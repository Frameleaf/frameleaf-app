import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stillRecipe, renderStillImage, probeStillOutput } from './render-worker-still-executor.mjs';
const claim = () => ({
  settings: { format: 'mp4-h264', color: 'preserve', resolution: '720p', audio: 'preserve' },
  snapshot: {
    studio: {
      graph: {
        id: 'p',
        duration: 1,
        metadata: { width: 1280, height: 720, fps: 24 },
        timeline: {
          tracks: [{ id: 'v1', kind: 'video' }],
          items: [
            {
              id: 'clip',
              type: 'image',
              mediaId: 'asset',
              trackId: 'v1',
              from: 0,
              durationInFrames: 24,
            },
          ],
          transitions: [],
          keyframes: [],
        },
      },
    },
    contract: { video: { minBitDepth: 8, transfer: null }, audio: null },
    timing: { cadence: '24/1', timeBase: '1/24', sources: [] },
  },
  limits: { maxWallClockMs: '30000', maxOutputBytes: '1048576' },
});
test('fresh one-still recipe applies stricter server ceilings and fixed measured encoder settings', () => {
  const recipe = stillRecipe(claim());
  assert.equal(recipe.frames, 24);
  assert.equal(recipe.maxMs, 30000);
  assert.equal(recipe.maxBytes, 1048576);
  assert.equal(recipe.settings.codec, 'avc');
  assert.equal(createHash('sha256').update(JSON.stringify({ recipe: 'single-still-sdr-v1', settings: recipe.settings })).digest('hex'),
    '95146e1c29cb2febb4fb2673c591e92d4d9c9e899b5e2835ce1e0953d5d145a9');
});
test('quality presets reach the encoder, preserve the legacy default and refuse invalid presets', () => {
  assert.equal(stillRecipe(claim()).settings.quality, 'high');
  assert.equal(stillRecipe(claim()).settings.videoBitrate, 10_000_000);
  for (const [quality, bitrate] of Object.entries({
    low: 2_500_000, medium: 5_000_000, high: 10_000_000, ultra: 20_000_000,
  })) {
    const input = claim();
    input.settings.quality = quality;
    const { settings } = stillRecipe(input);
    assert.equal(settings.quality, quality);
    assert.equal(settings.videoBitrate, bitrate);
  }
  for (const quality of ['lossless', null, 10, {}, 'constructor']) {
    const input = claim();
    input.settings.quality = quality;
    assert.throws(() => stillRecipe(input), /UNSUPPORTED_EXPORT_QUALITY/);
  }
});
test('MOV selection reaches the native AVC/QuickTime recipe without widening graph support', () => {
  const input = claim();
  input.settings.format = 'mov-h264';
  input.settings.subtitleMode = 'off';
  const recipe = stillRecipe(input);
  assert.equal(recipe.settings.container, 'mov');
  assert.equal(recipe.settings.codec, 'avc');
  assert.equal(recipe.settings.subtitleMode, 'off');
  assert.equal(stillRecipe(claim()).settings.container, 'mp4');
  input.snapshot.studio.graph.timeline.items[0].type = 'video';
  assert.throws(() => stillRecipe(input), /UNSUPPORTED_STILL/);
});
test('actual H264 files prove the selected container, not the shared ffprobe name or file suffix', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'still-containers-'));
  try {
    // Software-encoded specimens check the output verifier, not production GPU qualification.
    for (const container of ['mp4', 'mov']) {
      const file = path.join(folder, `${container}.artifact`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=24',
        '-frames:v', '8', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
        '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
        '-video_track_timescale', '24', '-f', container, file], { timeout: 10_000, stdio: 'pipe' });
      assert.equal(probeStillOutput(file, 8, 'ffprobe', container).streams[0].codec_name, 'h264');
      assert.throws(() => probeStillOutput(file, 8, 'ffprobe', container === 'mov' ? 'mp4' : 'mov'),
        /CONTAINER_MISMATCH/);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('native subtitle modes preserve legacy settings, reject unsupported modes and keep caption graphs refused', () => {
  assert.equal(Object.hasOwn(stillRecipe(claim()).settings, 'subtitleMode'), false);
  for (const subtitleMode of ['burn', 'off']) {
    const input = claim();
    input.settings.subtitleMode = subtitleMode;
    assert.equal(stillRecipe(input).settings.subtitleMode, subtitleMode);
    input.snapshot.studio.graph.timeline.items.push({ type: 'subtitle', text: 'Caption' });
    assert.throws(() => stillRecipe(input), /SINGLE_STILL_REQUIRED/);
  }
  for (const subtitleMode of ['sidecar', 'embedded', null, 10, {}]) {
    const input = claim();
    input.settings.subtitleMode = subtitleMode;
    assert.throws(() => stillRecipe(input), /UNSUPPORTED_SUBTITLE_MODE/);
  }
});
test('ranges retain source-frame bounds, render only the selected frames and require the bound contract', () => {
  const input = claim();
  input.settings.range = { inPoint: 4, outPoint: 12 };
  input.snapshot.contract.range = { ...input.settings.range, cadence: '24/1' };
  const before = structuredClone(input);
  const recipe = stillRecipe(input);
  assert.equal(recipe.frames, 8);
  assert.deepEqual(recipe.range, { inPoint: 4, outPoint: 12 });
  assert.deepEqual(input, before);
  for (const range of [{ inPoint: -1, outPoint: 12 }, { inPoint: 4.5, outPoint: 12 },
    { inPoint: 12, outPoint: 12 }, { inPoint: 4, outPoint: 25 }, { inPoint: 4, outPoint: 12, extra: true }, null]) {
    const invalid = structuredClone(before);
    invalid.settings.range = range;
    assert.throws(() => stillRecipe(invalid));
  }
  delete input.snapshot.contract.range;
  assert.throws(() => stillRecipe(input), /RANGE_CONTRACT_CHANGED/);
});
for (const [name, change] of [
  [
    'HDR graph',
    (c) => {
      c.snapshot.contract.video.transfer = 'smpte2084';
    },
  ],
  [
    'audio',
    (c) => {
      c.snapshot.contract.audio = { channels: 6 };
    },
  ],
  [
    'video source',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].type = 'video';
    },
  ],
  [
    'untranslated effect',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].effects = [{ type: 'blur' }];
    },
  ],
  [
    'animation',
    (c) => {
      c.snapshot.studio.graph.timeline.keyframes = [{}];
    },
  ],
  [
    'nested graph',
    (c) => {
      c.snapshot.studio.graph.timeline.compositions = [{}];
    },
  ],
  [
    'export format',
    (c) => {
      c.settings.format = 'mp4-hevc-main10';
    },
  ],
  [
    'ceiling duration',
    (c) => {
      c.snapshot.studio.graph.timeline.items[0].durationInFrames = 241;
    },
  ],
  [
    'malformed ceiling',
    (c) => {
      c.limits.maxWallClockMs = '-1';
    },
  ],
  [
    'completed checkpoint recovery',
    (c) => {
      c.checkpoints = [{ state: 'completed' }];
    },
  ],
])
  test(`${name} refuses before browser or output`, () => {
    const changed = claim();
    change(changed);
    assert.throws(() => stillRecipe(changed));
  });
test('expired lease refuses before loading engine/build or creating private output', async () => {
  await assert.rejects(
    renderStillImage({ claim: claim(), isLeaseActive: () => false }, () => assert.fail()),
    /LEASE_LOST/,
  );
});
