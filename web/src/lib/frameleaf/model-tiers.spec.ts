import { describe, expect, it } from 'vitest';
import { stopTiers, tierWords } from '$lib/frameleaf/model-tiers';

describe('tierWords', () => {
  it.each([
    [2, ['good', 'best']],
    [3, ['good', 'better', 'best']],
    [4, ['good', 'better', 'great', 'best']],
    [5, ['good', 'better', 'great', 'excellent', 'best']],
    [6, ['good', 'better', 'great', 'excellent', 'excellent', 'best']],
  ])('%i stops', (count, words) => {
    expect(tierWords(count)).toEqual(words);
  });

  it('always ends on Best, however many models are published', () => {
    for (const count of [2, 3, 7, 12]) {
      expect(tierWords(count).at(-1)).toBe('best');
      expect(tierWords(count)).toHaveLength(count);
    }
  });
});

describe('stopTiers', () => {
  it('gives a stop running the same model as the stop before it the same word', () => {
    const stops = ['small', 'medium', 'medium@cloud', 'large'];
    expect(stopTiers(stops, (stop) => stop.replace('@cloud', ''))).toEqual(['good', 'better', 'better', 'best']);
  });

  it('counts only distinct models, so a Cloud twin never moves the words', () => {
    const stops = ['a', 'a@cloud', 'b', 'b@cloud'];
    expect(stopTiers(stops, (stop) => stop.replace('@cloud', ''))).toEqual(['good', 'good', 'best', 'best']);
  });
});
