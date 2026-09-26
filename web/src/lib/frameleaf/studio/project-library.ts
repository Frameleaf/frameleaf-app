/**
 * The Studio project library (FL-91, `STU-204`): pure view-model rules.
 *
 * The prototype kept exactly one project in local storage and had no library at all, so this is
 * beyond the prototype and follows the Frameleaf shell's own shelves: an active shelf with the
 * projects a person owns and the ones shared with a space they belong to, an archive and a trash
 * that are theirs alone. Everything here is derived from what the server said; nothing is
 * remembered in the browser.
 *
 * Deleting a project, even for good, only ever removes the project. The copy on the page says so,
 * because "delete" next to anything built from photos reads as "delete the photos".
 */
import {
  MediaOperationStatus,
  StudioBundleSourceMode,
  StudioBundleSourceResolution,
  StudioProjectAccess,
  StudioProjectShelf,
  type StudioBundleOperationDto,
  type StudioBundleSourceDto,
  type StudioBundleUploadDto,
  type StudioProjectDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { isRetryingMediaOperation } from '$lib/frameleaf/activity';

export type StudioLibraryShelf = 'active' | 'archived' | 'trashed';
export type StudioLibrarySort = 'updated' | 'recent' | 'name';

export const STUDIO_LIBRARY_SHELVES: ReadonlyArray<{ id: StudioLibraryShelf; labelKey: Translations }> = [
  { id: 'active', labelKey: 'frameleaf_studio_library_shelf_active' },
  { id: 'archived', labelKey: 'frameleaf_studio_library_shelf_archived' },
  { id: 'trashed', labelKey: 'frameleaf_studio_library_shelf_trashed' },
];

export const STUDIO_LIBRARY_SORTS: ReadonlyArray<{ id: StudioLibrarySort; labelKey: Translations }> = [
  { id: 'updated', labelKey: 'frameleaf_studio_library_sort_updated' },
  { id: 'recent', labelKey: 'frameleaf_studio_library_sort_recent' },
  { id: 'name', labelKey: 'frameleaf_studio_library_sort_name' },
];

/** How many recently opened projects the library puts first. */
export const STUDIO_RECENT_LIMIT = 4;

export const isStudioLibraryShelf = (value: unknown): value is StudioLibraryShelf =>
  typeof value === 'string' && ['active', 'archived', 'trashed'].includes(value);

export const isStudioLibrarySort = (value: unknown): value is StudioLibrarySort =>
  typeof value === 'string' && ['updated', 'recent', 'name'].includes(value);

/**
 * The projects this person opened most recently, newest first. A reviewer's `lastOpenedAt` is
 * always null (the server never tells a reviewer when the owner worked), so recents are the
 * person's own projects only.
 */
export const recentStudioProjects = (
  projects: readonly StudioProjectDto[],
  limit = STUDIO_RECENT_LIMIT,
): StudioProjectDto[] =>
  projects
    .filter(
      (project) =>
        project.access === StudioProjectAccess.Owner &&
        project.shelf === StudioProjectShelf.Active &&
        project.lastOpenedAt,
    )
    .sort((a, b) => Date.parse(b.lastOpenedAt as string) - Date.parse(a.lastOpenedAt as string))
    .slice(0, limit);

export type StudioProjectAction =
  'open' | 'rename' | 'duplicate' | 'export' | 'archive' | 'unarchive' | 'trash' | 'restore' | 'delete-permanently';

/**
 * What a person may do with one project from the library. The server decides every one of these
 * again; this only keeps the menu from offering something that would certainly be refused.
 */
export const studioProjectActions = (project: StudioProjectDto): StudioProjectAction[] => {
  if (project.access !== StudioProjectAccess.Owner) {
    return ['open'];
  }
  switch (project.shelf) {
    case StudioProjectShelf.Trashed: {
      return ['restore', 'delete-permanently'];
    }
    case StudioProjectShelf.Archived: {
      return ['open', 'unarchive', ...(project.revision > 0 ? (['export'] as const) : []), 'duplicate', 'trash'];
    }
    default: {
      return [
        'open',
        'rename',
        'duplicate',
        ...(project.revision > 0 ? (['export'] as const) : []),
        'archive',
        'trash',
      ];
    }
  }
};

/** Whole days before a trashed project is deleted for good, or null when it is not trashed. */
export const studioDaysUntilPurge = (project: Pick<StudioProjectDto, 'purgeAfter'>, now = new Date()): number | null =>
  project.purgeAfter
    ? Math.max(0, Math.ceil((Date.parse(project.purgeAfter) - now.getTime()) / (24 * 60 * 60 * 1000)))
    : null;

/* ------------------------------------------------------------------ */
/* Bundles                                                              */
/* ------------------------------------------------------------------ */

export type StudioBundleReview = {
  kept: number;
  suggested: number;
  missing: number;
  /** Missing sources the bundle carries a verified copy of; FL-105 can add those to the library. */
  missingWithCopy: number;
};

export const reviewStudioBundle = (upload: Pick<StudioBundleUploadDto, 'sources'>): StudioBundleReview => {
  const review = { kept: 0, suggested: 0, missing: 0, missingWithCopy: 0 };
  for (const source of upload.sources) {
    if (source.resolution === StudioBundleSourceResolution.Kept) {
      review.kept += 1;
    } else if (source.resolution === StudioBundleSourceResolution.Suggested) {
      review.suggested += 1;
    } else {
      review.missing += 1;
      if (source.mode === StudioBundleSourceMode.Embedded) {
        review.missingWithCopy += 1;
      }
    }
  }
  return review;
};

/**
 * The mapping an import sends: every suggestion the person left accepted. A suggestion is an item
 * of theirs with exactly the same content, already checked for access by the server; declining one
 * leaves that source missing rather than guessing another.
 */
export const studioBundleMapping = (
  sources: readonly StudioBundleSourceDto[],
  declined: ReadonlySet<string> = new Set(),
): Record<string, string> => {
  const mapping: Record<string, string> = {};
  for (const source of sources) {
    if (
      source.resolution === StudioBundleSourceResolution.Suggested &&
      source.suggestedAssetId &&
      !declined.has(source.key)
    ) {
      mapping[source.key] = source.suggestedAssetId;
    }
  }
  return mapping;
};

/** Server error codes a person can act on, as i18n keys. Anything else reads as a generic failure. */
const BUNDLE_ERROR_KEYS: Record<string, Translations> = {
  bundle_not_zip: 'frameleaf_studio_bundle_error_not_bundle',
  bundle_manifest_missing: 'frameleaf_studio_bundle_error_not_bundle',
  bundle_manifest_invalid: 'frameleaf_studio_bundle_error_damaged',
  bundle_project_invalid: 'frameleaf_studio_bundle_error_damaged',
  bundle_corrupt: 'frameleaf_studio_bundle_error_damaged',
  bundle_digest_mismatch: 'frameleaf_studio_bundle_error_damaged',
  bundle_size_mismatch: 'frameleaf_studio_bundle_error_damaged',
  bundle_entry_missing: 'frameleaf_studio_bundle_error_damaged',
  bundle_unexpected_entry: 'frameleaf_studio_bundle_error_unsafe',
  bundle_entry_name: 'frameleaf_studio_bundle_error_unsafe',
  bundle_overlap: 'frameleaf_studio_bundle_error_unsafe',
  bundle_ratio: 'frameleaf_studio_bundle_error_unsafe',
  bundle_encrypted: 'frameleaf_studio_bundle_error_unsafe',
  bundle_compression: 'frameleaf_studio_bundle_error_unsafe',
  bundle_zip64: 'frameleaf_studio_bundle_error_too_large',
  bundle_too_large: 'frameleaf_studio_bundle_error_too_large',
  bundle_too_many_entries: 'frameleaf_studio_bundle_error_too_large',
  bundle_upload_expired: 'frameleaf_studio_bundle_error_expired',
  bundle_project_unavailable: 'frameleaf_studio_bundle_error_project_gone',
  bundle_revision_unavailable: 'frameleaf_studio_bundle_error_project_gone',
};

export const studioBundleErrorKey = (code: string | null | undefined): Translations =>
  (code && BUNDLE_ERROR_KEYS[code]) || 'frameleaf_studio_bundle_error_generic';

/** The code in a refused upload's response body, read structurally from the SDK's error. */
export const studioBundleErrorCode = (error: unknown): string | null => {
  const data = (error as { data?: { code?: unknown; message?: unknown } } | null)?.data;
  if (data && typeof data.code === 'string') {
    return data.code;
  }
  const message = typeof data?.message === 'object' ? (data.message as { code?: unknown } | null) : null;
  return message && typeof message.code === 'string' ? message.code : null;
};

const FINISHED: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Completed,
  MediaOperationStatus.Failed,
  MediaOperationStatus.Cancelled,
]);

export const isStudioBundleSettled = (operation: Pick<StudioBundleOperationDto, 'status'>): boolean =>
  FINISHED.has(operation.status);

/**
 * The status line for a bundle job, in Activity's words (FL-104). A queued job that has already
 * failed once is waiting for its automatic retry, so it reads "Retrying shortly" here exactly as it
 * does on the Activity page, never as freshly queued.
 */
export const studioBundleJobStatusKey = (
  operation: Pick<StudioBundleOperationDto, 'status' | 'autoRetries' | 'retryAt'>,
): Translations =>
  isRetryingMediaOperation(operation)
    ? 'frameleaf_activity_status_retrying'
    : `frameleaf_activity_status_${operation.status}`;

/**
 * How often to ask about a running bundle job. Quick at first, then slower: a large export spends
 * minutes hashing and the page should not hammer the server while it does.
 */
export const studioBundlePollMs = (attempt: number): number => Math.min(10_000, 1000 * 2 ** Math.min(attempt, 4));
