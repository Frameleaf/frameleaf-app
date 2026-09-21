import type { TimeBucketsResponseDto, TimeBucketAssetResponseDto } from '@immich/sdk';
import { tick } from 'svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';
import { timelineAssetFactory, toResponseDto } from '@test-data/factories/asset-factory';
import { TimelineManager } from './timeline-manager.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'owner-a' }, params: {} },
}));
const month = { year: 2024, month: 1 };
const buckets = [{ count: 1, timeBucket: '2024-01-01' }];
let timeline: TimelineManager;
beforeEach(() => {
  vi.clearAllMocks();
  authManager.user.id = 'owner-a';
  sdkMock.getTimeBuckets.mockResolvedValue(buckets);
  timeline = new TimelineManager();
});
afterEach(() => timeline.destroy());

it.each([
  ['lock-only action', () => eventManager.emit('SessionLocked')],
  ['PIN reset', () => eventManager.emit('UserPinCodeReset')],
  ['access change', () => eventManager.emit('SessionAccessChanged', { isElevated: false })],
] as const)(
  'clears and refetches timeline scope on %s, rejecting a non-cancellable old bucket',
  async (_name, restrict) => {
    await timeline.updateOptions({ isFavorite: true });
    const oldMonth = timeline.months[0];
    let resolve!: (response: TimeBucketAssetResponseDto) => void;
    sdkMock.getTimeBucket.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const oldLoad = timeline.loadTimelineMonth(month, { cancelable: false });
    const signal = sdkMock.getTimeBucket.mock.calls[0][1]?.signal;
    restrict();
    expect(timeline.months).toEqual([]);
    expect(timeline.scrubberMonths).toEqual([]);
    expect(signal?.aborted).toBe(true);
    await tick();
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledTimes(2);
    expect(sdkMock.getTimeBuckets.mock.calls[1][0]).toMatchObject({ isFavorite: true });
    resolve(
      toResponseDto(timelineAssetFactory.build({ localDateTime: fromISODateTimeUTCToObject('2024-01-01T00:00:00Z') })),
    );
    await oldLoad;
    expect(oldMonth.getAssets()).toEqual([]);
    expect(timeline.albumAssets.size).toBe(0);
  },
);

it('aborts stale month counts so an older scope cannot replace the post-lock collection', async () => {
  let resolve!: (response: TimeBucketsResponseDto[]) => void;
  sdkMock.getTimeBuckets
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    )
    .mockResolvedValueOnce([]);
  const oldLoad = timeline.updateOptions({ isFavorite: true });
  await tick();
  const signal = sdkMock.getTimeBuckets.mock.calls[0][1]?.signal;
  eventManager.emit('SessionLocked');
  expect(signal?.aborted).toBe(true);
  await tick();
  resolve([{ count: 999, timeBucket: '2020-01-01' }]);
  await oldLoad;
  expect(timeline.months).toEqual([]);
  expect(timeline.assetCount).toBe(0);
});

it.each([
  ['logout', () => eventManager.emit('AuthLogout')],
  ['deleted session', () => eventManager.emit('SessionDelete')],
  [
    'different account',
    () => {
      authManager.user.id = 'owner-b';
      eventManager.emit('AuthUserLoaded', authManager.user);
    },
  ],
] as const)('retires the old timeline after %s instead of requesting its old scoped filters', async (_name, revoke) => {
  await timeline.updateOptions({ personId: 'private-person' });
  revoke();
  expect(timeline.months).toEqual([]);
  await timeline.refresh();
  await timeline.updateViewport({ width: 100, height: 100 });
  expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
});

it('ignores a delayed pre-lock error without resetting the newly initialized timeline', async () => {
  let reject!: (error: Error) => void;
  sdkMock.getTimeBuckets.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const oldLoad = timeline.updateOptions({ isFavorite: true });
  await tick();
  eventManager.emit('SessionLocked');
  await tick();
  await vi.waitFor(() => expect(timeline.months).toHaveLength(1));
  reject(new Error('old permission response'));
  await oldLoad;
  expect(timeline.months).toHaveLength(1);
  expect(timeline.isInitialized).toBe(true);
});

it.each(['upsertAssets', 'upsertAssetsFromLiveEvent'] as const)(
  'does not refresh a retired sensitive-only timeline through %s',
  async (method) => {
    await timeline.updateOptions({ sensitiveOnly: true });
    eventManager.emit('AuthLogout');
    const refresh = vi.spyOn(timeline, 'refresh');
    timeline[method]([timelineAssetFactory.build()]);
    expect(refresh).not.toHaveBeenCalled();
    expect(timeline.assetCount).toBe(0);
    expect(sdkMock.getTimeBuckets).toHaveBeenCalledOnce();
  },
);
