import {
  AssetTypeEnum,
  ImageEnrichmentFilter,
  SearchFacetField,
  type SavedSearch,
  type SearchFacetsResponseDto,
  type SearchFilter,
  type SearchHistogramBucketDto,
} from '@immich/sdk';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import {
  discoveryTextField,
  parseDiscoveryQuery,
  structuredSearchRequest,
  toSearchDto,
  type DiscoveryQuery,
  type DiscoverySearchDto,
  type DiscoveryTextField,
} from '$lib/components/discovery/query';
import type { FilterPanelOptions } from '$lib/frameleaf/search-options';

/**
 * The search palette's pure half (FL-49), ported from
 * `design/frameleaf/template/src/search-palette.mjs` (September 24, 2026).
 *
 * Typed operators (`person:`, `place:`, `tag:`, `type:`, `camera:`, `lens:`, `rating:`, `is:`, `year:`,
 * `month:`, `after:`, `before:`, `file:`, `text:`, `path:`, each with a leading `-` to exclude) become
 * conditions on the server's structured `SearchFilter` — the same shape the results page sends
 * (`structuredSearchRequest`) — so every palette count and result still comes from the metadata-search
 * contract. Nothing is invented: an operator whose value cannot be resolved against the account's own
 * vocabulary, or that the filter cannot express (`-rating:`, `-text:`), stays in the free text exactly
 * as the prototype leaves it, instead of being silently dropped or approximated.
 *
 * Differences from the prototype, all because the server's filter is stricter than the sample search:
 * - `camera:` and `lens:` match by "contains" over the makes, models and lenses the library actually
 *   has (`in`/`notIn`), because `make`, `model` and `lensModel` take no `like` operator.
 * - `file:` and `path:` use `like`/`notLike` without `%`: the server already matches "contains".
 * - `text:` is `ocr.matches`, which has no negation.
 * - Two `place:` (or `type:`) values mean either one (`in`), since one photo has one city.
 */

/* -------------------------------------------------------------------------- */
/* Modes                                                                        */
/* -------------------------------------------------------------------------- */

/** The palette's search modes: smart search, "All text" (every text field) or one text field. */
export type PaletteMode = 'smart' | 'all' | DiscoveryTextField;

export const PALETTE_MODES: readonly {
  value: PaletteMode;
  labelKey: Translations;
  /** @mdi/js icon name, matching `SearchPalette.jsx` `searchModes`. */
  icon: 'smart' | 'all' | 'file' | 'description' | 'ocr' | 'path';
}[] = [
  { value: 'smart', labelKey: 'frameleaf_search_mode_smart', icon: 'smart' },
  { value: 'all', labelKey: 'frameleaf_search_mode_all_text', icon: 'all' },
  { value: 'originalFileName', labelKey: 'frameleaf_search_mode_filename', icon: 'file' },
  { value: 'description', labelKey: 'description', icon: 'description' },
  { value: 'ocr', labelKey: 'frameleaf_search_mode_ocr', icon: 'ocr' },
  { value: 'originalPath', labelKey: 'frameleaf_search_mode_full_path', icon: 'path' },
];

/** The text fields "All text" searches at once: each is one branch of an `or`. */
const ALL_TEXT_FIELDS: readonly DiscoveryTextField[] = ['originalFileName', 'description', 'ocr', 'originalPath'];

const textCondition = (field: DiscoveryTextField, text: string) =>
  field === 'ocr' ? { matches: text } : { like: text };

/** "All text": the text in any text field, as one `or` over the four real text conditions. */
export const allTextBranches = (text: string): NonNullable<SearchFilter['or']> =>
  ALL_TEXT_FIELDS.map((field) => ({ [field]: textCondition(field, text) }));

const MAX_OR_BRANCHES = 64;

/**
 * AND the "All text" `or` into a filter. Without an `or` it is simply added; with one, `(a or b) and
 * (c or d)` is distributed into `(a and c) or …`, skipping a pair only when both sides constrain the same
 * field (a branch cannot carry two conditions on one field). Returns undefined when the product would
 * exceed the server's branch limit, so the caller can refuse instead of widening the search.
 */
export const withAllText = (filter: SearchFilter, text: string): SearchFilter | undefined => {
  const branches = allTextBranches(text);
  if (!filter.or?.length) {
    return { ...filter, or: branches };
  }
  const product: NonNullable<SearchFilter['or']> = [];
  for (const existing of filter.or) {
    for (const branch of branches) {
      const [field] = Object.keys(branch) as (keyof typeof existing)[];
      if (existing[field] === undefined) {
        product.push({ ...existing, ...branch });
      }
    }
  }
  if (product.length === 0 || product.length > MAX_OR_BRANCHES) {
    return undefined;
  }
  return { ...filter, or: product };
};

/** The text an "All text" `or` searches for, when the filter's `or` is exactly one. */
export const readAllText = (filter: SearchFilter | undefined): string | undefined => {
  const branches = filter?.or;
  if (!branches || branches.length !== ALL_TEXT_FIELDS.length) {
    return undefined;
  }
  let text: string | undefined;
  for (const [index, field] of ALL_TEXT_FIELDS.entries()) {
    const branch = branches[index] as Record<string, Record<string, unknown> | undefined>;
    const condition = branch?.[field];
    const keys = Object.keys(branch ?? {});
    const value = field === 'ocr' ? condition?.matches : condition?.like;
    if (keys.length !== 1 || typeof value !== 'string' || Object.keys(condition ?? {}).length !== 1) {
      return undefined;
    }
    if (text !== undefined && text !== value) {
      return undefined;
    }
    text = value;
  }
  return text;
};

