import { AssetJobName } from 'src/dtos/asset.dto.js';
import { AssetVisibility, MediaOperationBulkAction, MediaOperationItemStatus, Permission } from 'src/enum.js';
import {
  type DuplicateGroupDecision,
  duplicateDecisionProblem,
  duplicateGroupIndex,
  groupAlignedBatchSize,
  parseDuplicateGroups,
} from 'src/utils/duplicate-review.js';

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
  /** Still + motion video pairs to relink (FL-70). Every id in this list is also in `assetIds`. */
  pairs?: { photoId: string; videoId: string }[];
  /** Duplicate review decisions (FL-61): one complete group each, members in job order. */
  duplicateGroups?: DuplicateGroupDecision[];
  /**
   * Library Care findings to act on (FL-69): one per asset in `assetIds`, naming the finding and,
   * for a relink or a recovery, the reviewed candidate. The worker re-reads and re-verifies all of
   * it at the moment of change; this only says what the person chose.
   */
  mediaHealth?: BulkMediaHealthEntry[];
  /** The classification rule an `apply-classification-rule` job applies (FL-60). */
  classificationRuleId?: string;
  /**
   * The transactional archive operation (FL-32) an `archive` or `unarchive` job publishes or undoes.
   * Set only by the server (`ArchiveOperationService`), never accepted from a client payload.
   */
  archiveOperationId?: string;
};

/** One reviewed Library Care finding in a bulk job (FL-69). */
export type BulkMediaHealthEntry = { assetId: string; findingId: string; candidateId?: string };

/** The Library Care bulk actions (FL-69). */
export const MEDIA_HEALTH_BULK_ACTIONS: readonly MediaOperationBulkAction[] = [
  MediaOperationBulkAction.RelinkMissingMedia,
  MediaOperationBulkAction.RecoverDamagedMedia,
  MediaOperationBulkAction.TrashDamagedMedia,
];

export const isMediaHealthBulkAction = (action: MediaOperationBulkAction) => MEDIA_HEALTH_BULK_ACTIONS.includes(action);

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
  /** The client's idempotency key. A second submit with the same key answers with the first job. */
  requestId: string | null;
  /**
   * The API key the operation was submitted with, when it was. The runner checks the key still
   * exists and still grants the action before every batch, so revoking a key stops its jobs.
   */
  apiKeyId: string | null;
  /**
   * True when the job was submitted from an unlocked (PIN-elevated) session (FL-34). The worker only
   * changes an item locked at the time of change when this is set; a job submitted without the PIN
   * skips anything locked since, whatever locked it.
   */
  elevated?: boolean;
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
  /**
   * The batch being applied right now, written before it is sent. If the worker dies mid-batch the
   * next claim finds this and applies the same batch again; every action is safe to repeat (a
   * relative date shift through `shiftFrom` below).
   */
  inFlight: { start: number; size: number } | null;
  /**
   * The automatic retry pass over the items that failed (owner decision, September 22, 2026).
   *
   * Once the first pass reaches the end, every recorded failure is moved in here, taken out of
   * `items` and `failed`, and applied once more on the next claim. What happens to it the second
   * time is what is reported. Null until the pass is planned; it is only ever planned once.
   */
  retry: BulkRetryPass | null;
  /**
   * The capture date each item had before a relative date shift touched it, as an ISO string, or
   * null when it had none. Recorded in the same write that marks the batch in flight, before the
   * batch is applied, and never overwritten: the shift then sets `from + minutes` rather than adding
   * to whatever the date is now, so applying the same batch again never moves an item twice. Kept
   * only while an item might still be applied again — in flight, failed or waiting for its retry.
   */
  shiftFrom: Record<string, string | null>;
};

