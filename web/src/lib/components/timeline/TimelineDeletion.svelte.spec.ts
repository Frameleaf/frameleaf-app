import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { showDeleteModal } from '$lib/stores/preferences.store';
import { navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import TimelineAssetViewer from './TimelineAssetViewer.svelte';

const { deleteRequest } = vi.hoisted(() => ({ deleteRequest: vi.fn<() => Promise<void>>() }));
vi.mock('$lib/components/asset-viewer/AssetViewer.svelte', async () => {
  const { default: component } = await import('./TimelineDeletion.test-viewer.svelte');
  return { default: component };
});
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { trash: false } } }));
vi.mock('$lib/utils/navigation', async () => ({
  ...(await vi.importActual<object>('$lib/utils/navigation')),
  navigate: vi.fn(),
}));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  deleteAssets: deleteRequest,
  getAssetInfo: vi.fn(),
}));

afterEach(() => {
  assetCacheManager.invalidate();
  showDeleteModal.set(true);
  vi.clearAllMocks();
});

it.each(['next', 'previous'] as const)(
  'continues to the %s asset on two deletes when the next cursor loads across the first completion',
  async (direction) => {
    const [a, b, c] = assetFactory.buildList(3, { isTrashed: true });
    let cResponseResolve!: (value: AssetResponseDto | PromiseLike<AssetResponseDto>) => void;
    const cResponse = {
      promise: new Promise<AssetResponseDto>((resolve) => {
        cResponseResolve = resolve;
      }),
      resolve: (value: AssetResponseDto) => cResponseResolve(value),
    };
    let deletionResolve!: (value: void | PromiseLike<void>) => void;
    const deletion = {
      promise: new Promise<void>((resolve) => {
        deletionResolve = resolve;
      }),
      resolve: (value: void) => deletionResolve(value),
    };
    deleteRequest.mockReturnValueOnce(deletion.promise).mockResolvedValueOnce(undefined);
    vi.mocked(getAssetInfo).mockImplementation(({ id }) => (id === c.id ? cResponse.promise : Promise.resolve(b)));
    const neighbor = vi.fn((asset: AssetResponseDto) =>
      Promise.resolve(asset.id === a.id ? b : asset.id === b.id ? c : undefined),
    );
    const manager = {
      getEarlierAsset: direction === 'next' ? neighbor : vi.fn().mockResolvedValue(undefined),
      getLaterAsset: direction === 'previous' ? neighbor : vi.fn().mockResolvedValue(undefined),
      removeAssets: vi.fn(),
    };
    vi.mocked(navigate).mockImplementation((options) => {
      if (options.assetId === b.id) {
        assetViewerManager.setAsset(b);
      }
      if (options.assetId === c.id) {
        assetViewerManager.setAsset(c);
      }
      return Promise.resolve();
    });
    assetViewerManager.setAsset(a);
    showDeleteModal.set(false);
    const view = renderWithTooltips(TimelineAssetViewer, {
      timelineManager: manager as unknown as TimelineManager,
      invisible: false,
    });
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: b.id })));
    await fireEvent.click(await view.findByRole('button', { name: 'permanently_delete' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalledWith(expect.objectContaining({ id: c.id })));
    deletion.resolve();
    // Wait for the actual onAction/cache invalidation continuation before the neighbor response.
    await waitFor(() => expect(view.getByTestId('completed')).toHaveTextContent(a.id));
    cResponse.resolve(c);
    await waitFor(() => expect(view.getByTestId('current')).toHaveTextContent(b.id));
    await fireEvent.click(view.getByRole('button', { name: 'permanently_delete' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ assetId: c.id })));
    expect(vi.mocked(navigate).mock.calls.some(([options]) => options.assetId === null)).toBe(false);
    expect(assetViewerManager.asset?.id).toBe(c.id);
  },
);