/* -------------------------------------------------------------------------- */
/* Operators                                                                    */
/* -------------------------------------------------------------------------- */

export type OperatorKey =
  | 'person'
  | 'place'
  | 'tag'
  | 'type'
  | 'camera'
  | 'lens'
  | 'rating'
  | 'is'
  | 'year'
  | 'month'
  | 'after'
  | 'before'
  | 'file'
  | 'text'
  | 'path';

/** The operators the palette understands; `hint` is shown in the syntax help, as in the prototype. */
export const SEARCH_OPERATORS: readonly { key: OperatorKey; hint: string; labelKey: Translations }[] = [
  { key: 'person', hint: 'person:Jamie', labelKey: 'frameleaf_search_operator_person' },
  { key: 'place', hint: 'place:Banff', labelKey: 'frameleaf_search_operator_place' },
  { key: 'tag', hint: 'tag:water', labelKey: 'frameleaf_search_operator_tag' },
  { key: 'type', hint: 'type:video', labelKey: 'frameleaf_search_operator_type' },
  { key: 'camera', hint: 'camera:Sony', labelKey: 'frameleaf_search_operator_camera' },
  { key: 'lens', hint: 'lens:24-70', labelKey: 'frameleaf_search_operator_lens' },
  { key: 'rating', hint: 'rating:4', labelKey: 'frameleaf_search_operator_rating' },
  { key: 'is', hint: 'is:favorite', labelKey: 'frameleaf_search_operator_is' },
  { key: 'year', hint: 'year:2026', labelKey: 'frameleaf_search_operator_year' },
  { key: 'month', hint: 'month:2026-08', labelKey: 'frameleaf_search_operator_month' },
  { key: 'after', hint: 'after:2026-08-12', labelKey: 'frameleaf_search_operator_after' },
  { key: 'before', hint: 'before:2026-08-15', labelKey: 'frameleaf_search_operator_before' },
  { key: 'file', hint: 'file:IMG_', labelKey: 'frameleaf_search_operator_file' },
  { key: 'text', hint: 'text:"lake agnes"', labelKey: 'frameleaf_search_operator_text' },
  { key: 'path', hint: 'path:2026/', labelKey: 'frameleaf_search_operator_path' },
];

const OPERATOR_KEYS: ReadonlySet<string> = new Set(SEARCH_OPERATORS.map((operator) => operator.key));

/** The search a palette catalog entry counts: a vocabulary value and, when facets supplied it, how many match. */
export type CatalogValue = { value: string; count?: number };

/**
 * The vocabulary operators resolve against: the signed-in account's own people, tags, places, cameras and
 * lenses (`loadFilterPanelOptions`), with counts from `POST /search/facets` where the server returned them.
 */
export type PaletteCatalog = {
  people: { id: string; name: string; count?: number }[];
  tags: { id: string; label: string; count?: number }[];
  places: CatalogValue[];
  makes: CatalogValue[];
  models: CatalogValue[];
  lenses: CatalogValue[];
  years: CatalogValue[];
  typeCounts?: Partial<Record<AssetTypeEnum, number>>;
  favoriteCount?: number;
};

export const emptyPaletteCatalog = (): PaletteCatalog => ({
  people: [],
  tags: [],
  places: [],
  makes: [],
  models: [],
  lenses: [],
  years: [],
});

/** Case- and accent-insensitive comparison form, as `fold` in the prototype. */
export const fold = (value: unknown) =>
  String(value ?? '')
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLocaleLowerCase('en');

/** A typed operator, as parsed. `display` is the resolved value a chip shows (a person's name, a tag's label). */
export type PaletteToken = {
  key: OperatorKey;
  value: string;
  exclude: boolean;
  /** The token exactly as typed, for removing it again. */
  raw: string;
  display: string;
  /** The `SearchFilter` fields this token writes. */
  fields: (keyof SearchFilter)[];
};

export type ParsedPaletteInput = { text: string; filter: SearchFilter; tokens: PaletteToken[] };

/** key:value, key:"quoted value", with an optional leading "-" to exclude. */
const TOKEN = /(^|\s)(-?)([a-z]+):(?:"([^"]*)"|(\S+))/gi;

const DAY_MS = 86_400_000;
const isoInstant = (time: number) => new Date(time).toISOString();

const dateRange = (key: OperatorKey, value: string): { gte?: string; lt?: string } | null => {
  if (key === 'year') {
    if (!/^\d{4}$/.test(value)) {
      return null;
    }
    const year = Number(value);
    return { gte: isoInstant(Date.UTC(year, 0, 1)), lt: isoInstant(Date.UTC(year + 1, 0, 1)) };
  }
  if (key === 'month') {
    const match = value.match(/^(\d{4})-(\d{1,2})$/);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
      return null;
    }
    const [year, month] = [Number(match[1]), Number(match[2]) - 1];
    return { gte: isoInstant(Date.UTC(year, month, 1)), lt: isoInstant(Date.UTC(year, month + 1, 1)) };
  }
  const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const time = Date.UTC(year, month, day);
  const date = new Date(time);
  // 2026-02-30 is refused rather than rolled over into March
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    return null;
  }
  // after: leaves its own day out and before: is exclusive, exactly as the prototype reads them
  return key === 'after' ? { gte: isoInstant(time + DAY_MS) } : { lt: isoInstant(time) };
};

