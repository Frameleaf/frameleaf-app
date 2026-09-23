import {
  addAssetsToAlbum,
  AssetImageEnrichmentAction,
  AssetJobName,
  AssetVisibility,
  bulkTagAssets,
  createBulkMediaOperation,
  createSharedLink,
  createStack,
  deleteAssets,
  deleteStacks,
  MediaOperationBulkAction,
  removeAssetFromAlbum,
  removeSharedLinkAssets,
  restoreAssets,
  runAssetJobs,
  searchAssetStatistics,
  searchAssets,
  searchSmart,
  SharedLinkType,
  untagAssets,
  updateAlbumInfo,
  updateAsset,
  updateAssetImageEnrichment,
  updateAssets,
  upsertTags,
  type BulkIdResponseDto,
  type MediaOperationBulkPayloadDto,
  type MediaOperationDto,
  type MetadataSearchDto,
  type SearchFilter,
  type SmartSearchDto,
} from '@immich/sdk';
import type { BulkActionId } from '$lib/frameleaf/bulk-actions';
import type { LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * Execution of the Frameleaf selection bar's bulk actions (FL-32).
 *
 * Every action here binds to an endpoint that already exists and is access checked on the server:
 * nothing in this module invents a route. Three rules from the September 22, 2026 revision and the
 * story's acceptance criteria shape it:
 *
 * - Partial failures report per item. Endpoints that answer per id (album membership, shared link
 *   membership) are mapped straight through; for the id-list endpoints a failing chunk is retried
 *   one item at a time so the report names the items that actually failed rather than the batch.
 * - A "select everything matching" selection is scope-bound. The matching set is resolved from the
 *   view state frozen at submit, so a later filter edit cannot change a running operation.
 * - Long operations run in the background with progress and cancellation. Cancellation stops
 *   between batches; work already acknowledged by the server is reported as done, never undone
 *   implicitly.
 *
 * Marking sensitive is metadata only. It never moves an asset and never touches album membership,
 * and it does not use the upstream move-to-Locked visibility action.
 */

/** Ids sent per request to the list endpoints. */
export const BULK_CHUNK_SIZE = 500;
/** Parallel requests for the endpoints that only take one asset at a time. */
export const BULK_ITEM_CONCURRENCY = 5;
/** Results per page while resolving a matching set. */
export const SNAPSHOT_PAGE_SIZE = 250;
/** Upper bound on a resolved matching set, so a runaway scope cannot exhaust the client. */
export const SNAPSHOT_MAX_ITEMS = 50_000;

export type BulkOutcomeStatus = 'ok' | 'skipped' | 'failed';

export type BulkOutcome = {
  id: string;
  status: BulkOutcomeStatus;
  /** i18n key describing why an item was skipped or failed. */
  reasonKey?: string;
  /** The server's message, kept for the details list. */
  message?: string;
};

export type BulkUndo = {
  action: BulkActionId;
  ids: string[];
  payload?: BulkPayload;
};

export type BulkResult = {
  action: BulkActionId;
  requested: number;
  outcomes: BulkOutcome[];
  succeeded: string[];
  failed: BulkOutcome[];
  skipped: BulkOutcome[];
  /** True when the caller cancelled before every item was attempted. */
  cancelled: boolean;
  /** Present when the action can be reversed; trash reverses through restore. */
  undo?: BulkUndo;
};

export type BulkPayload = {
  albumId?: string;
  sharedLinkId?: string;
  tagIds?: string[];
  newTagNames?: string[];
  /** 'set' writes the same instant to every item; 'shift' moves each item by `minutes`. */
  dateMode?: 'set' | 'shift';
  dateTimeOriginal?: string;
  timeZone?: string;
  minutes?: number;
  description?: string;
  latitude?: number;
  longitude?: number;
  primaryId?: string;
  stackIds?: string[];
  photoId?: string;
  videoId?: string;
  fileName?: string;
  force?: boolean;
};

export type BulkProgress = {
  /** Items the server has answered for. */
  processed: number;
  /** Items in the operation, or null while a matching set is still being resolved. */
  total: number | null;
  phase: 'resolving' | 'running';
};

export type BulkRunContext = {
  /** The authenticated user. Assets owned by anyone else are skipped, never attempted. */
  currentUserId?: string;
  /** Owners of the selected assets, when the caller has them loaded. */
  ownerById?: Record<string, string>;
};

export type BulkRunOptions = {
  payload?: BulkPayload;
  context?: BulkRunContext;
  signal?: AbortSignal;
  onProgress?: (progress: BulkProgress) => void;
  gateway?: BulkGateway;
};

/**
 * The endpoints this module is allowed to call. Injecting them keeps the unit tests honest about
 * which endpoint each action uses and makes an unbound action a compile error rather than a stub.
 */
export type BulkGateway = {
  updateAssets: typeof updateAssets;
  updateAsset: typeof updateAsset;
  updateAssetImageEnrichment: typeof updateAssetImageEnrichment;
  addAssetsToAlbum: typeof addAssetsToAlbum;
  removeAssetFromAlbum: typeof removeAssetFromAlbum;
  updateAlbumInfo: typeof updateAlbumInfo;
  deleteAssets: typeof deleteAssets;
  restoreAssets: typeof restoreAssets;
  createStack: typeof createStack;
  deleteStacks: typeof deleteStacks;
  bulkTagAssets: typeof bulkTagAssets;
  untagAssets: typeof untagAssets;
  upsertTags: typeof upsertTags;
  runAssetJobs: typeof runAssetJobs;
  createSharedLink: typeof createSharedLink;
  removeSharedLinkAssets: typeof removeSharedLinkAssets;
  searchAssets: typeof searchAssets;
  searchSmart: typeof searchSmart;
  searchAssetStatistics: typeof searchAssetStatistics;
  /** Queues a durable server-side bulk operation (FL-32). */
  createBulkMediaOperation: typeof createBulkMediaOperation;
  /** The web client's archive download flow, which already handles splitting and the manager. */
  downloadArchive: (fileName: string, options: { assetIds: string[] }) => Promise<unknown>;
};

/** The production bindings. `downloadArchive` is injected by the caller to avoid a cyclic import. */
export const createBulkGateway = (
  downloadArchive: BulkGateway['downloadArchive'],
): BulkGateway => ({
  updateAssets,
  updateAsset,
  updateAssetImageEnrichment,
  addAssetsToAlbum,
  removeAssetFromAlbum,
  updateAlbumInfo,
  deleteAssets,
  restoreAssets,
  createStack,
  deleteStacks,
  bulkTagAssets,
  untagAssets,
  upsertTags,
  runAssetJobs,
  createSharedLink,
  removeSharedLinkAssets,
  searchAssets,
  searchSmart,
  searchAssetStatistics,
  createBulkMediaOperation,
  downloadArchive,
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const distinct = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => typeof id === 'string' && id))];

