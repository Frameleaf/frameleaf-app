<script lang="ts">
  import { shortcuts, type ShortcutOptions } from '$lib/actions/shortcut';
  import ProgressBar from '$lib/components/shared-components/progress-bar/ProgressBar.svelte';
  import { ProgressBarStatus } from '$lib/constants';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import SlideshowSettingsDialog from '$lib/components/frameleaf/SlideshowSettingsDialog.svelte';
  import { bindMediaSession, MEDIA_SESSION_ARTIST } from '$lib/frameleaf/media-session';
  import { locale } from '$lib/stores/preferences.store';
  import { SlideshowNavigation, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { acquireWakeLock, releaseWakeLock } from '$lib/utils/wakelock.svelte';
  import { AssetMediaSize, AssetTypeEnum, type AssetResponseDto } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiChevronLeft, mdiChevronRight, mdiClose, mdiCog, mdiFullscreen, mdiPause, mdiPlay } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { useSwipe } from 'svelte-gestures';
  import { t } from 'svelte-i18n';
  import { motionFly } from '$lib/frameleaf/motion';

  interface Props {
    isFullScreen: boolean;
    assetType: AssetTypeEnum;
    /** The item on screen, for the lock screen and media keys (Media Session). */
    asset?: AssetResponseDto;
    /** The collection being played, such as the album's name. */
    title?: string;
    onNext?: () => void;
    onPrevious?: () => void;
    onClose?: () => void;
    onSetToFullScreen?: () => void;
  }

  let {
    isFullScreen,
    assetType,
    asset,
    title,
    onNext = () => {},
    onPrevious = () => {},
    onClose = () => {},
    onSetToFullScreen = () => {},
  }: Props = $props();

  const { restartProgress, stopProgress, slideshowDelay, showProgressBar, slideshowNavigation, slideshowState } =
    slideshowStore;

  let progressBarStatus: ProgressBarStatus | undefined = $state();
  let progressBar = $state<ReturnType<typeof ProgressBar>>();
  let showControls = $state(true);
  let timer: NodeJS.Timeout;
  let isOverControls = $state(false);
  const isVideoSlide = $derived(assetType === AssetTypeEnum.Video);

  let unsubscribeRestart: () => void;
  let unsubscribeStop: () => void;

  const setCursorStyle = (style: string) => {
    document.body.style.cursor = style;
  };

  const stopControlsHideTimer = () => {
    clearTimeout(timer);
    setCursorStyle('');
  };

  const showControlBar = () => {
    showControls = true;
    stopControlsHideTimer();
    hideControlsAfterDelay();
  };

  const hideControlsAfterDelay = () => {
    timer = setTimeout(() => {
      if (isOverControls) {
        return;
      }

      showControls = false;
      setCursorStyle('none');
    }, 2500);
  };

  onMount(() => {
    hideControlsAfterDelay();
    unsubscribeRestart = restartProgress.subscribe((value) => {
      if (value) {
        progressBar?.restart();
      }
    });

    unsubscribeStop = stopProgress.subscribe((value) => {
      if (!value) {
        return;
      }

      progressBar?.restart();
      stopControlsHideTimer();
    });
  });

  onDestroy(() => {
    setCursorStyle('');
    if (unsubscribeRestart) {
      unsubscribeRestart();
    }

    if (unsubscribeStop) {
      unsubscribeStop();
    }
  });

  const handleDone = async () => {
    await progressBar?.resetProgress();

    if ($slideshowNavigation === SlideshowNavigation.AscendingOrder) {
      onPrevious();
      return;
    }
    onNext();
  };

  // FL-36: the settings are a Frameleaf dialog over the slideshow (it stays full screen). The
  // slideshow holds still while they are open and carries on when they close.
  let settingsOpen = $state(false);
  let resumeAfterSettings = false;
  const onShowSettings = () => {
    resumeAfterSettings = progressBarStatus !== ProgressBarStatus.Paused && !isVideoSlide;
    if (resumeAfterSettings) {
      pause();
    }
    settingsOpen = true;
  };
  $effect(() => {
    if (settingsOpen || !resumeAfterSettings) {
      return;
    }
    resumeAfterSettings = false;
    play();
  });

  onMount(() => {
    function exitFullscreenHandler() {
      const doc = document as Document & {
        webkitIsFullScreen?: boolean;
      };

      if (!document.fullscreenElement && !doc.webkitIsFullScreen) {
        onClose();
      }
    }

    document.addEventListener('fullscreenchange', exitFullscreenHandler);
    document.addEventListener('webkitfullscreenchange', exitFullscreenHandler);

    return () => {
      document.removeEventListener('fullscreenchange', exitFullscreenHandler);
      document.removeEventListener('webkitfullscreenchange', exitFullscreenHandler);
    };
  });

  const { swipe, onswipe, onswipedown } = useSwipe(
    () => {},
    () => ({ touchAction: 'pan-x' }),
    { onswipedown: showControlBar },
    true,
  );

  const play = () => {
    $slideshowState = SlideshowState.PlaySlideshow;
    progressBar?.play();
  };

  const pause = () => {
    $slideshowState = SlideshowState.PauseSlideshow;
    progressBar?.pause();
  };

  const togglePause = () => {
    if (progressBarStatus === ProgressBarStatus.Paused) {
      play();
    } else {
      pause();
    }
  };

  // FL-36 (MediaViewer.jsx:863-885): keep the screen awake while the slideshow plays.
  $effect(() => {
    if ($slideshowState === SlideshowState.PlaySlideshow) {
      void acquireWakeLock('slideshow');
    } else {
      void releaseWakeLock('slideshow');
    }
  });
  onDestroy(() => void releaseWakeLock('slideshow'));

  // FL-36 (MediaViewer.jsx:886-923): the lock screen, headphones and media keys see the item on
  // screen and can play, pause and move through the slideshow.
  $effect(() => {
    if (!asset) {
      return;
    }
    const date = fromISODateTimeUTC(asset.localDateTime);
    return bindMediaSession({
      title: asset.originalFileName,
      artist: title || MEDIA_SESSION_ARTIST,
      album: [date.isValid ? date.toLocaleString(DateTime.DATE_MED, { locale: $locale }) : '', asset.exifInfo?.city]
        .filter(Boolean)
        .join(' · '),
      artwork: getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
      playing: isVideoSlide ? undefined : $slideshowState === SlideshowState.PlaySlideshow,
      controls: { play, pause, previous: onPrevious, next: onNext },
    });
  });

  const shortcutBindings = $derived.by((): ShortcutOptions[] => {
    // the settings dialog keeps Escape and the arrow keys to itself
    if (settingsOpen) {
      return [];
    }
    const bindings: ShortcutOptions[] = [
      { shortcut: { key: 'Escape' }, onShortcut: onClose },
      { shortcut: { key: 'ArrowLeft' }, onShortcut: onPrevious },
      { shortcut: { key: 'ArrowRight' }, onShortcut: onNext },
    ];

    // For videos, allow the native HTML5 element to handle space for play/pause
    if (!isVideoSlide) {
      bindings.push({
        shortcut: { key: ' ' },
        onShortcut: togglePause,
        preventDefault: true,
      });
    }

    return bindings;
  });
