import {
  AssetJobName,
  AssetVisibility,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationStatus,
  SharedLinkType,
} from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import {
  DURABLE_BULK_MAX_ITEMS,
  DURABLE_BULK_THRESHOLD,
  bulkResultSummary,
  countMatching,
  durableBulkAction,
  durableBulkParts,
  durableItemStates,
  removesFromView,
  resolveMatchingIds,
  runBulkAction,
  runBulkOperation,
  shouldRunDurably,
  snapshotSearch,
  submitDurableBulk,
  toDurablePayload,
  type BulkGateway,
} from '$lib/frameleaf/bulk-operations';
import { createLibrarySession, type LibraryViewState } from '$lib/frameleaf/library-session';

const gateway = () =>
  ({
    updateAssets: vi.fn().mockResolvedValue(undefined),
    updateAsset: vi.fn().mockResolvedValue(undefined),
    updateAssetImageEnrichment: vi.fn().mockResolvedValue(undefined),
    lockAssets: vi.fn().mockResolvedValue(undefined),
    unlockAssets: vi.fn().mockResolvedValue(undefined),
    addAssetsToAlbum: vi.fn(),
    removeAssetFromAlbum: vi.fn(),
    updateAlbumInfo: vi.fn().mockResolvedValue(undefined),
    deleteAssets: vi.fn().mockResolvedValue(undefined),
    restoreAssets: vi.fn().mockResolvedValue(undefined),
    createStack: vi.fn().mockResolvedValue({ id: 'stack-1' }),
    deleteStacks: vi.fn().mockResolvedValue(undefined),
    bulkTagAssets: vi.fn().mockResolvedValue({ count: 0 }),
    untagAssets: vi.fn().mockResolvedValue([]),
    upsertTags: vi.fn().mockResolvedValue([]),
    runAssetJobs: vi.fn().mockResolvedValue(undefined),
    createSharedLink: vi.fn().mockResolvedValue({ id: 'link-1' }),
    removeSharedLinkAssets: vi.fn(),
    searchAssets: vi.fn(),
    searchSmart: vi.fn(),
    searchAssetStatistics: vi.fn().mockResolvedValue({ total: 0 }),
    createBulkMediaOperation: vi.fn().mockImplementation(() => Promise.resolve({ id: 'job' })),
    downloadArchive: vi.fn().mockResolvedValue(undefined),
  }) as unknown as BulkGateway;

const viewState = (patch: Partial<LibraryViewState> = {}): LibraryViewState => ({
  ...createLibrarySession().state,
  ...patch,
});

const page = (ids: string[], nextPage: string | null, total = ids.length) => ({
  albums: { items: [], count: 0, total: 0, facets: [], nextPage: null, nextCursor: null },
  assets: { items: ids.map((id) => ({ id })), count: ids.length, total, facets: [], nextPage, nextCursor: null },
});

