import type { AssetLockReason, AssetStackResponseDto, AssetVisibility, TimelineOrderedSort } from '@immich/sdk';
import type { TimelineDate, TimelineDateTime, TimelineYearMonth } from '$lib/utils/timeline-util';
import type { TimelineDay } from './timeline-day.svelte';
import type { ViewerAsset } from './viewer-asset.svelte';

export type ViewportTopMonth = TimelineYearMonth | undefined | 'lead-in' | 'lead-out';

export type AssetApiGetTimeBucketsRequest = Parameters<typeof import('@immich/sdk').getTimeBuckets>[0];

export type TimelineManagerOptions = Omit<AssetApiGetTimeBucketsRequest, 'size'> & {
  timelineAlbumId?: string;
  /**
   * FL-30 (S-15): lay the same assets out in one flat order — by file name or by rating — instead of
   * by date. The manager then pages `GET /timeline/ordered` into synthetic "months" in that order;
   * every other option means what it means for the time buckets.
   */
  orderedBy?: TimelineOrderedSort;
  deferInit?: boolean;
  assetFilter?: Set<string>;
};

export type AssetDescriptor = { id: string };

export type Direction = 'earlier' | 'later';

export type TimelineAsset = {
  id: string;
  ownerId: string;
  tags?: string[];
  ratio: number;
  thumbhash: string | null;
  localDateTime: TimelineDateTime;
  createdAt: TimelineDateTime;
  fileCreatedAt: TimelineDateTime;
  visibility: AssetVisibility;
  /** Why the asset is locked (FL-34); only the Locked view's buckets carry it. */
  lockReason?: AssetLockReason | null;
  isFavorite: boolean;
  isTrashed: boolean;
  /** The file is missing from its external library (FL-33 tile badge); absent where unknown. */
  isOffline?: boolean;
  isVideo: boolean;
  isImage: boolean;
  stack: AssetStackResponseDto | null;
  duration: number | null;
  projectionType: string | null;
  livePhotoVideoId: string | null;
  city: string | null;
  country: string | null;
  people: string[] | null;
  latitude?: number | null;
  longitude?: number | null;
  /** Star rating (-1 rejected, 0 unrated, 1-5); absent where the source withholds metadata (FL-33). */
  rating?: number | null;
  /** The original file name, which Work shows on request (FL-33); absent where metadata is withheld. */
  originalFileName?: string | null;
  /** Pixel dimensions and file size for the list view (S-15); absent where metadata is withheld. */
  width?: number | null;
  height?: number | null;
  fileSizeInByte?: number | null;
};

export type MoveAsset = { asset: TimelineAsset; date: TimelineDate };

export interface Viewport {
  width: number;
  height: number;
}

export interface AddAsset {
  type: 'add';
  values: TimelineAsset[];
}

export interface UpdateAsset {
  type: 'update';
  values: TimelineAsset[];
}

export interface DeleteAsset {
  type: 'delete';
  values: string[];
}

export interface TrashAssets {
  type: 'trash';
  values: string[];
}

export type PendingChange = AddAsset | UpdateAsset | DeleteAsset | TrashAssets;

export type ScrubberMonth = {
  height: number;
  assetCount: number;
  year: number;
  month: number;
  title: string;
};

export interface UpdateGeometryOptions {
  invalidateHeight: boolean;
  noDefer?: boolean;
}

/**
 * How the Frameleaf timeline groups what it shows (prototype `TimelineLibrary.jsx` MODES). Months
 * are loaded a bucket at a time; a month group is one justified flow, and an "all" group (and a year
 * group when not shown as cards) is one justified flow that runs on across its months as they load
 * (FL-143), with the group header over the first month the group covers.
 */
export type TimelineGrouping = 'days' | 'months' | 'years' | 'all';

/** One tile of a group's flow (FL-143): the asset and the day that owns it. */
export type FlowItem = { viewerAsset: ViewerAsset; day: TimelineDay };
