import type { Translations } from 'svelte-i18n';
import {
  DISCOVERY_FILTER_SECTIONS,
  emptyDiscoveryQuery,
  isDiscoveryFilter,
  MAX_DISCOVERY_QUERY_LENGTH,
  parseDiscoveryQuery,
  type DiscoveryFilterSection,
  type DiscoveryQuery,
  type DiscoveryQueryProblem,
} from '$lib/components/discovery/query';
import type { BulkActionId } from '$lib/frameleaf/bulk-actions';

/**
 * The one library session every Frameleaf view shares.
 *
 * Ported for FL-31 from the approved prototype: `design/frameleaf/template/src/selection.mjs`
 * (selection algebra), the session portion of `App.jsx`, `search.mjs` (paging) and
 * `reference/library-session.ts`. The September 22, 2026 interaction revision fixes the semantics
 * this module has to guarantee:
 *
 * - Browse is the default layout, and layout is device-local: it never travels in a URL.
 * - Selection is a separate multi-select state from the open item. Nothing is selected on load,
 *   shift-click selects a range, and a day header selects its group.
 * - Page state (scope, query, sort, filter, grouping, view, layout) survives a layout switch and
 *   survives a mutation of the assets on the page.
 * - Selection is never persisted across reloads.
 * - Structured filtering lives behind one Filter control; the session carries which panel section
 *   the control deep-links into.
 * - Paging is cumulative: Show more raises the page count, it does not replace the page.
 *
 * Presentation switches never rebuild the collection, the selection or the editor draft.
 */
export type LibraryLayout = 'timeline' | 'browse' | 'work';
export type LibraryView = 'grid' | 'list' | 'detail' | 'compare' | 'map' | 'moments';
export type LibrarySort = 'captured-desc' | 'captured-asc' | 'imported-desc' | 'modified-desc' | 'filename' | 'rating';
export type LibraryGrouping = 'all' | 'days' | 'months' | 'years';
export type LibraryScope = { kind: 'library' | 'album' | 'space'; id?: string };

export const LIBRARY_LAYOUTS: readonly LibraryLayout[] = ['timeline', 'browse', 'work'];
export const LIBRARY_VIEWS: readonly LibraryView[] = ['grid', 'list', 'detail', 'compare', 'map', 'moments'];
export const LIBRARY_SORTS: readonly LibrarySort[] = [
  'captured-desc',
  'captured-asc',
  'imported-desc',
  'modified-desc',
  'filename',
  'rating',
];
export const LIBRARY_GROUPINGS: readonly LibraryGrouping[] = ['all', 'days', 'months', 'years'];
export const LIBRARY_SCOPE_KINDS: readonly LibraryScope['kind'][] = ['library', 'album', 'space'];

/** Browse is the default layout (September 22, 2026 revision). */
export const DEFAULT_LIBRARY_LAYOUT: LibraryLayout = 'browse';

/** The portable part of the session: everything a shared URL or a saved preset may carry. */
export type LibraryViewState = {
  version: 1;
  scope: LibraryScope;
  query: DiscoveryQuery;
  sort: LibrarySort;
  grouping: LibraryGrouping;
  view: LibraryView;
};

export type LibraryDraft = {
  assetId: string;
  recipe: unknown[];
  undo: unknown[][];
  redo: unknown[][];
};

/**
 * A bulk operation submitted against a frozen view state (FL-32).
 *
 * The record is what the UI shows while the work runs and what a retry resumes from. `scope` is a
 * deep copy taken at submit: editing the filter afterwards changes the session, never a running
 * operation. `requestId` is the idempotency key — a retry of the failed items reuses it so the
 * operation stays one thing in the activity list rather than becoming several.
 */
export type BulkOperationStatus = 'resolving' | 'running' | 'completed' | 'cancelled' | 'failed';

