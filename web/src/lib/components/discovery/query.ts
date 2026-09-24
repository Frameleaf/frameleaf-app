import {
  AssetTypeEnum,
  AssetVisibility,
  ImageEnrichmentFilter,
  type MetadataSearchDto,
  type SearchFilter,
  type SmartSearchDto,
} from '@immich/sdk';

/**
 * The one library query every Frameleaf view shares. It is portable: it travels in a URL, it is
 * stored in presets and it is handed to the search API unchanged. Layout is deliberately absent —
 * layout is device-local and lives on the session, not on the query.
 *
 * Ported from the approved prototype (`design/frameleaf/template/src/reference/query.ts`,
 * `search.mjs`) for FL-31. The September 22, 2026 interaction revision adds the single Filter
 * control model (active-filter badge and filter-panel deep links) and the cumulative paging
 * summary; both are expressed here as pure functions over a query.
 *
 * FL-48 makes the query a versioned round-trip contract: one reader (`parseDiscoveryQuery`) is used
 * for URLs, the library session and stored presets alike, every legacy search request is migrated
 * field by field or explicitly refused (`migrateLegacySearch`), and the search context a query was
 * opened in — the similar-photo reference, the text field, the shared space, the view and grouping —
 * survives every hop between the URL, the session, the search dialog, the chips and the server DTO.
 */
export type DiscoveryMode = 'text' | 'smart';
export type DiscoveryGrouping = 'all' | 'months' | 'years';
export type DiscoveryView = 'photos' | 'map' | 'moments';

/**
 * The search field a `text`-mode query searches (FL-48). Each is a real search field: a flat
 * `MetadataSearchDto` text field and, inside a structured filter, the `SearchFilter` condition of the
 * same name. Smart mode searches `query` instead and ignores this.
 */
export type DiscoveryTextField = 'originalFileName' | 'description' | 'ocr' | 'originalPath';

export type DiscoveryQuery = {
  version: 1;
  text: string;
  mode: DiscoveryMode;
  filter: SearchFilter;
  grouping: DiscoveryGrouping;
  view: DiscoveryView;
  spaceId?: string;
  /**
   * Image-enrichment facet (FL-49). It is a search *DTO* field rather than a `SearchFilter`
   * condition — the server exposes enrichment state as the single `imageEnrichment` enum on
   * `MetadataSearchDto`/`SmartSearchDto`, not as a filterable column — so it rides beside the
   * filter here and is copied straight onto the DTO in `toSearchDto`. The prototype's
   * `descriptionStatus`/`sensitiveStatus` fields have no production column and are deliberately
   * not invented; every value below exists in `ImageEnrichmentFilter`.
   */
  imageEnrichment?: ImageEnrichmentFilter;
  /** The field a `text`-mode query searches (FL-48). Absent means the file name. */
  textField?: DiscoveryTextField;
  /**
   * The photo a "view similar photos" search compares against (FL-48). It is search context, not a
   * filter: it is kept when the text or the layout changes and is sent as `queryAssetId`.
   */
  queryAssetId?: string;
};

/**
 * The contract version. Optional fields are additive and keep version 1; a reader that meets a
 * higher version refuses it as `unsupported-version` instead of guessing, so a link written by a
 * newer client is never silently rewritten into a narrower one.
 */
export const DISCOVERY_QUERY_VERSION = 1;
/** The URL parameter that carries a serialized query. */
export const DISCOVERY_QUERY_PARAMETER = 'dq';

export const DISCOVERY_MODES: readonly DiscoveryMode[] = ['text', 'smart'];
export const DISCOVERY_GROUPINGS: readonly DiscoveryGrouping[] = ['all', 'months', 'years'];
export const DISCOVERY_VIEWS: readonly DiscoveryView[] = ['photos', 'map', 'moments'];
export const DISCOVERY_TEXT_FIELDS: readonly DiscoveryTextField[] = [
  'originalFileName',
  'description',
  'ocr',
  'originalPath',
];
export const DEFAULT_DISCOVERY_TEXT_FIELD: DiscoveryTextField = 'originalFileName';

/** The field a `text`-mode query searches. */
export const discoveryTextField = (query: Pick<DiscoveryQuery, 'textField'>): DiscoveryTextField =>
  query.textField && DISCOVERY_TEXT_FIELDS.includes(query.textField) ? query.textField : DEFAULT_DISCOVERY_TEXT_FIELD;

export const emptyDiscoveryQuery = (): DiscoveryQuery => ({
  version: 1,
  text: '',
  mode: 'text',
  filter: {},
  grouping: 'all',
  view: 'photos',
});

/* -------------------------------------------------------------------------- */
/* Validation: the search DTO is the authority                                 */
/* -------------------------------------------------------------------------- */

