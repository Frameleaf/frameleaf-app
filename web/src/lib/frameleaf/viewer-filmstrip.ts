import { AssetVisibility } from '@immich/sdk';
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
