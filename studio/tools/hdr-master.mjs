// FL-107 (VID-202): native HDR10/HLG master from the renderer's explicit output
// conversion. Frames arrive as straight RGBA BT.2020 signal in [0, 1] (PQ or
// HLG, see ColorOutputPipeline). This module
//   - measures static content light levels of the edited output itself
//     (CTA-861.3 MaxCLL/MaxFALL from decoded PQ light, never copied from a source),
//   - validates them against the declared mastering display,
//   - encodes HEVC Main10 BT.2020 with explicit matrix/range/dither (the FL-102
//     float-to-integer convention) and HDR10 SEI, and
//   - verifies the written stream by probing and decoding it back.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { sourceTimeline } from './preflight-validators.mjs';

const PQ_M1 = 2610 / 16384;
const PQ_M2 = (2523 / 4096) * 128;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = (2413 / 4096) * 32;
const PQ_C3 = (2392 / 4096) * 32;

export function pqDecode(signal) {
  const e = Math.min(Math.max(signal, 0), 1) ** (1 / PQ_M2);
  return 10000 * (Math.max(e - PQ_C1, 0) / (PQ_C2 - PQ_C3 * e)) ** (1 / PQ_M1);
}

/** ITU-R BT.2020 container primaries and D65 in ST 2086 units (0.00002). */
export const BT2020_MASTERING_PRIMARIES = { G: [8500, 39850], B: [6550, 2300], R: [35400, 14600], WP: [15635, 16450] };

/**
 * CTA-861.3 static metadata of the frames themselves: MaxCLL is the brightest
 * max(R,G,B) of any pixel, MaxFALL the brightest frame-average of max(R,G,B), in
 * cd/m². Transparent texels count as black (the master has no alpha).
 */
export function measureContentLight(frames) {
  let maxCll = 0;
  let maxFall = 0;
  for (const { rgba, width, height } of frames) {
    let sum = 0;
    for (let i = 0; i < width * height; i++) {
      const a = rgba[i * 4 + 3];
      const peak = a <= 0 ? 0 : pqDecode(Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) * Math.min(a, 1));
      if (peak > maxCll) maxCll = peak;
      sum += peak;
    }
    maxFall = Math.max(maxFall, sum / (width * height));
  }
  // Round up to whole cd/m²; 0.01 cd/m² absorbs float32 PQ quantisation noise.
  const ceil = (v) => Math.max(0, Math.ceil(v - 0.01));
  return { maxCll: ceil(maxCll), maxFall: ceil(maxFall) };
}

/**
 * The declared mastering display must contain the content. Throws instead of
 * writing metadata that claims a peak the pictures exceed.
 */
export function validateMastering(light, mastering) {
  if (!(mastering.maxNits > mastering.minNits) || mastering.minNits < 0) {
    throw new Error('Mastering display luminance range is invalid');
  }
  if (light.maxCll > mastering.maxNits) {
    throw new Error(`Content peaks at ${light.maxCll} cd/m², above the ${mastering.maxNits} cd/m² mastering display; `
      + 'grade within the mastering peak or declare the display it was mastered on');
  }
  if (light.maxFall > light.maxCll) throw new Error('MaxFALL cannot exceed MaxCLL');
  return true;
}

export function masterDisplayParam(mastering) {
  const p = BT2020_MASTERING_PRIMARIES;
  const L = `L(${Math.round(mastering.maxNits * 10000)},${Math.round(mastering.minNits * 10000)})`;
  return `G(${p.G.join(',')})B(${p.B.join(',')})R(${p.R.join(',')})WP(${p.WP.join(',')})${L}`;
}

