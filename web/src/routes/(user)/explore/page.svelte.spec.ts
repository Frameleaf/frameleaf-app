import { getAssetInfo, type AssetResponseDto } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import type { PageData } from './$types';
import ExplorePage from './+page.svelte';

const callbacks = vi.hoisted(() => ({
  panel: undefined as { onViewAsset: (id: string) => Promise<void> } | undefined,
  viewer: undefined as
    | {
        onNavigateToAsset: (asset: { id: string }) => Promise<void>;
        onClose: () => void;
      }
    | undefined,
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/OnEvents.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ExplorePanel.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof callbacks.panel>) => {
    callbacks.panel = props;
  },
}));
vi.mock('$lib/components/asset-viewer/AssetViewer.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof callbacks.viewer>) => {
    callbacks.viewer = props;
  },
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), getAssetInfo: vi.fn() }));
vi.mock('$lib/utils/handle-error', async (original) => ({
  ...(await original<object>()),
  handleError: vi.fn(),
}));
const data = (recentCaptures: AssetResponseDto[] = []) =>
  ({
    error: undefined,
    asset: undefined,
    peopleCards: [],
    places: [],
    things: [],
    landmarks: [],
    landmarkAlbumSuggestion: null,
    memories: [],
    albums: [],
    recentCaptures,
    libraryTotal: 0,
    shortcutCounts: { favorites: 0, photos: 0, videos: 0, withoutPeople: 0 },
    bestPhotosPreview: { total: 0, cover: null },
    failed: { people: false, places: false, memories: false, albums: false, recents: false, landmarks: false },
    meta: { title: 'Explore' },
  }) as PageData;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAssetInfo).mockReset();
  callbacks.panel = undefined;
  callbacks.viewer = undefined;
  authManager.reset();
  assetViewerManager.showAssetViewer(false);
});
afterEach(() => assetViewerManager.showAssetViewer(false));

it('opens the current successful thumbnail request', async () => {
  const asset = assetFactory.build();
  vi.mocked(getAssetInfo).mockResolvedValue(asset);
  render(ExplorePage, { data: data() });
  await callbacks.panel!.onViewAsset(asset.id);
  expect(assetViewerManager.asset?.id).toBe(asset.id);
  expect(assetViewerManager.isViewing).toBe(true);
});

it.each(['close route', 'session', 'newer selection'] as const)('ignores a late thumbnail after %s', async (change) => {
  const old = deferredPromise<AssetResponseDto>();
  const current = assetFactory.build();
  vi.mocked(getAssetInfo).mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
  const view = render(ExplorePage, { data: data() });
  const pending = callbacks.panel!.onViewAsset('old');
  if (change === 'close route') {
    view.unmount();
  } else if (change === 'session') {
    authManager.reset();
  } else {
    await callbacks.panel!.onViewAsset(current.id);
  }
  old.resolve(assetFactory.build({ id: 'old' }));
  await pending;
  expect(assetViewerManager.isViewing).toBe(change === 'newer selection');
  if (change === 'newer selection') {
    expect(assetViewerManager.asset?.id).toBe(current.id);
  }
});

it.each([false, true])('handles an asset read failure only in its current route (retired: %s)', async (retired) => {
  const old = deferredPromise<AssetResponseDto>();
  vi.mocked(getAssetInfo).mockReturnValueOnce(old.promise);
  const view = render(ExplorePage, { data: data() });
  const pending = callbacks.panel!.onViewAsset('old');
  if (retired) {
    view.unmount();
  }
  old.reject(new Error('Offline'));
  await pending;
  expect(handleError).toHaveBeenCalledTimes(retired ? 0 : 1);
});

it('uses a cached recent capture and retires a pending neighbour when the viewer closes', async () => {
  const first = assetFactory.build();
  const next = assetFactory.build();
  const old = deferredPromise<AssetResponseDto>();
  vi.mocked(getAssetInfo).mockResolvedValueOnce(first).mockReturnValueOnce(old.promise);
  render(ExplorePage, { data: data([first, next]) });
  await callbacks.panel!.onViewAsset(first.id);
  await waitFor(() => expect(callbacks.viewer).toBeDefined());
  await callbacks.viewer!.onNavigateToAsset({ id: next.id });
  expect(assetViewerManager.asset?.id).toBe(next.id);
  expect(getAssetInfo).toHaveBeenCalledOnce();
  const pending = callbacks.viewer!.onNavigateToAsset({ id: 'outside-row' });
  callbacks.viewer!.onClose();
  await tick();
  old.resolve(assetFactory.build({ id: 'outside-row' }));
  await pending;
  expect(assetViewerManager.isViewing).toBe(false);
});
