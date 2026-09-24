import { AssetTypeEnum, AssetVisibility, ImageEnrichmentFilter } from '@immich/sdk';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { activeFilterFields, ENRICHMENT_FIELD, type DiscoveryQuery } from '$lib/components/discovery/query';

/**
 * Filter-panel control state for the Frameleaf search dialog (FL-49).
 *
 * A direct port of `design/frameleaf/template/src/filter-state.mjs`, which the workstream
 * table names as the specification. Its whole point is that the panel's simple controls — a
 * select, a date input, a set of checkboxes — are a *lossy* view of a `SearchFilter`
 * condition, and editing one must never silently discard a condition the control cannot
 * express. So every reader returns {@link CUSTOM_CONDITION} when the stored condition is
 * richer than the control, the panel then shows "custom condition (see chip)" and leaves
 * the value alone, and the chip stays the way to remove it.
 *
 * Every field named here exists on the server's `SearchFilter` (see `SearchFilterBranch` in
 * the generated client) except `imageEnrichment`, which is a DTO-level enum and is handled
 * by its own helpers at the bottom of this file. Nothing is invented: the prototype's
 * `descriptionStatus`/`sensitiveStatus` have no production column and their intent is served
 * by `ImageEnrichmentFilter`.
 */

export const CUSTOM_CONDITION = '__custom_condition__';

export type SetGroup = 'any' | 'all' | 'none';
export const SET_GROUPS: readonly SetGroup[] = ['any', 'all', 'none'];
export const SET_GROUP_LABEL_KEYS: Record<SetGroup, Translations> = {
  any: 'frameleaf_search_match_any',
  all: 'frameleaf_search_match_all',
  none: 'frameleaf_search_match_none',
};

/** An id-set condition (`personIds`, `petIds`, `tagIds`, `albumIds`). */
export type SetCondition = Partial<Record<SetGroup, string[]>> | null;
type Condition = Record<string, unknown> | null | undefined;

const isSetGroup = (value: string): value is SetGroup => (SET_GROUPS as readonly string[]).includes(value);

/** Editing one group never changes the other groups in the same condition. */
export const updateSetGroup = (condition: SetCondition, group: string, values: string[]): SetCondition => {
  if (!isSetGroup(group)) {
    return condition ?? null;
  }
  const next: Record<string, string[]> = { ...condition } as Record<string, string[]>;
  if (values.length > 0) {
    next[group] = [...new Set(values)];
  } else {
    delete next[group];
  }
  return Object.keys(next).length > 0 ? (next as SetCondition) : null;
};

/** Move a group's values into another group, merging rather than replacing. */
export const moveSetGroup = (condition: SetCondition, from: string, to: string): SetCondition => {
  if (from === to || !isSetGroup(from) || !isSetGroup(to)) {
    return condition ?? null;
  }
  const values = condition?.[from] ?? [];
  const next: Record<string, string[]> = { ...condition } as Record<string, string[]>;
  delete next[from];
  if (values.length > 0) {
    next[to] = [...new Set([...(next[to] ?? []), ...values])];
  }
  return Object.keys(next).length > 0 ? (next as SetCondition) : null;
};

const isEmpty = (condition: Condition) => !condition || Object.keys(condition).length === 0;

const isOnly = (condition: Condition, operator: string) =>
  !!condition && Object.keys(condition).length === 1 && Object.hasOwn(condition, operator);

/**
 * The value for a control that can only express `{ eq: <accepted value> }`. Anything else —
 * `ne`, `in`, a value the control does not offer — reads as {@link CUSTOM_CONDITION}.
 */
export const equalityControlValue = (
  condition: Condition,
  accepts: (value: unknown) => boolean = (value) => typeof value === 'string' && value.length > 0,
): string => {
  if (isEmpty(condition)) {
    return '';
  }
  return isOnly(condition, 'eq') && accepts((condition as Record<string, unknown>).eq)
    ? String((condition as Record<string, unknown>).eq)
    : CUSTOM_CONDITION;
};

/* -------------------------------------------------------------------------- */
/* Rating                                                                      */
/* -------------------------------------------------------------------------- */

export const ratingControlValue = (condition: Condition): string => {
  if (isEmpty(condition)) {
    return '';
  }
  const value = condition as Record<string, unknown>;
  if (isOnly(condition, 'eq')) {
    if (value.eq === null) {
      return 'null';
    }
    if (Number.isSafeInteger(value.eq) && (value.eq as number) >= -1 && (value.eq as number) <= 5) {
      return String(value.eq);
    }
  }
  if (
    isOnly(condition, 'gte') &&
    Number.isSafeInteger(value.gte) &&
    (value.gte as number) >= 0 &&
    (value.gte as number) <= 5
  ) {
    return `min${value.gte}`;
  }
  return CUSTOM_CONDITION;
};