const MAX_TEXT_LENGTH = 4096;
const MAX_STRING_LENGTH = 4096;
const MAX_ID_LENGTH = 128;
const MAX_LIST_LENGTH = 1000;
const MAX_FILTER_FIELDS = 64;
const MAX_CONDITION_OPERATORS = 12;
const MAX_OR_BRANCHES = 64;
/** The longest serialized query a URL parameter or a stored preset may carry. */
export const MAX_DISCOVERY_QUERY_LENGTH = 32_768;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const oneOf = <T extends string>(value: unknown, choices: readonly T[]): value is T =>
  typeof value === 'string' && (choices as readonly string[]).includes(value);

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** A real UTC calendar day written `YYYY-MM-DD`; `2026-02-30` is refused, not rolled over. */
export const isCalendarDay = (value: unknown): value is string => {
  if (typeof value !== 'string' || !CALENDAR_DAY.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

/** An ISO 8601 datetime with an offset, the form the search DTO's date operands take. */
export const isIsoDatetime = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 64 &&
  ISO_DATETIME.test(value) &&
  isCalendarDay(value.slice(0, 10)) &&
  Number.isFinite(Date.parse(value));

type Check = (value: unknown) => boolean;

const anyString: Check = (value) => typeof value === 'string' && value.length <= MAX_STRING_LENGTH;
const nonEmptyString: Check = (value) => anyString(value) && (value as string).length > 0;
const idValue: Check = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
const finite: Check = (value) => typeof value === 'number' && Number.isFinite(value);
const dateBound: Check = (value) => isCalendarDay(value) || isIsoDatetime(value);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const list =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.length > 0 && value.length <= MAX_LIST_LENGTH && value.every((item) => check(item));
const enumOf =
  (values: readonly string[]): Check =>
  (value) =>
    typeof value === 'string' && values.includes(value);

const ASSET_TYPES: readonly string[] = Object.values(AssetTypeEnum);
const VISIBILITIES: readonly string[] = Object.values(AssetVisibility);
const ENRICHMENT_VALUES: readonly string[] = Object.values(ImageEnrichmentFilter);

const enumOperators = (values: readonly string[]) => ({
  eq: enumOf(values),
  ne: enumOf(values),
  in: list(enumOf(values)),
  notIn: list(enumOf(values)),
});
const stringNullableOperators = {
  eq: nullable(anyString),
  ne: nullable(anyString),
  in: list(anyString),
  notIn: list(anyString),
};
const numberRangeOperators = {
  lt: finite,
  lte: finite,
  gt: finite,
  gte: finite,
  in: list(finite),
  notIn: list(finite),
};
// A calendar day is a range, so it is accepted wherever a range can express it. `ne` of a whole day
// would need an `or`, so `ne` takes an exact datetime only.
const dateRangeOperators = { gt: dateBound, gte: dateBound, lt: dateBound, lte: dateBound };

/**
 * The operators each `SearchFilter` field accepts and what their operands must be — the mirror of
 * `searchFilterBranchShape` in `server/src/dtos/search.dto.ts`. A condition the server would refuse is
 * refused here, where it can fail safely, instead of reaching the API and failing the page.
 */
const FIELD_OPERATORS: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
  id: { eq: idValue, ne: idValue },
  libraryId: { eq: nullable(idValue), ne: nullable(idValue) },
  type: enumOperators(ASSET_TYPES),
  visibility: enumOperators(VISIBILITIES),
  isFavorite: { eq: (value) => typeof value === 'boolean' },
  isMotion: { eq: (value) => typeof value === 'boolean' },
  isOffline: { eq: (value) => typeof value === 'boolean' },
  isEncoded: { eq: (value) => typeof value === 'boolean' },
  hasAlbums: { eq: (value) => typeof value === 'boolean' },
  hasPeople: { eq: (value) => typeof value === 'boolean' },
  hasTags: { eq: (value) => typeof value === 'boolean' },
  city: stringNullableOperators,
  state: stringNullableOperators,
  country: stringNullableOperators,
  ...Object.fromEntries(
    // FL-49: cameras and lenses take the pattern operators too, for camera: and lens: "contains"
    ['description', 'originalFileName', 'originalPath', 'make', 'model', 'lensModel'].map((field) => [
      field,
      {
        ...stringNullableOperators,
        like: nonEmptyString,
        notLike: nonEmptyString,
        startsWith: nonEmptyString,
        endsWith: nonEmptyString,
      },
    ]),
  ),
  ocr: { matches: nonEmptyString },
  rating: { eq: nullable(finite), ne: nullable(finite), ...numberRangeOperators },
  fileSizeInBytes: { eq: finite, ne: finite, ...numberRangeOperators },
  takenAt: { eq: dateBound, ne: isIsoDatetime, ...dateRangeOperators },
  localDateTime: { eq: dateBound, ne: isIsoDatetime, ...dateRangeOperators },
  createdAt: { eq: dateBound, ne: isIsoDatetime, ...dateRangeOperators },
  updatedAt: { eq: dateBound, ne: isIsoDatetime, ...dateRangeOperators },
  trashedAt: { eq: nullable(dateBound), ne: nullable(isIsoDatetime), ...dateRangeOperators },
  personIds: { any: list(idValue), all: list(idValue), none: list(idValue) },
  petIds: { any: list(idValue), all: list(idValue), none: list(idValue) },
  tagIds: { any: list(idValue), all: list(idValue), none: list(idValue) },
  albumIds: { any: list(idValue), all: list(idValue), none: list(idValue) },
  checksum: { eq: anyString, ne: anyString, in: list(anyString), notIn: list(anyString) },
  encodedVideoPath: { eq: anyString, ne: anyString, in: list(anyString), notIn: list(anyString) },
};

/** Fields holding a boolean condition, which is exactly `{ eq: boolean }`. */
const BOOLEAN_FIELDS = new Set([
  'isFavorite',
  'isMotion',
  'isOffline',
  'isEncoded',
  'hasAlbums',
  'hasPeople',
  'hasTags',
]);

/**
 * Bounded structural validation of a filter against the search DTO. A top-level filter may be empty;
 * an `or` branch may not, and branches do not nest. The authenticated search API still validates and
 * access-checks everything again: passing here never widens what a request may see.
 */
export const isDiscoveryFilter = (value: unknown, branch = false): value is SearchFilter => {
  if (!isRecord(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_FILTER_FIELDS || (branch && entries.length === 0)) {
    return false;
  }
  return entries.every(([field, condition]) => {
    if (field === 'or') {
      return (
        !branch &&
        Array.isArray(condition) &&
        condition.length > 0 &&
        condition.length <= MAX_OR_BRANCHES &&
        condition.every((item) => isDiscoveryFilter(item, true))
      );
    }
    const operators = Object.hasOwn(FIELD_OPERATORS, field) ? FIELD_OPERATORS[field] : undefined;
    if (!operators || !isRecord(condition)) {
      return false;
    }
    const pairs = Object.entries(condition);
    if (pairs.length === 0 || pairs.length > MAX_CONDITION_OPERATORS) {
      return false;
    }
    if (BOOLEAN_FIELDS.has(field) && pairs.length !== 1) {
      return false;
    }
    return pairs.every(([operator, operand]) => Object.hasOwn(operators, operator) && operators[operator](operand));
  });
};

const TYPE_WORDS: Readonly<Record<string, AssetTypeEnum>> = {
  photo: AssetTypeEnum.Image,
  photos: AssetTypeEnum.Image,
  image: AssetTypeEnum.Image,
  images: AssetTypeEnum.Image,
  video: AssetTypeEnum.Video,
  videos: AssetTypeEnum.Video,
};
const typeWord = (value: unknown) => (typeof value === 'string' ? (TYPE_WORDS[value.toLowerCase()] ?? value) : value);
const ID_LIST_FIELDS = ['personIds', 'petIds', 'tagIds', 'albumIds'] as const;

/**
 * Earlier prototype and fork links wrote a few conditions under other names or shapes. Each is
 * rewritten to the server field it always meant, so an old link keeps its meaning rather than
 * failing validation or losing the condition. A port of `normalizeFilter` in the prototype's
 * `search.mjs`; the input is never mutated.
 */
export const normalizeDiscoveryFilter = (input: unknown, depth = 0): unknown => {
  if (!isRecord(input)) {
    return input;
  }
  const result: Record<string, unknown> = structuredClone(input);
  if (result.person !== undefined && result.personIds === undefined) {
    result.personIds =
      isRecord(result.person) && typeof result.person.eq === 'string' ? { any: [result.person.eq] } : result.person;
  }
  if (result.favorite !== undefined && result.isFavorite === undefined) {
    result.isFavorite = result.favorite;
  }
  if (result.isArchived !== undefined && result.visibility === undefined) {
    const archived = isRecord(result.isArchived) ? result.isArchived.eq : result.isArchived;
    result.visibility =
      typeof archived === 'boolean' ? { [archived ? 'eq' : 'ne']: AssetVisibility.Archive } : result.isArchived;
  }
  if (result.isNotInAlbum !== undefined && result.hasAlbums === undefined) {
    const notInAlbum = isRecord(result.isNotInAlbum) ? result.isNotInAlbum.eq : result.isNotInAlbum;
    result.hasAlbums = typeof notInAlbum === 'boolean' ? { eq: !notInAlbum } : result.isNotInAlbum;
  }
  for (const alias of ['person', 'favorite', 'isArchived', 'isNotInAlbum']) {
    delete result[alias];
  }
  if (isRecord(result.type)) {
    result.type = Object.fromEntries(
      Object.entries(result.type).map(([operator, value]) => [
        operator,
        Array.isArray(value) ? value.map((item) => typeWord(item)) : typeWord(value),
      ]),
    );
  }
  // The prototype's earlier minimum-rating select stored its DOM string in `eq`; it meant "at least".
  // A numeric `eq` is an exact rating and is left alone.
  if (isRecord(result.rating) && typeof result.rating.eq === 'string' && /^[0-5]$/.test(result.rating.eq)) {
    const { eq, ...rest } = result.rating;
    result.rating = { ...rest, gte: Number(eq) };
  }
  for (const field of ID_LIST_FIELDS) {
    const value = result[field];
    if (Array.isArray(value)) {
      result[field] = { all: [...new Set(value)] };
    }
  }
  if (Array.isArray(result.or) && depth === 0) {
    result.or = result.or.map((branch) => normalizeDiscoveryFilter(branch, depth + 1));
  }
  return result;
};

/* -------------------------------------------------------------------------- */
/* Reading and writing the query                                               */
/* -------------------------------------------------------------------------- */

/**
 * Why a serialized query was refused. `unsupported-version` is a query from a newer contract: the
 * caller must not rewrite it into this version's shape, which would silently drop what it cannot read.
 */
export type DiscoveryQueryProblem = 'malformed' | 'invalid' | 'unsupported-version';

export type DiscoveryQueryParse = { ok: true; query: DiscoveryQuery } | { ok: false; problem: DiscoveryQueryProblem };

const refuse = (problem: DiscoveryQueryProblem): DiscoveryQueryParse => ({ ok: false, problem });

const absent = (value: unknown) => value === undefined || value === null;

/**
 * The single reader for a portable query — from a URL, from the library session's URL state and from
 * stored presets. Missing presentation fields take their defaults; anything present must be valid.
 * The result is a fresh object: nothing is shared with the input.
 */
export const parseDiscoveryQuery = (value: unknown): DiscoveryQueryParse => {
  if (!isRecord(value)) {
    return refuse('malformed');
  }
  if (value.version !== DISCOVERY_QUERY_VERSION) {
    const newer =
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version > DISCOVERY_QUERY_VERSION;
    return refuse(newer ? 'unsupported-version' : 'malformed');
  }
  const text = value.text ?? '';
  const mode = value.mode ?? 'text';
  const grouping = value.grouping ?? 'all';
  const view = value.view ?? 'photos';
  if (
    typeof text !== 'string' ||
    text.length > MAX_TEXT_LENGTH ||
    !oneOf(mode, DISCOVERY_MODES) ||
    !oneOf(grouping, DISCOVERY_GROUPINGS) ||
    !oneOf(view, DISCOVERY_VIEWS)
  ) {
    return refuse('invalid');
  }

  const filter = normalizeDiscoveryFilter(value.filter ?? {});
  // FL-58: earlier links carried pets beside the filter as a top-level `petIds` list the search API
  // never read. Pets are an ordinary `filter.petIds` condition, so such a list is folded into it (as
  // `any`, which is what the prototype meant) unless the filter already says something about pets.
  if (value.petIds !== undefined) {
    if (!Array.isArray(value.petIds) || value.petIds.some((id) => typeof id !== 'string')) {
      return refuse('invalid');
    }
    if (value.petIds.length > 0 && isRecord(filter) && filter.petIds === undefined) {
      filter.petIds = { any: [...new Set(value.petIds as string[])] };
    }
  }
  if (!isDiscoveryFilter(filter)) {
    return refuse('invalid');
  }

  const query: DiscoveryQuery = { version: 1, text, mode, filter, grouping, view };
  if (!absent(value.spaceId) && value.spaceId !== '') {
    if (!idValue(value.spaceId)) {
      return refuse('invalid');
    }
    query.spaceId = value.spaceId as string;
  }
  // FL-49: the enrichment facet is a closed server enum, so an unknown value is refused rather than
  // forwarded to the API.
  if (!absent(value.imageEnrichment)) {
    if (!oneOf(value.imageEnrichment, ENRICHMENT_VALUES)) {
      return refuse('invalid');
    }
    query.imageEnrichment = value.imageEnrichment as ImageEnrichmentFilter;
  }
  if (!absent(value.textField)) {
    if (!oneOf(value.textField, DISCOVERY_TEXT_FIELDS)) {
      return refuse('invalid');
    }
    query.textField = value.textField as DiscoveryTextField;
  }
  if (!absent(value.queryAssetId)) {
    if (!idValue(value.queryAssetId)) {
      return refuse('invalid');
    }
    query.queryAssetId = value.queryAssetId as string;
  }
  return { ok: true, query };
};

/** Parse a serialized query, bounded in length. */
export const parseDiscoveryQueryText = (raw: string): DiscoveryQueryParse => {
  if (raw.length > MAX_DISCOVERY_QUERY_LENGTH) {
    return refuse('malformed');
  }
  try {
    return parseDiscoveryQuery(JSON.parse(raw));
  } catch {
    return refuse('malformed');
  }
};

/** The query a URL carries, or the empty query when it carries none or an unusable one. */
export const readDiscoveryQuery = (url: URL): DiscoveryQuery => {
  const raw = url.searchParams.get(DISCOVERY_QUERY_PARAMETER);
  if (!raw) {
    return emptyDiscoveryQuery();
  }
  const result = parseDiscoveryQueryText(raw);
  return result.ok ? result.query : emptyDiscoveryQuery();
};

/** The search results page for a query. The whole query travels, so nothing is lost on the way. */
export const discoveryUrl = (query: DiscoveryQuery) =>
  `/search?${new URLSearchParams({ [DISCOVERY_QUERY_PARAMETER]: JSON.stringify(query) })}`;

/* -------------------------------------------------------------------------- */
/* Legacy search requests                                                      */
/* -------------------------------------------------------------------------- */

export type LegacySearchMigration = {
  query: DiscoveryQuery;
  /**
   * Keys of the legacy request the query cannot carry. A non-empty list means the migration is
   * refused: the caller keeps using the legacy request itself rather than a narrower query.
   */
  unsupported: string[];
};

const LEGACY_EQUALITY_FIELDS = ['city', 'state', 'country', 'make', 'model', 'lensModel'] as const;
const LEGACY_FLAG_FIELDS = ['isFavorite', 'isMotion', 'isOffline', 'isEncoded'] as const;
const LEGACY_DATE_FIELDS: Readonly<Record<string, readonly [keyof SearchFilter, 'gte' | 'lte']>> = {
  takenAfter: ['takenAt', 'gte'],
  takenBefore: ['takenAt', 'lte'],
  createdAfter: ['createdAt', 'gte'],
  createdBefore: ['createdAt', 'lte'],
  updatedAfter: ['updatedAt', 'gte'],
  updatedBefore: ['updatedAt', 'lte'],
  trashedAfter: ['trashedAt', 'gte'],
  trashedBefore: ['trashedAt', 'lte'],
};
/** Keys that page or present a request rather than decide what it matches. */
const LEGACY_PRESENTATION_KEYS = new Set([
  'page',
  'size',
  'withExif',
  'withStacked',
  'withPeople',
  'language',
  'order',
  'orderBy',
  'cursor',
]);
const LEGACY_KNOWN_KEYS = new Set([
  'filter',
  'query',
  'queryAssetId',
  ...DISCOVERY_TEXT_FIELDS,
  ...LEGACY_EQUALITY_FIELDS,
  ...LEGACY_FLAG_FIELDS,
  ...ID_LIST_FIELDS,
  ...Object.keys(LEGACY_DATE_FIELDS),
  'type',
  'visibility',
  'rating',
  'isNotInAlbum',
  'id',
  'libraryId',
  'checksum',
  'encodedVideoPath',
  'imageEnrichment',
  'withDeleted',
  'suppressedOnly',
]);

/** The condition a text field's search becomes inside a structured filter; both mean "contains". */
export const textFieldCondition = (field: DiscoveryTextField, text: string) =>
  field === 'ocr' ? { matches: text } : { like: text };

/**
 * Migrate a legacy flat search request (a `/search?query=` URL, a Places card, an explore link) to the
 * shared query, field by field and with the flat semantics the server applies to it: id lists match
 * all of their ids, capture bounds are inclusive, the file-name, description and path fields match
 * text they contain. The free text becomes the query's own text so the search dialog shows it where
 * it was typed; a second text field becomes a condition.
 *
 * Nothing is dropped silently. A field with no structured equivalent — including everything in the
 * trash, suppressed-only content and the preview/thumbnail path — is reported in `unsupported`, and
 * so is a field the filter already constrains, since a structured request cannot carry both.
 */
export const migrateLegacySearch = (input: unknown): LegacySearchMigration => {
  const query = emptyDiscoveryQuery();
  if (!isRecord(input)) {
    return { query, unsupported: ['query'] };
  }
  const unsupported: string[] = [];
  const filter: Record<string, unknown> = {};

  if (input.filter !== undefined) {
    const normalized = normalizeDiscoveryFilter(input.filter);
    if (isDiscoveryFilter(normalized)) {
      Object.assign(filter, normalized);
    } else {
      unsupported.push('filter');
    }
  }
  const put = (key: string, field: string, condition: Record<string, unknown>) => {
    if (filter[field] === undefined) {
      filter[field] = condition;
    } else {
      unsupported.push(key);
    }
  };

  // Free text: the smart query first, then the similar-photo reference, then the first text field.
  if (input.query !== undefined) {
    if (typeof input.query === 'string') {
      const text = input.query.trim();
      if (text) {
        query.text = text;
        query.mode = 'smart';
      }
    } else {
      unsupported.push('query');
    }
  }
  if (input.queryAssetId !== undefined) {
    if (idValue(input.queryAssetId)) {
      query.queryAssetId = input.queryAssetId as string;
      query.mode = 'smart';
    } else {
      unsupported.push('queryAssetId');
    }
  }
  for (const field of DISCOVERY_TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (!anyString(value)) {
      unsupported.push(field);
      continue;
    }
    // The server trims the file-name and description terms; the others are used as written.
    const text = field === 'originalFileName' || field === 'description' ? (value as string).trim() : (value as string);
    if (!text) {
      continue;
    }
    if (query.mode === 'text' && !query.text) {
      query.text = text;
      query.textField = field;
    } else {
      put(field, field, textFieldCondition(field, text));
    }
  }

  for (const field of LEGACY_EQUALITY_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (value === null || anyString(value)) {
      put(field, field, { eq: value });
    } else {
      unsupported.push(field);
    }
  }
  for (const [field, values] of [
    ['type', ASSET_TYPES],
    ['visibility', VISIBILITIES],
  ] as const) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (oneOf(value, values)) {
      put(field, field, { eq: value });
    } else {
      unsupported.push(field);
    }
  }
  for (const field of LEGACY_FLAG_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'boolean') {
      put(field, field, { eq: value });
    } else {
      unsupported.push(field);
    }
  }
  if (input.rating !== undefined) {
    if (input.rating === null || finite(input.rating)) {
      put('rating', 'rating', { eq: input.rating });
    } else {
      unsupported.push('rating');
    }
  }

  const flatAlbumIds = Array.isArray(input.albumIds) && input.albumIds.length > 0;
  for (const field of ID_LIST_FIELDS) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (field === 'tagIds' && value === null) {
      put('tagIds', 'hasTags', { eq: false });
    } else if (Array.isArray(value) && value.every((id) => idValue(id))) {
      if (value.length > 0) {
        put(field, field, { all: [...new Set(value as string[])] });
      }
    } else {
      unsupported.push(field);
    }
  }
  if (input.isNotInAlbum !== undefined) {
    if (typeof input.isNotInAlbum !== 'boolean') {
      unsupported.push('isNotInAlbum');
    } else if (input.isNotInAlbum && !flatAlbumIds) {
      // The flat search ignores "not in any album" next to an album list, and so does the migration.
      put('isNotInAlbum', 'hasAlbums', { eq: false });
    }
  }

  const bounds: Record<string, Record<string, unknown>> = {};
  const boundKeys: Record<string, string[]> = {};
  for (const [key, [field, operator]] of Object.entries(LEGACY_DATE_FIELDS)) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (!dateBound(value)) {
      unsupported.push(key);
      continue;
    }
    bounds[field] = { ...bounds[field], [operator]: value };
    boundKeys[field] = [...(boundKeys[field] ?? []), key];
  }
  for (const [field, condition] of Object.entries(bounds)) {
    if (filter[field] === undefined) {
      filter[field] = condition;
    } else {
      unsupported.push(...boundKeys[field]);
    }
  }

  if (input.id !== undefined) {
    if (idValue(input.id)) {
      put('id', 'id', { eq: input.id });
    } else {
      unsupported.push('id');
    }
  }
  if (input.libraryId !== undefined) {
    if (input.libraryId === null || idValue(input.libraryId)) {
      put('libraryId', 'libraryId', { eq: input.libraryId });
    } else {
      unsupported.push('libraryId');
    }
  }
  for (const field of ['checksum', 'encodedVideoPath'] as const) {
    const value = input[field];
    if (value === undefined) {
      continue;
    }
    if (nonEmptyString(value)) {
      put(field, field, { eq: value });
    } else {
      unsupported.push(field);
    }
  }
  if (input.imageEnrichment !== undefined) {
    if (oneOf(input.imageEnrichment, ENRICHMENT_VALUES)) {
      query.imageEnrichment = input.imageEnrichment as ImageEnrichmentFilter;
    } else {
      unsupported.push('imageEnrichment');
    }
  }

  // A flat search includes the trash when asked to, or when it looks at trash dates or offline files.
  // A structured search leaves the trash out unless its filter says otherwise, and has no way to say
  // "trashed or not", so such a request is refused rather than quietly narrowed.
  const trashBounds = input.trashedAfter !== undefined || input.trashedBefore !== undefined;
  if (input.withDeleted !== undefined && input.withDeleted !== false && !trashBounds) {
    unsupported.push('withDeleted');
  }
  if (input.isOffline === true && !trashBounds) {
    unsupported.push('isOffline');
  }
  // Suppressed-only content needs an elevated session; the query never carries it, so a request
  // for it stays a request the server authorizes on its own terms.
  if (input.suppressedOnly !== undefined && input.suppressedOnly !== false) {
    unsupported.push('suppressedOnly');
  }
  for (const key of Object.keys(input)) {
    if (!LEGACY_KNOWN_KEYS.has(key) && !LEGACY_PRESENTATION_KEYS.has(key)) {
      unsupported.push(key);
    }
  }

  if (isDiscoveryFilter(filter)) {
    query.filter = filter as SearchFilter;
  } else {
    unsupported.push('filter');
  }
  return { query, unsupported: [...new Set(unsupported)] };
};

