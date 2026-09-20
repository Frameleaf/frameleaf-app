import { emptyDiscoveryQuery, type DiscoveryQuery } from './query';

export type LibraryLayout = 'timeline' | 'browse' | 'work';
export type LibraryView = 'grid' | 'list' | 'detail' | 'compare' | 'map' | 'moments';
export type LibrarySort = 'captured-desc' | 'captured-asc' | 'imported-desc' | 'modified-desc' | 'filename' | 'rating';
export type LibraryScope = { kind: 'library' | 'album' | 'space'; id?: string };
export type LibraryViewState = {
  version: 1;
  scope: LibraryScope;
  query: DiscoveryQuery;
  sort: LibrarySort;
  grouping: 'all' | 'days' | 'months' | 'years';
  view: LibraryView;
};
export type LibrarySession = {
  layout: LibraryLayout;
  state: LibraryViewState;
  selection: string[];
  selectionSnapshot?: LibraryViewState;
  scrollAnchor?: string;
  openAssetId?: string;
  playbackPosition: number;
  draft: { assetId: string; recipe: unknown[]; undo: unknown[][]; redo: unknown[][] } | null;
};
export type LibrarySessionAction =
  | { type: 'layout'; layout: LibraryLayout }
  | { type: 'view'; patch: Partial<Omit<LibraryViewState, 'version'>> }
  | { type: 'selection'; ids: string[]; allMatching?: boolean }
  | { type: 'anchor'; id: string }
  | { type: 'open'; id: string; time?: number }
  | { type: 'playback'; time: number }
  | { type: 'draft'; draft: LibrarySession['draft'] };

export const createLibrarySession = (): LibrarySession => ({
  layout: 'work',
  state: {
    version: 1,
    scope: { kind: 'library' },
    query: emptyDiscoveryQuery(),
    sort: 'captured-desc',
    grouping: 'all',
    view: 'grid',
  },
  selection: [],
  playbackPosition: 0,
  draft: null,
});

/** Presentation switches never rebuild the collection, selection, or editor. */
export const reduceLibrarySession = (session: LibrarySession, action: LibrarySessionAction): LibrarySession => {
  switch (action.type) {
    case 'layout': {
      return { ...session, layout: action.layout };
    }
    case 'view': {
      return { ...session, state: { ...session.state, ...action.patch } };
    }
    case 'selection': {
      return {
        ...session,
        selection: [...new Set(action.ids)],
        selectionSnapshot: action.allMatching ? structuredClone(session.state) : undefined,
      };
    }
    case 'anchor': {
      return { ...session, scrollAnchor: action.id };
    }
    case 'open': {
      return {
        ...session,
        openAssetId: action.id,
        playbackPosition: Number.isFinite(action.time) ? Math.max(0, action.time!) : 0,
      };
    }
    case 'playback': {
      return Number.isFinite(action.time) ? { ...session, playbackPosition: Math.max(0, action.time) } : session;
    }
    case 'draft': {
      return { ...session, draft: action.draft };
    }
  }
};

const oneOf = (value: unknown, choices: readonly string[]): value is string =>
  typeof value === 'string' && choices.includes(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const stringValue = (value: unknown) => typeof value === 'string' && value.length <= 4096;
const numberValue = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const booleanFields = new Set([
  'isFavorite',
  'isMotion',
  'isOffline',
  'isEncoded',
  'hasAlbums',
  'hasPeople',
  'hasTags',
  'favorite',
]);
const numberFields = new Set(['rating', 'fileSizeInBytes']);
const listFields = new Set(['personIds', 'tagIds', 'albumIds']);
const stringFields = new Set([
  'id',
  'libraryId',
  'type',
  'visibility',
  'city',
  'state',
  'country',
  'make',
  'model',
  'lensModel',
  'description',
  'originalFileName',
  'originalPath',
  'ocr',
  'takenAt',
  'createdAt',
  'updatedAt',
  'trashedAt',
  'checksum',
  'encodedVideoPath',
  'person',
]);
const scalarOperators = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'like',
  'notLike',
  'startsWith',
  'endsWith',
  'matches',
]);
const listOperators = new Set(['in', 'notIn', 'any', 'all', 'none']);

