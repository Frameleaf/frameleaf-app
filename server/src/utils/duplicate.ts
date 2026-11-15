import type { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { DUPLICATE_KEEP_RULES, type DuplicateKeepRule } from 'src/utils/duplicate-keep-rules.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * What Frameleaf suggests when the person set no rules: RAW, then HEIC/HEIF/HIF, then the largest
 * file, then the most EXIF details. Ties after the rules go to the lowest asset id.
 */
export const DEFAULT_DUPLICATE_KEEP_RULES: readonly DuplicateKeepRule[] = ['raw', 'heic', 'largest', 'mostMetadata'];

export type SuggestDuplicateOptions = {
  /** @deprecated Accepted for older clients; format preference is always enforced. */
  preferOriginalFormat?: boolean;
  /** The owner's ordered rules (`duplicates.keepRules`); empty or absent is the default order. */
  rules?: readonly DuplicateKeepRule[];
  /** Ids of the copies that are in at least one of the owner's albums (only read by `inAlbum`). */
  inAlbumIds?: ReadonlySet<string>;
  /** Ids of the copies with develop history; `isEdited` counts as well (only read by `hasEdits`). */
  editedIds?: ReadonlySet<string>;
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
 * A comparator answers below zero when `a` is the better copy to keep, above zero when `b` is, and
 * zero when the rule cannot tell them apart.
 */
type KeepContext = SuggestDuplicateOptions & {
  /** `getFormatRank` read once per copy for the whole suggestion (the file name is read only then). */
  formatRank: (asset: AssetResponseDto) => number;
};
type KeepComparator = (a: AssetResponseDto, b: AssetResponseDto, context: KeepContext) => number;

/** Prefers the copy for which `test` holds. */
const prefer =
  (test: (asset: AssetResponseDto, context: KeepContext) => boolean): KeepComparator =>
  (a, b, context) =>
    Number(test(b, context)) - Number(test(a, context));

/** Prefers the larger value; an unknown value never wins. */
const preferLarger =
  (value: (asset: AssetResponseDto) => number | undefined): KeepComparator =>
  (a, b) =>
    (value(b) ?? -Infinity) - (value(a) ?? -Infinity) || 0;

const pixels = (asset: AssetResponseDto) => {
  const width = asset.width ?? asset.exifInfo?.exifImageWidth;
  const height = asset.height ?? asset.exifInfo?.exifImageHeight;
  return width && height ? width * height : undefined;
};

/** When the photo was taken (EXIF), else when the file was created; unknown when neither parses. */
const takenAt = (asset: AssetResponseDto): number | undefined => {
  for (const value of [asset.exifInfo?.dateTimeOriginal, asset.fileCreatedAt]) {
    const time = Date.parse(value ?? '');
    if (!Number.isNaN(time)) {
      return time;
    }
  }
};

const KEEP_COMPARATORS: Record<DuplicateKeepRule, KeepComparator> = {
  raw: prefer((asset, { formatRank }) => formatRank(asset) === 2),
  heic: prefer((asset, { formatRank }) => formatRank(asset) === 1),
  largest: preferLarger((asset) => asset.exifInfo?.fileSizeInByte ?? 0),
  highestResolution: preferLarger(pixels),
  oldest: preferLarger((asset) => {
    const time = takenAt(asset);
    return time === undefined ? undefined : -time;
  }),
  newest: preferLarger(takenAt),
  inAlbum: prefer((asset, { inAlbumIds }) => !!inAlbumIds?.has(asset.id)),
  hasEdits: prefer((asset, { editedIds }) => asset.isEdited || !!editedIds?.has(asset.id)),
  favorite: prefer((asset) => asset.isFavorite),
  mostMetadata: preferLarger(getExifCount),
};

/**
 * The rules in the order they apply: the owner's own, without repeats or unknown values, then the
 * default rules they did not list, so a tie on every chosen rule still settles the way Frameleaf
 * always has before falling back to the lowest id.
 */
export const resolveKeepRules = (rules: readonly string[] | undefined = []): DuplicateKeepRule[] => {
  const ordered = new Set<DuplicateKeepRule>();
  for (const rule of rules) {
    if ((DUPLICATE_KEEP_RULES as readonly string[]).includes(rule)) {
      ordered.add(rule as DuplicateKeepRule);
    }
  }
  for (const rule of DEFAULT_DUPLICATE_KEEP_RULES) {
    ordered.add(rule);
  }
  return [...ordered];
};

/**
 * The copy to suggest keeping: the owner's rules in order (by default RAW, then HEIC/HEIF/HIF, then
 * size, then EXIF coverage), a tie on one rule going to the next, then the lowest stable asset ID.
 */
export const suggestDuplicate = (
  assets: AssetResponseDto[],
  options: SuggestDuplicateOptions = {},
): AssetResponseDto | undefined => {
  const comparators = resolveKeepRules(options.rules).map((rule) => KEEP_COMPARATORS[rule]);
  const ranks = new Map<AssetResponseDto, number>();
  const context: KeepContext = {
    ...options,
    formatRank: (asset) => {
      let rank = ranks.get(asset);
      if (rank === undefined) {
        rank = getFormatRank(asset);
        ranks.set(asset, rank);
      }
      return rank;
    },
  };
  let best: AssetResponseDto | undefined;
  for (const asset of assets) {
    if (asset === undefined) {
      continue;
    }
    if (best === undefined) {
      best = asset;
      continue;
    }
    let comparison = 0;
    for (const compare of comparators) {
      comparison = compare(asset, best, context);
      if (comparison !== 0) {
        break;
      }
    }
    if (comparison === 0) {
      comparison = asset.id < best.id ? -1 : asset.id > best.id ? 1 : 0;
    }
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
