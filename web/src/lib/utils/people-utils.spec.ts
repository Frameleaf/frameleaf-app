import type { Faces } from '$lib/managers/asset-viewer-manager.svelte';
import type { Size } from '$lib/utils/container-utils';
import { getBoundingBox } from '$lib/utils/people-utils';

const makeFace = (overrides: Partial<Faces> = {}): Faces => ({
  id: 'face-1',
  imageWidth: 4000,
  imageHeight: 3000,
  boundingBoxX1: 1000,
  boundingBoxY1: 750,
  boundingBoxX2: 2000,
  boundingBoxY2: 1500,
  ...overrides,
});

describe('getBoundingBox', () => {
  it('should scale face coordinates to display dimensions', () => {
    const face = makeFace();
    const imageSize: Size = { width: 800, height: 600 };

    const boxes = getBoundingBox([face], imageSize);

    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toEqual({
      id: 'face-1',
      top: 600 * (750 / 3000),
      left: 800 * (1000 / 4000),
      width: 800 * (2000 / 4000) - 800 * (1000 / 4000),
      height: 600 * (1500 / 3000) - 600 * (750 / 3000),
    });
  });

  it('should map full-image face to full display area', () => {
    const face = makeFace({
      imageWidth: 1000,
      imageHeight: 1000,
      boundingBoxX1: 0,
      boundingBoxY1: 0,
      boundingBoxX2: 1000,
      boundingBoxY2: 1000,
    });
    const imageSize: Size = { width: 600, height: 600 };

    const boxes = getBoundingBox([face], imageSize);

    expect(boxes[0]).toEqual({
      id: 'face-1',
      top: 0,
      left: 0,
      width: 600,
      height: 600,
    });
  });

  it('should return empty array for empty faces', () => {
    expect(getBoundingBox([], { width: 800, height: 600 })).toEqual([]);
  });

  it('should handle multiple faces', () => {
    const faces = [
      makeFace({ id: 'face-1', boundingBoxX1: 0, boundingBoxY1: 0, boundingBoxX2: 1000, boundingBoxY2: 1000 }),
      makeFace({ id: 'face-2', boundingBoxX1: 2000, boundingBoxY1: 1500, boundingBoxX2: 3000, boundingBoxY2: 2500 }),
    ];

    const boxes = getBoundingBox(faces, { width: 800, height: 600 });

    expect(boxes).toHaveLength(2);
    expect(boxes[0].left).toBeLessThan(boxes[1].left);
  });

  it('uses each face model resolution independently', () => {
    const faces = [
      makeFace(),
      makeFace({
        id: 'second',
        imageWidth: 800,
        imageHeight: 600,
        boundingBoxX1: 200,
        boundingBoxY1: 150,
        boundingBoxX2: 400,
        boundingBoxY2: 300,
      }),
    ];
    expect(getBoundingBox(faces, { width: 800, height: 600 })).toEqual([
      { id: 'face-1', top: 150, left: 200, width: 200, height: 150 },
      { id: 'second', top: 150, left: 200, width: 200, height: 150 },
    ]);
  });

  it('preserves input order and duplicate ids without changing frozen face data', () => {
    const faces = [makeFace({ id: 'same' }), makeFace({ id: 'same', boundingBoxX1: 0 })];
    const before = structuredClone(faces);
    for (const face of faces) {
      Object.freeze(face);
    }
    Object.freeze(faces);
    const size = Object.freeze({ width: 800, height: 600 });
    expect(getBoundingBox(faces, size)).toEqual([
      { id: 'same', top: 150, left: 200, width: 200, height: 150 },
      { id: 'same', top: 150, left: 0, width: 400, height: 150 },
    ]);
    expect(faces).toEqual(before);
  });

  it('uses the current display size on every call', () => {
    const faces = [makeFace()];
    expect(getBoundingBox(faces, { width: 800, height: 600 })[0]).toEqual({
      id: 'face-1',
      top: 150,
      left: 200,
      width: 200,
      height: 150,
    });
    expect(getBoundingBox(faces, { width: 400, height: 300 })[0]).toEqual({
      id: 'face-1',
      top: 75,
      left: 100,
      width: 100,
      height: 75,
    });
  });

  it('retains signed geometry outside the model bounds without clamping or reversing endpoints', () => {
    const face = makeFace({
      imageWidth: 100,
      imageHeight: 100,
      boundingBoxX1: -10,
      boundingBoxY1: -20,
      boundingBoxX2: -20,
      boundingBoxY2: 120,
    });
    expect(getBoundingBox([face], { width: 200, height: 100 })).toEqual([
      { id: 'face-1', top: -20, left: -20, width: -20, height: 140 },
    ]);
  });
});
