import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import '$lib/components/asset-viewer/AssetViewer.svelte';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { showDeleteModal } from '$lib/stores/preferences.store';
import { getAssetInfoFromParam, navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import Host from './TimelineDeletion.test-host.svelte';

const { deleteRequest, confirmRequest } = vi.hoisted(() => ({
  deleteRequest: vi.fn<() => Promise<void>>(),
  confirmRequest: vi.fn<(options: unknown) => Promise<boolean>>(),
}));
// A permanent delete is confirmed with the Frameleaf dialog (`confirmAndDeletePermanently`).
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: confirmRequest }));
vi.mock('@immich/sdk', async () => ({
  ...(await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk')),
  deleteAssets: deleteRequest,
  getAssetInfo: vi.fn(),
  getFaces: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/utils/navigation', async () => ({
  ...(await vi.importActual<typeof import('$lib/utils/navigation')>('$lib/utils/navigation')),
  navigate: vi.fn(),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { init: vi.fn(), value: { smartSearch: true, trash: true } },
}));
vi.mock('$lib/components/asset-viewer/VideoWrapperViewer.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockText.svelte');
  return { default: component };
});
vi.mock('$lib/components/frameleaf/editor/QuickEditor.svelte', async () => {
  const { default: component } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: component };
});
vi.mock('$lib/stores/face.svelte', () => ({
  faceManager: { clear: vi.fn(), getAssetFaces: vi.fn(), data: [], facesByPersonId: new Map(), people: [] },
}));
vi.mock('$lib/stores/ocr.svelte', () => ({
  ocrManager: { clear: vi.fn(), getAssetOcr: vi.fn(), hasOcrData: false, showOverlay: false },
}));

beforeAll(() => {
  Element.prototype.animate = getAnimateMock();
  vi.stubGlobal('ResizeObserver', getResizeObserverMock());
});
afterEach(() => {
  assetCacheManager.invalidate();
  authManager.reset();
  showDeleteModal.set(true);
  vi.clearAllMocks();
});

function setup(isTrashed = true) {
  const user = userAdminFactory.build();
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  const [a, b, c] = assetFactory.buildList(3, { ownerId: user.id, isTrashed });
  const manager = {
    getEarlierAsset: vi.fn((asset: AssetResponseDto) =>
      Promise.resolve(asset.id === a.id ? b : asset.id === b.id ? c : undefined),
    ),
    getLaterAsset: vi.fn().mockResolvedValue(undefined),
    removeAssets: vi.fn(),
    getTimelineMonthByAssetId: vi.fn(),
  };
  vi.mocked(getAssetInfo).mockImplementation(({ id }) => Promise.resolve(id === b.id ? b : c));
  deleteRequest.mockResolvedValue(undefined);
  // The viewer confirms every permanent delete; the user answers the dialog with "Delete permanently".
  confirmRequest.mockResolvedValue(true);
  assetViewerManager.setAsset(a);
  return { a, b, c, manager };
}

it.each([true, false])(
  'keeps a delayed route lookup alive until navigation completes before emitting the real local delete event (permanent=%s)',
  async (force) => {
    const { a, b, manager } = setup(force);
    showDeleteModal.set(false);
    const deleted = vi.fn();
    const stop = eventManager.on({ AssetsDelete: deleted });
    const view = renderWithTooltips(Host, { timelineManager: manager as unknown as TimelineManager });
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: b.id })));
    const button = await view.findByRole('button', {
      name: force ? 'frameleaf_viewer_delete_permanently' : 'frameleaf_viewer_move_to_trash',
    });
    let resolveRoute!: (asset: AssetResponseDto) => void;
    const response = new Promise<AssetResponseDto>((resolve) => {
      resolveRoute = resolve;
    });
    assetCacheManager.invalidateAsset(b.id);
    vi.mocked(getAssetInfo).mockReturnValueOnce(response);
    let routeError: unknown;
    let routeCompletion: Promise<void> | undefined;
    vi.mocked(navigate).mockImplementation(
      ({ assetId }) =>
        (routeCompletion = (async () => {
          try {
            const asset = await getAssetInfoFromParam({ assetId: assetId ?? undefined });
            if (asset) {
              assetViewerManager.setAsset(asset);
            }
          } catch (error) {
            routeError = error;
          }
        })()),
    );
    await fireEvent.click(button);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ assetId: b.id })));
    const requestsBeforeRouteCompletion = deleteRequest.mock.calls.length;
    resolveRoute(b);
    await routeCompletion;
    await waitFor(() => expect(deleted).toHaveBeenCalledWith([a.id]));
    expect.soft(requestsBeforeRouteCompletion).toBe(0);
    expect.soft(routeError).toBeUndefined();
    expect(assetViewerManager.asset?.id).toBe(b.id);
    expect(assetViewerManager.isViewing).toBe(true);
    expect(confirmRequest).toHaveBeenCalledTimes(force ? 1 : 0);
    stop();
  },
);