/** The migrated query alone. Callers that must not lose fields read `migrateLegacySearch` instead. */
export const fromLegacySearch = (dto: unknown): DiscoveryQuery => migrateLegacySearch(dto).query;

/* -------------------------------------------------------------------------- */
/* The search a page was opened on                                             */
/* -------------------------------------------------------------------------- */

/** The `/search` page's own legacy parameter (`QueryParameter.QUERY`). */
const LEGACY_SEARCH_PARAMETER = 'query';

export type SearchLocation =
  | { kind: 'empty' }
  | { kind: 'discovery'; query: DiscoveryQuery }
  | { kind: 'legacy'; terms: Record<string, unknown>; migration: LegacySearchMigration }
  | { kind: 'rejected'; problem: DiscoveryQueryProblem };

/**
 * What the `/search` page shows. A `dq` query wins; otherwise the legacy flat request is read, kept
 * exactly as it is for the page and migrated for the search dialog. A payload that cannot be parsed
 * is reported, never thrown, so a damaged or newer link fails safely.
 */
export const readSearchLocation = (url: URL): SearchLocation =>
  readSearchParameters(url.searchParams.get(DISCOVERY_QUERY_PARAMETER), url.searchParams.get(LEGACY_SEARCH_PARAMETER));

/**
 * `readSearchLocation` over the two raw parameter values, for a page that derives them separately so
 * that opening an item (a path change) does not look like a new search.
 */
