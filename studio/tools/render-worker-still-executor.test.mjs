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
