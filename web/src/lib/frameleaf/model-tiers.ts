/**
 * The quality word each model slider stop shows, worked out from where the stop sits in its list, so a
 * newly published model slots in with no code change. Two stops are Good and Best, three add Better,
 * four add Great, and five or more add Excellent as often as needed: the last is always Best.
 */
export type ModelTier = 'good' | 'better' | 'great' | 'excellent' | 'best';

/** The word of each of `count` different models, lightest first. */
export const tierWords = (count: number): ModelTier[] => {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return ['best'];
  }
  const leading: ModelTier[] = count === 2 ? ['good'] : count === 3 ? ['good', 'better'] : ['good', 'better', 'great'];
  const excellent = Array.from({ length: Math.max(0, count - leading.length - 1) }, () => 'excellent' as const);
  return [...leading, ...excellent, 'best'];
};

/**
 * The word of every stop. `modelOf` says which model a stop runs: a stop that runs the same model as the
 * one before it (the same model on Frameleaf Cloud, right after its local stop) keeps that stop's word.
 */
export const stopTiers = <T>(stops: readonly T[], modelOf: (stop: T) => string): ModelTier[] => {
  const distinct: string[] = [];
  for (const stop of stops) {
    if (!distinct.includes(modelOf(stop))) {
      distinct.push(modelOf(stop));
    }
  }
  const words = tierWords(distinct.length);
  return stops.map((stop) => words[distinct.indexOf(modelOf(stop))]);
};

/** The i18n key of a quality word. */
export const tierKey = (tier: ModelTier) => `frameleaf_model_tier_${tier}` as const;
