<script lang="ts">
  /**
   * Slideshow controls (FL-36, V-18). The slideshow plays inside the viewer (MediaViewer.jsx:254-263);
   * full screen is the viewer footer's control, never forced. Play, pause and the settings live in the
   * viewer footer (V-13), which drives the same state (`slideshowStore.slideshowState`,
   * `slideshowStore.toggleSettings`); this adds a small frosted capsule over the top of the canvas
   * with what the footer lacks (end slideshow, previous, next), the thin accent progress line along
   * the top edge (media-viewer.css:425-450), the S and Space keys, the wake lock and Media Session.
   *
   * The viewer's chrome (header, footer and this capsule) is one state, `chromeHidden`, shared with
   * the viewer's own tap-to-hide. While a slideshow runs it hides after 2.5 s without movement
   * (source behaviour), with the pointer; moving a mouse, swiping down, or keyboard focus inside the
   * chrome shows it again, and a tap on the photo toggles it (MediaViewer.jsx:559-572,
   * `.chrome-hidden`, apple-style.css:393-404). While the settings panel is open the slideshow holds:
   * the progress stops and a video pauses, without changing play or pause (MediaViewer.jsx:422-460).
   *
   * Escape follows MediaViewer.jsx:733-747: it closes the settings panel first, then leaves full
   * screen (the browser does that itself), then ends the slideshow.
   */
  import { shortcuts, type ShortcutOptions } from '$lib/actions/shortcut';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import ProgressBar from '$lib/components/shared-components/progress-bar/ProgressBar.svelte';
  import { ProgressBarStatus } from '$lib/constants';
  import { bindMediaSession, MEDIA_SESSION_ARTIST } from '$lib/frameleaf/media-session';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { AssetMediaSize, AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronLeft, mdiChevronRight, mdiClose } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    /** The viewer's shared chrome state (header, footer and these controls). */
    chromeHidden?: boolean;
    assetType: AssetTypeEnum;
    /** The item on screen, for the lock screen and media keys (Media Session). */
    asset?: AssetResponseDto;
    /** The collection being played, such as the album's name. */
    title?: string;
    onNext?: () => void;
    onPrevious?: () => void;
    onClose?: () => void;
  }

  let {
    chromeHidden = $bindable(false),
    assetType,
    asset,
    title,
    onNext = () => {},
    onPrevious = () => {},
    onClose = () => {},
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

  const handleDone = async () => {
    await progressBar?.resetProgress();

    if ($slideshowNavigation === SlideshowNavigation.AscendingOrder) {
      onPrevious();
      return;
    }
    onNext();
  };

  // Play and pause are the slideshow state; the progress line follows it, whoever changed it
  // (these controls, the viewer footer, Space, S or the media keys).
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

  // Idle auto-hide (source behaviour, 2.5 s), swipe down on the photo to reveal, tap to toggle
  // (MediaViewer.jsx:559-572).
  const IDLE_HIDE_MS = 2500;
  const controlsVisible = $derived(!chromeHidden);
  let controlsElement = $state<HTMLElement>();
  let pointerOverControls = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // the capsule and the viewer's header and footer (data-viewer-chrome) are one chrome
  const CHROME = '[data-testid="slideshow-controls"], [data-viewer-chrome]';
  const inChrome = (node: EventTarget | Element | null) => node instanceof Element && !!node.closest(CHROME);
  /**
   * Visible focus in the chrome holds it on screen: a keyboard or screen-reader user there, or focus
   * returned to the cog when the settings close. A button left focused by a click is not
   * focus-visible, so it lets the idle hide run again.
   */
  const focusVisible = (element: Element) => {
    try {
      return element.matches(':focus-visible');
    } catch {
      // an engine without :focus-visible (test DOMs): no focus is treated as visible
      return false;
    }
  };
  const focusInsideControls = () => {
    const active = document.activeElement;
    return !!active && inChrome(active) && focusVisible(active);
  };
  const setCursor = (value: string) => (document.body.style.cursor = value);
  const scheduleHide = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if ($settingsOpen || pointerOverControls || focusInsideControls()) {
        return;
      }
      chromeHidden = true;
      setCursor('none');
    }, IDLE_HIDE_MS);
  };
  const showControls = () => {
    chromeHidden = false;
    setCursor('');
    scheduleHide();
  };
  const hideControls = () => {
    clearTimeout(idleTimer);
    if ($settingsOpen || focusInsideControls()) {
      return;
    }
    chromeHidden = true;
  };
  // The viewer brings the chrome back on its own too (a key press, focus); every return restarts
  // the idle timer, so the chrome never stays up for good.
  $effect(() => {
    if (!chromeHidden) {
      untrack(() => {
        setCursor('');
        scheduleHide();
      });
    }
  });
  onMount(() => {
    scheduleHide();
    return () => {
      clearTimeout(idleTimer);
      setCursor('');
    };
  });
  // the settings panel keeps the controls on screen; closing it starts the idle timer again
  $effect(() => {
    if ($settingsOpen) {
      showControls();
    }
  });

  // the state at pointerdown decides the toggle, so a swipe-down reveal in between cannot undo it
  let tap: { x: number; y: number; time: number; visible: boolean } | undefined;
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Element | null;
    tap =
      target?.closest?.('[data-viewer-content]') && !inChrome(target)
        ? { x: event.clientX, y: event.clientY, time: performance.now(), visible: controlsVisible }
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
    // a swipe down reveals the controls (source behaviour)
    if (dy > 50 && Math.abs(dx) < dy) {
      showControls();
      return;
    }
    if (!(Math.hypot(dx, dy) < 6)) {
      return;
    }
    if (performance.now() - start.time >= 280) {
      return;
    }
    if (start.visible) {
      hideControls();
    } else {
      showControls();
    }
  };

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
    // stay with their controls
    if ($settingsOpen) {
      return [{ shortcut: { key: 'Escape' }, onShortcut: () => void closeSettings() }];
    }
    const bindings: ShortcutOptions[] = [
      { shortcut: { key: 'Escape' }, onShortcut: onClose },
      { shortcut: { key: 'ArrowLeft' }, onShortcut: onPrevious },
      { shortcut: { key: 'ArrowRight' }, onShortcut: onNext },
      { shortcut: { key: 's' }, onShortcut: togglePause, preventDefault: true },
    ];

    // For videos, allow the native HTML5 element to handle space for play/pause
    if (!isVideoSlide) {
      bindings.push({ shortcut: { key: ' ' }, onShortcut: togglePause, preventDefault: true });
    }

    return bindings;
  });
