import { NotificationLevel, NotificationType, type NotificationDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { notificationManager } from './notification-manager.svelte';

const events = vi.hoisted<{
  AuthLogin?: (user: { userId: string }) => Promise<void>;
  AuthLogout?: () => void;
  AuthUserLoaded?: (user: { id: string }) => void;
}>(() => ({}));
const handleError = vi.hoisted(() => vi.fn());
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { on: (subscriptions: typeof events) => Object.assign(events, subscriptions) },
}));
vi.mock('$lib/utils/handle-error', () => ({ handleError }));

const notification = (id: string): NotificationDto => ({
  id,
  title: id,
  description: '',
  createdAt: '2026-10-14T00:00:00.000Z',
  level: NotificationLevel.Info,
  type: NotificationType.SystemMessage,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  notificationManager.clear();
  sdkMock.getNotifications.mockReset();
  sdkMock.deleteNotification.mockReset();
  sdkMock.updateNotification.mockReset().mockResolvedValue(notification('updated'));
  // Generated no-content SDK operations expose Promise<never>.
  sdkMock.updateNotifications.mockReset().mockResolvedValue(undefined as never);
  handleError.mockClear();
});

afterEach(() => notificationManager.clear());

it('cancels the previous refresh and keeps the newest response when requests finish out of order', async () => {
  const old = deferred<NotificationDto[]>();
  const latest = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const first = notificationManager.refresh();
  const oldSignal = sdkMock.getNotifications.mock.calls[0][1]?.signal;
  const second = notificationManager.refresh();
  latest.resolve([notification('new')]);
  await second;
  old.resolve([notification('old')]);
  await first;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['new']);
  expect(oldSignal?.aborted).toBe(true);
  expect(handleError).not.toHaveBeenCalled();
});

it('does not restore a previous account response after logout even when cancellation is ignored', async () => {
  const response = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(response.promise);
  const pending = notificationManager.refresh();
  const signal = sdkMock.getNotifications.mock.calls[0][1]?.signal;
  events.AuthLogout?.();
  response.resolve([notification('previous-account')]);
  await pending;
  expect(notificationManager.notifications).toEqual([]);
  expect(signal?.aborted).toBe(true);
});

it('clears the previous account immediately on login and reads the new account', async () => {
  notificationManager.notifications = [notification('previous-account')];
  const response = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(response.promise);
  const pending = events.AuthLogin?.({ userId: 'current-account' });
  expect(notificationManager.notifications).toEqual([]);
  response.resolve([notification('current-account')]);
  await pending;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['current-account']);
});

it.each(['read', 'read-all', 'dismiss'] as const)('does not let a pending refresh undo a local %s', async (action) => {
  notificationManager.notifications = [notification('a'), notification('b')];
  const response = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(response.promise);
  sdkMock.deleteNotification.mockResolvedValueOnce(undefined as never);
  const pending = notificationManager.refresh();
  const signal = sdkMock.getNotifications.mock.calls[0][1]?.signal;
  if (action === 'read') {
    await notificationManager.markAsRead('a');
  } else if (action === 'read-all') {
    await notificationManager.markAllAsRead();
  } else {
    await notificationManager.dismiss('a');
  }
  response.resolve([notification('a'), notification('b')]);
  await pending;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(action === 'read-all' ? [] : ['b']);
  expect(signal?.aborted).toBe(true);
});

it('ignores stale request errors while preserving error handling for the current request', async () => {
  const old = deferred<NotificationDto[]>();
  const latest = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const first = notificationManager.refresh();
  const second = notificationManager.refresh();
  old.reject(new Error('superseded'));
  await first;
  expect(handleError).not.toHaveBeenCalled();
  const error = new Error('active request failed');
  latest.reject(error);
  await second;
  expect(handleError).toHaveBeenCalledExactlyOnceWith(error, expect.any(String));
});

it('keeps a newer refresh cancellable when the older request finishes', async () => {
  const old = deferred<NotificationDto[]>();
  const latest = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const first = notificationManager.refresh();
  const second = notificationManager.refresh();
  const signal = sdkMock.getNotifications.mock.calls[1][1]?.signal;
  old.resolve([notification('old')]);
  await first;
  notificationManager.clear();
  expect(signal?.aborted).toBe(true);
  latest.resolve([notification('new')]);
  await second;
  expect(notificationManager.notifications).toEqual([]);
});

it('never rolls a failed dismiss back into another account', async () => {
  notificationManager.notifications = [notification('previous-account')];
  const response = deferred<never>();
  sdkMock.deleteNotification.mockReturnValueOnce(response.promise);
  const pending = notificationManager.dismiss('previous-account');
  notificationManager.clear();
  notificationManager.notifications = [notification('current-account')];
  response.reject(new Error('offline'));
  await expect(pending).rejects.toThrow('offline');
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['current-account']);
});

it('retains same-account rollback while another notification is read', async () => {
  notificationManager.notifications = [notification('a'), notification('b'), notification('c')];
  const response = deferred<never>();
  sdkMock.deleteNotification.mockReturnValueOnce(response.promise);
  const pending = notificationManager.dismiss('b');
  await notificationManager.markAsRead('c');
  response.reject(new Error('offline'));
  await expect(pending).rejects.toThrow('offline');
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['a', 'b']);
});

it('does not send a delete or cancel an active refresh for an absent notification', async () => {
  const response = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(response.promise);
  const pending = notificationManager.refresh();
  const signal = sdkMock.getNotifications.mock.calls[0][1]?.signal;
  await notificationManager.dismiss('missing');
  expect(sdkMock.deleteNotification).not.toHaveBeenCalled();
  expect(signal?.aborted).toBe(false);
  response.resolve([notification('new')]);
  await pending;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['new']);
});

