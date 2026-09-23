<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { clickOutside } from '$lib/actions/click-outside';
  import AccountMenu from '$lib/components/frameleaf/AccountMenu.svelte';
  import ActivityIndicator from '$lib/components/frameleaf/ActivityIndicator.svelte';
  import FrameleafLogo from '$lib/components/frameleaf/Logo.svelte';
  import UploadMenuButton from '$lib/components/frameleaf/UploadMenuButton.svelte';
  import NotificationPanel from '$lib/components/shared-components/navigation-bar/NotificationPanel.svelte';
  import SearchBar from '$lib/components/shared-components/search-bar/SearchBar.svelte';
  import ThemeButton from '$lib/components/shared-components/ThemeButton.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import '$lib/frameleaf/tokens.css';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import SearchFilterModal from '$lib/modals/SearchFilterModal.svelte';
  import { Route } from '$lib/route';
  import { getGlobalActions } from '$lib/services/app.service';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { notificationManager } from '$lib/stores/notification-manager.svelte';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, isAssetViewerRoute, isLockedFolderRoute, navigate } from '$lib/utils/navigation';
  import { getAuthStatus, lockAuthSession } from '@immich/sdk';
  import { ActionButton, IconButton, modalManager, Theme as AppTheme, themeManager } from '@immich/ui';
  import {
    mdiBellBadge,
    mdiBellOutline,
    mdiLockOpenVariantOutline,
    mdiLockOutline,
    mdiMagnify,
    mdiMenu,
    mdiTune,
  } from '@mdi/js';
  import { onMount } from 'svelte';
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
  let isSearchOptionsOpen = $state(false);
  let isElevated = $state(false);
  let isSessionLoading = $state(true);

  const hasUnreadNotifications = $derived(notificationManager.notifications.length > 0);
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

    return eventManager.on({
      SessionLocked: () => (isElevated = false),
      SessionAccessChanged: ({ isElevated: elevated }) => (isElevated = elevated),
    });
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

  const openSearchOptions = async () => {
    if (isSearchOptionsOpen) {
      return;
    }

    isSearchOptionsOpen = true;

    try {
      const result = modalManager.open(SearchFilterModal, { searchQuery: {} });
      const searchResult = await result.onClose;

      if (searchResult) {
        await goto(Route.search(searchResult));
      }
    } finally {
      isSearchOptionsOpen = false;
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
      <!-- One search entry for the whole library. -->
      <div class="hidden w-full max-w-5xl min-w-0 flex-1 sm:block">
        {#if featureFlagsManager.value.search}
          <SearchBar grayTheme={true} />
        {/if}
      </div>

      <section class="flex min-w-0 place-items-center justify-end gap-1 md:gap-2">
        {#if featureFlagsManager.value.search}
          <IconButton
            color="secondary"
            shape="round"
            variant="ghost"
            size="medium"
            icon={mdiMagnify}
            href={Route.search()}
            id="search-button"
            class="sm:hidden"
            aria-label={$t('go_to_search')}
          />
          <IconButton
            color="secondary"
            shape="round"
            variant="ghost"
            size="medium"
            icon={mdiTune}
            onclick={() => handlePromiseError(openSearchOptions())}
            id="search-options-button"
            class="sm:hidden"
            aria-label={$t('show_search_options')}
          />
        {/if}

        {#if onUploadClick && !isAdminRoute}
          <UploadMenuButton defaultAlbumId={uploadAlbumId} isLockedAssets={uploadIsLocked} />
        {/if}

        <!-- The activity indicator is desktop only; phones keep the bar to its fixed grid. -->
        <div class="hidden md:flex">
          <ActivityIndicator />
        </div>

        <div
          use:clickOutside={{
            onOutclick: () => (showNotifications = false),
            onEscape: () => (showNotifications = false),
          }}
        >
          <div class="relative">
            <IconButton
              shape="round"
              color={hasUnreadNotifications ? 'primary' : 'secondary'}
              variant="ghost"
              size="medium"
              icon={hasUnreadNotifications ? mdiBellBadge : mdiBellOutline}
              onclick={() => (showNotifications = !showNotifications)}
              aria-label={$t('notifications')}
            />
            {#if hasUnreadNotifications}
              <div
                class="pointer-events-none absolute top-0 right-1 flex size-5 items-center justify-center rounded-full border bg-primary text-[10px] font-bold text-light"
              >
                {notificationManager.notifications.length}
              </div>
            {/if}
          </div>

          {#if showNotifications}
            <NotificationPanel />
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
</style>
