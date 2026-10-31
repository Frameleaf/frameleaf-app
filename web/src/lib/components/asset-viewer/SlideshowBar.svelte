<script lang="ts">
  import { isForwardKey } from '$lib/frameleaf/reading-direction';
  /**
   * The slideshow's engine (FL-36, V-18, VIEWER-P1). The slideshow plays inside the viewer and keeps
   * its chrome, as in the template (MediaViewer.jsx:1008-1298, 1704-1820): the frosted header with the
   * name and "n of N", the side arrows, and the footer, whose Play turns into a green Pause. Play,
   * pause and the settings live in the footer (V-13), which drives the same state
   * (`slideshowStore.slideshowState`, `slideshowStore.toggleSettings`); the header's back arrow and
   * Escape close the viewer. This draws only the thin accent progress line under the header
   * (media-viewer.css:425-450), and adds the S, Space and arrow keys, the wake lock and Media Session.
   *
   * The viewer's chrome (header, footer, arrows) is one state, `chromeHidden`, shared with the viewer's
   * own tap-to-hide. During a slideshow a tap on the photo toggles it and a swipe down shows it again
   * (MediaViewer.jsx:559-583, `.chrome-hidden`, apple-style.css:393-404); it never hides by itself.
   * While the settings panel is open the slideshow holds: the progress stops and a video pauses,
   * without changing play or pause (MediaViewer.jsx:422-460).
   */
  import { shortcuts, type ShortcutOptions } from '$lib/actions/shortcut';
  import ProgressBar from '$lib/components/shared-components/progress-bar/ProgressBar.svelte';
  import { ProgressBarStatus } from '$lib/constants';
  import { bindMediaSession, MEDIA_SESSION_ARTIST } from '$lib/frameleaf/media-session';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { AssetMediaSize, AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@frameleaf/sdk';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';

  interface Props {
    /** The viewer's shared chrome state (header, footer and arrows). */
    chromeHidden?: boolean;
    assetType: AssetTypeEnum;
    /** The item on screen, for the lock screen and media keys (Media Session). */
    asset?: AssetResponseDto;
    /** The collection being played, such as the album's name. */
    title?: string;
    onNext?: () => void;
    onPrevious?: () => void;
  }

  let {
    chromeHidden = $bindable(false),
    assetType,
    asset,
    title,
    onNext = () => {},
    onPrevious = () => {},
  }: Props = $props();

  const {
    restartProgress,
    stopProgress,
    slideshowDelay,
    showProgressBar,
    slideshowNavigation,
    slideshowState,
    settingsOpen,
    closeSettings,
  } = slideshowStore;

  let progressBar = $state<ReturnType<typeof ProgressBar>>();
  let progressBarStatus: ProgressBarStatus | undefined = $state();
  const isVideoSlide = $derived(assetType === AssetTypeEnum.Video);
  const playing = $derived($slideshowState === SlideshowState.PlaySlideshow);

  onMount(() => {
    const unsubscribeRestart = restartProgress.subscribe((value) => {
      if (value) {
        progressBar?.restart();
      }
    });
    const unsubscribeStop = stopProgress.subscribe((value) => {
      if (value) {
        progressBar?.restart();
      }
    });
    return () => {
      unsubscribeRestart();
      unsubscribeStop();
    };
  });

  let alive = true;
  let advanceOwner: object | undefined;
  $effect.pre(() => {
    advanceOwner = { assetId: asset?.id, assetType, state: $slideshowState, settingsOpen: $settingsOpen };
  });

  const handleDone = async () => {
    if (!alive || !advancing) {
      return;
    }
    const owner = advanceOwner;
    const bar = progressBar;
    const isCurrentSession = authManager.captureSession();
    await bar?.resetProgress();
    if (!alive || !isCurrentSession() || owner !== advanceOwner || bar !== progressBar || !advancing) {
      return;
    }

    if ($slideshowNavigation === SlideshowNavigation.AscendingOrder) {
      onPrevious();
      return;
    }
    onNext();
  };

  // Play and pause are the slideshow state; the progress line follows it, whoever changed it
  // (the viewer footer, the More menu, Space, S or the media keys).
  const play = () => ($slideshowState = SlideshowState.PlaySlideshow);
  const pause = () => ($slideshowState = SlideshowState.PauseSlideshow);
  const togglePause = () => (playing ? pause() : play());
  // MediaViewer.jsx:422-460: the open settings panel holds the advance without pausing the slideshow.
  const advancing = $derived(playing && !$settingsOpen);
  $effect(() => {
    const bar = progressBar;
    if (!bar) {
      return;
    }
    if (advancing && progressBarStatus === ProgressBarStatus.Paused) {
      void bar.play();
    } else if (!advancing && progressBarStatus !== ProgressBarStatus.Paused) {
      void bar.pause();
    }
  });

  // A tap on the photo toggles the chrome and a swipe down shows it (MediaViewer.jsx:559-583).
  const CHROME = '[data-viewer-chrome]';
  const inChrome = (node: EventTarget | Element | null) => node instanceof Element && !!node.closest(CHROME);
  // the state at pointerdown decides the toggle, so a swipe-down reveal in between cannot undo it
  let tap: { x: number; y: number; time: number; hidden: boolean } | undefined;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    tap =
      target?.closest?.('[data-viewer-content]') && !inChrome(target)
        ? { x: event.clientX, y: event.clientY, time: performance.now(), hidden: chromeHidden }
        : undefined;
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = tap;
    tap = undefined;
    if (!start) {
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // a swipe down reveals the chrome (source behaviour)
    if (dy > 50 && Math.abs(dx) < dy) {
      chromeHidden = false;
      return;
    }
    if (!(Math.hypot(dx, dy) < 6) || performance.now() - start.time >= 280) {
      return;
    }
    chromeHidden = !start.hidden;
  };

  // the settings panel keeps the chrome on screen
  $effect(() => {
    if ($settingsOpen) {
      chromeHidden = false;
    }
  });

  // The settings panel is the viewer's (SlideshowSettingsPanel); ending the slideshow closes it.
  onDestroy(() => {
    void closeSettings({ restoreFocus: false });
  });

  // FL-36 (MediaViewer.jsx:863-885): keep the screen awake while the slideshow plays, and while
  // its settings are open over it.
  $effect(() => {
    if (playing || $settingsOpen) {
      void acquireWakeLock('slideshow');
    } else {
      releaseWakeLock('slideshow').catch(() => {});
    }
  });
  onDestroy(() => {
    alive = false;
    releaseWakeLock('slideshow').catch(() => {});
  });

  // FL-36 (MediaViewer.jsx:886-923): the lock screen, headphones and media keys see the item on
  // screen and can play, pause and move through the slideshow.
  $effect(() => {
    if (!asset) {
      return;
    }
    const date = fromISODateTimeUTC(asset.localDateTime);
    return bindMediaSession({
      // a Locked item never reaches the lock screen or the OS media controls
      locked: asset.visibility === AssetVisibility.Locked,
      title: asset.originalFileName,
      artist: title || MEDIA_SESSION_ARTIST,
      album: [date.isValid ? date.toLocaleString(DateTime.DATE_MED, { locale: $locale }) : '', asset.exifInfo?.city]
        .filter(Boolean)
        .join(' · '),
      artwork: getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
      playing: isVideoSlide ? undefined : playing,
      controls: { play, pause, previous: onPrevious, next: onNext },
    });
  });

  const shortcutBindings = $derived.by((): ShortcutOptions[] => {
    // MediaViewer.jsx:733-747: Escape closes the settings first; with them open, the arrow keys
    // stay with their controls. Otherwise Escape is the header's Close viewer.
    if ($settingsOpen) {
      return [{ shortcut: { key: 'Escape' }, onShortcut: () => void closeSettings() }];
    }
    const bindings: ShortcutOptions[] = [
      { shortcut: { key: 'ArrowLeft' }, onShortcut: () => (isForwardKey('ArrowLeft') ? onNext() : onPrevious()) },
      { shortcut: { key: 'ArrowRight' }, onShortcut: () => (isForwardKey('ArrowRight') ? onNext() : onPrevious()) },
      { shortcut: { key: 's' }, onShortcut: togglePause, preventDefault: true },
    ];

    // For videos, allow the native HTML5 element to handle space for play/pause
    if (!isVideoSlide) {
      bindings.push({ shortcut: { key: ' ' }, onShortcut: togglePause, preventDefault: true });
    }

    return bindings;
  });
</script>

<svelte:document use:shortcuts={shortcutBindings} onpointerdown={onPointerDown} onpointerup={onPointerUp} />

<!-- media-viewer.css:425-450: the thin accent line along the top of the canvas, under the header -->
{#if !isVideoSlide}
  <div
    class="frameleaf slideshow-progress"
    data-theme="dark"
    data-testid="slideshow-progress"
    class:hidden={!$showProgressBar}
    class:chrome-hidden={chromeHidden}
    aria-hidden="true"
  >
    <ProgressBar
      autoplay={playing}
      hidden={!$showProgressBar}
      duration={$slideshowDelay}
      bind:this={progressBar}
      bind:status={progressBarStatus}
      onDone={handleDone}
    />
  </div>
{/if}

<style>
  /* media-viewer.css:425-434: the canvas's top edge, which is the bottom of the 64px header. */
  .slideshow-progress {
    position: fixed;
    top: calc(max(8px, env(safe-area-inset-top)) + 56px);
    left: 0;
    right: 0;
    z-index: 3;
    height: 3px;
    background: var(--fl-viewer-border);
    pointer-events: none;
    transition: top var(--fl-motion) var(--fl-ease);
  }
  /* With the chrome tucked away the line runs along the top of the screen. */
  .slideshow-progress.chrome-hidden {
    top: 0;
  }
  .slideshow-progress :global(span) {
    top: 0;
    background: var(--fl-accent);
  }
  @media (prefers-reduced-motion: reduce) {
    .slideshow-progress {
      transition: none;
    }
  }
</style>
