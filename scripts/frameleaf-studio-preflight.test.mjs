import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preflight } from './frameleaf-studio-preflight.mjs';

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
    color_primaries: 'bt2020', color_transfer: 'smpte2084', color_space: 'bt2020nc' }],
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

test('wrong tool version and missing accelerator fail closed', () => {
  const oldVersion = preflight({ ...plan(), tools: { ...plan().tools, ffmpeg: { path: '/opt/tools/ffmpeg', version: 'ffmpeg version 6' } } }, execute);
  assert.equal(oldVersion.localChecksPassed, false);
  const noGpu = preflight(plan(), (binary, args) => args.includes('-hwaccels') ? 'Hardware acceleration methods:\n' : execute(binary, args));
  assert.equal(noGpu.localChecksPassed, false);
});
