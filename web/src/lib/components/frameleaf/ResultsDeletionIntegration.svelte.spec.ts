import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import '$lib/components/asset-viewer/AssetViewer.svelte';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { showDeleteModal } from '$lib/stores/preferences.store';
import { getAssetInfoFromParam, navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ResultsAssetViewer from './ResultsAssetViewer.svelte';

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
  const assets = assetFactory.buildList(3, { ownerId: user.id, isTrashed });
  vi.mocked(getAssetInfo).mockImplementation(({ id }) => Promise.resolve(assets.find((asset) => asset.id === id)!));
  deleteRequest.mockResolvedValue(undefined);
  // The viewer confirms every permanent delete even when bulk-delete warnings are switched off;
  // the user answers the dialog with "Delete permanently".
  showDeleteModal.set(false);
  confirmRequest.mockResolvedValue(true);
  assetViewerManager.setAsset(assets[0]);
  vi.mocked(navigate).mockImplementation(async ({ assetId }) => {
    const asset = await getAssetInfoFromParam({ assetId: assetId ?? undefined });
    if (asset) {
      assetViewerManager.setAsset(asset);
    }
  });
  const view = renderWithTooltips(ResultsAssetViewer, {
    assets,
    onRemove: (id: string) => {
      const index = assets.findIndex((asset) => asset.id === id);
      if (index !== -1) {
        assets.splice(index, 1);
      }
      void view.rerender({ assets: [...assets] });
    },
  });
  return { assets, view };
}

it.each([true, false])(
  'advances after two real gallery deletions with deferred route publication (permanent=%s)',
  async (force) => {
    const { assets, view } = setup(force);
    const [a, b, c] = assets;
    let resolveRoute!: (asset: AssetResponseDto) => void;
    vi.mocked(getAssetInfo).mockImplementation(({ id }) =>
      id === b.id
        ? new Promise((resolve) => {
            resolveRoute = resolve;
          })
        : Promise.resolve(c),
    );
    const deleted = vi.fn();
    const stop = eventManager.on({ AssetsDelete: deleted });
    await fireEvent.click(
      await view.findByRole('button', {
        name: force ? 'frameleaf_viewer_delete_permanently' : 'frameleaf_viewer_move_to_trash',
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ assetId: b.id })));
    expect(deleteRequest).not.toHaveBeenCalled();
    resolveRoute(b);
    await waitFor(() => expect(deleted).toHaveBeenCalledWith([a.id]));
    expect(assetViewerManager.asset?.id).toBe(b.id);
    await fireEvent.click(
      await view.findByRole('button', {
        name: force ? 'frameleaf_viewer_delete_permanently' : 'frameleaf_viewer_move_to_trash',
      }),
    );
    await waitFor(() => expect(deleted).toHaveBeenCalledWith([b.id]));
    expect(assetViewerManager.asset?.id).toBe(c.id);
    expect(assetViewerManager.isViewing).toBe(true);
    expect(confirmRequest).toHaveBeenCalledTimes(force ? 2 : 0);
    stop();
  },
);

it('uses the previous neighbor for the last asset and ignores stale confirmation cursor', async () => {
  const { assets, view } = setup();
  const [a, b, c] = assets;
  assetViewerManager.setAsset(c);
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_delete_permanently' }));
  await waitFor(() => expect(assetViewerManager.asset?.id).toBe(b.id));
  let confirm!: (value: boolean) => void;
  confirmRequest.mockReturnValueOnce(
    new Promise((resolve) => {
      confirm = resolve;
    }),
  );
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_delete_permanently' }));
  await waitFor(() => expect(confirmRequest).toHaveBeenCalledTimes(2));
  assetViewerManager.setAsset(a);
  vi.mocked(navigate).mockClear();
  confirm(true);
  await waitFor(() => expect(deleteRequest).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [b.id], force: true } }));
  expect(navigate).not.toHaveBeenCalled();
  expect(assetViewerManager.asset?.id).toBe(a.id);
});

it('uses the current cursor after backward and forward navigation', async () => {
  const { assets, view } = setup(false);
  const [a, b, c] = assets;
  assetViewerManager.setAsset(b);
  await fireEvent.click(await view.findByRole('button', { name: 'view_previous_asset' }));
  await waitFor(() => expect(assetViewerManager.asset?.id).toBe(a.id));
  await fireEvent.click(await view.findByRole('button', { name: 'view_next_asset' }));
  await waitFor(() => expect(assetViewerManager.asset?.id).toBe(b.id));
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_move_to_trash' }));
  await waitFor(() => expect(deleteRequest).toHaveBeenCalledOnce());
  expect(assetViewerManager.asset?.id).toBe(c.id);
});

it('does not remove an unrelated final result when the deleted ID was already removed', async () => {
  const { assets, view } = setup();
  const [a, b, c] = assets;
  let complete!: () => void;
  deleteRequest.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await fireEvent.click(await view.findByRole('button', { name: 'frameleaf_viewer_delete_permanently' }));
  await waitFor(() => expect(deleteRequest).toHaveBeenCalledOnce());
  // always confirmed, even with the delete prompt turned off, and as a danger action
  expect(confirmRequest).toHaveBeenCalledWith(
    expect.objectContaining({ confirmText: 'frameleaf_viewer_delete_permanently', danger: true }),
  );
  assets.splice(
    assets.findIndex((asset) => asset.id === a.id),
    1,
  );
  complete();
  await waitFor(() => expect(assetViewerManager.asset?.id).toBe(b.id));
  expect(assets.map((asset) => asset.id)).toEqual([b.id, c.id]);
});
