import { AssetVisibility, type TimeBucketAssetResponseDto } from '@immich/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import type { LibraryTimelineQuery } from './library-session';
import { LibraryTimelineSession } from './library-timeline-session.svelte';

it('keeps only the latest route scope when scopes change before initialization yields', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  let query: LibraryTimelineQuery = { scope: { kind: 'album', id: 'a' }, filters: {} };
  const session = new LibraryTimelineSession(() => query);
  const first = session.timeline.updateOptions(session.options);
  query = { scope: { kind: 'album', id: 'b' }, filters: {} };
  const second = session.timeline.updateOptions(session.options);
  await Promise.all([first, second]);
  expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ albumId: 'b' });
  expect(sdkMock.getTimeBuckets.mock.calls.some(([options]) => options.albumId === 'a')).toBe(false);
  session.destroy();
});

it('aborts old non-cancellable picker pages so they cannot repopulate membership in a new scope', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([{ count: 1, timeBucket: '2024-01-01' }]);
  const session = new LibraryTimelineSession(() => ({ scope: { kind: 'album-picker', id: 'a' }, filters: {} }));
  await session.timeline.updateOptions(session.options);
  let pendingResolve!: (value: TimeBucketAssetResponseDto | PromiseLike<TimeBucketAssetResponseDto>) => void;
  const pending = {
    promise: new Promise<TimeBucketAssetResponseDto>((resolve) => {
      pendingResolve = resolve;
    }),
    resolve: (value: TimeBucketAssetResponseDto) => pendingResolve(value),
  };
  sdkMock.getTimeBucket.mockReturnValueOnce(pending.promise);
  const load = session.timeline.loadTimelineMonth({ year: 2024, month: 1 }, { cancelable: false });
  const signal = sdkMock.getTimeBucket.mock.calls.at(-1)?.[1]?.signal;
  await session.timeline.updateOptions({ albumId: 'b' });
  expect(signal?.aborted).toBe(true);
  pending.resolve({ id: [] } as unknown as TimeBucketAssetResponseDto);
  await load;
  expect(session.timeline.albumAssets.size).toBe(0);
  session.destroy();
});

it('retains zero-result filters and restores album options after a picker round trip', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  let query: LibraryTimelineQuery = { scope: { kind: 'album', id: 'a' }, filters: { isFavorite: true } };
  const session = new LibraryTimelineSession(() => query);
  const manager = session.timeline;
  await manager.updateOptions(session.options);
  expect(session.query.filters.isFavorite).toBe(true);
  query = {
    scope: { kind: 'album-picker', id: 'a' },
    filters: { visibility: AssetVisibility.Timeline, withPartners: true },
  };
  await manager.updateOptions(session.options);
  expect(session.options).toEqual({ timelineAlbumId: 'a', visibility: AssetVisibility.Timeline, withPartners: true });
  query = { scope: { kind: 'album', id: 'a' }, filters: { isFavorite: true } };
  await manager.updateOptions(session.options);
  expect(session.timeline).toBe(manager);
  expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ albumId: 'a', isFavorite: true });
  session.destroy();
});

beforeEach(() => vi.clearAllMocks());

it('honors immediate Back to the original scope while a different scope is pending', async () => {
  sdkMock.getTimeBuckets.mockResolvedValue([]);
  const session = new LibraryTimelineSession(() => ({ scope: { kind: 'album', id: 'a' }, filters: {} }));
  await session.timeline.updateOptions(session.options);
  const away = session.timeline.updateOptions({ albumId: 'b' });
  const back = session.timeline.updateOptions(session.options);
  await Promise.all([away, back]);
  expect(sdkMock.getTimeBuckets.mock.calls.at(-1)?.[0]).toMatchObject({ albumId: 'a' });
  session.destroy();
});