/** `undefined` means "the control cannot express this"; the caller leaves the condition alone. */
export const ratingConditionForValue = (value: string): Condition | undefined => {
  if (value === '') {
    return null;
  }
  if (value === 'null') {
    return { eq: null };
  }
  if (/^(?:-1|[0-5])$/.test(value)) {
    return { eq: Number(value) };
  }
  if (/^min[0-5]$/.test(value)) {
    return { gte: Number(value.slice(3)) };
  }
  return undefined;
};

/* -------------------------------------------------------------------------- */
/* Capture date                                                                */
/* -------------------------------------------------------------------------- */

const calendarDay = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    return '';
  }
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : '';
};

export const captureDateControlValue = (condition: Condition, operator: 'gte' | 'lte'): string => {
  const value = (condition ?? {}) as Record<string, unknown>;
  if (value[operator] !== undefined) {
    return calendarDay(value[operator]);
  }
  if (operator !== 'lte' || typeof value.lt !== 'string') {
    return '';
  }
  const day = calendarDay(value.lt);
  if (!day) {
    return '';
  }
  // An exclusive upper bound is a UTC midnight; subtracting one millisecond also keeps a
  // custom intraday end on its actual calendar day.
  const boundary = new Date(value.lt.length === 10 ? `${day}T00:00:00.000Z` : value.lt);
  if (!Number.isFinite(boundary.getTime())) {
    return '';
  }
  return new Date(boundary.getTime() - 1).toISOString().slice(0, 10);
};

export const updateCaptureDate = (condition: Condition, operator: 'gte' | 'lte', value: string): Condition => {
  if (!['gte', 'lte'].includes(operator) || (value && calendarDay(value) !== value)) {
    return condition ?? null;
  }
  const next: Record<string, unknown> = { ...condition };
  delete next[operator];
  // An explicit edit replaces only this endpoint, including its strict variant, so changing
  // From retains an existing exclusive upper bound.
  delete next[operator === 'gte' ? 'gt' : 'lt'];
  if (value) {
    next[operator] = value;
  }
  return Object.keys(next).length > 0 ? next : null;
};

export const captureDateHasCustomCondition = (condition: Condition): boolean => {
  const value = (condition ?? {}) as Record<string, unknown>;
  if (value.lt !== undefined && value.lte !== undefined) {
    return true;
  }
  return Object.entries(value).some(([operator, item]) => {
    if (!['gte', 'lte', 'lt'].includes(operator) || !calendarDay(item)) {
      return true;
    }
    if (operator === 'lt') {
      return !/^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.000)?Z)?$/.test(item as string);
    }
    if (operator === 'lte' && (item as string).length > 10) {
      return true;
    }
    // Date-only controls cannot fully represent an intraday timestamp.
    return (item as string).length > 10 && !/^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(item as string);
  });
};

/* -------------------------------------------------------------------------- */
/* Boolean quick toggles                                                       */
/* -------------------------------------------------------------------------- */

/**
 * "Not in any album" and "Untagged" set one boolean equality and clear it again. Both map to
 * a real `SearchFilter` field: `hasAlbums: { eq: false }` and `hasTags: { eq: false }`. Any
 * other condition on the field is left to the chip.
 */
export const flagToggleActive = (condition: Condition, value: boolean): boolean =>
  isOnly(condition, 'eq') && (condition as Record<string, unknown>).eq === value;

export const toggleFlagCondition = (condition: Condition, value: boolean): Condition =>
  typeof value === 'boolean' ? (flagToggleActive(condition, value) ? null : { eq: value }) : (condition ?? null);

/* -------------------------------------------------------------------------- */
/* Enrichment                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The enrichment quick filters from `SearchPalette.jsx`, mapped onto the server's real
 * `ImageEnrichmentFilter` enum. The prototype's three chips (description missing,
 * description failed, needs sensitivity review) are the first three here; the rest of the
 * enum is offered in the filter panel so nothing the server supports is unreachable.
 */
export const ENRICHMENT_QUICK_FILTERS: readonly { value: ImageEnrichmentFilter; labelKey: Translations }[] = [
  { value: ImageEnrichmentFilter.MissingImageDescription, labelKey: 'image_enrichment_filter_missing_description' },
  { value: ImageEnrichmentFilter.ImageDescriptionFailed, labelKey: 'image_enrichment_filter_description_failed' },
  { value: ImageEnrichmentFilter.NsfwReview, labelKey: 'image_enrichment_filter_nsfw_review' },
];