describe('bulk actions bind to existing endpoints', () => {
  let api: BulkGateway;

  beforeEach(() => {
    api = gateway();
  });

  it('favorites through the bulk update endpoint and offers the reverse as undo', async () => {
    const result = await runBulkAction('favorite', ['a', 'b'], { gateway: api });
    expect(api.updateAssets).toHaveBeenCalledWith({ assetBulkUpdateDto: { ids: ['a', 'b'], isFavorite: true } });
    expect(result.succeeded).toEqual(['a', 'b']);
    expect(result.undo).toEqual({ action: 'unfavorite', ids: ['a', 'b'] });
  });

  it('archives with the visibility field, never by moving the asset', async () => {
    await runBulkAction('archive', ['a'], { gateway: api });
    expect(api.updateAssets).toHaveBeenCalledWith({
      assetBulkUpdateDto: { ids: ['a'], visibility: AssetVisibility.Archive },
    });
  });


  it('marks sensitive as the lock record, never a visibility, album or enrichment change (FL-34)', async () => {
    const result = await runBulkAction('mark-sensitive', ['a', 'b'], { gateway: api });
    expect(api.lockAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['a', 'b'] } });
    expect(api.updateAssets).not.toHaveBeenCalled();
    expect(api.addAssetsToAlbum).not.toHaveBeenCalled();
    expect(api.removeAssetFromAlbum).not.toHaveBeenCalled();
    // undoing a mark would take the PIN, so it is not offered from here
    expect(result.undo).toBeUndefined();
  });

  it('unmarks sensitive by unlocking, and undoes it by marking again (FL-34)', async () => {
    const result = await runBulkAction('unmark-sensitive', ['a'], { gateway: api });
    expect(api.unlockAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['a'] } });
    expect(api.updateAssets).not.toHaveBeenCalled();
    expect(result.undo).toEqual({ action: 'mark-sensitive', ids: ['a'] });
  });

  it('trashes through delete and undoes through restore', async () => {
    const result = await runBulkAction('delete', ['a'], { gateway: api });
    expect(api.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['a'], force: false } });
    expect(result.undo).toEqual({ action: 'restore', ids: ['a'] });

    const permanent = await runBulkAction('delete-permanently', ['a'], { gateway: api });
    expect(api.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['a'], force: true } });
    expect(permanent.undo).toBeUndefined();
  });

  it('sets a date or shifts it, using the one bulk update endpoint for both', async () => {
    await runBulkAction('change-date', ['a'], {
      gateway: api,
      payload: { dateMode: 'set', dateTimeOriginal: '2026-09-22T07:14:00', timeZone: 'America/Edmonton' },
    });
    expect(api.updateAssets).toHaveBeenCalledWith({
      assetBulkUpdateDto: { ids: ['a'], dateTimeOriginal: '2026-09-22T07:14:00', timeZone: 'America/Edmonton' },
    });

    await runBulkAction('change-date', ['a'], { gateway: api, payload: { dateMode: 'shift', minutes: -120 } });
    expect(api.updateAssets).toHaveBeenLastCalledWith({ assetBulkUpdateDto: { ids: ['a'], dateTimeRelative: -120 } });
  });

  it('creates the tags the user typed before applying them', async () => {
    vi.mocked(api.upsertTags).mockResolvedValue([{ id: 'tag-new', name: 'Hikes' }] as never);
    const result = await runBulkAction('tag', ['a'], {
      gateway: api,
      payload: { tagIds: ['tag-1'], newTagNames: ['Hikes'] },
    });
    expect(api.upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['Hikes'] } });
    expect(api.bulkTagAssets).toHaveBeenCalledWith({
      tagBulkAssetsDto: { assetIds: ['a'], tagIds: ['tag-1', 'tag-new'] },
    });
    expect(result.undo).toEqual({ action: 'untag', ids: ['a'], payload: { tagIds: ['tag-1', 'tag-new'] } });
  });

  it('stacks with the chosen primary first and undoes by deleting the stack', async () => {
    const result = await runBulkAction('stack', ['a', 'b', 'c'], { gateway: api, payload: { primaryId: 'b' } });
    expect(api.createStack).toHaveBeenCalledWith({ stackCreateDto: { assetIds: ['b', 'a', 'c'] } });
    expect(result.undo).toEqual({ action: 'unstack', ids: ['b', 'a', 'c'], payload: { stackIds: ['stack-1'] } });
  });

  it('queues the per-item refresh jobs by name', async () => {
    await runBulkAction('refresh-thumbnails', ['a'], { gateway: api });
    await runBulkAction('refresh-metadata', ['a'], { gateway: api });
    await runBulkAction('refresh-encoded', ['a'], { gateway: api });
    await runBulkAction('refresh-faces', ['a'], { gateway: api });
    expect(vi.mocked(api.runAssetJobs).mock.calls.map(([argument]) => argument.assetJobsDto.name)).toEqual([
      AssetJobName.RegenerateThumbnail,
      AssetJobName.RefreshMetadata,
      AssetJobName.TranscodeVideo,
      AssetJobName.RefreshFaces,
    ]);
  });

  it('shares a link over the individual assets', async () => {
    await runBulkAction('create-shared-link', ['a', 'b'], { gateway: api });
    expect(api.createSharedLink).toHaveBeenCalledWith({
      sharedLinkCreateDto: { type: SharedLinkType.Individual, assetIds: ['a', 'b'] },
    });
  });

  it('downloads through the client archive flow rather than per asset', async () => {
    await runBulkAction('download', ['a', 'b'], { gateway: api, payload: { fileName: 'Frameleaf' } });
    expect(api.downloadArchive).toHaveBeenCalledWith('Frameleaf', { assetIds: ['a', 'b'] });
  });

  it('refuses to run an action whose payload is missing', async () => {
    await expect(runBulkAction('add-to-album', ['a'], { gateway: api })).rejects.toThrow(/albumId/);
  });
});

