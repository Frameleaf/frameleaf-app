import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
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
// a file that cannot be opened for reading now, though it was hashed a moment before (FL-1337)
const unreadable = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (path: string, ...rest: unknown[]) =>
      path === unreadable.path
        ? Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
        : (actual.open as (...args: unknown[]) => ReturnType<typeof actual.open>)(path, ...rest),
  };
});
vi.mock('src/utils/raw-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/raw-renderer.js')>()),
  renderRawWithLibRaw: vi.fn(),
}));
describe(MediaIntegrityService.name, () => {
  const mocks = getMocks();
  const bytes = Buffer.from('synthetic original bytes');
  let directory: string;
  let input: { path: string; originalFileName: string; type: AssetType };
  let sut: MediaIntegrityService;
  beforeEach(async () => {
    vi.clearAllMocks();
    exec.error = undefined;
    vi.mocked(renderRawWithLibRaw).mockReset();
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
  it("integrity check counts an encrypted file as encrypted and doesn't hash it", async () => {
    // FL-721 (spec §8.3): a sealed Locked file is "encrypted, not checked", never corrupt
    await writeFile(input.path, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
    const hash = vi.spyOn(CryptoRepository.prototype, 'hashFileDigests');
    try {
      await expect(
        sut.validate({ ...input, deep: true, expected: { sha256: Buffer.alloc(32), sizeInBytes: bytes.length } }),
      ).resolves.toEqual({ status: 'encrypted', reason: 'locked_encrypted' });

      expect(hash).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
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
  it('refuses immediately on cancellation but settles only after noncooperative decode and retains its slot', async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    mocks.media.decodeImage.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { data: bytes, info: {} } as never;
    });
    const first = sut.validateWithSettlement({ ...input, deep: true });
    await entered.promise;
    first.cancel();
    expect(await first.result).toEqual({ status: 'timeout', reason: 'validation_timeout' });
    let settled = false;
    void first.settled.then(() => {
      settled = true;
    });
    const second = sut.validateWithSettlement({ ...input, deep: true });
    expect(await sut.validate(input)).toEqual({ status: 'transient', reason: 'validation_busy' });
    expect(settled).toBe(false);
    resume.resolve();
    await Promise.all([first.settled, second.settled]);
    expect(settled).toBe(true);
    expect((await sut.validate(input)).status).toBe('healthy');
    expect(await first.result).toEqual({ status: 'timeout', reason: 'validation_timeout' });
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
    [Object.assign(new Error('private'), { killed: true }), { status: 'timeout', reason: 'decode_timeout' }],
    [Object.assign(new Error('private'), { code: 'ENOENT' }), { status: 'transient', reason: 'decoder_unavailable' }],
    [
      new Error('Invalid data found when processing input'),
      // FL-1337: a decode failure carries the decoder's words, for telling its cause
      { status: 'corrupt', reason: 'decode_failed', message: 'Invalid data found when processing input' },
    ],
  ])('classifies ffmpeg failure %j', async (error, expected) => {
    exec.error = error;
    expect(await sut.validate({ ...input, type: AssetType.Video, deep: true })).toEqual(expected);
  });
  it('an unsupported-format message on a JPEG with junk in front is corrupt', async () => {
    await writeFile(input.path, Buffer.concat([Buffer.alloc(300, 7), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]));
    mocks.media.decodeImage.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
    expect(await sut.validate({ ...input, deep: true })).toEqual({
      status: 'corrupt',
      reason: 'decode_failed',
      message: 'Input buffer contains unsupported image format',
    });
  });
  it('an unsupported-format message on a PSD with an embedded JPEG stays unsupported', async () => {
    const psd = join(directory, 'original.psd');
    await writeFile(psd, Buffer.concat([Buffer.alloc(128, 7), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])]));
    mocks.media.decodeImage.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
    expect(await sut.validate({ ...input, path: psd, originalFileName: 'original.psd', deep: true })).toEqual({
      status: 'unsupported',
      reason: 'decode_unsupported',
      message: 'Input buffer contains unsupported image format',
    });
  });
  it('an unsupported-format message on a JPEG it could not read back is busy, never unsupported', async () => {
    mocks.media.decodeImage.mockImplementation(() => {
      unreadable.path = input.path;
      return Promise.reject(new Error('Input buffer contains unsupported image format'));
    });
    try {
      // "left as it is" would file a damaged JPEG away for good on one failed read
      expect(await sut.validate({ ...input, deep: true })).toEqual({ status: 'transient', reason: 'io_failed' });
    } finally {
      unreadable.path = undefined;
    }
  });
  it('an unsupported-format message on a file with no JPEG marker stays unsupported', async () => {
    mocks.media.decodeImage.mockRejectedValue(new Error('Input buffer contains unsupported image format'));
    expect(await sut.validate({ ...input, deep: true })).toEqual({
      status: 'unsupported',
      reason: 'decode_unsupported',
      message: 'Input buffer contains unsupported image format',
    });
  });
  it('decodes the full rendered RAW without thumbnail resizing', async () => {
    vi.mocked(renderRawWithLibRaw).mockResolvedValue(bytes);
    expect(await sut.validate({ ...input, originalFileName: 'original.nef', deep: true })).toMatchObject({
      status: 'healthy',
    });
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(bytes, { colorspace: 'srgb', processInvalidImages: false });
    expect(mocks.media.extract).not.toHaveBeenCalled();
  });
  it.each([
    ['unsupported', 'ERR_RAW_UNSUPPORTED', 'unsupported', 'raw_decode_unsupported'],
    ['dependency_missing', 'ENOENT', 'transient', 'decoder_unavailable'],
    ['timeout', 'ETIMEDOUT', 'timeout', 'decode_timeout'],
    ['cancelled', 'ABORT_ERR', 'timeout', 'validation_timeout'],
    ['resource_limit', 'ERR_RAW_RESOURCE_LIMIT', 'transient', 'decoder_resource_limit'],
    ['damaged', 'ERR_RAW_DAMAGED', 'transient', 'raw_decode_damaged'],
    ['io', 'EACCES', 'unreadable', 'access_denied'],
    ['io', 'EIO', 'transient', 'io_failed'],
    ['decode_failed', 'ERR_RAW_DECODE', 'transient', 'decode_unverified'],
  ] as const)('maps typed RAW %s without confirming corruption', async (failure, code, status, reason) => {
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(new RawRenderError(failure, code));
    expect(await sut.validate({ ...input, originalFileName: 'original.nef', deep: true })).toEqual({ status, reason });
    expect(mocks.media.extract).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).not.toHaveBeenCalled();
  });

  it('aborts an active RAW decoder at the validation deadline', async () => {
    vi.useFakeTimers();
    const { promise: ready, resolve: started } = Promise.withResolvers<void>();
    let decoderSignal: AbortSignal | undefined;
    vi.mocked(renderRawWithLibRaw).mockImplementation((_path, signal) => {
      decoderSignal = signal;
      started();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new RawRenderError('cancelled', 'ABORT_ERR')), { once: true });
      });
    });
    const result = sut.validate({ ...input, originalFileName: 'original.nef', deep: true });
    await ready;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await result).toEqual({ status: 'timeout', reason: 'validation_timeout' });
    expect(decoderSignal?.aborted).toBe(true);
    expect(mocks.media.decodeImage).not.toHaveBeenCalled();
  });

  it('preserves layered PSD decoding without treating it as camera sensor data', async () => {
    expect(await sut.validate({ ...input, originalFileName: 'original.psd', deep: true })).toMatchObject({
      status: 'healthy',
    });
    expect(renderRawWithLibRaw).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(input.path, expect.any(Object));
  });

  it('reports malformed image', async () => {
    mocks.media.decodeImage.mockRejectedValue(new Error('premature end of JPEG'));
    expect(await sut.validate({ ...input, deep: true })).toEqual({
      status: 'corrupt',
      reason: 'decode_failed',
      message: 'premature end of JPEG',
    });
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
    vi.stubEnv('FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS', setting);
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
