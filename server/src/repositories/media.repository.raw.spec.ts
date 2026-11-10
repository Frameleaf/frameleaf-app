import { ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DecodeToBufferOptions } from 'src/types.js';
import { Colorspace } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { renderDarktable } from 'src/utils/darktable-renderer.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { automock } from 'test/utils.js';

vi.mock('src/utils/darktable-renderer.js', () => ({ renderDarktable: vi.fn() }));
vi.mock('src/utils/raw-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/raw-renderer.js')>()),
  renderRawWithLibRaw: vi.fn(),
}));

const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };

describe.each(['decodeImage', 'generateImageThumbnails'] as const)('MediaRepository RAW fallback: %s', (operation) => {
  let sut: MediaRepository;
  let directory: string;
  const decode = (input: string | Buffer, options: DecodeToBufferOptions) =>
    operation === 'decodeImage'
      ? sut.decodeImage(input, options)
      : sut.generateImageThumbnails(input, options, { outputs: [], edits: [], checkTransparency: false });
  beforeEach(async () => {
    vi.mocked(renderRawWithLibRaw).mockReset();
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-raw-pipeline-'));
  });
  afterEach(async () => await rm(directory, { recursive: true, force: true }));

  it('preserves an existing successful decoder result without invoking LibRaw', async () => {
    const input = join(directory, 'decodable.DNG');
    await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } })
      .png()
      .toFile(input);
    expect((await decode(input, options)).info).toMatchObject({ width: 16, height: 8 });
    expect(renderRawWithLibRaw).not.toHaveBeenCalled();
  });

  it('retries an undecodable RAW with sensor TIFF and preserves sizing without double rotation', async () => {
    const input = join(directory, 'camera.CR3');
    await writeFile(input, 'original RAW bytes');
    const tiff = await sharp({ create: { width: 16, height: 8, channels: 3, background: 'red' } })
      .toColourspace('rgb16')
      .withIccProfile('srgb')
      .tiff()
      .toBuffer();
    vi.mocked(renderRawWithLibRaw).mockResolvedValue(tiff);
    // This is the normal media repository, with no entitlement, mode or enhanced-RAW setting.
    const result = await decode(input, { ...options, orientation: 6, size: 4 });
    expect(result.info).toMatchObject({ width: 8, height: 4 });
    expect(renderRawWithLibRaw).toHaveBeenCalledExactlyOnceWith(input, undefined);
    expect(await readFile(input, 'utf8')).toBe('original RAW bytes');
  });

  it('does not invoke a sensor decoder for an explicitly interleaved raw input', async () => {
    const input = join(directory, 'pixels.CR3');
    await writeFile(input, 'invalid pixels');
    await expect(decode(input, { ...options, raw: { width: 64, height: 64, channels: 3 } })).rejects.toThrow();
    expect(renderRawWithLibRaw).not.toHaveBeenCalled();
  });

  it('propagates the classified sensor-render failure', async () => {
    const input = join(directory, 'camera.NEF');
    await writeFile(input, 'unreadable bytes');
    const failure = new RawRenderError('dependency_missing', 'ENOENT');
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
    await expect(decode(input, options)).rejects.toBe(failure);
  });

  it.each(['photo.jpg', 'photo.CR3'])(
    'does not treat buffers or ordinary image failures as RAW sensor data: %s',
    async (name) => {
      const input = name.endsWith('.jpg') ? join(directory, name) : Buffer.from('invalid image');
      if (typeof input === 'string') {
        await writeFile(input, 'invalid image');
      }
      await expect(decode(input, options)).rejects.toThrow();
      expect(renderRawWithLibRaw).not.toHaveBeenCalled();
    },
  );
});