export const chunk = <T>(items: readonly T[], size = BULK_CHUNK_SIZE): T[][] => {
  const width = Number.isInteger(size) && size > 0 ? size : BULK_CHUNK_SIZE;
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += width) {
    result.push(items.slice(index, index + width));
  }
  return result;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

const ok = (id: string): BulkOutcome => ({ id, status: 'ok' });
const failed = (id: string, error: unknown): BulkOutcome => ({
  id,
  status: 'failed',
  reasonKey: 'frameleaf_bulk_reason_failed',
  message: errorMessage(error),
});
const skipped = (id: string, reasonKey: string): BulkOutcome => ({ id, status: 'skipped', reasonKey });

const isOutcomeList = (value: unknown): value is BulkOutcome[] =>
  Array.isArray(value) && value.every((item) => !!item && typeof item === 'object' && 'status' in item);

/** Map an endpoint that answers per id straight onto outcomes. */
const fromBulkIdResponses = (responses: readonly BulkIdResponseDto[]): BulkOutcome[] =>
  responses.map((response) =>
    response.success
      ? ok(response.id)
      : {
          id: response.id,
          status: 'failed' as const,
          reasonKey: `frameleaf_bulk_reason_${String(response.error ?? 'failed').replaceAll('-', '_')}`,
          message: response.errorMessage,
        },
  );

const summarize = (
  action: BulkActionId,
  requested: number,
  outcomes: BulkOutcome[],
  cancelled: boolean,
): BulkResult => ({
  action,
  requested,
  outcomes,
  succeeded: outcomes.filter((outcome) => outcome.status === 'ok').map((outcome) => outcome.id),
  failed: outcomes.filter((outcome) => outcome.status === 'failed'),
  skipped: outcomes.filter((outcome) => outcome.status === 'skipped'),
  cancelled,
});

type Runner = {
  ids: string[];
  signal?: AbortSignal;
  onProgress?: (processed: number) => void;
};

/**
 * Send ids in batches. A batch that fails as a whole is retried one item at a time so the report
 * names the items that actually failed; every endpoint used here is idempotent for that retry.
 */
