import { getAssetInfo } from '@immich/sdk';
import { fireEvent, waitFor } from '@testing-library/svelte';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { navigate } from '$lib/utils/navigation';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
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

afterEach(() => vi.clearAllMocks());

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

it.each(['lock', 'account'] as const)('does not reopen deleted media when Undo lookup crosses %s', async (change) => {
  const asset = assetFactory.build();
  eventManager.emit('AuthUserLoaded', userAdminFactory.build());
  assetViewerManager.setAsset(asset);
  const timelineManager = {
    getEarlierAsset: vi.fn().mockResolvedValue(undefined),
    getLaterAsset: vi.fn().mockResolvedValue(undefined),
    upsertAssets: vi.fn(),
  };
  let resolve!: (value: typeof asset) => void;
  vi.mocked(getAssetInfo).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { findByRole } = renderWithTooltips(TimelineAssetViewer, {
    timelineManager: timelineManager as unknown as TimelineManager,
    invisible: false,
  });
  await fireEvent.click(await findByRole('button', { name: 'Undo deleted asset' }));
  await waitFor(() => expect(getAssetInfo).toHaveBeenCalledOnce());
  if (change === 'lock') {
    eventManager.emit('SessionLocked');
  } else {
    eventManager.emit('AuthUserLoaded', userAdminFactory.build());
  }
  resolve(asset);
  await waitFor(() => expect(assetViewerManager.isViewing).toBe(false));
  expect(assetViewerManager.asset).toBeUndefined();
  expect(navigate).not.toHaveBeenCalled();
});
