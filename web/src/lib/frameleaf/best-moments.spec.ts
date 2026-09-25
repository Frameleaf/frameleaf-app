import { AssetTypeEnum, type BestPhotoAssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { bestMomentsOf, isEffectiveCover } from '$lib/frameleaf/best-moments';
import { assetFactory } from '@test-data/factories/asset-factory';

const ranked = (type: AssetTypeEnum, bestFrameTimestampMs: number | null): BestPhotoAssetResponseDto =>
  ({
    ...assetFactory.build({ type }),
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
      frameScore: null,
      frameMetadata: null,
    },
  }) as BestPhotoAssetResponseDto;

describe('bestMomentsOf', () => {
  it('lists the ranked videos that have a best frame, in ranking order, with its time', () => {
    const first = ranked(AssetTypeEnum.Video, 12_500);
    const second = ranked(AssetTypeEnum.Video, 0);
    expect(bestMomentsOf([first, ranked(AssetTypeEnum.Image, null), second])).toEqual([
      { asset: first, timestampMs: 12_500 },
      { asset: second, timestampMs: 0 },
    ]);
  });

  it('offers nothing for photos or videos scored without a frame', () => {
    expect(bestMomentsOf([ranked(AssetTypeEnum.Image, 1000), ranked(AssetTypeEnum.Video, null)])).toEqual([]);
  });
});

describe('isEffectiveCover', () => {
  const frames = [
    { timestampMs: 0, isCover: false },
    { timestampMs: 5000, isCover: true },
    { timestampMs: 10_000, isCover: false },
  ];

  it('is the cover when the frame nearest the moment is the cover frame', () => {
    expect(isEffectiveCover(frames, 5000)).toBe(true);
    expect(isEffectiveCover(frames, 6200)).toBe(true);
  });

  it('is not the cover when another frame is nearer, or there are no frames', () => {
    expect(isEffectiveCover(frames, 9000)).toBe(false);
    expect(isEffectiveCover([], 5000)).toBe(false);
  });
});
