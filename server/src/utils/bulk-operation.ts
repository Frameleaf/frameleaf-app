import { MediaOperationBulkAction, MediaOperationItemStatus } from 'src/enum.js';

/**
 * The durable rules for a bulk media operation (FL-32), kept free of the database and of NestJS so
 * they can be read and tested on their own.
 *
 * Three things live here and nothing else:
 *
 * 1. **What was asked for.** `BulkOperationSnapshot` is the immutable request: the action, the
 *    exact asset ids frozen when the person submitted, and the action's payload. It is parsed
 *    defensively because it comes back out of a `jsonb` column that a future version may have
 *    written differently.
 * 2. **What happened.** `BulkOperationResult` accumulates per-item outcomes as batches finish.
 *    Successes are counted, refusals are recorded individually up to a bound, and the bound is
 *    reported rather than hidden.
 * 3. **What is left.** `bulkResumeIds` answers the only question a retry may ask: which items of
 *    this operation have not been done. It is the difference between resuming an operation and
 *    silently running it a second time.
 */

/** Ids sent to a list endpoint in one call. Matches the web client's own batch size. */
export const BULK_BATCH_SIZE = 500;

/**
 * Per-item outcomes kept on the row.
 *
 * Successes are not recorded individually: a 50,000-item favourite would otherwise store 50,000
 * rows saying "yes". Refusals are, because they are what a person has to act on and what a retry
 * has to reach. When more refusals occur than this, the count stays exact and `itemsTruncated`
 * says the list does not — a retry must never quietly cover less than it appears to.
 */
export const BULK_RECORDED_ITEM_LIMIT = 1000;

/** The largest frozen set the server will accept in one operation. */
export const BULK_MAX_ITEMS = 50_000;

export type BulkOperationPayload = {
  albumId?: string;
  tagIds?: string[];
  dateMode?: 'set' | 'shift';
  dateTimeOriginal?: string;
  timeZone?: string;
  minutes?: number;
  description?: string;
  latitude?: number;
  longitude?: number;
  primaryId?: string;
  stackIds?: string[];
};

/** The immutable request, as stored in `media_operation.snapshot`. */
export type BulkOperationSnapshot = {
  action: MediaOperationBulkAction;
  /** The frozen matching set, in the order it will be worked through. Order is the resume cursor. */
  assetIds: string[];
  payload: BulkOperationPayload;
  /** The count the person saw next to "Select all n" when they submitted, when there was one. */
  submittedTotal: number | null;
  /** True when the client's matching set hit its own bound and the frozen set is short of it. */
  truncated: boolean;
  /** Free-form description of the scope the set came from, for the audit trail. Never re-resolved. */
  scope?: Record<string, unknown>;
};

export type BulkOperationItem = {
  id: string;
  status: MediaOperationItemStatus;
  /** A stable key the client translates. Never a raw server message. */
  reasonKey?: string;
  /** The server's own words, for the details list. */
  message?: string;
};

