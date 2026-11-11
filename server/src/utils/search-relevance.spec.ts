import { countCloseMatches } from 'src/utils/search-relevance.js';

describe(countCloseMatches.name, () => {
  it('counts the results in the first part of the way from the best one to an unrelated photo', () => {
    // best 0.90, unrelated 1.00: close up to 0.93
    expect(countCloseMatches([0.9, 0.92, 0.93, 0.94, 0.99], 1)).toBe(3);
  });

  it('counts every result when all of them are close', () => {
    expect(countCloseMatches([0.9, 0.91, 0.92], 1)).toBe(3);
  });

  it('says nothing without an unrelated distance, without results, or when the best is no closer than that', () => {
    expect(countCloseMatches([0.9, 0.95], null)).toBeUndefined();
    expect(countCloseMatches([], 1)).toBeUndefined();
    expect(countCloseMatches([1, 1.01], 1)).toBeUndefined();
    expect(countCloseMatches([1.02, 1.03], 1)).toBeUndefined();
  });
});