export type BulkRetryPass = {
  /** The failed items, in snapshot order. */
  ids: string[];
  /** How many there are; kept apart from `ids` so the list view can drop the ids and keep this. */
  total: number;
  /** The retry pass's own cursor over `ids`. */
  processed: number;
  inFlight: { start: number; size: number } | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const parseInFlight = (value: unknown): BulkOperationResult['inFlight'] => {
  if (!isRecord(value)) {
    return null;
  }
  const start = asNumber(value.start);
  const size = asNumber(value.size);
  return Number.isSafeInteger(start) && Number.isSafeInteger(size) && start >= 0 && size > 0 ? { start, size } : null;
};

const parseRetryPass = (value: unknown): BulkRetryPass | null => {
  if (!isRecord(value)) {
    return null;
  }
  // The list query trims the ids and keeps the count, so the bound falls back to it.
  const ids = [...new Set(asStringArray(value.ids))];
  const total = ids.length > 0 ? ids.length : asNumber(value.total);
  const processed = asNumber(value.processed);
  return {
    ids,
    total,
    processed: Number.isSafeInteger(processed) ? Math.min(Math.max(0, processed), total) : 0,
    inFlight: parseInFlight(value.inFlight),
  };
};

const parseShiftFrom = (value: unknown): Record<string, string | null> => {
  if (!isRecord(value)) {
    return {};
  }
  const origins: Record<string, string | null> = {};
  for (const [id, from] of Object.entries(value)) {
    if (from === null) {
      origins[id] = null;
    } else if (typeof from === 'string' && !Number.isNaN(Date.parse(from))) {
      origins[id] = from;
    }
  }
  return origins;
};

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
    requestId: typeof snapshot.requestId === 'string' ? snapshot.requestId : null,
    apiKeyId: typeof snapshot.apiKeyId === 'string' ? snapshot.apiKeyId : null,
    elevated: snapshot.elevated === true,
  };
};

