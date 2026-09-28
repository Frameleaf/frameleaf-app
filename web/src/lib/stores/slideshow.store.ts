import { tick } from 'svelte';
import { persisted } from 'svelte-persisted-store';
import { get, writable } from 'svelte/store';
import {
  DEFAULT_SLIDESHOW_TRANSITION,
  slideshowTransitionSerializer,
  type SlideshowTransition,
} from '$lib/frameleaf/slideshow-transitions';

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
  // FL-36: one of five transitions. The key is unchanged; a stored boolean from before reads
  // as fade (true) or none (false) through the serializer.
  const slideshowTransition = persisted<SlideshowTransition>('slideshow-transition', DEFAULT_SLIDESHOW_TRANSITION, {
    serializer: slideshowTransitionSerializer,
  });
  const slideshowAutoplay = persisted<boolean>('slideshow-autoplay', true, {});
  const slideshowRepeat = persisted<boolean>('slideshow-repeat', false);
  const slideshowShowMetadataOverlay = persisted<boolean>('slideshow-show-metadata-overlay', false);
  const slideshowMetadataOverlayMode = persisted<SlideshowMetadataOverlayMode>(
    'slideshow-metadata-overlay-mode',
    SlideshowMetadataOverlayMode.Full,
  );

  /**
   * FL-36: whether the slideshow settings panel is open (MediaViewer.jsx `settingsOpen`). Any
   * control may open it (the slideshow controls, the viewer footer's cog, a More menu item); the
   * viewer renders the panel. Closing it returns focus to the control that opened it
   * (MediaViewer.jsx:740-744).
   */
  const settingsOpen = writable<boolean>(false);
  let settingsReturnFocus: HTMLElement | undefined;
  const openSettings = (returnFocus?: HTMLElement | null) => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    settingsReturnFocus = returnFocus ?? (active instanceof HTMLElement ? active : undefined);
    settingsOpen.set(true);
  };
  const closeSettings = async ({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
    const target = settingsReturnFocus;
    settingsReturnFocus = undefined;
    settingsOpen.set(false);
    if (!restoreFocus) {
      return;
    }
    await tick();
    if (target?.isConnected) {
      target.focus();
    }
  };
  const toggleSettings = (returnFocus?: HTMLElement | null) => {
    if (get(settingsOpen)) {
      void closeSettings();
    } else {
      openSettings(returnFocus);
    }
  };

  return {
    settingsOpen: { subscribe: settingsOpen.subscribe },
    openSettings,
    closeSettings,
    toggleSettings,
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
  };
}

export const slideshowStore = createSlideshowStore();