export const readSearchParameters = (raw: string | null, legacy: string | null): SearchLocation => {
  if (raw !== null) {
    const result = parseDiscoveryQueryText(raw);
    return result.ok ? { kind: 'discovery', query: result.query } : { kind: 'rejected', problem: result.problem };
  }
  if (!legacy) {
    return { kind: 'empty' };
  }
  let terms: unknown;
  try {
    terms = JSON.parse(legacy);
  } catch {
    return { kind: 'rejected', problem: 'malformed' };
  }
  if (!isRecord(terms)) {
    return { kind: 'rejected', problem: 'malformed' };
  }
  if (Object.keys(terms).length === 0) {
    return { kind: 'empty' };
  }
  return { kind: 'legacy', terms, migration: migrateLegacySearch(terms) };
};

export type DiscoveryContext = {
  query: DiscoveryQuery;
  /** Legacy fields the query could not carry; the search dialog says so instead of dropping them. */
  unsupported: string[];
};

const UUID = String.raw`[\da-f-]{36}`;
const routeId = (pathname: string, prefix: string) =>
  pathname.match(new RegExp(`^/${prefix}/(${UUID})(?:/|$)`, 'i'))?.[1];

/**
 * The query a search opened on this page starts from: the search it already shows, or the scope the
 * page stands for — an album, a pet, a shared space. Searching again never resets a scope the person
 * did not ask to leave.
 *
 * The map page contributes no scope (FL-48 map/space follow-ups): the prototype (`App.jsx`
 * `exploreQuery`/`MapView`'s "Search this area") always lands a submitted search on the plain grid
 * results, never on a persisted map view, so a search opened from `/map` is treated like any other
 * unscoped page instead of tagging the query `view: 'map'` for a results page that would ignore it.
 */
