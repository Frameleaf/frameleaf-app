import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export type SuggestDuplicateOptions = {
  /** @deprecated Accepted for older clients; format preference is always enforced. */
  preferOriginalFormat?: boolean;
};

/**
 * Counts all truthy values in the exifInfo object.
 *
 * @param asset Asset with optional exifInfo
 * @returns Count of truthy EXIF values
 */
export const getExifCount = (asset: AssetResponseDto): number => {
  let count = 0;
  for (const value of Object.values(asset.exifInfo ?? {})) {
    if (value) {
      count++;
    }
  }
  return count;
};

/** Format preference only; the extension does not establish capture provenance. */
export const getFormatRank = (asset: AssetResponseDto): number => {
  const fileName = asset.originalFileName ?? '';
  if (mimeTypes.isRaw(fileName)) {
    return 2;
  }
  if (mimeTypes.isHeic(fileName)) {
    return 1;
  }
  return 0;
};

/**
 * Prefer RAW, then HEIC/HEIF/HIF, then other formats, regardless of file size.
 * Within a tier, prefer size, EXIF coverage, then the lowest stable asset ID.
 */
export const suggestDuplicate = (
  assets: AssetResponseDto[],
  _options: SuggestDuplicateOptions = {},
): AssetResponseDto | undefined => {
  let best: AssetResponseDto | undefined;
  for (const asset of assets) {
    if (asset === undefined) {
      continue;
    }
    if (best === undefined) {
      best = asset;
      continue;
    }
    const comparison =
      getFormatRank(best) - getFormatRank(asset) ||
      (best.exifInfo?.fileSizeInByte ?? 0) - (asset.exifInfo?.fileSizeInByte ?? 0) ||
      getExifCount(best) - getExifCount(asset) ||
      (asset.id < best.id ? -1 : asset.id > best.id ? 1 : 0);
    if (comparison < 0) {
      best = asset;
    }
  }
  return best;
};

/**
 * Suggests the best duplicate asset IDs to keep from a list of duplicates.
 * Returns an array with a single asset ID (the best candidate), or empty if no assets.
 *
 * @param assets List of duplicate assets
 * @param options Suggestion options
 * @returns Array of suggested asset IDs to keep (0 or 1 element)
 */
export const suggestDuplicateKeepAssetIds = (
  assets: AssetResponseDto[],
  options?: SuggestDuplicateOptions,
): string[] => {
  const suggested = suggestDuplicate(assets, options);
  return suggested ? [suggested.id] : [];
};
