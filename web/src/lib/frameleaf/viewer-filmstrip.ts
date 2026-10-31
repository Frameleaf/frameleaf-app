import { AssetVisibility } from '@frameleaf/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { fromISODateTimeUTCToObject } from '$lib/utils/timeline-util';

/**
 * A filmstrip thumbnail for a list that holds less than a timeline asset (audit V-17): the trash rows
 * and the map's markers. The filmstrip only draws the item's thumbnail and opens it, so its id, kind and
 * Locked state are all it needs; the dates are placeholders it never shows.
 */
export const filmstripPlaceholder = ({
  id,
  ownerId,
  isVideo = false,
  isLocked = false,
  isTrashed = false,
  originalFileName = null,
  fileSizeInByte = null,
  at = null,
}: {
  id: string;
  ownerId: string;
  isVideo?: boolean;
  isLocked?: boolean;
  isTrashed?: boolean;
  originalFileName?: string | null;
  fileSizeInByte?: number | null;
  at?: string | null;
}): TimelineAsset => {
  const when = fromISODateTimeUTCToObject(at ?? new Date(0).toISOString());
  return {
    id,
    ownerId,
    ratio: 1,
    thumbhash: null,
    localDateTime: when,
    createdAt: when,
    fileCreatedAt: when,
    visibility: isLocked ? AssetVisibility.Locked : AssetVisibility.Timeline,
    isFavorite: false,
    isTrashed,
    isVideo,
    isImage: !isVideo,
    stack: null,
    duration: null,
    projectionType: null,
    livePhotoVideoId: null,
    city: null,
    country: null,
    people: null,
    originalFileName,
    fileSizeInByte,
  };
};

/*
 * VIEWER-P4: the viewer filmstrip across the whole timeline (MediaViewer.jsx:1635-1666 shows the
 * whole collection). The timeline holds its items month by month, so the strip is a window of items
 * around the open one that runs on into the neighbouring months. A month that is not loaded yet ends
 * the window on that side and is handed back to be loaded; once it arrives the window grows into it.
 * Reading stays inside what the timeline may load anyway, so the strip can never show more than the
 * timeline itself would.
 */

/** Items the filmstrip keeps on each side of the open one. */
export const FILMSTRIP_REACH = 40;
/** Neighbouring months read on each side at most, so a run of empty months never loads the whole library. */
export const FILMSTRIP_MONTH_REACH = 12;

export type FilmstripMonth = { isLoaded: boolean; getAssets(): TimelineAsset[] };

export type FilmstripWindow<M extends FilmstripMonth> = {
  /** The items around the open one, in the timeline's order. */
  assets: TimelineAsset[];
  /** Months the window reached but are not loaded yet: at most one on each side. */
  toLoad: M[];
};

/**
 * The window of items around `currentId`, which sits in `months[monthIndex]` (months in the
 * timeline's display order).
 */
export const filmstripWindow = <M extends FilmstripMonth>(
  months: readonly M[],
  monthIndex: number,
  currentId: string,
  reach = FILMSTRIP_REACH,
  monthReach = FILMSTRIP_MONTH_REACH,
): FilmstripWindow<M> => {
  const month = months[monthIndex];
  const own = month?.isLoaded ? month.getAssets() : [];
  const at = own.findIndex((asset) => asset.id === currentId);
  if (at === -1) {
    return { assets: [], toLoad: [] };
  }

  const toLoad: M[] = [];
  let before = own.slice(Math.max(0, at - reach), at);
  for (let index = monthIndex - 1, steps = 0; index >= 0 && before.length < reach && steps < monthReach; index--) {
    const earlier = months[index];
    if (!earlier.isLoaded) {
      toLoad.push(earlier);
      break;
    }
    before = [...earlier.getAssets().slice(-(reach - before.length)), ...before];
    steps++;
  }

  let after = own.slice(at + 1, at + 1 + reach);
  for (
    let index = monthIndex + 1, steps = 0;
    index < months.length && after.length < reach && steps < monthReach;
    index++
  ) {
    const later = months[index];
    if (!later.isLoaded) {
      toLoad.push(later);
      break;
    }
    after = [...after, ...later.getAssets().slice(0, reach - after.length)];
    steps++;
  }

  return { assets: [...before, own[at], ...after], toLoad };
};
