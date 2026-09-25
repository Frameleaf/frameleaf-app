<script lang="ts">
  import { afterNavigate, beforeNavigate, onNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { sessionAccess, trackSessionModals } from '$lib/frameleaf/session-access.svelte';
  import { requestSessionLock, watchSessionLockOwner } from '$lib/frameleaf/session-lock';
  import SessionLockShield from '$lib/components/frameleaf/SessionLockShield.svelte';
  import DownloadPanel from '$lib/components/frameleaf/DownloadPanel.svelte';
  import PanelDock from '$lib/components/frameleaf/PanelDock.svelte';
  import UploadPanel from '$lib/components/frameleaf/UploadPanel.svelte';
  import ErrorLayout from './ErrorLayout.svelte';
  import SessionPrivacyGuard from './SessionPrivacyGuard.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import NavigationLoadingBar from './NavigationLoadingBar.svelte';
  import VersionAnnouncement from './VersionAnnouncement.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import ServerRestartingModal from '$lib/modals/ServerRestartingModal.svelte';
  import { Route } from '$lib/route';
  import { lang, locale } from '$lib/stores/preferences.store';
  import { sidebarStore } from '$lib/stores/sidebar.svelte';
  import { closeWebsocketConnection, openWebsocketConnection, websocketStore } from '$lib/stores/websocket';
  import { maintenanceShouldRedirect } from '$lib/utils/maintenance';
  import { installSearchShortcuts } from '$lib/frameleaf/search-shortcuts';
  import { applyThemeColor } from '$lib/frameleaf/theme-color';
  import { viewerZoomTransition } from '$lib/frameleaf/viewer-zoom';
  import frameleafLogoDarkUrl from '$lib/assets/frameleaf/frameleaf-logo-dark.svg?url';
  import frameleafSymbolUrl from '$lib/assets/frameleaf/frameleaf-symbol.svg?url';
  import { getServerConfig } from '@immich/sdk';
  import {
    logoManager,
    modalManager,
    setLocale,
    setTranslations,
    Theme,
    themeManager,
    toastManager,
    TooltipProvider,
  } from '@immich/ui';
  import { En } from 'media-chrome/lang/en';
  import { addTranslation } from 'media-chrome/utils/i18n';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import '../app.css';

  trackSessionModals(modalManager);

  // FL-35: a photo grows out of its thumbnail into the viewer and back (interactions.js viewerTransition).
  onNavigate((navigation) => viewerZoomTransition(navigation));

  // The browser chrome follows the app theme, not the OS colour scheme (App.jsx:2193-2203).
  $effect(() => applyThemeColor(themeManager.value === Theme.Dark ? 'dark' : 'light'));

  interface Props {
    children?: Snippet;
  }

  // FL-135: app-owned marks render through $lib/components/frameleaf/Logo.svelte. This only swaps the
  // mark @immich/ui draws inside its own components (the Modal header icon, SupporterBadge) so no
  // vendored Immich logo is shown. The kit ships no light-background wordmark, so light lockups
  // fall back to the gradient symbol, mirroring Logo.svelte's rule.
  const frameleafLockup = { light: frameleafSymbolUrl, dark: frameleafLogoDarkUrl };
  logoManager.setLogo({
    stacked: frameleafLockup,
    unstacked: frameleafLockup,
    stacked_futo: frameleafLockup,
    icon: frameleafSymbolUrl,
  });

  const MediaChromeDefaultKeys = [
    'Start airplay',
    'Stop airplay',
    'Audio',
    'Start casting',
    'Stop casting',
    'Enter picture in picture mode',
    'Exit picture in picture mode',
    'Seek backward',
    'Seek forward',
    'audio player',
    'seek',
    'audio tracks',
    'chapter: {chapterName}',
    'live',
    'start airplay',
    'stop airplay',
    'start casting',
    'stop casting',
    'enter picture in picture mode',
    'exit picture in picture mode',
    'seek to live',
    'playing live',
    'seek back {seekOffset} seconds',
    'seek forward {seekOffset} seconds',
    'Encryption Error',
    'The media is encrypted and there are no keys to decrypt it.',
  ] as const satisfies Array<keyof typeof En>;
  const MediaChromeDefaults = Object.fromEntries(MediaChromeDefaultKeys.map((key) => [key, key])) as {
    [K in (typeof MediaChromeDefaultKeys)[number]]: K;
  };

  $effect(() => {
    setTranslations({
      cancel: $t('cancel'),
      close: $t('close'),
      confirm: $t('confirm'),
      expand: $t('expand'),
      collapse: $t('collapse'),
      search_placeholder: $t('search'),
      search_no_results: $t('no_results'),
      prompt_default: $t('are_you_sure_to_do_this'),
      show_password: $t('show_password'),
      hide_password: $t('hide_password'),
      dark_theme: themeManager.value === Theme.Dark ? $t('light_theme') : $t('dark_theme'),
      open_menu: $t('open'),
      command_palette_prompt_default: $t('command_palette_prompt'),
      command_palette_to_select: $t('command_palette_to_select'),
      command_palette_to_navigate: $t('command_palette_to_navigate'),
      command_palette_to_close: $t('command_palette_to_close'),
      command_palette_to_show_all: $t('command_palette_to_show_all'),
      navigate_next: $t('next'),
      navigate_previous: $t('previous'),
      open_calendar: $t('open_calendar'),
      toast_success_title: $t('success'),
      toast_info_title: $t('info'),
      toast_warning_title: $t('warning'),
      toast_danger_title: $t('error'),
      save: $t('save'),
      supporter: $t('supporter'),
    });

    addTranslation($lang, {
      ...MediaChromeDefaults,
      Captions: $t('media_chrome.captions'),
      'Enable captions': $t('media_chrome.enable_captions'),
      'Disable captions': $t('media_chrome.disable_captions'),
      'Enter fullscreen mode': $t('media_chrome.enter_fullscreen_mode'),
      'Exit fullscreen mode': $t('media_chrome.exit_fullscreen_mode'),
      Mute: $t('media_chrome.mute'),
      Unmute: $t('media_chrome.unmute'),
      Loop: $t('media_chrome.loop'),
      Play: $t('play'),
      Pause: $t('pause'),
      'Playback rate': $t('media_chrome.playback_rate'),
      'Playback rate {playbackRate}': $t('media_chrome.playback_rate_value'),
      Quality: $t('media_chrome.quality'),
      Settings: $t('settings'),
      Auto: $t('media_chrome.auto'),
      'video player': $t('media_chrome.video_player'),
      volume: $t('media_chrome.volume'),
      'closed captions': $t('media_chrome.closed_captions'),
      'current playback rate': $t('media_chrome.playback_rate_current'),
      'playback time': $t('media_chrome.playback_time'),
      'media loading': $t('media_chrome.media_loading'),
      settings: $t('settings'),
      quality: $t('media_chrome.quality'),
      play: $t('play'),
      pause: $t('pause'),
      mute: $t('media_chrome.mute'),
      unmute: $t('media_chrome.unmute'),
      Off: $t('media_chrome.captions_off'),
      'enter fullscreen mode': $t('media_chrome.enter_fullscreen_mode'),
      'exit fullscreen mode': $t('media_chrome.exit_fullscreen_mode'),
      'Network Error': $t('media_chrome.network_error'),
      'Decode Error': $t('media_chrome.decode_error'),
      'Source Not Supported': $t('media_chrome.not_supported_error'),
      'A network error caused the media download to fail.': $t('media_chrome.network_error_description'),
      'A media error caused playback to be aborted. The media could be corrupt or your browser does not support this format.':
        $t('media_chrome.media_error_description'),
      'An unsupported error occurred. The server or network failed, or your browser does not support this format.': $t(
        'media_chrome.unsupported_error_description',
      ),
      hour: $t('hour'),
      hours: $t('hours'),
      minute: $t('minute'),
      minutes: $t('minutes'),
      second: $t('media_chrome.second'),
      seconds: $t('media_chrome.seconds'),
      '{time} remaining': $t('media_chrome.time_value_remaining'),
      '{currentTime} of {totalTime}': $t('media_chrome.time_value_of_total_time'),
      'video not loaded, unknown time.': $t('media_chrome.video_not_loaded_unknown_time'),
    });
  });

  $effect(() => setLocale($locale));

  let { children }: Props = $props();

  let showNavigationLoadingBar = $state(false);

  toastManager.setOptions({ class: 'top-16 fixed' });

  onMount(() => {
    const element = document.querySelector('#stencil');
    element?.remove();
    // FL-83: the root owns lock retries even when a PIN route or dialog has unmounted.
    sessionAccess.retryLock = requestSessionLock;
    const stopWatchingLockOwner = watchSessionLockOwner();
    // Only a signed-in session has anything to lock; a signed-out tab keeps the flag until the next
    // sign-in or sign-out drops it.
    if (sessionAccess.lockPending && authManager.authenticated) {
      void requestSessionLock();
    }
    // Ctrl/Cmd+K and "/" open Frameleaf search, never the upstream command palette.
    const removeSearchShortcuts = installSearchShortcuts();
    return () => {
      sessionAccess.retryLock = undefined;
      stopWatchingLockOwner();
      removeSearchShortcuts?.();
    };
  });

  eventManager.emit('AppInit');

  beforeNavigate(({ from, to }) => {
    if (sidebarStore.isOpen) {
      sidebarStore.reset();
    }

    const fromRouteId = from?.route?.id;
    const toRouteId = to?.route?.id;
    const sameRouteTransition = fromRouteId && toRouteId && fromRouteId === toRouteId;

    if (sameRouteTransition) {
      return;
    }

    eventManager.emit('AppNavigate');

    showNavigationLoadingBar = true;
  });

  afterNavigate(() => {
    showNavigationLoadingBar = false;
  });

  const { serverRestarting } = websocketStore;

  $effect.pre(() => {
    if (authManager.authenticated || $serverRestarting || page.url.pathname.startsWith(Route.maintenanceMode())) {
      openWebsocketConnection();
    } else {
      closeWebsocketConnection();
    }
  });

  serverRestarting.subscribe((isRestarting) => {
    if (!isRestarting) {
      return;
    }

    // FL-80 M-4: the maintenance page shows its own "Maintenance is finished" state with "Open Frameleaf".
    if (
      maintenanceShouldRedirect(isRestarting.isMaintenanceMode, location) &&
      !location.pathname.startsWith(Route.maintenanceMode())
    ) {
      modalManager.show(ServerRestartingModal, {}).catch((error) => console.error('Error [ServerRestartBox]:', error));
    }
  });

  const onWebsocketConnect = async () => {
    const isRestarting = get(serverRestarting);
    if (isRestarting && maintenanceShouldRedirect(isRestarting.isMaintenanceMode, location)) {
      const { maintenanceMode } = await getServerConfig();
      if (maintenanceMode === isRestarting.isMaintenanceMode) {
        location.reload();
      }
    }
  };
</script>

<OnEvents {onWebsocketConnect} />

<VersionAnnouncement />

<svelte:head>
  <title>{page.data.meta?.title || 'Web'} - Frameleaf</title>
  <link rel="manifest" href="/manifest.json" crossorigin="use-credentials" />

  {#if page.data.meta}
    <meta name="description" content={page.data.meta.description} />

    <!-- Facebook Meta Tags -->
    <meta property="og:type" content="website" />
    <meta property="og:title" content={page.data.meta.title} />
    <meta property="og:description" content={page.data.meta.description} />
    {#if page.data.meta.imageUrl}
      <meta
        property="og:image"
        content={new URL(page.data.meta.imageUrl, serverConfigManager.value.externalDomain || location.origin).href}
      />
    {/if}
  {/if}
</svelte:head>

<!-- FL-34: nothing (panels included) renders until the session's elevated access is verified -->
<!-- FL-83: a pending local lock (persisted across reloads) keeps everything behind the root shield -->
<TooltipProvider>
  <SessionLockShield active={sessionAccess.lockPending && authManager.authenticated}>
    <SessionPrivacyGuard>
      {#if page.data.error}
        <ErrorLayout error={page.data.error}></ErrorLayout>
      {:else}
        {@render children?.()}
      {/if}

      {#if showNavigationLoadingBar}
        <NavigationLoadingBar />
      {/if}

      <!-- App.jsx PanelDock: uploads above downloads. -->
      <PanelDock>
        <UploadPanel />
        <DownloadPanel />
      </PanelDock>
    </SessionPrivacyGuard>
  </SessionLockShield>
</TooltipProvider>