export const contextDiscoveryState = (url: URL): DiscoveryContext => {
  if (url.pathname === '/discover') {
    return { query: readDiscoveryQuery(url), unsupported: [] };
  }
  if (/^\/search(?:\/|$)/.test(url.pathname)) {
    const location = readSearchLocation(url);
    if (location.kind === 'discovery') {
      return { query: location.query, unsupported: [] };
    }
    if (location.kind === 'legacy') {
      return { query: location.migration.query, unsupported: location.migration.unsupported };
    }
    return { query: emptyDiscoveryQuery(), unsupported: [] };
  }
  const result = emptyDiscoveryQuery();
  const albumId = routeId(url.pathname, 'albums');
  const petId = routeId(url.pathname, 'pets');
  // Shared spaces live under /sharing/{id}; /spaces/{id} is kept for links written before that.
  const spaceId = routeId(url.pathname, 'sharing') ?? routeId(url.pathname, 'spaces');
  if (albumId) {
    result.filter = { albumIds: { any: [albumId] } };
  }
  // FL-58: searching from a pet's page searches that pet's confirmed photos
  if (petId) {
    result.filter = { petIds: { any: [petId] } };
  }
  if (spaceId) {
    result.spaceId = spaceId;
  }
  return { query: result, unsupported: [] };
};

