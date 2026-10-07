import assert from 'node:assert/strict';
import test from 'node:test';
import { stillRecipe, renderStillImage } from './render-worker-still-executor.mjs';
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
});
test('quality presets reach the encoder, preserve the legacy default and refuse invalid presets', () => {
  assert.equal(stillRecipe(claim()).settings.quality, 'high');
  assert.equal(stillRecipe(claim()).settings.videoBitrate, 10_000_000);
  for (const [quality, bitrate] of Object.entries({
    low: 2_500_000,
    medium: 5_000_000,
    high: 10_000_000,
    ultra: 20_000_000,
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
  for (const range of [
    { inPoint: -1, outPoint: 12 },
    { inPoint: 4.5, outPoint: 12 },
    { inPoint: 12, outPoint: 12 },
    { inPoint: 4, outPoint: 25 },
    { inPoint: 4, outPoint: 12, extra: true },
    null,
  ]) {
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

test('still image recipes preserve explicit document intent and one frame without accepting video settings', () => {
  for (const format of ['sdr-jpeg', 'hdr-jpeg', 'hdr-heic']) {
    const input = claim();
    input.settings = { format, color: 'preserve', resolution: 'original', audio: 'preserve' };
    input.snapshot.studio.graph.metadata.colorManagement = { workingRange: 'hdr' };
    input.snapshot.contract.image = {
      version: 1,
      format,
      width: 1280,
      height: 720,
      frame: 0,
      dynamicRange: format === 'sdr-jpeg' ? 'sdr' : 'hdr',
      outputIntent: 'hdr',
      referenceWhite: 203,
      renderer: 'frameleaf-studio-image-v1',
    };
    const previous = process.env.FRAMELEAF_HDR_IMAGES;
    process.env.FRAMELEAF_HDR_IMAGES = 'experimental';
    try {
      const recipe = stillRecipe(input);
      assert.equal(recipe.frames, 1);
      assert.equal(recipe.photo.format, format);
      assert.equal(recipe.photo.outputIntent, 'hdr');
      assert.equal(recipe.settings.resolution.width, 1280);
      input.settings.resolution = '720p';
      assert.throws(() => stillRecipe(input), /UNSUPPORTED_STILL_EXPORT_SETTINGS/);
    } finally {
      if (previous === undefined) delete process.env.FRAMELEAF_HDR_IMAGES;
      else process.env.FRAMELEAF_HDR_IMAGES = previous;
    }
  }
});
