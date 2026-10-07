import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export type SuggestDuplicateOptions = {
  /** @deprecated Accepted for older clients; format preference is always enforced. */
  preferOriginalFormat?: boolean;
};

/**
 * Counts all truthy values in the exifInfo object.
 * This matches the client implementation in web/src/lib/utils/exif-utils.ts
 *
 * @param asset Asset with optional exifInfo
 * @returns Count of truthy EXIF values
 */
export const getExifCount = (asset: AssetResponseDto): number => {
  return Object.values(asset.exifInfo ?? {}).filter(Boolean).length;
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
): AssetResponseDto | undefined =>
  assets.toSorted(
    (a, b) =>
      getFormatRank(b) - getFormatRank(a) ||
      (b.exifInfo?.fileSizeInByte ?? 0) - (a.exifInfo?.fileSizeInByte ?? 0) ||
      getExifCount(b) - getExifCount(a) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];

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
