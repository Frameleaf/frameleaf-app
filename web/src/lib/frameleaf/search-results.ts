/**
 * FL-1393 (UI review 11-10, B4): what the search results page shows above and around the grid.
 * Pure, so the rules are tested without mounting the page.
 */

/** One hit of moment search, as much of it as the grouping reads. */
export type MomentHit = { assetId: string; timestampMs: number };

/** One video that holds moments matching a search. */
export type VideoMoments<T extends MomentHit = MomentHit> = {
  assetId: string;
  /** How many separate moments match. */
  count: number;
  /** The earliest matching moment, where the video opens. */
  firstMs: number;
  /** The earliest hit, for its frame. */
  first: T;
};

/**
 * Hits this close together are one moment: moment search answers with frames, and neighbouring
 * frames of one scene (two seconds apart in the review) are not separate things to find.
 */
export const SAME_MOMENT_MS = 5000;

/**
 * One entry per video, in the order the search ranked the videos (by each video's best hit), with
 * how many moments match and the time of the first.
 */
export const momentsByVideo = <T extends MomentHit>(hits: T[]): VideoMoments<T>[] => {
  const byVideo = new Map<string, T[]>();
  for (const hit of hits) {
    const group = byVideo.get(hit.assetId);
    if (group) {
      group.push(hit);
    } else {
      byVideo.set(hit.assetId, [hit]);
    }
  }
  return [...byVideo.entries()].map(([assetId, group]) => {
    const ordered = [...group].sort((a, b) => a.timestampMs - b.timestampMs);
    let count = 0;
    let last = -Infinity;
    for (const { timestampMs } of ordered) {
      if (timestampMs - last > SAME_MOMENT_MS) {
        count++;
      }
      last = timestampMs;
    }
    return { assetId, count, firstMs: ordered[0].timestampMs, first: ordered[0] };
  });
};

/**
 * Close matches first, looser ones after: the split of a ranked result list, or null for one
 * undivided grid. There is no split when the server gave no count (a text search), when nothing
 * is a close match, or when everything is.
 */
export const searchSplit = <T>(results: T[], closeMatches: number | null | undefined) =>
  closeMatches && closeMatches > 0 && closeMatches < results.length
    ? { best: results.slice(0, closeMatches), rest: results.slice(closeMatches) }
    : null;
