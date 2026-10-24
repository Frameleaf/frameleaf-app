// FL-107: HDR10 and HLG masters on the bundled Studio worker.
//
// The engine composites the edit on its float route and hands over each frame as BT.2020 signal
// (PQ or HLG). This module streams those frames into an HEVC Main10 master with the container's
// ffmpeg (`hdr-master.mjs` owns the arguments and the BT.2100 rounding), measures the content light
// of what it encoded, and decodes the result back to prove the transfer, primaries, matrix, range
// and bit depth before anything is uploaded.
//
// At admission `probeHdrMasters` proves the same path on this container: a lossless patch fixture
// must meet the two-code BT.2020 limit, and a production-settings ten-bit ramp must decode back as
// ten-bit BT.2020 with the right transfer. Only the transfers that passed are advertised, as exact
// `<format>+<transfer>` evidence tokens next to the colour precision the server gates on.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MASTER_TRC,
  assertMasterSignalling,
  encoderArgs,
  pqDecode,
  probeMaster,
  rawFrameBytes,
  toRgb48,
  validateHdrPlaneSamples,
  validateMastering,
} from './hdr-master.mjs';

/** The one server format an HDR master is written as (server/src/utils/studio-export-formats.ts). */
export const HDR_MASTER_FORMAT = 'mp4-hevc-main10';
export const HDR_MASTER_ENCODER = 'libx265';
export const HDR_TRANSFERS = Object.freeze(['pq', 'hlg']);

/** Exact evidence that this session wrote and decoded back `format` with `transfer` (≤ 30 chars). */
export const hdrEvidenceToken = (transfer, format = HDR_MASTER_FORMAT) => `${format}+${transfer}`;

/** Mean decoded-luma error (ten-bit codes) a lossy master may show against the rendered signal. */
export const LUMA_MEAN_TOLERANCE = 4;

const KR = 0.2627;
const KB = 0.0593;
const KG = 1 - KR - KB;

let pqNits;
/** cd/m² of every 16-bit PQ code; MaxCLL/MaxFALL are measured on the samples actually encoded. */
const pqLut = () => {
  if (!pqNits) {
    pqNits = new Float64Array(65_536);
    for (let code = 0; code < 65_536; code++) pqNits[code] = pqDecode(code / 65_535);
  }
  return pqNits;
};

/** A little-endian 16-bit view of rgb48le bytes (copied when the bytes are not 2-byte aligned). */
export const rgb48Samples = (bytes) => {
  const aligned = bytes.byteOffset % 2 === 0 ? bytes : Buffer.from(bytes);
  return new Uint16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
};

/** CTA-861.3 MaxCLL / MaxFALL over rgb48le frames, in whole cd/m² (as `measureContentLight`). */
export function createLightMeter() {
  let maxCll = 0;
  let maxFall = 0;
  return {
    add(rgb48, width, height) {
      const lut = pqLut();
      const samples = rgb48Samples(rgb48);
      let sum = 0;
      for (let i = 0; i < width * height; i++) {
        const peak = lut[Math.max(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2])];
        if (peak > maxCll) maxCll = peak;
        sum += peak;
      }
      maxFall = Math.max(maxFall, sum / (width * height));
    },
    result() {
      const ceil = (value) => Math.max(0, Math.ceil(value - 0.01));
      return { maxCll: ceil(maxCll), maxFall: ceil(maxFall) };
    },
  };
}

/** Limited-range BT.2020 NCL luma codes of an rgb48le frame on a `stride` grid. */
export function lumaGrid(rgb48, width, height, stride = 4) {
  const samples = rgb48Samples(rgb48);
  const grid = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 3;
      const luma = (KR * samples[i] + KG * samples[i + 1] + KB * samples[i + 2]) / 65_535;
      grid.push(64 + 876 * luma);
    }
  }
  return Float64Array.from(grid);
}

/** Frame indices whose decoded picture is compared: the first, the middle and the last. */
export const sampledFrames = (count) => [...new Set([0, Math.floor((count - 1) / 2), count - 1])];

