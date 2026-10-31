import type { TimeBucketAssetResponseDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { deferredPromise } from '@test-data/deferred';
import { TimelineManager } from './timeline-manager.svelte';

beforeEach(() => vi.resetAllMocks());

it('does not initialize a timeline destroyed before its options start loading', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const manager = new TimelineManager();
  const loading = manager.updateOptions({});
  manager.destroy();
  await loading;
  expect(sdkMock.getTimeBuckets).not.toHaveBeenCalled();
  expect(manager.isInitialized).toBe(false);
});

it('does not revive a destroyed timeline when its bucket list arrives', async () => {
  const response = deferredPromise<{ timeBucket: string; count: number }[]>();
  sdkMock.getTimeBuckets.mockReturnValueOnce(response.promise);
  const manager = new TimelineManager();
  const loading = manager.updateOptions({});
  await vi.waitFor(() => expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce());
  manager.destroy();
  response.resolve([{ timeBucket: '2024-01-01', count: 1 }]);
  await loading;
  expect(manager.months).toEqual([]);
  expect(manager.isInitialized).toBe(false);
});

it('aborts a month request on destruction even when navigation made it noncancellable', async () => {
  sdkMock.getTimeBuckets.mockResolvedValueOnce([{ timeBucket: '2024-01-01', count: 1 }]);
  const response = deferredPromise<TimeBucketAssetResponseDto>();
  sdkMock.getTimeBucket.mockReturnValueOnce(response.promise);
  const manager = new TimelineManager();
  await manager.updateOptions({});
  const month = manager.months[0];
  const loading = manager.loadTimelineMonth(month.yearMonth, { cancelable: false });
  const signal = sdkMock.getTimeBucket.mock.calls[0][1]?.signal;
  manager.destroy();
  expect(signal?.aborted).toBe(true);
  response.resolve({ id: [] } as unknown as TimeBucketAssetResponseDto);
  await loading;
  expect(manager.months).toEqual([]);
  expect(manager.isInitialized).toBe(false);
});
