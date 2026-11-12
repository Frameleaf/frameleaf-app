import { countCloseMatches, frameMatchLimit } from 'src/utils/search-relevance.js';

const looks = (...distances: number[]) =>
  distances.map((distance) => ({ searchDistance: distance, visualDistance: distance }));

describe(countCloseMatches.name, () => {
  it('counts the results in the first part of the way from the best one to an unrelated photo', () => {
    // best 0.90, unrelated 1.00: close up to 0.93
    expect(countCloseMatches(looks(0.9, 0.92, 0.93, 0.94, 0.99), 1)).toBe(3);
  });

  it('counts every result when all of them are close', () => {
    expect(countCloseMatches(looks(0.9, 0.91, 0.92), 1)).toBe(3);
  });

  it('counts a photo whose words name the search, without letting its bonus move the line', () => {
    // Ranked first by its words (0.85) though it looks like 0.95. The line still starts at the
    // best-looking photo (0.90), so the look-alikes up to 0.93 stay close.
    const named = { searchDistance: 0.85, visualDistance: 0.95 };
    expect(countCloseMatches([named, ...looks(0.9, 0.92, 0.93, 0.94, 0.99)], 1)).toBe(4);
  });

  it('says nothing without an unrelated distance, without results, or when the best is no closer than that', () => {
    expect(countCloseMatches(looks(0.9, 0.95), null)).toBeUndefined();
    expect(countCloseMatches([], 1)).toBeUndefined();
    expect(countCloseMatches(looks(1, 1.01), 1)).toBeUndefined();
    expect(countCloseMatches(looks(1.02, 1.03), 1)).toBeUndefined();
  });
});

describe(frameMatchLimit.name, () => {
  it('keeps frames in the first part of the way from the best one to an unrelated frame', () => {
    // best 0.90, unrelated 1.00: up to 0.93, nearer than nonsense (0.95) gets
    expect(frameMatchLimit(0.9, 1, 0.95)).toBeCloseTo(0.93);
  });

  it('never keeps a frame as far as nonsense words get', () => {
    expect(frameMatchLimit(0.9, 1.2, 0.94)).toBe(0.94);
    // Too few frames to say what unrelated is: only the nonsense line.
    expect(frameMatchLimit(0.9, null, 0.94)).toBe(0.94);
  });

  it('matches nothing when the best frame is no nearer than nonsense, or there is no frame', () => {
    expect(frameMatchLimit(0.95, 1, 0.95)).toBeUndefined();
    expect(frameMatchLimit(0.97, 1, 0.95)).toBeUndefined();
    expect(frameMatchLimit(undefined, 1, 0.95)).toBeUndefined();
    expect(frameMatchLimit(0.9, 1, null)).toBeUndefined();
  });
});
