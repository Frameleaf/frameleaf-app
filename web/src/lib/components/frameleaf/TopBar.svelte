<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { clickOutside } from '$lib/actions/click-outside';
  import AccountMenu from '$lib/components/frameleaf/AccountMenu.svelte';
  import LockedUnlockDialog from '$lib/components/frameleaf/LockedUnlockDialog.svelte';
  import ActivityIndicator from '$lib/components/frameleaf/ActivityIndicator.svelte';
  import FrameleafLogo from '$lib/components/frameleaf/Logo.svelte';
  import UploadMenuButton from '$lib/components/frameleaf/UploadMenuButton.svelte';
  import NotificationPanel from '$lib/components/shared-components/navigation-bar/NotificationPanel.svelte';
  import SearchEntry from '$lib/components/frameleaf/SearchEntry.svelte';
  import TabBar from '$lib/components/frameleaf/TabBar.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { buildPrimaryDestinations, currentPrimaryDestination } from '$lib/frameleaf/navigation';
  import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';
  import { sessionAccess, trackSessionModals } from '$lib/frameleaf/session-access.svelte';
  import { requestSessionLock } from '$lib/frameleaf/session-lock';
  import '$lib/frameleaf/tokens.css';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { notificationManager } from '$lib/stores/notification-manager.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { isAlbumsRoute, isLockedFolderRoute } from '$lib/utils/navigation';
  import { getAuthStatus } from '@immich/sdk';
  import { Icon, IconButton, modalManager, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiBellOutline,
    mdiChevronRight,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiMenu,
    mdiMoonWaningCrescent,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { MediaQuery } from 'svelte/reactivity';

  trackSessionModals(modalManager);

  /**
   * Frameleaf top bar (FL-30), ported from the prototype's `App.jsx` header.
   *
   * In the prototype's order: the brand, the Library / Studio / Activity switcher, one search
   * entry, Upload, the activity indicator, Notifications, the Locked toggle as an icon, the theme
   * toggle and the account menu. The switcher's items are text only and the current one carries
   * the accent underline. On phones the bar is a fixed two-row grid: the brand and the controls
   * on the first row, the switcher on the second, and the activity indicator hidden.
   *
   * September 24 (apple-style.css "#3 materials", "#9 edge-to-edge", "top bar", "#7 phone tab
   * bar"): the bar is frosted and keeps clear of the notch; from 1200px the search field sits in
   * the true centre; on phones (≤700px) the bar has no search field, because the tab bar owns
   * Search, and the brand shows the Frameleaf symbol only while keeping "Frameleaf" as its name.
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
  /** apple-style.css: phones show the Frameleaf symbol only. */
  const phone = new MediaQuery('max-width: 700px');
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
  let sessionRevision = 0;
  let lockFlight: Promise<void> | undefined;
  // FL-34: views that reveal the owner's marks to an unlocked session read it from here
  $effect(() => {
    sessionAccess.isElevated = isElevated;
  });

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
  // The prototype's Locked control: "Unlock Locked content" / "Hide Locked content", with the state
  // spelled out as Locked / Revealed beside the icon (LockedContent.jsx).
  const lockedLabel = $derived(
    isElevated ? $t('frameleaf_locked_hide_content') : $t('frameleaf_locked_unlock_content'),
  );
  let unlockDialogOpen = $state(false);
  // Matches the drag-and-drop overlay's own defaults (FL-45): uploads made from an album
  // page join that album, and uploads made from the Locked area stay locked.
  const uploadAlbumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  const uploadIsLocked = $derived(isLockedFolderRoute(page.route?.id));

  onMount(() => {
    void refreshNotifications();
    sessionAccess.retryLock = requestSessionLock;
    if (sessionAccess.lockPending) {
      void lockSession();
    } else {
      void refreshAuthStatus();
    }

    // One poll for everything running; fast only while the panel is open or something runs.
    const stopRunningJobs = runningJobsSession.watch();
    const stopEvents = eventManager.on({
      SessionLocked: () => (isElevated = false),
      SessionAccessChanged: ({ isElevated: elevated }) => (isElevated = elevated && !sessionAccess.lockPending),
    });

    // FL-83: a hidden tab conceals only its own content (the root shield does that); the server
    // lock is explicit or the server's idle timeout. Coming back re-reads the session, and a lock
    // that is still pending (for example after going offline) is retried.
    const onVisibilityChange = () => {
      if (sessionAccess.lockPending) {
        handlePromiseError(lockSession());
      } else if (!document.hidden && !lockFlight) {
        void refreshAuthStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    addEventListener('online', onVisibilityChange);

    return () => {
      stopRunningJobs();
      stopEvents();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      removeEventListener('online', onVisibilityChange);
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
    const revision = sessionRevision;
    const privacyRevision = sessionAccess.revision;
    isSessionLoading = true;
    try {
      const status = await getAuthStatus();
      if (revision === sessionRevision && privacyRevision === sessionAccess.revision && !sessionAccess.lockPending) {
        isElevated = status.isElevated;
      }
    } catch (error) {
      console.error('Failed to load elevated session status', error);
    } finally {
      isSessionLoading = false;
    }
  };

  // Unlocking happens in place (the prototype's PIN dialog on the control); the PIN prompt route
  // stays for deep links that need an elevated session before they can render.
  const unlockSession = () => {
    unlockDialogOpen = true;
  };

  const onUnlocked = async () => {
    sessionRevision++;
    if (sessionAccess.lockPending) {
      await lockSession();
      return;
    }
    isElevated = true;
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    await invalidateAll();
  };

  const lockSession = (): Promise<void> => {
    if (lockFlight) {
      return lockFlight;
    }
    sessionRevision++;
    isElevated = false;
    isSessionLoading = true;
    unlockDialogOpen = false;
    lockFlight = requestSessionLock().finally(() => {
      isSessionLoading = false;
      lockFlight = undefined;
    });
    return lockFlight;
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
  class="frameleaf fl-topbar fl-material h-(--fl-topbar-height) w-dvw text-sm max-md:h-(--fl-topbar-height-phone)"
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
      <!-- App.jsx `.brand`: the button is named "Frameleaf" whatever it shows. -->
      <a
        class="fl-topbar-brand"
        data-sveltekit-preload-data="hover"
        href={Route.photos()}
        aria-label={$t('frameleaf_brand_name')}
      >
        <FrameleafLogo
          variant={mediaQueryManager.isFullSidebar && !phone.current ? 'inline' : 'icon'}
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
      {#if onUploadClick}
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
          <Icon icon={mdiBellOutline} size="20" aria-hidden="true" />
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

      <div class="fl-locked-control" class:is-revealed={isElevated}>
        <button
          type="button"
          class="fl-locked-toggle"
          disabled={isSessionLoading}
          onclick={toggleSession}
          title={lockedLabel}
          aria-label={lockedLabel}
        >
          <Icon icon={isElevated ? mdiLockOpenVariantOutline : mdiLockOutline} size="18" aria-hidden="true" />
          <span class="fl-locked-state"
            >{isElevated ? $t('frameleaf_locked_revealed_short') : $t('frameleaf_locked')}</span
          >
        </button>
        {#if isElevated}
          <a
            class="fl-locked-open"
            href={Route.locked()}
            title={$t('frameleaf_open_locked')}
            aria-label={$t('frameleaf_open_locked')}
          >
            <Icon icon={mdiChevronRight} size="17" aria-hidden="true" />
          </a>
        {/if}
      </div>

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

<!-- Outside the frosted bar: a backdrop filter would make the bar the fixed tab bar's containing block. -->
{#if hasRail}
  <TabBar theme={appTheme} />
{/if}

<LockedUnlockDialog bind:open={unlockDialogOpen} onUnlocked={() => handlePromiseError(onUnlocked())} />

<style>
  /*
   * The prototype's `.topbar` (styles.css): 56px tall, the brand, then the switcher, then search
   * pushed toward the controls and capped at 480px. Below Tailwind's `md` the bar becomes the
   * prototype's phone grid.
   */
  /* apple-style.css "#3 materials": the bar is frosted, with a hairline edge. */
  .fl-topbar {
    position: relative;
    z-index: 20;
    background: var(--fl-material);
    border-bottom: 1px solid var(--fl-material-edge);
    /* "#9 edge-to-edge": --fl-topbar-height already includes the top inset (app.css). */
    padding-top: var(--fl-safe-top);
  }
  .fl-no-border {
    border-bottom: 0;
  }
  .fl-topbar-grid {
    display: flex;
    align-items: center;
    gap: 1.125rem;
    height: 100%;
    padding: 0 max(1.5rem, var(--fl-safe-right)) 0 max(1.125rem, var(--fl-safe-left));
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
  /* apple-style.css "top bar": the search field sits in the true centre on wide screens. */
  @media (min-width: 1200px) {
    .fl-topbar-search {
      position: absolute;
      left: 50%;
      translate: -50% 0;
      width: min(480px, calc(100vw - 940px));
      max-width: none;
      margin: 0;
    }
    .fl-topbar-actions {
      margin-left: auto;
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
      padding: 0.1875rem max(0.5rem, var(--fl-safe-right)) 0.5rem max(0.5rem, var(--fl-safe-left));
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
  /* apple-style.css: on phones the tab bar owns Search, so the bar keeps no search field. The
     entry stays mounted (only its trigger is hidden) so the tab bar and ⌘K still open it. */
  @media (max-width: 700px) {
    .fl-topbar-grid {
      grid-template-areas:
        'lead . actions'
        'primary primary primary';
    }
    .fl-topbar-search {
      position: absolute;
      width: 0;
      height: 0;
    }
    .fl-topbar-search > :global(button) {
      display: none;
    }
    /* The notifications bottom sheet is fixed; a backdrop filter would make the bar its
       containing block, so the bar turns solid while the sheet is open. */
    .fl-topbar:has(.fl-notifications-panel) {
      background: var(--fl-panel);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
  /* The prototype's bordered Locked control (locked-content.css): icon + state, accent when revealed. */
  .fl-locked-control {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    height: 34px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  .fl-locked-control.is-revealed {
    color: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .fl-locked-toggle,
  .fl-locked-open {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
  }
  .fl-locked-toggle {
    gap: 7px;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 600;
  }
  .fl-locked-toggle:disabled {
    opacity: 0.6;
  }
  .fl-locked-open {
    width: 29px;
    border-inline-start: 1px solid var(--fl-border);
  }
  .fl-locked-control.is-revealed .fl-locked-open {
    border-color: var(--fl-accent);
  }
  .fl-locked-toggle:hover:not(:disabled),
  .fl-locked-open:hover {
    background: var(--fl-raised);
  }
  @media (max-width: 700px) {
    .fl-locked-state {
      display: none;
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
