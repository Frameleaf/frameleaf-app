import { AssetTypeEnum } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { ProjectionType } from '$lib/constants';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoWrapperViewer from './VideoWrapperViewer.svelte';

vi.mock('./VideoNativeViewer.svelte', async () => ({
  default: (await import('@test-data/components/VideoPlaybackProbe.svelte')).default,
}));
vi.mock('./PhotoSphereViewerAdapter.svelte', async () => ({
  default: (await import('@test-data/components/PanoramaSourceProbe.svelte')).default,
}));
vi.mock('@photo-sphere-viewer/equirectangular-video-adapter', () => ({ EquirectangularVideoAdapter: class {} }));
vi.mock('@photo-sphere-viewer/video-plugin', () => ({ VideoPlugin: class {} }));
vi.mock('@photo-sphere-viewer/video-plugin/index.css', () => ({}));

const renderVideo = (projectionType: string | null) =>
  render(VideoWrapperViewer, {
    asset: assetFactory.build({ type: AssetTypeEnum.Video, exifInfo: { projectionType } }),
    projectionType,
    cacheKey: null,
    loopVideo: false,
    playOriginalVideo: false,
  });

describe('VideoWrapperViewer (FL-968)', () => {
  it.each([ProjectionType.DUAL_FISHEYE, ProjectionType.EQUIANGULAR_CUBEMAP])(
    'plays %s video stitched in the panorama viewer, without the raw original',
    async (projectionType) => {
      renderVideo(projectionType);
      const panorama = await screen.findByTestId('panorama');
      expect(panorama.dataset.source).toContain('/video/playback');
      expect(panorama.dataset.original).toBe('');
      expect(screen.queryByTestId('video-source')).toBeNull();
    },
  );

  it('keeps the original resolution for an equirectangular video', async () => {
    renderVideo(ProjectionType.EQUIRECTANGULAR);
    const panorama = await screen.findByTestId('panorama');
    expect(panorama.dataset.original).not.toBe('');
  });

  it.each([null, ProjectionType.NONE, ProjectionType.CUBEMAP])(
    'plays %s video in the ordinary player',
    (projectionType) => {
      renderVideo(projectionType);
      expect(screen.getByTestId('video-source')).toBeTruthy();
      expect(screen.queryByTestId('panorama')).toBeNull();
    },
  );
});