describe('partial failures are reported per item', () => {
  let api: BulkGateway;

  beforeEach(() => {
    api = gateway();
  });

  it('maps an endpoint that answers per id straight through', async () => {
    vi.mocked(api.addAssetsToAlbum).mockResolvedValue([
      { id: 'a', success: true },
      { id: 'b', success: false, error: 'duplicate' },
      { id: 'c', success: false, error: 'no_permission', errorMessage: 'Not yours' },
    ] as never);

    const result = await runBulkAction('add-to-album', ['a', 'b', 'c'], {
      gateway: api,
      payload: { albumId: 'album-1' },
    });
    expect(result.succeeded).toEqual(['a']);
    expect(result.failed.map((outcome) => outcome.reasonKey)).toEqual([
      'frameleaf_bulk_reason_duplicate',
      'frameleaf_bulk_reason_no_permission',
    ]);
    // Only the items that worked can be undone.
    expect(result.undo).toEqual({ action: 'remove-from-album', ids: ['a'], payload: { albumId: 'album-1' } });
  });

  it('isolates the failing item when a batch endpoint rejects the whole batch', async () => {
    type UpdateArgument = { assetBulkUpdateDto: { ids: string[] } };
    vi.mocked(api.updateAssets).mockImplementation((({ assetBulkUpdateDto }: UpdateArgument) =>
      assetBulkUpdateDto.ids.includes('b')
        ? Promise.reject(new Error('asset b is offline'))
        : Promise.resolve(undefined)) as never);

    const result = await runBulkAction('favorite', ['a', 'b', 'c'], { gateway: api });
    expect(result.succeeded).toEqual(['a', 'c']);
    expect(result.failed).toEqual([
      { id: 'b', status: 'failed', reasonKey: 'frameleaf_bulk_reason_failed', message: 'asset b is offline' },
    ]);
    // One batch, then one request per item to find out which of them failed.
    expect(api.updateAssets).toHaveBeenCalledTimes(4);
  });

  it('skips assets owned by someone else without attempting them', async () => {
    const result = await runBulkAction('archive', ['mine', 'theirs'], {
      gateway: api,
      context: { currentUserId: 'user-1', ownerById: { mine: 'user-1', theirs: 'user-2' } },
    });
    expect(api.updateAssets).toHaveBeenCalledWith({
      assetBulkUpdateDto: { ids: ['mine'], visibility: AssetVisibility.Archive },
    });
    expect(result.skipped).toEqual([{ id: 'theirs', status: 'skipped', reasonKey: 'frameleaf_bulk_reason_not_owner' }]);
    expect(result.requested).toBe(2);
  });

  it('summarizes a partial run as partial, not as success', () => {
    expect(
      bulkResultSummary({
        action: 'favorite',
        requested: 3,
        outcomes: [],
        succeeded: ['a'],
        failed: [{ id: 'b', status: 'failed' }],
        skipped: [{ id: 'c', status: 'skipped' }],
        cancelled: false,
      }).key,
    ).toBe('frameleaf_bulk_summary_partial');
  });

  it('stops between batches when cancelled and reports what was done', async () => {
    const controller = new AbortController();
    vi.mocked(api.updateAssets).mockImplementation((() => {
      controller.abort();
      return Promise.resolve(undefined);
    }) as never);

    const ids = Array.from({ length: 1200 }, (_, index) => `asset-${index}`);
    const result = await runBulkAction('favorite', ids, { gateway: api, signal: controller.signal });
    expect(api.updateAssets).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(result.succeeded).toHaveLength(500);
    expect(bulkResultSummary(result).key).toBe('frameleaf_bulk_summary_cancelled');
  });
});

