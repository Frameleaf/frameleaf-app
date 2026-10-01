import { ServiceUnavailableException } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { DarktableDevelopRecipeSchema } from 'src/dtos/asset-develop.dto.js';

const execFile = promisify(execFileCallback);

// release-5.6.1: https://github.com/darktable-org/darktable/tree/03179f8e080aa9cedebfe14b098b7ba88940a292
// The deployment image must pin this source and its dependencies; --version verifies the release, not build provenance.
export const DARKTABLE_RENDERER_VERSION =
  'frameleaf-darktable/1;darktable/5.6.1;03179f8e080aa9cedebfe14b098b7ba88940a292';
export const DARKTABLE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 ** 3;
// ponytail: one native render per worker process; use shared admission if the deployment needs a global ceiling.
let nativeRenderActive = false;

/** An aborted execFile promise can reject before close; keep admission until the child is actually gone. */
async function runDarktable(args: string[], signal: AbortSignal) {
  const execution = execFile('darktable-cli', args, { signal, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  const closed = new Promise<void>((resolve) => execution.child.once('close', () => resolve()));
  try {
    return await execution;
  } finally {
    await closed;
  }
}

/** Only accepts the pinned release banner, never development builds or another patch release. */
export function verifyDarktableVersion(stdout: string): void {
  if (!/^darktable 5\.6\.1\r?\n/.test(stdout)) {
    throw new Error('Native development requires darktable 5.6.1');
  }
}

/**
 * src/iop/exposure.c, dt_iop_exposure_params_t v7: enum, four floats, two gboolean (all 32-bit).
 * Preserve the engine's own module/history/blend defaults, then set manual EV with both automatic
 * compensations disabled. This is deliberately not the version 1 post-decode exposure operation.
 */
export function translateDarktableExposure(params: Uint8Array, exposureEV: number): Buffer {
  if (endianness() !== 'LE' || params.byteLength !== 28 || !Number.isFinite(exposureEV) || Math.abs(exposureEV) > 18) {
    throw new Error('Unsupported darktable exposure parameter layout or value');
  }
  const translated = Buffer.from(params);
  translated.writeInt32LE(0, 0); // EXPOSURE_MODE_MANUAL
  translated.writeFloatLE(0, 4); // No black-level correction.
  translated.writeFloatLE(exposureEV, 8);
  translated.writeInt32LE(0, 20); // No camera exposure-bias compensation.
  translated.writeInt32LE(0, 24); // No automatic highlight-preservation compensation.
  return translated;
}

/**
 * The native engine creates the complete camera-specific history first. Never synthesize XMP or
 * assume omitted modules mean defaults: XMP v5 requires the full history (src/common/exif.cc).
 * Work only on a private, closed CLI library; src/develop/develop.c persists its default history.
 */
export function prepareNativeHistory(library: string, exposureEV: number): void {
  const db = new DatabaseSync(library, { open: true });
  try {
    const images = db.prepare('SELECT id, history_end FROM images').all();
    if (images.length !== 1) {
      throw new Error('Native development did not create one image history');
    }
    const image = images[0];
    const rows = db
      .prepare(
        "SELECT num, module, op_params, multi_priority FROM history WHERE imgid = ? AND operation = 'exposure' AND num < ? ORDER BY num DESC",
      )
      .all(image.id, image.history_end);
    const exposure = rows[0];
    if (
      !exposure ||
      exposure.module !== 7 ||
      !(exposure.op_params instanceof Uint8Array) ||
      rows.some((row) => row.multi_priority !== exposure.multi_priority)
    ) {
      throw new Error('Unsupported native exposure history');
    }
    const params = translateDarktableExposure(exposure.op_params, exposureEV);
    const result = db
      .prepare('UPDATE history SET op_params = ?, enabled = 1 WHERE imgid = ? AND num = ?')
      .run(params, image.id, exposure.num);
    if (result.changes !== 1) {
      throw new Error('Native exposure history was not updated');
    }
  } finally {
    db.close();
  }
}

/** Real native RAW processing. Both interactive and final output use this full-resolution sRGB pipeline. */
export async function renderDarktable(input: string, value: unknown, signal?: AbortSignal): Promise<Buffer> {
  const recipe = DarktableDevelopRecipeSchema.parse(value); // Reject unknown controls before touching a file/process.
  signal?.throwIfAborted();
  if (nativeRenderActive) {
    throw new ServiceUnavailableException('Native development is busy; try again shortly');
  }
  nativeRenderActive = true;
  let directory: string | undefined;
  try {
    const deadline = AbortSignal.timeout(DARKTABLE_TIMEOUT_MS);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const { stdout } = await runDarktable(['--version'], abort);
    verifyDarktableVersion(stdout);
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-darktable-'));
    // A private copy also excludes adjacent imported sidecars and makes original writes impossible.
    const source = join(directory, `original${extname(input)}`);
    const library = join(directory, 'library.db');
    const output = join(directory, 'developed.png');
    const config = join(directory, 'config');
    const cache = join(directory, 'cache');
    await mkdir(config);
    await mkdir(cache);
    await copyFile(input, source, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(source, 0o400);
    abort.throwIfAborted();
    const common = [
      '--library',
      library,
      '--apply-custom-presets',
      'false',
      '--icc-type',
      'SRGB',
      '--icc-intent',
      'RELATIVE_COLORIMETRIC',
      '--hq',
      'true',
      '--upscale',
      'false',
      '--core',
      '--configdir',
      config,
      '--cachedir',
      cache,
      '--disable-opencl',
      '--conf',
      'write_sidecar_files=never',
      '--conf',
      'plugins/darkroom/workflow=scene-referred (sigmoid)',
      '--conf',
      'plugins/imageio/format/png/bpp=16',
    ];
    // Native-size initialization avoids a tiny bounding box truncating the shorter image edge to zero.
    const bootstrap = join(directory, 'bootstrap.png');
    await runDarktable([source, bootstrap, ...common], abort);
    abort.throwIfAborted();
    if ((await stat(bootstrap)).size > MAX_OUTPUT_BYTES) {
      throw new Error('Invalid native bootstrap output size');
    }
    await rm(bootstrap); // Only the native history is needed; do not retain two full-resolution PNGs.
    prepareNativeHistory(library, recipe.exposureEV);
    await runDarktable([source, output, ...common], abort);
    abort.throwIfAborted();
    const file = await stat(output);
    if (!file.isFile() || file.size === 0 || file.size > MAX_OUTPUT_BYTES) {
      throw new Error('Invalid native output size');
    }
    const buffer = await readFile(output);
    const decoder = sharp(buffer, { failOn: 'warning' });
    const metadata = await decoder.metadata();
    if (
      metadata.format !== 'png' ||
      metadata.bitsPerSample !== 16 ||
      !metadata.width ||
      !metadata.height ||
      !metadata.icc
    ) {
      throw new Error('Native development did not produce a profiled 16-bit PNG');
    }
    await decoder.stats(); // Force complete decoding: a plausible header or a successful CLI exit is insufficient.
    abort.throwIfAborted();
    return buffer;
  } finally {
    try {
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      nativeRenderActive = false;
    }
  }
}
