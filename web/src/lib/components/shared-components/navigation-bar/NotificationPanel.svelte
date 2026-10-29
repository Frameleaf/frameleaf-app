<script lang="ts">
  import { goto } from '$app/navigation';
  import { focusTrap } from '$lib/actions/focus-trap';
  import NotificationItem from '$lib/components/shared-components/navigation-bar/NotificationItem.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { notificationManager } from '$lib/stores/notification-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { NotificationType, type NotificationDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiBellOutline, mdiClose } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { motionFlip } from '$lib/frameleaf/motion';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';

  /**
   * The notifications panel, in the prototype's design (`SystemPanels.jsx` NotificationsPanel).
   *
   * Notifications only (SHELL-P1, owner 2026-10-16): opening one marks it read, goes to its target
   * and closes the panel. Work in progress is not listed here; the top bar's activity ring and the
   * Activity page own it.
   */

  /** `onClose` is the close button; `onNavigate` is a row taking the person somewhere else. */
  let { onClose, onNavigate }: { onClose?: () => void; onNavigate?: () => void } = $props();

  const titleId = 'fl-notifications-title';
  let panel = $state<HTMLElement>();
  const unreadCount = $derived(notificationManager.notifications.length);
  const noUnreadNotifications = $derived(unreadCount === 0);

  // As in the prototype, the panel takes focus when it opens so the keyboard starts inside it.
  onMount(() => panel?.focus());

  let alive = true;
  onDestroy(() => {
    alive = false;
  });
  const capturePanel = () => {
    const isCurrentSession = authManager.captureSession();
    return () => alive && isCurrentSession();
  };

  const markAsRead = async (id: string) => {
    const isCurrent = capturePanel();
    try {
      await notificationManager.markAsRead(id);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('errors.failed_to_update_notification_status'));
      }
    }
  };

  const markAllAsRead = async () => {
    const isCurrent = capturePanel();
    try {
      await notificationManager.markAllAsRead();
      if (isCurrent()) {
        toastManager.info($t('marked_all_as_read'));
      }
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('errors.failed_to_update_notification_status'));
      }
    }
  };

  const handleNotificationAction = async (notification: NotificationDto) => {
    switch (notification.type) {
      case NotificationType.AlbumInvite:
      case NotificationType.AlbumUpdate: {
        if (!notification.data) {
          return;
        }

        if (typeof notification.data !== 'string') {
          return;
        }

        const data = JSON.parse(notification.data);
        if (data?.albumId) {
          await goto(`/albums/${data.albumId}`);
        }

        break;
      }

      // FL-83 (AL-30b): items shared with you one by one open under Sharing › Shared with you.
      case NotificationType.ItemShare: {
        await goto(`${Route.sharing()}?section=shared-with-you`);
        break;
      }

      case NotificationType.ClusterGroupRequest: {
        await goto(Route.userSettings({ isOpen: OpenQueryParam.SHARING }));
        break;
      }

      // FL-55: a mention or a reply opens the space's own viewer on the item, or the space's activity
      // panel for a comment on the space itself.
      case NotificationType.SharedSpaceMention:
      case NotificationType.SharedSpaceReply: {
        if (typeof notification.data !== 'string') {
          return;
        }
        const data = JSON.parse(notification.data);
        if (!data?.albumId) {
          return;
        }
        await goto(
          data.assetId
            ? Route.viewSharedSpaceAsset({ spaceId: data.albumId, assetId: data.assetId })
            : `${Route.viewSharedSpace({ id: data.albumId })}?panel=activity`,
        );
        break;
      }

      // FL-657: a library data snapshot that didn't finish opens Backup › On this server, with its retry.
      case NotificationType.BackupFailed: {
        const data: unknown = notification.data;
        const kind = data && typeof data === 'object' ? (data as { kind?: unknown }).kind : undefined;
        if (kind === 'library-snapshot-failed') {
          await goto(backupPageUrl('local'));
        }
        break;
      }

      // The Immich import's report of originals that came across without a file opens Missing media.
      case NotificationType.SystemMessage: {
        const data = typeof notification.data === 'string' ? JSON.parse(notification.data) : notification.data;
        if (data?.kind === 'immich-import-lost-originals') {
          await goto(Route.missingMediaUtility());
        }
        break;
      }

      default: {
        break;
      }
    }
  };

  /** The prototype's per-row dismiss (SystemPanels.jsx `notif-dismiss`, September 24 "Small actions"). */
  const dismiss = async (notification: NotificationDto) => {
    const isCurrent = capturePanel();
    try {
      await notificationManager.dismiss(notification.id);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('errors.frameleaf_notification_dismiss_failed'));
      }
    }
  };

  // The prototype's `open`: mark it read, go to its target, close the panel.
  const onclick = async (notification: NotificationDto) => {
    const isCurrent = capturePanel();
    await markAsRead(notification.id);
    if (!isCurrent()) {
      return;
    }
    try {
      await handleNotificationAction(notification);
      onNavigate?.();
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('errors.something_went_wrong'));
      }
    }
  };