const later = (a: string | undefined, b: string) => (a === undefined || Date.parse(b) > Date.parse(a) ? b : a);
const earlier = (a: string | undefined, b: string) => (a === undefined || Date.parse(b) < Date.parse(a) ? b : a);

/** Values of a vocabulary that contain the needle; an exact match alone wins. */
const containing = (values: CatalogValue[], needle: string): string[] => {
  const target = fold(needle);
  const exact = values.filter((item) => fold(item.value) === target).map((item) => item.value);
  if (exact.length > 0) {
    return exact;
  }
  return [...new Set(values.filter((item) => fold(item.value).includes(target)).map((item) => item.value))];
};

type StringListCondition = { eq?: string; ne?: string; in?: string[]; notIn?: string[] };

/** Include values become `eq`/`in`, excluded ones `ne`/`notIn`, merged with what the field already had. */
const withStringValues = (
  current: StringListCondition | undefined,
  values: string[],
  exclude: boolean,
): StringListCondition => {
  const include = new Set([...(current?.eq === undefined ? [] : [current.eq]), ...(current?.in ?? [])]);
  const omit = new Set([...(current?.ne === undefined ? [] : [current.ne]), ...(current?.notIn ?? [])]);
  for (const value of values) {
    (exclude ? omit : include).add(value);
  }
  const result: StringListCondition = {};
  if (include.size === 1) {
    result.eq = [...include][0];
  } else if (include.size > 1) {
    result.in = [...include];
  }
  if (omit.size === 1) {
    result.ne = [...omit][0];
  } else if (omit.size > 1) {
    result.notIn = [...omit];
  }
  return result;
};

type IdsCondition = { any?: string[]; all?: string[]; none?: string[] };

const withId = (current: IdsCondition | undefined, id: string, exclude: boolean): IdsCondition => {
  const bucket = exclude ? 'none' : 'all';
  return { ...current, [bucket]: [...new Set([...(current?.[bucket] ?? []), id])] };
};

const TYPE_WORDS: Readonly<Record<string, AssetTypeEnum>> = {
  photo: AssetTypeEnum.Image,
  photos: AssetTypeEnum.Image,
  image: AssetTypeEnum.Image,
  images: AssetTypeEnum.Image,
  video: AssetTypeEnum.Video,
  videos: AssetTypeEnum.Video,
};

const byName = <T extends { id: string }>(items: T[], value: string, name: (item: T) => string) =>
  items.find((item) => fold(item.id) === fold(value) || fold(name(item)) === fold(value));

/**
 * Split palette input into free text and structured filters. Unknown or unresolvable operators are left
 * in the free text so nothing is silently dropped.
 */
export const parseSearchInput = (
  input: string,
  catalog: PaletteCatalog = emptyPaletteCatalog(),
): ParsedPaletteInput => {
  const source = (input ?? '').slice(0, 500);
  const filter: Record<string, unknown> = {};
  const tokens: PaletteToken[] = [];

  const text = source.replaceAll(
    TOKEN,
    (raw: string, lead: string, minus: string, rawKey: string, quoted?: string, bare?: string) => {
      const key = rawKey.toLowerCase() as OperatorKey;
      const value = (quoted ?? bare ?? '').trim();
      const exclude = minus === '-';
      if (!OPERATOR_KEYS.has(key) || !value) {
        return raw;
      }
      const resolved = resolveToken(filter, key, value, exclude, catalog);
      if (!resolved) {
        return raw;
      }
      tokens.push({ key, value, exclude, raw: raw.trim(), ...resolved });
      return lead;
    },
  );
  return { text: text.replaceAll(/\s+/g, ' ').trim(), filter: filter as SearchFilter, tokens };
};

