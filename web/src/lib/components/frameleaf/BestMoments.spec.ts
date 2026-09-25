import { AssetTypeEnum, type BestPhotoAssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetFactory } from '@test-data/factories/asset-factory';
import BestMoments from './BestMoments.svelte';

const ranked = (id: string, type: AssetTypeEnum, bestFrameTimestampMs: number | null) =>
  ({
    ...assetFactory.build({ id, type, originalFileName: `${id}.mov` }),
    bestPhotoScore: {
      score: 0.95,
      aestheticScore: null,
      technicalScore: null,
      subjectScore: null,
      diversityScore: null,
      scoreVersion: 1,
      computedAt: '2026-09-24T00:00:00.000Z',
      metadata: null,
      bestFrameTimestampMs,
      frameScore: 0.9,
      frameMetadata: null,
    },
  }) as BestPhotoAssetResponseDto;

/** A moments index with `frames` frames a second apart; `coverAt` is the effective cover frame's time. */
const index = (frames: number, coverAt: number | null = null) =>
  ({
    frames: Array.from({ length: frames }, (_, i) => ({
      id: `f${i}`,
      timestampMs: i * 1000,
      isCover: i * 1000 === coverAt,
    })),
  }) as never;

/** FL-50: ranked video-frame moment and cover actions, only where supported. */
describe('BestMoments', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows nothing when no ranked video has a best frame', () => {
    render(BestMoments, {
      assets: [ranked('photo', AssetTypeEnum.Image, null), ranked('old', AssetTypeEnum.Video, null)],
      onPlay: vi.fn(),
    });
    expect(screen.queryByRole('region')).toBeNull();
    expect(sdkMock.getVideoMoments).not.toHaveBeenCalled();
  });

  it('plays a video from its best moment', async () => {
    sdkMock.getVideoMoments.mockResolvedValue(index(0));
    const onPlay = vi.fn();
    const clip = ranked('clip', AssetTypeEnum.Video, 65_000);
    render(BestMoments, { assets: [clip], onPlay });

    await fireEvent.click(screen.getByRole('button', { name: 'Play clip.mov from 1:05' }));
    expect(onPlay).toHaveBeenCalledWith({ asset: clip, timestampMs: 65_000 });
    await fireEvent.click(screen.getByRole('button', { name: 'Play from 1:05' }));
    expect(onPlay).toHaveBeenCalledTimes(2);
  });

  it('offers the cover only once the video has frames to cover from', async () => {
    sdkMock.getVideoMoments.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(index(id === 'framed' ? 4 : 0)),
    );
    render(BestMoments, {
      assets: [ranked('framed', AssetTypeEnum.Video, 2000), ranked('bare', AssetTypeEnum.Video, 3000)],
      onPlay: vi.fn(),
    });

    expect(await screen.findAllByRole('button', { name: 'Use as cover' })).toHaveLength(1);
  });

  it('makes the best moment the cover', async () => {
    sdkMock.getVideoMoments.mockResolvedValue(index(4, 0));
    sdkMock.setVideoMomentCover.mockResolvedValue(index(4, 2000));
    render(BestMoments, { assets: [ranked('framed', AssetTypeEnum.Video, 2000)], onPlay: vi.fn() });

    await fireEvent.click(await screen.findByRole('button', { name: 'Use as cover' }));
    expect(sdkMock.setVideoMomentCover).toHaveBeenCalledWith({
      id: 'framed',
      videoMomentCoverDto: { timestampMs: 2000 },
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use as cover' })).toBeNull());
    expect(screen.getByText('Cover')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('framed.mov now uses its moment at 0:02 as the cover.');
  });

  it('offers no cover action for the moment that already is the cover, by default or by choice', async () => {
    // no cover chosen: the best-ranked frame (here at 2s, nearest the moment at 2.3s) is the cover
    sdkMock.getVideoMoments.mockResolvedValue(index(4, 2000));
    render(BestMoments, { assets: [ranked('framed', AssetTypeEnum.Video, 2300)], onPlay: vi.fn() });

    expect(await screen.findByText('Cover')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as cover' })).toBeNull();
  });

  it('plays but never covers when the moments index cannot be read', async () => {
    sdkMock.getVideoMoments.mockRejectedValue(new Error('enrichment off'));
    render(BestMoments, { assets: [ranked('clip', AssetTypeEnum.Video, 2000)], onPlay: vi.fn() });
    await waitFor(() => expect(sdkMock.getVideoMoments).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Play from 0:02' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as cover' })).toBeNull();
  });
});
