import { beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@immich/ui', () => ({ toastManager: { primary: vi.fn(), danger: vi.fn() } }));
vi.mock('$lib/frameleaf/activity-session.svelte', () => ({ activitySession: { refresh: vi.fn() } }));

const page = (ids: string[], nextPage: string | null, total = ids.length) => ({
  albums: { items: [], count: 0, total: 0, facets: [], nextPage: null, nextCursor: null },
  assets: { items: ids.map((id) => ({ id })), count: ids.length, total, facets: [], nextPage, nextCursor: null },
});

describe('the bulk controller', () => {
  let session: LibrarySession;
  let api: BulkGateway;
  let controller: BulkController;
  const queued = vi.fn();

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
    controller = new BulkController({ dispatch, gateway: api, queued });
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

    const result = await controller.run('archive', ids);

    expect(result).toBeNull();
    expect(api.updateAssets).not.toHaveBeenCalled();
    expect(api.createBulkMediaOperation).toHaveBeenCalledWith({
      mediaOperationBulkCreateDto: expect.objectContaining({ action: 'archive', assetIds: ids }),
    });
    expect(controller.undo).toBeNull();
    expect(queued).toHaveBeenCalled();
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
    await controller.runMatching('archive', scope, { submittedTotal: 2, requestId });

    expect(api.createBulkMediaOperation).toHaveBeenCalledWith({
      mediaOperationBulkCreateDto: expect.objectContaining({
        action: 'archive',
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
  });

  it('reports a refused scope as a failed operation without calling anything', async () => {
    await controller.runMatching('archive', {
      ...session.state,
      scope: { kind: 'space', id: 'space-1' },
    });
    expect(session.operations[0].status).toBe('failed');
    expect(session.operations[0].errorKey).toBe('frameleaf_bulk_reason_scope_unsupported');
    expect(api.createBulkMediaOperation).not.toHaveBeenCalled();
  });

  it('keeps a rejected submit as a failed record that retry runs again under the same key', async () => {
    vi.mocked(api.createBulkMediaOperation).mockRejectedValueOnce(new Error('offline'));

    await controller.runMatching('archive', session.state, { submittedTotal: 2 });
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
});