/** Writes one operator into the filter; returns what its chip shows, or null to leave it as text. */
const resolveToken = (
  filter: Record<string, unknown>,
  key: OperatorKey,
  value: string,
  exclude: boolean,
  catalog: PaletteCatalog,
): { display: string; fields: (keyof SearchFilter)[] } | null => {
  switch (key) {
    case 'person': {
      // Unnamed people have no name to type, so only named people resolve
      const person = byName(
        catalog.people.filter((item) => item.name),
        value,
        (item) => item.name,
      );
      if (!person) {
        return null;
      }
      filter.personIds = withId(filter.personIds as IdsCondition, person.id, exclude);
      return { display: person.name, fields: ['personIds'] };
    }
    case 'tag': {
      const tag = byName(catalog.tags, value, (item) => item.label);
      if (!tag) {
        return null;
      }
      filter.tagIds = withId(filter.tagIds as IdsCondition, tag.id, exclude);
      return { display: tag.label, fields: ['tagIds'] };
    }
    case 'place': {
      const place = catalog.places.find((item) => fold(item.value) === fold(value))?.value ?? value;
      filter.city = withStringValues(filter.city as StringListCondition, [place], exclude);
      return { display: place, fields: ['city'] };
    }
    case 'type': {
      const type = TYPE_WORDS[value.toLowerCase()];
      if (!type) {
        return null;
      }
      filter.type = withStringValues(filter.type as StringListCondition, [type], exclude);
      return { display: type, fields: ['type'] };
    }
    case 'camera': {
      const makes = containing(catalog.makes, value);
      const models = makes.length > 0 ? [] : containing(catalog.models, value);
      const field = makes.length > 0 ? 'make' : 'model';
      const values = makes.length > 0 ? makes : models;
      if (values.length === 0) {
        return null;
      }
      filter[field] = withStringValues(filter[field] as StringListCondition, values, exclude);
      return { display: values.length === 1 ? values[0] : value, fields: [field] };
    }
    case 'lens': {
      const lenses = containing(catalog.lenses, value);
      if (lenses.length === 0) {
        return null;
      }
      filter.lensModel = withStringValues(filter.lensModel as StringListCondition, lenses, exclude);
      return { display: lenses.length === 1 ? lenses[0] : value, fields: ['lensModel'] };
    }
    case 'rating': {
      if (!/^[0-5]$/.test(value) || exclude) {
        return null;
      }
      filter.rating = { gte: Number(value) };
      return { display: value, fields: ['rating'] };
    }
    case 'is': {
      if (!/^(fav|favou?rites?)$/i.test(value)) {
        return null;
      }
      filter.isFavorite = { eq: !exclude };
      return { display: value, fields: ['isFavorite'] };
    }
    case 'year':
    case 'month':
    case 'after':
    case 'before': {
      const range = dateRange(key, value);
      if (!range || exclude) {
        return null;
      }
      const current = (filter.takenAt ?? {}) as { gte?: string; lt?: string };
      filter.takenAt = {
        ...current,
        ...(range.gte && { gte: later(current.gte, range.gte) }),
        ...(range.lt && { lt: earlier(current.lt, range.lt) }),
      };
      return { display: value, fields: ['takenAt'] };
    }
    case 'text': {
      if (exclude) {
        return null;
      }
      filter.ocr = { matches: value };
      return { display: value, fields: ['ocr'] };
    }
    case 'file':
    case 'path': {
      const field = key === 'file' ? 'originalFileName' : 'originalPath';
      filter[field] = exclude ? { notLike: value } : { like: value };
      return { display: value, fields: [field] };
    }
  }
};

/** Formats a token's chip label, e.g. "Not Jamie", "Camera: Sony", "4★ or more". */
export const tokenLabel = ($t: MessageFormatter, token: Pick<PaletteToken, 'key' | 'display' | 'exclude'>) => {
  const value = token.display;
  let label: string;
  switch (token.key) {
    case 'type': {
      label = $t(value === AssetTypeEnum.Video ? 'videos' : 'photos');
      break;
    }
    case 'camera': {
      label = $t('frameleaf_search_token_camera', { values: { value } });
      break;
    }
    case 'lens': {
      label = $t('frameleaf_search_token_lens', { values: { value } });
      break;
    }
    case 'rating': {
      label = $t('frameleaf_search_token_rating', { values: { count: Number(value) } });
      break;
    }
    case 'is': {
      label = $t('favorites');
      break;
    }
    case 'after': {
      label = $t('frameleaf_search_token_after', { values: { value } });
      break;
    }
    case 'before': {
      label = $t('frameleaf_search_token_before', { values: { value } });
      break;
    }
    case 'file': {
      label = $t('frameleaf_search_token_file', { values: { value } });
      break;
    }
    case 'text': {
      label = $t('frameleaf_search_token_text', { values: { value } });
      break;
    }
    case 'path': {
      label = $t('frameleaf_search_token_path', { values: { value } });
      break;
    }
    default: {
      label = value;
    }
  }
  return token.exclude ? $t('frameleaf_search_token_not', { values: { label } }) : label;
};

/** Removes one operator token (by its raw text) from the input. */
export const removeSearchToken = (input: string, raw: string) => {
  const index = input.indexOf(raw);
  if (index === -1) {
    return input;
  }
  return `${input.slice(0, index)}${input.slice(index + raw.length)}`.replaceAll(/\s+/g, ' ').trim();
};

/** A completed operator token (followed by a space) becomes a chip; a trailing one stays editable. */
const COMPLETE_TOKEN = /(^|\s)(-?[a-z]+:(?:"[^"]*"|\S+))\s/i;

/**
 * Moves every completed, resolvable operator out of the typed text into chips, as the prototype's
 * `commitTokens` does on each change. What cannot be resolved stays in the text.
 */
export const commitCompletedTokens = (value: string, catalog: PaletteCatalog): { tokens: string[]; rest: string } => {
  let rest = value;
  const tokens: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const match = rest.slice(searchFrom).match(COMPLETE_TOKEN);
    if (!match || match.index === undefined) {
      break;
    }
    const start = searchFrom + match.index;
    const raw = match[2];
    if (parseSearchInput(raw, catalog).tokens.length === 0) {
      // Unresolvable: leave it where it is and keep looking after it
      searchFrom = start + match[0].length - 1;
      continue;
    }
    tokens.push(raw);
    rest = `${rest.slice(0, start)}${match[1]}${rest.slice(start + match[0].length)}`;
    searchFrom = start;
  }
  return { tokens, rest: rest.replace(/^\s+/, '') };
};

/** The raw token for a key and value, quoting a value with spaces. */
export const operatorToken = (key: OperatorKey, value: string, exclude = false) =>
  `${exclude ? '-' : ''}${key}:${/\s/.test(value) ? `"${value}"` : value}`;

/** The `SearchFilter` fields a raw token writes, or none when it does not resolve. */
export const tokenFields = (raw: string, catalog: PaletteCatalog): (keyof SearchFilter)[] =>
  parseSearchInput(raw, catalog).tokens.flatMap((token) => token.fields);