</script>

<svelte:document
  use:shortcuts={shortcutBindings}
  onpointermove={(event) => {
    // a touch tap is followed by a compatibility mousemove; only a real mouse reveals the chrome
    if (event.pointerType !== 'mouse') {
      return;
    }
    pointerOverControls = inChrome(event.target);
    showControls();
  }}
  onpointerdown={onPointerDown}
  onpointerup={onPointerUp}
/>

<!-- media-viewer.css:425-450: the thin accent line along the top of the canvas -->
{#if !isVideoSlide}
  <div class="frameleaf slideshow-progress" data-theme="dark" class:hidden={!$showProgressBar} aria-hidden="true">
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

<div
  class="frameleaf slideshow-controls"
  class:chrome-hidden={!controlsVisible}
  data-theme="dark"
  role="toolbar"
  tabindex="-1"
  aria-label={$t('slideshow')}
  data-testid="slideshow-controls"
  bind:this={controlsElement}
  onfocusin={showControls}
  onfocusout={scheduleHide}
  onpointerenter={() => (pointerOverControls = true)}
  onpointerleave={() => {
    pointerOverControls = false;
    scheduleHide();
  }}
>
  <IconButton label={$t('exit_slideshow')} onclick={onClose}>
    <Icon icon={mdiClose} size="1.25rem" />
  </IconButton>
  <IconButton label={$t('previous')} onclick={onPrevious}>
    <Icon icon={languageManager.rtl ? mdiChevronRight : mdiChevronLeft} size="1.25rem" />
  </IconButton>
  <IconButton label={$t('next')} onclick={onNext}>
    <Icon icon={languageManager.rtl ? mdiChevronLeft : mdiChevronRight} size="1.25rem" />
  </IconButton>
</div>

<style>
  /* media-viewer.css:425-434 */
  .slideshow-progress {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 3;
    height: 3px;
    background: #ffffff14;
    pointer-events: none;
  }
  .slideshow-progress :global(span) {
    top: 0;
    background: var(--fl-accent);
  }
  /* The prototype's capsule toolbar pattern (apple-style.css frosted materials, capsule toolbars),
     floating over the top of the canvas while the viewer header steps aside for the slideshow. */
  .slideshow-controls {
    position: fixed;
    top: max(12px, env(safe-area-inset-top));
    left: 50%;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    translate: -50% 0;
    color: var(--fl-viewer-text);
    background: color-mix(in srgb, var(--fl-viewer-panel) 72%, transparent);
    -webkit-backdrop-filter: blur(24px) saturate(1.6);
    backdrop-filter: blur(24px) saturate(1.6);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-pill);
    box-shadow: var(--fl-shadow-2);
  }
  /* apple-style.css:393-404 (.chrome-hidden): fades up out of the way; focus brings it back */
  .slideshow-controls {
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      translate var(--fl-motion) var(--fl-ease);
  }
  .slideshow-controls.chrome-hidden {
    opacity: 0;
    translate: -50% -12px;
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .slideshow-controls.chrome-hidden {
      translate: -50% 0;
    }
  }
  .slideshow-controls :global(button) {
    color: var(--fl-viewer-text);
    border-radius: var(--fl-radius-pill);
  }
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .slideshow-controls {
      background: var(--fl-viewer-panel);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
    }
  }
</style>
