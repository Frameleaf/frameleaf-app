import { ArchiveOperationScope, type ArchiveOperationResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveGateway } from '$lib/frameleaf/archive-operations';
import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
import { DURABLE_BULK_THRESHOLD, type BulkGateway } from '$lib/frameleaf/bulk-operations';
import {
  createLibrarySession,
  reduceLibrarySession,
  type LibrarySession,
  type LibrarySessionAction,
} from '$lib/frameleaf/library-session';

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: async () => (key: string) => key,
}));
vi.mock('$lib/utils/asset-utils', () => ({ downloadArchive: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@immich/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn(), warning: vi.fn() } }));
// an HTTP refusal, as the generated SDK reports one
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => error instanceof Error && 'status' in error,
}));
vi.mock('$lib/frameleaf/activity-session.svelte', () => ({ activitySession: { refresh: vi.fn() } }));

// FL-48: a structured search pages by cursor, so the next page is announced as `nextCursor`
const page = (ids: string[], nextPage: string | null, total = ids.length) => ({
  albums: { items: [], count: 0, total: 0, facets: [], nextPage: null, nextCursor: null },
  assets: { items: ids.map((id) => ({ id })), count: ids.length, total, facets: [], nextPage, nextCursor: nextPage },
});

describe('the bulk controller', () => {
  let session: LibrarySession;
  let api: BulkGateway;
  let controller: BulkController;
  const queued = vi.fn();
  const tracker = { track: vi.fn() };
  let archive: { [K in keyof ArchiveGateway]: ReturnType<typeof vi.fn> };

  const operationOf = (overrides: Partial<ArchiveOperationResponseDto> = {}): ArchiveOperationResponseDto => ({
    id: 'op-1',
    scope: ArchiveOperationScope.SelectedOwnedAssets,
    requestKey: '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c',
    count: 2,
    prepared: false,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    archiveJobId: 'archive-job',
    undoJobId: null,
    pending: 2,
    archived: 0,
    skipped: 0,
    undone: 0,
    conflict: 0,
    undoable: true,
    currentSession: true,
    ...overrides,
  });

  const dispatch = vi.fn((action: LibrarySessionAction) => {
    session = reduceLibrarySession(session, action);
  });

  beforeEach(() => {
    session = createLibrarySession();
    dispatch.mockClear();
    api = {
      updateAssets: vi.fn().mockResolvedValue(undefined),
      deleteAssets: vi.fn().mockResolvedValue(undefined),
      restoreAssets: vi.fn().mockResolvedValue(undefined),
      searchAssets: vi.fn().mockResolvedValue(page(['a', 'b'], null, 2)),
      searchAssetStatistics: vi.fn().mockResolvedValue({ total: 2 }),
      createBulkMediaOperation: vi.fn().mockResolvedValue({ id: 'job-1' }),
      upsertTags: vi.fn().mockResolvedValue([]),
    } as unknown as BulkGateway;
    queued.mockClear();
    tracker.track.mockClear();
    archive = {
      createArchiveOperation: vi.fn().mockResolvedValue(operationOf()),
      prepareArchiveOperation: vi.fn(),
      confirmArchiveOperation: vi.fn(),
      undoArchiveOperation: vi.fn().mockResolvedValue(operationOf({ undoJobId: 'undo-job', undoable: false })),
      getArchiveOperations: vi.fn().mockResolvedValue([]),
    };
    controller = new BulkController({ dispatch, gateway: api, queued, tracker, archive: archive as never });
  });

  it('tells the page which items an immediate action changed, so it can show the change at once', async () => {
    const applied = vi.fn();
    controller = new BulkController({ dispatch, gateway: api, queued, tracker, applied, archive: archive as never });
    await controller.run('favorite', ['a', 'b']);
    expect(applied).toHaveBeenCalledWith('favorite', ['a', 'b'], undefined);
    // A favorite leaves nothing: the page decides what an item's new state takes out of its view.
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mutated' }));
  });

  it('offers restore as the undo for a trashed selection and runs it against the same ids', async () => {
    await controller.run('delete', ['a', 'b']);
    expect(api.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['a', 'b'], force: false } });
    // The trashed assets left the page, so the session drops its references to them.
    expect(dispatch).toHaveBeenCalledWith({ type: 'mutated', removedIds: ['a', 'b'] });

    expect(controller.undo?.label).toBe('frameleaf_bulk_restore');
    await controller.undo!.run();
    expect(api.restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: ['a', 'b'] } });
    expect(controller.undo).toBeNull();
  });

  it('runs a small selection here, with undo, and never queues a job', async () => {
    const ids = Array.from({ length: DURABLE_BULK_THRESHOLD }, (_, index) => `id-${index}`);

    await controller.run('favorite', ids);

    expect(api.updateAssets).toHaveBeenCalled();
    expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
    expect(controller.undo).not.toBeNull();
  });

  it('hands a selection above the threshold to the server as a durable job', async () => {
    const ids = Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`);

    const result = await controller.run('favorite', ids);

    expect(result).toBeNull();
    expect(api.updateAssets).not.toHaveBeenCalled();
    expect(api.createBulkMediaOperation).toHaveBeenCalledWith({
      mediaOperationBulkCreateDto: expect.objectContaining({ action: 'favorite', assetIds: ids }),
    });
    expect(controller.undo).toBeNull();
    expect(queued).toHaveBeenCalled();
  });

  it('keeps a large delete on the page with a loader on every tile until the job answers for it', async () => {
    const ids = Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`);

    await controller.run('delete', ids);

    // Nothing leaves the page at submit; the tracker removes items as the job finishes them.
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'mutated' }));
    expect(tracker.track).toHaveBeenCalledWith('delete', 'job-1', ids);
  });

  it('follows each part of a set split across several jobs with its own ids', async () => {
    vi.mocked(api.createBulkMediaOperation)
      .mockResolvedValueOnce({ id: 'job-1' } as never)
      .mockResolvedValueOnce({ id: 'job-2' } as never);
    const ids = Array.from({ length: 50_001 }, (_, index) => `id-${index}`);

    await controller.run('favorite', ids);

    expect(tracker.track).toHaveBeenCalledWith('favorite', 'job-1', ids.slice(0, 50_000));
    expect(tracker.track).toHaveBeenCalledWith('favorite', 'job-2', ids.slice(50_000));
  });

  it('keeps a large download in this tab, because only this tab can receive it', async () => {
    const ids = Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`);
    (api as unknown as { downloadArchive: unknown }).downloadArchive = vi.fn().mockResolvedValue(undefined);

    await controller.run('download', ids);

    expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
  });

  it('resolves everything matching once and queues exactly those ids against the frozen scope', async () => {
    const scope = structuredClone(session.state);
    const requestId = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';
    await controller.runMatching('favorite', scope, { submittedTotal: 2, requestId });

    expect(api.createBulkMediaOperation).toHaveBeenCalledWith({
      mediaOperationBulkCreateDto: expect.objectContaining({
        action: 'favorite',
        assetIds: ['a', 'b'],
        submittedTotal: 2,
        truncated: false,
        requestId,
        scope,
      }),
    });
    expect(api.updateAssets).not.toHaveBeenCalled();
    // The server owns the job now; Activity shows it, so the tab's own record is dropped.
    expect(session.operations).toHaveLength(0);
    expect(queued).toHaveBeenCalled();
    expect(tracker.track).toHaveBeenCalledWith('favorite', 'job-1', ['a', 'b']);
  });

  it('reports a refused scope as a failed operation without calling anything', async () => {
    // A shared space with an id resolves to the album condition it is (FL-48 map/space
    // follow-ups, `bulk-operations.spec.ts`); a space scope with none is still refused, the
    // same as an album scope with none.
    await controller.runMatching('archive', {
      ...session.state,
      scope: { kind: 'space' },
    });
    expect(session.operations[0].status).toBe('failed');
    expect(session.operations[0].errorKey).toBe('frameleaf_bulk_reason_scope_unsupported');
    expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
  });

  it('keeps a rejected submit as a failed record that retry runs again under the same key', async () => {
    vi.mocked(api.createBulkMediaOperation).mockRejectedValueOnce(new Error('offline'));

    await controller.runMatching('favorite', session.state, { submittedTotal: 2 });
    expect(session.operations).toHaveLength(1);
    expect(session.operations[0].status).toBe('failed');

    await controller.retry(session.operations[0]);
    expect(api.createBulkMediaOperation).toHaveBeenCalledTimes(2);
    expect(session.operations).toHaveLength(0);
  });

  it('cancels while the matching set is still being found, before anything is queued', async () => {
    let resolveSearch: (value: unknown) => void = () => {};
    vi.mocked(api.searchAssets).mockImplementation(
      (() => new Promise((resolve) => (resolveSearch = resolve))) as never,
    );

    const running = controller.runMatching('archive', session.state, {
      submittedTotal: 2,
      requestId: 'request-1',
    });
    controller.cancel('request-1');
    resolveSearch(page(['a'], '2', 50));
    await running;

    expect(session.operations[0].status).toBe('cancelled');
    expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
    expect(api.updateAssets).not.toHaveBeenCalled();
  });
  describe('a transactional archive (FL-32)', () => {
    it('archives a large selection as one operation, follows its job and keeps an Undo', async () => {
      const ids = Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`);
      archive.createArchiveOperation.mockResolvedValue(operationOf({ count: ids.length, pending: ids.length }));

      await controller.run('archive', ids);

      expect(archive.createArchiveOperation).toHaveBeenCalledWith({
        archiveOperationCreateDto: { requestKey: expect.any(String), assetIds: ids },
      });
      expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
      expect(tracker.track).toHaveBeenCalledWith('archive', 'archive-job', ids);
      expect(queued).toHaveBeenCalled();
      expect(controller.undo?.label).toBe('frameleaf_bulk_archive');

      await controller.undo!.run();

      expect(archive.undoArchiveOperation).toHaveBeenCalledWith({
        id: 'op-1',
        archiveOperationUndoDto: { requestKey: expect.any(String) },
      });
      expect(controller.undo).toBeNull();
    });

    it('archives a resolved matching set as one operation under the hand-off request key', async () => {
      const requestId = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';

      await controller.runMatching('archive', structuredClone(session.state), { submittedTotal: 2, requestId });

      expect(archive.createArchiveOperation).toHaveBeenCalledWith({
        archiveOperationCreateDto: { requestKey: requestId, assetIds: ['a', 'b'] },
      });
      expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
      expect(session.operations).toHaveLength(0);
      expect(tracker.track).toHaveBeenCalledWith('archive', 'archive-job', ['a', 'b']);
    });

    it('prepares the matching set on the server and archives only the confirmed count', async () => {
      const prepared = operationOf({
        scope: ArchiveOperationScope.MatchingOwnedTimeline,
        prepared: true,
        count: 1200,
        archiveJobId: null,
        undoable: false,
      });
      archive.prepareArchiveOperation.mockResolvedValue(prepared);
      archive.confirmArchiveOperation.mockResolvedValue(operationOf({ count: 1200 }));

      expect(await controller.prepareArchive()).toEqual(prepared);
      expect(archive.prepareArchiveOperation).toHaveBeenCalledWith({
        archiveOperationPrepareDto: { requestKey: expect.any(String), scope: 'matching-owned-timeline' },
      });
      expect(archive.confirmArchiveOperation).not.toHaveBeenCalled();

      expect(await controller.confirmArchive(prepared)).toBe(true);
      expect(archive.confirmArchiveOperation).toHaveBeenCalledWith({
        id: prepared.id,
        archiveOperationConfirmDto: { requestKey: prepared.requestKey },
      });
      expect(controller.undo).not.toBeNull();
    });

    it('starts nothing when the prepared selection expired before it was confirmed', async () => {
      archive.confirmArchiveOperation.mockRejectedValue(Object.assign(new Error('expired'), { status: 410 }));

      expect(await controller.confirmArchive(operationOf({ prepared: true }))).toBe(false);
      expect(controller.undo).toBeNull();
      expect(queued).not.toHaveBeenCalled();
    });

    it('offers the latest recent archive’s Undo again after a reload, and not an old one', async () => {
      const now = Date.parse('2026-09-23T12:00:00.000Z');
      archive.getArchiveOperations.mockResolvedValue([
        operationOf({ id: 'finished', undoable: false, createdAt: '2026-09-23T11:59:00.000Z' }),
        operationOf({ id: 'recent', createdAt: '2026-09-23T11:50:00.000Z' }),
      ]);

      await controller.restoreArchiveUndo(now);
      await controller.undo!.run();

      expect(archive.undoArchiveOperation).toHaveBeenCalledWith(expect.objectContaining({ id: 'recent' }));

      // shown once as the prototype's toast, with Undo on it, without a selection
      expect(toastManager.primary).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'frameleaf_bulk_archive_undo_available', button: expect.any(Function) }),
      );
      vi.mocked(toastManager.primary).mockClear();
      controller.undo = null;
      await controller.restoreArchiveUndo(now);
      expect(controller.undo).not.toBeNull();
      expect(toastManager.primary).not.toHaveBeenCalled();

      controller.undo = null;
      archive.getArchiveOperations.mockResolvedValue([operationOf({ createdAt: '2026-09-23T10:00:00.000Z' })]);
      await controller.restoreArchiveUndo(now);
      expect(controller.undo).toBeNull();
    });
    it('refuses an archive larger than one operation instead of archiving it short (P2-2)', async () => {
      const ids = Array.from({ length: 50_001 }, (_, index) => `id-${index}`);

      await controller.run('archive', ids);

      expect(archive.createArchiveOperation).not.toHaveBeenCalled();
      expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
      expect(toastManager.warning).toHaveBeenCalledWith('frameleaf_bulk_reason_archive_too_many');
    });

    it('refuses a filtered matching set that was cut short, keeping the truncated notice (P2-2)', async () => {
      const ids = Array.from({ length: 50_001 }, (_, index) => `id-${index}`);
      vi.mocked(api.searchAssets).mockResolvedValue(page(ids, null, 60_000) as never);

      await controller.runMatching('archive', structuredClone(session.state), { submittedTotal: 60_000 });

      expect(archive.createArchiveOperation).not.toHaveBeenCalled();
      expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
      expect(session.operations[0]).toEqual(
        expect.objectContaining({
          status: 'failed',
          errorKey: 'frameleaf_bulk_reason_archive_too_many',
          truncated: true,
        }),
      );
    });

    it('does not follow tiles when the server left some of the selection out', async () => {
      archive.createArchiveOperation.mockResolvedValue(operationOf({ count: 2, pending: 1, skipped: 1 }));

      await controller.run(
        'archive',
        Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`),
      );

      expect(tracker.track).not.toHaveBeenCalled();
    });

    it('says nothing was queued when no job started', async () => {
      archive.createArchiveOperation.mockResolvedValue(
        operationOf({ archiveJobId: null, pending: 0, skipped: 2, undoable: false }),
      );

      await controller.run(
        'archive',
        Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`),
      );

      expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_bulk_archive_nothing_selected');
      expect(queued).not.toHaveBeenCalled();
      expect(controller.undo).toBeNull();
    });

    it('retries a hand-off whose answer was lost with the same selection under the same key', async () => {
      const requestId = '6f1c1b0e-8d7a-4c2e-9b1a-0d3e5f7a9b2c';
      archive.createArchiveOperation.mockRejectedValueOnce(new Error('offline'));
      await controller.runMatching('archive', structuredClone(session.state), { submittedTotal: 2, requestId });
      expect(session.operations[0].status).toBe('failed');

      // the view changed meanwhile; the retry must not resolve it again
      vi.mocked(api.searchAssets).mockResolvedValue(page(['a', 'b', 'c'], null, 3) as never);
      await controller.retry(session.operations[0]);

      expect(archive.createArchiveOperation).toHaveBeenLastCalledWith({
        archiveOperationCreateDto: { requestKey: requestId, assetIds: ['a', 'b'] },
      });
    });

    it('shows the expired notice when the prepared selection is gone (P3)', async () => {
      archive.confirmArchiveOperation.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));

      expect(await controller.confirmArchive(operationOf({ prepared: true }))).toBe(false);
      expect(toastManager.warning).toHaveBeenCalledWith('frameleaf_bulk_archive_expired');
    });

    it('sends one undo per offer, and keeps the offer under the same key when it fails (P2-6)', async () => {
      await controller.run(
        'archive',
        Array.from({ length: DURABLE_BULK_THRESHOLD + 1 }, (_, index) => `id-${index}`),
      );
      const undo = controller.undo!;
      let answer!: () => void;
      archive.undoArchiveOperation.mockReturnValueOnce(
        new Promise((_resolve, reject) => (answer = () => reject(new Error('offline')))),
      );

      const clicks = [undo.run(), undo.run()];
      answer();
      await Promise.all(clicks);

      expect(archive.undoArchiveOperation).toHaveBeenCalledTimes(1);
      expect(controller.undo).toBe(undo);

      await controller.undo!.run();
      const keys = archive.undoArchiveOperation.mock.calls.map(
        ([request]) =>
          (request as { archiveOperationUndoDto: { requestKey: string } }).archiveOperationUndoDto.requestKey,
      );
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBe(keys[1]);
    });

    it('offers a restored Undo only for this session’s own archives (P2-3)', async () => {
      archive.getArchiveOperations.mockResolvedValue([
        operationOf({ id: 'other-device', currentSession: false } as never),
      ]);

      await controller.restoreArchiveUndo();

      expect(controller.undo).toBeNull();
    });
  });
});
