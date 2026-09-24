import {
  deleteNotification,
  getNotifications,
  updateNotification,
  updateNotifications,
  type NotificationDto,
} from '@immich/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';

class NotificationStore {
  notifications = $state<NotificationDto[]>([]);

  constructor() {
    eventManager.on({
      AuthLogin: () => this.refresh(),
      AuthLogout: () => this.clear(),
    });
  }

  async refresh() {
    try {
      this.notifications = await getNotifications({ unread: true });
    } catch (error) {
      const translate = get(t);
      handleError(error, translate('errors.failed_to_load_notifications'));
    }
  }

  markAsRead = async (id: string) => {
    this.notifications = this.notifications.filter((notification) => notification.id !== id);
    await updateNotification({ id, notificationUpdateDto: { readAt: new Date().toISOString() } });
  };

  markAllAsRead = async () => {
    const ids = this.notifications.map(({ id }) => id);
    this.notifications = [];
    await updateNotifications({ notificationUpdateAllDto: { ids, readAt: new Date().toISOString() } });
  };

  /**
   * Dismisses one notification for good (`DELETE /notifications/:id`), as the prototype's per-row
   * dismiss does (`dismissNotification`, SystemPanels.jsx). It leaves the list at once and comes
   * back if the server refuses, so a failed dismiss never loses a notification silently.
   */
  dismiss = async (id: string) => {
    const index = this.notifications.findIndex((notification) => notification.id === id);
    if (index === -1) {
      return;
    }
    const dismissed = this.notifications[index];
    this.notifications = this.notifications.filter((notification) => notification.id !== id);
    try {
      await deleteNotification({ id });
    } catch (error) {
      // Only the failed one comes back, where it was; anything read or dismissed meanwhile stays gone.
      if (this.notifications.every((notification) => notification.id !== id)) {
        const next = [...this.notifications];
        next.splice(Math.min(index, next.length), 0, dismissed);
        this.notifications = next;
      }
      throw error;
    }
  };

  clear = () => {
    this.notifications = [];
  };
}

export const notificationManager = new NotificationStore();
