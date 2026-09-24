import { defaults } from '@immich/sdk';
import type { LibraryViewState } from '$lib/frameleaf/library-session';

/**
 * Client access to the transactional archive (FL-32, `/archive-operations`).
 *
 * The server freezes what an archive covers before anything changes — an explicit selection, or
 * every matching asset of the owner's own Timeline counted in one transaction and confirmed at that
 * exact count — hands it to the durable bulk job Activity already follows, and keeps a per-item
 * record so Undo survives a reload and never overwrites a newer change.
 *
 * These calls mirror the endpoints the server adds (`ArchiveOperationController`) with the names
 * and shapes the generated SDK will have. They go through the SDK's own `defaults` (base URL,
 * headers, fetch), so they behave like every generated call; once the SDK is regenerated this
 * module can re-export the generated functions instead.
 */

export enum ArchiveOperationScope {
  SelectedOwnedAssets = 'selected-owned-assets',
  MatchingOwnedTimeline = 'matching-owned-timeline',
}

export type ArchiveOperationResponseDto = {
  id: string;
  scope: ArchiveOperationScope;
  requestKey: string;
  /** Assets frozen into the operation. For a prepared selection, the count to confirm. */
  count: number;
  /** Counted and frozen, waiting for confirmation; nothing has changed yet. */
  prepared: boolean;
  expiresAt: string | null;
  createdAt: string;
  archiveJobId: string | null;
  undoJobId: string | null;
  pending: number;
  archived: number;
  skipped: number;
  undone: number;
  conflict: number;
  undoable: boolean;
};

/** A refused archive call. `status` is the HTTP status, for the caller to tell expiry from conflict. */
export class ArchiveOperationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ArchiveOperationError';
  }
}

const request = async <T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> => {
  const fetchImpl = defaults.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  for (const [key, value] of Object.entries(defaults.headers ?? {})) {
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetchImpl(`${defaults.baseUrl}${path}`, {
    method: init.method,
    headers,
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data?.message === 'string') {
        message = data.message;
      }
    } catch {
      // not JSON: keep the status text
    }
    throw new ArchiveOperationError(message, response.status);
  }
  return (await response.json()) as T;
};

export const createArchiveOperation = ({
  archiveOperationCreateDto,
}: {
  archiveOperationCreateDto: { requestKey: string; assetIds: string[] };
}) => request<ArchiveOperationResponseDto>('/archive-operations', { method: 'POST', body: archiveOperationCreateDto });

export const prepareArchiveOperation = ({
  archiveOperationPrepareDto,
}: {
  archiveOperationPrepareDto: { requestKey: string; scope: ArchiveOperationScope.MatchingOwnedTimeline };
}) =>
  request<ArchiveOperationResponseDto>('/archive-operations/prepare', {
    method: 'POST',
    body: archiveOperationPrepareDto,
  });

export const confirmArchiveOperation = ({
  id,
  archiveOperationConfirmDto,
}: {
  id: string;
  archiveOperationConfirmDto: { requestKey: string };
}) =>
  request<ArchiveOperationResponseDto>(`/archive-operations/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: archiveOperationConfirmDto,
  });

export const undoArchiveOperation = ({
  id,
  archiveOperationUndoDto,
}: {
  id: string;
  archiveOperationUndoDto: { requestKey: string };
}) =>
  request<ArchiveOperationResponseDto>(`/archive-operations/${encodeURIComponent(id)}/undo`, {
    method: 'POST',
    body: archiveOperationUndoDto,
  });

export const getArchiveOperations = () =>
  request<ArchiveOperationResponseDto[]>('/archive-operations', { method: 'GET' });

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
