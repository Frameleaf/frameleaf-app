// FL-640: the caption look of a vertical or square export.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { SAFE_AREA, reframeGraph, reframeOf, shapedOutputSize } from './bundled-worker-reframe.mjs';
import {
  VERTICAL_WORD_CAPTION_LOOK,
  WORD_CAPTION_POSITION_RATIO,
  WORD_CAPTION_SIZE_RATIO,
  applyShapedCaptionLooks,
  isWordCaptionLook,
  shapedCaptionLook,
  wordCaptionPlacement,
} from './bundled-worker-word-captions.mjs';

const ASSET = '11111111-1111-4111-8111-111111111111';
const project = (items) => ({
  metadata: { width: 1920, height: 1080, fps: 30, frameRate: { num: 30, den: 1 } },
  timeline: { tracks: [{ id: 'c1', order: 0 }, { id: 'v1', order: 1 }], items },
});
const shot = (overrides = {}) => ({
  id: 'shot',
  trackId: 'v1',
  type: 'video',
  mediaId: ASSET,
  from: 0,
  durationInFrames: 121,
  sourceWidth: 3840,
  sourceHeight: 2160,
  ...overrides,
});
const segment = (overrides = {}) => ({
  id: 'captions',
  trackId: 'c1',
  type: 'subtitle',
  from: 0,
  durationInFrames: 121,
  label: 'Transcript',
  source: { type: 'transcript', mediaId: ASSET, clipId: 'shot' },
  cues: [{ id: 'c0', startSeconds: 0, endSeconds: 2, text: 'We made it' }],
  fontSize: 49,
  color: '#ffffff',
  transform: { x: 0, y: 346, width: 1574, height: 173, rotation: 0, opacity: 1 },
  ...overrides,
});
const clipCaptions = (overrides = {}) => ({
  type: 'transcript',
  mediaId: ASSET,
  enabled: true,
  updatedAt: 1,
  cues: [{ id: 'c0', startSeconds: 0, endSeconds: 2, text: 'We made it' }],
  ...overrides,
});
const plan = (shape) =>
  reframeOf({
    shape,
    resolution: '1080p',
    reframe: { version: 1, shape, output: shapedOutputSize(shape, '1080p'), shots: { shot: [{ t: 0, x: 0.5 }] } },
  });
const chosen = { style: 'word', highlightColor: '#58a6ff', size: 'small', position: 'bottom' };

