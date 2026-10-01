import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile: Object.assign(execFile, { [Symbol.for('nodejs.util.promisify.custom')]: execFile }) };
});

const tiff = Buffer.from('49492a0008000000', 'hex');

describe('renderRawWithLibRaw', () => {
  beforeEach(() => vi.mocked(execFile).mockReset());

  it('uses the pinned CLI, camera WB, sRGB, full-resolution 16-bit TIFF and bounded stdout', async () => {
    vi.mocked(execFile).mockResolvedValue({ stdout: tiff, stderr: Buffer.alloc(0) } as never);
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

  it('forwards cancellation while retaining the fixed decoder deadline and kill signal', async () => {
    const controller = new AbortController();
    vi.mocked(execFile).mockResolvedValue({ stdout: tiff, stderr: Buffer.alloc(0) } as never);
    await renderRawWithLibRaw('photo.DNG', controller.signal);
    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        signal: controller.signal,
        timeout: 120_000,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  });

  it.each([false, true])('classifies cancellation during execution, including the success race %s', async (success) => {
    const controller = new AbortController();
    vi.mocked(execFile).mockImplementation(() => {
      controller.abort();
      return (
        success
          ? Promise.resolve({ stdout: tiff, stderr: Buffer.alloc(0) })
          : Promise.reject({ code: 'ABORT_ERR', killed: true, stderr: Buffer.from('data corrupted') })
      ) as never;
    });
    await expect(renderRawWithLibRaw('photo.DNG', controller.signal)).rejects.toMatchObject({
      reason: 'cancelled',
      code: 'ABORT_ERR',
    });
    expect(execFile).toHaveBeenCalledOnce();
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
    vi.mocked(execFile).mockRejectedValue(failure);
    await expect(renderRawWithLibRaw('/private/photo.CR3')).rejects.toMatchObject({
      name: 'RawRenderError',
      reason,
      code,
      message: `RAW sensor rendering failed: ${reason}`,
      cause: failure,
    });
  });

  it.each([Buffer.alloc(0), Buffer.from('not a TIFF'), tiff.subarray(0, 4)])(
    'rejects missing or truncated output despite exit zero',
    async (stdout) => {
      vi.mocked(execFile).mockResolvedValue({ stdout, stderr: Buffer.alloc(0) } as never);
      await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'damaged' });
    },
  );

  it('rejects corruption diagnostics even when the decoder returns TIFF bytes', async () => {
    vi.mocked(execFile).mockResolvedValue({
      stdout: tiff,
      stderr: Buffer.from('data corrupted at offset 42'),
    } as never);
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toBeInstanceOf(RawRenderError);
  });

  it('preserves the original checksum and leaves no temporary or adjacent output after success or failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-raw-test-'));
    const source = join(directory, 'original.CR3');
    const original = Buffer.from('immutable original sensor data');
    const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    try {
      await writeFile(source, original);
      vi.mocked(execFile).mockResolvedValueOnce({ stdout: tiff, stderr: Buffer.alloc(0) } as never);
      await renderRawWithLibRaw(source);
      vi.mocked(execFile).mockRejectedValueOnce({ killed: true });
      await expect(renderRawWithLibRaw(source)).rejects.toMatchObject({ reason: 'timeout' });
      expect(await readdir(directory)).toEqual(['original.CR3']);
      expect(checksum(await readFile(source))).toBe(checksum(original));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
