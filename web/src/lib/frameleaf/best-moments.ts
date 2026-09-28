import { AssetTypeEnum, type BestPhotoAssetResponseDto, type VideoMomentFrameDto } from '@immich/sdk';

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

/**
 * Whether a moment is already the video's effective cover: the moments index keeps its cover as a
 * frame (the owner's chosen time, or the best-ranked frame by default), and choosing a time lands on
 * the nearest frame, so the moment is the cover when its nearest frame is the cover frame.
 */
export const isEffectiveCover = (
  frames: Pick<VideoMomentFrameDto, 'timestampMs' | 'isCover'>[],
  timestampMs: number,
) => {
  let nearest: (typeof frames)[number] | undefined;
  for (const frame of frames) {
    if (!nearest || Math.abs(frame.timestampMs - timestampMs) < Math.abs(nearest.timestampMs - timestampMs)) {
      nearest = frame;
    }
  }
  return nearest?.isCover ?? false;
};