export const contextDiscoveryQuery = (url: URL): DiscoveryQuery => contextDiscoveryState(url).query;

/**
 * True when a query would search for nothing in particular: no text, no filter, no enrichment facet,
 * no similar-photo reference and no space. Submitting one opens the plain search page, as it always has.
 */
export const isEmptyDiscoverySearch = (query: DiscoveryQuery): boolean =>
  !query.text.trim() && activeFilterCount(query) === 0 && !query.queryAssetId && !query.spaceId;

export const withDiscoveryFacet = (query: DiscoveryQuery, field: string, value: string): DiscoveryQuery => {
  const result = structuredClone(query);
  if ((ID_LIST_FIELDS as readonly string[]).includes(field)) {
    const key = field as (typeof ID_LIST_FIELDS)[number];
    // FL-48: picking one more value adds it to the any-of group and keeps the all-of and exclude
    // groups the condition already had.
    const current = result.filter[key];
    result.filter[key] = { ...current, any: [...new Set([...(current?.any ?? []), value])] };
  } else {
    Object.assign(result.filter, { [field]: { eq: value } });
  }
  return result;
};

export const withoutDiscoveryFilter = (query: DiscoveryQuery, field: string): DiscoveryQuery => {
  const result = structuredClone(query);
  if (field === ENRICHMENT_FIELD) {
    delete result.imageEnrichment;
    return result;
  }
  delete result.filter[field as keyof SearchFilter];
  return result;
};

/**
 * The enrichment facet's pseudo-field name. It is reported alongside real `SearchFilter` fields so
 * the badge, the Filter menu and the chip row treat it like any other active condition, even though
 * it lives on the query root rather than inside `filter`.
 */
export const ENRICHMENT_FIELD = 'imageEnrichment';

export const withDiscoveryEnrichment = (
  query: DiscoveryQuery,
  value: ImageEnrichmentFilter | undefined,
): DiscoveryQuery => {
  const result = structuredClone(query);
  if (value) {
    result.imageEnrichment = value;
  } else {
    delete result.imageEnrichment;
  }
  return result;
};

export const formatMomentTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/* -------------------------------------------------------------------------- */
/* The single Filter control                                                   */
/* -------------------------------------------------------------------------- */

/**
 * September 22, 2026 revision: structured filtering sits behind one Filter control in the results
 * toolbar, with a badge carrying the active filter count and a menu that deep-links into a section
 * of the filter panel. `all` is the catch-all section; it also owns every field no other section
 * claims, so a filter arriving from a URL or a saved preset always has a home to open into.
 */
export type DiscoveryFilterSection = 'people' | 'pets' | 'date' | 'places' | 'media' | 'tags' | 'all';

export const DISCOVERY_FILTER_SECTIONS: readonly DiscoveryFilterSection[] = [
  'people',
  'pets',
  'date',
  'places',
  'media',
  'tags',
  'all',
];

const SECTION_FIELDS: Record<Exclude<DiscoveryFilterSection, 'all'>, readonly string[]> = {
  people: ['personIds', 'hasPeople'],
  // FL-58: the owner's own pets, matched on confirmed observations only
  pets: ['petIds'],
  date: ['takenAt', 'localDateTime', 'createdAt', 'updatedAt', 'trashedAt'],
  places: ['city', 'state', 'country'],
  media: [
    'type',
    'visibility',
    'rating',
    'isFavorite',
    'isMotion',
    'isOffline',
    'isEncoded',
    'make',
    'model',
    'lensModel',
    'fileSizeInBytes',
  ],
  tags: ['tagIds', 'hasTags'],
};

/** The filter panel section a field belongs to. Unclaimed fields open the All filters section. */
export const filterSectionForField = (field: string): DiscoveryFilterSection => {
  for (const section of DISCOVERY_FILTER_SECTIONS) {
    if (section !== 'all' && SECTION_FIELDS[section].includes(field)) {
      return section;
    }
  }
  return 'all';
};

/**
 * Fields carrying an active condition, in a stable order. An `or` branch counts once: the badge
 * reports how many things the user has narrowed by, not how many operands were written.
 */
export const activeFilterFields = (query: DiscoveryQuery): string[] => {
  const filter = query?.filter;
  const fields =
    filter && typeof filter === 'object'
      ? Object.entries(filter)
          .filter(([, condition]) => {
            if (Array.isArray(condition)) {
              return condition.length > 0;
            }
            return !!condition && typeof condition === 'object' && Object.keys(condition).length > 0;
          })
          .map(([field]) => field)
      : [];
  if (query?.imageEnrichment) {
    fields.push(ENRICHMENT_FIELD);
  }
  return fields.sort();
};

/** The fields a section owns. `all` owns every field present in the query. */
export const fieldsInFilterSection = (query: DiscoveryQuery, section: DiscoveryFilterSection): string[] =>
  activeFilterFields(query).filter((field) => section === 'all' || filterSectionForField(field) === section);

/** The number for the Filter control's badge. Free text is a separate entry point, so it is excluded. */
export const activeFilterCount = (query: DiscoveryQuery): number => activeFilterFields(query).length;

export const isDiscoveryFilterActive = (query: DiscoveryQuery): boolean => activeFilterCount(query) > 0;

/** Sections that currently hold a condition, for marking entries in the Filter menu. */
export const activeFilterSections = (query: DiscoveryQuery): DiscoveryFilterSection[] => {
  const sections = new Set(activeFilterFields(query).map((field) => filterSectionForField(field)));
  return DISCOVERY_FILTER_SECTIONS.filter((section) => sections.has(section));
};

/**
 * The destination the results are already shown under. A chip that merely restates it is not
 * drawn: a person page does not need a "People: Ada" chip, Favorites does not need a favourite chip.
 */
export type DiscoveryDestination = {
  kind:
    'library' | 'album' | 'space' | 'person' | 'pet' | 'tag' | 'place' | 'favorites' | 'archive' | 'trash' | 'search';
  id?: string;
};

