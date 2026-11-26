import {
  deleteNotification,
  getNotifications,
  updateNotification,
  updateNotifications,
  type NotificationDto,
} from '@frameleaf/sdk';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';

class NotificationStore {
  notifications = $state<NotificationDto[]>([]);
  #refresh: AbortController | undefined;
  #session = 0;
  #userId: string | undefined;
  #writes = new Set<Promise<void>>();
  /** FL-1796: this account's list was asked for; the socket (`on_notification`) keeps it current. */
  #asked = false;

  constructor() {
    eventManager.on({
      AuthLogin: ({ userId }) => {
        this.clear();
        this.#userId = userId;
        return this.refresh();
      },
      AuthLogout: () => this.clear(),
      // pushes sent while the socket was down were missed: read the list again
      WebsocketConnect: () => {
        if (this.#asked) {
          void this.refresh();
        }
      },
      AuthUserLoaded: ({ id }) => {
        if (id === this.#userId) {
          return;
        }
        this.clear();
        this.#userId = id;
      },
    });
  }

  /**
   * FL-1796: read the list once per account. The top bar asks on every mount; after the first
   * answer the server's pushes keep the list current, so later mounts ask nothing.
   */
  load() {
    return this.#asked ? Promise.resolve() : this.refresh();
  }

  async refresh() {
    this.#asked = true;
    this.#cancelRefresh();
    const request = new AbortController();
    this.#refresh = request;
    try {
      if (this.#writes.size > 0) {
        await Promise.all(this.#writes);
        if (this.#refresh !== request) {
          return;
        }
      }
      const notifications = await getNotifications({ unread: true }, { signal: request.signal });
      if (this.#refresh === request) {
        this.notifications = notifications;
      }
    } catch (error) {
      if (this.#refresh === request) {
        // a failed first read is asked again by the next mount
        this.#asked = false;
        handleError(error, get(t)('errors.failed_to_load_notifications'));
      }
    } finally {
      if (this.#refresh === request) {
        this.#refresh = undefined;
      }
    }
  }

  #cancelRefresh() {
    const request = this.#refresh;
    this.#refresh = undefined;
    request?.abort();
  }

  #beginWrite() {
    // A read already in flight could bring back what this write removes, so it is dropped here and
    // read again once the write is done (in the same account, unless a newer read started meanwhile).
    const cancelled = this.#refresh !== undefined;
    const session = this.#session;
    this.#cancelRefresh();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.#writes.add(pending);
    return () => {
      this.#writes.delete(pending);
      complete();
      if (cancelled && session === this.#session && this.#refresh === undefined) {
        void this.refresh();
      }
    };
  }

  markAsRead = async (id: string) => {
    const complete = this.#beginWrite();
    this.notifications = this.notifications.filter((notification) => notification.id !== id);
    try {
      await updateNotification({ id, notificationUpdateDto: { readAt: new Date().toISOString() } });
    } finally {
      complete();
    }
  };

  markAllAsRead = async () => {
    const complete = this.#beginWrite();
    const ids = this.notifications.map(({ id }) => id);
    this.notifications = [];
    try {
      await updateNotifications({ notificationUpdateAllDto: { ids, readAt: new Date().toISOString() } });
    } finally {
      complete();
    }
  };

  dismiss = async (id: string) => {
    const index = this.notifications.findIndex((notification) => notification.id === id);
    if (index === -1) {
      return;
    }
    const complete = this.#beginWrite();
    const session = this.#session;
    const dismissed = this.notifications[index];
    this.notifications = this.notifications.filter((notification) => notification.id !== id);
    try {
      await deleteNotification({ id });
    } catch (error) {
      // Restore only this row in the account that started the request.
      if (session === this.#session && this.notifications.every((notification) => notification.id !== id)) {
        const next = [...this.notifications];
        next.splice(Math.min(index, next.length), 0, dismissed);
        this.notifications = next;
      }
      throw error;
    } finally {
      complete();
    }
  };

  clear = () => {
    this.#cancelRefresh();
    this.#session++;
    this.#userId = undefined;
    this.#writes.clear();
    this.#asked = false;
    this.notifications = [];
  };
}

export const notificationManager = new NotificationStore();