describe('a matching set is bound to the scope it was taken from', () => {
  let api: BulkGateway;

  beforeEach(() => {
    api = gateway();
  });

  it('applies an album scope on top of the query filter', () => {
    const search = snapshotSearch(
      viewState({
        scope: { kind: 'album', id: 'album-1' },
        query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } },
      }),
    );
    expect(search).toEqual({
      kind: 'metadata',
      dto: {
        filter: {
          isFavorite: { eq: true },
          albumIds: { any: ['album-1'] },
          // A view that says nothing about visibility means the timeline, not everything unlocked.
          visibility: { eq: AssetVisibility.Timeline },
        },
        size: 250,
      },
    });
  });

  it('includes trashed assets when the view filters on the trash date', () => {
    const search = snapshotSearch(
      viewState({ query: { ...emptyDiscoveryQuery(), filter: { trashedAt: { gte: '2026-01-01' } } } }),
    );
    expect(search).toEqual({
      kind: 'metadata',
      dto: {
        filter: { trashedAt: { gte: '2026-01-01' }, visibility: { eq: AssetVisibility.Timeline } },
        size: 250,
        withDeleted: true,
      },
    });
  });

  it('refuses a locked view, whose visibility depends on an elevated session', () => {
    expect(
      snapshotSearch(
        viewState({
          query: { ...emptyDiscoveryQuery(), filter: { visibility: { eq: AssetVisibility.Locked } } },
        }),
      ),
    ).toEqual({ kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_scope_unsupported' });
  });

  it('keeps a visibility the view already states', () => {
    const search = snapshotSearch(
      viewState({ query: { ...emptyDiscoveryQuery(), filter: { visibility: { eq: AssetVisibility.Archive } } } }),
    );
    expect(search).toEqual({
      kind: 'metadata',
      dto: { filter: { visibility: { eq: AssetVisibility.Archive } }, size: 250 },
    });
  });

  it('refuses a scope or a query the search API cannot express rather than widening it', () => {
    expect(snapshotSearch(viewState({ scope: { kind: 'space', id: 'space-1' } }))).toEqual({
      kind: 'unsupported',
      reasonKey: 'frameleaf_bulk_reason_scope_unsupported',
    });
    expect(
      snapshotSearch(viewState({ query: { ...emptyDiscoveryQuery(), text: 'lake', mode: 'text' } })),
    ).toEqual({ kind: 'unsupported', reasonKey: 'frameleaf_bulk_reason_text_query_unsupported' });
    expect(snapshotSearch(viewState({ query: { ...emptyDiscoveryQuery(), text: 'lake', mode: 'smart' } })).kind).toBe(
      'smart',
    );
  });

  it('pages the frozen scope and never copies the live session state', async () => {
    vi.mocked(api.searchAssets)
      .mockResolvedValueOnce(page(['a', 'b'], '2', 3) as never)
      .mockResolvedValueOnce(page(['c'], null, 3) as never);

    const frozen = viewState({ query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } });
    const snapshot = await resolveMatchingIds(frozen, { gateway: api });
    expect(snapshot).toEqual({ ids: ['a', 'b', 'c'], total: 3, truncated: false, cancelled: false });
    expect(vi.mocked(api.searchAssets).mock.calls.map(([argument]) => argument.metadataSearchDto.page)).toEqual([1, 2]);
  });

  it('stops collecting at the client bound and says so', async () => {
    vi.mocked(api.searchAssets).mockResolvedValue(page(['a', 'b', 'c'], '2', 9000) as never);
    const snapshot = await resolveMatchingIds(viewState(), { gateway: api, limit: 2 });
    expect(snapshot.ids).toEqual(['a', 'b']);
    expect(snapshot.truncated).toBe(true);
  });

  it('counts the matching set from the same frozen state', async () => {
    vi.mocked(api.searchAssetStatistics).mockResolvedValue({ total: 4200 } as never);
    const state = viewState({ query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } });
    await expect(countMatching(state, api)).resolves.toBe(4200);
    expect(api.searchAssetStatistics).toHaveBeenCalledWith({
      statisticsSearchDto: {
        filter: { isFavorite: { eq: true }, visibility: { eq: AssetVisibility.Timeline } },
      },
    });
  });

  it('runs an operation against the frozen scope even after the live query moves on', async () => {
    vi.mocked(api.searchAssets).mockResolvedValue(page(['a', 'b'], null, 2) as never);
    const frozen = viewState({ query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } });
    const progress: string[] = [];

    const outcome = await runBulkOperation(
      { requestId: 'request-1', action: 'archive', scope: frozen, submittedTotal: 2 },
      { gateway: api, onProgress: (value) => progress.push(`${value.phase}:${value.processed}`) },
    );

    // The filter the request carried is the one the search used.
    expect(vi.mocked(api.searchAssets).mock.calls[0][0].metadataSearchDto.filter).toEqual({
      isFavorite: { eq: true },
      visibility: { eq: AssetVisibility.Timeline },
    });
    expect(api.updateAssets).toHaveBeenCalledWith({
      assetBulkUpdateDto: { ids: ['a', 'b'], visibility: AssetVisibility.Archive },
    });
    expect(outcome.requestId).toBe('request-1');
    expect(outcome.succeeded).toEqual(['a', 'b']);
    expect(progress[0]).toBe('resolving:0');
    expect(progress.at(-1)).toBe('running:2');
  });

  it('does not touch anything when the operation is cancelled while resolving', async () => {
    const controller = new AbortController();
    vi.mocked(api.searchAssets).mockImplementation((() => {
      controller.abort();
      return Promise.resolve(page(['a'], '2', 50));
    }) as never);

    const outcome = await runBulkOperation(
      { requestId: 'request-2', action: 'delete', scope: viewState(), submittedTotal: 50 },
      { gateway: api, signal: controller.signal },
    );
    expect(outcome.cancelled).toBe(true);
    expect(api.deleteAssets).not.toHaveBeenCalled();
  });
});

