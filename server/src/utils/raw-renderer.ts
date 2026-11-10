import { spawn } from 'node:child_process';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { jobSignal } from 'src/queue/context.js';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';
import { sharpConfiguration } from 'src/queue/sharp-configuration.js';
import { makeWorkDirFor } from 'src/utils/locked-read.js';

const RAW_RENDER_TIMEOUT_MS = 120_000;
/** Added per megapixel: a 45 MP sensor gets 3.5 minutes, a 100 MP one over 5. */
const RAW_RENDER_MS_PER_MEGAPIXEL = 2000;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

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
  /** FL-1355: every rung of the RAW ladder failed, so there is no picture to show for this file yet. */
  ladderExhausted = false;

  constructor(
    public readonly reason: RawRenderFailure,
    public readonly code: string,
    cause?: unknown,
  ) {
    super(`RAW sensor rendering failed: ${reason}`, { cause });
    this.name = 'RawRenderError';
  }
}

export type RawRenderOptions = {
  /** Half-size demosaic: a quarter of the pixels at a quarter of the cost, for previews and checks. */
  halfSize?: boolean;
  /** The sensor's pixel count from the file's metadata, when known. */
  pixels?: number;
  /** Decoder threads; the caller divides the processors between its concurrent jobs. */
  threads?: number;
};

const classifyExit = (code: number | null, killedBy: NodeJS.Signals | null, diagnostic: string) => {
  if (/error while loading shared libraries/i.test(diagnostic)) {
    return new RawRenderError('dependency_missing', 'ENOENT');
  }
  if (/no space left|quota exceeded/i.test(diagnostic)) {
    // a full drive is the server's trouble, named so that nobody settles for a lower rung because of it
    return new RawRenderError('resource_limit', 'ENOSPC');
  }
  if (
    killedBy ||
    /insufficient memory|unsufficient memory|libraw internal mempool overflowed|out of memory|cannot allocate|too big/i.test(
      diagnostic,
    )
  ) {
    // killed from outside (out of memory, the host shutting down): nothing about the file
    return new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT');
  }
  if (/unsupported|not (?:a )?raw|not implemented/i.test(diagnostic)) {
    return new RawRenderError('unsupported', 'ERR_RAW_UNSUPPORTED');
  }
  if (/corrupt|unexpected (?:end|eof)|data error/i.test(diagnostic)) {
    return new RawRenderError('damaged', 'ERR_RAW_DAMAGED');
  }
  if (/permission denied|input\/output|i\/o error/i.test(diagnostic)) {
    return new RawRenderError('io', 'EIO');
  }
  return new RawRenderError('decode_failed', 'ERR_RAW_DECODE', new Error(`RAW decoder exited with code ${code}`));
};

/**
 * Sensor render, never an embedded preview. LibRaw applies orientation and embeds the sRGB output profile.
 * FL-1355: the TIFF goes to a private temp file, so its size is bounded by the image worker's own limits
 * and not by a pipe buffer; a clean render is kept whatever the decoder muttered on the way.
 */