export const emptyBulkResult = (requested: number): BulkOperationResult => ({
  requested,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  items: [],
  itemsTruncated: false,
  inFlight: null,
  retry: null,
  shiftFrom: {},
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
    inFlight: parseInFlight(result.inFlight),
    retry: parseRetryPass(result.retry),
    shiftFrom: parseShiftFrom(result.shiftFrom),
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
 * Three groups, and all of them matter:
 *
 * - items that were attempted and failed,
 * - items the operation never reached, because it was cancelled or its worker died partway —
 *   including a batch that was in flight at that moment, which is safe to apply again, and
 * - items waiting in the automatic retry pass that the pass had not reached yet.
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
  for (const id of bulkRetryPending(result)) {
    unreached.add(id);
  }

  return snapshot.assetIds.filter((id) => retryable.has(id) || unreached.has(id));
};

/** The items of the automatic retry pass it has not answered for yet. */
export const bulkRetryPending = (result: Pick<BulkOperationResult, 'retry'>): string[] =>
  result.retry ? result.retry.ids.slice(result.retry.processed) : [];

/**
 * Plan the automatic retry pass: every recorded failure, once (owner decision, September 22, 2026).
 *
 * The failed items leave `items` and the `failed` count and go into `retry`, in snapshot order, so
 * the counts stay exact while they wait — they are neither done nor failed until the second attempt
 * answers for them. Returns null when there is nothing to retry or the pass has already been
 * planned; a job's items are retried automatically once, never more.
 *
 * Only recorded failures can be retried. When more failed than `BULK_RECORDED_ITEM_LIMIT` allows
 * the list to hold, the unrecorded ones stay counted as failed, as `itemsTruncated` already says.
 */
export const planBulkRetryPass = (
  snapshot: Pick<BulkOperationSnapshot, 'assetIds'>,
  result: BulkOperationResult,
): BulkOperationResult | null => {
  if (result.retry) {
    return null;
  }

  const failed = new Set(
    result.items.filter((item) => item.status === MediaOperationItemStatus.Failed).map((item) => item.id),
  );
  if (failed.size === 0) {
    return null;
  }

  const ids = snapshot.assetIds.filter((id) => failed.has(id));
  return {
    ...result,
    failed: Math.max(0, result.failed - ids.length),
    items: result.items.filter((item) => !(item.status === MediaOperationItemStatus.Failed && failed.has(item.id))),
    retry: { ids, total: ids.length, processed: 0, inFlight: null },
  };
};

/** True for the one action whose repeat would compound: a relative date shift. */
export const isRelativeDateShift = (snapshot: Pick<BulkOperationSnapshot, 'action' | 'payload'>): boolean =>
  snapshot.action === MediaOperationBulkAction.ChangeDate && snapshot.payload.dateMode === 'shift';

/**
 * Record where each item's capture date started, for the ones not recorded yet.
 *
 * An item already in `shiftFrom` keeps its first value: by now the shift may have been applied to
 * it, and reading the date again would record the shifted date as the start and move it twice.
 * An item the reader did not answer for (not the owner's, or gone) is left out; the access check
 * refuses it before anything is applied.
 */
export const recordShiftOrigins = (
  result: BulkOperationResult,
  ids: readonly string[],
  current: ReadonlyMap<string, Date | null>,
): BulkOperationResult => {
  const shiftFrom = { ...result.shiftFrom };
  for (const id of ids) {
    if (id in shiftFrom || !current.has(id)) {
      continue;
    }
    const value = current.get(id) ?? null;
    shiftFrom[id] = value ? value.toISOString() : null;
  }
  return { ...result, shiftFrom };
};

/**
 * Forget the starting dates nothing can apply again: keep an item only while it is in flight,
 * recorded as failed (a manual retry may reach it) or waiting in the retry pass.
 */
export const pruneShiftOrigins = (
  snapshot: Pick<BulkOperationSnapshot, 'assetIds'>,
  result: BulkOperationResult,
): BulkOperationResult => {
  const keys = Object.keys(result.shiftFrom);
  if (keys.length === 0) {
    return result;
  }

  const keep = new Set([
    ...result.items.filter((item) => item.status === MediaOperationItemStatus.Failed).map((item) => item.id),
    ...bulkRetryPending(result),
  ]);
  if (result.inFlight) {
    for (const id of snapshot.assetIds.slice(result.inFlight.start, result.inFlight.start + result.inFlight.size)) {
      keep.add(id);
    }
  }
  if (result.retry?.inFlight) {
    const { start, size } = result.retry.inFlight;
    for (const id of result.retry.ids.slice(start, start + size)) {
      keep.add(id);
    }
  }

  return {
    ...result,
    shiftFrom: Object.fromEntries(Object.entries(result.shiftFrom).filter(([id]) => keep.has(id))),
  };
};

/** The recorded starting dates a manual retry of these items carries over. */
export const carriedShiftOrigins = (
  result: Pick<BulkOperationResult, 'shiftFrom'>,
  ids: readonly string[],
): Record<string, string | null> =>
  Object.fromEntries(ids.filter((id) => id in result.shiftFrom).map((id) => [id, result.shiftFrom[id]]));

export const chunkIds = (ids: readonly string[], size = BULK_BATCH_SIZE): string[][] => {
  const width = Number.isSafeInteger(size) && size > 0 ? size : BULK_BATCH_SIZE;
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += width) {
    batches.push(ids.slice(index, index + width));
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
    return { status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_no_permission' };
  }

  return { status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' };
};

export const bulkErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown error';
};

/**
 * What a scoped API key has to grant before it may submit an action.
 *
 * The worker applies the action as the account, not as the key, so this is checked at submit and
 * again before every batch. Without it a key restricted to reading could queue a delete.
 */
export const BULK_ACTION_PERMISSIONS: Readonly<Record<MediaOperationBulkAction, readonly Permission[]>> = {
  [MediaOperationBulkAction.Favorite]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.Unfavorite]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.Archive]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.Unarchive]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.AddToAlbum]: [Permission.AlbumAssetCreate, Permission.AssetShare],
  [MediaOperationBulkAction.RemoveFromAlbum]: [Permission.AlbumAssetDelete],
  [MediaOperationBulkAction.Tag]: [Permission.TagAsset, Permission.AssetUpdate],
  [MediaOperationBulkAction.Untag]: [Permission.TagAsset],
  [MediaOperationBulkAction.ChangeDate]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.ChangeDescription]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.ChangeLocation]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.MarkSensitive]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.UnmarkSensitive]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.Delete]: [Permission.AssetDelete],
  [MediaOperationBulkAction.DeletePermanently]: [Permission.AssetDelete],
  [MediaOperationBulkAction.Restore]: [Permission.AssetDelete],
  [MediaOperationBulkAction.Stack]: [Permission.AssetUpdate, Permission.StackCreate],
  [MediaOperationBulkAction.Unstack]: [Permission.StackDelete],
  [MediaOperationBulkAction.RefreshThumbnails]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.RefreshMetadata]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.RefreshEncoded]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.RefreshFaces]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.RelinkLivePhoto]: [Permission.AssetUpdate],
  // A decision can trash, stack or merge metadata into the keeper; its undo restores and unstacks.
  [MediaOperationBulkAction.ResolveDuplicates]: [
    Permission.DuplicateDelete,
    Permission.AssetDelete,
    Permission.AssetUpdate,
    Permission.StackCreate,
  ],
  [MediaOperationBulkAction.UndoDuplicates]: [
    Permission.DuplicateDelete,
    Permission.AssetDelete,
    Permission.AssetUpdate,
    Permission.StackDelete,
  ],
  [MediaOperationBulkAction.RelinkMissingMedia]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.RecoverDamagedMedia]: [Permission.AssetUpdate],
  [MediaOperationBulkAction.TrashDamagedMedia]: [Permission.AssetDelete],
  // A rule writes to its own smart album, its rule-owned tag and, when consented, the archive state.
  [MediaOperationBulkAction.ApplyClassificationRule]: [Permission.AlbumUpdate, Permission.AssetUpdate],
};