it('retires old reads and dismiss rollback when AuthUserLoaded changes identity', async () => {
  sdkMock.getNotifications.mockResolvedValueOnce([notification('account-a')]);
  events.AuthUserLoaded?.({ id: 'a' });
  await notificationManager.refresh();
  const read = deferred<NotificationDto[]>();
  const write = deferred<never>();
  sdkMock.getNotifications.mockReturnValueOnce(read.promise);
  const pending = notificationManager.refresh();
  sdkMock.deleteNotification.mockReturnValueOnce(write.promise);
  const dismiss = notificationManager.dismiss('account-a');
  sdkMock.getNotifications.mockResolvedValueOnce([notification('account-b')]);
  events.AuthUserLoaded?.({ id: 'b' });
  expect(notificationManager.notifications).toEqual([]);
  await notificationManager.refresh();
  write.reject(new Error('old-account write failed'));
  await expect(dismiss).rejects.toThrow('old-account write failed');
  read.resolve([notification('account-a')]);
  await pending;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['account-b']);
});

it('does not clear or re-read notifications when AuthUserLoaded repeats the same identity', async () => {
  sdkMock.getNotifications.mockResolvedValueOnce([notification('account-a')]);
  events.AuthUserLoaded?.({ id: 'a' });
  await notificationManager.refresh();
  events.AuthUserLoaded?.({ id: 'a' });
  expect(sdkMock.getNotifications).toHaveBeenCalledTimes(1);
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['account-a']);
});

it.each(['read', 'read-all', 'dismiss'] as const)(
  'waits for a pending %s before issuing the newest refresh',
  async (action) => {
    notificationManager.notifications = [notification('a'), notification('b')];
    const write = deferred<never>();
    sdkMock.updateNotification.mockReturnValueOnce(write.promise);
    sdkMock.updateNotifications.mockReturnValueOnce(write.promise);
    sdkMock.deleteNotification.mockReturnValueOnce(write.promise);
    const mutation =
      action === 'read'
        ? notificationManager.markAsRead('a')
        : action === 'read-all'
          ? notificationManager.markAllAsRead()
          : notificationManager.dismiss('a');
    sdkMock.getNotifications.mockResolvedValueOnce([notification('stale')]);
    const old = notificationManager.refresh();
    const latest = notificationManager.refresh();
    expect(sdkMock.getNotifications).not.toHaveBeenCalled();
    write.reject(new Error('write failed'));
    await expect(mutation).rejects.toThrow('write failed');
    await Promise.all([old, latest]);
    expect(sdkMock.getNotifications).toHaveBeenCalledTimes(1);
  },
);

it('waits for every concurrent write before fetching and discards a waiting refresh on logout', async () => {
  notificationManager.notifications = [notification('a'), notification('b')];
  const a = deferred<NotificationDto>();
  const b = deferred<NotificationDto>();
  sdkMock.updateNotification.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
  const first = notificationManager.markAsRead('a');
  const second = notificationManager.markAsRead('b');
  const pending = notificationManager.refresh();
  a.resolve(notification('a'));
  await first;
  expect(sdkMock.getNotifications).not.toHaveBeenCalled();
  notificationManager.clear();
  b.resolve(notification('b'));
  await second;
  await pending;
  expect(sdkMock.getNotifications).not.toHaveBeenCalled();
  expect(notificationManager.notifications).toEqual([]);
});

it('coalesces refreshes during a successful write and reads the committed unread list once', async () => {
  notificationManager.notifications = [notification('a'), notification('b')];
  const write = deferred<NotificationDto>();
  sdkMock.updateNotification.mockReturnValueOnce(write.promise);
  const mutation = notificationManager.markAsRead('a');
  sdkMock.getNotifications.mockResolvedValueOnce([notification('b')]);
  const refreshes = [notificationManager.refresh(), notificationManager.refresh(), notificationManager.refresh()];
  expect(sdkMock.getNotifications).not.toHaveBeenCalled();
  write.resolve(notification('a'));
  await mutation;
  await Promise.all(refreshes);
  expect(sdkMock.getNotifications).toHaveBeenCalledTimes(1);
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['b']);
});

it('lets the new account refresh immediately without waiting for previous-account writes', async () => {
  notificationManager.notifications = [notification('old')];
  const write = deferred<NotificationDto>();
  sdkMock.updateNotification.mockReturnValueOnce(write.promise);
  const mutation = notificationManager.markAsRead('old');
  notificationManager.clear();
  sdkMock.getNotifications.mockResolvedValueOnce([notification('new')]);
  await notificationManager.refresh();
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['new']);
  write.resolve(notification('old'));
  await mutation;
  expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['new']);
});

it('does not read private notifications when a public frame observes the signed-in visitor', async () => {
  sdkMock.getNotifications.mockResolvedValue([]);
  events.AuthUserLoaded?.({ id: 'visitor' });
  events.AuthUserLoaded?.({ id: 'other-visitor' });
  expect(sdkMock.getNotifications).not.toHaveBeenCalled();
});

it('retires a previous account read on identity load without starting another private request', async () => {
  notificationManager.notifications = [notification('previous-account')];
  const response = deferred<NotificationDto[]>();
  sdkMock.getNotifications.mockReturnValueOnce(response.promise).mockResolvedValue([]);
  const pending = notificationManager.refresh();
  const signal = sdkMock.getNotifications.mock.calls[0][1]?.signal;
  events.AuthUserLoaded?.({ id: 'visitor' });
  expect(signal?.aborted).toBe(true);
  expect(notificationManager.notifications).toEqual([]);
  response.resolve([notification('previous-account')]);
  await pending;
  expect(sdkMock.getNotifications).toHaveBeenCalledTimes(1);
  expect(notificationManager.notifications).toEqual([]);
});