export const ENRICHMENT_OPTIONS: readonly { value: ImageEnrichmentFilter; labelKey: Translations }[] = [
  { value: ImageEnrichmentFilter.Nsfw, labelKey: 'image_enrichment_filter_nsfw' },
  { value: ImageEnrichmentFilter.NsfwReview, labelKey: 'image_enrichment_filter_nsfw_review' },
  { value: ImageEnrichmentFilter.NsfwReviewed, labelKey: 'image_enrichment_filter_nsfw_reviewed' },
  { value: ImageEnrichmentFilter.NsfwOverridden, labelKey: 'image_enrichment_filter_nsfw_overridden' },
  { value: ImageEnrichmentFilter.ImageDescriptionFailed, labelKey: 'image_enrichment_filter_description_failed' },
  { value: ImageEnrichmentFilter.NsfwDetectionFailed, labelKey: 'image_enrichment_filter_nsfw_failed' },
  { value: ImageEnrichmentFilter.MissingImageDescription, labelKey: 'image_enrichment_filter_missing_description' },
  { value: ImageEnrichmentFilter.MissingNsfwDetection, labelKey: 'image_enrichment_filter_missing_nsfw' },
];

export const isEnrichmentFilter = (value: unknown): value is ImageEnrichmentFilter =>
  typeof value === 'string' && Object.values(ImageEnrichmentFilter).includes(value as ImageEnrichmentFilter);

/* -------------------------------------------------------------------------- */
/* Chip labels                                                                 */
/* -------------------------------------------------------------------------- */

/** Translated field names for the chip row, keyed by `SearchFilter` field. */
const FIELD_LABEL_KEYS: Record<string, Translations> = {
  personIds: 'people',
  petIds: 'frameleaf_pets_title',
  tagIds: 'tags',
  albumIds: 'albums',
  type: 'media_type',
  takenAt: 'frameleaf_search_field_taken_at',
  localDateTime: 'frameleaf_search_field_taken_at',
  createdAt: 'frameleaf_search_field_created_at',
  updatedAt: 'frameleaf_search_field_updated_at',
  trashedAt: 'frameleaf_search_field_trashed_at',
  city: 'city',
  state: 'state',
  country: 'country',
  make: 'camera_brand',
  model: 'camera_model',
  lensModel: 'lens_model',
  rating: 'rating',
  originalFileName: 'file_name_text',
  description: 'description',
  ocr: 'ocr',
  originalPath: 'full_path_or_folder',
  visibility: 'visibility',
  isFavorite: 'favorites',
  isMotion: 'motion',
  isOffline: 'offline',
  isEncoded: 'frameleaf_search_field_encoded',
  hasPeople: 'people',
  hasAlbums: 'albums',
  hasTags: 'tags',
  fileSizeInBytes: 'file_size',
  checksum: 'checksum',
  libraryId: 'library',
  [ENRICHMENT_FIELD]: 'image_enrichment',
};

const BOOLEAN_LABEL_KEYS: Record<string, [Translations, Translations]> = {
  isFavorite: ['frameleaf_search_not_favorites', 'favorites'],
  hasPeople: ['frameleaf_search_no_people', 'frameleaf_search_with_people'],
  hasAlbums: ['not_in_any_album', 'frameleaf_search_in_an_album'],
  hasTags: ['untagged', 'frameleaf_search_tagged'],
  isMotion: ['frameleaf_search_not_motion', 'motion'],
  isOffline: ['frameleaf_search_online', 'offline'],
  isEncoded: ['frameleaf_search_not_encoded', 'frameleaf_search_field_encoded'],
};