export type BulkOperationRecord = {
  requestId: string;
  action: BulkActionId;
  scope: LibraryViewState;
  status: BulkOperationStatus;
  /** The matching count shown to the user when they submitted, before anything ran. */
  submittedTotal: number | null;
  /** Items the server has answered for. */
  processed: number;
  /** Items in the operation once the matching set is resolved. */
  total: number | null;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Per-item failures, bounded so a large operation cannot grow the session without limit. */
  failures: { id: string; reasonKey?: Translations; message?: string }[];
  /** True when the matching set was larger than the client's bound and was cut short. */
  truncated: boolean;
  startedAt: number;
  finishedAt?: number;
  /** i18n key when the operation could not start at all. */
  errorKey?: Translations;
};

/** Failures kept per operation; the count above stays exact. */
export const BULK_OPERATION_FAILURE_LIMIT = 100;
/** Operations kept on the session; older finished ones fall off. */
export const BULK_OPERATION_HISTORY_LIMIT = 20;

export type LibrarySession = {
  /** Device-local, never portable. */
  layout: LibraryLayout;
  state: LibraryViewState;
  /** Ordered multi-select. Separate from `openAssetId`; empty on load and after a scope change. */
  selection: string[];
  /** The last item a plain click landed on; the origin of the next shift-click range. */
  anchorId: string | null;
  /** The view state a "select everything matching" selection was taken against. */
  selectionSnapshot?: LibraryViewState;
  scrollAnchor?: string;
  /** The item open in the viewer. Opening an item does not select it. */
  openAssetId?: string;
  playbackPosition: number;
  draft: LibraryDraft | null;
  /** Cumulative page count for Show more. */
  page: number;
  /** Which section of the filter panel the single Filter control is deep-linked into. */
  filterSection: DiscoveryFilterSection | null;
  /**
   * Increments whenever the result set changes. An in-flight request carries the revision it was
   * issued under; a response whose revision is stale must be dropped rather than applied.
   */
  revision: number;
  /**
   * Background bulk operations, newest first. Each carries its own frozen scope, so it is
   * unaffected by anything the session does afterwards. Never persisted across reloads.
   */
  operations: BulkOperationRecord[];
};

export type LibrarySessionAction =
  | { type: 'layout'; layout: LibraryLayout }
  | { type: 'view'; patch: Partial<Omit<LibraryViewState, 'version'>> }
  | { type: 'scope'; scope: LibraryScope }
  | { type: 'selection'; ids: string[]; allMatching?: boolean }
  | { type: 'select'; id: string; additive?: boolean }
  | { type: 'select-range'; orderedIds: string[]; id: string }
  | { type: 'select-group'; ids: string[]; checked: boolean }
  | { type: 'select-all'; orderedIds: string[] }
  | { type: 'clear-selection' }
  | { type: 'anchor'; id: string }
  | { type: 'open'; id: string; time?: number }
  | { type: 'close' }
  | { type: 'playback'; time: number }
  | { type: 'draft'; draft: LibrarySession['draft'] }
  | { type: 'show-more' }
  | { type: 'page'; page: number }
  | { type: 'filter-section'; section: DiscoveryFilterSection | null }
  | { type: 'mutated'; removedIds: string[] }
  /* FL-32, additive: background bulk operations over a scope-bound snapshot. */
  | {
      type: 'operation-start';
      requestId: string;
      action: BulkActionId;
      /** Omitted for a selected-id operation, which is bound by its ids rather than a scope. */
      scope?: LibraryViewState;
      submittedTotal?: number | null;
    }
  | {
      type: 'operation-progress';
      requestId: string;
      processed?: number;
      total?: number | null;
      status?: Extract<BulkOperationStatus, 'resolving' | 'running'>;
    }
  | {
      type: 'operation-finish';
      requestId: string;
      succeeded: number;
      failed: number;
      skipped: number;
      failures?: BulkOperationRecord['failures'];
      cancelled?: boolean;
      truncated?: boolean;
      errorKey?: Translations;
    }
  | { type: 'operation-dismiss'; requestId: string };

