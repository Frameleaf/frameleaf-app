import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
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
    const onClose = vi.fn();
    const onToggleFullScreen = vi.fn();
    const result = renderWithTooltips(SlideshowBar, {
      isFullScreen: true,
      assetType: AssetTypeEnum.Image,
      asset,
      title: 'Lisbon',
      onNext,
      onPrevious,
      onClose,
      onToggleFullScreen,
      ...props,
    });
    return { ...result, asset, onNext, onPrevious, onClose, onToggleFullScreen };
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

    await fireEvent.click(screen.getByLabelText('slideshow_settings'));
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

  it('opens the settings without pausing and returns focus to the settings button on Escape', async () => {
    renderBar();
    const button = screen.getByLabelText('slideshow_settings');
    await fireEvent.click(button);

    expect(get(slideshowStore.settingsOpen)).toBe(true);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
    await waitFor(() => expect(button).toHaveFocus());
    // Escape closed the panel, not the slideshow
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });

  it('closes the settings when the slideshow ends', async () => {
    const { unmount } = renderBar();
    await fireEvent.click(screen.getByLabelText('slideshow_settings'));
    unmount();
    expect(get(slideshowStore.settingsOpen)).toBe(false);
  });

  // The viewer footer (Packet 4A) drives the same state as these controls.
  it('follows play and pause set from elsewhere', async () => {
    renderBar();
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    expect(await screen.findByLabelText('frameleaf_slideshow_play')).toBeInTheDocument();
    slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
    expect(await screen.findByLabelText('frameleaf_slideshow_pause')).toBeInTheDocument();
  });

  // V-18: the slideshow plays in the viewer, with its controls in a bar along the bottom.
  it('plays in the viewer, offering full screen as a choice', async () => {
    const requestFullscreen = vi.fn();
    Element.prototype.requestFullscreen = requestFullscreen;
    const { onToggleFullScreen } = renderBar({ isFullScreen: false });

    expect(screen.getByRole('toolbar', { name: 'slideshow' })).toBe(screen.getByTestId('slideshow-controls'));
    expect(requestFullscreen).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByLabelText('frameleaf_slideshow_enter_full_screen'));
    expect(onToggleFullScreen).toHaveBeenCalledOnce();
  });

  it('offers Exit full screen while full screen', () => {
    renderBar({ isFullScreen: true });
    expect(screen.getByLabelText('frameleaf_slideshow_exit_full_screen')).toBeInTheDocument();
  });

  it('plays and pauses from its button and S', async () => {
    renderBar();
    await fireEvent.click(screen.getByLabelText('frameleaf_slideshow_pause'));
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PauseSlideshow);
    await fireEvent.keyDown(document, { key: 's' });
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });

  // MediaViewer.jsx:733-747: Escape closes the settings first, then ends the slideshow.
  it('closes the settings on the first Escape and ends the slideshow on the next', async () => {
    const { onClose } = renderBar();
    await fireEvent.click(screen.getByLabelText('slideshow_settings'));
    expect(get(slideshowStore.settingsOpen)).toBe(true);

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not end the slideshow when full screen is left', async () => {
    const { onClose } = renderBar({ isFullScreen: true });
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(onClose).not.toHaveBeenCalled();
  });

  // MediaViewer.jsx:422-460: the open settings hold the advance without changing play or pause.
  it('holds the progress while the settings are open and resumes on close', async () => {
    renderBar();
    await waitFor(() => expect(screen.getByLabelText('frameleaf_slideshow_pause')).toBeInTheDocument());
    progressBarCalls.length = 0;

    await fireEvent.click(screen.getByLabelText('slideshow_settings'));
    await waitFor(() => expect(progressBarCalls).toEqual(['pause']));
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    await slideshowStore.closeSettings();
    await waitFor(() => expect(progressBarCalls).toEqual(['pause', 'play']));
  });

  it('stays paused after the settings close when it was paused', async () => {
    slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
    renderBar();
    progressBarCalls.length = 0;
    await fireEvent.click(screen.getByLabelText('slideshow_settings'));
    await slideshowStore.closeSettings();
    await Promise.resolve();
    expect(progressBarCalls).not.toContain('play');
  });

  describe('idle auto-hide', () => {
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

    const controls = () => screen.getByTestId('slideshow-controls');

    it('hides the controls and the pointer after 2.5 s, and movement shows them', async () => {
      renderBar();
      expect(controls()).not.toHaveClass('chrome-hidden');

      await vi.advanceTimersByTimeAsync(2500);
      expect(controls()).toHaveClass('chrome-hidden');
      expect(document.body.style.cursor).toBe('none');

      await fireEvent.pointerMove(document, { pointerType: 'mouse' });
      expect(controls()).not.toHaveClass('chrome-hidden');
      expect(document.body.style.cursor).toBe('');
    });

    it('still hides after a control is clicked', async () => {
      renderBar();
      const next = screen.getByLabelText('next');
      await fireEvent.pointerDown(next, { pointerType: 'mouse' });
      next.focus();
      await fireEvent.click(next);
      await fireEvent.pointerLeave(controls());

      await vi.advanceTimersByTimeAsync(2500);
      expect(next).toHaveFocus();
      expect(controls()).toHaveClass('chrome-hidden');
      expect(document.body.style.cursor).toBe('none');
    });

    it('keeps a tap on a touch screen from being undone by its compatibility mouse move', async () => {
      renderBar();
      await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerType: 'touch' });
      await fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerType: 'touch' });
      await fireEvent.mouseMove(document);
      await fireEvent.pointerMove(document, { pointerType: 'touch' });
      expect(controls()).toHaveClass('chrome-hidden');
    });

    it('shows the controls when keyboard focus moves into them and keeps them while focused', async () => {
      renderBar();
      await vi.advanceTimersByTimeAsync(2500);
      expect(controls()).toHaveClass('chrome-hidden');

      await fireEvent.keyDown(document, { key: 'Tab' });
      screen.getByLabelText('exit_slideshow').focus();
      await Promise.resolve();
      expect(controls()).not.toHaveClass('chrome-hidden');
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls()).not.toHaveClass('chrome-hidden');
    });

    it('keeps the controls while the settings are open', async () => {
      renderBar();
      await fireEvent.click(screen.getByLabelText('slideshow_settings'));
      screen.getByLabelText('slideshow_settings').blur();
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls()).not.toHaveClass('chrome-hidden');
    });

    // MediaViewer.jsx:559-572: a tap on the photo toggles the controls.
    it('toggles the controls with a tap on the photo', async () => {
      renderBar();
      const tapCanvas = async () => {
        await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
        await fireEvent.pointerUp(canvas, { clientX: 11, clientY: 10 });
      };

      await tapCanvas();
      expect(controls()).toHaveClass('chrome-hidden');
      await tapCanvas();
      expect(controls()).not.toHaveClass('chrome-hidden');

      // a drag is not a tap
      await fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      await fireEvent.pointerUp(canvas, { clientX: 60, clientY: 10 });
      expect(controls()).not.toHaveClass('chrome-hidden');
    });

    it('reveals hidden controls with a swipe down', async () => {
      renderBar();
      await vi.advanceTimersByTimeAsync(2500);
      expect(controls()).toHaveClass('chrome-hidden');

      await fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100 });
      await fireEvent.pointerUp(canvas, { clientX: 105, clientY: 220 });
      expect(controls()).not.toHaveClass('chrome-hidden');
    });
  });
});