/** Straight RGBA float signal → rgb48le over black, full range (alpha applied). */
export function toRgb48(frame) {
  const { rgba, width, height } = frame;
  const out = new Uint16Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = Math.min(Math.max(rgba[i * 4 + 3], 0), 1);
    for (let c = 0; c < 3; c++) {
      out[i * 3 + c] = Math.round(Math.min(Math.max(rgba[i * 4 + c] * a, 0), 1) * 65535);
    }
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

export function encoderArgs({ width, height, fps, transfer, light, mastering, output, lossless = false, timeline, audio }) {
  const trc = transfer === 'pq' ? 'smpte2084' : 'arib-std-b67';
  const x265 = [
    'profile=main10', ...(timeline ? ['bframes=0'] : []), 'repeat-headers=1', 'colorprim=bt2020', `transfer=${trc}`,
    'colormatrix=bt2020nc', 'range=limited',
    // Verification masters isolate the colour conversion from compression loss.
    ...(lossless ? ['lossless=1'] : []),
    ...(transfer === 'pq'
      ? ['hdr10=1', 'hdr10-opt=1', `master-display=${masterDisplayParam(mastering)}`,
        `max-cll=${light.maxCll},${light.maxFall}`]
      : []),
  ];
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb48le', '-s', `${width}x${height}`, '-r', String(fps),
    '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'rgb', '-color_range', 'pc',
    '-i', '-',
    ...(audio ? ['-i', audio.path, '-map', '0:v:0', '-map', `1:a:${audio.stream ?? 0}`, '-c:a', 'copy'] : []),
    // FL-102 convention: explicit matrix, range and error-diffusion dither.
    '-vf', [
      'scale=in_range=pc:out_range=tv:out_color_matrix=bt2020:sws_dither=ed,format=yuv420p10le',
      ...(timeline ? [`settb=${timeline.timeBase}`, `setpts=${timeline.pts.reduceRight((expr, pts, i) =>
        i === timeline.pts.length - 1 ? String(pts) : `if(eq(N,${i}),${pts},${expr})`, '').replaceAll(',', '\\,')}`] : []),
    ].join(','),
    ...(timeline ? ['-fps_mode', 'passthrough', '-enc_time_base', timeline.timeBase,
      '-video_track_timescale', timeline.timeBase.split('/')[1], '-avoid_negative_ts', 'disabled'] : []),
    '-c:v', 'libx265', '-preset', 'medium', ...(lossless ? [] : ['-crf', '12']),
    '-x265-params', x265.join(':'),
    '-tag:v', 'hvc1',
    '-color_primaries', 'bt2020', '-color_trc', trc, '-colorspace', 'bt2020nc', '-color_range', 'tv',
    '-movflags', '+faststart', output,
  ];
}

