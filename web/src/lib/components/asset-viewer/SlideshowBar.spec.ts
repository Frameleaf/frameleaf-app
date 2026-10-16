import { AssetTypeEnum, AssetVisibility } from '@frameleaf/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { get } from 'svelte/store';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
import { progressBarCalls } from '@test-data/components/progress-bar-calls';
import { assetFactory } from '@test-data/factories/asset-factory';
import SlideshowBar from './SlideshowBar.svelte';

const mocks = vi.hoisted(() => ({
  acquireWakeLock: vi.fn(() => Promise.resolve()),
  releaseWakeLock: vi.fn(() => Promise.resolve()),
  cleanup: vi.fn(),
  bindMediaSession: vi.fn(),
}));

vi.mock('$lib/utils/wakelock.svelte', () => ({
  acquireWakeLock: mocks.acquireWakeLock,
  releaseWakeLock: mocks.releaseWakeLock,
}));

vi.mock('$lib/components/shared-components/progress-bar/ProgressBar.svelte', async () => {
  const { default: MockProgressBar } = await import('@test-data/components/MockProgressBar.svelte');
  return { default: MockProgressBar };
});

vi.mock('$lib/frameleaf/media-session', () => ({
  MEDIA_SESSION_ARTIST: 'Frameleaf',
  bindMediaSession: mocks.bindMediaSession,
}));

type Binding = {
  locked?: boolean;
  title: string;
  artist: string;
  controls: { play?: () => void; pause?: () => void; previous?: () => void; next?: () => void };
};
const lastBinding = () => mocks.bindMediaSession.mock.calls.at(-1)?.[0] as Binding | undefined;

