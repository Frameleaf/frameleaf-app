import { describe, expect, it } from 'vitest';
import {
  COMPARE_KEEP_RATING,
  COMPARE_REJECT_RATING,
  COMPARE_UNDO_LIMIT,
  compareDecisionOf,
  comparePair,
  compareRating,
  nextChallenger,
  pushUndo,
} from '$lib/frameleaf/library-compare';

describe('library compare', () => {
  it('keeps with five stars and rejects with the rejected mark, and clears a repeated choice', () => {
    expect(compareRating('keep', null)).toBe(COMPARE_KEEP_RATING);
    expect(compareRating('reject', 3)).toBe(COMPARE_REJECT_RATING);
    expect(compareRating('keep', COMPARE_KEEP_RATING)).toBeNull();
    expect(compareRating('reject', COMPARE_REJECT_RATING)).toBeNull();
  });

  it('reads a rating back as a decision', () => {
    expect(compareDecisionOf(5)).toBe('keep');
    expect(compareDecisionOf(-1)).toBe('reject');
    expect(compareDecisionOf(3)).toBeNull();
    expect(compareDecisionOf(null)).toBeNull();
  });

  it('pins the first selected item and brings the rest up beside it', () => {
    expect(comparePair(['a'], 1)).toBeNull();
    expect(comparePair(['a', 'b', 'c'], 1)).toEqual({ pinned: 'a', challenger: 'b' });
    expect(comparePair(['a', 'b', 'c'], 9)).toEqual({ pinned: 'a', challenger: 'c' });
    expect(comparePair(['a', 'b', 'c'], 0)).toEqual({ pinned: 'a', challenger: 'b' });
  });

  it('moves on to the next selected item after a decision, stopping on the last', () => {
    expect(nextChallenger(['a', 'b', 'c'], 1)).toBe(2);
    expect(nextChallenger(['a', 'b', 'c'], 2)).toBe(2);
  });

  it('keeps a bounded undo history, newest last', () => {
    let stack = pushUndo([], { assetId: 'a', previous: null });
    stack = pushUndo(stack, { assetId: 'b', previous: 3 });
    expect(stack.at(-1)).toEqual({ assetId: 'b', previous: 3 });
    for (let index = 0; index < COMPARE_UNDO_LIMIT + 5; index++) {
      stack = pushUndo(stack, { assetId: `x${index}`, previous: null });
    }
    expect(stack).toHaveLength(COMPARE_UNDO_LIMIT);
  });
});
