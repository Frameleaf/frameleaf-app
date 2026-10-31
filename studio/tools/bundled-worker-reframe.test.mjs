// FL-563: the graph a vertical or square export renders, derived from the project's own graph.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  REFRAME_PROFILE,
  ReframeRefusal,
  SAFE_AREA,
  cropRegion,
  pathAt,
  reframeGraph,
  reframeOf,
  shapedOutputSize,
} from './bundled-worker-reframe.mjs';

const ASSET = '11111111-1111-4111-8111-111111111111';

const project = (items, extra = {}) => ({
  metadata: { width: 1920, height: 1080, fps: 30, frameRate: { num: 30, den: 1 } },
  timeline: {
    tracks: [
      { id: 'v2', order: 0 },
      { id: 'v1', order: 1 },
      { id: 'a1', order: 2 },
    ],
    items,
    ...extra,
  },
});

const shot = (id, overrides = {}) => ({
  id,
  trackId: 'v1',
  type: 'video',
  mediaId: ASSET,
  from: 0,
  durationInFrames: 121,
  sourceWidth: 3840,
  sourceHeight: 2160,
  ...overrides,
});

const plan = (shots, shape = 'vertical', resolution = '1080p') =>
  reframeOf({ shape, resolution, reframe: { version: 1, shape, output: shapedOutputSize(shape, resolution), shots } });

describe('reframe sizes', () => {
  it('writes the shaped file size for each resolution', () => {
    assert.deepEqual(shapedOutputSize('vertical', '1080p'), { width: 1080, height: 1920 });
    assert.deepEqual(shapedOutputSize('vertical', '2160p'), { width: 2160, height: 3840 });
    assert.deepEqual(shapedOutputSize('vertical', '720p'), { width: 720, height: 1280 });
    assert.deepEqual(shapedOutputSize('square', '1440p'), { width: 1440, height: 1440 });
    assert.equal(shapedOutputSize('vertical', 'original'), null);
    assert.equal(shapedOutputSize('round', '1080p'), null);
  });

  it('crops the full height of a wide frame and the full width of a tall one', () => {
    assert.deepEqual(cropRegion({ width: 1920, height: 1080 }, 'vertical'), {
      width: 607.5,
      height: 1080,
      horizontal: true,
    });
    assert.deepEqual(cropRegion({ width: 1920, height: 1080 }, 'square'), { width: 1080, height: 1080, horizontal: true });
    assert.deepEqual(cropRegion({ width: 1080, height: 1920 }, 'square'), {
      width: 1080,
      height: 1080,
      horizontal: false,
    });
  });

  it('interpolates a path linearly and holds its ends', () => {
    const path = [
      { t: 0.2, x: 0.3 },
      { t: 0.8, x: 0.6 },
    ];
    assert.equal(pathAt(path, 0), 0.3);
    assert.ok(Math.abs(pathAt(path, 0.5) - 0.45) < 1e-12);
    assert.equal(pathAt(path, 1), 0.6);
    assert.equal(pathAt([{ t: 0.5, x: 0.7 }], 0.1), 0.7);
  });

  it('advertises a stable profile token for admission', () => {
    assert.equal(REFRAME_PROFILE, 'reframe-v1');
  });
});

describe('sealed framing', () => {
  it('is absent for the original shape', () => {
    assert.equal(reframeOf({ resolution: '1080p' }), null);
    assert.equal(reframeOf({ shape: 'original', resolution: '1080p' }), null);
  });

  const refusals = [
    ['a framing without a shape', { resolution: '1080p', reframe: {} }],
    ['an unknown shape', { shape: 'round', resolution: '1080p' }],
    ['a shape without a framing', { shape: 'vertical', resolution: '1080p' }],
    [
      'a framing sealed for another resolution',
      {
        shape: 'vertical',
        resolution: '1080p',
        reframe: { version: 1, shape: 'vertical', output: { width: 720, height: 1280 }, shots: {} },
      },
    ],
    [
      'a framing for another shape',
      {
        shape: 'vertical',
        resolution: '1080p',
        reframe: { version: 1, shape: 'square', output: { width: 1080, height: 1920 }, shots: {} },
      },
    ],
    [
      'a path out of order',
      {
        shape: 'vertical',
        resolution: '1080p',
        reframe: {
          version: 1,
          shape: 'vertical',
          output: { width: 1080, height: 1920 },
          shots: {
            v: [
              { t: 0.5, x: 0.5 },
              { t: 0.2, x: 0.4 },
            ],
          },
        },
      },
    ],
    [
      'a centre outside the frame',
      {
        shape: 'vertical',
        resolution: '1080p',
        reframe: { version: 1, shape: 'vertical', output: { width: 1080, height: 1920 }, shots: { v: [{ t: 0, x: 1.4 }] } },
      },
    ],
    ['the original resolution', { shape: 'square', resolution: 'original' }],
  ];
  for (const [name, settings] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => reframeOf(settings), (error) => error instanceof ReframeRefusal && error.code === 'reframe_invalid');
    });
  }
});

