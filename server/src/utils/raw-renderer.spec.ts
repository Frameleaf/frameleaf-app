import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

const tiff = Buffer.from('49492a0008000000', 'hex');

// A real process in place of dcraw_emu: it records its arguments and environment, then acts out FAKE_RAW.
const decoderScript = String.raw`#!/bin/sh
printf '%s\n' "$@" > "$FAKE_RAW_LOG"
printf 'threads=%s\npid=%s\n' "$OMP_NUM_THREADS" "$$" >> "$FAKE_RAW_LOG"
case "$FAKE_RAW" in
  warn) echo "data corrupted at offset 42" >&2; printf 'II*\000\010\000\000\000' ;;
  big) printf 'II*\000\010\000\000\000'; head -c 2048 /dev/zero ;;
  huge) printf 'II*\000\010\000\000\000'; head -c 67108864 /dev/zero ;;
  empty) ;;
  text) printf 'not a TIFF' ;;
  hang) exec sleep 30 ;;
  killed) kill -9 $$ ;;
  libs) echo "error while loading shared libraries: libraw.so" >&2; exit 127 ;;
  memory) echo "Insufficient memory" >&2; exit 1 ;;
  unsupported) echo "Unsupported file format or not RAW file" >&2; exit 1 ;;
  corrupt) echo "Corrupted data or unexpected EOF" >&2; exit 1 ;;
  io) echo "I/O error" >&2; exit 1 ;;
  fail) exit 2 ;;
  *) printf 'II*\000\010\000\000\000' ;;
esac
`;

