import { ServiceUnavailableException } from '@nestjs/common';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
  ASSET_DEVELOP_BITMAP_MASK_KINDS,
  AssetDevelopMaskKind,
  type DarktableDevelopRecipe,
  DarktableDevelopRecipeSchema,
} from 'src/dtos/asset-develop.dto.js';
import { trackQueueChild } from 'src/queue/child-process.js';
import { NATIVE_RAW_ORDER, nativeBlendParams, nativeModuleParams } from 'src/utils/darktable-controls.js';
import { type DevelopBitmap } from 'src/utils/develop-cleanup.js';
import { maskWeight, originalMaskWeight } from 'src/utils/develop-recipe.js';

const execFile = promisify(execFileCallback);

// release-5.6.1: https://github.com/darktable-org/darktable/tree/03179f8e080aa9cedebfe14b098b7ba88940a292
// The deployment image must pin this source and its dependencies; --version verifies the release, not build provenance.
export const DARKTABLE_RENDERER_VERSION =
  'frameleaf-darktable/2;darktable/5.6.1;03179f8e080aa9cedebfe14b098b7ba88940a292;lens-calibration/1;mask-geometry/1;omp-thread-limit/1';
export const DARKTABLE_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1024 ** 3;
// ponytail: one native render per worker process; use shared admission if the deployment needs a global ceiling.
let nativeRenderActive = false;

