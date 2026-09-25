import { AssetTypeEnum, type BestPhotoAssetResponseDto } from '@immich/sdk';

/** A ranked video and the time of its best-scored frame (FL-50). */
export interface BestMoment {
  asset: BestPhotoAssetResponseDto;
  timestampMs: number;
}

/**
 * The videos among Best Photos results that scoring gave a best frame, in ranking order. Photos,
 * and videos scored before frames were sampled (or too long to sample), have none and are left out:
 * the moment action is offered only where it is supported.
 */
export const bestMomentsOf = (assets: BestPhotoAssetResponseDto[]): BestMoment[] =>
  assets.flatMap((asset) => {
    const timestampMs = asset.bestPhotoScore?.bestFrameTimestampMs;
    return asset.type === AssetTypeEnum.Video && typeof timestampMs === 'number' && timestampMs >= 0
      ? [{ asset, timestampMs }]
      : [];
  });
