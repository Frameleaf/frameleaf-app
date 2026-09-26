/**
 * Libraries rules for the Frameleaf admin Libraries area (FL-78).
 *
 * The design template's `AccountsLibraries.jsx` (libraries view) lists every owner's managed
 * uploads beside their external libraries, filters and sorts them, and drives a simulated scan.
 * Production has the real shapes: `LibraryResponseDto` with its latest durable scan, and
 * `ManagedUploadsStatsResponseDto` for the uploads Frameleaf stores itself. This module ports the
 * template's rules onto those shapes so the components stay about presentation and the rules stay
 * testable without a DOM.
 *
 * Nothing here decides what the server allows. Owner changes, folder checks, one scan per
 * library and the two-stage removal are all enforced by the endpoints; these rules only keep the
 * controls honest about what the server will say.
 */
import {
  LibraryScanPhase,
  LibraryScanStopReason,
  MediaOperationStatus,
  UserStatus,
  type LibraryResponseDto,
  type LibraryScanResponseDto,
  type LibraryStatsResponseDto,
  type ManagedUploadsStatsResponseDto,
  type UserAdminResponseDto,
  getAllLibraries,
  getLibraryStatistics,
  getManagedUploadStatistics,
  searchUsersAdmin,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/** The template's field limits. */
export const LIBRARY_NAME_MAX_LENGTH = 160;
export const LIBRARY_PATH_MAX_LENGTH = 1024;
export const LIBRARY_PATHS_MAX = 128;
export const LIBRARY_QUERY_MAX_LENGTH = 200;
/** A new library's exclusions, as the template seeds them. */
export const DEFAULT_EXCLUSION_PATTERNS: readonly string[] = ['**/.DS_Store'];
/** How often the list reads scan progress back while a scan is running. */
export const LIBRARY_SCAN_POLL_MS = 2000;

export type LibraryFilter = 'active' | 'all' | 'deleted' | 'upload' | 'external';
export type LibrarySort = 'name' | 'storage' | 'created';
export type LibraryKind = 'upload' | 'external';
/** `removing` is a library whose removal was confirmed and whose items are still going. */
export type LibraryLifecycle = 'active' | 'removing';

export type LibraryStats = { items: number; photos: number; videos: number; logical: number; physical: number };

/** One row of the Libraries table: an account's managed uploads, or an external library. */
export type LibraryRow = {
  /** `library:<id>` or `uploads:<ownerId>`, the key selection and the URL use. */
  key: string;
  kind: LibraryKind;
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  ownerActive: boolean;
  importPaths: string[];
  exclusionPatterns: string[];
  createdAt: string;
  refreshedAt: string | null;
  lifecycle: LibraryLifecycle;
  scan: LibraryScanResponseDto | null;
  stats: LibraryStats | null;
};

export const libraryKey = (id: string) => `library:${id}`;
export const uploadsKey = (ownerId: string) => `uploads:${ownerId}`;

const isActiveOwner = (user: Pick<UserAdminResponseDto, 'status' | 'deletedAt'> | undefined) =>
  !!user && user.status === UserStatus.Active && !user.deletedAt;

const toStats = (stats: Pick<LibraryStatsResponseDto, 'photos' | 'videos' | 'usage' | 'usagePhysical'>) => ({
  items: stats.photos + stats.videos,
  photos: stats.photos,
  videos: stats.videos,
  logical: stats.usage,
  physical: stats.usagePhysical,
});

/**
 * Every row the page can show: one managed-uploads row per active account, as the template's
 * seeded "uploads" libraries, then every external library, including those being removed.
 */
export const buildLibraryRows = ({
  libraries,
  users,
  uploads,
  statistics,
  uploadsName,
}: {
  libraries: LibraryResponseDto[];
  users: UserAdminResponseDto[];
  uploads: ManagedUploadsStatsResponseDto[];
  statistics: Record<string, LibraryStatsResponseDto | undefined>;
  uploadsName: (ownerName: string) => string;
}): LibraryRow[] => {
  const byId = new Map(users.map((user) => [user.id, user]));

  const uploadRows = uploads.flatMap((upload): LibraryRow[] => {
    const owner = byId.get(upload.ownerId);
    if (!owner) {
      return [];
    }
    return [
      {
        key: uploadsKey(owner.id),
        kind: 'upload',
        id: owner.id,
        name: uploadsName(owner.name),
        ownerId: owner.id,
        ownerName: owner.name,
        ownerActive: isActiveOwner(owner),
        importPaths: [],
        exclusionPatterns: [],
        createdAt: owner.createdAt,
        refreshedAt: null,
        lifecycle: 'active',
        scan: null,
        stats: toStats(upload),
      },
    ];
  });

  const externalRows = libraries.map((library): LibraryRow => {
    const owner = byId.get(library.ownerId);
    const stats = statistics[library.id];
    return {
      key: libraryKey(library.id),
      kind: 'external',
      id: library.id,
      name: library.name,
      ownerId: library.ownerId,
      ownerName: owner?.name ?? '',
      ownerActive: isActiveOwner(owner),
      importPaths: library.importPaths,
      exclusionPatterns: library.exclusionPatterns,
      createdAt: library.createdAt,
      refreshedAt: library.refreshedAt,
      lifecycle: library.deletedAt ? 'removing' : 'active',
      scan: library.scan ?? null,
      stats: stats ? toStats(stats) : null,
    };
  });

  return [...uploadRows, ...externalRows];
};

export const normalizeLibraryQuery = (query: string | undefined | null) =>
  (query ?? '').trim().slice(0, LIBRARY_QUERY_MAX_LENGTH).toLowerCase();

export const filterLibraryRows = (
  rows: readonly LibraryRow[],
  { query, filter, ownerId }: { query?: string | null; filter: LibraryFilter; ownerId?: string },
): LibraryRow[] => {
  const normalized = normalizeLibraryQuery(query);
  return rows.filter((row) => {
    if (ownerId && row.ownerId !== ownerId) {
      return false;
    }
    if (filter === 'active' && row.lifecycle !== 'active') {
      return false;
    }
    if (filter === 'deleted' && row.lifecycle === 'active') {
      return false;
    }
    if ((filter === 'upload' || filter === 'external') && row.kind !== filter) {
      return false;
    }
    return !normalized || `${row.name} ${row.ownerName}`.toLowerCase().includes(normalized);
  });
};

/** Sorts a copy, like the template: largest first for storage, newest first for created. */
export const sortLibraryRows = (rows: readonly LibraryRow[], sort: LibrarySort): LibraryRow[] => {
  const copy = [...rows];
  switch (sort) {
    case 'storage': {
      return copy.sort((a, b) => (b.stats?.logical ?? 0) - (a.stats?.logical ?? 0));
    }
    case 'created': {
      return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    case 'name': {
      return copy.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
};

/* ------------------------------------------------------------------ */
/* Scans                                                               */
/* ------------------------------------------------------------------ */

const ACTIVE_SCAN_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
]);

/** A scan that is waiting, running, paused or stopping: one the server will refuse to start again. */
export const isScanActive = (scan: LibraryScanResponseDto | null | undefined): scan is LibraryScanResponseDto =>
  !!scan && ACTIVE_SCAN_STATUSES.has(scan.status);

/** A scan whose numbers are still moving, which is what the page polls for. */
export const isScanMoving = (scan: LibraryScanResponseDto | null | undefined) =>
  isScanActive(scan) && scan.status !== MediaOperationStatus.Paused;

/** External, not being removed, with folders, an active owner and no scan already going. */
export const canScanLibrary = (row: LibraryRow) =>
  row.kind === 'external' &&
  row.lifecycle === 'active' &&
  row.importPaths.length > 0 &&
  row.ownerActive &&
  !isScanActive(row.scan);

/** The libraries the header's "Scan N libraries" covers. */
export const scannableLibraries = (rows: readonly LibraryRow[]) => rows.filter((row) => canScanLibrary(row));

export type ScanStatusKey =
  'queued' | 'running' | 'pausing' | 'paused' | 'cancelling' | 'cancelled' | 'retrying' | 'failed' | 'completed';

/** The status word in the table's Status column. */
export const scanStatusKey = (scan: LibraryScanResponseDto): ScanStatusKey => {
  if (scan.retrying) {
    return 'retrying';
  }
  switch (scan.status) {
    case MediaOperationStatus.Queued: {
      return 'queued';
    }
    case MediaOperationStatus.Paused: {
      return 'paused';
    }
    case MediaOperationStatus.Cancelling: {
      return 'cancelling';
    }
    case MediaOperationStatus.Cancelled: {
      return 'cancelled';
    }
    case MediaOperationStatus.Failed: {
      return 'failed';
    }
    case MediaOperationStatus.Completed: {
      return 'completed';
    }
    default: {
      return scan.pauseRequested ? 'pausing' : 'running';
    }
  }
};

export const scanNeedsAttention = (scan: LibraryScanResponseDto) =>
  scan.status === MediaOperationStatus.Failed || scan.retrying;

type FailureKey =
  | 'frameleaf_libraries_scan_failed_unavailable'
  | 'frameleaf_libraries_scan_failed_empty'
  | 'frameleaf_libraries_scan_failed_owner'
  | 'frameleaf_libraries_scan_failed_no_folders'
  | 'frameleaf_libraries_scan_failed';

/** What the scan block's message says, as a translation key and its values. */
export type ScanMessage = { key: Translations; values?: Record<string, string | number> };

const FAILURE_KEYS: Readonly<Record<string, FailureKey>> = {
  library_source_unavailable: 'frameleaf_libraries_scan_failed_unavailable',
  library_source_empty: 'frameleaf_libraries_scan_failed_empty',
  library_scan_owner_inactive: 'frameleaf_libraries_scan_failed_owner',
  library_scan_no_folders: 'frameleaf_libraries_scan_failed_no_folders',
};

export const scanMessage = (scan: LibraryScanResponseDto | null | undefined): ScanMessage => {
  if (!scan) {
    return { key: 'frameleaf_libraries_scan_idle' };
  }

  if (scanNeedsAttention(scan)) {
    const key: FailureKey = (scan.errorCode && FAILURE_KEYS[scan.errorCode]) || 'frameleaf_libraries_scan_failed';
    return {
      key: scan.retrying ? (`${key}_retrying` as const) : key,
      values: { error: scan.error ?? '' },
    };
  }

  switch (scanStatusKey(scan)) {
    case 'queued': {
      return { key: 'frameleaf_libraries_scan_waiting' };
    }
    case 'pausing': {
      return { key: 'frameleaf_libraries_scan_pausing' };
    }
    case 'paused': {
      return { key: 'frameleaf_libraries_scan_paused' };
    }
    case 'cancelling': {
      return { key: 'frameleaf_libraries_scan_cancelling' };
    }
    case 'cancelled': {
      if (scan.stopReason === LibraryScanStopReason.PathsChanged) {
        return { key: 'frameleaf_libraries_scan_stopped_paths' };
      }
      if (scan.stopReason === LibraryScanStopReason.OwnerDeleted) {
        return { key: 'frameleaf_libraries_scan_stopped_owner' };
      }
      return { key: 'frameleaf_libraries_scan_cancelled' };
    }
    case 'completed': {
      return {
        key: 'frameleaf_libraries_scan_completed',
        values: {
          matched: Math.max(0, scan.checked - scan.offlined),
          added: scan.added,
          missing: scan.offlined,
        },
      };
    }
    default: {
      return scan.phase === LibraryScanPhase.Crawl
        ? { key: 'frameleaf_libraries_scan_reading', values: { found: scan.processedUnits, added: scan.added } }
        : // in the check phase the totals are the crawl's files plus the items to check
          {
            key: 'frameleaf_libraries_scan_checking',
            values: {
              checked: scan.checked,
              total: Math.max(scan.checked, scan.totalUnits - (scan.processedUnits - scan.checked)),
            },
          };
    }
  }
};

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u{0}-\u{1F}\u{7F}]/u;

/** The template's own format check, before the server is asked about the disk. */
export const isImportPathFormatValid = (path: string) =>
  path.startsWith('/') && !path.split('/').includes('..') && !CONTROL_CHARACTERS.test(path);

const normalizeFolder = (path: string) => (path.length > 1 && path.endsWith('/') ? path.replace(/\/+$/, '') : path);

/** Folders or exclusions as the form will send them, or why the form cannot be saved yet. */
export const checkPathList = (values: readonly string[]): 'empty' | 'duplicate' | 'too-many' | null => {
  if (values.length > LIBRARY_PATHS_MAX) {
    return 'too-many';
  }
  if (values.some((value) => value.trim() === '')) {
    return 'empty';
  }
  const normalized = values.map((value) => normalizeFolder(value.trim()));
  return new Set(normalized).size === normalized.length ? null : 'duplicate';
};

/** Whether saving these folders and exclusions changes what the library scans. */
export const foldersChanged = (
  library: Pick<LibraryResponseDto, 'importPaths' | 'exclusionPatterns'>,
  next: { importPaths: string[]; exclusionPatterns: string[] },
) => {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length &&
    a
      .map((value) => normalizeFolder(value))
      .sort()
      .join('\n') ===
      b
        .map((value) => normalizeFolder(value))
        .sort()
        .join('\n');
  return !same(library.importPaths, next.importPaths) || !same(library.exclusionPatterns, next.exclusionPatterns);
};

/** The HTTP status of a failed SDK call, when it has one. */
export const serverStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Everything the Libraries area shows, read afresh on every refresh (FL-78). */
export type LibrariesAreaData = {
  users: UserAdminResponseDto[];
  libraries: LibraryResponseDto[];
  uploads: ManagedUploadsStatsResponseDto[];
  statistics: Record<string, LibraryStatsResponseDto | undefined>;
  snapshotAt: Date;
};

/**
 * Every account (deleted ones too, so a library's owner always has a name), every external library
 * including those still being removed, each with its latest scan, and each account's managed
 * uploads, with each library's statistics.
 */
export const loadLibrariesArea = async (api: {
  searchUsersAdmin: typeof searchUsersAdmin;
  getAllLibraries: typeof getAllLibraries;
  getManagedUploadStatistics: typeof getManagedUploadStatistics;
  getLibraryStatistics: typeof getLibraryStatistics;
}): Promise<LibrariesAreaData> => {
  const [users, libraries, uploads] = await Promise.all([
    api.searchUsersAdmin({ withDeleted: true }),
    api.getAllLibraries({ withDeleted: true }),
    api.getManagedUploadStatistics(),
  ]);
  const statistics = Object.fromEntries(
    await Promise.all(
      libraries.map(async ({ id }) => [id, await api.getLibraryStatistics({ id }).catch(() => undefined)] as const),
    ),
  );
  return { users, libraries, uploads, statistics, snapshotAt: new Date() };
};
