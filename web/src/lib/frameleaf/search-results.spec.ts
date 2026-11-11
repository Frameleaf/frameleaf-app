import { searchSplit } from '$lib/frameleaf/search-results';

describe('searchSplit', () => {
  const results = ['a', 'b', 'c', 'd'];

  it('puts the close matches first and the looser ones after', () => {
    expect(searchSplit(results, 1)).toEqual({ best: ['a'], rest: ['b', 'c', 'd'] });
  });

  it('keeps one undivided grid when the server gave no count', () => {
    expect(searchSplit(results, undefined)).toBeNull();
    expect(searchSplit(results, null)).toBeNull();
  });

  it('keeps one undivided grid when everything is a close match, or nothing is', () => {
    expect(searchSplit(results, 4)).toBeNull();
    expect(searchSplit(results, 9)).toBeNull();
    expect(searchSplit(results, 0)).toBeNull();
  });
});