const runInChunks = async (
  { ids, signal, onProgress }: Runner,
  send: (batch: string[]) => Promise<unknown>,
  size = BULK_CHUNK_SIZE,
): Promise<{ outcomes: BulkOutcome[]; cancelled: boolean }> => {
  const outcomes: BulkOutcome[] = [];
  let processed = 0;
  for (const batch of chunk(ids, size)) {
    if (signal?.aborted) {
      return { outcomes, cancelled: true };
    }
    try {
      const answered = await send(batch);
      outcomes.push(...(isOutcomeList(answered) ? answered : batch.map((id) => ok(id))));
    } catch (error) {
      if (signal?.aborted) {
        return { outcomes, cancelled: true };
      }
      if (batch.length === 1) {
        outcomes.push(failed(batch[0], error));
      } else {
        // Isolate the failures rather than condemning the whole batch.
        for (const id of batch) {
          if (signal?.aborted) {
            return { outcomes, cancelled: true };
          }
          try {
            const answered = await send([id]);
            outcomes.push(...(isOutcomeList(answered) ? answered : [ok(id)]));
          } catch (itemError) {
            outcomes.push(failed(id, itemError));
          }
          processed += 1;
          onProgress?.(processed);
        }
        continue;
      }
    }
    processed += batch.length;
    onProgress?.(processed);
  }
  return { outcomes, cancelled: !!signal?.aborted };
};

/** Endpoints that take a single asset. Bounded concurrency, as the production NSFW action does. */
const runPerItem = async (
  { ids, signal, onProgress }: Runner,
  send: (id: string) => Promise<void>,
  concurrency = BULK_ITEM_CONCURRENCY,
): Promise<{ outcomes: BulkOutcome[]; cancelled: boolean }> => {
  const outcomes: BulkOutcome[] = [];
  let cursor = 0;
  let processed = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      if (signal?.aborted) {
        return;
      }
      const id = ids[cursor++];
      try {
        await send(id);
        outcomes.push(ok(id));
      } catch (error) {
        outcomes.push(signal?.aborted ? skipped(id, 'frameleaf_bulk_reason_cancelled') : failed(id, error));
      }
      processed += 1;
      onProgress?.(processed);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
  return { outcomes, cancelled: !!signal?.aborted };
};

/* -------------------------------------------------------------------------- */
/* Scope-bound matching sets                                                   */
/* -------------------------------------------------------------------------- */

export type SnapshotSearch =
  | { kind: 'metadata'; dto: MetadataSearchDto }
  | { kind: 'smart'; dto: SmartSearchDto }
  | { kind: 'unsupported'; reasonKey: string };

/**
 * Turn the frozen view state into a search the server can answer. The scope is applied on top of
 * the query's own filter, so an album scope stays an album scope even if the filter says nothing
 * about albums. A scope or query the search API cannot express is refused rather than widened:
 * running a bulk operation over a larger set than the user saw is the failure this story exists to
 * prevent.
 */