describe('renderRawWithLibRaw', () => {
  let directory: string;
  let log: string;
  const logged = async () => (await readFile(log, 'utf8')).trim().split('\n');
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-raw-test-'));
    log = join(directory, 'log');
    const decoder = join(directory, 'dcraw_emu');
    await writeFile(decoder, decoderScript);
    await chmod(decoder, 0o755);
    vi.stubEnv('FRAMELEAF_RAW_DECODER_PATH', decoder);
    vi.stubEnv('FAKE_RAW_LOG', log);
    vi.stubEnv('FAKE_RAW', 'ok');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a relative decoder override', async () => {
    vi.stubEnv('FRAMELEAF_RAW_DECODER_PATH', 'dcraw_emu');
    await expect(renderRawWithLibRaw('photo.DNG')).rejects.toMatchObject({ reason: 'dependency_missing' });
  });

  it('renders a full-resolution 16-bit sRGB TIFF with camera white balance on one thread by default', async () => {
    expect(await renderRawWithLibRaw('-photo with spaces.CR3')).toEqual(tiff);
    expect(await logged()).toEqual([
      '-T',
      '-6',
      '-w',
      '-o',
      '1',
      '-Z',
      '-',
      resolve('-photo with spaces.CR3'),
      'threads=1',
      expect.stringMatching(/^pid=\d+$/),
    ]);
  });

  it('renders half size on the given number of threads', async () => {
    await renderRawWithLibRaw('photo.CR3', undefined, { halfSize: true, threads: 4 });
    const lines = await logged();
    expect(lines.slice(0, 2)).toEqual(['-h', '-T']);
    expect(lines).toContain('threads=4');
  });

  it('returns a render larger than any pipe buffer', async () => {
    vi.stubEnv('FAKE_RAW', 'big');
    expect(await renderRawWithLibRaw('photo.CR3')).toHaveLength(tiff.length + 2048);
  });

  it('keeps a clean render even when the decoder mentions corruption', async () => {
    vi.stubEnv('FAKE_RAW', 'warn');
    expect(await renderRawWithLibRaw('/photos/corrupt backups/photo.CR3')).toEqual(tiff);
  });

  it('refuses a sensor over the pixel limit without starting the decoder, and allows it at half size', async () => {
    vi.stubEnv('FRAMELEAF_SHARP_MAX_PIXELS', '1000000');
    await expect(renderRawWithLibRaw('photo.CR3', undefined, { pixels: 3_000_000 })).rejects.toMatchObject({
      reason: 'resource_limit',
    });
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await renderRawWithLibRaw('photo.CR3', undefined, { pixels: 3_000_000, halfSize: true })).toEqual(tiff);
  });

  it('refuses a render the image worker could not accept', async () => {
    vi.stubEnv('FAKE_RAW', 'huge');
    vi.stubEnv('FRAMELEAF_SHARP_MAX_BUFFER_BYTES', String(64 * 1024 ** 2));
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'resource_limit' });
  });

  it('does not start a decoder for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(renderRawWithLibRaw('photo.DNG', controller.signal)).rejects.toMatchObject({
      reason: 'cancelled',
      code: 'ABORT_ERR',
    });
    await expect(readFile(log)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops the decoder on cancellation and settles only once it is gone', async () => {
    vi.stubEnv('FAKE_RAW', 'hang');
    const controller = new AbortController();
    const result = renderRawWithLibRaw('photo.DNG', controller.signal);
    await vi.waitFor(async () => expect(await logged()).toHaveLength(10));
    const pid = Number((await logged()).at(-1)!.slice(4));
    expect(alive(pid)).toBe(true);
    controller.abort();
    await expect(result).rejects.toMatchObject({ reason: 'cancelled', code: 'ABORT_ERR' });
    expect(alive(pid)).toBe(false);
  });

  it('gives a larger sensor more time, and reports running out of it as a timeout', async () => {
    vi.stubEnv('FAKE_RAW', 'hang');
    vi.stubEnv('FRAMELEAF_RAW_RENDER_TIMEOUT_MS', '200');
    const started = Date.now();
    await expect(renderRawWithLibRaw('photo.CR3', undefined, { pixels: 100_000 })).rejects.toMatchObject({
      reason: 'timeout',
      code: 'ETIMEDOUT',
    });
    // 200 ms plus 2 s per megapixel: 0.1 MP adds 200 ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
  });

  it.each([
    ['killed', 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    ['libs', 'dependency_missing', 'ENOENT'],
    ['memory', 'resource_limit', 'ERR_RAW_RESOURCE_LIMIT'],
    ['unsupported', 'unsupported', 'ERR_RAW_UNSUPPORTED'],
    ['corrupt', 'damaged', 'ERR_RAW_DAMAGED'],
    ['io', 'io', 'EIO'],
    ['fail', 'decode_failed', 'ERR_RAW_DECODE'],
    // exit zero without a picture is the decoder's failure, not proof of damage
    ['empty', 'decode_failed', 'ERR_RAW_DECODE'],
    ['text', 'decode_failed', 'ERR_RAW_DECODE'],
  ])('classifies decoder outcome %s as %s', async (mode, reason, code) => {
    vi.stubEnv('FAKE_RAW', mode);
    await expect(renderRawWithLibRaw('/private/photo.CR3')).rejects.toMatchObject({
      name: 'RawRenderError',
      reason,
      code,
      message: `RAW sensor rendering failed: ${reason}`,
    });
  });

  it('never lets the path decide the verdict', async () => {
    vi.stubEnv('FAKE_RAW', 'fail');
    await expect(renderRawWithLibRaw('/unsupported corrupt/photo.CR3')).rejects.toMatchObject({
      reason: 'decode_failed',
    });
  });

  it('reports a missing or unusable decoder', async () => {
    vi.stubEnv('FRAMELEAF_RAW_DECODER_PATH', join(directory, 'missing'));
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toMatchObject({ reason: 'dependency_missing' });
    await chmod(join(directory, 'dcraw_emu'), 0o644);
    vi.stubEnv('FRAMELEAF_RAW_DECODER_PATH', join(directory, 'dcraw_emu'));
    await expect(renderRawWithLibRaw('photo.CR3')).rejects.toBeInstanceOf(RawRenderError);
  });

  it('preserves the original and leaves nothing beside it or in the temp folder', async () => {
    const source = join(directory, 'original.CR3');
    const original = Buffer.from('immutable original sensor data');
    const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    await writeFile(source, original);
    const scratch = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('frameleaf-raw-')).sort();
    const before = await scratch();
    await renderRawWithLibRaw(source);
    vi.stubEnv('FAKE_RAW', 'fail');
    await expect(renderRawWithLibRaw(source)).rejects.toMatchObject({ reason: 'decode_failed' });
    expect(await scratch()).toEqual(before);
    expect((await readdir(directory)).sort()).toEqual(['dcraw_emu', 'log', 'original.CR3']);
    expect(checksum(await readFile(source))).toBe(checksum(original));
  });
});
