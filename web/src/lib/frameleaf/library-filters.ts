import type { SearchFilter } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import type { DiscoveryQuery } from '$lib/components/discovery/query';

/**
 * Labels for the single Filter control's chips (FL-33).
 *
 * The September 22, 2026 revision keeps structured filtering behind one Filter control and draws
 * chips only while a filter is active. A chip has to say what was narrowed by without re-stating
 * the whole condition, so this module turns a field and its condition into a short name and an
 * optional detail. It is pure: the caller translates the name and formats nothing else.
 */
const FIELD_LABEL_KEYS: Record<string, Translations> = {
  personIds: 'people',
  hasPeople: 'people',
  petIds: 'frameleaf_pets_title',
  takenAt: 'date_and_time',
  createdAt: 'created',
  updatedAt: 'frameleaf_library_filter_field_updated',
  trashedAt: 'frameleaf_library_filter_field_trashed',
  city: 'city',
  state: 'state',
  country: 'country',
  type: 'media_type',
  visibility: 'visibility',
  rating: 'rating',
  isFavorite: 'favorite',
  isMotion: 'frameleaf_library_filter_field_motion',
  isOffline: 'offline',
  isEncoded: 'frameleaf_library_filter_field_encoded',
  make: 'make',
  model: 'model',
  lensModel: 'lens_model',
  fileSizeInBytes: 'file_size',
  tagIds: 'tags',
  hasTags: 'tags',
  albumIds: 'albums',
  hasAlbums: 'albums',
  originalFileName: 'frameleaf_library_filter_field_file_name',
  originalPath: 'path',
  description: 'description',
  ocr: 'ocr',
  libraryId: 'frameleaf_library_filter_field_library',
  or: 'frameleaf_library_filter_field_any_of',
};

/** i18n key naming a filter field. Unknown fields fall back to a neutral "Filter". */
export const filterFieldLabelKey = (field: string) => FIELD_LABEL_KEYS[field] ?? 'frameleaf_library_filter_field_other';

const LIST_OPERATORS = ['in', 'notIn', 'any', 'all', 'none'] as const;
const TEXT_OPERATORS = ['like', 'notLike', 'startsWith', 'endsWith', 'matches'] as const;

const scalar = (value: unknown): string | null => {
  if (typeof value === 'string') {
    // A `like` condition is stored with SQL wildcards; the chip shows what the user typed.
    return value.replaceAll('%', '').trim() || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

export type FilterChipDescription = {
  field: string;
  /** i18n key for the field's name. */
  labelKey: Translations;
  /** A short rendering of the condition, or null when the name says it all. */
  detail: string | null;
  /** How many values a list condition holds; 0 when it is not a list. */
  count: number;
  /** True for a boolean condition that is explicitly negated ("not favourite"). */
  negated: boolean;
};

/**
 * Describe one active condition. `null` is returned for a field carrying no condition, so callers
 * can map over a filter without pre-filtering it.
 */
export const describeFilterField = (query: DiscoveryQuery, field: string): FilterChipDescription | null => {
  const condition = query?.filter?.[field as keyof SearchFilter] as unknown;
  if (condition === undefined || condition === null) {
    return null;
  }
  const base = { field, labelKey: filterFieldLabelKey(field), detail: null as string | null, count: 0, negated: false };
  if (Array.isArray(condition)) {
    // An `or` branch: one chip for the whole branch, counting the alternatives.
    return condition.length === 0 ? null : { ...base, count: condition.length };
  }
  if (typeof condition !== 'object') {
    return null;
  }
  // An empty list (`{ any: [] }`) constrains nothing, exactly like an empty condition.
  const entries = Object.entries(condition as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
  );
  if (entries.length === 0) {
    return null;
  }
  for (const operator of LIST_OPERATORS) {
    const values = (condition as Record<string, unknown>)[operator];
    if (Array.isArray(values) && values.length > 0) {
      return { ...base, count: values.length, negated: operator === 'notIn' || operator === 'none' };
    }
  }
  const eq = (condition as Record<string, unknown>).eq;
  const ne = (condition as Record<string, unknown>).ne;
  if (typeof eq === 'boolean' || typeof ne === 'boolean') {
    // "Favorite" and "Not favorite" — the field's own name carries the meaning.
    return { ...base, negated: eq === false || ne === true };
  }
  if (eq !== undefined || ne !== undefined) {
    return { ...base, detail: scalar(eq ?? ne), negated: ne !== undefined };
  }
  for (const operator of TEXT_OPERATORS) {
    const value = (condition as Record<string, unknown>)[operator];
    if (value !== undefined) {
      return { ...base, detail: scalar(value), negated: operator === 'notLike' };
    }
  }
  const from = scalar((condition as Record<string, unknown>).gte ?? (condition as Record<string, unknown>).gt);
  const to = scalar((condition as Record<string, unknown>).lte ?? (condition as Record<string, unknown>).lt);
  if (from || to) {
    return { ...base, detail: from && to ? `${from} – ${to}` : (from ?? to) };
  }
  return base;
};

/** Descriptions for every chip the toolbar should draw, in the order the fields were given. */
export const describeFilterFields = (query: DiscoveryQuery, fields: string[]): FilterChipDescription[] =>
  fields
    .map((field) => describeFilterField(query, field))
    .filter((description): description is FilterChipDescription => description !== null);

/**
 * The literal ids behind an active `personIds`/`petIds`/`tagIds` (or similar id-list) condition, when it is
 * a positive membership condition (`any`/`all`) — `null` for an exclusion (`none`) and for anything
 * that is not an id-list condition. Naming a download after an id from a `none` condition would say
 * the opposite of what was filtered (FL-45): the download holds everything *except* those ids, so
 * their names are not a description of it.
 */
export const filterFieldEntityIds = (query: DiscoveryQuery, field: string): string[] | null => {
  const condition = query?.filter?.[field as keyof SearchFilter] as unknown;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return null;
  }
  const { any, all } = condition as Record<string, unknown>;
  const ids = Array.isArray(any) ? any : Array.isArray(all) ? all : null;
  return ids && ids.every((id) => typeof id === 'string') ? (ids as string[]) : null;
};