/** Encodes frames (an array of signal frames) into an MP4 HDR master. */
export async function encodeHdrMaster({ ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', frames, fps, transfer, mastering, output, lossless = false, timeline, audio, signal, validate }) {
  if (!['pq', 'hlg'].includes(transfer)) throw new Error(`Unsupported HDR transfer ${transfer}`);
  if (frames.length === 0) throw new Error('No frames to encode');
  const { width, height } = frames[0];
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new Error('Every frame must have the same size');
  }
  if (timeline) {
    sourceTimeline(timeline.timeBase, timeline.pts.map((pts) => ({ pts })));
    if (timeline.pts.length !== frames.length) throw new Error('One output PTS is required per rendered frame');
    // ponytail: setpts lookup is bounded to diagnostic sequences; a streaming timestamped encoder is the worker upgrade.
    if (frames.length > 256) throw new Error('Timestamped diagnostic masters are limited to 256 frames');
  }
  if (audio && (typeof audio.path !== 'string' || !audio.path ||
    !Number.isSafeInteger(audio.stream ?? 0) || (audio.stream ?? 0) < 0)) {
    throw new Error('Audio requires a path and a nonnegative stream index');
  }
  signal?.throwIfAborted();
  // HDR10 static metadata applies to PQ; HLG masters carry none.
  const light = transfer === 'pq' ? measureContentLight(frames) : null;
  if (light) validateMastering(light, mastering);
  // The final path only ever names a complete master. A retry restarts from the
  // caller's immutable rendered sequence; an interrupted attempt never replaces it.
  const partial = `${output}.${randomUUID()}.partial.mp4`;
  const args = encoderArgs({ width, height, fps, transfer, light, mastering, output: partial, lossless, timeline, audio });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const abort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(signal.reason);
        else if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
      });
      child.stdin.on('error', () => {});
      for (const frame of frames) child.stdin.write(toRgb48(frame));
      child.stdin.end();
    });
    signal?.throwIfAborted();
    const probe = probeMaster(ffprobe, partial);
    const trc = transfer === 'pq' ? 'smpte2084' : 'arib-std-b67';
    assert.deepEqual([probe.codec, probe.profile, probe.pixFmt, probe.primaries, probe.transfer, probe.matrix, probe.range],
      ['hevc', 'Main 10', 'yuv420p10le', 'bt2020', trc, 'bt2020nc', 'tv'], 'HDR master signalling mismatch');
    assert.deepEqual([probe.width, probe.height, probe.frames], [width, height, frames.length], 'HDR master picture count/size mismatch');
    if (light) {
      assert.deepEqual([Number(probe.contentLight?.max_content), Number(probe.contentLight?.max_average)],
        [light.maxCll, light.maxFall], 'HDR master content-light mismatch');
      const ratio = (value) => { const [num, den] = String(value).split('/').map(Number); return num / den; };
      const data = probe.mastering;
      assert.deepEqual([ratio(data?.max_luminance), ratio(data?.min_luminance)],
        [Math.round(mastering.maxNits * 10000) / 10000, Math.round(mastering.minNits * 10000) / 10000],
        'HDR master mastering luminance mismatch');
      for (const [key, prefix] of [['R', 'red'], ['G', 'green'], ['B', 'blue'], ['WP', 'white_point']]) {
        assert.deepEqual([ratio(data?.[`${prefix}_x`]), ratio(data?.[`${prefix}_y`])],
          BT2020_MASTERING_PRIMARIES[key].map((value) => value / 50000), 'HDR master mastering chromaticity mismatch');
      }
    }
    const decoded = decodeMaster(ffmpeg, partial, width, height);
    assert.equal(decoded.length, frames.length, 'HDR master decoded frame count mismatch');
    // Caller-specific picture/timing/audio QC must pass while the result is still private.
    await validate?.({ output: partial, probe, decoded, light });
    signal?.throwIfAborted();
    await rename(partial, output);
  } finally {
    await rm(partial, { force: true });
  }
  return { light, args };
}

/** Probes the master: codec, 10-bit, colour tags and HDR10 side data. */
export function probeMaster(ffprobe, file) {
  const run = (args) => {
    const result = spawnSync(ffprobe, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  const { streams: [stream] } = run(['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', file]);
  const { frames } = run(['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_frames',
    '-show_entries', 'frame=side_data_list', '-of', 'json', file]);
  const sideData = [...(stream.side_data_list ?? []), ...(frames?.[0]?.side_data_list ?? [])];
  const find = (type) => sideData.find((entry) => entry.side_data_type === type);
  return {
    codec: stream.codec_name, profile: stream.profile, pixFmt: stream.pix_fmt,
    primaries: stream.color_primaries, transfer: stream.color_transfer, matrix: stream.color_space,
    range: stream.color_range, frames: Number(stream.nb_frames), rFrameRate: stream.r_frame_rate,
    width: stream.width, height: stream.height,
    contentLight: find('Content light level metadata'),
    mastering: find('Mastering display metadata'),
  };
}

/** Decodes the master back to full-range BT.2020 RGB signal (rgb48le) for comparison. */
export function decodeMaster(ffmpeg, file, width, height) {
  const result = spawnSync(ffmpeg, ['-v', 'error', '-xerror', '-i', file,
    '-vf', 'scale=in_range=tv:out_range=pc:in_color_matrix=bt2020:flags=accurate_rnd+full_chroma_int,format=rgb48le',
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  if (result.status !== 0) throw new Error(`ffmpeg decode failed: ${result.stderr}`);
  const samples = new Uint16Array(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength / 2);
  const frameSize = width * height * 3;
  return Array.from({ length: samples.length / frameSize }, (_, i) =>
    Float32Array.from(samples.subarray(i * frameSize, (i + 1) * frameSize), (v) => v / 65535));
}
