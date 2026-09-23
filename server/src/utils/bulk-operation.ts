import { AssetJobName } from 'src/dtos/asset.dto.js';
import { AssetVisibility, MediaOperationBulkAction, MediaOperationItemStatus, Permission } from 'src/enum.js';

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
  /** The client's idempotency key. A second submit with the same key answers with the first job. */
  requestId: string | null;
  /**
   * The API key the operation was submitted with, when it was. The runner checks the key still
   * exists and still grants the action before every batch, so revoking a key stops its jobs.
   */
  apiKeyId: string | null;
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
   * next claim finds this and knows exactly which items may or may not have been changed.
   */
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
  return Number.isInteger(start) && Number.isInteger(size) && start >= 0 && size > 0 ? { start, size } : null;
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

  // A batch that was in flight when the worker died may already have been applied. Running it
  // again is harmless for every action except a relative date shift, which would move those items
  // twice; for that one action the interrupted batch is left out rather than risked.
  if (result.inFlight && !isReplaySafe(snapshot)) {
    const { start, size } = result.inFlight;
    for (const id of snapshot.assetIds.slice(start, start + size)) {
      unreached.delete(id);
      retryable.delete(id);
    }
  }

  return snapshot.assetIds.filter((id) => retryable.has(id) || unreached.has(id));
};

/**
 * Whether applying the same batch twice leaves the library as applying it once would.
 *
 * True for everything this runner does except a relative date shift. The runner uses it to decide
 * what to do with a batch that was in flight when a worker died: replay it, or report it.
 */
export const isReplaySafe = (snapshot: Pick<BulkOperationSnapshot, 'action' | 'payload'>): boolean =>
  !(snapshot.action === MediaOperationBulkAction.ChangeDate && snapshot.payload.dateMode === 'shift');

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
  // Sensitive marking runs one item at a time and checks each one itself.
  [MediaOperationBulkAction.MarkSensitive]: null,
  [MediaOperationBulkAction.UnmarkSensitive]: null,
  [MediaOperationBulkAction.Delete]: Permission.AssetDelete,
  [MediaOperationBulkAction.DeletePermanently]: Permission.AssetDelete,
  [MediaOperationBulkAction.Restore]: Permission.AssetDelete,
  [MediaOperationBulkAction.Stack]: Permission.AssetUpdate,
  [MediaOperationBulkAction.Unstack]: null,
  [MediaOperationBulkAction.RefreshThumbnails]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshMetadata]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshEncoded]: Permission.AssetUpdate,
  [MediaOperationBulkAction.RefreshFaces]: Permission.AssetUpdate,
};

export const BULK_ASSET_JOBS: Readonly<Partial<Record<MediaOperationBulkAction, AssetJobName>>> = {
  [MediaOperationBulkAction.RefreshThumbnails]: AssetJobName.REGENERATE_THUMBNAIL,
  [MediaOperationBulkAction.RefreshMetadata]: AssetJobName.REFRESH_METADATA,
  [MediaOperationBulkAction.RefreshEncoded]: AssetJobName.TRANSCODE_VIDEO,
  [MediaOperationBulkAction.RefreshFaces]: AssetJobName.REFRESH_FACES,
};

/**
 * The fields of the bulk asset update an action writes, or null when it is not that kind of action.
 *
 * Deliberately no Locked visibility anywhere in here: moving into or out of the Locked folder needs
 * an elevated session, and a background worker neither has one nor may be given one.
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
      return payload.dateMode === 'shift'
        ? { dateTimeRelative: payload.minutes }
        : { dateTimeOriginal: payload.dateTimeOriginal, ...(payload.timeZone ? { timeZone: payload.timeZone } : {}) };
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
    case MediaOperationBulkAction.ChangeDate: {
      if (payload.dateMode === 'shift') {
        return Number.isInteger(payload.minutes) && payload.minutes !== 0
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