/** An aborted execFile promise can reject before close; keep admission until the child is actually gone. */
async function runDarktable(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const execution = execFile('darktable-cli', args, {
    signal,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    // Pin native OpenMP concurrency for repeatable pixels without changing the worker environment.
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
  trackQueueChild(execution.child);
  const closed = new Promise<void>((resolve) => execution.child.once('close', () => resolve()));
  // Node 24 execFile does not forward killSignal to spawn's AbortSignal handler.
  const abort = () => {
    execution.child.kill('SIGKILL');
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) {
    abort();
  }
  try {
    return await execution;
  } finally {
    await closed;
    signal.removeEventListener('abort', abort);
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
export function prepareNativeHistory(
  library: string,
  value: number | DarktableDevelopRecipe,
  rasterFiles: string[] = [],
): { rotatedMasks: boolean } {
  if (endianness() !== 'LE') throw new Error('Unsupported native parameter endianness');
  const recipe = DarktableDevelopRecipeSchema.parse(
    typeof value === 'number' ? { version: 2, renderer: 'darktable/5.6.1', exposureEV: value } : value,
  );
  const db = new DatabaseSync(library, { open: true });
  try {
    db.exec('BEGIN IMMEDIATE');
    const images = db.prepare('SELECT id, history_end FROM images').all();
    if (images.length !== 1) throw new Error('Native development did not create one image history');
    const image = images[0];
    let end = Number(image.history_end);
    const rows = (operation: string) =>
      db
        .prepare('SELECT * FROM history WHERE imgid = ? AND operation = ? AND num < ? ORDER BY num DESC')
        .all(image.id, operation, image.history_end);
    const exposureRows = rows('exposure');
    const exposure = exposureRows[0];
    if (
      !exposure ||
      exposure.module !== 7 ||
      !(exposure.op_params instanceof Uint8Array) ||
      exposureRows.some((row) => row.multi_priority !== exposure.multi_priority)
    )
      throw new Error('Unsupported native exposure history');
    const originalExposure = Buffer.from(exposure.op_params);
    db.prepare('UPDATE history SET op_params = ?, enabled = 1 WHERE imgid = ? AND num = ?').run(
      translateDarktableExposure(originalExposure, recipe.exposureEV),
      image.id,
      exposure.num,
    );
    // Preserve the bootstrap's full module order. Add duplicates only to an explicit, verified order.
    let order: Array<[string, number]> | undefined;
    const ensureOrder = () => {
      if (order) return order;
      const row = db.prepare('SELECT version, iop_list FROM module_order WHERE imgid = ?').get(image.id);
      if (!row) throw new Error('Missing native module order');
      if (typeof row.iop_list === 'string' && row.iop_list) {
        const entries = row.iop_list.split(',');
        if (entries.length % 2) throw new Error('Invalid native module order');
        order = Array.from({ length: entries.length / 2 }, (_, index) => [
          entries[index * 2],
          Number(entries[index * 2 + 1]),
        ]);
        if (
          order[0][0] !== 'rawprepare' ||
          order.at(-1)![0] !== 'gamma' ||
          order.some(([op, instance]) => !/^[a-z0-9]+$/.test(op) || !Number.isSafeInteger(instance))
        )
          throw new Error('Unsupported native module order');
      } else if (row.version === 4) order = NATIVE_RAW_ORDER.map((op) => [op, 0]);
      else throw new Error('Unsupported native default module order');
      return order;
    };
    const put = (
      operation: string,
      module: number,
      params: Buffer,
      enabled: boolean,
      colorspace: number,
      instance = 0,
      rasterInstance?: number,
    ) => {
      const list = ensureOrder();
      if (list.every(([op]) => op !== operation)) throw new Error(`Unsupported native module order for ${operation}`);
      const existing = rows(operation).find((row) => row.multi_priority === instance);
      if (
        existing &&
        (existing.module !== module ||
          !(existing.op_params instanceof Uint8Array) ||
          existing.op_params.length !== params.length)
      )
        throw new Error(`Unsupported native ${operation} history`);
      if (existing)
        db.prepare('UPDATE history SET op_params = ?, enabled = ? WHERE imgid = ? AND num = ?').run(
          params,
          enabled ? 1 : 0,
          image.id,
          existing.num,
        );
      else
        db.prepare(
          'INSERT INTO history(imgid, num, operation, module, op_params, enabled, blendop_params, blendop_version, multi_priority, multi_name, multi_name_hand_edited) VALUES(?, ?, ?, ?, ?, ?, ?, 14, ?, ?, 0)',
        ).run(
          image.id,
          end++,
          operation,
          module,
          params,
          enabled ? 1 : 0,
          nativeBlendParams(colorspace, rasterInstance),
          instance,
          instance ? `Frameleaf mask ${instance}` : 'Frameleaf',
        );
      if (list.every(([op, priority]) => !(op === operation && priority === instance))) {
        const last = list.findLastIndex(([op]) => op === operation);
        list.splice(last + 1, 0, [operation, instance]);
      }
    };
    if (recipe.whiteBalance) {
      const row = rows('temperature')[0];
      if (!row || row.module !== 4 || !(row.op_params instanceof Uint8Array) || row.op_params.length !== 20)
        throw new Error('Unsupported native white balance history');
      const params = Buffer.from(row.op_params);
      for (const [index, gain] of [
        recipe.whiteBalance.red,
        recipe.whiteBalance.green,
        recipe.whiteBalance.blue,
      ].entries()) {
        const coefficient = params.readFloatLE(index * 4) * gain;
        if (!Number.isFinite(coefficient) || coefficient <= 0 || coefficient > 8)
          throw new Error('Native white balance coefficient out of range');
        params.writeFloatLE(coefficient, index * 4);
      }
      params.writeInt32LE(2, 16); // native USER preset; preserve 4th camera channel.
      put('temperature', 4, params, true, 0);
    }
    const globals = nativeModuleParams(
      recipe.sensorCanvas ? { ...recipe, lensCorrection: false, crop: undefined, straighten: undefined } : recipe,
    );
    for (const [operation, module] of globals)
      put(operation, module.version, module.params, module.enabled, module.colorspace);
    if (recipe.sensorCanvas || recipe.rotation || recipe.flipHorizontal || recipe.flipVertical) {
      const row = rows('flip')[0];
      if (!row || row.module !== 2 || !(row.op_params instanceof Uint8Array) || row.op_params.length !== 4)
        throw new Error('Unsupported native orientation history');
      let orientation = Buffer.from(row.op_params).readInt32LE(0);
      if (orientation === -1)
        orientation = Number(db.prepare('SELECT orientation FROM images WHERE id = ?').get(image.id)?.orientation);
      if (!Number.isSafeInteger(orientation) || orientation < 0 || orientation > 7)
        throw new Error('Unsupported native camera orientation');
      for (let turn = 0; turn < (recipe.rotation ?? 0) / 90; turn++)
        orientation = orientation ^ (orientation & 4 ? 2 : 1) ^ 4;
      if (recipe.flipHorizontal) orientation ^= orientation & 4 ? 1 : 2;
      if (recipe.flipVertical) orientation ^= orientation & 4 ? 2 : 1;
      const params = Buffer.alloc(4);
      params.writeInt32LE(recipe.sensorCanvas ? 0 : orientation);
      put('flip', 2, params, true, 0);
      if (recipe.sensorCanvas) {
        // Camera pixel-aspect/tilted-sensor transforms are downstream of rasterfile too.
        for (const operation of ['rotatepixels', 'scalepixels', 'clipping', 'crop', 'ashift'])
          for (const geometry of rows(operation))
            db.prepare('UPDATE history SET enabled = 0 WHERE imgid = ? AND num = ?').run(image.id, geometry.num);
      }
    }
    const masks = recipe.masks?.filter((mask) => mask.enabled && mask.amount > 0) ?? [];
    if (masks.length !== rasterFiles.length) throw new Error('Missing native raster mask files');
    for (const [index, mask] of masks.entries()) {
      const instance = index + 1;
      const raster = Buffer.alloc(4100); // rasterfile.c v1: mode + 2048 path + 2048 filename
      raster.writeInt32LE(7);
      const file = rasterFiles[index];
      if (Buffer.byteLength(dirname(file)) >= 2048 || Buffer.byteLength(basename(file)) >= 2048)
        throw new Error('Native raster path too long');
      raster.write(dirname(file), 4, 'utf8');
      raster.write(basename(file), 2052, 'utf8');
      put('rasterfile', 1, raster, true, 0, instance);
      if (mask.adjustments.exposureEV)
        put(
          'exposure',
          7,
          translateDarktableExposure(originalExposure, mask.adjustments.exposureEV),
          true,
          4,
          instance,
          instance,
        );
      for (const [operation, module] of nativeModuleParams(mask.adjustments))
        put(operation, module.version, module.params, true, module.colorspace, instance, instance);
    }
    if (order)
      db.prepare('UPDATE module_order SET version = 0, iop_list = ? WHERE imgid = ?').run(
        order.map(([op, priority]) => `${op},${priority}`).join(','),
        image.id,
      );
    db.prepare('UPDATE images SET history_end = ? WHERE id = ?').run(end, image.id);
    const rotatedMasks =
      masks.some((mask) => !!mask.adjustments.exposureEV || nativeModuleParams(mask.adjustments).size > 0) &&
      rows('rotatepixels').some((row) => row.enabled === 1);
    db.exec('COMMIT');
    return { rotatedMasks };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

/** Mask-only rasterization reuses existing stroke/shape coverage; pixels are never developed here. */
async function writeNativeMasks(
  library: string,
  directory: string,
  recipe: DarktableDevelopRecipe,
  bitmaps: ReadonlyMap<string, DevelopBitmap>,
  signal: AbortSignal,
) {
  const masks = recipe.masks?.filter((mask) => mask.enabled && mask.amount > 0) ?? [];
  if (masks.length === 0) return [];
  const db = new DatabaseSync(library);
  let original: { width: number; height: number };
  try {
    const image = db.prepare('SELECT width, height FROM images').get();
    const row = db
      .prepare("SELECT module, op_params FROM history WHERE operation = 'rawprepare' ORDER BY num DESC LIMIT 1")
      .get();
    if (!image || !row || row.module !== 2 || !(row.op_params instanceof Uint8Array) || row.op_params.length !== 32)
      throw new Error('Unsupported native sensor crop history');
    const params = Buffer.from(row.op_params);
    original = {
      width: Number(image.width) - params.readInt32LE(0) - params.readInt32LE(8),
      height: Number(image.height) - params.readInt32LE(4) - params.readInt32LE(12),
    };
    if (original.width <= 0 || original.height <= 0) throw new Error('Invalid native sensor dimensions');
  } finally {
    db.close();
  }
  // ponytail: bounded 2048-edge coverage grid; increase after rendered thin-edge qualification.
  const scale = Math.min(1, 2048 / Math.max(original.width, original.height));
  const width = Math.max(1, Math.round(original.width * scale)),
    height = Math.max(1, Math.round(original.height * scale));
  const files: string[] = [];
  for (const [index, mask] of masks.entries()) {
    if (ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) && (!mask.artifact || !bitmaps.has(mask.artifact)))
      throw new Error('Missing owned native mask artifact');
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      signal.throwIfAborted();
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width,
          v = (y + 0.5) / height;
        const weight =
          mask.kind === AssetDevelopMaskKind.Radial || mask.kind === AssetDevelopMaskKind.Linear
            ? maskWeight(mask, u, v, original.width / original.height)
            : originalMaskWeight(mask, u * original.width, v * original.height, original, bitmaps);
        pixels[y * width + x] = Math.round(weight * mask.amount * 2.55);
      }
    }
    const file = join(directory, `mask-${index}.png`);
    await sharp(pixels, { raw: { width, height, channels: 1 } })
      .toColourspace('srgb')
      .png()
      .toFile(file);
    files.push(file);
  }
  return files;
}

/** Real native RAW processing. Both interactive and final output use this full-resolution sRGB pipeline. */
export async function renderDarktable(
  input: string,
  value: unknown,
  signal?: AbortSignal,
  bitmaps: ReadonlyMap<string, DevelopBitmap> = new Map(),
): Promise<Buffer> {
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
    const masks = await writeNativeMasks(library, directory, recipe, bitmaps, abort);
    const { rotatedMasks } = prepareNativeHistory(library, recipe, masks);
    const rendered = await runDarktable([source, output, ...common], abort);
    if (
      recipe.lensCorrection &&
      !recipe.sensorCanvas &&
      !/^[1-7]$/.test(
        (rendered.stdout + rendered.stderr)
          .matchAll(/frameleaf-lens-calibration:(\d+)\b/g)
          .toArray()
          .at(-1)?.[1] ?? '',
      )
    )
      throw new Error('Native lens calibration unavailable; install the qualified engine or disable lens correction');
    if (rotatedMasks && !(rendered.stdout + rendered.stderr).includes('frameleaf-native-mask-geometry:rotatepixels:1'))
      throw new Error('Native tilted-sensor mask support unavailable; install the qualified engine');
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

/** Resize/encode directly from the profiled native 16-bit output; never round-trip through 8-bit raw. */
export async function encodeNativeDevelopOutput(
  buffer: Buffer,
  options: { format: 'jpeg' | 'webp'; quality: number; progressive?: boolean; size?: number },
  output?: string,
): Promise<Buffer | undefined> {
  let pipeline = sharp(buffer, { failOn: 'warning' }).pipelineColorspace('rgb16').keepIccProfile();
  const targetSize = options.size;
  if (targetSize) pipeline = pipeline.resize(targetSize, targetSize, { fit: 'inside', withoutEnlargement: true });
  pipeline = pipeline.toFormat(options.format, {
    quality: options.quality,
    chromaSubsampling: '4:4:4',
    progressive: options.progressive ?? false,
  });
  if (output) {
    await pipeline.toFile(output);
    return;
  }
  return pipeline.toBuffer();
}