const DESTINATION_FIELDS: Record<DiscoveryDestination['kind'], readonly string[]> = {
  library: [],
  album: ['albumIds'],
  space: [],
  person: ['personIds'],
  pet: ['petIds'],
  tag: ['tagIds'],
  place: ['city', 'state', 'country'],
  favorites: ['isFavorite'],
  archive: ['visibility'],
  trash: ['visibility', 'trashedAt'],
  search: [],
};

/** Filter fields the destination already states in its own title. */
export const destinationFilterFields = (destination?: DiscoveryDestination): string[] => [
  ...(DESTINATION_FIELDS[destination?.kind ?? 'library'] ?? []),
];

/**
 * Fields that should be drawn as removable filter chips. Chips exist only while a filter is
 * active and never restate the destination.
 */
export const discoveryChipFields = (query: DiscoveryQuery, destination?: DiscoveryDestination): string[] => {
  const suppressed = new Set(destinationFilterFields(destination));
  return activeFilterFields(query).filter((field) => !suppressed.has(field));
};

/** Clear every structured filter while keeping the text query, grouping and view. */
export const withoutDiscoveryFilters = (query: DiscoveryQuery): DiscoveryQuery => {
  const result = { ...structuredClone(query), filter: {} };
  delete result.imageEnrichment;
  return result;
};

/* -------------------------------------------------------------------------- */
/* Handing the query to the search API                                         */
/* -------------------------------------------------------------------------- */

export type DiscoverySearchDto = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;

const DAY_MS = 86_400_000;
const DATE_FILTER_FIELDS = ['takenAt', 'localDateTime', 'createdAt', 'updatedAt', 'trashedAt'] as const;
const dayStart = (day: string) => `${day}T00:00:00.000Z`;
const nextDayStart = (day: string) => new Date(Date.parse(dayStart(day)) + DAY_MS).toISOString();

const narrowest = (values: string[], pick: 'max' | 'min') => {
  let best = values[0];
  for (const value of values.slice(1)) {
    const later = Date.parse(value) > Date.parse(best);
    if (pick === 'max' ? later : !later) {
      best = value;
    }
  }
  return best;
};

/**
 * A date condition as the server takes it (FL-48). The filter panel edits whole UTC calendar days
 * (`YYYY-MM-DD`, as the prototype's `filter-state.mjs` does), but the search DTO's date operands are
 * ISO datetimes with an offset, so each day becomes the instant range it always meant: From a day is
 * its first instant, Through a day is everything before the next day, On a day is both, Before and
 * After leave the whole day out. Datetime operands pass through. Where one side ends up with more
 * than one bound, the narrowest is kept, which is exactly the conjunction the condition stated.
 */
type RangeOperator = 'gte' | 'gt' | 'lt' | 'lte';
const RANGE_OPERATORS: ReadonlySet<string> = new Set<RangeOperator>(['gte', 'gt', 'lt', 'lte']);
const isRangeOperator = (operator: string): operator is RangeOperator => RANGE_OPERATORS.has(operator);

export const toServerDateCondition = (condition: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const collected: Record<'gte' | 'gt' | 'lt' | 'lte', string[]> = { gte: [], gt: [], lt: [], lte: [] };
  for (const [operator, operand] of Object.entries(condition)) {
    if (isCalendarDay(operand)) {
      switch (operator) {
        case 'gte': {
          collected.gte.push(dayStart(operand));
          continue;
        }
        case 'gt': {
          collected.gte.push(nextDayStart(operand));
          continue;
        }
        case 'lte': {
          collected.lt.push(nextDayStart(operand));
          continue;
        }
        case 'lt': {
          collected.lt.push(dayStart(operand));
          continue;
        }
        case 'eq': {
          collected.gte.push(dayStart(operand));
          collected.lt.push(nextDayStart(operand));
          continue;
        }
      }
    }
    if (isRangeOperator(operator) && typeof operand === 'string') {
      collected[operator].push(operand);
      continue;
    }
    result[operator] = operand;
  }
  for (const operator of ['gte', 'gt'] as const) {
    if (collected[operator].length > 0) {
      result[operator] = narrowest(collected[operator], 'max');
    }
  }
  for (const operator of ['lt', 'lte'] as const) {
    if (collected[operator].length > 0) {
      result[operator] = narrowest(collected[operator], 'min');
    }
  }
  return result;
};

const toServerBranch = (branch: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...branch };
  for (const field of DATE_FILTER_FIELDS) {
    const condition = result[field];
    if (isRecord(condition)) {
      result[field] = toServerDateCondition(condition);
    }
  }
  return result;
};

/** A deep copy of the filter with every date condition in the server's datetime form. */
export const toServerFilter = (filter: SearchFilter): SearchFilter => {
  const result = toServerBranch(structuredClone(filter) as Record<string, unknown>);
  if (Array.isArray(result.or)) {
    result.or = result.or.map((branch: Record<string, unknown>) => toServerBranch(branch));
  }
  return result as SearchFilter;
};

/**
 * A shared space is an album of kind `space`, and its photos are what an album-confined search
 * returns for it (`space-photos.svelte.ts`). Searching in a space therefore also requires the space
 * among the item's albums, on top of any album condition the filter already has.
 *
 * Exported so `bulk-operations.ts` can resolve a "select all matching" snapshot for a space the same
 * way (FL-48 map/space follow-ups): the space is an album condition there too, not a scope the search
 * DTO cannot express.
 */
export const withSpaceScope = (filter: SearchFilter, spaceId: string): SearchFilter => {
  const albums = filter.albumIds;
  return {
    ...filter,
    albumIds: albums ? { ...albums, all: [...new Set([...(albums.all ?? []), spaceId])] } : { any: [spaceId] },
  };
};

/**
 * The query as the search endpoints take it (FL-49, made lossless in FL-48). The filter travels with
 * its date bounds in the server's datetime form; a shared space becomes the album condition it is;
 * free text goes to `query` in smart mode and to the query's text field otherwise (or the field the
 * caller names); the enrichment facet and the similar-photo reference go to their own DTO fields.
 * Nothing is invented: every key written here exists on `MetadataSearchDto` or `SmartSearchDto`.
 */
export const toSearchDto = (query: DiscoveryQuery, textField?: keyof DiscoverySearchDto): DiscoverySearchDto => {
  const text = query.text.trim();
  const dto: DiscoverySearchDto = {};
  let filter = toServerFilter(query.filter ?? {});
  if (query.spaceId) {
    filter = withSpaceScope(filter, query.spaceId);
  }
  if (Object.keys(filter).length > 0) {
    dto.filter = filter;
  }
  if (query.imageEnrichment) {
    dto.imageEnrichment = query.imageEnrichment;
  }
  if (query.queryAssetId) {
    dto.queryAssetId = query.queryAssetId;
  }
  if (text) {
    Object.assign(dto, { [query.mode === 'smart' ? 'query' : (textField ?? discoveryTextField(query))]: text });
  }
  return dto;
};

