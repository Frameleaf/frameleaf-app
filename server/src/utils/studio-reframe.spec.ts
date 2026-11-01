import {
  REFRAME_STILL_RANGE,
  StudioReframeError,
  canvasFraction,
  clampCentre,
  cropShare,
  reframeShots,
  sealStudioReframe,
  shapedOutputSize,
  shotSourceSeconds,
  smoothSubjectPath,
  subjectCentre,
} from 'src/utils/studio-reframe.js';

const face = (x1: number, x2: number, y1 = 100, y2 = 200, width = 1000, height = 1000) => ({
  boundingBoxX1: x1,
  boundingBoxX2: x2,
  boundingBoxY1: y1,
  boundingBoxY2: y2,
  imageWidth: width,
  imageHeight: height,
});

const graph = (items: unknown[]) => ({
  metadata: { width: 1920, height: 1080 },
  timeline: { tracks: [{ id: 'v1', order: 0 }], items },
});

const video = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  trackId: 'v1',
  type: 'video',
  mediaId: '11111111-1111-4111-8111-111111111111',
  from: 0,
  durationInFrames: 90,
  sourceStart: 30,
  sourceEnd: 120,
  sourceFps: 30,
  sourceWidth: 1920,
  sourceHeight: 1080,
  ...overrides,
});

describe('subjectCentre', () => {
  it('is the centre of the faces weighted by their size', () => {
    expect(subjectCentre([face(100, 200)])).toBe(0.15);
    // a big face at 0.7 and a smaller one at 0.3: the big one pulls harder
    expect(subjectCentre([face(600, 800, 0, 200), face(250, 350, 0, 100)])).toBeCloseTo((0.7 * 4 + 0.3 * 1) / 5, 4);
  });

  it('ignores faces far smaller than the largest, and pictures with none', () => {
    expect(subjectCentre([face(600, 800, 0, 200), face(0, 20, 0, 20)])).toBe(0.7);
    expect(subjectCentre([])).toBeNull();
    expect(subjectCentre([face(100, 100)])).toBeNull();
    expect(subjectCentre([{ ...face(100, 200), imageWidth: 0 }])).toBeNull();
  });
});

describe('smoothSubjectPath', () => {
  it('smooths samples so one jumpy frame cannot swing the crop', () => {
    const path = smoothSubjectPath([
      { t: 0.15, x: 0.3 },
      { t: 0.5, x: 0.9 },
      { t: 0.85, x: 0.3 },
    ])!;
    expect(path.map((point) => point.t)).toEqual([0.15, 0.5, 0.85]);
    expect(path[1].x).toBe(0.6);
    expect(path[0].x).toBe(0.45);
  });

  it('holds a path that barely moves at its average', () => {
    expect(
      smoothSubjectPath([
        { t: 0.15, x: 0.5 },
        { t: 0.5, x: 0.5 + REFRAME_STILL_RANGE / 2 },
        { t: 0.85, x: 0.5 },
      ]),
    ).toEqual([{ t: 0.5, x: 0.5067 }]);
  });

  it('fills a frame with no face from the nearest one, then from the library faces', () => {
    expect(
      smoothSubjectPath([
        { t: 0.15, x: 0.2 },
        { t: 0.5, x: null },
        { t: 0.85, x: 0.8 },
      ])!.map((point) => point.x),
    ).toEqual([0.2, 0.35, 0.65]);
    expect(smoothSubjectPath([{ t: 0.5, x: null }], 0.3)).toEqual([{ t: 0.5, x: 0.3 }]);
    expect(smoothSubjectPath([], 0.42)).toEqual([{ t: 0.5, x: 0.42 }]);
  });

  it('answers null when nothing was found anywhere, so the caller centres the crop', () => {
    expect(smoothSubjectPath([{ t: 0.5, x: null }])).toBeNull();
    expect(smoothSubjectPath([])).toBeNull();
  });

  it('is deterministic', () => {
    const samples = [
      { t: 0.85, x: 0.7 },
      { t: 0.15, x: 0.2 },
      { t: 0.5, x: 0.4 },
    ];
    expect(smoothSubjectPath(samples)).toEqual(smoothSubjectPath(samples.toReversed()));
  });
});

