import { toastManager } from '@frameleaf/ui';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory, timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { deleteAssets, updateStackedAssetInTimeline, updateUnstackedAssetInTimeline } from './actions';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it('awaits an asynchronous undo callback and owns its rejection', async () => {
  sdkMock.deleteAssets.mockResolvedValue(undefined as never);
  sdkMock.restoreAssets.mockResolvedValue({ count: 1 });
  const toast = vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
  const restored = deferredPromise<void>();
  const callback = vi.fn(() => restored.promise);
  const asset = toTimelineAsset(assetFactory.build());
  await deleteAssets(false, vi.fn(), [asset], callback);
  const content = toast.mock.calls[0][0] as { button: { onclick: () => Promise<void> } };
  const undo = content.button.onclick();
  await vi.waitFor(() => expect(callback).toHaveBeenCalledWith([asset]));
  const error = new Error('viewer lookup failed');
  restored.reject(error);
  await undo;
  expect(handleError).toHaveBeenCalledWith(error, expect.any(String));
  expect(sdkMock.restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: [asset.id] } });
});

describe('stack changes on a calendar-paged timeline', () => {
  const at = fromISODateTimeUTCToObject('2024-01-15T12:00:00.000Z');
  const primary = timelineAssetFactory.build({ id: 'primary', localDateTime: at, fileCreatedAt: at });
  const member = timelineAssetFactory.build({ id: 'member', localDateTime: at, fileCreatedAt: at, stack: null });
  const stack = { id: 'stack', primaryAssetId: 'primary', assetCount: 2 };
  const page = (count: number, last: string) => [
    { timeBucket: '2024-01-01', count, page: 0, after: null, firstAssetId: 'primary', lastAssetId: last },
  ];

  const pagedTimeline = async (count: number, last: string, assets: Parameters<typeof toResponseDto>) => {
    sdkMock.getTimeBuckets.mockResolvedValue(page(count, last));
    sdkMock.getTimeBucket.mockResolvedValue(toResponseDto(...assets));
    const manager = new TimelineManager();
    await manager.updateOptions({});
    await manager.loadTimelineMonth(manager.months[0].yearMonth, { cancelable: false });
    sdkMock.getTimeBuckets.mockClear();
    return manager;
  };

  // The viewer's Unstack: the pages move under the open Library, so it reads them again just once.
  it('reads the pages again once after an unstack, keeping the tiles until they arrive', async () => {
    const manager = await pagedTimeline(1, 'primary', [{ ...primary, stack }]);
    try {
      sdkMock.getTimeBuckets.mockResolvedValue(page(2, 'member'));
      updateUnstackedAssetInTimeline(manager, [{ ...primary, stack: null }, member]);
      await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
      expect(manager.assetCount).toBe(2);
    } finally {
      manager.destroy();
    }
  });

  it('reads the pages again once after a stack', async () => {
    const manager = await pagedTimeline(2, 'member', [primary, member]);
    try {
      sdkMock.getTimeBuckets.mockResolvedValue(page(1, 'primary'));
      updateStackedAssetInTimeline(manager, {
        stack: { id: 'stack', primaryAssetId: 'primary', assets: [] } as never,
        toDeleteIds: ['member'],
      });
      await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
      expect(manager.assetCount).toBe(1);
    } finally {
      manager.destroy();
    }
  });
});