/**
 * A graphical pick in the Advanced view replaces any typed chip for the same field, so the two never
 * disagree about what is being searched (`setAdvancedCondition` in `SearchPalette.jsx`).
 */
export const withoutTokensForFields = (tokens: string[], fields: Iterable<string>, catalog: PaletteCatalog) => {
  const replaced = new Set(fields);
  return tokens.filter((raw) => tokenFields(raw, catalog).every((field) => !replaced.has(field)));
};

/* -------------------------------------------------------------------------- */
/* Typeahead                                                                    */
/* -------------------------------------------------------------------------- */

export type SuggestionKind = 'person' | 'place' | 'tag' | 'camera' | 'year' | 'type' | 'is' | 'operator';

export type PaletteSuggestion = {
  kind: SuggestionKind;
  /** The value shown; for `type` and `is` an i18n key is carried in `labelKey` instead. */
  label: string;
  labelKey?: Translations;
  /** The token the suggestion inserts, shown beside it (`person:Jamie`). */
  detail: string;
  count?: number;
  /** The whole new input: the fragment being typed is replaced by the token. */
  insert: string;
  /** For person suggestions, so the row can show their face photo. */
  personId?: string;
};

/**
 * Typeahead for the word being typed. Completions replace that word with an operator token, most
 * relevant first: a prefix match, then more matches, then alphabetical. Unnamed people are skipped:
 * they have no name to type, so they cannot be a `person:` token.
 */
export const suggestSearchTokens = (input: string, catalog: PaletteCatalog, limit = 8): PaletteSuggestion[] => {
  const source = input ?? '';
  const match = source.match(/(^|\s)(-?)([^\s:]*)(?::("?)([^"]*))?$/);
  if (!match) {
    return [];
  }
  const minus = match[2];
  const head = match[3];
  const tail = match[5] as string | undefined;
  const fragmentStart = source.length - match[0].trimStart().length;
  const hasOperator = tail !== undefined;
  const typedKey = fold(head);
  const needle = fold(hasOperator ? tail : head);
  if (!hasOperator && needle.length === 0) {
    return [];
  }
  const replace = (token: string) => `${source.slice(0, fragmentStart)}${minus}${token} `;
  const out: (PaletteSuggestion & { rank: number })[] = [];
  const push = (
    kind: SuggestionKind,
    key: OperatorKey,
    value: string,
    label: string,
    count: number | undefined,
    extra: Partial<PaletteSuggestion> = {},
  ) => {
    if (hasOperator && typedKey !== key) {
      return;
    }
    const haystack = fold(value);
    const labelHaystack = fold(label);
    const hit = (text: string) =>
      !needle || text.startsWith(needle) || text.includes(` ${needle}`) || (needle.length > 2 && text.includes(needle));
    if (!hit(haystack) && !hit(labelHaystack)) {
      return;
    }
    const token = operatorToken(key, value);
    out.push({
      kind,
      label,
      detail: token,
      count,
      insert: replace(token),
      rank: haystack.startsWith(needle) || labelHaystack.startsWith(needle) ? 0 : 1,
      ...extra,
    });
  };

  for (const person of catalog.people) {
    if (person.name) {
      push('person', 'person', person.name, person.name, person.count, { personId: person.id });
    }
  }
  for (const place of catalog.places) {
    push('place', 'place', place.value, place.value, place.count);
  }
  for (const tag of catalog.tags) {
    push('tag', 'tag', tag.label, tag.label, tag.count);
  }
  for (const make of catalog.makes) {
    push('camera', 'camera', make.value, make.value, make.count);
  }
  for (const year of catalog.years) {
    push('year', 'year', year.value, year.value, year.count);
  }
  push('type', 'type', 'photo', 'photo', catalog.typeCounts?.[AssetTypeEnum.Image], { labelKey: 'photos' });
  push('type', 'type', 'video', 'video', catalog.typeCounts?.[AssetTypeEnum.Video], { labelKey: 'videos' });
  push('is', 'is', 'favorite', 'favorite', catalog.favoriteCount, { labelKey: 'favorites' });
  if (!hasOperator && typedKey.length >= 2) {
    for (const operator of SEARCH_OPERATORS) {
      if (operator.key.startsWith(typedKey)) {
        out.push({
          kind: 'operator',
          label: operator.key,
          labelKey: operator.labelKey,
          detail: operator.hint,
          insert: `${source.slice(0, fragmentStart)}${minus}${operator.key}:`,
          rank: 2,
        });
      }
    }
  }
  return out
    .sort((a, b) => a.rank - b.rank || (b.count ?? -1) - (a.count ?? -1) || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ rank: _, ...item }) => item);
};

/* -------------------------------------------------------------------------- */
/* Facets and the catalog                                                       */
/* -------------------------------------------------------------------------- */

export type FacetValue = { value: string; label?: string | null; count: number };
export type PaletteFacets = Partial<Record<SearchFacetField, FacetValue[]>>;

/** The facets response keyed by field, busiest first as the server returns them. */
export const facetsByField = (response: SearchFacetsResponseDto | null | undefined): PaletteFacets => {
  const result: PaletteFacets = {};
  for (const facet of response?.facets ?? []) {
    result[facet.fieldName as SearchFacetField] = facet.counts.map(({ value, label, count }) => ({
      value,
      label,
      count,
    }));
  }
  return result;
};

