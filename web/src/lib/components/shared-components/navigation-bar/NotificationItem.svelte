<script lang="ts">
  import { NotificationLevel, NotificationType, type NotificationDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAt,
    mdiBackupRestore,
    mdiImageAlbum,
    mdiImagePlus,
    mdiInformationOutline,
    mdiMessageBadgeOutline,
    mdiReply,
    mdiSync,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { locale, t } from 'svelte-i18n';

  /**
   * One notification, in the prototype's row design (`SystemPanels.jsx`): a tinted icon, the title
   * and body, when it arrived, and a dot while it is unread. What a click does is the panel's.
   */

  interface Props {
    notification: NotificationDto;
    onclick: (notification: NotificationDto) => void;
  }

  let { notification, onclick }: Props = $props();

  /** The icon's tint. Colour never carries meaning alone: the title says what happened. */
  const toneOf = (level: NotificationLevel) => {
    switch (level) {
      case NotificationLevel.Error: {
        return 'danger';
      }
      case NotificationLevel.Warning: {
        return 'warning';
      }
      case NotificationLevel.Success: {
        return 'success';
      }
      default: {
        return 'info';
      }
    }
  };

  const tone = $derived(toneOf(notification.level));

  const getIconType = (type: NotificationType) => {
    switch (type) {
      case NotificationType.BackupFailed: {
        return mdiBackupRestore;
      }
      case NotificationType.JobFailed: {
        return mdiSync;
      }
      case NotificationType.SystemMessage: {
        return mdiMessageBadgeOutline;
      }
      case NotificationType.Custom: {
        return mdiInformationOutline;
      }

      case NotificationType.AlbumInvite: {
        return mdiImageAlbum;
      }

      case NotificationType.AlbumUpdate: {
        return mdiImagePlus;
      }

      case NotificationType.SharedSpaceMention: {
        return mdiAt;
      }

      case NotificationType.SharedSpaceReply: {
        return mdiReply;
      }

      default: {
        return mdiInformationOutline;
      }
    }
  };

  const formatRelativeTime = (dateString: string): string => {
    try {
      const date = DateTime.fromISO(dateString);
      if (!date.isValid) {
        return dateString; // Return original string if parsing fails
      }
      // S-29: relative time in the display language, not always English.
      return date.setLocale($locale ?? 'en').toRelative() || dateString;
    } catch (error) {
      console.error('Error formatting relative time:', error);
      return dateString; // Fallback to original string on error
    }
  };
</script>

<button
  class="fl-notif-item"
  class:unread={!notification.readAt}
  type="button"
  onclick={() => onclick(notification)}
  title={notification.createdAt}
>
  {#if !notification.readAt}
    <span class="fl-notif-dot" aria-hidden="true"></span>
  {/if}
  <span
    class="fl-notif-icon"
    class:tone-info={tone === 'info'}
    class:tone-success={tone === 'success'}
    class:tone-warning={tone === 'warning'}
    class:tone-danger={tone === 'danger'}
    aria-hidden="true"
  >
    <Icon icon={getIconType(notification.type)} size="18" />
  </span>
  <span class="fl-notif-text">
    <strong>
      {notification.title}
      {#if !notification.readAt}
        <span class="fl-sr-only">, {$t('frameleaf_notifications_unread')}</span>
      {/if}
    </strong>
    {#if notification.description}
      <span>{notification.description}</span>
    {/if}
  </span>
  <time datetime={notification.createdAt}>{formatRelativeTime(notification.createdAt)}</time>
</button>

<style>
  .fl-notif-item {
    position: relative;
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.25rem 0.75rem;
    width: 100%;
    min-height: 44px;
    padding: 0.625rem;
    border-radius: var(--fl-radius-control);
    color: inherit;
    text-align: left;
  }
  .fl-notif-item:hover,
  .fl-notif-item:focus-visible {
    background: var(--fl-raised);
  }
  .fl-notif-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 10px;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .fl-notif-item:hover .fl-notif-icon {
    background: var(--fl-panel);
  }
  .fl-notif-icon.tone-info {
    color: var(--fl-blue);
  }
  .fl-notif-icon.tone-success {
    color: var(--fl-teal);
  }
  .fl-notif-icon.tone-warning {
    color: var(--fl-warning);
  }
  .fl-notif-icon.tone-danger {
    color: var(--fl-danger);
  }
  .fl-notif-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .fl-notif-text strong {
    font-weight: 500;
    color: var(--fl-muted);
  }
  .fl-notif-item.unread .fl-notif-text strong {
    font-weight: 600;
    color: var(--fl-text);
  }
  .fl-notif-text > span {
    overflow-wrap: anywhere;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  time {
    padding-top: 2px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    white-space: nowrap;
  }
  .fl-notif-dot {
    position: absolute;
    top: 50%;
    left: 2px;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    background: var(--fl-accent);
  }
  .fl-sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
</style>