export const createLibrarySession = (): LibrarySession => ({
  layout: DEFAULT_LIBRARY_LAYOUT,
  state: {
    version: 1,
    scope: { kind: 'library' },
    query: emptyDiscoveryQuery(),
    sort: 'captured-desc',
    grouping: 'all',
    view: 'grid',
  },
  selection: [],
  anchorId: null,
  playbackPosition: 0,
  draft: null,
  page: 1,
  filterSection: null,
  revision: 0,
  operations: [],
});

/* -------------------------------------------------------------------------- */
/* Selection algebra (ported from selection.mjs)                               */
/* -------------------------------------------------------------------------- */

const ids = (value: Iterable<string> | null | undefined): string[] =>
  value ? [...value].filter((id) => typeof id === 'string') : [];

const union = (current: Iterable<string>, extra: Iterable<string>): string[] => {
  const seen = new Set(ids(current));
  const next = [...seen];
  for (const id of extra) {
    if (typeof id !== 'string' || seen.has(id)) {
      continue;
    }

    seen.add(id);
    next.push(id);
  }
  return next;
};

export const isSelected = (selection: string[], id: string) => selection.includes(id);

export const toggleSelection = (selection: string[], id: string): string[] =>
  selection.includes(id) ? selection.filter((value) => value !== id) : [...selection, id];

/** Everything between the anchor and the target, inclusive, in visible order. */
export const selectRange = (
  orderedIds: string[],
  anchorId: string | null,
  targetId: string,
  current: string[] = [],
): string[] => {
  const order = Array.isArray(orderedIds) ? orderedIds : [];
  const target = order.indexOf(targetId);
  if (target === -1) {
    return ids(current);
  }
  const anchor = anchorId === null ? -1 : order.indexOf(anchorId);
  if (anchor < 0) {
    return union(current, [targetId]);
  }
  const [from, to] = anchor < target ? [anchor, target] : [target, anchor];
  return union(current, order.slice(from, to + 1));
};

export const selectAll = (orderedIds: string[], current: string[] = []) => union(current, orderedIds ?? []);

export const clearSelection = (): string[] => [];

/** Add or remove a whole group; used by the sticky day header's select-all checkbox. */
export const selectGroup = (current: string[], groupIds: string[], checked: boolean): string[] => {
  const group = Array.isArray(groupIds) ? groupIds : [];
  if (checked) {
    return union(current, group);
  }
  const remove = new Set(group);
  return ids(current).filter((id) => !remove.has(id));
};

export type GroupSelectionState = 'none' | 'some' | 'all';

export const groupSelectionState = (groupIds: string[], current: string[]): GroupSelectionState => {
  const group = Array.isArray(groupIds) ? groupIds : [];
  if (group.length === 0) {
    return 'none';
  }
  const selected = new Set(ids(current));
  const count = group.filter((id) => selected.has(id)).length;
  return count === 0 ? 'none' : count === group.length ? 'all' : 'some';
};

/** The anchor for the next shift-click after `id` was toggled. */
export const nextAnchor = (selection: string[], id: string, previousAnchor: string | null = null): string | null => {
  if (selection.includes(id)) {
    return id;
  }
  if (previousAnchor && selection.includes(previousAnchor)) {
    return previousAnchor;
  }
  return selection.at(-1) ?? null;
};

/* -------------------------------------------------------------------------- */
/* Reducer                                                                     */
/* -------------------------------------------------------------------------- */

/** Patch keys that change which assets are on the page, and therefore restart cumulative paging. */
const RESULT_KEYS: readonly (keyof LibraryViewState)[] = ['scope', 'query', 'sort'];

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const withSelection = (session: LibrarySession, selection: string[], anchorId: string | null): LibrarySession => ({
  ...session,
  selection,
  anchorId,
  selectionSnapshot: undefined,
});