export interface FilterChipDescriptor {
  field: string;
  label: string;
  /** Person ids to show as avatars ahead of the label; empty for every other field. */
  personIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const DATE_FIELDS = new Set(['takenAt', 'localDateTime', 'createdAt', 'updatedAt', 'trashedAt']);
const SET_FIELDS = new Set(['personIds', 'petIds', 'tagIds', 'albumIds']);

const formatDay = (value: unknown, locale: string) => {
  const day = typeof value === 'string' ? value : '';
  const time = Date.parse(day.length === 10 ? `${day}T00:00:00.000Z` : day);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(time)
    : String(value);
};

export interface ChipLabelOptions {
  /** Resolves an id to a display name (a person, a pet, a tag, an album). Falls back to the id. */
  nameFor?: (field: string, id: string) => string | undefined;
  locale?: string;
}

const valueLabel = ($t: MessageFormatter, field: string, value: unknown, options: ChipLabelOptions): string => {
  if (SET_FIELDS.has(field) && typeof value === 'string') {
    return options.nameFor?.(field, value) ?? value;
  }
  switch (field) {
    case 'type': {
      if (value === AssetTypeEnum.Image) {
        return $t('image');
      }
      if (value === AssetTypeEnum.Video) {
        return $t('video');
      }
      break;
    }
    case 'visibility': {
      if (value === AssetVisibility.Archive) {
        return $t('archive');
      }
      if (value === AssetVisibility.Timeline) {
        return $t('frameleaf_search_in_timeline');
      }
      break;
    }
    case 'rating': {
      return value === null ? $t('frameleaf_search_unrated') : String(value);
    }
  }
  if (field === ENRICHMENT_FIELD) {
    const option = ENRICHMENT_OPTIONS.find((item) => item.value === value);
    return option ? $t(option.labelKey) : String(value);
  }
  if (DATE_FIELDS.has(field)) {
    return formatDay(value, options.locale ?? 'en');
  }
  return value === null ? $t('frameleaf_search_not_set') : String(value);
};

const operatorLabel = ($t: MessageFormatter, field: string, operator: string, formatted: string): string => {
  switch (operator) {
    case 'eq':
    case 'any':
    case 'all':
    case 'in': {
      return formatted;
    }
    case 'none': {
      return $t('frameleaf_search_op_without', { values: { value: formatted } });
    }
    case 'ne':
    case 'notIn': {
      return $t('frameleaf_search_op_not', { values: { value: formatted } });
    }
    case 'gte': {
      return field === 'rating'
        ? $t('frameleaf_search_op_at_least', { values: { value: formatted } })
        : $t('frameleaf_search_op_from', { values: { value: formatted } });
    }
    case 'gt': {
      return $t('frameleaf_search_op_after', { values: { value: formatted } });
    }
    case 'lte': {
      return $t('frameleaf_search_op_through', { values: { value: formatted } });
    }
    case 'lt': {
      return $t('frameleaf_search_op_before', { values: { value: formatted } });
    }
    case 'startsWith': {
      return $t('frameleaf_search_op_starts_with', { values: { value: formatted } });
    }
    case 'endsWith': {
      return $t('frameleaf_search_op_ends_with', { values: { value: formatted } });
    }
    default: {
      return formatted.replaceAll(/^%|%$/g, '');
    }
  }
};

/**
 * One chip per active field, in the order `activeFilterFields` reports. A boolean field reads
 * as its plain-language state ("Untagged") rather than "Has tags: false", matching the
 * prototype; every other field reads "Field: value".
 */
export const describeFilterChips = (
  $t: MessageFormatter,
  query: DiscoveryQuery,
  options: ChipLabelOptions = {},
  fields: string[] = activeFilterFields(query),
): FilterChipDescriptor[] =>
  fields.map((field) => {
    const labelKey = FIELD_LABEL_KEYS[field];
    const label = labelKey ? $t(labelKey) : field;

    if (field === ENRICHMENT_FIELD) {
      return {
        field,
        personIds: [],
        label: `${label}: ${valueLabel($t, field, query.imageEnrichment, options)}`,
      };
    }

    const condition = (query.filter as Record<string, unknown>)[field];

    if (field === 'or') {
      return {
        field,
        personIds: [],
        label: $t('frameleaf_search_any_of_groups', {
          values: { count: Array.isArray(condition) ? condition.length : 0 },
        }),
      };
    }

    if (!isRecord(condition)) {
      return { field, personIds: [], label: `${label}: ${$t('frameleaf_search_invalid_filter')}` };
    }

    const booleanLabels = BOOLEAN_LABEL_KEYS[field];
    if (booleanLabels && isOnly(condition, 'eq') && typeof condition.eq === 'boolean') {
      const [whenFalse, whenTrue] = booleanLabels;
      return { field, personIds: [], label: $t(condition.eq ? whenTrue : whenFalse) };
    }

    const parts = Object.entries(condition).map(([operator, value]) => {
      const format = (item: unknown) => valueLabel($t, field, item, options);
      const joiner = operator === 'all' ? $t('frameleaf_search_join_and') : $t('frameleaf_search_join_or');
      const formatted = Array.isArray(value) ? value.map((item) => format(item)).join(joiner) : format(value);
      return operatorLabel($t, field, operator, formatted);
    });

    return {
      field,
      personIds:
        field === 'personIds'
          ? Object.values(condition)
              .flat()
              .filter((id): id is string => typeof id === 'string')
          : [],
      label: `${label}: ${parts.join('; ')}`,
    };
  });

/** Set a single field's condition on a query, removing it when the condition is empty. */
export const withFilterCondition = (query: DiscoveryQuery, field: string, condition: Condition): DiscoveryQuery => {
  const result = structuredClone(query);
  const filter = result.filter as Record<string, unknown>;
  if (condition && Object.keys(condition).length > 0) {
    filter[field] = condition;
  } else {
    delete filter[field];
  }
  return result;
};

export { type SearchFilter } from '@immich/sdk';