const countsOf = (facets: FacetValue[] | undefined) => new Map((facets ?? []).map((item) => [item.value, item.count]));

/** Vocabulary values with their counts; values only the facets know are added so nothing counted is hidden. */
const withCounts = (values: string[], facets: FacetValue[] | undefined): CatalogValue[] => {
  const counts = countsOf(facets);
  const all = new Set([...values, ...(facets ?? []).map((item) => item.value)]);
  return [...all].filter(Boolean).map((value) => ({ value, count: counts.get(value) }));
};

/**
 * The typeahead catalog: the account's own vocabularies, with counts for the current scope from
 * `POST /search/facets` and years from a year histogram. People and tags keep only what the vocabulary
 * lists (hidden people are already left out there).
 */
export const buildPaletteCatalog = (
  options: FilterPanelOptions,
  facets: PaletteFacets = {},
  years: SearchHistogramBucketDto[] = [],
): PaletteCatalog => {
  const people = countsOf(facets[SearchFacetField.People]);
  const tags = countsOf(facets[SearchFacetField.Tags]);
  const types = countsOf(facets[SearchFacetField.Type]);
  const favorite = countsOf(facets[SearchFacetField.IsFavorite]);
  return {
    people: options.people.map((person) => ({ id: person.id, name: person.name, count: people.get(person.id) })),
    tags: options.tags.map((tag) => ({ id: tag.value, label: tag.label, count: tags.get(tag.value) })),
    places: withCounts(options.cities, facets[SearchFacetField.City]),
    makes: withCounts(options.makes, facets[SearchFacetField.Make]),
    models: withCounts(options.models, facets[SearchFacetField.Model]),
    lenses: withCounts(options.lenses, facets[SearchFacetField.LensModel]),
    years: years.map((bucket) => ({ value: bucket.date.slice(0, 4), count: bucket.count })),
    typeCounts:
      types.size > 0
        ? {
            [AssetTypeEnum.Image]: types.get(AssetTypeEnum.Image) ?? 0,
            [AssetTypeEnum.Video]: types.get(AssetTypeEnum.Video) ?? 0,
          }
        : undefined,
    favoriteCount: favorite.size > 0 ? (favorite.get('true') ?? 0) : undefined,
  };
};

/* -------------------------------------------------------------------------- */
/* Date histogram                                                               */
/* -------------------------------------------------------------------------- */

export type HistogramUnit = 'day' | 'month' | 'year';

/** One bar: `[start, end)` as UTC calendar days, and how many matches it holds (zero for a gap). */
export type HistogramBar = { start: string; end: string; count: number };

const dayOf = (time: number) => new Date(time).toISOString().slice(0, 10);
const parseDay = (day: string) => Date.parse(`${day.slice(0, 10)}T00:00:00.000Z`);

const startOf = (time: number, unit: HistogramUnit) => {
  const date = new Date(time);
  const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  return unit === 'day' ? Date.UTC(y, m, d) : unit === 'month' ? Date.UTC(y, m, 1) : Date.UTC(y, 0, 1);
};

const nextOf = (time: number, unit: HistogramUnit) => {
  const date = new Date(time);
  const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
  return unit === 'day' ? Date.UTC(y, m, d + 1) : unit === 'month' ? Date.UTC(y, m + 1, 1) : Date.UTC(y + 1, 0, 1);
};

/**
 * The prototype adapts granularity to the span: days (≤ 62 days), months (≤ 3 years) or years. The
 * server buckets for us, so the palette asks for months first and uses this to decide whether to ask
 * again for days or to fold the months into years.
 */
export const histogramUnitFor = (monthBuckets: Pick<SearchHistogramBucketDto, 'date'>[]): HistogramUnit => {
  if (monthBuckets.length === 0) {
    return 'month';
  }
  const first = parseDay(monthBuckets[0].date);
  const last = nextOf(parseDay(monthBuckets.at(-1)!.date), 'month');
  const span = last - first;
  return span <= 62 * DAY_MS ? 'day' : span <= 3 * 366 * DAY_MS ? 'month' : 'year';
};

/** Folds month (or day) buckets into years, for spans longer than three years. */
export const bucketsByYear = (buckets: SearchHistogramBucketDto[]): SearchHistogramBucketDto[] => {
  const years = new Map<string, number>();
  for (const bucket of buckets) {
    const year = `${bucket.date.slice(0, 4)}-01-01`;
    years.set(year, (years.get(year) ?? 0) + bucket.count);
  }
  return [...years].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
};

const MAX_BARS = 400;

/** Every bar from the first bucket to the last, empty ones included so gaps in the library read as gaps. */
export const histogramBars = (buckets: SearchHistogramBucketDto[], unit: HistogramUnit): HistogramBar[] => {
  if (buckets.length === 0) {
    return [];
  }
  const counts = new Map<number, number>();
  for (const bucket of buckets) {
    const key = startOf(parseDay(bucket.date), unit);
    counts.set(key, (counts.get(key) ?? 0) + bucket.count);
  }
  const keys = [...counts.keys()];
  const min = Math.min(...keys);
  const max = Math.max(...keys);
  const bars: HistogramBar[] = [];
  for (let time = min; time <= max && bars.length < MAX_BARS; time = nextOf(time, unit)) {
    bars.push({ start: dayOf(time), end: dayOf(nextOf(time, unit)), count: counts.get(time) ?? 0 });
  }
  return bars;
};