describe('frame geometry', () => {
  it('sizes shaped files and crops', () => {
    expect(shapedOutputSize('vertical', '2160p')).toEqual({ width: 2160, height: 3840 });
    expect(shapedOutputSize('square', '720p')).toEqual({ width: 720, height: 720 });
    expect(shapedOutputSize('vertical', 'original')).toBeNull();
    expect(cropShare({ width: 1920, height: 1080 }, 'vertical')).toBeCloseTo(0.3164, 4);
    expect(cropShare({ width: 1920, height: 1080 }, 'square')).toBe(0.5625);
    expect(cropShare({ width: 1080, height: 1920 }, 'square')).toBe(1);
  });

  it('keeps the crop inside the frame', () => {
    expect(clampCentre(0.05, 0.5)).toBe(0.25);
    expect(clampCentre(0.95, 0.5)).toBe(0.75);
    expect(clampCentre(0.6, 0.5)).toBe(0.6);
    expect(clampCentre(0.1, 1)).toBe(0.5);
  });

  it('maps a point of the picture onto the canvas through the clip box', () => {
    const canvas = { width: 1920, height: 1080 };
    expect(canvasFraction(video('v'), canvas, 0.25)).toBe(0.25);
    // a portrait phone clip is pillarboxed in the middle third
    expect(canvasFraction(video('v', { sourceWidth: 1080, sourceHeight: 1920 }), canvas, 0)).toBeCloseTo(
      (960 - 303.75) / 1920,
      4,
    );
    // moved right by a quarter of the frame, half size
    expect(canvasFraction(video('v', { transform: { x: 480, width: 960, height: 540 } }), canvas, 0.5)).toBe(0.75);
    expect(canvasFraction(video('v', { transform: { flipHorizontal: true } }), canvas, 0.2)).toBe(0.8);
    expect(canvasFraction(video('v', { transform: { rotation: 90, x: 192 } }), canvas, 0.1)).toBe(0.6);
  });

  it('lists the shots of the main timeline in the order they start, with their source time', () => {
    const shots = reframeShots(
      graph([
        video('b', { from: 90 }),
        { id: 't', type: 'text', from: 0, durationInFrames: 10 },
        { id: 'p', type: 'image', mediaId: null, from: 0, durationInFrames: 30 },
        video('a'),
      ]),
    );
    expect(shots.map((shot) => shot.id)).toEqual(['a', 'p', 'b']);
    expect(shotSourceSeconds(shots[0], 0)).toBe(1);
    expect(shotSourceSeconds(shots[0], 1)).toBe(4);
    expect(shotSourceSeconds(shots[1], 0.5)).toBeNull();
  });
});

describe('sealStudioReframe', () => {
  const project = graph([video('a'), video('b', { from: 90, transform: { x: 480, width: 960, height: 540 } })]);

  it('seals the output size and every shot, centring those the dialog did not send', () => {
    const seal = sealStudioReframe(project, 'vertical', '1080p', [
      {
        clipId: 'a',
        path: [
          { t: 0, x: 0.4 },
          { t: 1, x: 0.6 },
        ],
      },
    ]);
    expect(seal).toEqual({
      version: 1,
      shape: 'vertical',
      output: { width: 1080, height: 1920 },
      shots: {
        a: [
          { t: 0, x: 0.4 },
          { t: 1, x: 0.6 },
        ],
        b: [{ t: 0.5, x: 0.75 }],
      },
    });
  });

  it('clamps every centre so the crop stays in the frame', () => {
    const seal = sealStudioReframe(project, 'square', '720p', [{ clipId: 'a', path: [{ t: 0.5, x: 0.01 }] }]);
    expect(seal.shots.a).toEqual([{ t: 0.5, x: 0.2813 }]);
    expect(seal.shots.b).toEqual([{ t: 0.5, x: 0.7188 }]);
  });

  it('drops progress values that rounding brings together', () => {
    const seal = sealStudioReframe(project, 'vertical', '1080p', [
      {
        clipId: 'a',
        path: [
          { t: 0.50001, x: 0.4 },
          { t: 0.50002, x: 0.6 },
        ],
      },
    ]);
    expect(seal.shots.a).toEqual([{ t: 0.5, x: 0.4 }]);
  });

  it('ignores a clip that is no longer a shot of this version', () => {
    const seal = sealStudioReframe(project, 'vertical', '1080p', [{ clipId: 'gone', path: [{ t: 0.5, x: 0.2 }] }]);
    expect(Object.keys(seal.shots)).toEqual(['a', 'b']);
  });

  it.each([
    [
      'a clip twice',
      [
        { clipId: 'a', path: [{ t: 0.5, x: 0.5 }] },
        { clipId: 'a', path: [{ t: 0.5, x: 0.5 }] },
      ],
    ],
    [
      'a path out of order',
      [
        {
          clipId: 'a',
          path: [
            { t: 0.6, x: 0.5 },
            { t: 0.2, x: 0.5 },
          ],
        },
      ],
    ],
    ['an empty path', [{ clipId: 'a', path: [] }]],
    ['a first point that is not a number', [{ clipId: 'a', path: [{ t: NaN, x: 0.5 }] }]],
    ['an infinite position', [{ clipId: 'a', path: [{ t: 0.5, x: Infinity }] }]],
  ])('refuses %s', (_name, framing) => {
    expect(() => sealStudioReframe(project, 'vertical', '1080p', framing)).toThrow(StudioReframeError);
  });

  it('refuses the original resolution and a graph with no canvas', () => {
    expect(() => sealStudioReframe(project, 'vertical', 'original')).toThrow(StudioReframeError);
    expect(() => sealStudioReframe({ timeline: { items: [] } }, 'vertical', '1080p')).toThrow(StudioReframeError);
  });
});
