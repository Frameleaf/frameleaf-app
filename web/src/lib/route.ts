import {
  getBaseUrl,
  IntegrityReport,
  QueueName,
  type MediaHealthStatus,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@immich/sdk';
import { omitBy } from 'lodash-es';
import { OpenQueryParam, type SharedLinkTab } from '$lib/constants';
import { studioHandoffQuery } from '$lib/frameleaf/studio/handoff';

const asQueueSlug = (name: QueueName) => {
  return name.replaceAll(/[A-Z]/g, (m) => '-' + m.toLowerCase());
};

export const fromQueueSlug = (slug: string): QueueName | undefined => {
  const name = slug.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (Object.values(QueueName).includes(name as QueueName)) {
    return name as QueueName;
  }
};

type QueryValue = number | string | boolean;
const asQueryString = (
  params?: Record<string, QueryValue | undefined>,
  options?: { skipEmptyStrings?: boolean; skipNullValues?: boolean },
) => {
  const { skipEmptyStrings = true, skipNullValues = true } = options ?? {};
  const items = Object.entries(params ?? {})
    .filter((item): item is [string, QueryValue] => {
      const value = item[1];

      if (value === undefined) {
        return false;
      }

      if (skipNullValues && value === null) {
        return false;
      }

      return !(skipEmptyStrings && value === '');
    })
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);

  return items.length === 0 ? '' : `?${items.join('&')}`;
};

