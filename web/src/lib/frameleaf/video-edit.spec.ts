import {
  AssetEditAction,
  MirrorAxis,
  TextOverlayPosition,
  VideoAdjustModel,
  VideoDevelopPreset,
  VideoTrimMode,
} from '@immich/sdk';
import {
  changeVideoDraft,
  createVideoDraft,
  filmstripTimes,
  flattenSpeedRanges,
  fromVideoEdits,
  initialVideoEdit,
  normalizeVideoEdit,
  preciseTime,
  renderedDuration,
  speedAt,
  textSizeFraction,
  toOriginalRect,
  toVideoEdits,
  travelVideoDraft,
  type VideoEdit,
} from '$lib/frameleaf/video-edit';

const source = { width: 1920, height: 1080, durationMs: 24_000 };
const edit = (patch: Partial<VideoEdit> = {}) => normalizeVideoEdit({ ...initialVideoEdit(24), ...patch }, 24);

describe('video quick editor edit (FL-113)', () => {
  it('saves nothing for an untouched clip', () => {
    expect(toVideoEdits(edit(), source)).toEqual([]);
  });

  it('matches the prototype helpers for the timeline', () => {
    expect(filmstripTimes(12, 4)).toEqual([1.5, 4.5, 7.5, 10.5]);
    expect(preciseTime(75.25)).toBe('01:15.3');
    const clip = edit({ speed: 2, speedSegments: [{ start: 4, end: 8, speed: 0.5 }] });
    expect(speedAt(clip, 5)).toBe(0.5);
    expect(speedAt(clip, 10)).toBe(2);
    // 4 s at 2×, 4 s at 0.5×, 16 s at 2×.
    expect(renderedDuration(clip)).toBe(2 + 8 + 8);
  });

  it('resolves overlapping ranges the way playback does and drops ranges at the whole-clip speed', () => {
    const clip = edit({
      start: 2,
      end: 20,
      speedSegments: [
        { start: 0, end: 6, speed: 2 },
        { start: 4, end: 10, speed: 0.5 },
        { start: 12, end: 14, speed: 1 },
      ],
    });
    expect(flattenSpeedRanges(clip)).toEqual([
      { start: 2, end: 6, speed: 2 },
      { start: 6, end: 10, speed: 0.5 },
    ]);
  });

  it('writes trim, speed, audio and Enhance as the server expects', () => {
    const edits = toVideoEdits(
      edit({
        start: 1.5,
        end: 20,
        trim: 'fast',
        speed: 2,
        speedSegments: [{ start: 4, end: 8, speed: 0.5 }],
        volume: 120,
        stabilize: true,
        autoEnhance: true,
      }),
      source,
    );
    expect(edits).toEqual([
      { action: AssetEditAction.Stabilize, parameters: { enabled: true } },
      { action: AssetEditAction.AutoEnhance, parameters: { enabled: true } },
      { action: AssetEditAction.Trim, parameters: { startMs: 1500, endMs: 20_000, mode: VideoTrimMode.Fast } },
      { action: AssetEditAction.Speed, parameters: { rate: 2 } },
      { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 4000, endMs: 8000 } },
      { action: AssetEditAction.Audio, parameters: { volume: 1.2 } },
    ]);
    expect(toVideoEdits(edit({ volume: 0 }), source)).toEqual([
      { action: AssetEditAction.Audio, parameters: { muted: true } },
    ]);
  });

  it('writes the develop model with the look and its strength', () => {
    expect(
      toVideoEdits(edit({ exposure: 0.5, clarity: 10, preset: VideoDevelopPreset.BW, presetStrength: 60 }), source),
    ).toEqual([
      {
        action: AssetEditAction.Adjust,
        parameters: {
          model: VideoAdjustModel.Develop,
          exposure: 0.5,
          clarity: 10,
          preset: VideoDevelopPreset.BW,
          presetStrength: 60,
        },
      },
    ]);
  });

  it('turns and flips the displayed crop back into the original pixels', () => {
    // A quarter turn clockwise: the displayed frame is 1080 × 1920. Its top-left quarter is the
    // original's bottom-left quarter.
    const turned = edit({ rotation: 90, cropRect: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    expect(toOriginalRect(turned)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    const edits = toVideoEdits(turned, source);
    expect(edits[0]).toEqual({ action: AssetEditAction.Crop, parameters: { x: 0, y: 540, width: 960, height: 540 } });
    expect(edits[1]).toEqual({ action: AssetEditAction.Rotate, parameters: { angle: 90 } });

    const flipped = edit({ flipH: true, cropRect: { x: 0, y: 0, w: 0.25, h: 1 } });
    expect(toVideoEdits(flipped, source)[0]).toEqual({
      action: AssetEditAction.Crop,
      parameters: { x: 1440, y: 0, width: 480, height: 1080 },
    });
  });

  it('negates the straighten angle under a single flip, because the server mirrors afterwards', () => {
    expect(toVideoEdits(edit({ straighten: 5, flipH: true }), source)).toContainEqual({
      action: AssetEditAction.Straighten,
      parameters: { angle: -5 },
    });
    expect(toVideoEdits(edit({ straighten: 5, flipH: true, flipV: true }), source)).toContainEqual({
      action: AssetEditAction.Straighten,
      parameters: { angle: 5 },
    });
  });

  it('anchors text on the grid and scales its size from points to the output height', () => {
    expect(textSizeFraction(32, { width: 1920, height: 1080 })).toBe(0.0444);
    const [overlay] = toVideoEdits(
      edit({
        textOverlays: [
          {
            id: 'a',
            text: ' Hello ',
            position: TextOverlayPosition.BottomRight,
            start: 1,
            end: 5,
            fontSize: 32,
            color: '#f5d76e',
            shadow: true,
          },
        ],
      }),
      source,
    );
    expect(overlay).toEqual({
      action: AssetEditAction.TextOverlay,
      parameters: {
        text: 'Hello',
        position: TextOverlayPosition.BottomRight,
        x: 1,
        y: 1,
        shadow: true,
        size: 0.0444,
        color: '#f5d76e',
        startMs: 1000,
        endMs: 5000,
      },
    });
  });

  it('reads back what it writes', () => {
    const original = edit({
      rotation: 270,
      flipV: true,
      straighten: -3.5,
      cropRect: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 },
      crop: 'Free',
      exposure: -0.5,
      preset: VideoDevelopPreset.Noir,
      presetStrength: 40,
      start: 2,
      end: 18,
      speed: 0.5,
      speedSegments: [{ start: 4, end: 6, speed: 2 }],
      volume: 50,
      textOverlays: [
        {
          id: 'text-1',
          text: 'Title',
          position: TextOverlayPosition.Top,
          start: 2,
          end: 6,
          fontSize: 48,
          color: '#ffffff',
          shadow: false,
        },
      ],
      autoEnhance: true,
    });
    const restored = fromVideoEdits(toVideoEdits(original, source), source);
    expect(restored.cropRect.x).toBeCloseTo(0.1, 2);
    expect(restored.cropRect.w).toBeCloseTo(0.5, 2);
    expect({ ...restored, cropRect: original.cropRect }).toEqual(original);
  });

  it('keeps adjustments from the earlier editor until Adjust or Presets change', () => {
    const legacy = [
      { action: AssetEditAction.Adjust, parameters: { brightness: 10 } },
      { action: AssetEditAction.Filter, parameters: { name: 'warm', intensity: 80 } },
    ];
    const opened = fromVideoEdits(
      [...legacy, { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } }],
      source,
    );
    expect(toVideoEdits(opened, source)).toEqual(
      expect.arrayContaining([
        ...legacy,
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ]),
    );

    const trimmed = changeVideoDraft(createVideoDraft(opened), { start: 1 }, 24);
    expect(trimmed.edit.legacy).toHaveLength(2);
    const adjusted = changeVideoDraft(trimmed, { contrast: 10 }, 24);
    expect(adjusted.edit.legacy).toEqual([]);
    expect(toVideoEdits(adjusted.edit, source)).not.toContainEqual(legacy[0]);
  });

  it('undoes and redoes, and ignores a change that changes nothing', () => {
    const start = createVideoDraft(edit());
    expect(changeVideoDraft(start, { volume: 100 }, 24)).toBe(start);
    const louder = changeVideoDraft(start, { volume: 130 }, 24);
    const undone = travelVideoDraft(louder, 'undo');
    expect(undone.edit.volume).toBe(100);
    expect(travelVideoDraft(undone, 'redo').edit.volume).toBe(130);
  });
});
