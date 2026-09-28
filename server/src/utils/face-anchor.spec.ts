import {
  anchorBox,
  boxIou,
  fractionBox,
  matchAnchoredFaces,
  normalizedBox,
  sameChecksum,
} from 'src/utils/face-anchor.js';

const face = (id: string, x1: number, x2: number) => ({
  id,
  boundingBoxX1: x1,
  boundingBoxX2: x2,
  boundingBoxY1: 100,
  boundingBoxY2: 200,
  imageWidth: 1000,
  imageHeight: 1000,
});
const entry = (x1: number, x2: number, at: number) => ({
  boxX1: x1,
  boxX2: x2,
  boxY1: 0.1,
  boxY2: 0.2,
  createdAt: new Date(at),
});

describe('face anchors (FL-57)', () => {
  it('normalizes a face box and measures overlap', () => {
    expect(normalizedBox(face('a', 100, 200))).toEqual({ x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 });
    expect(normalizedBox({ ...face('a', 1, 2), imageWidth: 0 })).toBeNull();
    const box = { x1: 0, y1: 0, x2: 1, y2: 1 };
    expect(boxIou(box, box)).toBe(1);
    expect(boxIou(box, { x1: 2, y1: 2, x2: 3, y2: 3 })).toBe(0);
    expect(boxIou(box, null)).toBe(0);
    expect(anchorBox({ boxX1: null, boxY1: null, boxX2: null, boxY2: null })).toBeNull();
  });

  it('holds a decision to its original only', () => {
    expect(sameChecksum(Buffer.from('a'), Buffer.from('a'))).toBe(true);
    expect(sameChecksum(Buffer.from('a'), Buffer.from('b'))).toBe(false);
    expect(sameChecksum(Buffer.from('a'), null)).toBe(false);
    expect(sameChecksum(null, Buffer.from('b'))).toBe(true);
  });

  it('gives each decision the new face it overlaps most, newest decision first, one decision per face', () => {
    const older = entry(0.1, 0.2, 1);
    const newer = entry(0.11, 0.21, 2);
    const far = entry(0.8, 0.9, 3);
    const matches = matchAnchoredFaces([older, newer, far], [face('a', 100, 200), face('b', 400, 500)]);
    expect(matches).toEqual([{ entry: newer, face: expect.objectContaining({ id: 'a' }) }]);
  });

  it('turns a pixel box into fractions of its image', () => {
    expect(fractionBox(face('a', 100, 300))).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    expect(fractionBox(face('a', 300, 100))).toBeNull();
  });
});
