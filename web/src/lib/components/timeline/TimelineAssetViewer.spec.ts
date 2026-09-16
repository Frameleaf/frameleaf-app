import { getAssetInfo } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
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
vi.mock('@immich/sdk', async () => ({
  ...(await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk')),
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
