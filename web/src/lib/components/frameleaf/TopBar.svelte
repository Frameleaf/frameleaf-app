<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { clickOutside } from '$lib/actions/click-outside';
  import AccountMenu from '$lib/components/frameleaf/AccountMenu.svelte';
  import ActivityIndicator from '$lib/components/frameleaf/ActivityIndicator.svelte';
  import FrameleafLogo from '$lib/components/frameleaf/Logo.svelte';
  import UploadMenuButton from '$lib/components/frameleaf/UploadMenuButton.svelte';
  import NotificationPanel from '$lib/components/shared-components/navigation-bar/NotificationPanel.svelte';
  import SearchEntry from '$lib/components/frameleaf/SearchEntry.svelte';
  import ThemeButton from '$lib/components/shared-components/ThemeButton.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
  import '$lib/frameleaf/tokens.css';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getGlobalActions } from '$lib/services/app.service';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { notificationManager } from '$lib/stores/notification-manager.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, isAssetViewerRoute, isLockedFolderRoute, navigate } from '$lib/utils/navigation';
  import { getAuthStatus, lockAuthSession } from '@immich/sdk';
  import { ActionButton, Icon, IconButton, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiBellOutline,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiMenu,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf top bar (FL-30), ported from the prototype's `App.jsx` header.
   *
   * One search entry, Upload, the activity indicator, Notifications, the Locked toggle
   * as an icon, theme and the account menu. On phones the bar stays a fixed grid and
   * the activity indicator is hidden. Every control drives an existing production
   * service: the Locked toggle is the elevated session, Upload is the upload manager's
   * file dialog, Notifications is the notification manager.
   */

  type Props = {
    onUploadClick?: () => void;
    noBorder?: boolean;
  };

  let { onUploadClick, noBorder = false }: Props = $props();

  let showNotifications = $state(false);
  let bellButton = $state<HTMLButtonElement>();

  /** Close the panel; from the keyboard (Escape, its close button) focus goes back to the bell. */
  const closeNotifications = (returnFocus = false) => {
    showNotifications = false;
    if (returnFocus) {
      bellButton?.focus();
    }
  };
  let isElevated = $state(false);
  let isSessionLoading = $state(true);

  const unreadCount = $derived(notificationManager.notifications.length);
  // FL-104: background jobs the viewer may see (queues too, for administrators) are in the panel.
  const runningCount = $derived(runningJobsSession.activeCount);
  // The prototype's bell: "Notifications, 3 unread", plus what is running when anything is.
  const bellLabel = $derived(
    [
      unreadCount > 0
        ? $t('frameleaf_notifications_bell_unread', { values: { count: unreadCount } })
        : $t('notifications'),
      runningCount > 0 ? $t('frameleaf_running_bell', { values: { count: runningCount } }) : null,
    ]
      .filter(Boolean)
      .join(', '),
  );
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const isAdminRoute = $derived(page.url.pathname.startsWith('/admin'));
  const lockedLabel = $derived(isElevated ? $t('lock_sensitive_content') : $t('unlock_sensitive_content'));
  // Matches the drag-and-drop overlay's own defaults (FL-45): uploads made from an album
  // page join that album, and uploads made from the Locked area stay locked.
  const uploadAlbumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  const uploadIsLocked = $derived(isLockedFolderRoute(page.route?.id));
  // Casting is an existing production capability; the new bar keeps it rather than
  // dropping an action the legacy bar offered.
  const { Cast } = $derived(getGlobalActions($t));

  onMount(() => {
    void refreshNotifications();
    void refreshAuthStatus();

    // One poll for everything running; fast only while the panel is open or something runs.
    const stopRunningJobs = runningJobsSession.watch();
    const stopEvents = eventManager.on({
      SessionLocked: () => (isElevated = false),
      SessionAccessChanged: ({ isElevated: elevated }) => (isElevated = elevated),
    });

    return () => {
      stopRunningJobs();
      stopEvents();
    };
  });

  // Open panel: poll at the fast pace so its bars keep up; closed: back to following the work.
  $effect(() => {
    const open = showNotifications;
    untrack(() => runningJobsSession.setPanelOpen(open));
  });

  const refreshNotifications = async () => {
    try {
      await notificationManager.refresh();
    } catch (error) {
      console.error('Failed to load notifications on mount', error);
    }
  };

  const refreshAuthStatus = async () => {
    isSessionLoading = true;
    try {
      const status = await getAuthStatus();
      isElevated = status.isElevated;
    } catch (error) {
      console.error('Failed to load elevated session status', error);
    } finally {
      isSessionLoading = false;
    }
  };

  const isSensitiveRoute = (pathname: string) => {
    const roots = [Route.locked(), Route.suppressed()];
    return roots.some((root) => pathname === root || pathname.startsWith(`${root}/`));
  };

  const unlockSession = () => {
    // The PIN prompt is the only way into an elevated session; it returns here.
    handlePromiseError(goto(Route.pinPrompt({ continue: page.url.pathname + page.url.search })));
  };

  const lockSession = async () => {
    const pathname = page.url.pathname;
    isSessionLoading = true;

    try {
      await lockAuthSession();
      isElevated = false;

      if (isSensitiveRoute(pathname)) {
        // Never leave sensitive media on screen after locking.
        await goto(Route.photos());
      } else if (isAssetViewerRoute(page)) {
        await navigate({ targetRoute: 'current', assetId: null }, { replaceState: true, invalidateAll: true });
      } else {
        await invalidateAll();
      }

      eventManager.emit('SessionAccessChanged', { isElevated: false });
      eventManager.emit('SessionLocked');
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      isSessionLoading = false;
    }
  };

  const toggleSession = () => {
    if (isSessionLoading) {
      return;
    }

    if (isElevated) {
      handlePromiseError(lockSession());
    } else {
      unlockSession();
    }
  };

</script>

<nav
  id="dashboard-navbar"
  class="frameleaf fl-topbar h-(--navbar-height) w-dvw text-sm max-md:h-(--navbar-height-md)"
  class:fl-no-border={noBorder}
  data-theme={appTheme}
>
  <SkipLink text={$t('skip_to_content')} />
  <div class="grid h-full grid-cols-[--spacing(32)_auto] items-center py-2 sidebar:grid-cols-[--spacing(64)_auto]">
    <div class="mx-4 flex flex-row items-center gap-1">
      <!-- The id matches `menuButtonId` exported by NavigationBar.svelte, which the
           sidebar focuses when it closes. It is repeated rather than imported so the
           two shells never import each other. -->
      <IconButton
        id="top-menu-button"
        shape="round"
        color="secondary"
        variant="ghost"
        size="medium"
        aria-label={$t('main_menu')}
        icon={mdiMenu}
        onclick={() => sidebarStore.toggle()}
        onmousedown={(event: MouseEvent) => {
          if (sidebarStore.isOpen) {
            // Stop the event reaching the sidebar's click-outside handler.
            event.stopPropagation();
          }
        }}
        class="sidebar:hidden"
      />
      <a data-sveltekit-preload-data="hover" href={Route.photos()} aria-label={$t('library')}>
        <FrameleafLogo
          variant={mediaQueryManager.isFullSidebar ? 'inline' : 'icon'}
          theme={appTheme}
          decorative
          class="h-12"
        />
      </a>
    </div>

    <div class="flex min-w-0 justify-between gap-2 pe-4 md:gap-4 md:pe-6">
      <!--
        FL-49: exactly one search entry for the whole library, at every width. It opens the
        Frameleaf search dialog, which now carries the filter panel that the separate
        search-options modal used to hold. Mounting it once also means one set of keyboard
        shortcuts: a second instance would open the dialog twice.
      -->
      <div class="w-full max-w-5xl min-w-0 flex-1">
        {#if featureFlagsManager.value.search}
          <SearchEntry />
        {/if}
      </div>

      <section class="flex min-w-0 place-items-center justify-end gap-1 md:gap-2">
        {#if onUploadClick && !isAdminRoute}
          <UploadMenuButton defaultAlbumId={uploadAlbumId} isLockedAssets={uploadIsLocked} />
        {/if}

        <!-- The activity indicator is desktop only; phones keep the bar to its fixed grid. -->
        <div class="hidden md:flex">
          <ActivityIndicator />
        </div>

        <div
          use:clickOutside={{
            onOutclick: () => closeNotifications(),
            onEscape: () => closeNotifications(true),
          }}
        >
          <!-- The prototype's NotificationsBell (SystemPanels.jsx): outline bell, unread count capped at 9+. -->
          <button
            bind:this={bellButton}
            type="button"
            class="fl-notif-bell"
            aria-label={bellLabel}
            aria-haspopup="dialog"
            aria-expanded={showNotifications}
            onclick={() => (showNotifications = !showNotifications)}
          >
            <Icon icon={mdiBellOutline} size={20} aria-hidden="true" />
            {#if unreadCount > 0}
              <span class="fl-notif-count" aria-hidden="true">{unreadCount > 9 ? '9+' : unreadCount}</span>
            {/if}
            {#if runningCount > 0}
              <!-- Jobs are running: a small turning ring at the bell's foot, still for reduced motion. -->
              <span class="fl-bell-running" aria-hidden="true"></span>
            {/if}
          </button>

          {#if showNotifications}
            <NotificationPanel onClose={() => closeNotifications(true)} onNavigate={() => closeNotifications()} />
          {/if}
        </div>

        <IconButton
          color={isElevated ? 'primary' : 'secondary'}
          shape="round"
          variant="ghost"
          size="medium"
          icon={isElevated ? mdiLockOpenVariantOutline : mdiLockOutline}
          disabled={isSessionLoading}
          onclick={toggleSession}
          title={lockedLabel}
          aria-label={lockedLabel}
        />

        <ActionButton action={Cast} />

        <ThemeButton />

        <AccountMenu
          {isElevated}
          {isSessionLoading}
          onUnlock={unlockSession}
          onLock={() => handlePromiseError(lockSession())}
        />
      </section>
    </div>
  </div>
</nav>

<style>
  .fl-topbar {
    background: var(--fl-panel);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-no-border {
    border-bottom: 0;
  }
  .fl-notif-bell {
    position: relative;
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 36px;
    height: 34px;
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
  }
  .fl-notif-bell:hover,
  .fl-notif-bell[aria-expanded='true'] {
    background: var(--fl-raised);
  }
  .fl-notif-count {
    position: absolute;
    top: 3px;
    right: 2px;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: 10px;
    font-weight: 700;
    line-height: 16px;
    text-align: center;
    box-shadow: 0 0 0 2px var(--fl-panel);
    pointer-events: none;
  }
  .fl-bell-running {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 12px;
    height: 12px;
    border: 2px solid var(--fl-border);
    border-top-color: var(--fl-accent);
    border-radius: 50%;
    background: var(--fl-panel);
    pointer-events: none;
    animation: fl-bell-spin 900ms linear infinite;
  }
  @keyframes fl-bell-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-bell-running {
      border-color: var(--fl-accent);
      animation: none;
    }
  }
</style>