export async function renderRawWithLibRaw(
  input: string,
  signal: AbortSignal | undefined = jobSignal(),
  options: RawRenderOptions = {},
): Promise<Buffer> {
  if (signal?.aborted) {
    throw new RawRenderError('cancelled', 'ABORT_ERR', signal.reason);
  }
  const decoder = process.env.FRAMELEAF_RAW_DECODER_PATH ?? '/usr/local/bin/dcraw_emu';
  if (!isAbsolute(decoder)) {
    throw new RawRenderError('dependency_missing', 'ERR_RAW_DECODER_PATH');
  }
  const limits = sharpConfiguration();
  if (options.pixels && options.pixels / (options.halfSize ? 4 : 1) > limits.maxPixels) {
    throw new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT');
  }
  const source = resolve(input);
  // Without dimensions, a megabyte of RAW stands in for a megapixel (compressed sensors store about that).
  const megapixels = options.pixels
    ? options.pixels / 1e6
    : await stat(source)
        .then(({ size }) => size / 1e6)
        .catch(() => 0);
  // ponytail: a scaled deadline, not stall detection. dcraw_emu reports stages only to a block-buffered stdout,
  // so there is no progress to watch; add an idle window if LibRaw is ever called in-process.
  const configured = Number(process.env.FRAMELEAF_RAW_RENDER_TIMEOUT_MS ?? RAW_RENDER_TIMEOUT_MS);
  const base = Number.isFinite(configured) && configured >= 1 ? configured : RAW_RENDER_TIMEOUT_MS;
  // capped at the longest delay a Node timer takes
  const deadlineMs = Math.min(base + megapixels * RAW_RENDER_MS_PER_MEGAPIXEL, 2_147_483_647);
  // Never beside the immutable original; a plain copy of a sealed Locked file renders inside the RAM folder.
  // Its own errors (a Locked key that is not loaded yet) are the caller's to see, unclassified.
  const directory = await makeWorkDirFor(source, 'raw');
  try {
    const output = join(directory, 'render.tiff');
    const file = await open(output, 'wx', 0o600);
    const stderr: Buffer[] = [];
    let exit: { code: number | null; killedBy: NodeJS.Signals | null };
    let timedOut = false;
    try {
      exit = await new Promise((resolveExit, reject) => {
        // Desktop supplies its inventory-verified binary; NAS retains its pinned image path.
        const child = spawn(
          decoder,
          [...(options.halfSize ? ['-h'] : []), '-T', '-6', '-w', '-o', '1', '-Z', '-', source],
          {
            stdio: ['ignore', file.fd, 'pipe'],
            env: { ...process.env, LC_ALL: 'C', OMP_NUM_THREADS: String(Math.max(1, options.threads ?? 1)) },
          },
        );
        // Owns cancellation and the deadline, and keeps admission until the child has closed.
        const supervisor = superviseMediaProcess(child, { signal, deadlineMs });
        let diagnosticBytes = 0;
        child.stderr!.on('data', (chunk: Buffer) => {
          if (diagnosticBytes < MAX_DIAGNOSTIC_BYTES) {
            stderr.push(chunk);
            diagnosticBytes += chunk.length;
          }
        });
        // A failed spawn has no process to wait for.
        child.once('error', reject);
        child.once('close', (code, killedBy) => {
          timedOut = !!supervisor.error() && !signal?.aborted;
          resolveExit({ code, killedBy });
        });
      });
    } finally {
      await file.close();
    }
    if (signal?.aborted) {
      throw new RawRenderError('cancelled', 'ABORT_ERR', signal.reason);
    }
    if (timedOut) {
      throw new RawRenderError('timeout', 'ETIMEDOUT');
    }
    if (exit.code !== 0) {
      // The path is the person's own words ("corrupt backups/…"); it must never decide the verdict.
      throw classifyExit(exit.code, exit.killedBy, Buffer.concat(stderr).toString().replaceAll(source, ''));
    }
    if ((await stat(output)).size > limits.maxBytes) {
      throw new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT');
    }
    const rendered = await readFile(output);
    const signature = rendered.subarray(0, 4).toString('hex');
    if (rendered.length < 8 || (signature !== '49492a00' && signature !== '4d4d002a')) {
      // Exit zero without a picture is the decoder's failure; damage needs proof.
      throw new RawRenderError('decode_failed', 'ERR_RAW_DECODE');
    }
    return rendered;
  } catch (error) {
    if (error instanceof RawRenderError) {
      throw error;
    }
    if (signal?.aborted) {
      throw new RawRenderError('cancelled', 'ABORT_ERR', error);
    }
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') {
      throw new RawRenderError('dependency_missing', 'ENOENT', error);
    }
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      // a full drive or quota keeps its own code, so the ladder and the job see it for what it is
      throw new RawRenderError('resource_limit', code, error);
    }
    if (['ENOMEM', 'ERR_FS_FILE_TOO_LARGE'].includes(code as string)) {
      throw new RawRenderError('resource_limit', 'ERR_RAW_RESOURCE_LIMIT', error);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new RawRenderError('io', code, error);
    }
    throw new RawRenderError('decode_failed', 'ERR_RAW_DECODE', error);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
