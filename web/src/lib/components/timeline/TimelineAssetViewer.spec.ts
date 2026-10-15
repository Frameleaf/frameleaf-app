import { getAssetInfo } from '@frameleaf/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import TimelineAssetViewer from './TimelineAssetViewer.svelte';

vi.mock('$lib/components/asset-viewer/AssetViewer.svelte', async () => {
  const { default: MockViewerControls } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: MockViewerControls };
});
vi.mock('$lib/utils/navigation', async () => ({
  ...(await vi.importActual<typeof import('$lib/utils/navigation')>('$lib/utils/navigation')),
  navigate: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async () => ({
  ...(await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk')),
  getAssetInfo: vi.fn(),
}));

describe('TimelineAssetViewer suppression', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([true, false])('removes the suppressed asset and leaves it (next asset: %s)', async (hasNext) => {
    const asset = assetFactory.build();
    const next = assetFactory.build();
    const timelineManager = {
      getEarlierAsset: vi.fn().mockResolvedValue(hasNext ? next : undefined),
      getLaterAsset: vi.fn().mockResolvedValue(undefined),
      removeAssets: vi.fn(),
    };
    vi.mocked(getAssetInfo).mockResolvedValue(next);
    assetViewerManager.setAsset(asset);
    const { findByRole } = renderWithTooltips(TimelineAssetViewer, {
      timelineManager: timelineManager as unknown as TimelineManager,
      invisible: false,
    });
    const button = await findByRole('button', { name: 'Suppress asset' });
    if (hasNext) {
      await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
    }

    await fireEvent.click(button);

    await waitFor(() => expect(timelineManager.removeAssets).toHaveBeenCalledWith([asset.id]));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRoute: 'current',
          assetId: hasNext ? next.id : null,
        }),
      ),
    );
  });
});

it.each(['none', 'unmount', 'session', 'viewer'])('undo delete respects %s ownership changes', async (retire) => {
  vi.clearAllMocks();
  let current = true;
  const session = vi.spyOn(authManager, 'captureSession').mockReturnValue(() => current);
  const [asset, replacement] = assetFactory.buildList(2);
  const request = deferredPromise<typeof asset>();
  vi.mocked(getAssetInfo).mockReturnValue(request.promise);
  const manager = {
    getEarlierAsset: vi.fn().mockResolvedValue(undefined),
    getLaterAsset: vi.fn().mockResolvedValue(undefined),
    removeAssets: vi.fn(),
    upsertAssets: vi.fn(),
  };
  assetViewerManager.setAsset(asset);
  try {
    const view = renderWithTooltips(TimelineAssetViewer, {
      timelineManager: manager as unknown as TimelineManager,
      invisible: false,
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Undo delete' }));
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
    expect(manager.upsertAssets).toHaveBeenCalled();
    switch (retire) {
      case 'unmount': {
        view.unmount();
        break;
      }
      case 'session': {
        current = false;
        break;
      }
      case 'viewer': {
        assetViewerManager.setAsset(replacement);
        break;
      }
      // No default
    }
    request.resolve(asset);
    await tick();
    await tick();
    if (retire === 'none') {
      await waitFor(() => expect(navigate).toHaveBeenCalledWith({ targetRoute: 'current', assetId: asset.id }));
    } else {
      expect(navigate).not.toHaveBeenCalled();
      if (retire === 'viewer') {
        expect(assetViewerManager.asset?.id).toBe(replacement.id);
      }
    }
  } finally {
    session.mockRestore();
  }
});
