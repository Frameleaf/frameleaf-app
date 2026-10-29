import {
  AssetTypeEnum,
  AssetVisibility,
  ColorTolerance,
  ImageEnrichmentFilter,
  type ColorFilter,
  type NumberFilterNullable,
  type SearchFilter,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { ENRICHMENT_FIELD, type DiscoveryQuery } from '$lib/components/discovery/query';
import {
  captureDateControlValue,
  captureDateHasCustomCondition,
  ratingControlValue,
} from '$lib/frameleaf/search-filters';

/**
 * Labels for the single Filter control's chips (FL-33).
 *
 * The September 22, 2026 revision keeps structured filtering behind one Filter control and draws
 * chips only while a filter is active. A chip has to say what was narrowed by without re-stating
 * the whole condition, so this module turns a field and its condition into a short name and an
 * optional detail. It is pure: the caller translates the name and formats nothing else.
 */
const FIELD_LABEL_KEYS: Record<string, Translations> = {
  color: 'frameleaf_color_filter',
  hasTransparency: 'frameleaf_filter_transparency',
  source: 'frameleaf_sources_title',
  text: 'frameleaf_search_mode_all_text',
  albumSubtreeIds: 'frameleaf_filter_nested_albums',
  width: 'frameleaf_filter_width',
  height: 'frameleaf_filter_height',
  aspectRatio: 'frameleaf_filter_aspect_ratio',
  durationMs: 'frameleaf_filter_duration',
  personIds: 'people',
  hasPeople: 'people',
  petIds: 'frameleaf_pets_title',
  takenAt: 'frameleaf_search_field_taken_at',
  localDateTime: 'frameleaf_search_field_taken_at',
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
  make: 'camera_brand',
  model: 'camera_model',
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

/** Text the caller translates: an i18n key and its ICU values. */
export type FilterText = { key: Translations; values?: Record<string, string | number | Date> };

/** LIB-09: the filter panel's own wording for each value, shared so a chip never shows the stored one. */
export const MEDIA_TYPE_LABEL_KEYS: Record<string, Translations> = {
  [AssetTypeEnum.Image]: 'photos',
  [AssetTypeEnum.Video]: 'videos',
};

export const VISIBILITY_LABEL_KEYS: Record<string, Translations> = {
  [AssetVisibility.Timeline]: 'timeline',
  [AssetVisibility.Archive]: 'archived',
  [AssetVisibility.Hidden]: 'frameleaf_people_hidden_badge',
  [AssetVisibility.Locked]: 'frameleaf_locked',
};

/**
 * The rating control's choices, in panel order. "0 stars or more" is not offered: it only means
 * "has a rating and is not rejected", which nobody asks for, and it read as "everything".
 */
export const RATING_CHOICES = ['null', '-1', '0', '1', '2', '3', '4', '5', 'min1', 'min2', 'min3', 'min4', 'min5'];

/** Label for a `ratingControlValue`; null for the empty and custom values. */
export const ratingChoiceText = (value: string): FilterText | null => {
  if (value === 'null') {
    return { key: 'frameleaf_search_rating_unset' };
  }
  if (value === '-1') {
    return { key: 'frameleaf_search_rating_rejected' };
  }
  if (/^[0-5]$/.test(value)) {
    return { key: 'frameleaf_search_rating_exactly', values: { count: Number(value) } };
  }
  if (/^min[1-5]$/.test(value)) {
    return { key: 'frameleaf_search_rating_at_least', values: { count: Number(value.slice(3)) } };
  }
  return null;
};

/**
 * The "Text & descriptions" and "Sensitivity review" radiogroups (FP-2). The server has one
 * enrichment enum, so the two groups share it: a choice in one returns the other to Any. The
 * prototype's "Generated" and "Written manually" description states have no server value and are
 * not offered; the detection states the prototype does not list stay reachable in the sensitivity
 * group, so nothing the server supports is lost.
 */
export const ENRICHMENT_GROUPS: {
  section: string;
  headingKey: Translations;
  helpKey: Translations;
  labelKey: Translations;
  values: readonly { value: ImageEnrichmentFilter; labelKey: Translations }[];
}[] = [
  {
    section: 'text',
    headingKey: 'frameleaf_search_text_and_descriptions',
    helpKey: 'frameleaf_search_text_and_descriptions_help',
    labelKey: 'description',
    values: [
      { value: ImageEnrichmentFilter.MissingImageDescription, labelKey: 'frameleaf_search_status_no_description' },
      { value: ImageEnrichmentFilter.ImageDescriptionFailed, labelKey: 'frameleaf_search_status_generation_failed' },
    ],
  },
  {
    section: 'sensitivity',
    headingKey: 'frameleaf_search_sensitivity_review',
    helpKey: 'frameleaf_search_sensitivity_review_help',
    labelKey: 'frameleaf_search_review_status',
    values: [
      { value: ImageEnrichmentFilter.NsfwReviewed, labelKey: 'frameleaf_search_status_reviewed' },
      { value: ImageEnrichmentFilter.NsfwReview, labelKey: 'frameleaf_search_status_needs_review' },
      { value: ImageEnrichmentFilter.NsfwOverridden, labelKey: 'frameleaf_search_status_overridden' },
      { value: ImageEnrichmentFilter.Nsfw, labelKey: 'frameleaf_search_status_flagged' },
      { value: ImageEnrichmentFilter.NsfwDetectionFailed, labelKey: 'frameleaf_search_status_check_failed' },
      { value: ImageEnrichmentFilter.MissingNsfwDetection, labelKey: 'frameleaf_search_status_not_checked' },
    ],
  },
];

/** Library-status flags: the panel's names, and the quick toggle's name for the `false` case. */
const STATUS_FLAG_LABELS: Record<string, { yes: Translations; no?: Translations }> = {
  hasPeople: { yes: 'frameleaf_search_has_people' },
  hasAlbums: { yes: 'frameleaf_search_in_an_album', no: 'not_in_any_album' },
  hasTags: { yes: 'frameleaf_search_has_tags', no: 'untagged' },
};

/** A date-only day as a local Date, so the formatted day is the day the user picked. */
const localDay = (day: string) => new Date(`${day}T00:00:00`);

/** i18n key naming a filter field. Unknown fields fall back to a neutral "Filter". */
export const filterFieldLabelKey = (field: string) => FIELD_LABEL_KEYS[field] ?? 'frameleaf_library_filter_field_other';

const LIST_OPERATORS = ['in', 'notIn', 'any', 'all', 'none'] as const;
const TEXT_OPERATORS = ['like', 'notLike', 'startsWith', 'endsWith', 'matches', 'contains'] as const;

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
  /** The panel's wording for the condition; when set, callers show it instead of `detail`. */
  detailText?: FilterText;
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
  const described = describeRawFilterField(query, field);
  if (!described) {
    return field === ENRICHMENT_FIELD ? describeEnrichment(query) : null;
  }
  const condition = query.filter[field as keyof SearchFilter] as Record<string, unknown>;
  const flag = STATUS_FLAG_LABELS[field];
  if (flag && typeof condition.eq === 'boolean' && Object.keys(condition).length === 1) {
    if (condition.eq) {
      return { ...described, labelKey: flag.yes, negated: false };
    }
    return flag.no
      ? { ...described, labelKey: flag.no, negated: false }
      : { ...described, labelKey: flag.yes, negated: false, detailText: { key: 'no' } };
  }
  const detailText = describeValue(field, condition);
  return detailText ? { ...described, detail: null, detailText } : described;
};

const describeValue = (field: string, condition: Record<string, unknown>): FilterText | undefined => {
  const value = condition.eq ?? condition.ne;
  const labels = field === 'type' ? MEDIA_TYPE_LABEL_KEYS : field === 'visibility' ? VISIBILITY_LABEL_KEYS : undefined;
  const key = labels && typeof value === 'string' ? labels[value] : undefined;
  if (key) {
    return { key };
  }
  if (field === 'rating') {
    return ratingChoiceText(ratingControlValue(condition)) ?? undefined;
  }
  if (field === 'color') {
    return colorFilterText(condition as ColorFilter) ?? undefined;
  }
  if (field === 'aspectRatio') {
    const shape = boardShapeOf(condition as NumberFilterNullable);
    return shape === 'any' || shape === 'custom' ? undefined : { key: BOARD_SHAPE_LABEL_KEYS[shape] };
  }
  if (field === 'width') {
    const width = minimumWidthOf(condition as NumberFilterNullable);
    return typeof width === 'number' && width > 0
      ? { key: 'frameleaf_boards_min_width_value', values: { width } }
      : undefined;
  }
  if ((field === 'localDateTime' || field === 'takenAt') && !captureDateHasCustomCondition(condition)) {
    const from = captureDateControlValue(condition, 'gte');
    const to = captureDateControlValue(condition, 'lte');
    if (from && to) {
      return { key: 'frameleaf_library_filter_date_range', values: { from: localDay(from), to: localDay(to) } };
    }
    if (from || to) {
      return from
        ? { key: 'frameleaf_library_filter_date_from', values: { from: localDay(from) } }
        : { key: 'frameleaf_library_filter_date_through', values: { to: localDay(to) } };
    }
  }
  return undefined;
};

/** The enrichment choice lives on the query root; its chip reads like the radiogroup that set it. */
const describeEnrichment = (query: DiscoveryQuery): FilterChipDescription | null => {
  for (const group of ENRICHMENT_GROUPS) {
    const choice = group.values.find(({ value }) => value === query?.imageEnrichment);
    if (choice) {
      return {
        field: ENRICHMENT_FIELD,
        labelKey: group.labelKey,
        detail: null,
        detailText: { key: choice.labelKey },
        count: 0,
        negated: false,
      };
    }
  }
  return null;
};

const describeRawFilterField = (query: DiscoveryQuery, field: string): FilterChipDescription | null => {
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
  if (field === 'color') {
    return { ...base, detail: scalar((condition as Record<string, unknown>).hex) };
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

/* -------------------------------------------------------------------------- */
/* Boards colour, shape and width controls                                       */
/* -------------------------------------------------------------------------- */

/**
 * The colour picker's 16 named swatches (Boards prototype `COLOUR_PRESETS`). The id is the value of
 * the `name` select in `frameleaf_boards_colour_name`, so every swatch has a translated name.
 */
export const COLOR_PRESETS = [
  { id: 'red', hex: '#c0392b' },
  { id: 'rust', hex: '#b5523b' },
  { id: 'amber', hex: '#d9a441' },
  { id: 'sand', hex: '#e4c96a' },
  { id: 'green', hex: '#3fb46a' },
  { id: 'olive', hex: '#55582e' },
  { id: 'teal', hex: '#3f8f8a' },
  { id: 'lake', hex: '#45869c' },
  { id: 'blue', hex: '#417cb6' },
  { id: 'navy', hex: '#24495a' },
  { id: 'purple', hex: '#8b6cf0' },
  { id: 'pink', hex: '#d9639b' },
  { id: 'cream', hex: '#eee8e0' },
  { id: 'grey', hex: '#828a8c' },
  { id: 'black', hex: '#141b20' },
  { id: 'white', hex: '#ffffff' },
] as const;

/** The swatch id for a hex, or `other` so the name select falls back to the hex itself. */
export const colorPresetId = (hex: string): string =>
  COLOR_PRESETS.find((preset) => preset.hex === hex.toLowerCase())?.id ?? 'other';

/** The values for `frameleaf_boards_colour_name` (and the pill): the swatch's name, or the hex. */
export const colorNameValues = (hex: string) => ({ name: colorPresetId(hex), hex: hex.toUpperCase() });

/** "How close": the prototype's Exact, Close and Loose are the server's Tight, Normal and Broad. */
export const COLOR_CLOSENESS: readonly { value: ColorTolerance; labelKey: Translations }[] = [
  { value: ColorTolerance.Tight, labelKey: 'frameleaf_boards_colour_exact' },
  { value: ColorTolerance.Normal, labelKey: 'frameleaf_boards_colour_close' },
  { value: ColorTolerance.Broad, labelKey: 'frameleaf_boards_colour_loose' },
];

/** The server's default minimum swatch coverage: any colour that shows in the palette. */
export const COLOR_DEFAULT_MIN_WEIGHT = 0.05;
/**
 * "Only the main colour". The server has no "dominant swatch" predicate, only a minimum coverage, so
 * the main colour is a swatch covering at least a quarter of the picture.
 */
export const COLOR_MAIN_MIN_WEIGHT = 0.25;

export type ColorChoice = { hex: string; tolerance: ColorTolerance; mainOnly: boolean };

export const isHexColor = (value: string) => /^#[\da-f]{6}$/i.test(value);

/** The picker's three controls as a server colour filter. */
export const colorFilterFrom = ({ hex, tolerance, mainOnly }: ColorChoice): ColorFilter => ({
  hex: hex.toLowerCase(),
  tolerance,
  minWeight: mainOnly ? COLOR_MAIN_MIN_WEIGHT : COLOR_DEFAULT_MIN_WEIGHT,
});

/** A stored colour filter read back into the picker's controls. */
export const colorChoiceOf = (color: ColorFilter | undefined): ColorChoice | null =>
  color && isHexColor(color.hex)
    ? {
        hex: color.hex.toLowerCase(),
        tolerance: color.tolerance ?? ColorTolerance.Normal,
        mainOnly: (color.minWeight ?? COLOR_DEFAULT_MIN_WEIGHT) >= COLOR_MAIN_MIN_WEIGHT,
      }
    : null;

/** "Teal · close": the active colour as a pill or chip names it. */
export const colorFilterText = (color: ColorFilter | undefined): FilterText | null => {
  const choice = colorChoiceOf(color);
  return choice
    ? { key: 'frameleaf_boards_colour_pill', values: { ...colorNameValues(choice.hex), closeness: choice.tolerance } }
    : null;
};

/** "Show loose matches": the same colour at the widest distance and any coverage. */
export const looseColorFilter = (color: ColorFilter): ColorFilter =>
  colorFilterFrom({ hex: color.hex, tolerance: ColorTolerance.Broad, mainOnly: false });

export type BoardShape = 'any' | 'landscape' | 'portrait' | 'square' | 'wide';

/** Shapes as aspect-ratio (width ÷ height) ranges, the same cut-offs the prototype's `shapeOf` uses. */
export const BOARD_SHAPES: Record<Exclude<BoardShape, 'any'>, NumberFilterNullable> = {
  landscape: { gt: 1.05, lte: 1.9 },
  portrait: { lt: 0.95 },
  square: { gte: 0.95, lte: 1.05 },
  wide: { gt: 1.9 },
};

export const BOARD_SHAPE_LABEL_KEYS: Record<BoardShape, Translations> = {
  any: 'frameleaf_boards_shape_any',
  landscape: 'frameleaf_boards_shape_landscape',
  portrait: 'frameleaf_boards_shape_portrait',
  square: 'frameleaf_boards_shape_square',
  wide: 'frameleaf_boards_shape_wide',
};

const sameCondition = (a: object, b: object) => {
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = Object.entries(b);
  return left.length === right.length && right.every(([key, value]) => (a as Record<string, unknown>)[key] === value);
};

/** The shape an aspect-ratio condition stands for; `custom` for any other range. */
export const boardShapeOf = (condition: NumberFilterNullable | undefined): BoardShape | 'custom' => {
  if (!condition || Object.keys(condition).length === 0) {
    return 'any';
  }
  const shape = (Object.keys(BOARD_SHAPES) as Exclude<BoardShape, 'any'>[]).find((id) =>
    sameCondition(condition, BOARD_SHAPES[id]),
  );
  return shape ?? 'custom';
};

export const boardShapeCondition = (shape: BoardShape): NumberFilterNullable | undefined =>
  shape === 'any' ? undefined : { ...BOARD_SHAPES[shape] };

/** "At least this wide": any width, 800, 1,200, full HD and 4K. */
export const MINIMUM_WIDTHS = [0, 800, 1200, 1920, 3840] as const;

/** The minimum width a width condition asks for: 0 for none, `custom` for anything else. */
export const minimumWidthOf = (condition: NumberFilterNullable | undefined): number | 'custom' => {
  if (!condition || Object.keys(condition).length === 0) {
    return 0;
  }
  const keys = Object.keys(condition).filter((key) => condition[key as keyof NumberFilterNullable] !== undefined);
  return keys.length === 1 && typeof condition.gte === 'number' ? condition.gte : 'custom';
};

export const minimumWidthCondition = (width: number): NumberFilterNullable | undefined =>
  width > 0 ? { gte: width } : undefined;
