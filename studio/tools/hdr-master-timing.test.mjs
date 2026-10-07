// FL-107 diagnostic acceptance packet; not production-worker/deployment qualification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encodeHdrMaster } from './hdr-master.mjs';
import { sourceTimeline } from './preflight-validators.mjs';

const run = (tool, args) => {
  const result = spawnSync(tool, args, { maxBuffer: 16 << 20 });
  assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
  return result.stdout;
};
const probe = (file, entries, stream, extra = []) => JSON.parse(run('ffprobe', [
  '-v', 'error', '-select_streams', stream, ...extra, '-show_entries', entries, '-of', 'json', file,
]));
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const makeFrames = (count) => Array.from({ length: count }, (_, n) => ({
  width: 64, height: 32,
  rgba: Float32Array.from({ length: 64 * 32 * 4 }, (_, i) => i % 4 === 3 ? 1 : 0.2 + (n % 5) * 0.05),
}));
const expectedPts = [0, 40, 120, 160, 280];
const report = { schemaVersion: 1, qualification: 'diagnostic helper only; production worker/checkpoint and admitted deployments unqualified', cases: [] };
const hasEncoder = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });

test('VFR output PTS, channel order and atomic interrupted restart', {
  skip: hasEncoder.status !== 0 || !/libx265/.test(hasEncoder.stdout) ? 'FFmpeg with libx265 unavailable' : false,
}, async () => {
  const dir = mkdtempSync(process.env.HDR_TIMING_REPORT
    ? `${path.resolve(process.env.HDR_TIMING_REPORT)}.artifacts-` : path.join(tmpdir(), 'fl-hdr-timing-'));
  try {
    report.tools = Object.fromEntries(['ffmpeg', 'ffprobe'].map((tool) => [tool, run(tool, ['-version']).toString().split('\n')[0]]));
    const source = path.join(dir, 'vfr.mkv');
    const fixtureArgs = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x32:rate=25', '-frames:v', '5',
      '-vf', "settb=1/1000,setpts=if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,40\\,if(eq(N\\,2)\\,120\\,if(eq(N\\,3)\\,160\\,280))))",
      '-fps_mode', 'passthrough', '-enc_time_base', '1/1000', '-c:v', 'ffv1', source];
    run('ffmpeg', fixtureArgs);
    const sourceProbe = probe(source, 'stream=time_base:frame=pts', 'v:0', ['-show_frames']);
    const timeline = sourceTimeline(sourceProbe.streams[0].time_base, sourceProbe.frames);
    // Independent fixture oracle: do not derive the expected output from output metadata.
    assert.deepEqual(timeline, { timeBase: '1/1000', pts: expectedPts });
    const frames = makeFrames(5);
    for (const transfer of ['pq', 'hlg']) {
      for (const layout of ['5.1', '7.1(wide)']) {
        const audio = path.join(dir, `${layout}.m4a`);
        const channels = layout === '5.1' ? 6 : 8;
        const levels = Array.from({ length: channels }, (_, n) => (n + 1) / 16).join('|');
        const audioArgs = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${levels}:s=48000:d=0.32:c=${layout}`, '-c:a', 'alac', audio];
        run('ffmpeg', audioArgs);
        const output = path.join(dir, `${transfer}-${layout}.mp4`);
        const options = { frames, fps: 25, transfer, timeline, audio: { path: audio }, mastering: { maxNits: 1000, minNits: 0.005 }, output, lossless: true };
        let outputProbe;
        let outputAudio;
        let inputPcm;
        options.validate = ({ probe: master, decoded, output }) => {
          outputProbe = probe(output, 'stream=time_base:frame=pts', 'v:0', ['-show_frames']);
          assert.equal(outputProbe.streams[0].time_base, '1/1000');
          assert.deepEqual(outputProbe.frames.map((f) => f.pts), expectedPts);
          assert.equal(master.transfer, transfer === 'pq' ? 'smpte2084' : 'arib-std-b67');
          assert.equal(decoded.length, frames.length);
          decoded.forEach((pixels, n) => assert.ok(Math.abs(pixels[0] - frames[n].rgba[0]) <= 2 / 1023, `frame identity at PTS ${expectedPts[n]}`));
          const audioEntries = 'stream=codec_name,channels,channel_layout,sample_rate:packet=data_hash';
          const inputAudio = probe(audio, audioEntries, 'a:0', ['-show_packets', '-show_data_hash', 'sha256']);
          outputAudio = probe(output, audioEntries, 'a:0', ['-show_packets', '-show_data_hash', 'sha256']);
          assert.equal(inputAudio.streams[0].channel_layout, layout);
          assert.equal(inputAudio.streams[0].channels, channels);
          assert.deepEqual(outputAudio, inputAudio, 'layout and compressed audio packets preserved');
          inputPcm = decodeAudio(audio);
          assert.deepEqual(decodeAudio(output), inputPcm, 'independent PCM decode preserves channel order');
          const samples = new Int32Array(inputPcm.buffer, inputPcm.byteOffset, channels);
          Array.from(samples).forEach((sample, n) => assert.equal(sample, (n + 1) * 2 ** 27, `ordered channel ${n}`));
        };
        const decodeAudio = (file) => run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'pcm_s32le', '-f', 's32le', '-']);
        const encoded = await encodeHdrMaster(options);
        const expectedOutputProbe = outputProbe;
        const completeDigest = digest(output);
        // A real ffmpeg attempt is killed after opening its unpublished output.
        const controller = new AbortController();
        const watcher = watch(dir, (_event, name) => {
          if (name?.endsWith('.partial.mp4')) controller.abort(new Error('interrupted diagnostic export'));
        });
        try {
          await assert.rejects(encodeHdrMaster({ ...options, frames: makeFrames(200), timeline: undefined, signal: controller.signal }), /interrupted diagnostic export/);
        } finally { watcher.close(); }
        assert.equal(digest(output), completeDigest, 'interruption leaves the prior complete master intact');
        assert.ok(!readdirSync(dir).some((name) => name.endsWith('.partial.mp4')), 'no torn attempt is exposed');
        await encodeHdrMaster(options);
        assert.deepEqual(probe(output, 'stream=time_base:frame=pts', 'v:0', ['-show_frames']), expectedOutputProbe, 'restart preserves exact PTS');
        assert.deepEqual(decodeAudio(output), inputPcm, 'restart preserves ordered audio');
        const retainedPath = (file) => process.env.HDR_TIMING_REPORT
          ? path.relative(path.dirname(path.resolve(process.env.HDR_TIMING_REPORT)), file) : null;
        report.cases.push({ transfer, layout, axes: ['pts', 'audio', 'temporal-recovery'], sourceSha256: digest(source), audioSha256: digest(audio), outputSha256: digest(output),
          sourcePath: retainedPath(source), audioPath: retainedPath(audio), outputPath: retainedPath(output),
          timeline, outputTimeline: outputProbe, audio: outputAudio, frameIdentity: true, interruptedPriorOutputUnchanged: true, restartVerified: true,
          fixtureArgs: fixtureArgs.slice(0, -1), audioArgs: audioArgs.slice(0, -1), encoderArgs: encoded.args.map((arg) => arg === audio ? '<audio>' : arg.endsWith('.partial.mp4') ? '<unpublished-output>' : arg) });
      }
    }
    await assert.rejects(encodeHdrMaster({ frames, fps: 25, transfer: 'hlg', output: path.join(dir, 'bad.mp4'), timeline: { timeBase: '1/1000', pts: [0, 40] } }), /One output PTS/);
    assert.ok(!existsSync(path.join(dir, 'bad.mp4')));
    if (process.env.HDR_TIMING_REPORT) writeFileSync(process.env.HDR_TIMING_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  } finally { if (!process.env.HDR_TIMING_REPORT) rmSync(dir, { recursive: true, force: true }); }
});
