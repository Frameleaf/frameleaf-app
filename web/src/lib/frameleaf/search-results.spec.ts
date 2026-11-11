import { momentsByVideo, searchSplit } from '$lib/frameleaf/search-results';

describe('momentsByVideo', () => {
  it('gives one entry per video, with how many moments match and the time of the first', () => {
    const videos = momentsByVideo([
      { assetId: 'lake', timestampMs: 42_000 },
      { assetId: 'drive', timestampMs: 9000 },
      { assetId: 'lake', timestampMs: 6000 },
      { assetId: 'lake', timestampMs: 90_000 },
    ]);

    expect(videos.map(({ assetId, count, firstMs }) => ({ assetId, count, firstMs }))).toEqual([
      { assetId: 'lake', count: 3, firstMs: 6000 },
      { assetId: 'drive', count: 1, firstMs: 9000 },
    ]);
    expect(videos[0].first).toEqual({ assetId: 'lake', timestampMs: 6000 });
  });

  it('counts frames a few seconds apart as one moment', () => {
    // The review's case: four near-identical frames of one video, two seconds apart.
    const hits = [4000, 6000, 8000, 10_000].map((timestampMs) => ({ assetId: 'lake', timestampMs }));

    expect(momentsByVideo(hits)).toMatchObject([{ assetId: 'lake', count: 1, firstMs: 4000 }]);
    expect(momentsByVideo([...hits, { assetId: 'lake', timestampMs: 30_000 }])).toMatchObject([{ count: 2 }]);
  });

  it('is empty when no video matches', () => {
    expect(momentsByVideo([])).toEqual([]);
  });
});

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