describe('durable bulk operations', () => {
  let api: BulkGateway;

  beforeEach(() => {
    api = gateway();
  });

  it('keeps small selections, downloads, shared links and Locked moves in this tab', () => {
    expect(shouldRunDurably('favorite', DURABLE_BULK_THRESHOLD)).toBe(false);
    expect(shouldRunDurably('favorite', DURABLE_BULK_THRESHOLD + 1)).toBe(true);
    expect(durableBulkAction('download')).toBeNull();
    expect(durableBulkAction('create-shared-link')).toBeNull();
    expect(durableBulkAction('mark-sensitive')).toBe(MediaOperationBulkAction.MarkSensitive);
  });

  it('sends only the payload fields the server knows, and keeps an empty description', () => {
    expect(toDurablePayload({ description: '', fileName: 'x', force: true })).toEqual({ description: '' });
    expect(toDurablePayload({ dateMode: 'shift', minutes: -30 })).toEqual({ dateMode: 'shift', minutes: -30 });
  });

  it('creates typed tags first and sends their ids', async () => {
    vi.mocked(api.upsertTags).mockResolvedValue([{ id: 'tag-new' }] as never);

    await submitDurableBulk('tag', ['a'], { payload: { tagIds: ['tag-1'], newTagNames: ['Summer'] } }, api);

    expect(api.upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['Summer'] } });
    expect(api.createBulkMediaOperation).toHaveBeenCalledWith({
      mediaOperationBulkCreateDto: expect.objectContaining({
        action: MediaOperationBulkAction.Tag,
        payload: { tagIds: ['tag-1', 'tag-new'] },
      }),
    });
  });

  it('splits a set larger than one job accepts, keeping the idempotency key on the first part only', async () => {
    const ids = Array.from({ length: DURABLE_BULK_MAX_ITEMS + 2 }, (_, index) => `id-${index}`);
    const requestId = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';

    const created = await submitDurableBulk('archive', ids, { requestId }, api);

    expect(created).toHaveLength(2);
    const calls = vi.mocked(api.createBulkMediaOperation).mock.calls.map(([args]) => args.mediaOperationBulkCreateDto);
    expect(calls[0].assetIds).toHaveLength(DURABLE_BULK_MAX_ITEMS);
    expect(calls[0].requestId).toBe(requestId);
    expect(calls[1].assetIds).toEqual(ids.slice(DURABLE_BULK_MAX_ITEMS));
    expect(calls[1].requestId).toBeUndefined();
  });

  it('does not send a request key the server would reject', async () => {
    await submitDurableBulk('archive', ['a'], { requestId: 'fl-legacy-key' }, api);

    const [[{ mediaOperationBulkCreateDto }]] = vi.mocked(api.createBulkMediaOperation).mock.calls;
    expect(mediaOperationBulkCreateDto.requestId).toBeUndefined();
  });

  it('refuses an action the server does not run', async () => {
    await expect(submitDurableBulk('download', ['a'], {}, api)).rejects.toThrow('frameleaf_bulk_reason_not_durable');
  });
});

