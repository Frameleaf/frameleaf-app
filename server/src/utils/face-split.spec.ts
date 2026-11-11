import { describe, expect, it } from 'vitest';
import { findFaceSplit } from 'src/utils/face-split.js';

// A small deterministic generator, so the faces are the same on every run.
const random = (seed: number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
};

const DIMENSIONS = 512;

/** `count` faces of one identity: a direction of its own plus noise (about 0.4 apart, as one person's faces are). */
const person = (identity: number, count: number, next: () => number, noise = 0.036) => {
  const centre = Array.from({ length: DIMENSIONS }, (_, index) => (index === identity ? 1 : 0));
  return Array.from({ length: count }, () => centre.map((value) => value + (next() * 2 - 1) * noise * Math.sqrt(3)));
};

/** Faces that look like nobody in particular: no shared direction at all. */
const leftovers = (count: number, next: () => number) =>
  Array.from({ length: count }, () => Array.from({ length: DIMENSIONS }, () => next() * 2 - 1));

describe('findFaceSplit (FL-1385)', () => {
  const options = { minDistance: 0.6 };

  it('finds the smaller of two different people held as one', () => {
    const next = random(1);
    const faces = [...person(0, 40, next), ...person(1, 6, next)];

    const split = findFaceSplit(faces, options);

    expect(split?.smaller).toEqual([40, 41, 42, 43, 44, 45]);
    expect(split?.larger).toHaveLength(40);
    expect(split?.distance).toBeGreaterThan(0.9);
  });

  it('finds an even mix too', () => {
    const next = random(2);
    const split = findFaceSplit([...person(0, 12, next), ...person(1, 12, next)], options);

    expect(split?.smaller).toHaveLength(12);
    expect(split?.larger).toHaveLength(12);
  });

  it('leaves one person alone', () => {
    expect(findFaceSplit(person(0, 60, random(3)), options)).toBeNull();
  });

  it('does not take blurry leftovers for a second person', () => {
    const next = random(4);
    expect(findFaceSplit([...person(0, 40, next), ...leftovers(5, next)], options)).toBeNull();
  });

  it('needs at least three faces on each side', () => {
    const next = random(5);
    expect(findFaceSplit([...person(0, 40, next), ...person(1, 2, next)], options)).toBeNull();
    expect(findFaceSplit([...person(0, 3, next), ...person(1, 2, next)], options)).toBeNull();
  });

  it('keeps two looks of one person together when their centres are closer than the threshold', () => {
    const next = random(6);
    // the second look shares most of its direction with the first
    const look = person(0, 10, next).map((face) => face.map((value, index) => (index === 1 ? value + 0.6 : value)));
    expect(findFaceSplit([...person(0, 30, next), ...look], options)).toBeNull();
  });
});
