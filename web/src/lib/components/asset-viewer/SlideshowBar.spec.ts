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
    slideshowStore.slideshowState.set(SlideshowState.None);
    document.body.style.cursor = '';
  });

  const renderBar = (props: Partial<Parameters<typeof renderWithTooltips>[1]> = {}) => {
    const asset = assetFactory.build({ type: AssetTypeEnum.Image, originalFileName: 'IMG_0001.jpg' });
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const result = renderWithTooltips(SlideshowBar, {
      isFullScreen: true,
      assetType: AssetTypeEnum.Image,
      asset,
      title: 'Lisbon',
      onNext,
      onPrevious,
      ...props,
    });
    return { ...result, asset, onNext, onPrevious };
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

  it('opens the settings as a panel and returns focus to the settings button on Escape', async () => {
    renderBar();
    const button = screen.getByLabelText('slideshow_settings');
    await fireEvent.click(button);

    const panel = await screen.findByTestId('slideshow-settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

    await fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('slideshow-settings')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText('slideshow_settings')).toHaveFocus());
    // Escape closed the panel, not the slideshow
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
  });
});