describe('derived graph', () => {
  it('makes the canvas the crop and centres each shot on its framing, leaving the project alone', () => {
    const graph = project([shot('v'), { id: 'a', trackId: 'a1', type: 'audio', mediaId: ASSET, from: 0, durationInFrames: 121 }]);
    const before = structuredClone(graph);
    const { graph: derived, canvas } = reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.7 }] }));
    assert.deepEqual(graph, before);
    assert.deepEqual(canvas, { width: 608, height: 1080 });
    assert.deepEqual(derived.metadata, { ...graph.metadata, width: 608, height: 1080 });
    const [video, audio] = derived.timeline.items;
    // The 4K source contained in 1920 × 1080 keeps that box; its centre 70 % across lands mid-frame.
    assert.equal(video.transform.width, 1920);
    assert.equal(video.transform.height, 1080);
    assert.ok(Math.abs(video.transform.x - (960 - 0.7 * 1920)) < 1e-9);
    assert.equal(audio.transform, undefined);
    assert.equal(derived.timeline.keyframes, undefined);
  });

  it('follows a moving subject with eased x keyframes across the shot', () => {
    const graph = project([shot('v')]);
    const { graph: derived } = reframeGraph(
      graph,
      plan({
        v: [
          { t: 0, x: 0.4 },
          { t: 0.5, x: 0.5 },
          { t: 1, x: 0.6 },
        ],
      }),
    );
    const [entry] = derived.timeline.keyframes;
    assert.equal(entry.itemId, 'v');
    assert.equal(entry.animationVersion, 2);
    const [group] = entry.properties;
    assert.equal(group.property, 'x');
    assert.deepEqual(
      group.keyframes.map((keyframe) => [keyframe.frame, Math.round(keyframe.value), keyframe.easing]),
      [
        [0, 192, 'ease-in-out'],
        [60, 0, 'ease-in-out'],
        [120, -192, 'ease-in-out'],
      ],
    );
    assert.equal(derived.timeline.items[0].transform.x, group.keyframes[0].value);
    // ids are deterministic, so the same claim renders the same graph
    assert.deepEqual(reframeGraph(graph, plan({ v: [{ t: 0, x: 0.4 }, { t: 0.5, x: 0.5 }, { t: 1, x: 0.6 }] })).graph, derived);
  });

  it('moves a clip that is already animated sideways by its average framing', () => {
    const keyframes = [
      {
        itemId: 'v',
        animationVersion: 2,
        properties: [{ property: 'x', keyframes: [{ id: 'k1', frame: 0, value: 100, easing: 'linear' }] }],
        vectorProperties: [
          { property: 'position', keyframes: [{ id: 'k2', frame: 10, value: { x: -50, y: 20 }, easing: 'linear' }] },
        ],
      },
    ];
    const graph = project([shot('v', { transform: { x: 100 } })], { keyframes });
    const { graph: derived } = reframeGraph(
      graph,
      plan({
        v: [
          { t: 0, x: 0.4 },
          { t: 1, x: 0.6 },
        ],
      }),
    );
    // mean 0.5: no move at all
    assert.equal(derived.timeline.keyframes[0].properties[0].keyframes[0].value, 100);
    assert.deepEqual(derived.timeline.keyframes[0].vectorProperties[0].keyframes[0].value, { x: -50, y: 20 });
    const { graph: moved } = reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.25 }] }));
    assert.equal(moved.timeline.items[0].transform.x, 100 + 480);
    assert.equal(moved.timeline.keyframes[0].properties[0].keyframes[0].value, 580);
    assert.deepEqual(moved.timeline.keyframes[0].vectorProperties[0].keyframes[0].value, { x: 430, y: 20 });
  });

  it('moves titles and captions into the safe area and wraps them to its width', () => {
    const graph = project([
      shot('v'),
      // a caption across most of the 16:9 frame, near the bottom
      { id: 'c', trackId: 'v2', type: 'text', textRole: 'caption', text: 'Hello', from: 0, durationInFrames: 30, transform: { x: 0, y: 420, width: 1500, height: 120 } },
      // a title with no box takes the whole frame
      { id: 't', trackId: 'v2', type: 'text', text: 'Summer', from: 30, durationInFrames: 30 },
      // a title off to the right
      { id: 'r', trackId: 'v2', type: 'text', text: 'Right', from: 60, durationInFrames: 30, transform: { x: 700, y: -400, width: 300, height: 80 } },
    ]);
    const { graph: derived, canvas } = reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.5 }] }));
    const safe = SAFE_AREA.vertical;
    const safeWidth = canvas.width * (1 - safe.left - safe.right);
    const within = (item) => {
      const { x, y, width, height } = item.transform;
      assert.ok(width <= safeWidth + 1e-9, `${item.id} is narrower than the safe width`);
      assert.ok(x - width / 2 >= -canvas.width / 2 + canvas.width * safe.left - 1e-9, `${item.id} clears the left`);
      assert.ok(x + width / 2 <= canvas.width / 2 - canvas.width * safe.right + 1e-9, `${item.id} clears the right`);
      if (height < canvas.height * (1 - safe.top - safe.bottom)) {
        assert.ok(y - height / 2 >= -canvas.height / 2 + canvas.height * safe.top - 1e-9, `${item.id} clears the top`);
        assert.ok(y + height / 2 <= canvas.height / 2 - canvas.height * safe.bottom + 1e-9, `${item.id} clears the bottom`);
      }
    };
    const [, caption, title, right] = derived.timeline.items;
    within(caption);
    within(title);
    within(right);
    assert.equal(caption.transform.width, safeWidth);
    assert.ok(caption.transform.y < 420, 'the caption rises above the bottom band');
    assert.equal(title.transform.height, 1080);
    assert.equal(right.transform.width, 300 > safeWidth ? safeWidth : 300);
  });

  it('places a drawn shape by the shot under it', () => {
    const graph = project([
      shot('v'),
      { id: 's', trackId: 'v2', type: 'shape', shapeType: 'rectangle', fillColor: '#fff', from: 10, durationInFrames: 20, transform: { x: 0, y: 0, width: 100, height: 100 } },
    ]);
    const { graph: derived } = reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.25 }] }));
    assert.equal(derived.timeline.items[1].transform.x, 480);
  });

  it('keeps horizontal positions when a tall frame is cropped to a square', () => {
    const graph = {
      ...project([shot('v', { sourceWidth: 1080, sourceHeight: 1920 })]),
      metadata: { width: 1080, height: 1920, fps: 30, frameRate: { num: 30, den: 1 } },
    };
    const { graph: derived, canvas } = reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.5 }] }, 'square'));
    assert.deepEqual(canvas, { width: 1080, height: 1080 });
    assert.equal(derived.timeline.items[0].transform.x, undefined);
    assert.equal(derived.timeline.items[0].transform.width, 1080);
  });

  const unsupported = [
    ['a shot the framing does not name', project([shot('v'), shot('w', { from: 121 })]), 'reframe_invalid'],
    ['a clip that follows another', project([shot('v', { transformParent: { parentItemId: 'p' } })]), 'reframe_unsupported'],
    [
      'a position driven by an expression',
      project([shot('v')], {
        keyframes: [
          { itemId: 'v', animationVersion: 2, properties: [], expressions: [{ type: 'expression', targetProperty: 'x', source: 'time', enabled: true }] },
        ],
      }),
      'reframe_unsupported',
    ],
    ['a picture with no size', project([shot('v', { sourceWidth: undefined, sourceHeight: undefined })]), 'reframe_unsupported'],
  ];
  for (const [name, graph, code] of unsupported) {
    it(`refuses ${name}`, () => {
      assert.throws(
        () => reframeGraph(graph, plan({ v: [{ t: 0.5, x: 0.5 }] })),
        (error) => error instanceof ReframeRefusal && error.code === code && error.message.length > 10,
      );
    });
  }
});
