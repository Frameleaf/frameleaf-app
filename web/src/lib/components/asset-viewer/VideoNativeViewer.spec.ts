import { AssetMediaSize, AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import Hls from 'hls.js';
import type { Component, ComponentProps } from 'svelte';
import { get } from 'svelte/store';
import { getResizeObserverMock } from '$lib/__mocks__/resize-observer.mock';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import ViewerFooter from '$lib/components/frameleaf/ViewerFooter.svelte';
import { clearMediaSession } from '$lib/frameleaf/media-session';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import { mediaCapabilitiesManager } from '$lib/managers/media-capabilities-manager.svelte';
import { videoQuality } from '$lib/stores/preferences.store';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { getAssetHlsUrl, getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import VideoNativeViewer from './VideoNativeViewer.svelte';

type ViewerProps = ComponentProps<typeof VideoNativeViewer>;

// TestWrapper's generic needs an index-signature props type, which the viewer's Props interface lacks.
const ViewerWrapper = TestWrapper as Component<{ component: typeof VideoNativeViewer; componentProps: ViewerProps }>;
const renderViewer = (props: ViewerProps) =>
  render(ViewerWrapper, { component: VideoNativeViewer, componentProps: props });

const hlsMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    stopLoad: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
    removeLevel: ReturnType<typeof vi.fn>;
    levels: Array<{ url: string[]; width?: number; height?: number }>;
    startLevel?: number;
  }>,
}));

vi.mock('hls-video-element', () => {
  class MockHlsVideo extends HTMLElement {
    api: (typeof hlsMocks.instances)[number] | undefined;
    videoRenditions = {
      selectedIndex: -1,
      getRenditionById: (id: string) => this.api?.levels[Number(id)] ?? null,
    };
    pause = vi.fn();
    currentTime = 0;
    get src() {
      return this.getAttribute('src') ?? '';
    }
    set src(value: string) {
      this.setAttribute('src', value);
      this.load();
    }
    load() {
      if (!this.src) {
        this.api = undefined;
        return;
      }
      this.api = {
        on: vi.fn(),
        off: vi.fn(),
        stopLoad: vi.fn(),
        startLoad: vi.fn(),
        removeLevel: vi.fn(),
        levels: [{ url: ['/video/stream/11111111-1111-1111-1111-111111111111/720p.m3u8'] }],
      };
      hlsMocks.instances.push(this.api);
    }
  }
  if (!customElements.get('hls-video')) {
    customElements.define('hls-video', MockHlsVideo);
  }
  return { default: MockHlsVideo };
});

vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    init: vi.fn(),
    loadFeatureFlags: vi.fn(),
    value: { realtimeTranscoding: false },
  } as never,
}));

vi.mock('media-chrome/media-control-bar', () => ({}));
vi.mock('media-chrome/media-controller', () => ({}));
vi.mock('media-chrome/media-fullscreen-button', () => ({}));
vi.mock('media-chrome/media-mute-button', () => ({}));
vi.mock('media-chrome/media-play-button', () => ({}));
vi.mock('media-chrome/media-playback-rate-button', () => ({}));
vi.mock('media-chrome/media-time-display', () => ({}));
vi.mock('media-chrome/media-time-range', () => ({
  default: class extends HTMLElement {
    connectedCallback() {}
    disconnectedCallback() {}
  },
}));
vi.mock('media-chrome/media-volume-range', () => ({}));
vi.mock('media-chrome/menu/media-playback-rate-menu', () => ({}));
vi.mock('media-chrome/menu/media-settings-menu', () => ({}));
vi.mock('media-chrome/menu/media-settings-menu-button', () => ({}));
vi.mock('media-chrome/menu/media-settings-menu-item', () => ({}));