describe('durable jobs on the page', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const detail = (overrides: Record<string, unknown> = {}) =>
    ({
      status: MediaOperationStatus.Rendering,
      processedUnits: '0',
      bulkItems: [],
      bulkRetryPending: [],
      bulk: { retried: 0, itemsTruncated: false },
      ...overrides,
    }) as never;

  it('splits and de-duplicates the frozen set exactly as the server will hold it', () => {
    expect(durableBulkParts(['a', 'b', 'a', 'c'])).toEqual([['a', 'b', 'c']]);
    const many = Array.from({ length: DURABLE_BULK_MAX_ITEMS + 1 }, (_, index) => `id-${index}`);
    expect(durableBulkParts(many).map((part) => part.length)).toEqual([DURABLE_BULK_MAX_ITEMS, 1]);
  });

  it('knows which actions take a finished item out of the view', () => {
    expect(removesFromView('delete')).toBe(true);
    expect(removesFromView('delete-permanently')).toBe(true);
    expect(removesFromView('restore')).toBe(true);
    expect(removesFromView('remove-from-album')).toBe(true);
    expect(removesFromView('favorite')).toBe(false);
  });

  it('removes a marked or unmarked item only from a view it no longer belongs to (FL-34)', () => {
    const timeline = { isLocked: false, revealsLocks: false };
    const revealing = { isLocked: false, revealsLocks: true };
    const locked = { isLocked: true, revealsLocks: false };

    expect(removesFromView('mark-sensitive', timeline)).toBe(true);
    expect(removesFromView('mark-sensitive', revealing)).toBe(false);
    expect(removesFromView('mark-sensitive', locked)).toBe(false);
    expect(removesFromView('unmark-sensitive', timeline)).toBe(false);
    expect(removesFromView('unmark-sensitive', revealing)).toBe(false);
    expect(removesFromView('unmark-sensitive', locked)).toBe(true);
  });

  it('reads answered items as done and the rest as pending while the job runs', () => {
    const states = durableItemStates(ids, detail({ processedUnits: '2' }));

    expect(states.get('a')).toEqual({ state: 'done' });
    expect(states.get('b')).toEqual({ state: 'done' });
    expect(states.get('c')).toEqual({ state: 'pending' });
    expect(states.get('d')).toEqual({ state: 'pending' });
  });

  it('keeps a failure pending until it has had its automatic retry', () => {
    const refusal = { id: 'b', status: MediaOperationItemStatus.Failed, reasonKey: 'frameleaf_bulk_reason_failed' };
    const before = detail({ processedUnits: '4', bulkItems: [refusal] });
    const after = detail({
      status: MediaOperationStatus.Completed,
      processedUnits: '4',
      bulkItems: [refusal],
      bulk: { retried: 1 },
    });

    expect(durableItemStates(ids, before).get('b')).toEqual({ state: 'pending' });
    expect(durableItemStates(ids, after).get('b')).toEqual({
      state: 'failed',
      reasonKey: 'frameleaf_bulk_reason_failed',
    });
  });

  it('shows a refusal at once, and treats "already there" as nothing to show', () => {
    const states = durableItemStates(
      ids,
      detail({
        processedUnits: '4',
        bulkItems: [
          { id: 'a', status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_no_permission' },
          { id: 'b', status: MediaOperationItemStatus.Skipped, reasonKey: 'frameleaf_bulk_reason_duplicate' },
        ],
      }),
    );

    expect(states.get('a')).toEqual({ state: 'failed', reasonKey: 'frameleaf_bulk_reason_no_permission' });
    expect(states.get('b')).toEqual({ state: 'unchanged' });
  });

  it('keeps items waiting for their retry pending wherever the cursor is', () => {
    const states = durableItemStates(
      ids,
      detail({
        status: MediaOperationStatus.Queued,
        processedUnits: '4',
        bulkRetryPending: ['c'],
        bulk: { retried: 1 },
      }),
    );

    expect(states.get('c')).toEqual({ state: 'pending' });
    expect(states.get('d')).toEqual({ state: 'done' });
  });

  it('leaves unreached items as they were after a cancel, and failed after a failed job', () => {
    const cancelled = detail({ status: MediaOperationStatus.Cancelled, processedUnits: '1' });
    const failed = detail({ status: MediaOperationStatus.Failed, processedUnits: '1' });

    expect(durableItemStates(ids, cancelled).get('d')).toEqual({ state: 'unchanged' });
    expect(durableItemStates(ids, failed).get('d')).toEqual({
      state: 'failed',
      reasonKey: 'frameleaf_bulk_reason_failed',
    });
  });

  it('never calls an item done on a guess when the refusal list was cut short', () => {
    const truncated = detail({
      status: MediaOperationStatus.Completed,
      processedUnits: '4',
      bulk: { retried: 0, itemsTruncated: true },
    });

    expect([...durableItemStates(ids, truncated).values()].every((state) => state.state === 'unchanged')).toBe(true);
  });
});