describe('MediaRepository.renderRaw (FL-1355 ladder)', () => {
  let sut: MediaRepository;
  const sensor = Buffer.from('sensor');
  const developed = Buffer.from('developed');
  const preview = { buffer: Buffer.from('preview'), format: 'jpeg' };
  const unsupported = () => new RawRenderError('unsupported', 'ERR_RAW_UNSUPPORTED');

  beforeEach(() => {
    vi.mocked(renderRawWithLibRaw).mockReset();
    vi.mocked(renderDarktable).mockReset();
    // eslint-disable-next-line no-sparse-arrays
    sut = new MediaRepository(automock(LoggingRepository, { args: [, { getEnv: () => ({}) }], strict: false }));
    vi.spyOn(sut, 'extract').mockResolvedValue(preview as never);
  });

  it('stops at LibRaw when it renders, passing the render options through', async () => {
    vi.mocked(renderRawWithLibRaw).mockResolvedValue(sensor);
    const signal = new AbortController().signal;
    expect(await sut.renderRaw('a.cr3', { signal, halfSize: true, pixels: 45e6, threads: 2 })).toEqual({
      rung: 'libraw',
      buffer: sensor,
    });
    expect(renderRawWithLibRaw).toHaveBeenCalledExactlyOnceWith('a.cr3', signal, {
      halfSize: true,
      pixels: 45e6,
      threads: 2,
    });
    expect(renderDarktable).not.toHaveBeenCalled();
    expect(sut.extract).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'damaged', 'decode_failed', 'dependency_missing'] as const)(
    'steps down to the second decoder when LibRaw says %s',
    async (reason) => {
      const failure = new RawRenderError(reason, 'X');
      vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
      vi.mocked(renderDarktable).mockResolvedValue(developed);
      expect(await sut.renderRaw('a.nef')).toEqual({ rung: 'darktable', buffer: developed, failure });
      expect(sut.extract).not.toHaveBeenCalled();
    },
  );

  it('steps down to the camera preview when neither decoder can read the sensor', async () => {
    const failure = unsupported();
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
    vi.mocked(renderDarktable).mockRejectedValue(new Error('unsupported camera'));
    expect(await sut.renderRaw('a.nef')).toEqual({ rung: 'preview', buffer: preview.buffer, failure });
  });

  it.each(['timeout', 'resource_limit'] as const)(
    'goes straight to the camera preview when LibRaw ran out: %s',
    async (reason) => {
      const failure = new RawRenderError(reason, 'X');
      vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
      expect(await sut.renderRaw('a.arw')).toEqual({ rung: 'preview', buffer: preview.buffer, failure });
      expect(renderDarktable).not.toHaveBeenCalled();
    },
  );

  it('skips the second decoder when asked to', async () => {
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(unsupported());
    expect(await sut.renderRaw('a.nef', { developer: false })).toMatchObject({ rung: 'preview' });
    expect(renderDarktable).not.toHaveBeenCalled();
  });

  it('returns the first failure, marked exhausted, when no rung gives a picture', async () => {
    const failure = unsupported();
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
    vi.mocked(renderDarktable).mockRejectedValue(new Error('no'));
    vi.mocked(sut.extract).mockResolvedValue(null);
    await expect(sut.renderRaw('a.nef')).rejects.toBe(failure);
    expect(failure.ladderExhausted).toBe(true);
  });

  it.each(['cancelled', 'io'] as const)('does not work around %s', async (reason) => {
    const failure = new RawRenderError(reason, 'X');
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
    await expect(sut.renderRaw('a.nef')).rejects.toBe(failure);
    expect(failure.ladderExhausted).toBe(false);
    expect(renderDarktable).not.toHaveBeenCalled();
    expect(sut.extract).not.toHaveBeenCalled();
  });

  it('asks for another try, without a lower rung, while the second decoder is busy with someone else', async () => {
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(unsupported());
    vi.mocked(renderDarktable).mockRejectedValue(new ServiceUnavailableException('Native development is busy'));
    const result = sut.renderRaw('a.gpr');
    await expect(result).rejects.toMatchObject({ reason: 'resource_limit', ladderExhausted: false });
    expect(sut.extract).not.toHaveBeenCalled();
  });

  it("takes turns at the second decoder for the ladder's own calls", async () => {
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(unsupported());
    let active = 0;
    let most = 0;
    vi.mocked(renderDarktable).mockImplementation(async () => {
      most = Math.max(most, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return developed;
    });
    await Promise.all([sut.renderRaw('a.gpr'), sut.renderRaw('b.gpr'), sut.renderRaw('c.gpr')]);
    expect(most).toBe(1);
  });

  it.each(['ENOSPC', 'EDQUOT'])('does not settle for a lower rung because the drive is full: %s', async (code) => {
    const failure = new RawRenderError('resource_limit', code);
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(failure);
    await expect(sut.renderRaw('a.nef')).rejects.toBe(failure);
    expect(failure.ladderExhausted).toBe(false);
    expect(sut.extract).not.toHaveBeenCalled();
  });

  it('does not settle for the camera preview because the drive filled up under the second decoder', async () => {
    const full = Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(unsupported());
    vi.mocked(renderDarktable).mockRejectedValue(full);
    await expect(sut.renderRaw('a.gpr')).rejects.toBe(full);
    expect(sut.extract).not.toHaveBeenCalled();
  });

  it('stops when cancelled during the second decoder', async () => {
    const controller = new AbortController();
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(unsupported());
    vi.mocked(renderDarktable).mockImplementation(() => {
      controller.abort(new Error('stop'));
      return Promise.reject(new Error('killed'));
    });
    await expect(sut.renderRaw('a.nef', { signal: controller.signal })).rejects.toThrow('stop');
    expect(sut.extract).not.toHaveBeenCalled();
  });
});
