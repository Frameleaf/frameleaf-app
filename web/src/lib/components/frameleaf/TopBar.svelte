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
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { buildPrimaryDestinations, currentPrimaryDestination, isSettingsRoute } from '$lib/frameleaf/navigation';
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
    mdiMoonWaningCrescent,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf top bar (FL-30), ported from the prototype's `App.jsx` header.
   *
   * In the prototype's order: the brand, the Library / Studio / Activity switcher, one search
   * entry, Upload, the activity indicator, Notifications, the Locked toggle as an icon, the theme
   * toggle and the account menu. The switcher's items are text only and the current one carries
   * the accent underline. On phones the bar is a fixed two-row grid: the brand and the controls
   * on the first row, the switcher and search on the second, and the activity indicator hidden.
   *
   * Every control drives an existing production service: the Locked toggle is the elevated
   * session, Upload is the upload manager's file dialog, Notifications is the notification
   * manager, and the switcher's destinations come from `navigation.ts`.
   */

  type Props = {
    onUploadClick?: () => void;
    noBorder?: boolean;
    /**
     * The page shows the library rail, so the phone menu button has something to open. Studio
     * has no rail, as in the prototype, and passes false rather than leave a button that does
     * nothing.
     */
    hasRail?: boolean;
  };

  let { onUploadClick, noBorder = false, hasRail = true }: Props = $props();

  const primaryDestinations = buildPrimaryDestinations();
  const currentPrimary = $derived(currentPrimaryDestination(page.url.pathname));

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
  // The prototype's theme control is always present and names the theme it switches to.
  const themeLabel = $derived(appTheme === 'dark' ? $t('light_theme') : $t('dark_theme'));
  // The prototype's one "admin" screen covers account preferences and system administration
  // alike (`openSettings()` in App.jsx always sets `screen("admin")`), so both roots hide
  // Upload and switch the search entry to settings search.
  const isAdminRoute = $derived(isSettingsRoute(page.url.pathname));
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
  class="frameleaf fl-topbar h-(--fl-topbar-height) w-dvw text-sm max-md:h-(--fl-topbar-height-phone)"
  class:fl-no-border={noBorder}
  data-theme={appTheme}
>
  <SkipLink text={$t('skip_to_content')} />
  <div class="fl-topbar-grid">
    <div class="fl-topbar-lead">
      {#if hasRail}
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
      {/if}
      <a class="fl-topbar-brand" data-sveltekit-preload-data="hover" href={Route.photos()} aria-label={$t('library')}>
        <FrameleafLogo
          variant={mediaQueryManager.isFullSidebar ? 'inline' : 'icon'}
          theme={appTheme}
          decorative
          class="h-8"
        />
      </a>
    </div>

    <!-- The prototype's `.primary-nav`: the three workspaces, text only, in this order. -->
    <nav class="fl-primary-nav" aria-label={$t('frameleaf_primary_navigation')}>
      {#each primaryDestinations as destination (destination.id)}
        <a
          href={destination.href}
          data-sveltekit-preload-data="hover"
          class:fl-current={currentPrimary === destination.id}
          aria-current={currentPrimary === destination.id ? 'page' : undefined}
        >
          {$t(destination.labelKey)}
        </a>
      {/each}
    </nav>

    <!--
      FL-49: exactly one search entry for the whole library, at every width. It opens the
      Frameleaf search dialog, which now carries the filter panel that the separate
      search-options modal used to hold. Mounting it once also means one set of keyboard
      shortcuts: a second instance would open the dialog twice.
    -->
    <div class="fl-topbar-search">
      {#if featureFlagsManager.value.search}
        <SearchEntry />
      {/if}
    </div>

    <section class="fl-topbar-actions">
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
          <!-- Anchored to the bar's bottom edge, whatever height the bar has at this width. -->
          <div class="fl-notifications-panel">
            <NotificationPanel onClose={() => closeNotifications(true)} onNavigate={() => closeNotifications()} />
          </div>
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

      <!-- Casting is contextual: the button shows only while a cast device is available. -->
      <ActionButton action={Cast} />

      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        size="medium"
        icon={appTheme === 'dark' ? mdiWhiteBalanceSunny : mdiMoonWaningCrescent}
        onclick={() => themeManager.toggle()}
        title={themeLabel}
        aria-label={themeLabel}
      />

      <AccountMenu
        {isElevated}
        {isSessionLoading}
        onUnlock={unlockSession}
        onLock={() => handlePromiseError(lockSession())}
      />
    </section>
  </div>
</nav>

<style>
  /*
   * The prototype's `.topbar` (styles.css): 56px tall, the brand, then the switcher, then search
   * pushed toward the controls and capped at 480px. Below Tailwind's `md` the bar becomes the
   * prototype's phone grid.
   */
  .fl-topbar {
    position: relative;
    background: var(--fl-panel);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-no-border {
    border-bottom: 0;
  }
  .fl-topbar-grid {
    display: flex;
    align-items: center;
    gap: 1.125rem;
    height: 100%;
    padding: 0 1.5rem 0 1.125rem;
  }
  .fl-topbar-lead {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    min-width: 10.6875rem;
  }
  .fl-topbar-brand {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .fl-primary-nav {
    display: flex;
    align-self: stretch;
    gap: 0.75rem;
  }
  .fl-primary-nav a {
    position: relative;
    display: flex;
    align-items: center;
    padding: 0 0.75rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
    white-space: nowrap;
    text-decoration: none;
    transition: color var(--fl-motion-fast) var(--fl-ease);
  }
  .fl-primary-nav a:hover,
  .fl-primary-nav a.fl-current {
    color: var(--fl-text);
  }
  .fl-primary-nav a.fl-current::after {
    content: '';
    position: absolute;
    left: 0.375rem;
    right: 0.375rem;
    bottom: 0;
    height: 2px;
    border-radius: 2px;
    background: var(--fl-accent);
  }
  .fl-topbar-search {
    flex: 1;
    min-width: 0;
    max-width: 30rem;
    margin-left: auto;
  }
  .fl-topbar-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  /* The prototype's popover sits just under the bar at its right edge; the panel keeps no offsets. */
  .fl-notifications-panel {
    position: absolute;
    top: 100%;
    right: 0.5rem;
    z-index: 40;
    padding-top: 0.5rem;
  }
  @media (max-width: 80rem) {
    .fl-topbar-grid {
      gap: 0.75rem;
      padding-right: 1rem;
    }
    .fl-primary-nav {
      gap: 0.125rem;
    }
  }
  @media (max-width: 62.5rem) {
    .fl-topbar-grid {
      gap: 0.5rem;
    }
  }
  /* Phones: the prototype's fixed two-row grid. */
  @media (max-width: 47.99rem) {
    .fl-topbar-grid {
      display: grid;
      grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
      grid-template-rows: 2.8125rem 2.4375rem;
      grid-template-areas:
        'lead . actions'
        'primary search search';
      column-gap: 0.3125rem;
      padding: 0.1875rem 0.5rem 0.5rem;
    }
    .fl-topbar-lead {
      grid-area: lead;
      min-width: 0;
      overflow: hidden;
    }
    .fl-primary-nav {
      grid-area: primary;
      gap: 0;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .fl-primary-nav a {
      padding: 0 0.5625rem;
      font-size: 0.75rem;
    }
    .fl-topbar-search {
      grid-area: search;
      max-width: none;
      margin-left: 0;
    }
    .fl-topbar-actions {
      grid-area: actions;
      gap: 0.125rem;
    }
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