</script>

<div
  bind:this={panel}
  id="notification-panel"
  class="fl-notif-panel"
  role="dialog"
  aria-labelledby={titleId}
  tabindex="-1"
  use:focusTrap
>
  <header class="fl-notif-head">
    <h2 id={titleId}>{$t('notifications')}</h2>
    {#if !noUnreadNotifications}
      <button type="button" class="fl-text-button" onclick={() => markAllAsRead()}>{$t('mark_all_as_read')}</button>
    {/if}
    {#if onClose}
      <button type="button" class="fl-icon-button" aria-label={$t('frameleaf_notifications_close')} onclick={onClose}>
        <Icon icon={mdiClose} size="18" aria-hidden="true" />
      </button>
    {/if}
  </header>

  <div class="fl-notif-body">
    {#if noUnreadNotifications}
      <div class="fl-notif-empty">
        <Icon icon={mdiBellOutline} size="28" aria-hidden="true" />
        <p>{$t('frameleaf_notifications_empty')}</p>
        <span>{$t('frameleaf_notifications_empty_help')}</span>
      </div>
    {:else}
      <ul class="fl-notif-list">
        {#each notificationManager.notifications as notification (notification.id)}
          <li animate:motionFlip={{ duration: 400 }}>
            <NotificationItem {notification} {onclick} />
            <button
              type="button"
              class="fl-icon-button fl-notif-dismiss"
              aria-label={$t('frameleaf_notifications_dismiss', { values: { title: notification.title } })}
              title={$t('dismiss')}
              onclick={() => void dismiss(notification)}
            >
              <Icon icon={mdiClose} size="14" aria-hidden="true" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <footer class="fl-notif-foot">
    {unreadCount > 0
      ? $t('frameleaf_notifications_unread_count', { values: { count: unreadCount } })
      : $t('frameleaf_notifications_nothing_unread')}
  </footer>
</div>

<style>
  /* Placed by the top bar's anchor (FL-30); on phones it becomes the prototype's bottom sheet. */
  .fl-notif-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(400px, calc(100vw - 32px));
    max-height: min(640px, calc(100dvh - 80px));
    background: var(--fl-panel);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    font-size: var(--fl-font-size);
    line-height: 1.45;
    transform-origin: top right;
    animation: fl-notif-in var(--fl-motion) var(--fl-ease);
  }
  .fl-notif-panel:focus {
    outline: none;
  }
  @keyframes fl-notif-in {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.98);
    }
  }
  @keyframes fl-notif-sheet-in {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
  }
  .fl-notif-foot {
    padding: 0.5rem 1rem;
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .fl-notif-head {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.75rem 0.625rem 0.75rem 1rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-notif-head h2 {
    flex: 1;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .fl-text-button {
    padding: 0.25rem 0.5rem;
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-text-button:hover,
  .fl-text-button:focus-visible {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .fl-icon-button {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: var(--fl-radius-control);
    color: var(--fl-muted);
  }
  .fl-icon-button:hover,
  .fl-icon-button:focus-visible {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .fl-notif-body {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .fl-notif-list {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: var(--fl-space-2);
    list-style: none;
  }
  /* Per-notification dismiss: bottom-right of the row, revealed on hover or focus (system.css). */
  .fl-notif-list li {
    position: relative;
  }
  .fl-notif-dismiss {
    position: absolute;
    right: 6px;
    bottom: 6px;
    width: 26px;
    height: 26px;
    /* Its own size, not the global touch-target floor, so it never covers the row's text. */
    min-width: 26px;
    min-height: 26px;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-notif-list li:is(:hover, :focus-within) .fl-notif-dismiss {
    opacity: 1;
  }
  @media (hover: none) {
    .fl-notif-dismiss {
      opacity: 1;
    }
  }
  .fl-notif-empty {
    display: grid;
    justify-items: center;
    gap: 0.375rem;
    padding: 2.25rem 1.5rem;
    text-align: center;
    color: var(--fl-muted);
  }
  .fl-notif-empty p {
    margin: 0.25rem 0 0;
    color: var(--fl-text);
    font-weight: 600;
  }
  .fl-notif-empty span {
    font-size: var(--fl-font-small);
  }
  /* Phones: the prototype's bottom sheet. */
  @media (max-width: 700px) {
    .fl-notif-panel {
      position: fixed;
      z-index: 40;
      top: auto;
      right: 0;
      bottom: 0;
      left: 0;
      width: auto;
      max-height: 82dvh;
      border-bottom: 0;
      border-radius: 14px 14px 0 0;
      transform-origin: bottom center;
      animation-name: fl-notif-sheet-in;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-notif-panel {
      animation: none;
    }
  }
</style>
