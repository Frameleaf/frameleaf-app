import {
  getBaseUrl,
  IntegrityReport,
  QueueName,
  type MediaHealthStatus,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@immich/sdk';
import { omitBy } from 'lodash-es';
import { OpenQueryParam, QueryParameter, type SharedLinkTab } from '$lib/constants';
import { analyticsAreaUrl } from '$lib/frameleaf/settings-areas';
import { studioHandoffQuery } from '$lib/frameleaf/studio/handoff';
import { utilitiesUrl } from '$lib/frameleaf/utilities';

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
  // FL-78: Libraries is an area of the settings command center, as in the design template; the
  // `/admin/library-management` addresses redirect here.
  libraries: () => '/admin/system-settings?area=libraries',
  newLibrary: () => '/admin/system-settings?area=libraries&new=1',
  viewLibrary: ({ id }: { id: string }) => `/admin/system-settings?area=libraries&selected=library:${id}`,
  editLibrary: ({ id }: { id: string }) => `/admin/system-settings?area=libraries&selected=library:${id}&edit=1`,

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

  // documents (FL-63)
  documents: (params?: { query?: string }) => '/documents' + asQueryString(params),
  viewDocumentAsset: ({ id }: { id: string }) => `/documents/photos/${id}`,

  // pets
  pets: () => '/pets',
  viewPet: ({ id }: { id: string }) => `/pets/${id}`,

  // photos
  photos: (params?: { at?: string }) => '/photos' + asQueryString(params),
  viewAsset: ({ id }: { id: string }) => `/photos/${id}`,
  recentlyAdded: (params?: { at?: string }) => '/recently-added' + asQueryString(params),
  viewRecentlyAddedAsset: ({ id }: { id: string }) => `/recently-added/${id}`,
  bestPhotos: (params?: { page?: number; limit?: number; minScore?: number }) => '/best-photos' + asQueryString(params),
  viewBestPhotosAsset: ({ id }: { id: string }) => `/best-photos/photos/${id}`,
  archive: () => '/archive',
  favorites: () => '/favorites',
  // FL-34: `reason` narrows the Locked view by why items are locked; left out, it shows them all
  locked: (params?: { reason?: string }) => '/locked' + asQueryString(params),
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

  // imports
  /** The Google Photos import wizard (FL-65); `import` opens one import. */
  takeout: (params?: { import?: string }) => '/takeout' + asQueryString(params),

  // settings
  userSettings: (params?: { isOpen?: OpenQueryParam }) => '/user-settings' + asQueryString(params),

  // system
  /**
   * `openSetting` drills past the section a plain `isOpen` scrolls to, into a control within it
   * (e.g. the enrichment workbench trigger inside the machine-learning section) that reads the
   * same-named query param on mount. See the Jobs manager's "Enrichment tasks" entry (FL-59).
   */
  systemSettings: (params?: { isOpen?: OpenQueryParam; openSetting?: string }) =>
    '/admin/system-settings' +
    asQueryString(
      params && {
        isOpen: params.isOpen,
        [QueryParameter.OPEN_SETTING]: params.openSetting,
      },
    ),
  /** Library analytics in the command center (FL-79); `/admin/server-status` redirects here. */
  libraryAnalytics: (params?: { scope?: string; range?: string }) => analyticsAreaUrl(params),
  physicalDeduplication: () => '/admin/physical-deduplication',
  systemMaintenance: (params?: { continue?: string }) => '/admin/maintenance' + asQueryString(params),
  /** Processing destinations (FL-110): where machine-learning work may run, with consent and cost controls. */
  systemProcessingDestinations: () => '/admin/processing-destinations',
  /** Workers & endpoints (FL-72): the worker inventory at the top of the same page. */
  systemWorkers: () => '/admin/processing-destinations#workers',
  systemMaintenanceIntegrityReport: ({ reportType }: { reportType: IntegrityReport }) =>
    `/admin/maintenance/integrity-report/${reportType}`,

  // studio
  /**
   * Opening Studio, optionally with a project and the "make a movie" selection. The query
   * is built by `studioHandoffQuery` so the link and the route's parser stay one contract.
   */
  studio: (params?: { projectId?: string | null; assetIds?: readonly string[] }) =>
    '/studio' + studioHandoffQuery(params ?? {}),
  /** The Studio project library (FL-91): every project, the archive and the trash. */
  studioProjects: (params?: { shelf?: 'active' | 'archived' | 'trashed' }) =>
    '/studio/projects' +
    asQueryString(params?.shelf && params.shelf !== 'active' ? { shelf: params.shelf } : undefined),

  // tags
  tags: (params?: { path?: string }) => '/tags' + asQueryString(params),

  // users
  users: () => '/admin/users',
  newUser: () => `/admin/users/new`,
  viewUser: ({ id }: { id: string }) => `/admin/users/${id}`,
  editUser: ({ id }: { id: string }) => `/admin/users/${id}/edit`,

  // utilities
  utilities: () => utilitiesUrl(),
  libraryCare: () => '/user-settings?screen=care',
  duplicatesUtility: (params?: { index?: number }) => utilitiesUrl('duplicates', params),
  largeFileUtility: () => utilitiesUrl('large-files'),
  livePhotosUtility: () => utilitiesUrl('live-photos'),
  geolocationUtility: () => utilitiesUrl('geolocation'),
  icloudSyncUtility: () => utilitiesUrl('icloud'),
  missingMediaUtility: (params?: { status?: MediaHealthStatus }) => utilitiesUrl('missing-media', params),
  corruptMediaUtility: (params?: { status?: MediaHealthStatus }) => utilitiesUrl('corrupt-media', params),


  downloadsUtility: () => utilitiesUrl('downloads'),
  obtainiumUtility: () => utilitiesUrl('obtainium'),

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