/**
 * AND one text search into a filter. The field is usually free; when it already carries the same
 * operator, the text rides in a single-branch `or`, which is still a conjunction, so neither is lost.
 */
type FilterBranch = NonNullable<SearchFilter['or']>[number];

const withCondition = <T extends SearchFilter | FilterBranch>(target: T, field: string, condition: unknown): T =>
  ({ ...target, [field]: condition }) as T;

const foldTextCondition = (filter: SearchFilter, field: DiscoveryTextField, text: string): SearchFilter => {
  const condition = textFieldCondition(field, text);
  const operator = field === 'ocr' ? 'matches' : 'like';
  const existing = filter[field] as Record<string, unknown> | undefined;
  if (existing === undefined) {
    return withCondition(filter, field, condition);
  }
  if (field !== 'ocr' && existing[operator] === undefined) {
    return withCondition(filter, field, { ...existing, [operator]: text });
  }
  if (filter.or === undefined) {
    return { ...filter, or: [withCondition<FilterBranch>({}, field, condition)] };
  }
  // (a or b) and c is (a and c) or (b and c): distribute into every branch that can still take it.
  return {
    ...filter,
    or: filter.or.map((branch) => (branch[field] === undefined ? withCondition(branch, field, condition) : branch)),
  };
};

/** A default is applied where the filter says nothing about the field, in any branch. */
const withDefaultCondition = (
  filter: SearchFilter,
  field: 'visibility' | 'trashedAt',
  condition: unknown,
): SearchFilter => {
  if (filter[field] !== undefined) {
    return filter;
  }
  if (filter.or?.some((branch) => branch[field] !== undefined)) {
    return {
      ...filter,
      or: filter.or.map((branch) => (branch[field] === undefined ? withCondition(branch, field, condition) : branch)),
    };
  }
  return withCondition(filter, field, condition);
};

/**
 * What a library or search view means when its filter says nothing about visibility or the trash:
 * the timeline, and nothing that is in the trash. A structured search would otherwise return archived
 * and hidden items and everything in the trash. A branch of an `or` that states its own visibility or
 * trash condition keeps it; the others get the default.
 */
export const withSearchDefaults = (filter: SearchFilter): SearchFilter =>
  withDefaultCondition(withDefaultCondition(filter, 'visibility', { eq: AssetVisibility.Timeline }), 'trashedAt', {
    eq: null,
  });

/**
 * The results-page request for a search that carries a structured `filter` (FL-58, so a pet picked in
 * the search dialog reaches the results). The server refuses every deprecated flat field next to
 * `filter`, so nothing flat may ride along: the dialog's text modes (file name, description, OCR,
 * path) are folded into the filter with the flat fields' own "contains" semantics, and the results
 * page's flat defaults become filter defaults (`withSearchDefaults`). Paging is by `cursor`; smart
 * search keeps its free-text `query` and its similar-photo reference.
 */
export const structuredSearchRequest = (dto: DiscoverySearchDto, cursor?: string | null): DiscoverySearchDto => {
  let filter = toServerFilter(dto.filter ?? {});
  for (const field of DISCOVERY_TEXT_FIELDS) {
    const text = dto[field];
    if (typeof text === 'string' && text) {
      filter = foldTextCondition(filter, field, text);
    }
  }
  return {
    filter: withSearchDefaults(filter),
    withExif: true,
    ...(dto.query && { query: dto.query }),
    ...(dto.queryAssetId && { queryAssetId: dto.queryAssetId }),
    ...(dto.imageEnrichment && { imageEnrichment: dto.imageEnrichment }),
    ...(cursor && { cursor }),
  };
};

/** The results request for a query: one path from the shared query to the server (FL-48). */
export const discoverySearchRequest = (query: DiscoveryQuery, cursor?: string | null): DiscoverySearchDto =>
  structuredSearchRequest(toSearchDto(query), cursor);

/* -------------------------------------------------------------------------- */
/* Cumulative paging                                                           */
/* -------------------------------------------------------------------------- */

export type DiscoveryPaging = {
  /** Pages already loaded, cumulative: Show more raises this, it never replaces the page. */
  page: number;
  pageSize: number;
  /** Items currently rendered, capped by the total when it is known. */
  shown: number;
  /** Total matches reported by the server, or null while it is unknown. */
  total: number | null;
  hasMore: boolean;
  remaining: number | null;
};

export const DEFAULT_DISCOVERY_PAGE_SIZE = 60;

/**
 * Cumulative paging for the Show more control. `page` counts loaded pages, so the visible run is
 * always 1..page * pageSize; this is what makes the summary read "Showing n of m" rather than a
 * range. An unknown total (the server has not counted yet) keeps Show more available.
 */
export const discoveryPaging = (
  page: number,
  total: number | null,
  pageSize: number = DEFAULT_DISCOVERY_PAGE_SIZE,
): DiscoveryPaging => {
  const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 1000) : DEFAULT_DISCOVERY_PAGE_SIZE;
  const current = Math.max(1, Number.isSafeInteger(page) ? page : 1);
  const count = Number.isSafeInteger(total) && (total as number) >= 0 ? (total as number) : null;
  const requested = current * size;
  const shown = count === null ? requested : Math.min(requested, count);
  return {
    page: count === null ? current : Math.max(1, Math.min(current, Math.ceil(count / size) || 1)),
    pageSize: size,
    shown,
    total: count,
    hasMore: count === null ? true : shown < count,
    remaining: count === null ? null : count - shown,
  };
};

export type DiscoveryPageSummary = {
  /** i18n key for the cumulative "Showing n of m" line under the results. */
  key: 'no_results' | 'frameleaf_library_showing_all' | 'frameleaf_library_showing_of';
  values: { shown: number; total: number };
  hasMore: boolean;
};

/** The cumulative summary; the caller translates `key` with `values`. */
export const discoveryPageSummary = (paging: DiscoveryPaging): DiscoveryPageSummary => {
  const total = paging.total ?? paging.shown;
  if (paging.total === 0) {
    return { key: 'no_results', values: { shown: 0, total: 0 }, hasMore: false };
  }
  if (!paging.hasMore) {
    return { key: 'frameleaf_library_showing_all', values: { shown: total, total }, hasMore: false };
  }
  return { key: 'frameleaf_library_showing_of', values: { shown: paging.shown, total }, hasMore: true };
};