/**
 * The per-item access check the runner makes before it sends a batch, or null where the service
 * it calls already answers per item.
 *
 * Pre-checking is what lets a refusal be reported against the item that caused it. Most list
 * endpoints reject a whole batch when one id is not the caller's, and one of them — bulk tagging —
 * silently drops it instead, which would count an untouched item as a success.
 */
export const BULK_ITEM_PERMISSION: Readonly<Record<MediaOperationBulkAction, Permission | null>> = {
  [MediaOperationBulkAction.Favorite]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Unfavorite]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Archive]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Unarchive]: Permission.AssetUpdate,
  // The album and untag endpoints answer per id with their own access check.
  [MediaOperationBulkAction.AddToAlbum]: null,
  [MediaOperationBulkAction.RemoveFromAlbum]: null,
  [MediaOperationBulkAction.Tag]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Untag]: null,
  [MediaOperationBulkAction.ChangeDate]: Permission.AssetUpdate,
  [MediaOperationBulkAction.ChangeDescription]: Permission.AssetUpdate,
  [MediaOperationBulkAction.ChangeLocation]: Permission.AssetUpdate,
  // Mark Sensitive is the lock (FL-34): the lock and unlock endpoints reject a whole list.
  [MediaOperationBulkAction.MarkSensitive]: Permission.AssetUpdate,
  [MediaOperationBulkAction.UnmarkSensitive]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Delete]: Permission.AssetDelete,
  [MediaOperationBulkAction.DeletePermanently]: Permission.AssetDelete,
  [MediaOperationBulkAction.Restore]: Permission.AssetDelete,
  [MediaOperationBulkAction.Stack]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Unstack]: null,
  [MediaOperationBulkAction.RefreshThumbnails]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshMetadata]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshEncoded]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshFaces]: Permission.AssetUpdate,
  // The relink service re-validates ownership of both the still and the video itself (FL-70).
  [MediaOperationBulkAction.RelinkLivePhoto]: null,
  // Duplicate decisions are checked a whole group at a time, as the owner of every photo in it.
  [MediaOperationBulkAction.ResolveDuplicates]: null,
  [MediaOperationBulkAction.UndoDuplicates]: null,
  // Library Care (FL-69) checks each finding's owner, Locked state and evidence itself, because an
  // administrator may repair another account's originals but never reach its Locked media.
  [MediaOperationBulkAction.RelinkMissingMedia]: null,
  [MediaOperationBulkAction.RecoverDamagedMedia]: null,
  [MediaOperationBulkAction.TrashDamagedMedia]: null,
  // The classification service reaches only the rule owner's own, unlocked items (FL-60).
  [MediaOperationBulkAction.ApplyClassificationRule]: null,
};

/** True for the two actions that work a complete duplicate group at a time (FL-61). */
export const isDuplicateDecisionAction = (action: MediaOperationBulkAction): boolean =>
  action === MediaOperationBulkAction.ResolveDuplicates || action === MediaOperationBulkAction.UndoDuplicates;

/**
 * Which duplicate group each asset of a decision job belongs to, or null for any other action. Built
 * once per claim: a batch must end on a group boundary (`bulkBatchLength`).
 */
export const bulkGroupIndex = (
  snapshot: Pick<BulkOperationSnapshot, 'action' | 'payload'>,
): ReadonlyMap<string, string> | null =>
  isDuplicateDecisionAction(snapshot.action)
    ? duplicateGroupIndex(parseDuplicateGroups(snapshot.payload.duplicateGroups))
    : null;

/**
 * How many of `ids` from `start` the next batch takes. A duplicate decision job never splits a group
 * across two batches, so its batches end on a group boundary; every other job takes `size`.
 */
export const bulkBatchLength = (
  ids: readonly string[],
  start: number,
  size: number,
  groupIndex: ReadonlyMap<string, string> | null,
): number =>
  groupIndex ? groupAlignedBatchSize(ids, start, size, groupIndex) : Math.max(0, Math.min(size, ids.length - start));

