import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { showFilmstrip } from '$lib/frameleaf/viewer-preferences';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { setSharedLink } from '$lib/utils';
import { assetFactory } from '@test-data/factories/asset-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import ViewerFooter from './ViewerFooter.svelte';

const base = {
  canNavigateCollection: true,
  canShowFilmstrip: true,
  hasStack: false,
  zoomable: true,
  isPlayingOriginalVideo: false,
  setPlayOriginalVideo: vi.fn(),
  fullscreen: false,
  onToggleFullscreen: vi.fn(),
};

describe('ViewerFooter (V-13, MediaViewer.jsx:1693-1797)', () => {
  afterEach(() => {
    slideshowStore.slideshowState.set(SlideshowState.None);
    void slideshowStore.closeSettings();
    assetViewerManager.resetZoomState();
    showFilmstrip.set(false);
  });

  it('plays the slideshow through the existing slideshow state, with its shortcut in the title', async () => {
    render(ViewerFooter, { asset: assetFactory.build({ type: AssetTypeEnum.Image }), ...base });
    const play = screen.getByRole('button', { name: 'frameleaf_viewer_play_slideshow' });
    expect(play).toHaveAttribute('aria-pressed', 'false');
    expect(play).toHaveAttribute('title', 'frameleaf_viewer_play_slideshow_title');
    await fireEvent.click(play);
    expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_pause_slideshow' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('cannot play a slideshow with nothing to move to', () => {
    render(ViewerFooter, { asset: assetFactory.build(), ...base, canNavigateCollection: false });
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_play_slideshow' })).toBeDisabled();
  });

  it('applies the Play slideshow gate: never Locked, whatever a shared link allows (AL-37)', () => {
    const locked = render(ViewerFooter, {
      asset: assetFactory.build({ visibility: AssetVisibility.Locked }),
      ...base,
    });
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_play_slideshow' })).toBeDisabled();
    locked.unmount();

    setSharedLink(sharedLinkFactory.build({ allowDownload: false }));
    const noDownload = render(ViewerFooter, {
      asset: assetFactory.build({ visibility: AssetVisibility.Timeline }),
      ...base,
    });
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_play_slideshow' })).toBeEnabled();
    noDownload.unmount();

    setSharedLink(sharedLinkFactory.build({ allowDownload: true }));
    render(ViewerFooter, { asset: assetFactory.build({ visibility: AssetVisibility.Timeline }), ...base });
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_play_slideshow' })).toBeEnabled();
    setSharedLink(undefined);
  });

  it('announces the position and toggles the settings flag and the filmstrip', async () => {
    render(ViewerFooter, { asset: assetFactory.build(), ...base, position: { index: 4, total: 9 } });
    expect(screen.getByTestId('viewer-position')).toHaveAttribute('aria-live', 'polite');

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_viewer_slideshow_settings' }));
    expect(get(slideshowStore.settingsOpen)).toBe(true);

    const filmstrip = screen.getByRole('button', { name: 'frameleaf_viewer_show_filmstrip' });
    expect(filmstrip).toHaveAttribute('title', 'frameleaf_viewer_show_filmstrip_title');
    await fireEvent.click(filmstrip);
    expect(get(showFilmstrip)).toBe(true);
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_hide_filmstrip' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps zoom in the footer: out, Fit and in', () => {
    render(ViewerFooter, { asset: assetFactory.build({ type: AssetTypeEnum.Image }), ...base });
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_zoom_out' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_fit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_viewer_zoom_in' })).toBeEnabled();
  });

  it('offers the video source for a video and no zoom', async () => {
    const setPlayOriginalVideo = vi.fn();
    render(ViewerFooter, {
      asset: assetFactory.build({ type: AssetTypeEnum.Video }),
      ...base,
      zoomable: false,
      setPlayOriginalVideo,
    });
    expect(screen.getByRole('group', { name: 'frameleaf_viewer_video_source' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_viewer_play_original' }));
    expect(setPlayOriginalVideo).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: 'frameleaf_viewer_zoom_in' })).toBeNull();
  });

  it('hides the key hint from assistive technology and names the stack only with one', () => {
    const { container } = render(ViewerFooter, { asset: assetFactory.build(), ...base, hasStack: true });
    const hint = container.querySelector('.fl-key-hint')!;
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    expect(hint).toHaveTextContent('frameleaf_viewer_hint_stack');
  });
});
