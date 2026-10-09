/** Opt-in precodec regression. Run through tsx with the server tsconfig.
 * Arguments: FFmpeg executable, gbrp16le fixture, width, height, owned output directory.
 * The none run is a diagnostic control; it never changes the production plan.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDetachedChildGroup } from './media-encode-process-group.mjs';
import { ColorMatrix, TranscodeHardwareAcceleration, VideoCodec } from '../src/enum.ts';
import { selectEncoderPixelFormat } from '../src/utils/media-encode.ts';
import { parseSourcePixelLayout } from '../src/utils/media-decode.ts';
import { EditedMasterColorPolicy, getFfmpegColorMatrixName } from '../src/utils/media-policy.ts';

const [ffmpeg, fixture, widthValue, heightValue, destination] = process.argv.slice(2);
assert.ok(ffmpeg && fixture && destination, 'Supply executable, raw fixture, width, height and owned output directory');
const width = Number(widthValue);
const height = Number(heightValue);
assert.ok(
  Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width % 2 === 0 &&
    height % 2 === 0,
);
const input = readFileSync(fixture);
assert.equal(input.length, width * height * 6, 'One planar integer16 RGB frame required');
const layout = parseSourcePixelLayout('gbrp16le');
assert.ok(layout);
const request = {
  codec: VideoCodec.Hevc,
  accel: TranscodeHardwareAcceleration.Disabled,
  layout,
  policy: EditedMasterColorPolicy.Preserve,
  colorMatrix: ColorMatrix.Bt2020Nc,
  range: 'tv',
};
const plan = selectEncoderPixelFormat(request);
assert.equal(getFfmpegColorMatrixName(ColorMatrix.Bt2020Nc), 'bt2020nc', 'Metadata matrix spelling stays intact');
assert.equal(plan.pixelFormat, 'yuv420p10le');
const outputDirectory = path.resolve(destination);
mkdirSync(outputDirectory, { recursive: true });
const ffmpegBytes = readFileSync(ffmpeg);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
writeFileSync(
  path.resolve(outputDirectory, 'recipe.json'),
  JSON.stringify({ request, plan, inputSha256: hash(input), ffmpegSha256: hash(ffmpegBytes) }, undefined, 2) + '\n',
);
const runs = [];
for (const dither of ['ed', 'none']) {
  const output = path.resolve(outputDirectory, `${dither}.yuv420p10le`);
  const filters =
    dither === 'ed' ? plan.filters : plan.filters.map((filter) => filter.replace('sws_dither=ed', 'sws_dither=none'));
  const argv = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'verbose',
    '-threads',
    '1',
    '-filter_threads',
    '1',
    '-f',
    'rawvideo',
    '-pixel_format',
    'gbrp16le',
    '-video_size',
    `${width}x${height}`,
    '-framerate',
    '1',
    '-color_primaries',
    'bt2020',
    '-color_trc',
    'smpte2084',
    '-colorspace',
    'rgb',
    '-color_range',
    'pc',
    '-i',
    path.resolve(fixture),
    '-vf',
    filters.join(','),
    ...plan.args,
    '-frames:v',
    '1',
    '-c:v',
    'rawvideo',
    '-threads',
    '1',
    '-f',
    'rawvideo',
    output,
  ];
  const started = performance.now();
  const spawnOptions = {
    cwd: outputDirectory,
    detached: true,
    timeout: 30_000,
    maxBuffer: 262_144,
    killSignal: 'SIGKILL',
  };
  const result = spawnSync(ffmpeg, argv, spawnOptions);
  writeFileSync(path.resolve(outputDirectory, `${dither}.stdout`), result.stdout ?? '');
  writeFileSync(path.resolve(outputDirectory, `${dither}.stderr`), result.stderr ?? '');
  const run = {
    dither,
    pid: result.pid,
    processGroup: undefined,
    isGroupAliveAfterWait: undefined,
    argv: [ffmpeg, ...argv],
    exit: result.status,
    signal: result.signal,
    error: result.error?.message ?? undefined,
    wallSeconds: (performance.now() - started) / 1000,
  };
  runs.push(run);
  writeFileSync(path.resolve(outputDirectory, 'runs.json'), JSON.stringify(runs, undefined, 2) + '\n');
  // Preserve raw spawn failure evidence before the ownership checks can refuse.
  run.isGroupAliveAfterWait = checkDetachedChildGroup(result, spawnOptions, process.kill, process.pid);
  run.processGroup = result.pid;
  writeFileSync(path.resolve(outputDirectory, 'runs.json'), JSON.stringify(runs, undefined, 2) + '\n');
  assert.equal(run.isGroupAliveAfterWait, false, 'Subprocess group must be fully reaped');
  assert.equal(result.status, 0, result.stderr?.toString());
  assert.equal(readFileSync(output).length, width * height * 3, 'Complete native yuv420p10le frame required');
}
console.log('Actual generated BT2020 NCL recipe and diagnostic none control each emitted one complete 10-bit frame.');
