import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const RAW_RENDER_TIMEOUT_MS = 120_000;
// ponytail: 256 MiB TIFF ceiling; raise with qualified high-resolution camera fixtures.
const RAW_RENDER_MAX_BYTES = 256 * 1024 * 1024;

export type RawRenderFailure =
  | 'dependency_missing'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'damaged'
  | 'resource_limit'
  | 'io'
  | 'decode_failed';

export class RawRenderError extends Error {
  constructor(
    public readonly reason: RawRenderFailure,
    public readonly code: string,
    cause?: unknown,
  ) {
    super(`RAW sensor rendering failed: ${reason}`, { cause });
    this.name = 'RawRenderError';
  }
}

/** Sensor render, never an embedded preview. LibRaw applies orientation and embeds the sRGB output profile. */
export async function renderRawWithLibRaw(input: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    if (signal?.aborted) {
      throw new RawRenderError('cancelled', 'ABORT_ERR', signal.reason);
    }
    // The absolute binary is built from the same pinned source as the server's LibRaw library.
    // stdout avoids temporary files and any derivative beside the immutable original.
    const { stdout, stderr } = await execFile(
      '/usr/local/bin/dcraw_emu',
      ['-T', '-6', '-w', '-o', '1', '-Z', '-', resolve(input)],
      {
        encoding: 'buffer',
        timeout: RAW_RENDER_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        signal,
        maxBuffer: RAW_RENDER_MAX_BYTES,
        env: { ...process.env, LC_ALL: 'C', OMP_NUM_THREADS: '1' },
      },
    );
    if (signal?.aborted) {
      throw new RawRenderError('cancelled', 'ABORT_ERR', signal.reason);
    }
    if (/corrupt|unexpected (?:end|eof)|data error/i.test(stderr.toString().replaceAll(resolve(input), ''))) {
      throw new RawRenderError('damaged', 'ERR_RAW_DAMAGED');
    }
    const signature = stdout.subarray(0, 4).toString('hex');
    if (stdout.length < 8 || (signature !== '49492a00' && signature !== '4d4d002a')) {
      throw new RawRenderError('damaged', 'ERR_RAW_DAMAGED');
    }
    return stdout;
  } catch (error) {
    if (error instanceof RawRenderError) {
      throw error;
    }
    const details = (error && typeof error === 'object' ? error : {}) as {
      code?: string | number;
      killed?: boolean;
      signal?: string;
      stderr?: Buffer;
    };
    if (signal?.aborted || details.code === 'ABORT_ERR') {
      throw new RawRenderError('cancelled', 'ABORT_ERR', error);
    }
    const diagnostic = (details.stderr?.toString() ?? '').replaceAll(resolve(input), '');
    if (details.code === 'ENOENT' || /error while loading shared libraries/i.test(diagnostic)) {
      throw new RawRenderError('dependency_missing', 'ENOENT', error);
    }
    // maxBuffer also kills the child: classify it before checking killed.
    if (
      details.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
      /insufficient memory|unsufficient memory|libraw internal mempool overflowed|out of memory|cannot allocate|too big|no space left/i.test(
        diagnostic,
      )
    ) {
      throw new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT', error);
    }
    if (details.killed || details.code === 'ETIMEDOUT') {
      throw new RawRenderError('timeout', 'ETIMEDOUT', error);
    }
    if (details.signal === 'SIGKILL') {
      throw new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT', error);
    }
    if (/unsupported|not (?:a )?raw|not implemented/i.test(diagnostic)) {
      throw new RawRenderError('unsupported', 'ERR_RAW_UNSUPPORTED', error);
    }
    if (/corrupt|unexpected (?:end|eof)|data error/i.test(diagnostic)) {
      throw new RawRenderError('damaged', 'ERR_RAW_DAMAGED', error);
    }
    if (
      details.code === 'EACCES' ||
      details.code === 'EPERM' ||
      /permission denied|input\/output|i\/o error/i.test(diagnostic)
    ) {
      throw new RawRenderError(
        'io',
        details.code === 'EACCES' || details.code === 'EPERM' ? details.code : 'EIO',
        error,
      );
    }
    throw new RawRenderError('decode_failed', 'ERR_RAW_DECODE', error);
  }
}
