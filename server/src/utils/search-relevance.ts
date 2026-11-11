/**
 * FL-1393: which of a ranked search's results are close matches.
 *
 * A search by meaning ranks every photo, so its results never end: after the photos that show what
 * was asked for come the ones that only resemble it. Distances mean different things for each
 * model and each search, so the line is drawn from the search's own numbers: a result is close
 * while it sits in the first part of the way from the best result to what an unrelated photo of
 * the library scores for the same search (`SearchRepository.getUnrelatedSearchDistance`).
 *
 * The share was read off real searches (SigLIP ViT-B-16-384, two demo libraries of about 85 photos,
 * one of them nearly all mountain lakes): at 0.3 "lake" kept 27 lakes of that library's 83 results
 * and no campsites, "dog" kept every dog, "birthday cake" the nine cakes, "sunset" four sunsets.
 * It cannot tell that nothing matches: a search for nonsense still calls its nearest results close.
 */
export const CLOSE_MATCH_SHARE = 0.3;

/**
 * How many leading results are close matches, given their distances in rank order and what an
 * unrelated photo scores. Undefined when nothing can be said: no results, no unrelated distance,
 * or a best result no closer than an unrelated photo.
 */
export const countCloseMatches = (distances: number[], unrelated: number | null): number | undefined => {
  const best = distances[0];
  if (unrelated === null || best === undefined || !(best < unrelated)) {
    return undefined;
  }
  const limit = best + CLOSE_MATCH_SHARE * (unrelated - best);
  const firstLoose = distances.findIndex((distance) => distance > limit);
  return firstLoose === -1 ? distances.length : firstLoose;
};
