import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssetType } from 'src/enum.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const tiff = Buffer.from('49492a0008000000', 'hex');
type Decoder = EventEmitter & { kill: ReturnType<typeof vi.fn> };

// The callback may precede close on a spawn/error path. Tests control both events independently.
const mockDecoder = (
  failure?: unknown,
  stdout = tiff,
  stderr = (failure as { stderr?: Buffer } | undefined)?.stderr ?? Buffer.alloc(0),
  delayedClose = false,
) => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
  vi.mocked(execFile).mockImplementationOnce((...args) => {
    const callback = args[3] as (error: unknown, stdout: Buffer, stderr: Buffer) => void;
    queueMicrotask(() => {
      callback(failure, stdout, stderr);
      if (!delayedClose) {
        child.emit('close', failure ? 2 : 0, null);
      }
    });
    return child as never;
  });
  return child;
};

describe('renderRawWithLibRaw', () => {
  beforeEach(() => vi.mocked(execFile).mockReset());
  afterEach(() => vi.useRealTimers());

  it('uses the pinned CLI, camera WB, sRGB, full-resolution 16-bit TIFF and bounded stdout', async () => {
    mockDecoder();
    expect(await renderRawWithLibRaw('-photo with spaces.CR3')).toBe(tiff);
    expect(execFile).toHaveBeenCalledWith(
      '/usr/local/bin/dcraw_emu',
      ['-T', '-6', '-w', '-o', '1', '-Z', '-', resolve('-photo with spaces.CR3')],
      expect.objectContaining({
        encoding: 'buffer',
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
        env: expect.objectContaining({ LC_ALL: 'C', OMP_NUM_THREADS: '1' }),
      }),
      expect.any(Function),
    );
  });

  it('does not start a decoder for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderRawWithLibRaw('photo.DNG', controller.signal)).rejects.toMatchObject({
      reason: 'cancelled',
      code: 'ABORT_ERR',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([undefined, { code: 'ABORT_ERR', killed: true, stderr: Buffer.from('data corrupted') }])(
    'kills cancellation explicitly and waits for close despite callback outcome %j',
    async (failure) => {
      const controller = new AbortController();
      const child = mockDecoder(failure, tiff, Buffer.alloc(0), true);
      const settled = vi.fn();
      const result = renderRawWithLibRaw('photo.DNG', controller.signal);
      void result.then(settled).catch(settled);
      await Promise.resolve();
      controller.abort();
      await Promise.resolve();
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      expect(settled).not.toHaveBeenCalled();
      expect(vi.mocked(execFile).mock.calls[0][2]).not.toHaveProperty('signal');
      child.emit('close', null, 'SIGKILL');
      await expect(result).rejects.toMatchObject({ reason: 'cancelled', code: 'ABORT_ERR' });
    },
  );

  it('handles cancellation arriving during child creation before the abort listener is installed', async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as Decoder;
    child.kill = vi.fn(() => true);
    vi.mocked(execFile).mockImplementationOnce(() => {
      controller.abort();
      return child as never;
    });
    const result = renderRawWithLibRaw('photo.DNG', controller.signal);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
  });

  it.each([undefined, { code: 'ENOENT' }])('waits for close on success and spawn failure %j', async (failure) => {
    const child = mockDecoder(failure, tiff, Buffer.alloc(0), true);
    const settled = vi.fn();
    const result = renderRawWithLibRaw('photo.DNG');
    void result.then(settled).catch(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit('close', failure ? -2 : 0, null);
    if (failure) {
      await expect(result).rejects.toMatchObject({ reason: 'dependency_missing' });
    } else {
      expect(await result).toBe(tiff);
    }
  });

  it('keeps both integrity admissions through deadline cancellation until child close', async () => {
    vi.useFakeTimers();
    const children = [
      mockDecoder(undefined, tiff, Buffer.alloc(0), true),
      mockDecoder(undefined, tiff, Buffer.alloc(0), true),
    ];
    const stat = { isFile: () => true, size: 8, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1 };
    const integrity = new MediaIntegrityService(
      { stat: vi.fn().mockResolvedValue(stat) } as never,
      {
        hashFileDigests: vi
          .fn()
          .mockResolvedValue({ sha1: Buffer.alloc(20), sha256: Buffer.alloc(32), sizeInBytes: 8 }),
      } as never,
      { decodeImage: vi.fn().mockResolvedValue({ data: Buffer.alloc(8), info: {} }) } as never,
    );
    const input = { path: '/original.DNG', originalFileName: 'original.DNG', type: AssetType.Image, deep: true };
    const results = [integrity.validate(input), integrity.validate(input)];
    await vi.advanceTimersByTimeAsync(0);
    expect(execFile).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await Promise.all(results)).toEqual([
      { status: 'timeout', reason: 'validation_timeout' },
      { status: 'timeout', reason: 'validation_timeout' },
    ]);
    for (const child of children) {
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    }
    expect(await integrity.validate(input)).toEqual({ status: 'transient', reason: 'validation_busy' });
    expect(execFile).toHaveBeenCalledTimes(2);
    for (const child of children) {
      child.emit('close', null, 'SIGKILL');
    }
    await vi.advanceTimersByTimeAsync(0);
    mockDecoder();
    expect(await integrity.validate(input)).toMatchObject({ status: 'healthy' });
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ code: 'ENOENT' }, 'dependency_missing', 'ENOENT'],
    [{ stderr: Buffer.from('error while loading shared libraries') }, 'dependency_missing', 'ENOENT'],
    [{ killed: true, signal: 'SIGKILL' }, 'timeout', 'ETIMEDOUT'],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ signal: 'SIGKILL' }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ stderr: Buffer.from('Insufficient memory') }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ stderr: Buffer.from('Unsufficient memory') }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ stderr: Buffer.from('Libraw internal mempool overflowed') }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ stderr: Buffer.from('No space left on device') }, 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    [{ stderr: Buffer.from('Unsupported file format or not RAW file') }, 'unsupported', 'ERR_RAW_UNSUPPORTED'],
    [{ stderr: Buffer.from('Corrupted data or unexpected EOF') }, 'damaged', 'ERR_RAW_DAMAGED'],
    [{ code: 'EACCES' }, 'io', 'EACCES'],
    [{ code: 2, stderr: Buffer.from('I/O error') }, 'io', 'EIO'],
    [{ code: 2 }, 'decode_failed', 'ERR_RAW_DECODE'],
  ])('classifies decoder failure %j as %s', async (failure, reason, code) => {
    mockDecoder(failure);
    await expect(renderRawWithLibRaw('/private/photo.CR3')).rejects.toMatchObject({
      name: 'RawRenderError',
      reason,
      code,
      message: `RAW sensor rendering failed: ${reason}`,
      cause: failure,
    });
  });

  it('retains callback stderr when the native Error does not carry its diagnostics', async () => {
    const failure = new Error('Command failed');
    mockDecoder(failure, Buffer.alloc(0), Buffer.from('Unsupported file format or not RAW file'));
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'unsupported', cause: failure });
  });

  it('classifies synchronous spawn failure without waiting for a nonexistent child', async () => {
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' });
    });
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'dependency_missing' });
  });

  it.each([Buffer.alloc(0), Buffer.from('not a TIFF'), tiff.subarray(0, 4)])(
    'rejects missing or truncated output despite exit zero',
    async (stdout) => {
      mockDecoder(undefined, stdout);
      await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'damaged' });
    },
  );

  it('rejects corruption diagnostics even when the decoder returns TIFF bytes', async () => {
    mockDecoder(undefined, tiff, Buffer.from('data corrupted at offset 42'));
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toBeInstanceOf(RawRenderError);
  });

  it('preserves the original checksum and leaves no adjacent output after success, failure and cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-raw-test-'));
    const source = join(directory, 'original.CR3');
    const original = Buffer.from('immutable original sensor data');
    const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    try {
      await writeFile(source, original);
      mockDecoder();
      await renderRawWithLibRaw(source);
      mockDecoder({ killed: true });
      await expect(renderRawWithLibRaw(source)).rejects.toMatchObject({ reason: 'timeout' });
      const controller = new AbortController();
      const child = mockDecoder(undefined, tiff, Buffer.alloc(0), true);
      const result = renderRawWithLibRaw(source, controller.signal);
      await Promise.resolve();
      controller.abort();
      child.emit('close', null, 'SIGKILL');
      await expect(result).rejects.toMatchObject({ reason: 'cancelled' });
      expect(await readdir(directory)).toEqual(['original.CR3']);
      expect(checksum(await readFile(source))).toBe(checksum(original));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
