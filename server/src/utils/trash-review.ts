import { createHash } from 'node:crypto';
import { AssetStatus } from 'src/enum.js';
import { compareCodeUnits } from 'src/utils/compare.js';

/**
 * Reviewed trash changes (FL-47).
 *
 * Every change the Trash page and the large-file review make to an asset's lifecycle goes through
 * one review and one apply. The review resolves the exact set the person is shown — their own
 * items, in the state the action starts from, without Locked media unless the session is unlocked
 * and without anything their privacy filters hide — and returns a token that fingerprints that set.
 * The apply resolves the same set again, inside the transaction that changes it, and refuses when
 * the fingerprint differs: an item restored, deleted, locked, unlocked, hidden or revealed since the
 * review is never changed on the strength of a review that did not show it.
 *
 * The token carries no authority. It only proves the set is the one that was reviewed; ownership,
 * the lock and the privacy filters are applied again by the query that finds the set.
 */
export enum TrashReviewAction {
  /** Move chosen library items to the trash (the large-file review). */
  Trash = 'trash',
  /** Restore chosen items from the trash. */
  Restore = 'restore',
  /** Restore every item in the trash the session can see. */
  RestoreAll = 'restore-all',
  /** Permanently delete chosen items from the trash. */
  Delete = 'delete',
  /** Permanently delete every item in the trash the session can see. */
  Empty = 'empty',
}

/** Actions over a set the caller names; the others cover the whole visible trash. */
export const TRASH_ACTIONS_WITH_IDS: ReadonlySet<TrashReviewAction> = new Set([
  TrashReviewAction.Trash,
  TrashReviewAction.Restore,
  TrashReviewAction.Delete,
]);

/** Permanent deletion; the review for these asks for typed confirmation in the client. */
export const DESTRUCTIVE_TRASH_ACTIONS: ReadonlySet<TrashReviewAction> = new Set([
  TrashReviewAction.Delete,
  TrashReviewAction.Empty,
]);

/** The status an item must have for the action to apply to it. */
export const trashActionSourceStatus = (action: TrashReviewAction): AssetStatus =>
  action === TrashReviewAction.Trash ? AssetStatus.Active : AssetStatus.Trashed;

/** What an item becomes. Restore also clears `deletedAt`; trash sets it. */
export const trashActionTargetStatus = (action: TrashReviewAction): AssetStatus => {
  switch (action) {
    case TrashReviewAction.Trash: {
      return AssetStatus.Trashed;
    }
    case TrashReviewAction.Restore:
    case TrashReviewAction.RestoreAll: {
      return AssetStatus.Active;
    }
    default: {
      return AssetStatus.Deleted;
    }
  }
};

/** One item of a reviewed set, as the fingerprint sees it. */
export type TrashScopeRow = {
  id: string;
  ownerId: string;
  status: AssetStatus;
  deletedAt: Date | string | null;
  isLocked: boolean;
};

/** One item of a reviewed set, as the review summarises it. */
export type TrashReviewRow = TrashScopeRow & {
  originalFileName: string;
  fileSizeInByte: number | string | null;
  /** Another asset still names the same original, so deleting this one does not free it. */
  sharesOriginal: boolean;
};

const toIso = (value: Date | string | null) => {
  if (value === null) {
    return '';
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

/**
 * The fingerprint of a reviewed set. Order-independent, and sensitive to everything that decides
 * whether the action may touch an item: which items, whose, their status, when they were trashed
 * and whether they are locked.
 */
export const trashReviewToken = (userId: string, action: TrashReviewAction, rows: readonly TrashScopeRow[]) => {
  const hash = createHash('sha256');
  hash.update(`${userId}\n${action}\n`);
  for (const row of rows.toSorted((a, b) => compareCodeUnits(a.id, b.id))) {
    hash.update(`${row.id}|${row.ownerId}|${row.status}|${toIso(row.deletedAt)}|${row.isLocked ? 1 : 0}\n`);
  }
  return hash.digest('hex');
};

/** A byte count from a bigint column, which may arrive as a string. Unknown counts as zero. */
export const toByteCount = (value: number | string | null | undefined) => {
  const bytes = Number(value ?? 0);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
};

/** How many file names the review lists before "and n more". */
export const TRASH_REVIEW_NAME_LIMIT = 8;

export type TrashReviewSummary = {
  count: number;
  bytes: number;
  retainedOriginals: number;
  retainedBytes: number;
  names: string[];
};

/**
 * What the review shows: the count, the logical size of the originals and how much of that stays
 * on disk because another item still uses the same original. Deleting a shared original frees
 * nothing until its last reference goes, so the page never promises space it will not free.
 */
export const summarizeTrashReview = (rows: readonly TrashReviewRow[]): TrashReviewSummary => {
  let bytes = 0;
  let retainedOriginals = 0;
  let retainedBytes = 0;
  for (const row of rows) {
    const size = toByteCount(row.fileSizeInByte);
    bytes += size;
    if (row.sharesOriginal) {
      retainedOriginals++;
      retainedBytes += size;
    }
  }

  const names = rows
    .map((row) => row.originalFileName)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, TRASH_REVIEW_NAME_LIMIT);

  return { count: rows.length, bytes, retainedOriginals, retainedBytes, names };
};

/** Search terms for the trash: whitespace separated, every term must appear in the file name. */
export const trashSearchTerms = (query: string | undefined) =>
  (query ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 10);

/** A term as a literal `ilike` pattern: `%`, `_` and the escape character match themselves. */
export const escapeLikeTerm = (term: string) => term.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