describe('FL-640 vertical export caption default', () => {
  it('uses Highlight, Large, Middle when no look was chosen', () => {
    assert.deepEqual(shapedCaptionLook(undefined, 'vertical'), VERTICAL_WORD_CAPTION_LOOK);
    assert.equal(shapedCaptionLook(undefined, 'square'), null);
    assert.deepEqual(shapedCaptionLook(chosen, 'vertical'), chosen);
    assert.deepEqual(shapedCaptionLook({ ...chosen, size: 'huge' }, 'vertical'), VERTICAL_WORD_CAPTION_LOOK);
  });

  it('gives caption segments and clip captions the vertical look in the derived graph only', () => {
    const graph = project([shot({ transcriptCaptions: clipCaptions() }), segment()]);
    const before = structuredClone(graph);
    const { graph: derived, canvas } = reframeGraph(graph, plan('vertical'));
    assert.deepEqual(graph, before, 'the project graph is not changed');
    const [clip, captions] = derived.timeline.items;
    const large = Math.round(canvas.width * WORD_CAPTION_SIZE_RATIO.large);
    assert.deepEqual(captions.wordLook, VERTICAL_WORD_CAPTION_LOOK);
    assert.equal(captions.fontSize, large);
    assert.equal(captions.transform.y, 0);
    assert.ok(captions.transform.width <= canvas.width * (1 - SAFE_AREA.vertical.left - SAFE_AREA.vertical.right));
    assert.deepEqual(clip.transcriptCaptions.wordLook, VERTICAL_WORD_CAPTION_LOOK);
    assert.equal(clip.transcriptCaptions.style.fontSize, large);
    assert.equal(clip.transcriptCaptions.style.transform.y, 0);
    assert.ok(clip.transcriptCaptions.style.transform.width <= canvas.width);
  });

  it('keeps a chosen look and works its size and position out again for the vertical frame', () => {
    const graph = project([shot({ transcriptCaptions: clipCaptions({ wordLook: chosen }) }), segment({ wordLook: chosen })]);
    const { graph: derived, canvas } = reframeGraph(graph, plan('vertical'));
    const [clip, captions] = derived.timeline.items;
    assert.deepEqual(captions.wordLook, chosen);
    assert.equal(captions.fontSize, Math.round(canvas.width * WORD_CAPTION_SIZE_RATIO.small));
    assert.ok(captions.transform.y > 0, 'still near the bottom');
    const safeBottom = canvas.height / 2 - canvas.height * SAFE_AREA.vertical.bottom;
    assert.ok(captions.transform.y + captions.transform.height / 2 <= safeBottom + 1e-6, 'clear of phone buttons');
    assert.deepEqual(clip.transcriptCaptions.wordLook, chosen);
    assert.ok(
      clip.transcriptCaptions.style.transform.y + clip.transcriptCaptions.style.transform.height / 2 <= safeBottom + 1e-6,
    );
  });

  it('treats zero-size boxes as unset and keeps an offset clip caption inside the safe area', () => {
    const frame = { width: 608, height: 1080 };
    const safe = SAFE_AREA.vertical;
    const safeWidth = Math.round(frame.width * (1 - safe.left - safe.right));
    const items = [
      shot({ id: 'a', transcriptCaptions: clipCaptions({ style: { transform: { x: 3, y: 0, width: 0, height: 0 } } }) }),
      shot({ id: 'b', transcriptCaptions: clipCaptions({ style: { transform: { x: 400, y: 0, width: 500, height: 120 } } }) }),
      shot({ id: 'c', transcriptCaptions: clipCaptions({ style: { transform: { x: -400, y: 0, width: 200, height: 120 } } }) }),
    ];
    assert.equal(applyShapedCaptionLooks(items, frame, 'vertical', safe), 3);
    const [a, b, c] = items.map((item) => item.transcriptCaptions.style.transform);
    assert.equal(a.width, safeWidth);
    assert.equal(a.height, Math.round(frame.height * 0.16));
    for (const box of [a, b, c]) {
      assert.ok(box.x - box.width / 2 >= -frame.width / 2 + frame.width * safe.left - 1e-6, 'clear of the left edge');
      assert.ok(box.x + box.width / 2 <= frame.width / 2 - frame.width * safe.right + 1e-6, 'clear of the right edge');
    }
    assert.equal(b.width, 500);
    assert.ok(b.x < 400, 'an offset that fitted the wide frame is pulled in');
    assert.equal(c.width, 200);
    assert.ok(c.x < 0, 'a box that fits keeps its side');
  });

  it('leaves captions without a chosen look alone in a square export, and skips hidden clip captions', () => {
    const graph = project([shot({ transcriptCaptions: clipCaptions({ enabled: false }) }), segment()]);
    const { graph: derived } = reframeGraph(graph, plan('square'));
    const [clip, captions] = derived.timeline.items;
    assert.equal(captions.wordLook, undefined);
    assert.equal(captions.fontSize, 49);
    assert.equal(clip.transcriptCaptions.wordLook, undefined);
    const items = [shot({ transcriptCaptions: clipCaptions({ enabled: false }) })];
    assert.equal(applyShapedCaptionLooks(items, { width: 608, height: 1080 }, 'vertical', SAFE_AREA.vertical), 0);
  });

  it('matches the engine numbers (patch 0168)', async () => {
    const patch = await readFile(new URL('../patches/0168-word-by-word-captions.patch', import.meta.url), 'utf8');
    for (const [size, ratio] of Object.entries(WORD_CAPTION_SIZE_RATIO)) assert.match(patch, new RegExp(`\\+  ${size}: ${ratio},`));
    for (const [position, ratio] of Object.entries(WORD_CAPTION_POSITION_RATIO)) {
      assert.match(patch, new RegExp(`\\+  ${position}: ${ratio},`));
    }
    for (const [key, value] of Object.entries(VERTICAL_WORD_CAPTION_LOOK)) {
      if (key === 'highlightColor') assert.match(patch, /\+  highlightColor: WORD_CAPTION_HIGHLIGHTS\[0\]!,/);
      else assert.match(patch, new RegExp(`\\+  ${key}: '${value}',`));
    }
    assert.match(patch, new RegExp(`\\+  '${VERTICAL_WORD_CAPTION_LOOK.highlightColor}',`));
    assert.ok(isWordCaptionLook(VERTICAL_WORD_CAPTION_LOOK));
    assert.deepEqual(wordCaptionPlacement({ size: 'large', position: 'middle' }, 1080, 1920), { fontSize: 76, y: 0 });
  });
});
