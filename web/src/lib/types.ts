import type { ImageEnrichmentFilter, QueueResponseDto } from '@immich/sdk';
import type { ActionItem } from '@immich/ui';
import type { DateTime } from 'luxon';
import type { SvelteSet } from 'svelte/reactivity';
import { MediaType } from '$lib/constants';

export type LatLng = { lng: number; lat: number };

export type QueueSnapshot = { timestamp: number; snapshot?: QueueResponseDto[] };

export type HeaderButtonActionItem = ActionItem & { data?: { title?: string } };

export enum UploadState {
  PENDING,
  STARTED,
  DONE,
  ERROR,
  DUPLICATED,
}

export type UploadAsset = {
  id: string;
  file: File;
  assetId?: string;
  isTrashed?: boolean;
  albumId?: string;
  progress?: number;
  state?: UploadState;
  startDate?: number;
  eta?: number;
  speed?: number;
  error?: unknown;
  message?: string;
};

export type SearchCameraFilter = {
  make?: string;
  model?: string;
  lensModel?: string;
};

export type SearchDateFilter = {
  takenBefore?: DateTime;
  takenAfter?: DateTime;
};

export type SearchDisplayFilters = {
  isNotInAlbum: boolean;
  isArchive: boolean;
  isFavorite: boolean;
};

export type SearchLocationFilter = {
  country?: string;
  state?: string;
  city?: string;
};

export type SearchFilter = {
  query: string;
  ocr?: string;
  queryType: 'smart' | 'metadata' | 'description' | 'fullPath' | 'ocr';
  personIds: SvelteSet<string>;
  tagIds: SvelteSet<string> | null;
  location: SearchLocationFilter;
  queryAssetId?: string;
  camera: SearchCameraFilter;
  date: SearchDateFilter;
  display: SearchDisplayFilters;
  mediaType: MediaType;
  rating?: number | null;
  imageEnrichment?: ImageEnrichmentFilter | '';
};
