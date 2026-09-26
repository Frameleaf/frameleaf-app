import { NotificationLevel, NotificationType, type NotificationDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { notificationManager } from '$lib/stores/notification-manager.svelte';
import en from '../../../../../../i18n/en.json';
import NotificationPanel from './NotificationPanel.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/frameleaf/running-jobs-session.svelte', () => ({
  runningJobsSession: { rows: [], activeCount: 0, watch: () => () => {}, setPanelOpen: vi.fn() },
}));
vi.mock('$lib/components/frameleaf/RunningJobsSection.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

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
  addMessages('dev', en);
  notificationManager.notifications = [notification('a', 'Backup finished'), notification('b', 'Album shared')];
});

describe('NotificationPanel', () => {
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
