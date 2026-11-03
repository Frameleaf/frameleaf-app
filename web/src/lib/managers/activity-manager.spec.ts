import { ReactionType, type ActivityResponseDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { activityManager } from './activity-manager.svelte';
import { authManager } from './auth-manager.svelte';
import { eventManager } from './event-manager.svelte';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const comment = (id: string) => ({ id, type: ReactionType.Comment }) as ActivityResponseDto;

describe('activity view ownership', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.reset();
    authManager.setUser({ id: 'user' } as never);
    activityManager.reset();
    eventManager.emit('AuthLogout');
    sdkMock.getActivities.mockImplementation((args) =>
      Promise.resolve(args.userId ? [] : [comment(args.assetId ?? args.albumId)]),
    );
    sdkMock.getActivityStatistics.mockResolvedValue({ comments: 1, likes: 0 });
    sdkMock.deleteActivity.mockResolvedValue(undefined as never);
  });

  it('does not replace a newer asset with an older response', async () => {
    const old = deferred<ActivityResponseDto[]>();
    sdkMock.getActivities.mockImplementation((args) =>
      args.assetId === 'old' && !args.userId ? old.promise : Promise.resolve(args.userId ? [] : [comment('new')]),
    );
    const pending = activityManager.init('album', 'old');
    await activityManager.init('album', 'new');
    old.resolve([comment('old')]);
    await pending;
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['new']);
    expect(activityManager.isLoading).toBe(false);
  });

  it('loads an album’s own activity once while the album stays open', async () => {
    await Promise.all([activityManager.init('open-album'), activityManager.init('open-album')]);
    await activityManager.init('open-album');
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(1);
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['open-album']);

    // one of its items is a view of its own; coming back shows the album's activity again
    await activityManager.init('open-album', 'item');
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['item']);
    await activityManager.init('open-album');
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['open-album']);
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(2);
  });

  it('asks again for an album whose cached activity a late reaction dropped', async () => {
    const created = deferred<ActivityResponseDto>();
    sdkMock.createActivity.mockReturnValue(created.promise as never);
    await activityManager.init('react-album', 'item');
    const reacting = activityManager.addActivity({ albumId: 'react-album', assetId: 'item', type: ReactionType.Like });
    await activityManager.init('react-album');
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(2);

    created.resolve({ id: 'like', type: ReactionType.Like } as ActivityResponseDto);
    await reacting;
    await activityManager.init('react-album');
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(3);
  });

  it('lets a repeated init wait for the load already running', async () => {
    const pending = deferred<ActivityResponseDto[]>();
    sdkMock.getActivities.mockImplementation((args) => (args.userId ? Promise.resolve([]) : pending.promise));
    const first = activityManager.init('open-album');
    const second = activityManager.init('open-album');
    pending.resolve([comment('open-album')]);
    await second;
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['open-album']);
    await first;
  });

  it('asks again for an album whose activity failed to load', async () => {
    sdkMock.getActivityStatistics.mockRejectedValueOnce(new Error('offline'));
    await activityManager.init('open-album');
    expect(activityManager.activities).toEqual([]);
    await activityManager.init('open-album');
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(2);
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['open-album']);
  });

  it('discards a response after reset', async () => {
    const old = deferred<ActivityResponseDto[]>();
    sdkMock.getActivities.mockImplementation((args) => (args.userId ? Promise.resolve([]) : old.promise));
    const pending = activityManager.init('reset-album', 'old');
    activityManager.reset();
    old.resolve([comment('old')]);
    await pending;
    expect(activityManager.activities).toEqual([]);
    expect(activityManager.isLoading).toBe(false);
  });

  it('does not reuse another account’s cached asset activities', async () => {
    await activityManager.init('cached-album', 'same');
    authManager.setUser({ id: 'other' } as never);
    sdkMock.getActivities.mockImplementation((args) => Promise.resolve(args.userId ? [] : [comment('other')]));
    await activityManager.init('cached-album', 'same');
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['other']);
    expect(sdkMock.getActivities).toHaveBeenCalledWith(expect.objectContaining({ userId: 'other' }));
  });

  it('clears loading on failure', async () => {
    sdkMock.getActivities.mockRejectedValue(new Error('offline'));
    await expect(activityManager.refreshActivities('failed-album')).rejects.toThrow('offline');
    expect(activityManager.isLoading).toBe(false);
  });

  it('removes the requested row and retains the rest when an index is supplied', async () => {
    sdkMock.getActivities.mockImplementation((args) =>
      Promise.resolve(args.userId ? [] : [comment('a'), comment('b')]),
    );
    await activityManager.init('delete-album');
    sdkMock.getActivities.mockReturnValue(new Promise(() => {}));
    await activityManager.deleteActivity(comment('b'), 1);
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['a']);
  });

  it('does not change a newer view when an old like finishes', async () => {
    await activityManager.init('like-album', 'old');
    const pendingLike = deferred<ActivityResponseDto>();
    sdkMock.createActivity.mockReturnValue(pendingLike.promise);
    const pending = activityManager.toggleLike();
    await activityManager.init('like-album', 'new');
    pendingLike.resolve({ id: 'old-like', type: ReactionType.Like } as ActivityResponseDto);
    await pending;
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['new']);
    expect(activityManager.isLiked).toBeNull();
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(2);
    await activityManager.init('like-album', 'old');
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(3);
  });

  it('does not decrement a newer view when an old deletion finishes', async () => {
    await activityManager.init('late-delete-album', 'old');
    const deletion = deferred<void>();
    sdkMock.deleteActivity.mockReturnValue(deletion.promise as never);
    const pending = activityManager.deleteActivity(comment('old'));
    await activityManager.init('late-delete-album', 'new');
    deletion.resolve();
    await pending;
    expect(activityManager.commentCount).toBe(1);
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['new']);
    expect(sdkMock.getActivityStatistics).toHaveBeenCalledTimes(2);
  });

  it('keeps the displayed row and count when deletion fails', async () => {
    await activityManager.init('failed-delete-album', 'row');
    sdkMock.deleteActivity.mockRejectedValue(new Error('denied'));
    await expect(activityManager.deleteActivity(comment('row'))).rejects.toThrow('denied');
    expect(activityManager.commentCount).toBe(1);
    expect(activityManager.activities.map(({ id }) => id)).toEqual(['row']);
  });

  it('clears cached data and like state on logout', async () => {
    const like = { id: 'like', type: ReactionType.Like } as ActivityResponseDto;
    sdkMock.getActivities.mockImplementation((args) => Promise.resolve(args.userId ? [like] : [comment('row')]));
    await activityManager.init('logout-album', 'row');
    eventManager.emit('AuthLogout');
    expect(activityManager.activities).toEqual([]);
    expect(activityManager.isLiked).toBeNull();
    expect(activityManager.commentCount).toBe(0);
  });
});