/** A bar's label: "Aug 12", "Aug 2026" or "2026", in the viewer's language. */
export const histogramBarLabel = (bar: HistogramBar, unit: HistogramUnit, locale?: string) => {
  const date = new Date(parseDay(bar.start));
  if (unit === 'year') {
    return String(date.getUTCFullYear());
  }
  return date.toLocaleDateString(locale, {
    timeZone: 'UTC',
    ...(unit === 'day' ? { month: 'short', day: 'numeric' } : { month: 'short', year: 'numeric' }),
  });
};

const DATE_TOKEN = /^-?(after|before|year|month):/i;

/**
 * Clicking a bar narrows to it: `after:` leaves its own day out and `before:` is exclusive, so the bar
 * `[start, end)` is bracketed as `after:start-1 before:end`. Any typed date chip is replaced.
 */
export const narrowToBar = (tokens: string[], bar: HistogramBar): string[] => [
  ...tokens.filter((raw) => !DATE_TOKEN.test(raw)),
  `after:${dayOf(parseDay(bar.start) - DAY_MS)}`,
  `before:${bar.end}`,
];

/* -------------------------------------------------------------------------- */
/* Compiling the palette into the shared query                                  */
/* -------------------------------------------------------------------------- */

/** What the palette holds besides its typed text: its mode and the graphical (non-typed) query. */
export type PaletteState = { input: string; mode: PaletteMode; base: DiscoveryQuery };

/**
 * The palette's query: the base (scope and graphical picks) with the typed filters over it — a typed
 * condition wins for its field, as `{ ...extra, ...parsed.filter }` in the prototype — and the free text
 * in the mode's field. "All text" becomes an `or` over every text field. Returns undefined only when
 * "All text" cannot be combined with an existing `or` inside the server's limits.
 */
export const compilePaletteQuery = (
  base: DiscoveryQuery,
  parsed: Pick<ParsedPaletteInput, 'text' | 'filter'>,
  mode: PaletteMode,
): DiscoveryQuery | undefined => {
  const result = structuredClone(base);
  result.filter = { ...result.filter, ...structuredClone(parsed.filter) };
  const text = parsed.text.trim();
  delete result.textField;
  if (mode === 'smart') {
    result.mode = 'smart';
    result.text = text;
    return result;
  }
  result.mode = 'text';
  if (mode === 'all') {
    result.text = '';
    if (text) {
      const filter = withAllText(result.filter, text);
      if (!filter) {
        return undefined;
      }
      result.filter = filter;
    }
    return result;
  }
  result.text = text;
  if (mode !== 'originalFileName') {
    result.textField = mode;
  }
  return result;
};

/** The palette state a query opens in: an "All text" `or` becomes the text again. */
export const readPaletteState = (query: DiscoveryQuery): PaletteState => {
  const base = structuredClone(query);
  const allText = readAllText(base.filter);
  if (allText !== undefined && !base.text) {
    delete base.filter.or;
    delete base.textField;
    return { input: allText, mode: 'all', base: { ...base, mode: 'text' } };
  }
  const input = base.text;
  const mode: PaletteMode = base.mode === 'smart' ? 'smart' : discoveryTextField(base);
  base.text = '';
  delete base.textField;
  return { input, mode, base };
};

/** The request body every palette count, facet and histogram shares: the results page's own. */
export const paletteSearchBody = (query: DiscoveryQuery): DiscoverySearchDto =>
  structuredSearchRequest(toSearchDto(query));

/** A body for the statistics, facets and histogram endpoints: only what they accept. */
export const paletteStatisticsBody = (body: DiscoverySearchDto) => ({
  ...(body.filter && { filter: body.filter }),
  ...(body.imageEnrichment && { imageEnrichment: body.imageEnrichment }),
});

/** Smart search runs when there is smart text or a similar-photo reference, as on the results page. */
export const isSmartBody = (body: DiscoverySearchDto) => !!(body.query || body.queryAssetId);

/* -------------------------------------------------------------------------- */
/* Scope                                                                        */
/* -------------------------------------------------------------------------- */

export type PaletteScope = { kind: 'album' | 'pet' | 'space'; id: string };

/** The collection a query is scoped to, as `contextDiscoveryState` writes it for an album, pet or space page. */
export const paletteScopeOf = (query: DiscoveryQuery): PaletteScope | undefined => {
  if (query.spaceId) {
    return { kind: 'space', id: query.spaceId };
  }
  const pets = query.filter.petIds?.any;
  if (pets?.length === 1) {
    return { kind: 'pet', id: pets[0] };
  }
  const albums = query.filter.albumIds?.any;
  if (albums?.length === 1) {
    return { kind: 'album', id: albums[0] };
  }
  return undefined;
};

/** The query over the entire library: the same search without the collection it was scoped to. */
export const withoutPaletteScope = (query: DiscoveryQuery, scope: PaletteScope | undefined): DiscoveryQuery => {
  const result = structuredClone(query);
  if (!scope) {
    return result;
  }
  if (scope.kind === 'space') {
    delete result.spaceId;
    return result;
  }
  const field = scope.kind === 'pet' ? 'petIds' : 'albumIds';
  const condition = result.filter[field];
  if (!condition) {
    return result;
  }
  const next = { ...condition };
  for (const group of ['any', 'all'] as const) {
    const ids = (next[group] ?? []).filter((id) => id !== scope.id);
    if (ids.length > 0) {
      next[group] = ids;
    } else {
      delete next[group];
    }
  }
  if (Object.keys(next).length === 0) {
    delete result.filter[field];
  } else {
    result.filter[field] = next;
  }
  return result;
};