describe('VideoNativeViewer component', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', getResizeObserverMock());
    vi.spyOn(Element.prototype, 'animate').mockReturnValue({ cancel: () => {} } as Animation);
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    assetViewerManager.closeEditor();
    authManager.reset();
    vi.clearAllMocks();
    featureFlagsManager.value.realtimeTranscoding = false;
    hlsMocks.instances.length = 0;
    videoQuality.set('auto');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('shows the editor control for editable owned videos and opens the editor drawer', async () => {
    const ownerId = 'owner-id';
    const asset = assetFactory.build({
      ownerId,
      type: AssetTypeEnum.Video,
      originalPath: '/upload/video.mp4',
      originalFileName: 'video.mp4',
      width: 1920,
      height: 1080,
      duration: 10_000,
    });

    authManager.setUser(userAdminFactory.build({ id: ownerId }));
    authManager.setPreferences(preferencesFactory.build());

    const { findByLabelText } = renderWithTooltips(VideoNativeViewer, {
      asset,
      assetId: asset.id,
      loopVideo: false,
      cacheKey: null,
      playOriginalVideo: false,
      extendedControls: true,
    });

    const editButton = await findByLabelText('editor_video_edit');
    await fireEvent.click(editButton);

    expect(assetViewerManager.isShowEditor).toBe(true);
  });
  const videoProps = () => {
    const asset = assetFactory.build({ ownerId: 'owner-id', type: AssetTypeEnum.Video, duration: 10_000 });
    authManager.setUser(userAdminFactory.build({ id: asset.ownerId }));
    authManager.setPreferences(preferencesFactory.build());
    return {
      asset,
      assetId: asset.id,
      loopVideo: false,
      cacheKey: null,
      playOriginalVideo: false,
      extendedControls: true,
    };
  };

  it('uses the navbar source choice even when realtime transcoding is enabled', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    const props = videoProps();
    const viewer = renderViewer(props);
    await waitFor(() =>
      expect(viewer.container.querySelector('hls-video')).toHaveAttribute('src', getAssetHlsUrl(props.asset.id)),
    );
    const api = hlsMocks.instances[0];
    // The source choice is the footer's Play original / Play encoded segment (V-13, MediaViewer.jsx:1765-1790).
    const footer = renderWithTooltips(ViewerFooter, {
      asset: props.asset,
      canNavigateCollection: false,
      canShowFilmstrip: false,
      hasStack: false,
      zoomable: false,
      isPlayingOriginalVideo: false,
      setPlayOriginalVideo: (value: boolean) =>
        viewer.rerender({ componentProps: { ...props, playOriginalVideo: value } }),
      fullscreen: false,
      onToggleFullscreen: () => {},
    });
    await fireEvent.click(footer.getByText('frameleaf_viewer_play_original'));
    await waitFor(() =>
      expect(viewer.container.querySelector('video')).toHaveAttribute(
        'src',
        getAssetMediaUrl({ id: props.asset.id, size: AssetMediaSize.Original, cacheKey: null }),
      ),
    );
    expect(viewer.container.querySelector('hls-video')).not.toBeInTheDocument();
    expect(viewer.container.querySelector('media-rendition-menu')).not.toBeInTheDocument();
    expect(api.stopLoad).toHaveBeenCalled();
    expect(api.off).toHaveBeenCalledTimes(3);
  });

  it('shows an accessible failure and retries the same original without falling back to HLS', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    const props = { ...videoProps(), playOriginalVideo: true };
    const viewer = renderViewer(props);
    const video = viewer.container.querySelector('video')!;
    const src = video.getAttribute('src');
    await fireEvent.error(video);
    expect(viewer.getByRole('alert')).toHaveTextContent('errors.failed_to_load_asset');
    expect(viewer.queryByRole('status', { name: 'loading' })).not.toBeInTheDocument();
    const beforeRetry = vi.mocked(HTMLMediaElement.prototype.load).mock.calls.length;
    await fireEvent.click(viewer.getByRole('button', { name: 'retry' }));
    expect(viewer.queryByRole('alert')).not.toBeInTheDocument();
    expect(viewer.getByRole('status', { name: 'loading' })).toBeInTheDocument();
    expect(video).toHaveAttribute('src', src);
    expect(viewer.container.querySelector('hls-video')).not.toBeInTheDocument();
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(beforeRetry + 1);
    await fireEvent.canPlay(video);
    expect(viewer.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the encoded playback URL when realtime transcoding is disabled', () => {
    const props = videoProps();
    const viewer = renderViewer(props);
    expect(viewer.container.querySelector('video')).toHaveAttribute(
      'src',
      getAssetPlaybackUrl({ id: props.asset.id, cacheKey: null }),
    );
  });

  it('retires the session and ignores a late capability result after switching sources', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    let finishCapabilities!: (value: Set<number>) => void;
    vi.spyOn(mediaCapabilitiesManager, 'efficientLevels').mockReturnValue(
      new Promise((resolve) => {
        finishCapabilities = resolve;
      }),
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    const props = videoProps();
    const viewer = renderViewer(props);
    await waitFor(() => expect(hlsMocks.instances[0]?.on).toHaveBeenCalled());
    const api = hlsMocks.instances[0];
    const manifestHandler = api.on.mock.calls.find(([event]) => event === Hls.Events.MANIFEST_PARSED)![1];
    const pending = manifestHandler();
    await viewer.rerender({ componentProps: { ...props, playOriginalVideo: true } });
    finishCapabilities(new Set([0]));
    await pending;
    expect(api.startLoad).not.toHaveBeenCalled();
    expect(api.off).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/video/stream/11111111-1111-1111-1111-111111111111'),
      { method: 'DELETE' },
    );
    fetchMock.mockRestore();
    vi.mocked(mediaCapabilitiesManager.efficientLevels).mockRestore();
  });
  it('ignores a pending play completion after the same video element changes assets', async () => {
    let finishPlay!: () => void;
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishPlay = resolve;
        }),
    );
    const onVideoStarted = vi.fn();
    const props = { ...videoProps(), onVideoStarted };
    const viewer = renderViewer(props);
    const video = viewer.container.querySelector('video')!;
    Object.defineProperty(video, 'paused', { configurable: true, value: false });
    await fireEvent.canPlay(video);
    expect(play).toHaveBeenCalledOnce();
    await viewer.rerender({ componentProps: { ...props, assetId: 'next-asset' } });
    finishPlay();
    await Promise.resolve();
    expect(onVideoStarted).not.toHaveBeenCalled();
    expect(viewer.getByRole('status', { name: 'loading' })).toBeInTheDocument();
    play.mockRestore();
  });

  it('reports fatal HLS failure and retries HLS without selecting original playback', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const props = videoProps();
    const viewer = renderViewer(props);
    await waitFor(() => expect(hlsMocks.instances[0]?.on).toHaveBeenCalled());
    const api = hlsMocks.instances[0];
    const errorHandler = api.on.mock.calls.find(([event]) => event === Hls.Events.ERROR)![1];
    errorHandler(Hls.Events.ERROR, { fatal: true, details: Hls.ErrorDetails.MANIFEST_LOAD_ERROR });
    expect(await viewer.findByRole('alert')).toBeInTheDocument();
    expect(viewer.queryByRole('status', { name: 'loading' })).not.toBeInTheDocument();
    await fireEvent.click(viewer.getByRole('button', { name: 'retry' }));
    expect(viewer.container.querySelector('hls-video')).toHaveAttribute('src', getAssetHlsUrl(props.assetId));
    expect(viewer.container.querySelector('video')).not.toBeInTheDocument();
    expect(hlsMocks.instances).toHaveLength(2);
    expect(api.off).toHaveBeenCalledTimes(3);
    expect(viewer.getByRole('status', { name: 'loading' })).toBeInTheDocument();
    errorLog.mockRestore();
  });

  it('stays on auto when the saved quality is corrupt', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    videoQuality.set('garbage' as unknown as number);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    vi.spyOn(mediaCapabilitiesManager, 'efficientLevels').mockResolvedValue(new Set([0, 1]));
    const viewer = renderViewer(videoProps());
    await waitFor(() => expect(hlsMocks.instances[0]?.on).toHaveBeenCalled());
    const api = hlsMocks.instances[0];
    const url = '/video/stream/11111111-1111-1111-1111-111111111111/0/playlist.m3u8';
    api.levels = [
      { url: [url], width: 854, height: 480 },
      { url: [url], width: 1280, height: 720 },
    ];
    const manifestHandler = api.on.mock.calls.find(([event]) => event === Hls.Events.MANIFEST_PARSED)![1];
    await manifestHandler();

    const element = viewer.container.querySelector('hls-video') as unknown as {
      videoRenditions: { selectedIndex: number };
    };
    expect(element.videoRenditions.selectedIndex).toBe(-1);
    expect(api.startLevel).toBeUndefined();
    viewer.unmount();
    fetchMock.mockRestore();
  });

  it('starts on the saved quality and saves the one picked from the quality menu', async () => {
    featureFlagsManager.value.realtimeTranscoding = true;
    videoQuality.set(720);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
    vi.spyOn(mediaCapabilitiesManager, 'efficientLevels').mockResolvedValue(new Set([0, 1, 2]));
    const viewer = renderViewer(videoProps());
    await waitFor(() => expect(hlsMocks.instances[0]?.on).toHaveBeenCalled());
    const api = hlsMocks.instances[0];
    const url = '/video/stream/11111111-1111-1111-1111-111111111111/0/playlist.m3u8';
    // Portrait levels: the short side is the width.
    api.levels = [
      { url: [url], width: 480, height: 854 },
      { url: [url], width: 720, height: 1280 },
      { url: [url], width: 1080, height: 1920 },
    ];
    const manifestHandler = api.on.mock.calls.find(([event]) => event === Hls.Events.MANIFEST_PARSED)![1];
    await manifestHandler();

    const element = viewer.container.querySelector('hls-video') as unknown as {
      videoRenditions: { selectedIndex: number };
    };
    expect(element.videoRenditions.selectedIndex).toBe(1);
    expect(api.startLevel).toBe(1);
    expect(api.startLoad).toHaveBeenCalled();

    const controller = viewer.container.querySelector('media-controller')!;
    controller.dispatchEvent(new CustomEvent('mediarenditionrequest', { detail: '2' }));
    expect(get(videoQuality)).toBe(1080);
    controller.dispatchEvent(new CustomEvent('mediarenditionrequest', { detail: 'auto' }));
    expect(get(videoQuality)).toBe('auto');
    viewer.unmount();
    fetchMock.mockRestore();
    vi.mocked(mediaCapabilitiesManager.efficientLevels).mockRestore();
  });

  // FL-36: media keys and the lock screen control the open video, never for a Locked one.
  describe('Media Session', () => {
    const handlers = new Map<string, (() => void) | null>();
    const session = {
      metadata: null as unknown,
      playbackState: 'none',
      setActionHandler: vi.fn((action: string, handler: (() => void) | null) => handlers.set(action, handler)),
    };

    beforeEach(() => {
      handlers.clear();
      Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
      vi.stubGlobal(
        'MediaMetadata',
        class {
          constructor(public init: MediaMetadataInit) {}
        },
      );
    });

    afterEach(() => {
      clearMediaSession();
      Reflect.deleteProperty(navigator, 'mediaSession');
      vi.stubGlobal('MediaMetadata', undefined);
      slideshowStore.slideshowState.set(SlideshowState.None);
    });

    it('publishes the open video and clears it on close', async () => {
      const props = videoProps();
      const viewer = renderViewer(props);

      await waitFor(() =>
        expect((session.metadata as { init?: MediaMetadataInit } | null)?.init?.title).toBe(
          props.asset.originalFileName,
        ),
      );
      expect(handlers.get('nexttrack')).toBeTypeOf('function');

      viewer.unmount();
      expect(session.metadata).toBeNull();
    });

    it('never publishes a Locked video', async () => {
      const props = videoProps();
      props.asset = { ...props.asset, visibility: AssetVisibility.Locked };
      renderViewer(props);

      await waitFor(() => expect(viewerVideo()).toBeTruthy());
      expect(session.metadata).toBeNull();
      expect([...handlers.values()].filter(Boolean)).toHaveLength(0);
    });

    it('pauses and resumes the video with the slideshow', async () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      renderViewer(videoProps());
      await waitFor(() => expect(viewerVideo()).toBeTruthy());
      pause.mockClear();

      slideshowStore.slideshowState.set(SlideshowState.PauseSlideshow);
      await waitFor(() => expect(pause).toHaveBeenCalled());
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      await waitFor(() => expect(play).toHaveBeenCalled());
      play.mockRestore();
    });

    // MediaViewer.jsx:422-460: the open settings hold the video without pausing the slideshow.
    it('holds the video while the slideshow settings are open', async () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const pause = vi.mocked(HTMLMediaElement.prototype.pause);
      slideshowStore.slideshowState.set(SlideshowState.PlaySlideshow);
      renderViewer(videoProps());
      await waitFor(() => expect(viewerVideo()).toBeTruthy());
      pause.mockClear();

      slideshowStore.openSettings();
      await waitFor(() => expect(pause).toHaveBeenCalled());
      expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow);

      await slideshowStore.closeSettings({ restoreFocus: false });
      await waitFor(() => expect(play).toHaveBeenCalled());
      play.mockRestore();
    });
  });
});

const viewerVideo = () => document.querySelector('video');
