import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { getMocks } from 'test/utils.js';

const exec = vi.hoisted(() => ({ error: undefined as Error | undefined }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: Error | undefined, stdout: string, stderr: string) => void,
  ) => callback(exec.error, '', ''),
}));
vi.mock('src/utils/raw-renderer.js', () => ({ renderRawWithLibRaw: vi.fn() }));
describe(MediaIntegrityService.name, () => {
  const mocks = getMocks();
  const bytes = Buffer.from('synthetic original bytes');
  let directory: string;
  let input: { path: string; originalFileName: string; type: AssetType };
  let sut: MediaIntegrityService;
  beforeEach(async () => {
    exec.error = undefined;
    directory = await mkdtemp(join(tmpdir(), 'integrity-test-'));
    input = { path: join(directory, 'original.jpg'), originalFileName: 'original.jpg', type: AssetType.Image };
    await writeFile(input.path, bytes);
    sut = new MediaIntegrityService(
      new StorageRepository(mocks.logger as never),
      new CryptoRepository(),
      mocks.media as never,
    );
    mocks.media.decodeImage.mockResolvedValue({ data: bytes, info: {} } as never);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('returns real dual hashes and identity', async () => {
    expect(await sut.validate(input)).toMatchObject({
      status: 'healthy',
      sizeInBytes: bytes.length,
      sha1: createHash('sha1').update(bytes).digest(),
      sha256: createHash('sha256').update(bytes).digest(),
      identity: { size: bytes.length, ino: expect.any(Number), dev: expect.any(Number) },
    });
  });
  it('reports missing', async () => {
    await rm(input.path);
    expect(await sut.validate(input)).toEqual({ status: 'missing', reason: 'file_missing' });
  });
  it('rejects directories', async () => {
    expect(await sut.validate({ ...input, path: directory })).toEqual({
      status: 'unreadable',
      reason: 'not_regular_file',
    });
  });
  it.each([{ sizeInBytes: 1 }, { sha1: Buffer.alloc(20) }, { sha256: Buffer.alloc(32) }])(
    'rejects mismatch %j',
    async (expected) => {
      expect(await sut.validate({ ...input, expected })).toEqual({ status: 'corrupt', reason: 'expected_mismatch' });
    },
  );
  it.each([
    ['EACCES', 'unreadable', 'access_denied'],
    ['EIO', 'transient', 'io_failed'],
  ])('classifies %s', async (code, status, reason) => {
    const storage = new StorageRepository(mocks.logger as never);
    vi.spyOn(storage, 'stat').mockRejectedValue(Object.assign(new Error('/secret/path'), { code }));
    sut = new MediaIntegrityService(storage, new CryptoRepository(), mocks.media as never);
    expect(await sut.validate(input)).toEqual({ status, reason });
  });
  it('rejects mutation during hashing', async () => {
    const crypto = new CryptoRepository();
    const hash = crypto.hashFileDigests.bind(crypto);
    vi.spyOn(crypto, 'hashFileDigests').mockImplementation(async (path) => {
      const result = await hash(path);
      await writeFile(input.path, 'replacement');
      return result;
    });
    sut = new MediaIntegrityService(new StorageRepository(mocks.logger as never), crypto, mocks.media as never);
    expect(await sut.validate(input)).toEqual({ status: 'transient', reason: 'file_changed' });
  });
  it.each([
    [new Error('Unsupported file format or not RAW file'), 'unsupported', 'raw_decode_unsupported'],
    [Object.assign(new Error('private'), { killed: true }), 'timeout', 'decode_timeout'],
    [Object.assign(new Error('private'), { code: 'ENOENT' }), 'transient', 'decoder_unavailable'],
  ])('uses full RAW and classifies %j', async (error, status, reason) => {
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(error);
    expect(await sut.validate({ ...input, originalFileName: 'original.nef', deep: true })).toEqual({ status, reason });
    expect(mocks.media.extract).not.toHaveBeenCalled();
  });
  it.each([
    [Object.assign(new Error('private'), { killed: true }), 'timeout', 'decode_timeout'],
    [Object.assign(new Error('private'), { code: 'ENOENT' }), 'transient', 'decoder_unavailable'],
    [new Error('Invalid data found when processing input'), 'corrupt', 'decode_failed'],
  ])('classifies ffmpeg failure %j', async (error, status, reason) => {
    exec.error = error;
    expect(await sut.validate({ ...input, type: AssetType.Video, deep: true })).toEqual({ status, reason });
  });
  it('decodes the full rendered RAW without thumbnail resizing', async () => {
    vi.mocked(renderRawWithLibRaw).mockResolvedValue(bytes);
    expect(await sut.validate({ ...input, originalFileName: 'original.nef', deep: true })).toMatchObject({
      status: 'healthy',
    });
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(bytes, { colorspace: 'srgb', processInvalidImages: false });
    expect(mocks.media.extract).not.toHaveBeenCalled();
  });
  it('reports malformed image', async () => {
    mocks.media.decodeImage.mockRejectedValue(new Error('premature end of JPEG'));
    expect(await sut.validate({ ...input, deep: true })).toEqual({ status: 'corrupt', reason: 'decode_failed' });
  });
  it('bounds a stalled operation', async () => {
    vi.useFakeTimers();
    const storage = new StorageRepository(mocks.logger as never);
    vi.spyOn(storage, 'stat').mockImplementation(() => new Promise(() => {}));
    sut = new MediaIntegrityService(storage, new CryptoRepository(), mocks.media as never);
    const result = sut.validate(input);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toEqual({ status: 'timeout', reason: 'validation_timeout' });
  });
  it.each([
    ['600000', 600_000],
    ['1', 10_000],
    ['999999999', 86_400_000],
    ['invalid', 120_000],
  ])('bounds configured validation deadline %s', async (setting, deadline) => {
    vi.stubEnv('IMMICH_MEDIA_VALIDATION_TIMEOUT_MS', setting);
    vi.useFakeTimers();
    const storage = new StorageRepository(mocks.logger as never);
    vi.spyOn(storage, 'stat').mockImplementation(() => new Promise(() => {}));
    sut = new MediaIntegrityService(storage, new CryptoRepository(), mocks.media as never);
    const result = sut.validate(input);
    const settled = vi.fn();
    void result.then(settled);
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ status: 'timeout', reason: 'validation_timeout' });
  });
  it('keeps timed-out native work within the global validation limit', async () => {
    vi.useFakeTimers();
    const storage = new StorageRepository(mocks.logger as never);
    vi.spyOn(storage, 'stat').mockImplementation(() => new Promise(() => {}));
    sut = new MediaIntegrityService(storage, new CryptoRepository(), mocks.media as never);
    const pending = [sut.validate(input), sut.validate(input)];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await Promise.all(pending)).toEqual([
      { status: 'timeout', reason: 'validation_timeout' },
      { status: 'timeout', reason: 'validation_timeout' },
    ]);
    expect(await sut.validate(input)).toEqual({ status: 'transient', reason: 'validation_busy' });
    expect(storage.stat).toHaveBeenCalledTimes(2);
  });
});
