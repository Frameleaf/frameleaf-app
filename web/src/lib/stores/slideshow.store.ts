import { persisted } from 'svelte-persisted-store';
import { get, writable } from 'svelte/store';

export enum SlideshowState {
  PlaySlideshow = 'play-slideshow',
  PauseSlideshow = 'pause-slideshow',
  StopSlideshow = 'stop-slideshow',
  None = 'none',
}

export enum SlideshowNavigation {
  Shuffle = 'shuffle',
  AscendingOrder = 'ascending-order',
  DescendingOrder = 'descending-order',
}

export enum SlideshowLook {
  Contain = 'contain',
  Cover = 'cover',
  BlurredBackground = 'blurred-background',
}

export enum SlideshowMetadataOverlayMode {
  DescriptionOnly = 'description-only',
  Full = 'full',
}

function createSlideshowStore() {
  const restartState = writable<boolean>(false);
  const stopState = writable<boolean>(false);

  const slideshowNavigation = persisted<SlideshowNavigation>(
    'slideshow-navigation',
    SlideshowNavigation.DescendingOrder,
  );
  const slideshowLook = persisted<SlideshowLook>('slideshow-look', SlideshowLook.Contain);
  const slideshowState = writable<SlideshowState>(SlideshowState.None);

  const showProgressBar = persisted<boolean>('slideshow-show-progressbar', true);
  const slideshowDelay = persisted<number>('slideshow-delay', 5, {});
  const slideshowTransition = persisted<boolean>('slideshow-transition', true);
  const slideshowAutoplay = persisted<boolean>('slideshow-autoplay', true, {});
  const slideshowRepeat = persisted<boolean>('slideshow-repeat', false);
  const slideshowShowMetadataOverlay = persisted<boolean>('slideshow-show-metadata-overlay', false);
  /**
   * V-13: whether the slideshow settings are open. The viewer footer's cog toggles it and whatever
   * presents the settings reads it; focus goes back to the button that opened them when they close.
   * (Same names as the inline slideshow's store, FL-62, so the two branches merge mechanically.)
   */
  const settingsOpenState = writable<boolean>(false);
  let settingsReturnFocus: HTMLElement | undefined;
  const openSettings = (buttonEl?: HTMLElement) => {
    settingsReturnFocus = buttonEl;
    settingsOpenState.set(true);
  };
  const closeSettings = () => {
    if (!get(settingsOpenState)) {
      return;
    }
    settingsOpenState.set(false);
    settingsReturnFocus?.focus();
    settingsReturnFocus = undefined;
  };
  const toggleSettings = (buttonEl?: HTMLElement) =>
    get(settingsOpenState) ? closeSettings() : openSettings(buttonEl);

  const slideshowMetadataOverlayMode = persisted<SlideshowMetadataOverlayMode>(
    'slideshow-metadata-overlay-mode',
    SlideshowMetadataOverlayMode.Full,
  );

  return {
    restartProgress: {
      subscribe: restartState.subscribe,
      set: (value: boolean) => {
        // Trigger an action whenever the restartProgress is set to true. Automatically
        // reset the restart state after that
        if (!value) {
          return;
        }

        restartState.set(true);
        restartState.set(false);
      },
    },
    stopProgress: {
      subscribe: stopState.subscribe,
      set: (value: boolean) => {
        // Trigger an action whenever the stopProgress is set to true. Automatically
        // reset the stop state after that
        if (!value) {
          return;
        }

        stopState.set(true);
        stopState.set(false);
      },
    },
    slideshowNavigation,
    slideshowLook,
    slideshowState,
    slideshowDelay,
    showProgressBar,
    slideshowTransition,
    slideshowAutoplay,
    slideshowRepeat,
    slideshowShowMetadataOverlay,
    slideshowMetadataOverlayMode,
    settingsOpen: { subscribe: settingsOpenState.subscribe },
    openSettings,
    closeSettings,
    toggleSettings,
  };
}

export const slideshowStore = createSlideshowStore();
