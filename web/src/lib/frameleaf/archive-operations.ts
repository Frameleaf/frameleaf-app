import {
  type ArchiveOperationResponseDto,
  confirmArchiveOperation,
  createArchiveOperation,
  getArchiveOperations,
  isHttpError,
  prepareArchiveOperation,
  undoArchiveOperation,
} from '@immich/sdk';
import type { LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * The transactional archive (FL-32, `/archive-operations`) as the library uses it.
 *
 * The server freezes what an archive covers before anything changes — an explicit selection, or
 * every matching asset of the owner's own Timeline counted in one transaction and confirmed at that
 * exact count — hands it to the durable bulk job Activity already follows, and keeps a per-item
 * record so Undo survives a reload and never overwrites a newer change. The calls are the generated
 * SDK's; the gateway is the seam the bulk controller's tests replace.
 */
export type ArchiveGateway = {
  createArchiveOperation: typeof createArchiveOperation;
  prepareArchiveOperation: typeof prepareArchiveOperation;
  confirmArchiveOperation: typeof confirmArchiveOperation;
  undoArchiveOperation: typeof undoArchiveOperation;
  getArchiveOperations: typeof getArchiveOperations;
};

export const archiveGateway: ArchiveGateway = {
  createArchiveOperation,
  prepareArchiveOperation,
  confirmArchiveOperation,
  undoArchiveOperation,
  getArchiveOperations,
};

/** The largest selection one archive operation accepts; the server's `BULK_MAX_ITEMS`. */
export const ARCHIVE_OPERATION_MAX_ITEMS = 50_000;

/** How long after an archive its Undo is offered again on a page that was reloaded. */
export const ARCHIVE_UNDO_RESTORE_MS = 30 * 60 * 1000;

/** The operation was submitted or confirmed from this session, so this session may offer its Undo. */
export const isCurrentSession = (operation: ArchiveOperationResponseDto) => operation.currentSession ?? false;

/** The server refused to confirm a prepared selection because it expired (HTTP 410). */
export const isExpiredSelection = (error: unknown) => isHttpError(error) && error.status === 410;

/**
 * Whether a "select everything matching" archive can be counted and frozen by the server: the
 * unfiltered library scope, which is exactly the owner's normal Timeline. Any filter, search text,
 * similar-photo reference, enrichment facet, album or Space goes through the frozen id list
 * instead, so the server is never asked to archive a wider set than the view showed.
 */
export const preparesArchiveOnServer = (state: LibraryViewState): boolean => {
  const { scope, query } = state;
  return (
    scope.kind === 'library' &&
    !scope.id &&
    !(query.text ?? '').trim() &&
    !query.queryAssetId &&
    !query.imageEnrichment &&
    !query.spaceId &&
    Object.keys(query.filter ?? {}).length === 0
  );
};