export const Route = {
  // activity
  /** The durable job feed (FL-104). Renders, restorations, transfers and bulk operations. */
  activity: (params?: { filter?: 'all' | 'running' | 'done' | 'failed' }) => '/activity' + asQueryString(params),

  // auth
  login: (params?: { continue?: string; autoLaunch?: 0 | 1 }) => '/auth/login' + asQueryString(params),
  logout: (params?: { continue?: string }) => '/auth/logout' + asQueryString(params),
  register: () => '/auth/register',
  changePassword: () => '/auth/change-password',
  onboarding: (params?: { step?: string }) => '/auth/onboarding' + asQueryString(params),
  pinPrompt: (params?: { continue?: string }) => '/auth/pin-prompt' + asQueryString({ continue: params?.continue }),

  // albums
  albums: () => '/albums',
  viewAlbum: ({ id }: { id: string }) => `/albums/${id}`,
  viewAlbumAsset: ({ albumId, assetId }: { albumId: string; assetId: string }) =>
    `/albums/${albumId}/photos/${assetId}`,

  // buy
  buy: () => '/buy',

  // explore
  explore: () => '/explore',
  places: () => '/places',

  // folders
  folders: (params?: { path?: string }) => '/folders' + asQueryString(params),

  // libraries
  libraries: () => '/admin/library-management',
  newLibrary: () => '/admin/library-management/new',
  viewLibrary: ({ id }: { id: string }) => `/admin/library-management/${id}`,
  editLibrary: ({ id }: { id: string }) => `/admin/library-management/${id}/edit`,

  // maintenance
  maintenanceMode: (params?: { continue?: string }) => '/maintenance' + asQueryString(params),

  // map
  map: (point?: { zoom: number; lat: number; lng: number }) =>
    '/map' + (point ? `#${point.zoom}/${point.lat}/${point.lng}` : ''),

  // memories
  memories: (params?: { isSaved?: boolean }) => '/memories' + asQueryString(params),
  viewMemory: ({ id, ...params }: { id: string; assetId?: string; isSaved?: boolean }) =>
    `/memories/${id}` + asQueryString(params),
  viewMemoryAsset: ({ id, assetId, ...params }: { id: string; assetId: string; isSaved?: boolean }) =>
    `/memories/${id}/photos/${assetId}` + asQueryString({ assetId, ...params }),

  // partners
  viewPartner: ({ id }: { id: string }) => `/partners/${id}`,

  // people
  people: () => '/people',
  viewPerson: ({ id }: { id: string }, params?: { previousRoute?: string; action?: 'merge' }) =>
    `/people/${id}` + asQueryString(params),

  // pets
  pets: () => '/pets',

  // photos
  photos: (params?: { at?: string }) => '/photos' + asQueryString(params),
  viewAsset: ({ id }: { id: string }) => `/photos/${id}`,
  recentlyAdded: (params?: { at?: string }) => '/recently-added' + asQueryString(params),
  viewRecentlyAddedAsset: ({ id }: { id: string }) => `/recently-added/${id}`,
  bestPhotos: (params?: { page?: number; limit?: number; minScore?: number }) => '/best-photos' + asQueryString(params),
  viewBestPhotosAsset: ({ id }: { id: string }) => `/best-photos/photos/${id}`,
  archive: () => '/archive',
  favorites: () => '/favorites',
  locked: () => '/locked',
  suppressed: (params?: { tab?: 'timeline' | 'albums' }) => '/suppressed' + asQueryString(params),
  suppressedAlbum: ({ id }: { id: string }) => `/suppressed/albums/${id}`,
  trash: () => '/trash',
  viewTrashedAsset: ({ id }: { id: string }) => `/trash/photos/${id}`,

  // search
  search: (dto?: MetadataSearchDto | SmartSearchDto) => {
    const metadata = omitBy(dto ?? {}, (value) => value === undefined);
    const query = Object.keys(metadata).length === 0 ? undefined : JSON.stringify(metadata);
    return `/search` + asQueryString({ query });
  },

  // sharing
  sharing: () => '/sharing',
  /** One shared space: its photos, linked albums, people, places, activity and members. */
  viewSharedSpace: ({ id }: { id: string }) => `/sharing/${id}`,
  /** One item in a shared space's own viewer; next and previous stay inside the space. */
  viewSharedSpaceAsset: ({ spaceId, assetId }: { spaceId: string; assetId: string }) =>
    `/sharing/${spaceId}/photos/${assetId}`,

  // shared links
  sharedLinks: (params?: { filter?: SharedLinkTab }) => '/shared-links' + asQueryString(params),
  editSharedLink: ({ id }: { id: string }) => `/shared-links/${id}/edit`,
  viewSharedLink: ({ slug, key }: { slug?: string | null; key: string }) =>
    slug ? `/s/${encodeURIComponent(slug)}` : `/share/${key}`,

  // settings
  userSettings: (params?: { isOpen?: OpenQueryParam }) => '/user-settings' + asQueryString(params),

  // system
  systemSettings: (params?: { isOpen?: OpenQueryParam }) => '/admin/system-settings' + asQueryString(params),
  systemStatistics: () => '/admin/server-status',
  physicalDeduplication: () => '/admin/physical-deduplication',
  systemMaintenance: (params?: { continue?: string }) => '/admin/maintenance' + asQueryString(params),
  /** Processing destinations (FL-110): where machine-learning work may run, with consent and cost controls. */
  systemProcessingDestinations: () => '/admin/processing-destinations',
  systemMaintenanceIntegrityReport: ({ reportType }: { reportType: IntegrityReport }) =>
    `/admin/maintenance/integrity-report/${reportType}`,

  // studio
  /**
   * Opening Studio, optionally with a project and the "make a movie" selection. The query
   * is built by `studioHandoffQuery` so the link and the route's parser stay one contract.
   */
  studio: (params?: { projectId?: string | null; assetIds?: readonly string[] }) =>
    '/studio' + studioHandoffQuery(params ?? {}),

  // tags
  tags: (params?: { path?: string }) => '/tags' + asQueryString(params),

  // users
  users: () => '/admin/users',
  newUser: () => `/admin/users/new`,
  viewUser: ({ id }: { id: string }) => `/admin/users/${id}`,
  editUser: ({ id }: { id: string }) => `/admin/users/${id}/edit`,

  // utilities
  utilities: () => '/utilities',
  duplicatesUtility: (params?: { index?: number }) => '/utilities/duplicates' + asQueryString(params),
  largeFileUtility: () => '/utilities/large-files',
  livePhotosUtility: () => '/utilities/live-photos',
  geolocationUtility: () => '/utilities/geolocation',
  icloudSyncUtility: () => '/utilities/icloud-sync',
  missingMediaUtility: (params?: { status?: MediaHealthStatus }) => '/utilities/missing-media' + asQueryString(params),
  corruptMediaUtility: (params?: { status?: MediaHealthStatus }) => '/utilities/corrupt-media' + asQueryString(params),

  // workflows
  workflows: () => '/workflows',
  viewWorkflow: ({ id }: { id: string }) => `/workflows/${id}`,

  // render workers
  renderWorkers: () => '/admin/render-workers',

  // queues
  queues: () => '/admin/queues',
  viewQueue: ({ name }: { name: QueueName }) => `/admin/queues/${asQueueSlug(name)}`,

  // integrity checks
  integrityReportFile: (reportId: string) => `${getBaseUrl()}/admin/integrity/report/${reportId}/file`,
  integrityReportCsv: (reportType: IntegrityReport) => `${getBaseUrl()}/admin/integrity/report/${reportType}/csv`,

  // continue helper for ensuring same-origin URLs
  continue: (url: string | null, fallback: string): string | URL => {
    const resolved = new URL(url ?? fallback, document.baseURI);

    if (resolved.origin !== location.origin) {
      return fallback;
    }

    return resolved;
  },
};