export type BulkOperationResult = {
  requested: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Recorded refusals, bounded by `BULK_RECORDED_ITEM_LIMIT`. */
  items: BulkOperationItem[];
  /** True when more refusals happened than were recorded above. */
  itemsTruncated: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const BULK_ACTIONS = new Set<string>(Object.values(MediaOperationBulkAction));

export const isBulkAction = (value: unknown): value is MediaOperationBulkAction =>
  typeof value === 'string' && BULK_ACTIONS.has(value);

/**
 * Read the immutable request back out of the row.
 *
 * Throws rather than guessing. A snapshot we cannot read is an operation we must not run: applying
 * a half-understood action to somebody's library is worse than failing loudly.
 */
export const parseBulkSnapshot = (snapshot: unknown): BulkOperationSnapshot => {
  if (!isRecord(snapshot)) {
    throw new Error('Bulk operation snapshot is missing');
  }

  const { action } = snapshot;
  if (!isBulkAction(action)) {
    throw new Error(`Unsupported bulk action: ${String(action)}`);
  }

  const assetIds = [...new Set(asStringArray(snapshot.assetIds))];
  if (assetIds.length === 0) {
    throw new Error('Bulk operation snapshot has no assets');
  }

  return {
    action,
    assetIds,
    payload: isRecord(snapshot.payload) ? (snapshot.payload as BulkOperationPayload) : {},
    submittedTotal: typeof snapshot.submittedTotal === 'number' ? snapshot.submittedTotal : null,
    truncated: snapshot.truncated === true,
    scope: isRecord(snapshot.scope) ? snapshot.scope : undefined,
  };
};

export const emptyBulkResult = (requested: number): BulkOperationResult => ({
  requested,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  items: [],
  itemsTruncated: false,
});

/** Read an accumulated result back, tolerating a row that has never been written to. */
export const parseBulkResult = (result: unknown, requested: number): BulkOperationResult => {
  if (!isRecord(result)) {
    return emptyBulkResult(requested);
  }

  const items = Array.isArray(result.items)
    ? result.items
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .filter((item) => typeof item.id === 'string')
        .map((item) => ({
          id: item.id as string,
          status:
            item.status === MediaOperationItemStatus.Skipped
              ? MediaOperationItemStatus.Skipped
              : item.status === MediaOperationItemStatus.Ok
                ? MediaOperationItemStatus.Ok
                : MediaOperationItemStatus.Failed,
          reasonKey: typeof item.reasonKey === 'string' ? item.reasonKey : undefined,
          message: typeof item.message === 'string' ? item.message : undefined,
        }))
    : [];

  return {
    requested: asNumber(result.requested) || requested,
    succeeded: asNumber(result.succeeded),
    failed: asNumber(result.failed),
    skipped: asNumber(result.skipped),
    items,
    itemsTruncated: result.itemsTruncated === true,
  };
};

/**
 * Fold a finished batch into the running result.
 *
 * Counts are always exact. The recorded list is where the bound bites, and when it does
 * `itemsTruncated` is set in the same breath, so nothing downstream can mistake a short list for a
 * complete one.
 */
export const mergeBulkOutcomes = (
  previous: BulkOperationResult,
  outcomes: readonly BulkOperationItem[],
): BulkOperationResult => {
  const merged: BulkOperationResult = {
    ...previous,
    items: [...previous.items],
  };

  for (const outcome of outcomes) {
    switch (outcome.status) {
      case MediaOperationItemStatus.Ok: {
        merged.succeeded += 1;
        // A success needs no record of its own; the count is the whole story.
        continue;
      }
      case MediaOperationItemStatus.Skipped: {
        merged.skipped += 1;
        break;
      }
      case MediaOperationItemStatus.Failed: {
        merged.failed += 1;
        break;
      }
    }

    if (merged.items.length < BULK_RECORDED_ITEM_LIMIT) {
      merged.items.push(outcome);
    } else {
      merged.itemsTruncated = true;
    }
  }

  return merged;
};

/** Items the operation has answered for, successfully or not. Drives progress and the cursor. */
export const bulkProcessedCount = (result: BulkOperationResult): number =>
  result.succeeded + result.failed + result.skipped;

/**
 * What a retry of this operation must cover.
 *
 * Two groups, and both matter:
 *
 * - items that were attempted and failed, and
 * - items the operation never reached, because it was cancelled or its worker died partway.
 *
 * Items that were skipped are *not* included: they were refused because the account has no access
 * to them, and running them again would fail in exactly the same way. The order of the original
 * snapshot is preserved so the retry's own cursor means the same thing.
 *
 * `processed` is the durable count from the row, which is why a resume is correct across a restart:
 * the first `processed` ids of the snapshot are the ones already answered for.
 */
export const bulkResumeIds = (
  snapshot: BulkOperationSnapshot,
  result: BulkOperationResult,
  processed: number,
): string[] => {
  const retryable = new Set(
    result.items.filter((item) => item.status === MediaOperationItemStatus.Failed).map((item) => item.id),
  );
  const cursor = Math.max(0, Math.min(processed, snapshot.assetIds.length));
  const unreached = new Set(snapshot.assetIds.slice(cursor));

  return snapshot.assetIds.filter((id) => retryable.has(id) || unreached.has(id));
};

export const chunkIds = (ids: readonly string[], size = BULK_BATCH_SIZE): string[][] => {
  const width = Number.isInteger(size) && size > 0 ? size : BULK_BATCH_SIZE;
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += width) {
    batches.push([...ids.slice(index, index + width)]);
  }
  return batches;
};

/**
 * The exact message `requireAccess` throws when an id in the batch is not the caller's to touch.
 *
 * Matching on it is a coupling, and a deliberate one: the alternative is treating every rejected
 * batch as a failure and offering a retry that can only fail again. The spec beside this file
 * pins the wording so a change upstream breaks a test rather than a person's Activity page.
 *
 * @see src/utils/access.ts
 */
const ACCESS_DENIED_PREFIX = 'Not found or no ';

type MaybeHttpError = { status?: unknown; message?: unknown };

/**
 * Decide how one item's rejection should read.
 *
 * "Skipped" means nothing changed and nothing will: no access, or the item is gone. "Failed" means
 * something went wrong that trying again could fix. Getting this backwards either offers a retry
 * that can never work or hides a transient failure as a permission problem, so the classification
 * is narrow: an access refusal, and nothing else, is a skip.
 */
export const classifyBulkError = (error: unknown): { status: MediaOperationItemStatus; reasonKey: string } => {
  const candidate = error as MaybeHttpError | null;
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  const status = typeof candidate?.status === 'number' ? candidate.status : 0;

  if (status === 403 || message.startsWith(ACCESS_DENIED_PREFIX)) {
    return { status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_no_access' };
  }

  return { status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' };
};

export const bulkErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown error';
};
