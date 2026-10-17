import { NotificationLevel, NotificationType, type NotificationDto } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { notificationManager } from '$lib/stores/notification-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import en from '../../../../../../i18n/en.json';
import fixtures from '../../../../../../server/test/fixtures/system-notification-locale.json';
import NotificationItem from './NotificationItem.svelte';
import NotificationPanel from './NotificationPanel.svelte';

vi.mock('$lib/utils/handle-error', async (original) => ({
  ...(await original<typeof import('$lib/utils/handle-error')>()),
  handleError: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const notification = (id: string, title: string): NotificationDto => ({
  id,
  title,
  description: '',
  createdAt: new Date().toISOString(),
  level: NotificationLevel.Info,
  type: NotificationType.SystemMessage,
});

beforeAll(() => {
  // The list reorders with animate:flip, which the test DOM does not implement.
  Element.prototype.getAnimations ??= () => [];
  Element.prototype.animate ??= () => ({ cancel: () => {}, finished: Promise.resolve() }) as unknown as Animation;
});

beforeEach(() => {
  vi.clearAllMocks();
  authManager.reset();
  addMessages('dev', en);
  notificationManager.notifications = [notification('a', 'Backup finished'), notification('b', 'Album shared')];
});

describe('NotificationPanel', () => {
  it.each(fixtures.cases)('displays supplied origin text verbatim: $name', ({ expected }) => {
    const { container } = render(NotificationItem, {
      notification: { ...notification('fixture', expected.title), description: expected.body },
      onclick: vi.fn(),
    });
    expect(screen.getByText(expected.title)).toBeInTheDocument();
    expect(screen.getByText(expected.body)).toBeInTheDocument();
    expect(container.querySelector('img, b')).toBeNull();
  });
  it('dismisses one notification on its own through the server', async () => {
    sdkMock.deleteNotification.mockResolvedValue(undefined as never);
    render(NotificationPanel);

    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss Backup finished' }));

    expect(sdkMock.deleteNotification).toHaveBeenCalledWith({ id: 'a' });
    expect(screen.queryByText('Backup finished')).toBeNull();
    expect(screen.getByText('Album shared')).toBeInTheDocument();
    // Dismissing is not opening: it neither marks anything read nor navigates.
    expect(sdkMock.updateNotification).not.toHaveBeenCalled();
  });

  it('lists notifications only: no running work, and the prototype empty state when nothing is unread', () => {
    notificationManager.notifications = [];
    render(NotificationPanel);

    expect(screen.getByText(en.frameleaf_notifications_empty)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_notifications_empty_help)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_running_title)).toBeNull();
  });

  it('closes after opening a notification, as the prototype does', async () => {
    sdkMock.updateNotification.mockResolvedValue(undefined as never);
    const onNavigate = vi.fn();
    render(NotificationPanel, { onNavigate });

    await fireEvent.click(screen.getByText('Album shared'));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());
    expect(sdkMock.updateNotification).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('brings a notification back when the server refuses to dismiss it', async () => {
    sdkMock.deleteNotification.mockRejectedValue(new Error('offline'));
    render(NotificationPanel);

    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss Backup finished' }));

    await waitFor(() => expect(screen.getByText('Backup finished')).toBeInTheDocument());
  });
});

describe('notificationManager.dismiss', () => {
  it('puts back only the notification whose dismiss failed', async () => {
    notificationManager.notifications = [notification('a', 'A'), notification('b', 'B'), notification('c', 'C')];
    let fail!: (reason: Error) => void;
    sdkMock.deleteNotification.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)) as never);
    sdkMock.updateNotification.mockResolvedValue(undefined as never);

    const pending = notificationManager.dismiss('b');
    // Meanwhile another one is read and leaves the list.
    await notificationManager.markAsRead('c');
    fail(new Error('offline'));

    await expect(pending).rejects.toThrow('offline');
    expect(notificationManager.notifications.map(({ id }) => id)).toEqual(['a', 'b']);
  });
});

it.each(['current', 'close', 'session'])('opens a read notification only for its panel owner: %s', async (change) => {
  notificationManager.notifications = [
    {
      ...notification('album', 'Album shared'),
      type: NotificationType.AlbumInvite,
      data: JSON.stringify({ albumId: 'album-id' }) as unknown as NotificationDto['data'],
    },
  ];
  const pending = deferredPromise<void>();
  sdkMock.updateNotification.mockReturnValueOnce(pending.promise as never);
  const view = render(NotificationPanel);
  await fireEvent.click(screen.getByText('Album shared'));
  expect(sdkMock.updateNotification).toHaveBeenCalled();
  if (change === 'close') {
    view.unmount();
  } else if (change === 'session') {
    authManager.reset();
  }
  pending.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(goto).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  if (change === 'current') {
    expect(goto).toHaveBeenCalledWith('/albums/album-id');
  }
});

it.each(['current', 'close', 'session'])('announces mark-all only for its panel owner: %s', async (change) => {
  const pending = deferredPromise<void>();
  sdkMock.updateNotifications.mockReturnValueOnce(pending.promise as never);
  const info = vi.spyOn(toastManager, 'info').mockImplementation(() => 'toast');
  try {
    const view = render(NotificationPanel);
    await fireEvent.click(screen.getByRole('button', { name: en.mark_all_as_read }));
    if (change === 'close') {
      view.unmount();
    } else if (change === 'session') {
      authManager.reset();
    }
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(info).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  } finally {
    info.mockRestore();
  }
});

it('reports malformed notification data without starting navigation', async () => {
  notificationManager.notifications = [
    {
      ...notification('bad', 'Malformed album'),
      type: NotificationType.AlbumInvite,
      data: '{broken' as unknown as NotificationDto['data'],
    },
  ];
  sdkMock.updateNotification.mockResolvedValueOnce(undefined as never);
  render(NotificationPanel);
  await fireEvent.click(screen.getByText('Malformed album'));
  await waitFor(() => expect(handleError).toHaveBeenCalledOnce());
  expect(goto).not.toHaveBeenCalled();
});

it('suppresses a mark-all failure after the panel closes', async () => {
  const pending = deferredPromise<void>();
  sdkMock.updateNotifications.mockReturnValueOnce(pending.promise as never);
  const view = render(NotificationPanel);
  await fireEvent.click(screen.getByRole('button', { name: en.mark_all_as_read }));
  view.unmount();
  pending.reject(new Error('Offline'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handleError).not.toHaveBeenCalled();
});
