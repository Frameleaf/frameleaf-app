import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { preflight, run } from './frameleaf-studio-preflight.mjs';
import { probeSource } from '../studio/tools/encode-probe.mjs';

const plan = () => ({
  schemaVersion: 1,
  distribution: 'local-only',
  tools: {
    ffmpeg: { path: '/opt/tools/ffmpeg', version: 'ffmpeg version 7.1' },
    ffprobe: { path: '/opt/tools/ffprobe', version: 'ffprobe version 7.1' },
  },
  gpu: { accelerator: 'videotoolbox' },
  source: { path: '/owned/source.mov', transfer: 'smpte2084' },
});

const source = {
  streams: [{ codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le',
    color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc', time_base: '1/30000' }],
  frames: [0, 1001, 2002, 4004].map((pts) => ({ pts, pix_fmt: 'yuv420p10le',
    color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc' })),
};

const execute = (_binary, args) => {
  if (args[0] === '-version') return _binary.includes('ffprobe') ? 'ffprobe version 7.1\n' : 'ffmpeg version 7.1\n';
  if (args.includes('-hwaccels')) return 'Hardware acceleration methods:\nvideotoolbox\n';
  if (args.includes('-show_entries')) return JSON.stringify(source);
  if (args.includes('format=gbrpf32le')) return '';
  throw new Error('unexpected operation');
};

test('technical probe passes but Dolby go/no-go stays closed', () => {
  const result = preflight(plan(), execute);
  assert.equal(result.localChecksPassed, true);
  assert.equal(result.goNoGo, false);
  assert.match(result.blockers.join(' '), /automation rights unverified/);
  assert.deepEqual(result.checks.find((check) => check.timeline)?.timeline,
    { timeBase: '1/30000', pts: [0, 1001, 2002, 4004] });
});

test('missing, duplicate, backward and inexact timestamps fail closed', () => {
  for (const frames of [undefined, [], [{}], [{ pts: 0 }, { pts: 0 }], [{ pts: 2 }, { pts: 1 }],
    [{ pts: 0.5 }], [{ pts: '1001' }], [{ pts: Number.MAX_SAFE_INTEGER + 1 }]]) {
    const result = preflight(plan(), (binary, args) => args.includes('-show_entries')
      ? JSON.stringify({ ...source, frames: frames?.map((frame) => ({ ...source.frames[0], pts: undefined, ...frame })) })
      : execute(binary, args));
    assert.equal(result.localChecksPassed, false, JSON.stringify(frames));
    assert.equal(result.goNoGo, false);
  }
  for (const time_base of [undefined, '0/1', '1/0', '0.001', '1/9007199254740992']) {
    const result = preflight(plan(), (binary, args) => args.includes('-show_entries')
      ? JSON.stringify({ ...source, streams: [{ ...source.streams[0], time_base }] }) : execute(binary, args));
    assert.equal(result.localChecksPassed, false, String(time_base));
    assert.equal(result.goNoGo, false);
  }
});

test('real HEVC fractional and variable PTS survive two source probes exactly', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'frameleaf-source-pts-'));
  try {
    for (const [transfer, variable] of [['smpte2084', false], ['arib-std-b67', true]]) {
      const file = path.join(directory, `${transfer}.mp4`);
      run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=white:size=16x16:rate=30000/1001',
        '-frames:v', '6', '-vf',
        `${variable ? 'setpts=if(lt(N\\,3)\\,N\\,N+1),' : ''}setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`,
        '-fps_mode', 'passthrough', '-enc_time_base', '1001/30000', '-video_track_timescale', '30000',
        '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'pools=none:frame-threads=1:log-level=error',
        '-color_primaries', 'bt2020', '-color_trc', transfer, '-colorspace', 'bt2020nc', '-movflags', '+faststart', file]);
      const first = probeSource('ffprobe', 'ffmpeg', { path: file, transfer }, run);
      const second = probeSource('ffprobe', 'ffmpeg', { path: file, transfer }, run);
      assert.equal(first.ok, true);
      assert.deepEqual(first.timeline, {
        timeBase: '1/30000', pts: variable ? [0, 1001, 2002, 4004, 5005, 6006] : [0, 1001, 2002, 3003, 4004, 5005],
      });
      assert.deepEqual(second.timeline, first.timeline);
      if (!variable) {
        const { packets } = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_packets', '-show_entries', 'packet=pos,size', '-of', 'json', file]));
        const damaged = path.join(directory, 'truncated.mp4');
        const cut = Number(packets[3].pos) + Math.floor(Number(packets[3].size) / 2);
        writeFileSync(damaged, readFileSync(file).subarray(0, cut));
        const partial = JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_frames', '-show_entries', 'frame=pts', '-of', 'json', damaged]));
        assert.ok(partial.frames.length > 0 && partial.frames.length < first.timeline.pts.length);
        assert.throws(() => probeSource('ffprobe', 'ffmpeg', { path: damaged, transfer }, run), /reported error diagnostics/);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('zero-exit tools emitting error diagnostics fail closed for both source operations', () => {
  for (const operation of ['-show_entries', 'format=gbrpf32le']) {
    const result = preflight(plan(), (binary, args, options) => args.includes(operation)
      ? run(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(source))}); process.stderr.write('partial file');`], options)
      : execute(binary, args));
    assert.equal(result.localChecksPassed, false, operation);
    assert.equal(result.goNoGo, false);
  }
});

test('bundled or distributed portal tools are refused', () => {
  assert.throws(() => preflight({ ...plan(), distribution: 'bundled' }, execute), /local-only/);
  assert.throws(() => preflight({ ...plan(), tools: { ...plan().tools,
    ffmpeg: { path: `${process.cwd()}/studio/tools/ffmpeg`, version: 'ffmpeg version 7.1' } } }, execute), /cannot be distributed/);
});

test('unavailable decode and unsupported input profile fail closed', () => {
  const missingDecoder = preflight(plan(), (binary, args) => {
    if (args.includes('format=gbrpf32le')) throw new Error('decoder unavailable');
    return execute(binary, args);
  });
  assert.equal(missingDecoder.localChecksPassed, false);
  const wrongProfile = preflight(plan(), (binary, args) =>
    args.includes('-show_entries') ? JSON.stringify({ streams: [{ ...source.streams[0], profile: 'Main' }] }) : execute(binary, args));
  assert.equal(wrongProfile.localChecksPassed, false);
  assert.equal(wrongProfile.goNoGo, false);
});

test('Dolby stream or later-frame signalling cannot pass as plain HDR source evidence', () => {
  const reason = 'Dolby Vision source decode/reshape is unqualified; no base-layer-only policy is enabled';
  // Synthetic probe records exercise admission only; they are not Dolby media qualification.
  for (const record of [
    ...[5, 7, 8].map((dv_profile) => ({ ...source, streams: [{ ...source.streams[0],
      side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile,
        dv_bl_signal_compatibility_id: dv_profile === 5 ? 0 : 1 }] }] })),
    ...['Dolby Vision RPU Data', 'Dolby Vision Metadata'].map((side_data_type) => ({ ...source,
      frames: [...source.frames.slice(0, -1), { ...source.frames.at(-1), side_data_list: [{ side_data_type }] }] })),
  ]) {
    let converted = false;
    const result = preflight(plan(), (binary, args) => {
      if (args.includes('-show_entries')) {
        const entries = args[args.indexOf('-show_entries') + 1];
        assert.ok(entries.includes('stream_side_data=side_data_type'));
        assert.ok(entries.includes('frame_side_data=side_data_type'));
        return JSON.stringify(record);
      }
      if (args.includes('format=gbrpf32le')) converted = true;
      return execute(binary, args);
    });
    assert.equal(result.localChecksPassed, false);
    assert.equal(result.goNoGo, false);
    assert.equal(result.checks.find((check) => check.name === 'source profile and decode').detail, reason);
    assert.equal(converted, false, 'unqualified Dolby input must not enter generic float conversion');
  }
  const plainHdr = preflight(plan(), (binary, args) => args.includes('-show_entries')
    ? JSON.stringify({ ...source, streams: [{ ...source.streams[0],
      side_data_list: [{ side_data_type: 'Mastering display metadata' }] }] }) : execute(binary, args));
  assert.equal(plainHdr.localChecksPassed, true);
  assert.equal(plainHdr.goNoGo, false);
});

test('HDR stream headers cannot conceal changed or missing decoded-frame picture metadata', () => {
  // Probe records check admission only; real HDR picture qualification remains separate.
  for (const transfer of ['smpte2084', 'arib-std-b67']) {
    const hdrSource = { streams: [{ ...source.streams[0], color_transfer: transfer }],
      frames: source.frames.map((frame) => ({ ...frame, color_transfer: transfer })) };
    assert.equal(probeSource('ffprobe', 'ffmpeg', { path: '/source.mp4', transfer },
      (binary, args) => args.includes('-show_entries') ? JSON.stringify(hdrSource) : execute(binary, args)).ok, true);
    for (const [field, changed] of [
      ['pix_fmt', 'yuv420p'], ['color_transfer', transfer === 'smpte2084' ? 'arib-std-b67' : 'smpte2084'],
      ['color_primaries', 'bt709'], ['color_space', 'bt709'],
    ]) {
      for (const value of [changed, undefined]) {
        let converted = false;
        const result = probeSource('ffprobe', 'ffmpeg', { path: '/source.mp4', transfer }, (binary, args) => {
          if (args.includes('-show_entries')) {
            const entries = args[args.indexOf('-show_entries') + 1];
            assert.ok(entries.includes('frame=pts,pix_fmt,color_primaries,color_transfer,color_space'));
            return JSON.stringify({ ...hdrSource, frames: [...hdrSource.frames.slice(0, -1),
              { ...hdrSource.frames.at(-1), [field]: value }] });
          }
          if (args.includes('format=gbrpf32le')) converted = true;
          return execute(binary, args);
        });
        assert.equal(result.ok, false, `${transfer}: ${field}=${value}`);
        assert.match(result.detail, /source or decoded frame/);
        assert.equal(converted, false, 'inconsistent HDR frames must not enter float conversion');
      }
    }
  }
});

test('zero decoded frames fail closed even when source metadata is valid', () => {
  const result = preflight(plan(), (binary, args) => {
    if (args.includes('format=gbrpf32le')) {
      if (args[args.indexOf('-abort_on') + 1] === 'empty_output') throw new Error('zero output frames');
      return '';
    }
    return execute(binary, args);
  });
  assert.equal(result.localChecksPassed, false);
  assert.equal(result.goNoGo, false);
});

test('an HDR10 first stream cannot hide a second Dolby enhancement stream', () => {
  const streams = [source.streams[0], { ...source.streams[0],
    side_data_list: [{ side_data_type: 'DOVI configuration record', dv_profile: 7 }] }];
  let converted = false;
  const result = preflight(plan(), (binary, args) => {
    if (args.includes('-show_entries')) {
      // Model FFprobe stream selection so v:0 reproduces the original false admission.
      const selected = args[args.indexOf('-select_streams') + 1];
      assert.ok(selected === 'v' || selected === 'v:0');
      return JSON.stringify({ ...source, streams: selected === 'v' ? streams : [streams[0]] });
    }
    if (args.includes('format=gbrpf32le')) converted = true;
    return execute(binary, args);
  });
  assert.equal(result.localChecksPassed, false);
  assert.equal(result.goNoGo, false);
  assert.equal(result.checks.find((check) => check.name === 'source profile and decode').detail,
    'source must contain exactly one video stream; multiple video streams are unqualified');
  assert.equal(converted, false);
});

test('wrong tool version and missing accelerator fail closed', () => {
  const oldVersion = preflight({ ...plan(), tools: { ...plan().tools, ffmpeg: { path: '/opt/tools/ffmpeg', version: 'ffmpeg version 6' } } }, execute);
  assert.equal(oldVersion.localChecksPassed, false);
  const noGpu = preflight(plan(), (binary, args) => args.includes('-hwaccels') ? 'Hardware acceleration methods:\n' : execute(binary, args));
  assert.equal(noGpu.localChecksPassed, false);
});
