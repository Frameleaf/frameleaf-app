import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
import type { BulkGateway } from '$lib/frameleaf/bulk-operations';
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

const page = (ids: string[], nextPage: string | null, total = ids.length) => ({
  albums: { items: [], count: 0, total: 0, facets: [], nextPage: null, nextCursor: null },
  assets: { items: ids.map((id) => ({ id })), count: ids.length, total, facets: [], nextPage, nextCursor: null },
});

describe('the bulk controller', () => {
  let session: LibrarySession;
  let api: BulkGateway;
  let controller: BulkController;

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
    } as unknown as BulkGateway;
    controller = new BulkController({ dispatch, gateway: api });
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

  it('records a background operation against the scope frozen at submit', async () => {
    const scope = structuredClone(session.state);
    await controller.runMatching('archive', scope, { submittedTotal: 2 });

    const [operation] = session.operations;
    expect(operation.status).toBe('completed');
    expect(operation.submittedTotal).toBe(2);
    expect(operation.succeeded).toBe(2);
    expect(operation.scope).toEqual(scope);
  });

  it('reports a refused scope as a failed operation without calling anything', async () => {
    await controller.runMatching('archive', {
      ...session.state,
      scope: { kind: 'space', id: 'space-1' },
    });
    expect(session.operations[0].status).toBe('failed');
    expect(session.operations[0].errorKey).toBe('frameleaf_bulk_reason_scope_unsupported');
    expect(api.updateAssets).not.toHaveBeenCalled();
  });

  it('retries under the same request key instead of starting a second operation', async () => {
    await controller.runMatching('archive', session.state, { submittedTotal: 2 });
    await controller.retry(session.operations[0]);
    expect(session.operations).toHaveLength(1);
    expect(session.operations[0].status).toBe('completed');
  });

  it('cancels a running operation between batches', async () => {
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
    expect(api.updateAssets).not.toHaveBeenCalled();
  });
});
