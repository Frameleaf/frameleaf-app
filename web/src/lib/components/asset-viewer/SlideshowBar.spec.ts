import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { get } from 'svelte/store';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
import { progressBarCalls } from '@test-data/components/progress-bar-calls';
import { assetFactory } from '@test-data/factories/asset-factory';
import { stubFocusVisible } from '@test-data/focus-visible';
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
    const result = renderWithTooltips(SlideshowBar, {
      assetType: AssetTypeEnum.Image,
      asset,
      title: 'Lisbon',
      onNext,
      onPrevious,
      onClose,
      ...props,
    });
    return { ...result, asset, onNext, onPrevious, onClose };
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

  // The viewer footer (V-13) owns Play/Pause and the cog; the capsule keeps end, previous and next.
  it('keeps only end, previous and next in the capsule', () => {
    renderBar();
    const labels = [...screen.getByTestId('slideshow-controls').querySelectorAll('button')].map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual(['exit_slideshow', 'previous', 'next']);
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

  // MediaViewer.jsx:733-747: Escape closes the settings first, then ends the slideshow.
  it('closes the settings on the first Escape and ends the slideshow on the next', async () => {
    const { onClose } = renderBar();
    openSettingsFromFooter();
    expect(get(slideshowStore.settingsOpen)).toBe(true);

    await fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(get(slideshowStore.settingsOpen)).toBe(false));
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not end the slideshow when full screen is left', async () => {
    const { onClose } = renderBar();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(onClose).not.toHaveBeenCalled();
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

  describe('idle auto-hide', () => {
    let canvas: HTMLElement;
    let focusVisible: ReturnType<typeof stubFocusVisible>;
    beforeEach(() => {
      focusVisible = stubFocusVisible();
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
      focusVisible.restore();
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

      const exit = screen.getByLabelText('exit_slideshow');
      focusVisible.visible.add(exit);
      exit.focus();
      await Promise.resolve();
      expect(controls()).not.toHaveClass('chrome-hidden');
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls()).not.toHaveClass('chrome-hidden');
    });

    // MediaViewer.jsx:740-744: Escape hands focus back to the cog, which is keyboard (visible) focus.
    it('keeps the chrome up when Escape returns focus to the cog', async () => {
      const { container } = renderBar();
      const footer = document.createElement('footer');
      footer.dataset.viewerChrome = 'footer';
      const cog = document.createElement('button');
      footer.append(cog);
      container.append(footer);
      focusVisible.visible.add(cog);
      cog.focus();
      slideshowStore.toggleSettings(cog);
      await vi.advanceTimersByTimeAsync(0);

      await fireEvent.keyDown(document, { key: 'Escape' });
      await vi.advanceTimersByTimeAsync(0);
      expect(get(slideshowStore.settingsOpen)).toBe(false);
      expect(cog).toHaveFocus();
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls()).not.toHaveClass('chrome-hidden');
      footer.remove();
    });

    it('keeps the controls while the settings are open', async () => {
      renderBar();
      openSettingsFromFooter().blur();
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