export const BULK_ASSET_JOBS: Readonly<Partial<Record<MediaOperationBulkAction, AssetJobName>>> = {
  [MediaOperationBulkAction.RefreshThumbnails]: AssetJobName.REGENERATE_THUMBNAIL,
  [MediaOperationBulkAction.RefreshMetadata]: AssetJobName.REFRESH_METADATA,
  [MediaOperationBulkAction.RefreshEncoded]: AssetJobName.TRANSCODE_VIDEO,
  [MediaOperationBulkAction.RefreshFaces]: AssetJobName.REFRESH_FACES,
};

/**
 * The fields of the bulk asset update an action writes, or null when it is not that kind of action.
 *
 * Deliberately no Locked visibility anywhere in here: moving into or out of the Locked folder is
 * confirmed by the person in their unlocked session, never queued for later.
 */
export const bulkAssetUpdate = (
  action: MediaOperationBulkAction,
  payload: BulkOperationPayload,
): Record<string, unknown> | null => {
  switch (action) {
    case MediaOperationBulkAction.Favorite: {
      return { isFavorite: true };
    }
    case MediaOperationBulkAction.Unfavorite: {
      return { isFavorite: false };
    }
    case MediaOperationBulkAction.Archive: {
      return { visibility: AssetVisibility.Archive };
    }
    case MediaOperationBulkAction.Unarchive: {
      return { visibility: AssetVisibility.Timeline };
    }
    case MediaOperationBulkAction.ChangeDate: {
      // A relative shift is not a bulk update: `dateTimeRelative` adds to whatever the date is now,
      // so repeating it would move items twice. The runner shifts from recorded starting dates.
      return payload.dateMode === 'shift'
        ? null
        : { dateTimeOriginal: payload.dateTimeOriginal, ...(payload.timeZone && { timeZone: payload.timeZone }) };
    }
    case MediaOperationBulkAction.ChangeDescription: {
      return { description: payload.description ?? '' };
    }
    case MediaOperationBulkAction.ChangeLocation: {
      return { latitude: payload.latitude, longitude: payload.longitude };
    }
    default: {
      return null;
    }
  }
};

const isTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * Why a submission cannot run, or null when it can.
 *
 * Every action that needs a payload has it checked here, at submit, so a mistake is a 400 to the
 * person who made it rather than fifty thousand identical failures in their Activity list.
 */
