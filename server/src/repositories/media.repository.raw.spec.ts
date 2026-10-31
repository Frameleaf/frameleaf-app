import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DecodeToBufferOptions } from 'src/types.js';
import { Colorspace } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { automock } from 'test/utils.js';

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