describe('SlideshowBar (FL-36)', () => {
  beforeEach(() => {
    mocks.bindMediaSession.mockImplementation(() => mocks.cleanup);
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
  });

  afterEach(() => {
    vi.clearAllMocks();
    void slideshowStore.closeSettings({ restoreFocus: false });
    slideshowStore.slideshowState.set(SlideshowState.None);
    document.body.style.cursor = '';
  });

  const renderBar = (props: Partial<Parameters<typeof renderWithTooltips>[1]> = {}) => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image, originalFileName: 'IMG_0001.jpg' });
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const result = renderWithTooltips(SlideshowBar, {
      assetType: AssetTypeEnum.Image,
      asset,
      title: 'Lisbon',
      onNext,
      onPrevious,
      ...props,
    });
    return { ...result, asset, onNext, onPrevious };
  };

  /** The viewer footer's cog (V-13), which opens the settings through the shared store. */
  const footerCog = () => {
    const cog = document.createElement('button');
    cog.setAttribute('aria-label', 'footer cog');
    document.body.append(cog);
    return cog;
  };
  const openSettingsFromFooter = () => {
    const cog = footerCog();
    cog.focus();
    slideshowStore.toggleSettings(cog);
    flushSync();
    return cog;
  };

  it('keeps the screen awake while playing and lets go when paused', async () => {
    renderBar();
    await waitFor(() => expect(mocks.acquireWakeLock).toHaveBeenCalledWith('slideshow'));

    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    await waitFor(() => expect(mocks.releaseWakeLock).toHaveBeenCalledWith('slideshow'));
  });

  it('keeps the screen awake while the settings are open, even when paused', async () => {
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    renderBar();
    await waitFor(() => expect(mocks.releaseWakeLock).toHaveBeenCalled());
    mocks.acquireWakeLock.mockClear();

    openSettingsFromFooter();
    await waitFor(() => expect(mocks.acquireWakeLock).toHaveBeenCalledWith('slideshow'));
  });

  it('releases the wake lock when the slideshow closes', async () => {
    const { unmount } = renderBar();
    unmount();
    expect(mocks.releaseWakeLock).toHaveBeenCalledWith('slideshow');
  });

  it('publishes the item to Media Session and drives the slideshow from the media keys', async () => {
    const { asset, onNext, onPrevious } = renderBar();
    await waitFor(() => expect(mocks.bindMediaSession).toHaveBeenCalled());

    const binding = lastBinding()!;
    expect(binding).toMatchObject({ locked: false, title: asset.originalFileName, artist: 'Lisbon' });
    binding.controls.pause?.();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow);
    lastBinding()!.controls.play?.();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    lastBinding()!.controls.next?.();
    lastBinding()!.controls.previous?.();
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrevious).toHaveBeenCalledOnce();
  });

  it('marks a Locked item so nothing about it is published', async () => {
    const locked = assetFactory.build({ type: AssetTypeEnum.Image, visibility: AssetVisibility.Locked });
    renderBar({ asset: locked });
    await waitFor(() => expect(mocks.bindMediaSession).toHaveBeenCalled());
    expect(lastBinding()?.locked).toBe(true);
  });

  it('clears the Media Session when the slideshow closes', async () => {
    const { unmount } = renderBar();
    await waitFor(() => expect(mocks.bindMediaSession).toHaveBeenCalled());
    unmount();
    expect(mocks.cleanup).toHaveBeenCalled();
  });

  it('opens the settings without pausing and returns focus to the footer cog on Escape', async () => {
    renderBar();
    const button = openSettingsFromFooter();
    button.blur();

    expect(get(slideshowStore.settingsOpen)).toBe(true);
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
    await waitFor(() => expect(button).toHaveFocus());
    // Escape closed the panel, not the slideshow
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });

  it('closes the settings when the slideshow ends', async () => {
    const { unmount } = renderBar();
    openSettingsFromFooter();
    unmount();
    expect(get(slideshowStore.settingsOpen)).toBe(false);
  });

  // VIEWER-P1: the viewer keeps its header, arrows and footer, so no floating capsule is drawn.
  it('draws no controls of its own, only the progress line', () => {
    const { container } = renderBar();
    expect(screen.queryByTestId('slideshow-controls')).not.toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(screen.getByTestId('slideshow-progress')).toBeInTheDocument();
  });

  it('moves with the arrow keys', async () => {
    const { onNext, onPrevious } = renderBar();
    await fireEvent.keyDown(document, { key: 'ArrowRight' });
    await fireEvent.keyDown(document, { key: 'ArrowLeft' });
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrevious).toHaveBeenCalledOnce();
  });

  it('plays and pauses with S, and follows play and pause set from the footer', async () => {
    renderBar();
    await fireEvent.keyDown(document, { key: 's' });
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow);
    await fireEvent.keyDown(document, { key: 's' });
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    progressBarCalls.length = 0;
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    await waitFor(() => expect(progressBarCalls).toEqual(['pause']));
  });

  // MediaViewer.jsx:733-747: Escape closes the settings first; after that it is the header's Close viewer.
  it('closes the settings on Escape and leaves the next Escape to the viewer', async () => {
    renderBar();
    openSettingsFromFooter();
    expect(get(slideshowStore.settingsOpen)).toBe(true);

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });

  it('does not end the slideshow when full screen is left', async () => {
    renderBar();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });

  // MediaViewer.jsx:422-460: the open settings hold the advance without changing play or pause.
  it('holds the progress while the settings are open and resumes on close', async () => {
    renderBar();
    await tick();
    progressBarCalls.length = 0;

    openSettingsFromFooter();
    await waitFor(() => expect(progressBarCalls).toEqual(['pause']));
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    await slideshowStore.closeSettings();
    await waitFor(() => expect(progressBarCalls).toEqual(['pause', 'play']));
  });

  it('stays paused after the settings close when it was paused', async () => {
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    renderBar();
    progressBarCalls.length = 0;
    openSettingsFromFooter();
    await slideshowStore.closeSettings();
    await Promise.resolve();
    expect(progressBarCalls).not.toContain('play');
  });

  // VIEWER-P1: the chrome stays up (MediaViewer.jsx has no idle hide); a tap toggles it.
  describe('chrome', () => {
    let canvas: HTMLElement;
    beforeEach(() => {
      if (!('PointerEvent' in globalThis)) {
        // jsdom has no PointerEvent; a MouseEvent carries the coordinates a tap needs
        vi.stubGlobal(
          'PointerEvent',
          class extends MouseEvent {
            pointerType: string;
            constructor(type: string, init: PointerEventInit = {}) {
              super(type, init);
              this.pointerType = init.pointerType ?? '';
            }
          },
        );
      }
      vi.useFakeTimers();
      canvas = document.createElement('div');
      canvas.dataset.viewerContent = '';
      document.body.append(canvas);
    });
    afterEach(() => {
      canvas.remove();
      vi.useRealTimers();
    });

    // The progress line follows the shared chrome state: under the header, or at the top when hidden.
    const progress = () => screen.getByTestId('slideshow-progress');
    const tapCanvas = async () => {
      await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      await fireEvent.pointerUp(canvas, { clientX: 11, clientY: 10 });
    };

    it('never hides the chrome by itself', async () => {
      renderBar();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(progress()).not.toHaveClass('chrome-hidden');
      expect(document.body.style.cursor).toBe('');
    });

    // MediaViewer.jsx:559-583: a tap on the photo toggles the chrome.
    it('toggles the chrome with a tap on the photo', async () => {
      renderBar();

      await tapCanvas();
      expect(progress()).toHaveClass('chrome-hidden');
      await tapCanvas();
      expect(progress()).not.toHaveClass('chrome-hidden');

      // a drag is not a tap
      await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      await fireEvent.pointerUp(canvas, { clientX: 60, clientY: 10 });
      expect(progress()).not.toHaveClass('chrome-hidden');
    });

    it('reveals hidden chrome with a swipe down', async () => {
      renderBar();
      await tapCanvas();
      expect(progress()).toHaveClass('chrome-hidden');

      await fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
      await fireEvent.pointerUp(canvas, { clientX: 105, clientY: 220 });
      expect(progress()).not.toHaveClass('chrome-hidden');
    });

    it('brings the chrome back when the settings open', async () => {
      renderBar();
      await tapCanvas();
      expect(progress()).toHaveClass('chrome-hidden');
      openSettingsFromFooter();
      await vi.advanceTimersByTimeAsync(0);
      expect(progress()).not.toHaveClass('chrome-hidden');
    });
  });
});
