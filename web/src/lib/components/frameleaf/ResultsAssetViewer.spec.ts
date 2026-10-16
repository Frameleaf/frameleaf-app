import { render, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { navigateToAsset } from '$lib/utils/asset-utils';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import ResultsAssetViewer from './ResultsAssetViewer.svelte';

const mock = vi.hoisted(() => ({ random: undefined as (() => Promise<{ id: string } | undefined>) | undefined }));
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/components/asset-viewer/AssetViewer.svelte', () => ({
  default: (_anchor: unknown, props: { onRandom: () => Promise<{ id: string } | undefined> }) => {
    mock.random = props.onRandom;
  },
}));
vi.mock('$lib/utils/asset-utils', async (original) => ({ ...(await original<object>()), navigateToAsset: vi.fn() }));
vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  mock.random = undefined;
  authManager.reset();
});

it.each(['none', 'unmount', 'session', 'replacement'] as const)(
  'random result navigation respects %s ownership',
  async (retire) => {
    const [original, target, replacement] = assetFactory.buildList(3);
    const pending = deferredPromise<boolean>();
    vi.mocked(navigateToAsset).mockReturnValue(pending.promise);
    assetViewerManager.setAsset(original);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.75);
    try {
      const view = render(ResultsAssetViewer, { assets: [original, target] });
      await waitFor(() => expect(mock.random).toBeDefined());
      const done = mock.random!();
      switch (retire) {
        case 'unmount': {
          view.unmount();
          break;
        }
        case 'session': {
          authManager.reset();
          break;
        }
        case 'replacement': {
          assetViewerManager.setAsset(replacement);
          break;
        }
        default:
          assetViewerManager.setAsset(target);
      }
      pending.resolve(true);
      await expect(done).resolves.toEqual(retire === 'none' ? target : undefined);
    } finally {
      random.mockRestore();
    }
  },
);

it('does not report a navigation error from a retired results viewer', async () => {
  const asset = assetFactory.build();
  const pending = deferredPromise<boolean>();
  vi.mocked(navigateToAsset).mockReturnValue(pending.promise);
  assetViewerManager.setAsset(asset);
  const view = render(ResultsAssetViewer, { assets: [asset] });
  await waitFor(() => expect(mock.random).toBeDefined());
  const done = mock.random!();
  view.unmount();
  pending.reject(new Error('Offline'));
  await expect(done).resolves.toBeUndefined();
  expect(handleError).not.toHaveBeenCalled();
});