export const snapshotSearch = (state: LibraryViewState): SnapshotSearch => {
  const filter: SearchFilter = structuredClone(state.query.filter ?? {});
  if (state.scope.kind === 'album') {
    if (!state.scope.id) {
      return { kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_scope_unsupported' };
    }
    filter.albumIds = { any: [state.scope.id] };
  }
  if (state.scope.kind === 'space' || state.query.spaceId) {
    // Shared spaces are not expressible in the search DTO; the caller must select explicitly.
    return { kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_scope_unsupported' };
  }
  // Locked browsing depends on an elevated session and its own visibility handling; a matching set
  // is never guessed for it.
  const visibility = filter.visibility;
  if (
    visibility &&
    [visibility.eq, visibility.ne, ...(visibility.in ?? []), ...(visibility.notIn ?? [])].includes(
      AssetVisibility.Locked,
    )
  ) {
    return { kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_scope_unsupported' };
  }
  if (!visibility) {
    // The search API's own default is everything that is not locked, which is wider than a library
    // view shows. A view that wants archived items says so in its filter; this one does not.
    filter.visibility = { eq: AssetVisibility.Timeline };
  }
  const text = state.query.text?.trim() ?? '';
  if (text && state.query.mode !== 'smart') {
    // Filename, description, OCR and path search are separate fields server side; collapsing them
    // into one term here would change the matching set.
    return { kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_text_query_unsupported' };
  }
  // The trash destination filters on `trashedAt`, and trashed assets are excluded by default.
  const withDeleted = filter.trashedAt ? { withDeleted: true } : {};
  if (text) {
    return { kind: 'smart', dto: { query: text, filter, size: SNAPSHOT_PAGE_SIZE, ...withDeleted } };
  }
  return { kind: 'metadata', dto: { filter, size: SNAPSHOT_PAGE_SIZE, ...withDeleted } };
};

/** The count the "Select all n" control offers, taken from the same frozen state. */
export const countMatching = async (
  state: LibraryViewState,
  gateway: Pick<BulkGateway, 'searchAssetStatistics'>,
): Promise<number | null> => {
  const search = snapshotSearch(state);
  if (search.kind !== 'metadata') {
    // Statistics take a metadata search only. A smart query and an unsupported scope report their
    // total with the first page of results instead, or not at all.
    return null;
  }
  const { total } = await gateway.searchAssetStatistics({
    statisticsSearchDto: { filter: search.dto.filter },
  });
  return total;
};

export type ResolvedSnapshot = {
  ids: string[];
  /** The total the server reported for the frozen state. */
  total: number | null;
  /** True when the matching set was larger than `SNAPSHOT_MAX_ITEMS` and was cut short. */
  truncated: boolean;
  cancelled: boolean;
};

/**
 * Page through the frozen state and collect the matching ids. The search endpoints are the
 * authenticated ones, so the result never crosses an ownership boundary the user cannot see; the
 * per-item permission check still happens again when the action runs.
 */
export const resolveMatchingIds = async (
  state: LibraryViewState,
  {
    gateway,
    signal,
    onProgress,
    limit = SNAPSHOT_MAX_ITEMS,
  }: {
    gateway: Pick<BulkGateway, 'searchAssets' | 'searchSmart'>;
    signal?: AbortSignal;
    onProgress?: (found: number, total: number | null) => void;
    limit?: number;
  },
): Promise<ResolvedSnapshot> => {
  const search = snapshotSearch(state);
  if (search.kind === 'unsupported') {
    throw new Error(search.reasonKey);
  }
  const found = new Set<string>();
  let total: number | null = null;
  let page: number | null = 1;
  while (page) {
    if (signal?.aborted) {
      return { ids: [...found], total, truncated: false, cancelled: true };
    }
    const { assets } =
      search.kind === 'smart'
        ? await gateway.searchSmart({ smartSearchDto: { ...search.dto, page } })
        : await gateway.searchAssets({ metadataSearchDto: { ...search.dto, page } });
    total = typeof assets.total === 'number' ? assets.total : total;
    for (const asset of assets.items) {
      if (found.size >= limit) {
        return { ids: [...found], total, truncated: true, cancelled: false };
      }
      found.add(asset.id);
    }
    onProgress?.(found.size, total);
    page = Number(assets.nextPage) || null;
  }
  return { ids: [...found], total, truncated: false, cancelled: false };
};

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

const requirePayload = <K extends keyof BulkPayload>(
  payload: BulkPayload | undefined,
  key: K,
): NonNullable<BulkPayload[K]> => {
  const value = payload?.[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing ${String(key)} for this action`);
  }
  return value as NonNullable<BulkPayload[K]>;
};

/** Tag names the user typed are created first, then every id is applied in one call. */
const resolveTagIds = async (payload: BulkPayload | undefined, gateway: BulkGateway): Promise<string[]> => {
  const existing = payload?.tagIds ?? [];
  const names = (payload?.newTagNames ?? []).map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) {
    return distinct(existing);
  }
  const created = await gateway.upsertTags({ tagUpsertDto: { tags: names } });
  return distinct([...existing, ...created.map((tag) => tag.id)]);
};

/**
 * Run one bulk action over an explicit id list.
 *
 * Every branch below names the endpoint it uses. Items owned by someone else are skipped before
 * anything is sent; the server checks again per item and its answer wins.
 */
export const runBulkAction = async (
  action: BulkActionId,
  requestedIds: readonly string[],
  { payload, context, signal, onProgress, gateway }: BulkRunOptions & { gateway: BulkGateway },
): Promise<BulkResult> => {
  const all = distinct(requestedIds);
  const outcomes: BulkOutcome[] = [];
  const ids: string[] = [];
  for (const id of all) {
    const owner = context?.ownerById?.[id];
    if (context?.currentUserId && owner && owner !== context.currentUserId && action !== 'download') {
      outcomes.push(skipped(id, 'frameleaf_bulk_reason_not_owner'));
      continue;
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    return summarize(action, all.length, outcomes, false);
  }
  const report = (processed: number) => onProgress?.({ processed, total: all.length, phase: 'running' });
  const runner: Runner = { ids, signal, onProgress: report };

  const finish = (
    result: { outcomes: BulkOutcome[]; cancelled: boolean },
    undo?: (succeeded: string[]) => BulkUndo | undefined,
  ): BulkResult => {
    const merged = summarize(action, all.length, [...outcomes, ...result.outcomes], result.cancelled);
    const entry = merged.succeeded.length > 0 ? undo?.(merged.succeeded) : undefined;
    return entry ? { ...merged, undo: entry } : merged;
  };

  switch (action) {
    /* PUT /assets — the bulk update endpoint. */
    case 'favorite':
    case 'unfavorite': {
      const isFavorite = action === 'favorite';
      return finish(
        await runInChunks(runner, (batch) => gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, isFavorite } })),
        (succeeded) => ({ action: isFavorite ? 'unfavorite' : 'favorite', ids: succeeded }),
      );
    }
    case 'archive':
    case 'unarchive': {
      const visibility = action === 'archive' ? AssetVisibility.Archive : AssetVisibility.Timeline;
      return finish(
        await runInChunks(runner, (batch) => gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, visibility } })),
        (succeeded) => ({ action: action === 'archive' ? 'unarchive' : 'archive', ids: succeeded }),
      );
    }
    case 'change-date': {
      const mode = payload?.dateMode ?? 'set';
      const dto =
        mode === 'shift'
          ? { dateTimeRelative: Number(requirePayload(payload, 'minutes')) }
          : {
              dateTimeOriginal: String(requirePayload(payload, 'dateTimeOriginal')),
              ...(payload?.timeZone ? { timeZone: payload.timeZone } : {}),
            };
      return finish(
        await runInChunks(runner, (batch) => gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, ...dto } })),
      );
    }
    case 'change-description': {
      const description = payload?.description ?? '';
      return finish(
        await runInChunks(runner, (batch) => gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, description } })),
      );
    }
    case 'change-location': {
      const latitude = Number(requirePayload(payload, 'latitude'));
      const longitude = Number(requirePayload(payload, 'longitude'));
      return finish(
        await runInChunks(runner, (batch) =>
          gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, latitude, longitude } }),
        ),
      );
    }

    /* PUT /albums/:id/assets and DELETE /albums/:id/assets — both answer per id. */
    case 'add-to-album': {
      const albumId = String(requirePayload(payload, 'albumId'));
      return finish(
        await runInChunks(runner, async (batch) =>
          fromBulkIdResponses(await gateway.addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: batch } })),
        ),
        (succeeded) => ({ action: 'remove-from-album', ids: succeeded, payload: { albumId } }),
      );
    }
    case 'remove-from-album': {
      const albumId = String(requirePayload(payload, 'albumId'));
      return finish(
        await runInChunks(runner, async (batch) =>
          fromBulkIdResponses(await gateway.removeAssetFromAlbum({ id: albumId, bulkIdsDto: { ids: batch } })),
        ),
        (succeeded) => ({ action: 'add-to-album', ids: succeeded, payload: { albumId } }),
      );
    }
    case 'set-album-cover': {
      const albumId = String(requirePayload(payload, 'albumId'));
      const [assetId] = ids;
      try {
        await gateway.updateAlbumInfo({ id: albumId, updateAlbumDto: { albumThumbnailAssetId: assetId } });
        return finish({ outcomes: [ok(assetId)], cancelled: false });
      } catch (error) {
        return finish({ outcomes: [failed(assetId, error)], cancelled: false });
      }
    }

    /* DELETE /assets and POST /trash/restore/assets — trash undoes through restore. */
    case 'delete':
    case 'delete-permanently': {
      const force = action === 'delete-permanently';
      return finish(
        await runInChunks(runner, (batch) => gateway.deleteAssets({ assetBulkDeleteDto: { ids: batch, force } })),
        (succeeded) => (force ? undefined : { action: 'restore', ids: succeeded }),
      );
    }
    case 'restore': {
      return finish(await runInChunks(runner, (batch) => gateway.restoreAssets({ bulkIdsDto: { ids: batch } })));
    }

    /* POST /stacks and DELETE /stacks — one stack per call, so no chunking. */
    case 'stack': {
      const primaryId = payload?.primaryId && ids.includes(payload.primaryId) ? payload.primaryId : ids[0];
      const ordered = [primaryId, ...ids.filter((id) => id !== primaryId)];
      if (ordered.length < 2) {
        const reason = skipped(ordered[0], 'frameleaf_bulk_reason_needs_two');
        return summarize(action, all.length, [...outcomes, reason], false);
      }
      try {
        const stack = await gateway.createStack({ stackCreateDto: { assetIds: ordered } });
        report(ordered.length);
        return finish({ outcomes: ordered.map((id) => ok(id)), cancelled: false }, (succeeded) => ({
          action: 'unstack',
          ids: succeeded,
          payload: { stackIds: [stack.id] },
        }));
      } catch (error) {
        return finish({ outcomes: ordered.map((id) => failed(id, error)), cancelled: false });
      }
    }
    case 'unstack': {
      const stackIds = distinct(payload?.stackIds ?? []);
      if (stackIds.length === 0) {
        const reasons = ids.map((id) => skipped(id, 'frameleaf_bulk_reason_not_stacked'));
        return summarize(action, all.length, [...outcomes, ...reasons], false);
      }
      try {
        await gateway.deleteStacks({ bulkIdsDto: { ids: stackIds } });
        report(ids.length);
        return finish({ outcomes: ids.map((id) => ok(id)), cancelled: false });
      } catch (error) {
        return finish({ outcomes: ids.map((id) => failed(id, error)), cancelled: false });
      }
    }

    /* PUT /assets — the Locked folder is a visibility, exactly as the legacy action set it. */
    case 'move-to-locked':
    case 'remove-from-locked': {
      const visibility = action === 'move-to-locked' ? AssetVisibility.Locked : AssetVisibility.Timeline;
      return finish(
        await runInChunks(runner, (batch) => gateway.updateAssets({ assetBulkUpdateDto: { ids: batch, visibility } })),
      );
    }

    /* PUT /assets/:id — the Live Photo link lives on the still, one asset at a time. */
    case 'link-live-photo': {
      const photoId = String(requirePayload(payload, 'photoId'));
      const videoId = String(requirePayload(payload, 'videoId'));
      try {
        await gateway.updateAsset({ id: photoId, updateAssetDto: { livePhotoVideoId: videoId } });
        report(1);
        return finish({ outcomes: [ok(photoId)], cancelled: false }, () => ({
          action: 'unlink-live-photo',
          ids: [photoId],
        }));
      } catch (error) {
        return finish({ outcomes: [failed(photoId, error)], cancelled: false });
      }
    }
    case 'unlink-live-photo': {
      return finish(
        await runPerItem(runner, async (id) => {
          await gateway.updateAsset({ id, updateAssetDto: { livePhotoVideoId: null } });
        }),
      );
    }

    /* PUT /assets/:id/image-enrichment — metadata only; album membership is untouched. */
    case 'mark-sensitive':
    case 'unmark-sensitive': {
      const enrichment =
        action === 'mark-sensitive' ? AssetImageEnrichmentAction.MarkNsfw : AssetImageEnrichmentAction.MarkSafe;
      return finish(
        await runPerItem(runner, async (id) => {
          await gateway.updateAssetImageEnrichment({
            id,
            assetImageEnrichmentActionRequestDto: { action: enrichment },
          });
        }),
        (succeeded) => ({
          action: action === 'mark-sensitive' ? 'unmark-sensitive' : 'mark-sensitive',
          ids: succeeded,
        }),
      );
    }

    /* PUT /tags/assets and DELETE /tags/:id/assets. */
    case 'tag': {
      const tagIds = await resolveTagIds(payload, gateway);
      if (tagIds.length === 0) {
        throw new Error('Missing tagIds for this action');
      }
      return finish(
        await runInChunks(runner, async (batch) => {
          await gateway.bulkTagAssets({ tagBulkAssetsDto: { assetIds: batch, tagIds } });
        }),
        (succeeded) => ({ action: 'untag', ids: succeeded, payload: { tagIds } }),
      );
    }
    case 'untag': {
      const tagIds = distinct(payload?.tagIds ?? []);
      if (tagIds.length === 0) {
        throw new Error('Missing tagIds for this action');
      }
      return finish(
        await runInChunks(runner, async (batch) => {
          for (const tagId of tagIds) {
            await gateway.untagAssets({ id: tagId, bulkIdsDto: { ids: batch } });
          }
        }),
      );
    }

    /* POST /jobs on the asset job endpoint. */
    case 'refresh-thumbnails':
    case 'refresh-metadata':
    case 'refresh-encoded':
    case 'refresh-faces': {
      const name = {
        'refresh-thumbnails': AssetJobName.RegenerateThumbnail,
        'refresh-metadata': AssetJobName.RefreshMetadata,
        'refresh-encoded': AssetJobName.TranscodeVideo,
        'refresh-faces': AssetJobName.RefreshFaces,
      }[action];
      return finish(
        await runInChunks(runner, (batch) => gateway.runAssetJobs({ assetJobsDto: { assetIds: batch, name } })),
      );
    }

    /* POST /shared-links and DELETE /shared-links/:id/assets. */
    case 'create-shared-link': {
      try {
        await gateway.createSharedLink({
          sharedLinkCreateDto: { type: SharedLinkType.Individual, assetIds: ids },
        });
        report(ids.length);
        return finish({ outcomes: ids.map((id) => ok(id)), cancelled: false });
      } catch (error) {
        return finish({ outcomes: ids.map((id) => failed(id, error)), cancelled: false });
      }
    }
    case 'remove-from-shared-link': {
      const sharedLinkId = String(requirePayload(payload, 'sharedLinkId'));
      return finish(
        await runInChunks(runner, async (batch) => {
          const responses = await gateway.removeSharedLinkAssets({
            id: sharedLinkId,
            assetIdsDto: { assetIds: batch },
          });
          return responses.map((response) =>
            response.success
              ? ok(response.assetId)
              : {
                  id: response.assetId,
                  status: 'failed' as const,
                  reasonKey: `frameleaf_bulk_reason_${String(response.error ?? 'failed').replaceAll('-', '_')}`,
                },
          );
        }),
      );
    }

    /* POST /download/info and /download/archive, through the web client's download manager. */
    case 'download': {
      try {
        await gateway.downloadArchive(payload?.fileName ?? 'frameleaf', { assetIds: ids });
        report(ids.length);
        return finish({ outcomes: ids.map((id) => ok(id)), cancelled: false });
      } catch (error) {
        return finish({ outcomes: ids.map((id) => failed(id, error)), cancelled: false });
      }
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Background operations over a scope-bound snapshot                           */
/* -------------------------------------------------------------------------- */

export type BulkOperationRequest = {
  /** Stable request key; a retry reuses it so the durable record stays one operation. */
  requestId: string;
  action: BulkActionId;
  /** The view state frozen at submit. Later filter edits cannot reach it. */
  scope: LibraryViewState;
  payload?: BulkPayload;
  /** The count shown next to "Select all n" when the user submitted. */
  submittedTotal: number | null;
};

export type BulkOperationOutcome = BulkResult & {
  requestId: string;
  /** The matching set the operation resolved, for a retry of the failed items. */
  resolvedTotal: number | null;
  truncated: boolean;
};

/**
 * Run a select-everything-matching operation in the background: resolve the frozen scope, then
 * apply the action with progress and cancellation. The snapshot is taken once; if the live session
 * has moved on the operation is unaffected, which is the whole point of freezing it.
 */
export const runBulkOperation = async (
  request: BulkOperationRequest,
  { gateway, signal, onProgress, context }: { gateway: BulkGateway } & Omit<BulkRunOptions, 'gateway' | 'payload'>,
): Promise<BulkOperationOutcome> => {
  onProgress?.({ processed: 0, total: request.submittedTotal, phase: 'resolving' });
  const snapshot = await resolveMatchingIds(request.scope, {
    gateway,
    signal,
    onProgress: (found, total) =>
      onProgress?.({ processed: found, total: total ?? request.submittedTotal, phase: 'resolving' }),
  });
  if (snapshot.cancelled) {
    return {
      ...summarize(request.action, snapshot.ids.length, [], true),
      requestId: request.requestId,
      resolvedTotal: snapshot.total,
      truncated: snapshot.truncated,
    };
  }
  const result = await runBulkAction(request.action, snapshot.ids, {
    payload: request.payload,
    context,
    signal,
    onProgress,
    gateway,
  });
  return {
    ...result,
    requestId: request.requestId,
    resolvedTotal: snapshot.total,
    truncated: snapshot.truncated,
  };
};

/** The i18n key and values for the result toast, including the partial-failure wording. */
export const bulkResultSummary = (
  result: BulkResult,
): { key: string; values: { count: number; failed: number; skipped: number; total: number } } => {
  const values = {
    count: result.succeeded.length,
    failed: result.failed.length,
    skipped: result.skipped.length,
    total: result.requested,
  };
  if (result.cancelled) {
    return { key: 'frameleaf_bulk_summary_cancelled', values };
  }
  if (result.failed.length === 0 && result.skipped.length === 0) {
    return { key: 'frameleaf_bulk_summary_done', values };
  }
  if (result.succeeded.length === 0) {
    return { key: 'frameleaf_bulk_summary_none', values };
  }
  return { key: 'frameleaf_bulk_summary_partial', values };
};

/* -------------------------------------------------------------------------- */
/* Durable operations                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Above this many items an explicit selection is handed to the server as a durable job instead of
 * being run from this tab. At or below it the action runs immediately and offers undo, which is
 * what a person expects from a handful of photos. "Select everything matching" is always durable.
 */
export const DURABLE_BULK_THRESHOLD = 500;

/** The largest frozen set one durable job accepts; a larger selection is split into several. */
export const DURABLE_BULK_MAX_ITEMS = 50_000;

/**
 * The actions the server runs durably, and their server name.
 *
 * Anything missing stays in this tab by design: a download or a shared link only makes sense to
 * the person waiting for it, and moves into or out of the Locked folder are confirmed in the
 * unlocked session the person is looking at.
 */
export const DURABLE_BULK_ACTIONS: Readonly<Partial<Record<BulkActionId, MediaOperationBulkAction>>> = {
  favorite: MediaOperationBulkAction.Favorite,
  unfavorite: MediaOperationBulkAction.Unfavorite,
  archive: MediaOperationBulkAction.Archive,
  unarchive: MediaOperationBulkAction.Unarchive,
  'add-to-album': MediaOperationBulkAction.AddToAlbum,
  'remove-from-album': MediaOperationBulkAction.RemoveFromAlbum,
  tag: MediaOperationBulkAction.Tag,
  untag: MediaOperationBulkAction.Untag,
  'change-date': MediaOperationBulkAction.ChangeDate,
  'change-description': MediaOperationBulkAction.ChangeDescription,
  'change-location': MediaOperationBulkAction.ChangeLocation,
  'mark-sensitive': MediaOperationBulkAction.MarkSensitive,
  'unmark-sensitive': MediaOperationBulkAction.UnmarkSensitive,
  delete: MediaOperationBulkAction.Delete,
  'delete-permanently': MediaOperationBulkAction.DeletePermanently,
  restore: MediaOperationBulkAction.Restore,
  'refresh-thumbnails': MediaOperationBulkAction.RefreshThumbnails,
  'refresh-metadata': MediaOperationBulkAction.RefreshMetadata,
  'refresh-encoded': MediaOperationBulkAction.RefreshEncoded,
  'refresh-faces': MediaOperationBulkAction.RefreshFaces,
};

export const durableBulkAction = (action: BulkActionId): MediaOperationBulkAction | null =>
  DURABLE_BULK_ACTIONS[action] ?? null;

/** Whether an explicit selection of this size goes to the server as a durable job. */
export const shouldRunDurably = (action: BulkActionId, count: number): boolean =>
  !!durableBulkAction(action) && count > DURABLE_BULK_THRESHOLD;

/** The server's payload for an action. Only the fields it knows are sent; nothing is defaulted. */
export const toDurablePayload = (payload: BulkPayload | undefined, tagIds?: string[]): MediaOperationBulkPayloadDto => {
  const source = payload ?? {};
  const result: MediaOperationBulkPayloadDto = {};
  if (source.albumId) {
    result.albumId = source.albumId;
  }
  if (tagIds && tagIds.length > 0) {
    result.tagIds = tagIds;
  }
  if (source.dateMode) {
    result.dateMode = source.dateMode as MediaOperationBulkPayloadDto['dateMode'];
  }
  if (source.dateTimeOriginal) {
    result.dateTimeOriginal = source.dateTimeOriginal;
  }
  if (source.timeZone) {
    result.timeZone = source.timeZone;
  }
  if (typeof source.minutes === 'number') {
    result.minutes = source.minutes;
  }
  if (typeof source.description === 'string') {
    result.description = source.description;
  }
  if (typeof source.latitude === 'number') {
    result.latitude = source.latitude;
  }
  if (typeof source.longitude === 'number') {
    result.longitude = source.longitude;
  }
  if (source.primaryId) {
    result.primaryId = source.primaryId;
  }
  if (source.stackIds && source.stackIds.length > 0) {
    result.stackIds = source.stackIds;
  }
  return result;
};

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

export type DurableBulkRequest = {
  payload?: BulkPayload;
  /** The count the person saw when they submitted, for the audit trail. */
  submittedTotal?: number | null;
  /** The matching set was cut short by the client's own bound. */
  truncated?: boolean;
  /** The view the set came from. Recorded, never re-resolved. */
  scope?: LibraryViewState;
  /** Idempotency key. Sent only when it is a v4 uuid, which is what the server accepts. */
  requestId?: string;
};

/**
 * Hand a frozen set to the server as one or more durable jobs.
 *
 * The ids are the whole contract: the server applies the action to exactly these, checking access
 * on each as it goes, and nothing about the view they came from is resolved again. A set larger
 * than one job accepts is split in order; only the first part carries the idempotency key, so a
 * repeated submit cannot quietly queue the tail twice.
 */
export const submitDurableBulk = async (
  action: BulkActionId,
  requestedIds: readonly string[],
  request: DurableBulkRequest,
  gateway: Pick<BulkGateway, 'createBulkMediaOperation' | 'upsertTags'>,
): Promise<MediaOperationDto[]> => {
  const serverAction = durableBulkAction(action);
  if (!serverAction) {
    throw new Error('frameleaf_bulk_reason_not_durable');
  }
  const ids = distinct(requestedIds);
  if (ids.length === 0) {
    return [];
  }
  const tagIds =
    action === 'tag' || action === 'untag' ? await resolveTagIds(request.payload, gateway as BulkGateway) : undefined;
  const payload = toDurablePayload(request.payload, tagIds);
  const requestId = request.requestId && UUID_V4.test(request.requestId) ? request.requestId : undefined;

  const created: MediaOperationDto[] = [];
  for (const [index, part] of chunk(ids, DURABLE_BULK_MAX_ITEMS).entries()) {
    created.push(
      await gateway.createBulkMediaOperation({
        mediaOperationBulkCreateDto: {
          action: serverAction,
          assetIds: part,
          payload,
          ...(index === 0 && requestId ? { requestId } : {}),
          submittedTotal: request.submittedTotal ?? null,
          truncated: request.truncated ?? false,
          ...(request.scope ? { scope: structuredClone(request.scope) as unknown as Record<string, unknown> } : {}),
        },
      }),
    );
  }
  return created;
};
