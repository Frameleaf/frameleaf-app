import { StudioExportResolution, StudioExportShape } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  clampCentre,
  cropCentreAt,
  cropPath,
  cropShare,
  isMoved,
  limitNudge,
  pathAt,
  shapedSize,
  sizeLabel,
} from './reframe';

const frame = { width: 1920, height: 1080 };

describe('vertical and square export framing (FL-563)', () => {
  it('sizes the exported file for each shape and resolution', () => {
    expect(shapedSize(StudioExportShape.Landscape, StudioExportResolution.$1080P)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(shapedSize(StudioExportShape.Vertical, StudioExportResolution.$2160P)).toEqual({
      width: 2160,
      height: 3840,
    });
    expect(shapedSize(StudioExportShape.Vertical, StudioExportResolution.$1080P)).toEqual({
      width: 1080,
      height: 1920,
    });
    expect(shapedSize(StudioExportShape.Vertical, StudioExportResolution.$720P)).toEqual({ width: 720, height: 1280 });
    expect(shapedSize(StudioExportShape.Square, StudioExportResolution.$1440P)).toEqual({ width: 1440, height: 1440 });
    expect(shapedSize(StudioExportShape.Original, StudioExportResolution.$1080P, frame)).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(shapedSize(StudioExportShape.Vertical, StudioExportResolution.Original)).toBeNull();
    expect(sizeLabel({ width: 1080, height: 1920 })).toBe('1080 × 1920');
  });

  it('crops the full height, the shape’s width', () => {
    expect(cropShare(StudioExportShape.Vertical, frame)).toBeCloseTo(0.3164, 4);
    expect(cropShare(StudioExportShape.Square, frame)).toBe(0.5625);
    expect(cropShare(StudioExportShape.Square, { width: 1080, height: 1920 })).toBe(1);
    expect(cropShare(StudioExportShape.Original, frame)).toBe(1);
  });

  it('follows the subject path through the shot and keeps the crop inside the frame', () => {
    const path = [
      { t: 0.2, x: 0.3 },
      { t: 0.8, x: 0.9 },
    ];
    expect(pathAt(path, 0)).toBe(0.3);
    expect(pathAt(path, 0.5)).toBeCloseTo(0.6, 10);
    expect(pathAt(path, 1)).toBe(0.9);
    expect(pathAt([], 0.5)).toBe(0.5);
    const share = cropShare(StudioExportShape.Square, frame);
    expect(cropCentreAt(path, 1, 0, share)).toBe(0.71875);
    expect(cropCentreAt(path, 0, -0.5, share)).toBe(0.28125);
    expect(clampCentre(0.2, 1)).toBe(0.5);
  });

  it('applies a move to the whole shot', () => {
    const share = cropShare(StudioExportShape.Vertical, frame);
    expect(
      cropPath(
        [
          { t: 0.15, x: 0.4 },
          { t: 0.85, x: 0.6 },
        ],
        0.1,
        share,
      ),
    ).toEqual([
      { t: 0.15, x: 0.5 },
      { t: 0.85, x: 0.7 },
    ]);
    expect(cropPath([], 0, share)).toEqual([{ t: 0.5, x: 0.5 }]);
    expect(isMoved(0)).toBe(false);
    expect(isMoved(undefined)).toBe(false);
    expect(isMoved(0.01)).toBe(true);
    expect(limitNudge(0.9)).toBe(0.5);
    expect(limitNudge(-0.9)).toBe(-0.5);
  });
});