const patchOperation = (
  session: LibrarySession,
  requestId: string,
  patch: (operation: BulkOperationRecord) => BulkOperationRecord,
): LibrarySession => {
  let changed = false;
  const operations = session.operations.map((operation) => {
    if (operation.requestId !== requestId) {
      return operation;
    }
    const next = patch(operation);
    changed ||= next !== operation;
    return next;
  });
  return changed ? { ...session, operations } : session;
};

/**
 * Presentation switches never rebuild the collection, the selection or the editor draft: a
 * `layout` action touches `layout` alone, and a `view` patch that only changes grouping or the
 * view mode leaves the page count and the selection where they were.
 */
/** An operation in one of these states has settled; a late progress report must not revive it. */
const FINISHED_OPERATION_STATUSES: ReadonlySet<BulkOperationStatus> = new Set(['completed', 'cancelled', 'failed']);

export const reduceLibrarySession = (session: LibrarySession, action: LibrarySessionAction): LibrarySession => {
  switch (action.type) {
    case 'layout': {
      return LIBRARY_LAYOUTS.includes(action.layout) && action.layout !== session.layout
        ? { ...session, layout: action.layout }
        : session;
    }
    case 'view': {
      const state: LibraryViewState = { ...session.state, ...action.patch, version: 1 };
      const resultChanged = RESULT_KEYS.some((key) => !sameValue(state[key], session.state[key]));
      const scopeChanged = !sameValue(state.scope, session.state.scope);
      return {
        ...session,
        state,
        // Cumulative paging restarts only when the result set itself changes.
        page: resultChanged ? 1 : session.page,
        revision: resultChanged ? session.revision + 1 : session.revision,
        // Selection is scope-bound: narrowing inside a scope keeps it, leaving the scope does not.
        selection: scopeChanged ? [] : session.selection,
        anchorId: scopeChanged ? null : session.anchorId,
        selectionSnapshot: scopeChanged ? undefined : session.selectionSnapshot,
      };
    }
    case 'scope': {
      return reduceLibrarySession(session, { type: 'view', patch: { scope: action.scope } });
    }
    /*
     * The shift-click anchor follows the prototype (`App.jsx` toggleSelect, selectGroupIds,
     * clearSelection): only a plain tile toggle sets it. A shift-click range, a replaced selection,
     * a group checkbox, select-all and clearing all leave it where it was, so chained shift-clicks
     * all range from the same original anchor, even after that item was deselected.
     */
    case 'selection': {
      return {
        ...session,
        selection: [...new Set(action.ids)],
        selectionSnapshot: action.allMatching ? structuredClone(session.state) : undefined,
      };
    }
    case 'select': {
      const selection = action.additive === false ? [action.id] : toggleSelection(session.selection, action.id);
      return withSelection(session, selection, nextAnchor(selection, action.id, session.anchorId));
    }
    case 'select-range': {
      // With no anchor yet, a shift-click is a plain toggle, which sets the anchor.
      if (session.anchorId === null) {
        return reduceLibrarySession(session, { type: 'select', id: action.id });
      }
      const selection = selectRange(action.orderedIds, session.anchorId, action.id, session.selection);
      return withSelection(session, selection, session.anchorId);
    }
    case 'select-group': {
      return withSelection(session, selectGroup(session.selection, action.ids, action.checked), session.anchorId);
    }
    case 'select-all': {
      return withSelection(session, selectAll(action.orderedIds, session.selection), session.anchorId);
    }
    case 'clear-selection': {
      return session.selection.length === 0 ? session : withSelection(session, clearSelection(), session.anchorId);
    }
    case 'anchor': {
      return { ...session, scrollAnchor: action.id };
    }
    case 'open': {
      // Opening an item is not selecting it; the multi-select state is left untouched.
      return {
        ...session,
        openAssetId: action.id,
        playbackPosition: Number.isFinite(action.time) ? Math.max(0, action.time as number) : 0,
      };
    }
    case 'close': {
      return { ...session, openAssetId: undefined, playbackPosition: 0 };
    }
    case 'playback': {
      return Number.isFinite(action.time) ? { ...session, playbackPosition: Math.max(0, action.time) } : session;
    }
    case 'draft': {
      return { ...session, draft: action.draft };
    }
    case 'show-more': {
      return { ...session, page: session.page + 1 };
    }
    case 'page': {
      const page = Number.isSafeInteger(action.page) ? Math.max(1, action.page) : session.page;
      return page === session.page ? session : { ...session, page };
    }
    case 'filter-section': {
      const section =
        action.section === null || DISCOVERY_FILTER_SECTIONS.includes(action.section) ? action.section : null;
      return section === session.filterSection ? session : { ...session, filterSection: section };
    }
    case 'mutated': {
      // A bulk operation removed assets from the page. Page state — scope, query, filter, sort,
      // grouping, view and layout — is untouched; only references to the gone assets are dropped.
      const removed = new Set(action.removedIds);
      if (removed.size === 0) {
        return session;
      }
      const selection = session.selection.filter((id) => !removed.has(id));
      const anchorId = session.anchorId && removed.has(session.anchorId) ? null : session.anchorId;
      const openAssetId = session.openAssetId && removed.has(session.openAssetId) ? undefined : session.openAssetId;
      return {
        ...session,
        selection,
        anchorId,
        openAssetId,
        playbackPosition: openAssetId === session.openAssetId ? session.playbackPosition : 0,
        scrollAnchor: session.scrollAnchor && removed.has(session.scrollAnchor) ? undefined : session.scrollAnchor,
        draft: session.draft && removed.has(session.draft.assetId) ? null : session.draft,
      };
    }
    /* FL-32: background bulk operations. They own a frozen copy of the view state, so nothing the
       session does after submit can change what a running operation acts on. */
    case 'operation-start': {
      if (session.operations.some((operation) => operation.requestId === action.requestId)) {
        // A retry reuses the request key; the existing record is resumed, not duplicated.
        return patchOperation(session, action.requestId, (operation) => ({
          ...operation,
          status: 'resolving',
          finishedAt: undefined,
          errorKey: undefined,
        }));
      }
      const record: BulkOperationRecord = {
        requestId: action.requestId,
        action: action.action,
        scope: structuredClone(action.scope ?? session.state),
        status: 'resolving',
        submittedTotal: action.submittedTotal ?? null,
        processed: 0,
        total: action.submittedTotal ?? null,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        failures: [],
        truncated: false,
        startedAt: Date.now(),
      };
      return {
        ...session,
        operations: [record, ...session.operations].slice(0, BULK_OPERATION_HISTORY_LIMIT),
      };
    }
    case 'operation-progress': {
      return patchOperation(session, action.requestId, (operation) =>
        FINISHED_OPERATION_STATUSES.has(operation.status)
          ? operation
          : {
              ...operation,
              status: action.status ?? 'running',
              processed: Number.isSafeInteger(action.processed) ? (action.processed as number) : operation.processed,
              total: action.total === undefined ? operation.total : action.total,
            },
      );
    }
    case 'operation-finish': {
      return patchOperation(session, action.requestId, (operation) => ({
        ...operation,
        status: action.errorKey ? 'failed' : action.cancelled ? 'cancelled' : 'completed',
        processed: action.succeeded + action.failed + action.skipped,
        succeeded: action.succeeded,
        failed: action.failed,
        skipped: action.skipped,
        failures: (action.failures ?? []).slice(0, BULK_OPERATION_FAILURE_LIMIT),
        truncated: action.truncated ?? operation.truncated,
        finishedAt: Date.now(),
        ...(action.errorKey && { errorKey: action.errorKey }),
      }));
    }
    case 'operation-dismiss': {
      const operations = session.operations.filter((operation) => operation.requestId !== action.requestId);
      return operations.length === session.operations.length ? session : { ...session, operations };
    }
  }
};