/**
 * Stream rgb48le frames into an HEVC Main10 master at `output` (written only here; the caller
 * publishes it). `frames` is an async iterable of `{ width, height, rgb48 }`. `light` is the PQ
 * static metadata to write (measured beforehand); the light of what is written is measured again
 * and returned with the luma grids of the sampled frames for the decode-back check.
 */
export async function streamHdrMaster({
  ffmpeg = 'ffmpeg',
  frames,
  frameCount,
  width,
  height,
  fps,
  transfer,
  light,
  mastering,
  audio,
  output,
  signal,
  onFrame,
  lossless = false,
}) {
  if (!HDR_TRANSFERS.includes(transfer)) throw new Error(`Unsupported HDR transfer ${transfer}`);
  if (transfer === 'pq') validateMastering(light, mastering);
  const args = encoderArgs({ width, height, fps, transfer, light, mastering, output, audio, lossless });
  // `-t`-free: the picture count is exactly what was piped; copied sound is cut to it below.
  if (audio) args.splice(args.indexOf('-movflags'), 0, '-shortest');
  const meter = createLightMeter();
  const wanted = new Set(sampledFrames(frameCount));
  const references = new Map();
  const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  child.stdin.on('error', () => {});
  let written = 0;
  try {
    for await (const frame of frames) {
      signal?.throwIfAborted();
      if (frame.width !== width || frame.height !== height) throw new Error('Every HDR frame must have the master size');
      if (frame.rgb48.byteLength !== rawFrameBytes(width, height, 'rgb48le')) throw new Error('Incomplete HDR frame');
      meter.add(frame.rgb48, width, height);
      if (wanted.has(written)) references.set(written, lumaGrid(frame.rgb48, width, height));
      if (!child.stdin.write(frame.rgb48)) {
        await Promise.race([once(child.stdin, 'drain'), closed.then(() => {
          throw new Error(`ffmpeg stopped while encoding: ${stderr.trim()}`);
        })]);
      }
      written++;
      onFrame?.(written);
    }
    child.stdin.end();
    const code = await closed;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`ffmpeg exited ${code}: ${stderr.trim()}`);
  } catch (error) {
    abort();
    await closed.catch(() => {});
    throw signal?.aborted ? signal.reason : error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (written !== frameCount) throw new Error(`Rendered ${written} HDR frames, expected ${frameCount}`);
  return { light: transfer === 'pq' ? meter.result() : null, references, args };
}

/**
 * Native ten-bit planes of a constant-rate master. No `-fps_mode`/`-vsync`: neither spelling works on
 * every ffmpeg the images ship (4.4 on the CUDA base, 7+ elsewhere), and a constant-rate master
 * decodes to the same pictures without it.
 */
const PLANE_DECODE_ARGS = (file) => [
  '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-pix_fmt', 'yuv420p10le', '-f', 'rawvideo', '-',
];

