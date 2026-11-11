/**
 * FL-1393: which of a ranked search's results are close matches.
 *
 * A search by meaning ranks every photo, so its results never end: after the photos that show what
 * was asked for come the ones that only resemble it. Distances mean different things for each
 * model and each search, so the line is drawn from the search's own numbers: a result is close
 * while it sits in the first part of the way from the best-looking result to what an unrelated
 * photo of the library scores for the same search (`SearchRepository.getUnrelatedSearchDistance`).
 *
 * Both ends of that line are how photos look (`visualDistance`). What is held against the line is
 * the distance a result was ranked by (`searchDistance`), which is lower when the photo's own
 * words name the search. So a photo that names the words counts as close, and its bonus never
 * moves the line: the photos that simply look right stay close too.
 *
 * The share was read off real searches (SigLIP ViT-B-16-384, two demo libraries of about 85 photos,
 * one of them nearly all mountain lakes): at 0.3 "lake" kept 27 lakes of that library's 83 results
 * and no campsites, "dog" kept every dog, "birthday cake" the nine cakes, "sunset" four sunsets.
 * It cannot tell that nothing matches: a search for nonsense still calls its nearest results close.
 */
export const CLOSE_MATCH_SHARE = 0.3;

export type RankedDistances = { searchDistance: number; visualDistance: number };

/**
 * How many leading results are close matches, given the results in rank order and what an
 * unrelated photo scores. Undefined when nothing can be said: no results, no unrelated distance,
 * or a best-looking result no closer than an unrelated photo.
 */
export const countCloseMatches = (results: RankedDistances[], unrelated: number | null): number | undefined => {
  if (unrelated === null || results.length === 0) {
    return undefined;
  }
  const best = Math.min(...results.map(({ visualDistance }) => visualDistance));
  if (!(best < unrelated)) {
    return undefined;
  }
  const limit = best + CLOSE_MATCH_SHARE * (unrelated - best);
  const firstLoose = results.findIndex(({ searchDistance }) => searchDistance > limit);
  return firstLoose === -1 ? results.length : firstLoose;
};