/** The query kept inside its collection: the scope's condition is required again if an edit dropped it. */
export const withPaletteScope = (query: DiscoveryQuery, scope: PaletteScope | undefined): DiscoveryQuery => {
  const result = structuredClone(query);
  if (!scope) {
    return result;
  }
  if (scope.kind === 'space') {
    result.spaceId = scope.id;
    return result;
  }
  const field = scope.kind === 'pet' ? 'petIds' : 'albumIds';
  // As `requireId` in search-context.ts: an `any` of several ids no longer confines to the scope, so
  // the scope then joins `all`
  const condition = result.filter[field];
  if (!condition) {
    result.filter[field] = { any: [scope.id] };
  } else if (
    !(condition.all ?? []).includes(scope.id) &&
    !(condition.any?.length === 1 && condition.any[0] === scope.id)
  ) {
    result.filter[field] = { ...condition, all: [...new Set([...(condition.all ?? []), scope.id])] };
  }
  return result;
};

/** "1,204", or "1,000+" when smart search stopped counting at its cap. */
export const formatScopeCount = (count: { total: number; capped?: boolean } | null | undefined, locale?: string) =>
  count ? `${count.total.toLocaleString(locale)}${count.capped ? '+' : ''}` : '…';

/* -------------------------------------------------------------------------- */
/* Recent and saved searches                                                    */
/* -------------------------------------------------------------------------- */

/** A search the palette can restore exactly: its typed input (chips included), mode and base query. */
export type PaletteSearch = { input: string; mode: PaletteMode; query: DiscoveryQuery };

export const RECENT_SEARCH_LIMIT = 5;
export const SAVED_SEARCH_LIMIT = 50;
export const SAVED_SEARCH_NAME_LIMIT = 100;

/** Most recent first, one entry per input and mode (`applySearch` in the prototype's App.jsx). */
export const rememberRecentSearch = (recent: PaletteSearch[], entry: PaletteSearch): PaletteSearch[] => {
  const input = entry.input.trim();
  if (!input) {
    return recent;
  }
  return [{ ...entry, input }, ...recent.filter((item) => item.input !== input || item.mode !== entry.mode)].slice(
    0,
    RECENT_SEARCH_LIMIT,
  );
};

const PALETTE_MODE_VALUES: ReadonlySet<string> = new Set(PALETTE_MODES.map((mode) => mode.value));

/**
 * A saved search's stored body. It is the portable query (`DiscoveryQuery`, the body the web hands to
 * the search endpoints) plus the palette's typed input and mode, so reopening it restores the chips.
 * Person, pet and tag ids stay in the query, which is what lets the server leave out a saved search that
 * names something Locked while the session is locked.
 */
export const toSavedSearch = (name: string, search: PaletteSearch): SavedSearch => ({
  name: name.trim().slice(0, SAVED_SEARCH_NAME_LIMIT),
  query: { ...search.query, palette: { input: search.input, mode: search.mode } },
});

/** Reads a saved search back; one written by another client, or damaged, is refused rather than guessed. */
export const fromSavedSearch = (saved: SavedSearch): PaletteSearch | undefined => {
  const parsed = parseDiscoveryQuery(saved.query);
  if (!parsed.ok) {
    return undefined;
  }
  const palette = (saved.query as { palette?: { input?: unknown; mode?: unknown } }).palette;
  const input = typeof palette?.input === 'string' ? palette.input : parsed.query.text;
  const mode =
    typeof palette?.mode === 'string' && PALETTE_MODE_VALUES.has(palette.mode)
      ? (palette.mode as PaletteMode)
      : parsed.query.mode === 'smart'
        ? 'smart'
        : discoveryTextField(parsed.query);
  return { input, mode, query: parsed.query };
};

/** Adds or replaces (by name, ignoring case) a saved search, newest first, within the server's limit. */
export const upsertSavedSearch = (list: SavedSearch[], entry: SavedSearch): SavedSearch[] =>
  [entry, ...list.filter((item) => item.name.toLocaleLowerCase() !== entry.name.toLocaleLowerCase())].slice(
    0,
    SAVED_SEARCH_LIMIT,
  );

export const removeSavedSearch = (list: SavedSearch[], name: string): SavedSearch[] =>
  list.filter((item) => item.name !== name);

/* -------------------------------------------------------------------------- */
/* Enrichment quick filters                                                     */
/* -------------------------------------------------------------------------- */

/** The quick filters `SearchPalette.jsx` shows, mapped onto the server's real enrichment enum. */
export const PALETTE_ENRICHMENT_FILTERS: readonly {
  value: ImageEnrichmentFilter;
  labelKey: Translations;
  icon: 'description' | 'failed' | 'review';
}[] = [
  {
    value: ImageEnrichmentFilter.MissingImageDescription,
    labelKey: 'frameleaf_search_quick_description_missing',
    icon: 'description',
  },
  {
    value: ImageEnrichmentFilter.ImageDescriptionFailed,
    labelKey: 'image_enrichment_filter_description_failed',
    icon: 'failed',
  },
  { value: ImageEnrichmentFilter.NsfwReview, labelKey: 'frameleaf_search_quick_sensitivity_review', icon: 'review' },
];
