import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { renderWithTooltips } from '$tests/helpers';
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
});