/** Operations still doing work. Used to keep the progress strip and its cancel control on screen. */
export const activeOperations = (session: LibrarySession): BulkOperationRecord[] =>
  session.operations.filter((operation) => operation.status === 'resolving' || operation.status === 'running');

/**
 * True when a "select everything matching" snapshot still describes the session's current scope
 * and query. FL-31 clears the snapshot on a scope change; this also catches the case where the
 * query moved on while the snapshot was still on screen, so the bar can offer the stale snapshot's
 * count honestly or drop back to the resolved ids.
 */
export const isSnapshotCurrent = (session: LibrarySession): boolean =>
  !!session.selectionSnapshot &&
  sameValue(session.selectionSnapshot.scope, session.state.scope) &&
  sameValue(session.selectionSnapshot.query, session.state.query);

/**
 * The view state a bulk operation must be submitted against: the snapshot when the user asked for
 * everything matching, and otherwise the live state. Always a deep copy, so the caller cannot hand
 * a running operation a reference the session will mutate.
 */
export const operationScope = (session: LibrarySession): LibraryViewState =>
  structuredClone(session.selectionSnapshot ?? session.state);

/** True when a response issued at `revision` still describes the session's current result set. */
export const isCurrentResult = (session: LibrarySession, revision: number) => session.revision === revision;