it('does not use B cursor when confirmation for A completes after navigation', async () => {
  const { a, b, c, manager } = setup();
  let confirm!: (value: boolean) => void;
  confirmRequest.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      confirm = resolve;
    }),
  );
  const deleted = vi.fn();
  const stop = eventManager.on({ AssetsDelete: deleted });
  const view = renderWithTooltips(Host, { timelineManager: manager as unknown as TimelineManager });
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_delete_permanently' }));
  await waitFor(() => expect(confirmRequest).toHaveBeenCalledOnce());
  assetViewerManager.setAsset(b);
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: c.id })));
  confirm(true);
  await waitFor(() => expect(deleted).toHaveBeenCalledWith([a.id]));
  expect(deleteRequest).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [a.id], force: true } });
  expect(navigate).not.toHaveBeenCalled();
  expect(assetViewerManager.asset?.id).toBe(b.id);
  stop();
});

it('ignores a late neighbor lookup for an asset that is no longer open', async () => {
  const { a, b, c, manager } = setup();
  showDeleteModal.set(false);
  let releaseOld!: (asset: AssetResponseDto) => void;
  manager.getEarlierAsset.mockImplementation((asset: AssetResponseDto) =>
    asset.id === a.id
      ? new Promise((resolve) => {
          releaseOld = resolve;
        })
      : Promise.resolve(c),
  );
  vi.mocked(getAssetInfo).mockImplementation(({ id }) => Promise.resolve(id === b.id ? b : c));
  vi.mocked(navigate).mockImplementation(async ({ assetId }) => {
    const target = await getAssetInfoFromParam({ assetId: assetId ?? undefined });
    if (target) {
      assetViewerManager.setAsset(target);
    }
  });
  const view = renderWithTooltips(Host, { timelineManager: manager as unknown as TimelineManager });
  await waitFor(() => expect(manager.getEarlierAsset).toHaveBeenCalledWith(a));
  assetViewerManager.setAsset(b);
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: c.id })));
  releaseOld(b);
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: b.id })));
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_delete_permanently' }));
  await waitFor(() => expect(deleteRequest).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [b.id], force: true } }));
  // always confirmed, even with the delete prompt turned off, and as a danger action
  expect(confirmRequest).toHaveBeenCalledWith(
    expect.objectContaining({ confirmText: 'frameleaf_viewer_delete_permanently', danger: true }),
  );
  expect(assetViewerManager.asset?.id).toBe(c.id);
});

it.each([true, false])(
  'keeps the next item when the delete event for a moved-past item arrives before that item loads (permanent=%s)',
  async (force) => {
    const { a, b, manager } = setup(force);
    showDeleteModal.set(false);
    const deleted = vi.fn();
    const stop = eventManager.on({ AssetsDelete: deleted });
    const view = renderWithTooltips(Host, { timelineManager: manager as unknown as TimelineManager });
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: b.id })));
    const button = await view.findByRole('button', {
      name: force ? 'frameleaf_viewer_delete_permanently' : 'frameleaf_viewer_move_to_trash',
    });
    // The route change finishes at once, but the next item loads later, as a page's own lookup does:
    // the viewer still shows A when A's delete events arrive.
    let showNext!: () => void;
    const shown = new Promise<void>((resolve) => {
      showNext = resolve;
    });
    vi.mocked(navigate).mockImplementation(({ assetId }) => {
      void shown.then(async () => {
        const asset = await getAssetInfoFromParam({ assetId: assetId ?? undefined });
        if (asset) {
          assetViewerManager.setAsset(asset);
        }
      });
      return Promise.resolve();
    });

    await fireEvent.click(button);
    await waitFor(() => expect(deleted).toHaveBeenCalledWith([a.id]));
    expect(assetViewerManager.asset?.id).toBe(a.id);
    // the server's event for the same item
    eventManager.emit('AssetsDelete', [a.id]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // the viewer did not act on A's removal a second time: one move to B, no close
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ assetId: b.id }));
    expect(assetViewerManager.isViewing).toBe(true);

    showNext();
    await waitFor(() => expect(assetViewerManager.asset?.id).toBe(b.id));
    expect(assetViewerManager.isViewing).toBe(true);
    stop();
  },
);