/** Every frame's ten-bit planes, for the small admission fixtures. */
const decodePlanes = (ffmpeg, file, width, height) => {
  const result = spawnSync(ffmpeg, PLANE_DECODE_ARGS(file), { maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new Error(`ffmpeg decode failed: ${String(result.stderr).trim()}`);
  const frameBytes = rawFrameBytes(width, height, 'yuv420p10le');
  if (result.stdout.byteLength === 0 || result.stdout.byteLength % frameBytes !== 0) {
    throw new Error('Decoded output has incomplete frames');
  }
  const samples = rgb48Samples(result.stdout);
  return Array.from({ length: result.stdout.byteLength / frameBytes }, (_, index) =>
    samples.slice((index * frameBytes) / 2, ((index + 1) * frameBytes) / 2),
  );
};

/** Run a media tool to completion, collecting stdout (bounded) and stderr. */
const collect = (file, args, { signal, maxBytes = 64 * 1024 * 1024 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    let stderr = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) abort();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (size > maxBytes) reject(new Error(`${path.basename(file)} wrote more than ${maxBytes} bytes`));
      else if (code !== 0) reject(new Error(`${path.basename(file)} exited ${code}: ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
  });

/**
 * Decode the master back and prove it is what the export promised:
 * - the container and stream signalling (`assertMasterSignalling`, including PQ static metadata);
 * - every decoded frame is ten-bit 4:2:0 limited-range BT.2020 NCL with the requested transfer;
 * - the decoded picture count; and
 * - the decoded luma of the sampled frames matches the rendered signal (mean within
 *   `LUMA_MEAN_TOLERANCE` codes), so no transfer, matrix or range was applied twice or not at all.
 * Returns the measurements.
 */
export async function verifyHdrMaster({
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  file,
  transfer,
  width,
  height,
  frameCount,
  light,
  mastering,
  references,
  signal,
}) {
  const probe = probeMaster(ffprobe, file);
  assertMasterSignalling(probe, { transfer, width, height, frames: frameCount, light, mastering });
  const tags = (
    await collect(
      ffprobe,
      [
        '-v', 'error', '-select_streams', 'v:0', '-show_entries',
        'frame=pix_fmt,color_range,color_space,color_primaries,color_transfer', '-of', 'compact=p=0', file,
      ],
      { signal },
    )
  )
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => Object.fromEntries(line.split('|').map((pair) => pair.split('='))));
  const want = {
    pix_fmt: 'yuv420p10le',
    color_range: 'tv',
    color_space: 'bt2020nc',
    color_primaries: 'bt2020',
    color_transfer: MASTER_TRC[transfer],
  };
  if (tags.length !== frameCount) throw new Error(`Decoded ${tags.length} HDR frames, expected ${frameCount}`);
  tags.forEach((frame, index) => {
    for (const [key, value] of Object.entries(want)) {
      if (frame[key] !== value) throw new Error(`Decoded frame ${index} is ${key}=${frame[key]}, not ${value}`);
    }
  });

  // Ten-bit planes, one frame at a time; only the sampled frames are compared.
  const frameBytes = rawFrameBytes(width, height, 'yuv420p10le');
  const child = spawn(ffmpeg, PLANE_DECODE_ARGS(file), { stdio: ['ignore', 'pipe', 'pipe'] });
  const abort = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', abort, { once: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const luma = {};
  let decoded = 0;
  let pending = [];
  let pendingBytes = 0;
  try {
    for await (const chunk of child.stdout) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= frameBytes) {
        const all = Buffer.concat(pending);
        const frame = all.subarray(0, frameBytes);
        pending = [all.subarray(frameBytes)];
        pendingBytes -= frameBytes;
        const reference = references.get(decoded);
        if (reference) {
          const planes = rgb48Samples(Buffer.from(frame));
          let sum = 0;
          let n = 0;
          for (let y = 0; y < height; y += 4) {
            for (let x = 0; x < width; x += 4) sum += Math.abs(planes[y * width + x] - reference[n++]);
          }
          luma[decoded] = sum / n;
        }
        decoded++;
      }
    }
    const code = await closed;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`ffmpeg decode exited ${code}: ${stderr.trim()}`);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (pendingBytes !== 0) throw new Error('The decoded master ends in an incomplete frame');
  if (decoded !== frameCount) throw new Error(`Decoded ${decoded} HDR pictures, expected ${frameCount}`);
  for (const index of references.keys()) {
    if (!(luma[index] <= LUMA_MEAN_TOLERANCE)) {
      throw new Error(
        `Decoded frame ${index} differs from the rendered ${transfer.toUpperCase()} signal by ${luma[index]?.toFixed(2)} luma codes on average`,
      );
    }
  }
  return { probe, frames: decoded, lumaMeanError: luma };
}

/**
 * Render-to-master for one export: stream the engine's frames into a private file, decode it back,
 * and only then move it to `output`. PQ needs MaxCLL/MaxFALL before the first frame is encoded, so
 * a PQ master renders twice: a measuring pass, then the encoding pass, whose measured light must be
 * identical (the engine is deterministic; a difference means the written metadata would be wrong).
 *
 * `renderFrames()` returns a fresh async iterable of `{ width, height, rgb48 }` for the whole range.
 */
export async function writeHdrMaster({
  ffmpeg = 'ffmpeg',
  ffprobe = 'ffprobe',
  renderFrames,
  frameCount,
  width,
  height,
  fps,
  transfer,
  mastering,
  audio,
  output,
  signal,
  onProgress,
  /** Admission fixtures only: isolate the colour conversion from compression loss. */
  lossless = false,
}) {
  let light = null;
  const passes = transfer === 'pq' ? 2 : 1;
  if (transfer === 'pq') {
    const meter = createLightMeter();
    let measured = 0;
    for await (const frame of renderFrames()) {
      signal?.throwIfAborted();
      meter.add(frame.rgb48, frame.width, frame.height);
      measured++;
      onProgress?.(measured / (frameCount * passes));
    }
    if (measured !== frameCount) throw new Error(`Rendered ${measured} HDR frames, expected ${frameCount}`);
    light = meter.result();
  }
  const partial = `${output}.${randomUUID()}.partial.mp4`;
  try {
    const written = await streamHdrMaster({
      ffmpeg,
      frames: renderFrames(),
      frameCount,
      width,
      height,
      fps,
      transfer,
      light,
      mastering,
      audio,
      lossless,
      output: partial,
      signal,
      onFrame: (count) => onProgress?.((count + (passes - 1) * frameCount) / (frameCount * passes)),
    });
    if (light && (written.light.maxCll !== light.maxCll || written.light.maxFall !== light.maxFall)) {
      throw new Error('The engine rendered different light on the encoding pass; the HDR10 metadata would be wrong');
    }
    const verified = await verifyHdrMaster({
      ffmpeg,
      ffprobe,
      file: partial,
      transfer,
      width,
      height,
      frameCount,
      light,
      mastering,
      references: written.references,
      signal,
    });
    await rename(partial, output);
    return { light, verified, args: written.args };
  } finally {
    await rm(partial, { force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Admission: prove this container's HDR master path                    */
/* ------------------------------------------------------------------ */

/** The widest PQ display, so every probe code is inside it. */
const PROBE_MASTERING = Object.freeze({ maxNits: 10_000, minNits: 0.005 });

/** Sixteen flat BT.2020 patches over a gradient: the fixture whose interiors bound the 10-bit error. */
const patchFixture = (width, height, scale) => {
  const rgba = new Float32Array(width * height * 4);
  const colour = (p) => [0, 1, 2].map((c) => 0.08 + 0.84 * (((p * 7 + c * 5 + 3) * 0.618_033_988_7) % 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const texel = y < height / 2
        ? colour(Math.floor(x / (width / 16))).map((value) => Math.min(value * scale, 1))
        : [x / width, 1 - x / width, (y - height / 2) / (height / 2)];
      rgba.set([...texel, 1], (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
};

/** A grey ramp across every ten-bit luma code, as rgb48le. */
const rampFrame = (width, height, offset = 0) => {
  const samples = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Math.round(Math.min(1, Math.max(0, (x + offset) / (width - 1))) * 65_535);
      samples.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  return Buffer.from(samples.buffer);
};

/**
 * Prove one transfer: (1) precision, a lossless master of the patch fixture decoded to ten-bit planes
 * where every flat-patch interior sample is within two codes (and two RGB10 codes after inversion);
 * (2) the production path, a three-frame ramp written and verified exactly as an export is, whose
 * decoded luma must take far more distinct values than an 8-bit picture could (≥ 512 of 877).
 */
async function proveTransfer(transfer, { ffmpeg, ffprobe, folder, signal }) {
  const width = 512;
  const height = 64;
  const fixture = patchFixture(width, height, transfer === 'pq' ? 0.75 : 0.95);
  const side = width / 16;
  const interiors = [];
  for (let p = 0; p < 16; p++) {
    for (let y = 8; y < height / 2 - 8; y += 2) {
      for (let x = p * side + 8; x < (p + 1) * side - 8; x += 2) interiors.push([x, y]);
    }
  }
  let worstRgb = 0;
  const precision = path.join(folder, `${transfer}-precision.mp4`);
  const fixtureRgb48 = toRgb48(fixture);
  await writeHdrMaster({
    ffmpeg,
    ffprobe,
    renderFrames: async function* () {
      yield { width, height, rgb48: fixtureRgb48 };
    },
    frameCount: 1,
    width,
    height,
    fps: '24/1',
    transfer,
    mastering: PROBE_MASTERING,
    output: precision,
    lossless: true,
    signal,
  });
  const samples = interiors.map(([x, y]) => ({
    frame: 0,
    x,
    y,
    rgb: fixture.rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3),
  }));
  for (const { rgbError } of validateHdrPlaneSamples(decodePlanes(ffmpeg, precision, width, height), width, height, samples)) {
    worstRgb = Math.max(worstRgb, ...rgbError);
  }

  const rampWidth = 1024;
  const rampHeight = 16;
  const ramp = [0, 1, 2].map((offset) => rampFrame(rampWidth, rampHeight, -offset));
  const output = path.join(folder, `${transfer}-ramp.mp4`);
  const result = await writeHdrMaster({
    ffmpeg,
    ffprobe,
    renderFrames: async function* () {
      for (const rgb48 of ramp) yield { width: rampWidth, height: rampHeight, rgb48 };
    },
    frameCount: ramp.length,
    width: rampWidth,
    height: rampHeight,
    fps: '24/1',
    transfer,
    mastering: PROBE_MASTERING,
    output,
    signal,
  });
  const [planes] = decodePlanes(ffmpeg, output, rampWidth, rampHeight);
  const row = new Set(planes.subarray(8 * rampWidth, 9 * rampWidth));
  if (row.size < 512) throw new Error(`the decoded ramp has ${row.size} luma codes; an 8-bit picture has at most 220`);
  return { worstInverseRgbCodes: worstRgb, rampLumaCodes: row.size, lumaMeanError: result.verified.lumaMeanError };
}

/**
 * Admission evidence for HDR masters on this container. Returns the evidence tokens, the encoder,
 * the colour precision (null when no transfer passed) and why a transfer was not offered.
 */
export async function probeHdrMasters({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', encoders, filters, log = () => {}, signal } = {}) {
  const refused = {};
  const proven = {};
  if (encoders && !encoders.has(HDR_MASTER_ENCODER)) {
    for (const transfer of HDR_TRANSFERS) refused[transfer] = `no ${HDR_MASTER_ENCODER} encoder`;
  } else if (filters && !filters.has('zscale')) {
    for (const transfer of HDR_TRANSFERS) refused[transfer] = 'no zscale filter (zimg) for the BT.2020 conversion';
  } else {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-hdr-probe-'));
    try {
      for (const transfer of HDR_TRANSFERS) {
        signal?.throwIfAborted();
        try {
          proven[transfer] = await proveTransfer(transfer, { ffmpeg, ffprobe, folder, signal });
        } catch (error) {
          signal?.throwIfAborted();
          refused[transfer] = String(error.message).split('\n')[0];
        }
      }
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  const transfers = HDR_TRANSFERS.filter((transfer) => proven[transfer]);
  log(
    transfers.length > 0
      ? `HDR masters: ${transfers.map((transfer) => `${transfer.toUpperCase()} (worst ${proven[transfer].worstInverseRgbCodes.toFixed(2)} RGB10 codes, ${proven[transfer].rampLumaCodes} ramp codes)`).join(', ')}` +
          (Object.keys(refused).length > 0 ? `; not offered: ${Object.entries(refused).map(([id, why]) => `${id} (${why})`).join(', ')}` : '')
      : `HDR masters not offered: ${Object.entries(refused).map(([id, why]) => `${id} (${why})`).join(', ')}`,
  );
  return {
    transfers,
    formats: transfers.length > 0 ? [HDR_MASTER_FORMAT, ...transfers.map((transfer) => hdrEvidenceToken(transfer))] : [],
    codecs: transfers.length > 0 ? [HDR_MASTER_ENCODER] : [],
    colorPrecision:
      transfers.length > 0 ? { maxBitDepth: 10, hdr10: transfers.includes('pq'), dolbyVision: false } : null,
    proven,
    refused,
  };
}