/** Bounded structural validation; the authenticated search API still validates field semantics. */
export const isLibraryFilter = (value: unknown, branch = false): boolean => {
  if (!object(value) || Object.keys(value).length > 64) {
    return false;
  }
  return Object.entries(value).every(([field, condition]) => {
    if (field === 'or') {
      return (
        !branch &&
        Array.isArray(condition) &&
        condition.length > 0 &&
        condition.length <= 64 &&
        condition.every((item) => object(item) && Object.keys(item).length > 0 && isLibraryFilter(item, true))
      );
    }
    if (!object(condition) || Object.keys(condition).length === 0 || Object.keys(condition).length > 12) {
      return false;
    }
    if (booleanFields.has(field)) {
      return Object.keys(condition).length === 1 && typeof condition.eq === 'boolean';
    }
    const itemValid = numberFields.has(field)
      ? numberValue
      : stringFields.has(field) || listFields.has(field)
        ? stringValue
        : null;
    if (!itemValid) {
      return false;
    }
    return Object.entries(condition).every(([operator, item]) => {
      if (listOperators.has(operator)) {
        return Array.isArray(item) && item.length > 0 && item.length <= 1000 && item.every((value) => itemValid(value));
      }
      if (listFields.has(field) || !scalarOperators.has(operator)) {
        return false;
      }
      return ((operator === 'eq' || operator === 'ne') && item === null) || itemValid(item);
    });
  });
};

/** Parse only view state. URLs cannot inject local selections, leases or edit history. */
export const readLibraryView = (url: URL): LibraryViewState | null => {
  const raw = url.searchParams.get('fl');
  if (!raw || raw.length > 32_768) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || !object(value.scope) || !object(value.query)) {
      return null;
    }
    if (!oneOf(value.scope.kind, ['library', 'album', 'space'])) {
      return null;
    }
    if (
      value.scope.kind !== 'library' &&
      (typeof value.scope.id !== 'string' || !value.scope.id || value.scope.id.length > 128)
    ) {
      return null;
    }
    if (
      !oneOf(value.sort, ['captured-desc', 'captured-asc', 'imported-desc', 'modified-desc', 'filename', 'rating']) ||
      !oneOf(value.grouping, ['all', 'days', 'months', 'years']) ||
      !oneOf(value.view, ['grid', 'list', 'detail', 'compare', 'map', 'moments'])
    ) {
      return null;
    }
    const q = value.query;
    const filter = object(q.filter) ? structuredClone(q.filter) : q.filter;
    // Earlier prototype URLs stored the rating select's DOM string value.
    if (
      object(filter) &&
      object(filter.rating) &&
      typeof filter.rating.eq === 'string' &&
      /^[1-5]$/.test(filter.rating.eq)
    ) {
      filter.rating.eq = Number(filter.rating.eq);
    }
    if (
      q.version !== 1 ||
      typeof q.text !== 'string' ||
      q.text.length > 4096 ||
      !isLibraryFilter(filter) ||
      !oneOf(q.mode, ['text', 'smart']) ||
      !oneOf(q.grouping, ['all', 'months', 'years']) ||
      !oneOf(q.view, ['photos', 'map', 'moments'])
    ) {
      return null;
    }
    if (q.spaceId !== undefined && typeof q.spaceId !== 'string') {
      return null;
    }
    if (q.petIds !== undefined && (!Array.isArray(q.petIds) || q.petIds.some((id) => typeof id !== 'string'))) {
      return null;
    }
    return {
      version: 1,
      scope: { kind: value.scope.kind, ...(value.scope.kind !== 'library' && { id: value.scope.id }) },
      query: {
        version: 1,
        text: q.text,
        mode: q.mode,
        filter,
        grouping: q.grouping,
        view: q.view,
        ...(q.spaceId && { spaceId: q.spaceId }),
        ...(q.petIds && { petIds: q.petIds }),
      },
      sort: value.sort,
      grouping: value.grouping,
      view: value.view,
    } as LibraryViewState;
  } catch {
    return null;
  }
};

/** Reuse URL validation for stored presets without accepting their arbitrary object shape. */
export const readLibraryViewValue = (value: unknown): LibraryViewState | null => {
  try {
    const url = new URL('http://localhost/');
    url.searchParams.set('fl', JSON.stringify(value));
    return readLibraryView(url);
  } catch {
    return null;
  }
};

export const writeLibraryView = (url: URL, state: LibraryViewState): URL => {
  const next = new URL(url);
  next.searchParams.set('fl', JSON.stringify(state));
  return next;
};

/** Callers must use the authenticated user ID; never reuse another user's session. */
export const libraryPreferenceKey = (userId: string) => `frameleaf:library:v1:${encodeURIComponent(userId)}`;
