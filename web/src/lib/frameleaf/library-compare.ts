/**
 * Culling comparison in the library (FL-61), the prototype's `compare` view (`App.jsx`): the first
 * selected item stays pinned on the left and the rest of the selection comes up beside it, one at a
 * time. Keep and Reject write the item's rating — keep is five stars, reject is the rejected mark —
 * so a cull is the same rating every other view and search reads, and every decision can be undone.
 */

/** The rating a Keep writes: the prototype's five stars. */
export const COMPARE_KEEP_RATING = 5;
/** The rating a Reject writes: the rejected mark. */
export const COMPARE_REJECT_RATING = -1;

export type CompareDecision = 'keep' | 'reject';

/** One reversible rating change: what the item was before. */
export type CompareUndo = { assetId: string; previous: number | null };

/** The rating a decision writes. Choosing the decision the item already has clears it again. */
export const compareRating = (decision: CompareDecision, current: number | null | undefined): number | null => {
  const target = decision === 'keep' ? COMPARE_KEEP_RATING : COMPARE_REJECT_RATING;
  return current === target ? null : target;
};

/** Which decision an item's rating reads as, if any. */
export const compareDecisionOf = (rating: number | null | undefined): CompareDecision | null =>
  rating === COMPARE_KEEP_RATING ? 'keep' : rating === COMPARE_REJECT_RATING ? 'reject' : null;

/**
 * The pinned item and the challenger at `index` (1-based within the rest of the selection). The
 * challenger index is clamped, so a selection that shrank never points past its end.
 */
export const comparePair = (
  selection: readonly string[],
  index: number,
): { pinned: string; challenger: string } | null => {
  if (selection.length < 2) {
    return null;
  }
  const at = Math.min(Math.max(1, index), selection.length - 1);
  return { pinned: selection[0], challenger: selection[at] };
};

/**
 * Where the challenger goes after a decision on it: the next selected item, or it stays on the last
 * one. One click decides and moves on; nothing asks for confirmation, because every decision undoes.
 */
export const nextChallenger = (selection: readonly string[], index: number): number =>
  Math.min(Math.max(1, index + 1), Math.max(1, selection.length - 1));

/** Keep at most this many decisions to undo, newest last. */
export const COMPARE_UNDO_LIMIT = 50;

export const pushUndo = (stack: readonly CompareUndo[], entry: CompareUndo): CompareUndo[] =>
  [...stack, entry].slice(-COMPARE_UNDO_LIMIT);
