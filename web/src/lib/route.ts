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
import {
  analyticsAreaUrl,
  areaForSection,
  commandCenterUrl,
  serverSectionKey as legacyServerSectionKey,
} from '$lib/frameleaf/settings-areas';
import { studioHandoffQuery } from '$lib/frameleaf/studio/handoff';
import { utilitiesUrl } from '$lib/frameleaf/utilities';

/** The sections of the Command Center's Maintenance area (FL-71), as the old maintenance page's `isOpen` named them. */
export const MAINTENANCE_SECTIONS = ['mode', 'backups', 'integrity'] as const;
export type MaintenanceSectionKey = (typeof MAINTENANCE_SECTIONS)[number];
export const asMaintenanceSection = (value: string | null | undefined): MaintenanceSectionKey | undefined =>
  MAINTENANCE_SECTIONS.find((key) => key === value);

/** The server settings section an `isOpen` key opens; the OAuth group sits in the sign-in methods form. */
const serverSectionKey = (key: string) =>
  key === OpenQueryParam.OAUTH ? 'authentication' : legacyServerSectionKey(key);

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
  /**
   * The Albums page with its create dialog open, as the rail's "+" does (LibraryRail.jsx `onSave`,
   * `onNewSpace`). The page consumes the request and drops it from the address, so opening All
   * albums later never replays it.
   */
  newAlbum: ({ kind }: { kind: 'album' | 'space' }) => `/albums?create=${kind}`,
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
  // FL-78: Libraries is an area of the Command Center, as in the design template; the
  // `/admin/library-management` addresses redirect here.
  libraries: () => commandCenterUrl('libraries'),
  newLibrary: () => commandCenterUrl('libraries', undefined, { new: 1 }),
  viewLibrary: ({ id }: { id: string }) => commandCenterUrl('libraries', undefined, { selected: `library:${id}` }),
  editLibrary: ({ id }: { id: string }) =>
    commandCenterUrl('libraries', undefined, { selected: `library:${id}`, edit: 1 }),

  // maintenance
  maintenanceMode: (params?: { continue?: string }) => '/maintenance' + asQueryString(params),

  // map
  map: (point?: { zoom: number; lat: number; lng: number }) =>
    '/map' + (point ? `#${point.zoom}/${point.lat}/${point.lng}` : ''),
  /** The Map screen scoped to one album's located items (prototype `setMapScope("collection")`). */
  mapAlbum: ({ id }: { id: string }) => '/map' + asQueryString({ albumId: id }),

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
  /** `area` is a map area (`west,south,east,north`) from the Map screen's "Search this area". */
  photos: (params?: { at?: string; area?: string }) => '/photos' + asQueryString(params),
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
  // FL-71: the account's Trash is a Command Center area (the rail's Trash opens it); `/trash` redirects.
  trash: () => commandCenterUrl('trash', 'contents'),
  viewTrashedAsset: ({ id }: { id: string }) => commandCenterUrl('trash', 'contents', { assetId: id }),

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
  sharedLinks: (params?: { filter?: SharedLinkTab; edit?: string }) => '/shared-links' + asQueryString(params),
  /** Editing is the list's Frameleaf form (AL-23); the old `/shared-links/{id}/edit` address redirects here. */
  editSharedLink: ({ id }: { id: string }) => '/shared-links' + asQueryString({ edit: id }),
  viewSharedLink: ({ slug, key }: { slug?: string | null; key: string }) =>
    slug ? `/s/${encodeURIComponent(slug)}` : `/share/${key}`,

  // imports
  /** The Google Photos import wizard (FL-65); `import` opens one import. */
  takeout: (params?: { import?: string }) => '/takeout' + asQueryString(params),

  // settings
  /**
   * The Command Center (FL-71), one address for every account. A bare `isOpen` key names one of the
   * account's own sections, as it did on the old personal settings page.
   */
  userSettings: (params?: { isOpen?: OpenQueryParam }) => '/user-settings' + asQueryString(params),

  // system
  /**
   * A server settings section of the Command Center, with its area named so the key cannot be read
   * as an account section. `openSetting` drills past the section into a control within it (e.g. the
   * enrichment workbench trigger inside the machine-learning section) that reads the same-named
   * query param on mount. See the Jobs manager's "Enrichment tasks" entry (FL-59).
   */
  systemSettings: (params?: { isOpen?: OpenQueryParam; openSetting?: string }) =>
    // The OAuth group is part of the sign-in methods form (Access & security).
    commandCenterUrl(
      params?.isOpen ? areaForSection(serverSectionKey(params.isOpen)) : undefined,
      params?.isOpen ? serverSectionKey(params.isOpen) : undefined,
      {
        isOpen: params?.isOpen,
        [QueryParameter.OPEN_SETTING]: params?.openSetting,
      },
    ),
  /** Library analytics in the command center (FL-79); `/admin/server-status` redirects here. */
  libraryAnalytics: (params?: { scope?: string; range?: string }) => analyticsAreaUrl(params),
  // FL-71: the old administration pages are Command Center sections; their addresses redirect.
  physicalDeduplication: () => commandCenterUrl('storage', 'deduplication'),
  /** Maintenance (FL-71): the area's directory, or one of its sections (mode, database backups, integrity checks). */
  systemMaintenance: (params?: { section?: MaintenanceSectionKey; continue?: string }) =>
    commandCenterUrl('maintenance', params?.section, { continue: params?.continue }),
  /** Processing destinations (FL-110): where machine-learning work may run, with consent and cost controls. */
  systemProcessingDestinations: () => commandCenterUrl('processing', 'routing'),
  /** Workers & endpoints (FL-72): the worker inventory at the top of the same page. */
  systemWorkers: () => commandCenterUrl('processing', 'workers'),
  systemMaintenanceIntegrityReport: ({ reportType }: { reportType: IntegrityReport }) =>
    commandCenterUrl('maintenance', 'integrity', { report: reportType }),

  // studio
  /**
   * Opening Studio, optionally with a project and the "make a movie" selection. The query
   * is built by `studioHandoffQuery` so the link and the route's parser stay one contract.
   */
  studio: (params?: {
    projectId?: string | null;
    assetIds?: readonly string[];
    returnTo?: string | null;
    at?: { num: number; den: number } | null;
  }) => '/studio' + studioHandoffQuery(params ?? {}),
  /** The Studio project library (FL-91): every project, the archive and the trash. */
  studioProjects: (params?: { shelf?: 'active' | 'archived' | 'trashed' }) =>
    '/studio/projects' +
    asQueryString(params?.shelf && params.shelf !== 'active' ? { shelf: params.shelf } : undefined),

  // tags
  tags: (params?: { path?: string }) => '/tags' + asQueryString(params),

  // users
  users: () => commandCenterUrl('users', 'accounts'),
  newUser: () => commandCenterUrl('users', 'accounts', { new: 1 }),
  viewUser: ({ id }: { id: string }) => commandCenterUrl('users', 'accounts', { user: id }),
  editUser: ({ id }: { id: string }) => commandCenterUrl('users', 'accounts', { user: id, edit: 1 }),

  // utilities
  utilities: () => utilitiesUrl(),
  // The rail's Library Care opens the Library care area, the hub for fixes (September 24).
  libraryCare: () => commandCenterUrl('care'),
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
  workflows: () => utilitiesUrl('workflows'),
  viewWorkflow: ({ id }: { id: string }) => utilitiesUrl('workflows', { workflowId: id }),

  // render workers
  renderWorkers: () => commandCenterUrl('processing', 'render-workers'),

  // queues
  queues: () => commandCenterUrl('processing', 'queues'),
  /** FL-159: Compute & jobs → Frameleaf Cloud. */
  cloudMl: () => commandCenterUrl('cloud', 'cloud-processing'),
  /** FL-159: Compute & jobs → Hardware & GPU. */
  hardware: () => commandCenterUrl('processing', 'hardware'),
  /** One queue in the Job manager, optionally on one of its job-state tabs (active, waiting, failed, history). */
  viewQueue: ({ name, tab }: { name: QueueName; tab?: string }) =>
    commandCenterUrl('processing', 'queues', { queue: asQueueSlug(name), tab }),

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