/* -------------------------------------------------------------------------- */
/* Portable state: URL and stored preferences                                  */
/* -------------------------------------------------------------------------- */

const oneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === 'string' && choices.includes(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The URL parameter carrying the portable view state. */
export const LIBRARY_VIEW_PARAMETER = 'fl';

/**
 * Bounded structural validation of a filter. FL-48: this is the shared query contract's validator,
 * which mirrors the search DTO field by field; the authenticated search API still validates again.
 */
export const isLibraryFilter = (value: unknown, branch = false): boolean => isDiscoveryFilter(value, branch);

/**
 * Why a view state was refused. `unsupported-version` comes from a newer client: the caller must not
 * overwrite it with its own narrower reading (FL-48).
 */
export type LibraryViewProblem = DiscoveryQueryProblem;

export type LibraryViewParse = { ok: true; state: LibraryViewState } | { ok: false; problem: LibraryViewProblem };

const refuseView = (problem: LibraryViewProblem): LibraryViewParse => ({ ok: false, problem });

/**
 * Parse only view state. URLs restore portable query state; they cannot inject local selections,
 * a layout, leases or edit history. The query inside goes through the one query reader
 * (`parseDiscoveryQuery`), so every field of the query — text field, similar-photo reference, space,
 * enrichment facet, grouping and view — survives a round trip through the URL and through storage.
 */
export const parseLibraryViewValue = (value: unknown): LibraryViewParse => {
  if (!object(value)) {
    return refuseView('malformed');
  }
  if (value.version !== 1) {
    const newer = typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version > 1;
    return refuseView(newer ? 'unsupported-version' : 'malformed');
  }
  if (!object(value.scope) || !oneOf(value.scope.kind, LIBRARY_SCOPE_KINDS)) {
    return refuseView('invalid');
  }
  if (
    value.scope.kind !== 'library' &&
    (typeof value.scope.id !== 'string' || !value.scope.id || value.scope.id.length > 128)
  ) {
    return refuseView('invalid');
  }
  if (
    !oneOf(value.sort, LIBRARY_SORTS) ||
    !oneOf(value.grouping, LIBRARY_GROUPINGS) ||
    !oneOf(value.view, LIBRARY_VIEWS)
  ) {
    return refuseView('invalid');
  }
  const query = parseDiscoveryQuery(value.query);
  if (!query.ok) {
    return refuseView(query.problem);
  }
  return {
    ok: true,
    state: {
      version: 1,
      scope: {
        kind: value.scope.kind as LibraryScope['kind'],
        ...(value.scope.kind !== 'library' && { id: value.scope.id as string }),
      },
      query: query.query,
      sort: value.sort as LibrarySort,
      grouping: value.grouping as LibraryGrouping,
      view: value.view as LibraryView,
    },
  };
};

/**
 * The view state a URL carries. `null` when it carries none; otherwise the parse result, so a caller
 * can tell a missing state from a refused one.
 */
export const parseLibraryView = (url: URL): LibraryViewParse | null => {
  const raw = url.searchParams.get(LIBRARY_VIEW_PARAMETER);
  if (!raw) {
    return null;
  }
  if (raw.length > MAX_DISCOVERY_QUERY_LENGTH) {
    return refuseView('malformed');
  }
  try {
    return parseLibraryViewValue(JSON.parse(raw));
  } catch {
    return refuseView('malformed');
  }
};

/** The view state a URL carries, or `null` for none or an unusable one. */
export const readLibraryView = (url: URL): LibraryViewState | null => {
  const result = parseLibraryView(url);
  return result?.ok ? result.state : null;
};

/** Reuse URL validation for stored presets without accepting their arbitrary object shape. */
export const readLibraryViewValue = (value: unknown): LibraryViewState | null => {
  try {
    // The same JSON round trip a URL makes, so an in-memory value reads exactly as its link would.
    // Not structuredClone: the JSON round trip is the point (undefined dropped, dates as strings).
    const json = JSON.stringify(value);
    const result = parseLibraryViewValue(JSON.parse(json));
    return result.ok ? result.state : null;
  } catch {
    return null;
  }
};

export const writeLibraryView = (url: URL, state: LibraryViewState): URL => {
  const next = new URL(url);
  next.searchParams.set(LIBRARY_VIEW_PARAMETER, JSON.stringify(state));
  return next;
};

/** Callers must use the authenticated user ID; never reuse another user's session. */
export const libraryPreferenceKey = (userId: string) => `frameleaf:library:v1:${encodeURIComponent(userId)}`;

/**
 * What survives a reload. Layout is device-local so it is stored rather than put in the URL.
 * Selection is deliberately absent: it is never persisted across reloads.
 */
export type StoredLibrarySession = {
  version: 1;
  layout: LibraryLayout;
  state: LibraryViewState;
  openAssetId?: string;
  playbackPosition?: number;
};

export const toStoredLibrarySession = (session: LibrarySession): StoredLibrarySession => ({
  version: 1,
  layout: session.layout,
  state: structuredClone(session.state),
  ...(session.openAssetId && { openAssetId: session.openAssetId }),
  ...(session.playbackPosition > 0 && { playbackPosition: session.playbackPosition }),
});

/**
 * Restore a session. `incoming` is the portable state from the URL and wins over the stored view,
 * so a shared link opens what it describes. Selection always comes back empty.
 */
export const fromStoredLibrarySession = (raw: unknown, incoming: LibraryViewState | null = null): LibrarySession => {
  const session = createLibrarySession();
  let stored: unknown = raw;
  if (typeof raw === 'string') {
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = null;
    }
  }
  const value = object(stored) ? stored : {};
  session.layout = oneOf(value.layout, LIBRARY_LAYOUTS) ? (value.layout as LibraryLayout) : DEFAULT_LIBRARY_LAYOUT;
  const state = incoming ?? readLibraryViewValue(value.state);
  if (state) {
    session.state = structuredClone(state);
  }
  if (typeof value.openAssetId === 'string' && value.openAssetId.length <= 128) {
    session.openAssetId = value.openAssetId;
  }
  if (typeof value.playbackPosition === 'number' && Number.isFinite(value.playbackPosition)) {
    session.playbackPosition = Math.max(0, value.playbackPosition);
  }
  // Selection, anchor, snapshot, draft and paging are session-local and start clean.
  session.selection = [];
  session.anchorId = null;
  session.page = 1;
  return session;
};