</script>

<svelte:document onmousemove={showControlBar} use:shortcuts={shortcutBindings} />

{/* @ts-expect-error https://github.com/Rezi/svelte-gestures/issues/38#issuecomment-3315953573 */ null}
<svelte:body {@attach swipe} {onswipe} {onswipedown} />

{#if showControls}
  <div
    class="dark m-4 flex gap-2 rounded-3xl bg-black/40 px-2 backdrop-blur-sm"
    onmouseenter={() => (isOverControls = true)}
    onmouseleave={() => (isOverControls = false)}
    transition:motionFly={{ duration: 150 }}
    role="navigation"
  >
    <IconButton
      variant="ghost"
      shape="round"
      color="secondary"
      icon={mdiClose}
      onclick={onClose}
      aria-label={$t('exit_slideshow')}
    />

    {#if !isVideoSlide}
      <IconButton
        variant="ghost"
        shape="round"
        color="secondary"
        icon={progressBarStatus === ProgressBarStatus.Paused ? mdiPlay : mdiPause}
        onclick={togglePause}
        aria-label={progressBarStatus === ProgressBarStatus.Paused ? $t('play') : $t('pause')}
      />
    {/if}
    <IconButton
      variant="ghost"
      shape="round"
      color="secondary"
      icon={languageManager.rtl ? mdiChevronRight : mdiChevronLeft}
      onclick={onPrevious}
      aria-label={$t('previous')}
    />
    <IconButton
      variant="ghost"
      shape="round"
      color="secondary"
      icon={languageManager.rtl ? mdiChevronLeft : mdiChevronRight}
      onclick={onNext}
      aria-label={$t('next')}
    />
    <IconButton
      variant="ghost"
      shape="round"
      color="secondary"
      icon={mdiCog}
      onclick={onShowSettings}
      aria-label={$t('slideshow_settings')}
    />
    {#if !isFullScreen}
      <IconButton
        variant="ghost"
        shape="round"
        color="secondary"
        icon={mdiFullscreen}
        onclick={onSetToFullScreen}
        aria-label={$t('set_slideshow_to_fullscreen')}
      />
    {/if}
  </div>
{/if}

{#if !isVideoSlide}
  <ProgressBar
    autoplay={$slideshowState === SlideshowState.PlaySlideshow}
    hidden={!$showProgressBar}
    duration={$slideshowDelay}
    bind:this={progressBar}
    bind:status={progressBarStatus}
    onDone={handleDone}
  />
{/if}

<SlideshowSettingsDialog bind:open={settingsOpen} />
