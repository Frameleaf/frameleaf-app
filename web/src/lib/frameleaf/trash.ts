import { AssetTypeEnum, type TrashItemResponseDto, type TrashReviewResponseDto } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { filmstripPlaceholder } from '$lib/frameleaf/viewer-filmstrip';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';

/**
 * The Trash page and the large-file review (FL-47), ported from the design template's
 * `TrashManager.jsx`, `trash-data.mjs` and the large-files part of `UtilitiesManager.jsx`.
 *
 * The template kept a sample trash in localStorage and checked its own snapshot before applying.
 * Production asks the server for both: `reviewTrash` resolves the set an action would change and
 * returns a token that fingerprints it, and `applyTrashReview` changes exactly that set or refuses
 * with 409. Nothing here decides what is in the trash; these helpers only shape what the page shows.
 */

/** Items fetched per page. */
export const TRASH_PAGE_SIZE = 200;
/** The largest page the server serves; "select all" loads the rest of the trash in these. */
export const TRASH_MAX_PAGE_SIZE = 1000;
/** Upper bound on one selection, matching the server's limit for one reviewed change. */
export const TRASH_SELECTION_LIMIT = 50_000;

export type TrashMediaFilter = 'all' | 'image' | 'video';

/** The server's type filter for the Media select. */
export const trashTypeFilter = (media: TrashMediaFilter): AssetTypeEnum | undefined => {
  if (media === 'image') {
    return AssetTypeEnum.Image;
  }
  if (media === 'video') {
    return AssetTypeEnum.Video;
  }
  return undefined;
};

/** The phrase that unlocks permanent deletion: `DELETE 12`, as in the template. */
export const deleteConfirmationPhrase = (count: number) => `DELETE ${count}`;

export const matchesDeleteConfirmation = (review: Pick<TrashReviewResponseDto, 'count'>, typed: string) =>
  typed.trim() === deleteConfirmationPhrase(review.count);

/**
 * Whole days since an item was trashed, or null when the date is missing, unreadable or in the
 * future (a clock difference is not "-1 days ago").
 */
export const trashAgeDays = (trashedAt: string | null | undefined, now = Date.now()): number | null => {
  if (!trashedAt) {
    return null;
  }
  const at = Date.parse(trashedAt);
  if (!Number.isFinite(at) || at > now) {
    return null;
  }
  return Math.floor((now - at) / 86_400_000);
};

/** The age label's i18n key and values. */
export const trashAgeLabel = (
  trashedAt: string | null | undefined,
  now = Date.now(),
): { key: Translations; values: Record<string, number> } => {
  const days = trashAgeDays(trashedAt, now);
  if (days === null) {
    return { key: 'frameleaf_trash_age_unknown', values: {} };
  }
  if (days === 0) {
    return { key: 'frameleaf_trash_age_today', values: {} };
  }
  return { key: 'frameleaf_trash_age_days', values: { count: days } };
};

/** Ids still on the page, in the order chosen. A reload keeps a selection only for items it still shows. */
export const pruneSelection = (selected: readonly string[], rows: readonly Pick<TrashItemResponseDto, 'id'>[]) => {
  const present = new Set(rows.map((row) => row.id));
  return selected.filter((id) => present.has(id));
};

/** Toggle one id in a selection. */
export const toggleSelection = (selected: readonly string[], id: string) =>
  selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];

/** Every row is chosen; false for an empty list, so the select-all box starts unticked. */
export const allSelected = (selected: readonly string[], rows: readonly Pick<TrashItemResponseDto, 'id'>[]) => {
  if (rows.length === 0) {
    return false;
  }
  const chosen = new Set(selected);
  return rows.every((row) => chosen.has(row.id));
};

/** Drop rows the server says have left the trash, without waiting for the reload. */
export const withoutIds = <T extends { id: string }>(rows: readonly T[], ids: readonly string[]) => {
  if (ids.length === 0) {
    return [...rows];
  }
  const gone = new Set(ids);
  return rows.filter((row) => !gone.has(row.id));
};

/**
 * The page's next state after a page arrives: the first page replaces the list, later pages append
 * (skipping anything already shown, in case the trash shifted between pages).
 */
export const mergeTrashPage = (
  rows: readonly TrashItemResponseDto[],
  page: readonly TrashItemResponseDto[],
  replace: boolean,
) => {
  if (replace) {
    return [...page];
  }
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !seen.has(row.id))];
};

/** "And 4 more" after the listed names, or null when every name is listed. */
export const remainingNames = (review: Pick<TrashReviewResponseDto, 'count' | 'names'>) => {
  const remaining = review.count - review.names.length;
  return remaining > 0 ? remaining : null;
};

/** An error's HTTP status, when the SDK attached one. */
export const errorStatus = (error: unknown): number | undefined => {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
};

/** A 409 from apply: the set changed after the review, so the page asks for a fresh one. */
export const isStaleReview = (error: unknown) => errorStatus(error) === 409;

/** A trash row as a filmstrip thumbnail for the trash viewer (audit V-17). */
export const trashFilmstripAsset = (item: TrashItemResponseDto, ownerId: string): TimelineAsset =>
  filmstripPlaceholder({
    id: item.id,
    ownerId,
    isVideo: item.type === AssetTypeEnum.Video,
    isLocked: item.isLocked,
    isTrashed: true,
    originalFileName: item.originalFileName,
    fileSizeInByte: item.fileSizeInByte,
    at: item.trashedAt,
  });