export const bulkPayloadProblem = (
  action: MediaOperationBulkAction,
  payload: BulkOperationPayload,
  assetIds: readonly string[],
): string | null => {
  switch (action) {
    case MediaOperationBulkAction.AddToAlbum:
    case MediaOperationBulkAction.RemoveFromAlbum: {
      return payload.albumId ? null : 'An album is required for this action';
    }
    case MediaOperationBulkAction.Tag:
    case MediaOperationBulkAction.Untag: {
      return payload.tagIds && payload.tagIds.length > 0 ? null : 'At least one tag is required for this action';
    }
    case MediaOperationBulkAction.ApplyClassificationRule: {
      return payload.classificationRuleId ? null : 'A classification rule is required for this action';
    }
    case MediaOperationBulkAction.ChangeDate: {
      if (payload.dateMode === 'shift') {
        return Number.isSafeInteger(payload.minutes) && payload.minutes !== 0
          ? null
          : 'A whole, non-zero number of minutes is required to shift dates';
      }
      if (!payload.dateTimeOriginal || Number.isNaN(Date.parse(payload.dateTimeOriginal))) {
        return 'A valid date is required for this action';
      }
      return !payload.timeZone || isTimeZone(payload.timeZone) ? null : 'The time zone is not recognised';
    }
    case MediaOperationBulkAction.ChangeDescription: {
      return typeof payload.description === 'string' ? null : 'A description is required for this action';
    }
    case MediaOperationBulkAction.ChangeLocation: {
      return typeof payload.latitude === 'number' && typeof payload.longitude === 'number'
        ? null
        : 'Latitude and longitude are required for this action';
    }
    case MediaOperationBulkAction.Stack: {
      if (assetIds.length < 2) {
        return 'A stack needs at least two items';
      }
      return !payload.primaryId || assetIds.includes(payload.primaryId)
        ? null
        : 'The primary item must be one of the selected items';
    }
    case MediaOperationBulkAction.Unstack: {
      return payload.stackIds && payload.stackIds.length > 0 ? null : 'At least one stack is required for this action';
    }
    case MediaOperationBulkAction.RelinkLivePhoto: {
      const pairs = payload.pairs ?? [];
      if (pairs.length === 0) {
        return 'At least one still + video pair is required for this action';
      }
      const photoIds = new Set(pairs.map((pair) => pair.photoId));
      const videoIds = new Set(pairs.map((pair) => pair.videoId));
      if (photoIds.size !== pairs.length || videoIds.size !== pairs.length) {
        return 'Each still and each video may appear in only one pair';
      }
      if (pairs.some((pair) => pair.photoId === pair.videoId)) {
        return 'A still cannot be paired with itself';
      }
      // The frozen set the job iterates over is the still ids; every pair must name one of them and
      // every still must have exactly one pair, so the job's cursor and its payload agree.
      const assetIdSet = new Set(assetIds);
      return photoIds.size === assetIdSet.size && [...photoIds].every((id) => assetIdSet.has(id))
        ? null
        : 'Every pair must name one of the selected still images';
    }
    case MediaOperationBulkAction.ResolveDuplicates:
    case MediaOperationBulkAction.UndoDuplicates: {
      const groups = parseDuplicateGroups(payload.duplicateGroups);
      if (!Array.isArray(payload.duplicateGroups) || groups.length !== payload.duplicateGroups.length) {
        return 'Every duplicate group needs a group, a decision and its photos';
      }
      return duplicateDecisionProblem(groups, assetIds, {
        undo: action === MediaOperationBulkAction.UndoDuplicates,
      });
    }
    case MediaOperationBulkAction.RelinkMissingMedia:
    case MediaOperationBulkAction.RecoverDamagedMedia:
    case MediaOperationBulkAction.TrashDamagedMedia: {
      const entries = payload.mediaHealth ?? [];
      if (entries.length === 0) {
        return 'At least one finding is required for this action';
      }
      const needsCandidate = action !== MediaOperationBulkAction.TrashDamagedMedia;
      if (needsCandidate && entries.some((entry) => !entry.candidateId)) {
        return 'Every finding needs a reviewed candidate for this action';
      }
      const entryAssetIds = new Set(entries.map((entry) => entry.assetId));
      const findingIds = new Set(entries.map((entry) => entry.findingId));
      if (entryAssetIds.size !== entries.length || findingIds.size !== entries.length) {
        return 'Each item and each finding may appear only once';
      }
      // The frozen set is the findings' asset ids, one entry each, so the cursor and payload agree.
      const assetIdSet = new Set(assetIds);
      return entryAssetIds.size === assetIdSet.size && [...entryAssetIds].every((id) => assetIdSet.has(id))
        ? null
        : 'Every finding must name one of the selected items';
    }
    default: {
      return null;
    }
  }
};

/**
 * The row's `label`. The web client shows its own translated action name for a bulk job; this is
 * what every other reader of the row — an API client, a log line — gets instead.
 */
export const bulkOperationLabel = (action: MediaOperationBulkAction, count: number): string =>
  `${action.replaceAll('-', ' ')} (${count} ${count === 1 ? 'item' : 'items'})`;

/** A per-id answer from an album or tag endpoint, as an outcome. */
export const fromBulkIdResponse = (response: {
  id: string;
  success: boolean;
  error?: string;
  errorMessage?: string;
}): BulkOperationItem => {
  if (response.success) {
    return { id: response.id, status: MediaOperationItemStatus.Ok };
  }

  switch (response.error) {
    // Already in the album, already gone from it, or not ours: nothing changed and nothing will.
    case 'duplicate':
    case 'not_found':
    case 'no_permission': {
      return {
        id: response.id,
        status: MediaOperationItemStatus.Skipped,
        reasonKey: `frameleaf_bulk_reason_${response.error}`,
        message: response.errorMessage,
      };
    }
    default: {
      return {
        id: response.id,
        status: MediaOperationItemStatus.Failed,
        reasonKey: `frameleaf_bulk_reason_${response.error ?? 'failed'}`,
        message: response.errorMessage,
      };
    }
  }
};

/** Progress as a percentage of answered items. */
export const bulkProgress = (processed: number, requested: number): number =>
  requested > 0 ? Math.min(100, Math.max(0, Math.round((processed / requested) * 10_000) / 100)) : 0;
