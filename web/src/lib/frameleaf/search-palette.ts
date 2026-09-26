import {
  AssetTypeEnum,
  ClassificationMediaType,
  ImageEnrichmentFilter,
  type ClassificationRuleCreateDto,
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
 * - `file:`, `path:`, `camera:` and `lens:` use `like`/`notLike` without `%`: the server already matches
 *   "contains" (make, model and lensModel take the pattern operators since FL-49).
 * - `text:` is `ocr.matches`, which has no negation.
 * - Two `place:` (or `type:`) values mean either one (`in`), since one photo has one city.
 * - Dates (`year:`, `month:`, `after:`, `before:` and a histogram bar) narrow `localDateTime`, the local
 *   capture date the histogram buckets by, so a bar selects exactly what it counts.
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
  /** The person or tag id a `person:` or `tag:` token resolved to (for the chip's face photo). */
  id?: string;
};

export type ParsedPaletteInput = { text: string; filter: SearchFilter; tokens: PaletteToken[] };

/**
 * The most free text the palette searches; longer text is cut and the palette says so. Typed chips are
 * parsed one by one and never cut.
 */
export const MAX_PALETTE_TEXT = 500;
/** A bound on the work one parse does, far above anything a person types. */
const MAX_PARSE_INPUT = 8192;

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

/** A "contains" (or, excluded, "does not contain") condition, kept beside what the field already had. */
const withPattern = (current: unknown, value: string, exclude: boolean) => ({
  ...(current as Record<string, unknown> | undefined),
  [exclude ? 'notLike' : 'like']: value,
});

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
  const source = (input ?? '').slice(0, MAX_PARSE_INPUT);
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
): { display: string; fields: (keyof SearchFilter)[]; id?: string } | null => {
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
      return { display: person.name, fields: ['personIds'], id: person.id };
    }
    case 'tag': {
      const tag = byName(catalog.tags, value, (item) => item.label);
      if (!tag) {
        return null;
      }
      filter.tagIds = withId(filter.tagIds as IdsCondition, tag.id, exclude);
      return { display: tag.label, fields: ['tagIds'], id: tag.id };
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
      // As the prototype: a make the library has, exactly; else a model containing it; else a make containing it
      const make = catalog.makes.find((item) => fold(item.value) === fold(value))?.value;
      // An exclusion is always "does not contain", which keeps photos with no camera at all, as the
      // prototype's -camera: does (search.mjs compares an absent make as empty text)
      if (make && !exclude) {
        filter.make = withStringValues(filter.make as StringListCondition, [make], false);
        return { display: make, fields: ['make'] };
      }
      if (make) {
        filter.make = withPattern(filter.make, make, true);
        return { display: make, fields: ['make'] };
      }
      const field = catalog.models.some((item) => fold(item.value).includes(fold(value))) ? 'model' : 'make';
      filter[field] = withPattern(filter[field], value, exclude);
      return { display: value, fields: [field] };
    }
    case 'lens': {
      filter.lensModel = withPattern(filter.lensModel, value, exclude);
      return { display: value, fields: ['lensModel'] };
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
      const current = (filter.localDateTime ?? {}) as { gte?: string; lt?: string };
      filter.localDateTime = {
        ...current,
        ...(range.gte && { gte: later(current.gte, range.gte) }),
        ...(range.lt && { lt: earlier(current.lt, range.lt) }),
      };
      return { display: value, fields: ['localDateTime'] };
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
/* Typed chips from a query                                                     */
/* -------------------------------------------------------------------------- */

type Condition = Record<string, unknown>;

const isCondition = (value: unknown): value is Condition =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const personName = (catalog: PaletteCatalog, id: string) =>
  catalog.people.find((item) => item.id === id)?.name || undefined;
const tagName = (catalog: PaletteCatalog, id: string) => catalog.tags.find((item) => item.id === id)?.label;

const dayBefore = (instant: string) => new Date(Date.parse(instant) - DAY_MS).toISOString().slice(0, 10);
const isMidnight = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/.test(value);

/** The typed tokens that would write exactly this condition, or undefined when none can. */
const candidateTokens = (field: string, condition: Condition, catalog: PaletteCatalog): string[] | undefined => {
  const values = (operator: string) => {
    const value = condition[operator];
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
  };
  const both = (key: OperatorKey, include: unknown[], exclude: unknown[]) => [
    ...include.map((value) => operatorToken(key, String(value))),
    ...exclude.map((value) => operatorToken(key, String(value), true)),
  ];
  switch (field) {
    case 'personIds':
    case 'tagIds': {
      if (condition.any !== undefined) {
        return undefined;
      }
      const name = field === 'personIds' ? personName : tagName;
      const key = field === 'personIds' ? 'person' : 'tag';
      const ids = [...values('all'), ...values('none')] as string[];
      if (ids.some((id) => !name(catalog, id))) {
        return undefined;
      }
      return both(
        key,
        values('all').map((id) => name(catalog, id as string)),
        values('none').map((id) => name(catalog, id as string)),
      );
    }
    case 'city': {
      return both('place', [...values('eq'), ...values('in')], [...values('ne'), ...values('notIn')]);
    }
    case 'type': {
      const word = (value: unknown) =>
        value === AssetTypeEnum.Video ? 'video' : value === AssetTypeEnum.Image ? 'photo' : '';
      return both(
        'type',
        values('eq').map((value) => word(value)),
        values('ne').map((value) => word(value)),
      );
    }
    case 'make':
    case 'model': {
      return both('camera', [...values('eq'), ...values('like')], [...values('ne'), ...values('notLike')]);
    }
    case 'lensModel': {
      return both('lens', values('like'), values('notLike'));
    }
    case 'rating': {
      return both('rating', values('gte'), []);
    }
    case 'isFavorite': {
      return [operatorToken('is', 'favorite', condition.eq === false)];
    }
    case 'localDateTime': {
      const { gte, lt } = condition;
      if ((gte !== undefined && !isMidnight(gte)) || (lt !== undefined && !isMidnight(lt))) {
        return undefined;
      }
      const start = gte as string | undefined;
      const end = lt as string | undefined;
      if (start && end) {
        const [year, month, day] = [start.slice(0, 4), start.slice(5, 7), start.slice(8, 10)];
        if (month === '01' && day === '01' && end === `${Number(year) + 1}-01-01T00:00:00.000Z`) {
          return [operatorToken('year', year)];
        }
        const next = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString();
        if (day === '01' && end === next) {
          return [operatorToken('month', `${year}-${month}`)];
        }
      }
      return [
        ...(start ? [operatorToken('after', dayBefore(start))] : []),
        ...(end ? [operatorToken('before', end.slice(0, 10))] : []),
      ];
    }
    case 'ocr': {
      return both('text', values('matches'), []);
    }
    case 'originalFileName':
    case 'originalPath': {
      const key = field === 'originalFileName' ? 'file' : 'path';
      return both(key, values('like'), values('notLike'));
    }
    default: {
      return undefined;
    }
  }
};

/**
 * The typed chips a query reads back as (FL-48: a search reopened from the URL, from Back, from a recent
 * or a saved search). Every condition an operator can write exactly becomes its chips and leaves the base;
 * each candidate is checked by parsing it again, so the round trip never changes what is searched. What
 * no operator can say — the collection scope, an any-of group, an id the viewer can no longer name —
 * stays in the base, where it is still searched and shown as a filter.
 */
export const typedTokensFromQuery = (
  query: DiscoveryQuery,
  catalog: PaletteCatalog,
): { tokens: string[]; base: DiscoveryQuery } => {
  const base = structuredClone(query);
  const tokens: string[] = [];
  const filter = base.filter as Record<string, unknown>;
  for (const [field, condition] of Object.entries(filter)) {
    if (field === 'or' || !isCondition(condition)) {
      continue;
    }
    const candidates = candidateTokens(field, condition, catalog);
    if (!candidates?.length) {
      continue;
    }
    const parsed = parseSearchInput(candidates.join(' '), catalog);
    const written = parsed.filter as Record<string, unknown>;
    if (
      parsed.text ||
      parsed.tokens.length !== candidates.length ||
      Object.keys(written).length !== 1 ||
      JSON.stringify(written[field]) !== JSON.stringify(condition)
    ) {
      continue;
    }
    tokens.push(...candidates);
    delete filter[field];
  }
  return { tokens, base };
};

/** A query's chips and text as one line, for a recent or saved search row. */
export const paletteSearchLabel = (query: DiscoveryQuery, catalog: PaletteCatalog) => {
  const state = readPaletteState(query);
  const { tokens } = typedTokensFromQuery(state.base, catalog);
  return [...tokens, state.input].join(' ').trim();
};

/* -------------------------------------------------------------------------- */
/* Recent and saved searches                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A recent search: the compiled query itself, scope and resolved ids included. The chips and text it is
 * shown and restored with are derived from it (`typedTokensFromQuery`), never stored beside it, so a
 * name is only ever shown for an id the viewer can still resolve.
 */
export type PaletteSearch = { query: DiscoveryQuery };

export const RECENT_SEARCH_LIMIT = 5;
export const SAVED_SEARCH_LIMIT = 50;
export const SAVED_SEARCH_NAME_LIMIT = 100;

/** Most recent first, one entry per distinct query (`applySearch` in the prototype's App.jsx). */
export const rememberRecentSearch = (recent: PaletteSearch[], entry: PaletteSearch): PaletteSearch[] => {
  if (isEmptyPaletteQuery(entry.query)) {
    return recent;
  }
  const key = JSON.stringify(entry.query);
  return [entry, ...recent.filter((item) => JSON.stringify(item.query) !== key)].slice(0, RECENT_SEARCH_LIMIT);
};

const isEmptyPaletteQuery = (query: DiscoveryQuery) =>
  !query.text.trim() && Object.keys(query.filter ?? {}).length === 0 && !query.imageEnrichment && !query.queryAssetId;

/**
 * A saved search's stored body: the compiled, portable query (`DiscoveryQuery`, the body the web hands to
 * the search endpoints), with every typed person, pet and tag already resolved to its id. Nothing else is
 * stored — no typed names — so the server can leave out a search that names something Locked while the
 * session is locked (`withoutLockedSavedSearches`), and reopening it rebuilds the chips from the ids.
 */
export const toSavedSearch = (name: string, query: DiscoveryQuery): SavedSearch => ({
  name: name.trim().slice(0, SAVED_SEARCH_NAME_LIMIT),
  query: structuredClone(query) as unknown as SavedSearch['query'],
});

/** Reads a saved search back; one written by another client, or damaged, is refused rather than guessed. */
export const fromSavedSearch = (saved: SavedSearch): DiscoveryQuery | undefined => {
  const parsed = parseDiscoveryQuery(saved.query);
  return parsed.ok ? parsed.query : undefined;
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
/* Saving as a smart album                                                      */
/* -------------------------------------------------------------------------- */

export type SmartAlbumCriteria = Omit<ClassificationRuleCreateDto, 'albumName'>;

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MIDNIGHT = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?Z$/;
const shiftDay = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The inclusive capture days a localDateTime condition covers, as a rule's takenAfter/takenBefore.
 * Each operator becomes its own bound (a calendar day or a UTC midnight, as the palette and the filter
 * panel write them); when both a strict and a non-strict bound are given, the narrower wins. A condition
 * that is not whole days (an intraday instant, `eq`, `ne`) returns undefined.
 */
const smartAlbumDays = (condition: Record<string, unknown>): { after?: string; before?: string } | undefined => {
  const lower: string[] = [];
  const upper: string[] = [];
  for (const [operator, operand] of Object.entries(condition)) {
    if (typeof operand !== 'string') {
      return undefined;
    }
    const isDay = CALENDAR_DAY.test(operand);
    const isMidnight = MIDNIGHT.test(operand);
    const day = operand.slice(0, 10);
    switch (operator) {
      case 'gte': {
        if (!isDay && !isMidnight) {
          return undefined;
        }
        lower.push(day);
        break;
      }
      case 'gt': {
        // After a whole day (the filter panel's day form); after an instant is not a whole day
        if (!isDay) {
          return undefined;
        }
        lower.push(shiftDay(day, 1));
        break;
      }
      case 'lte': {
        if (!isDay) {
          return undefined;
        }
        upper.push(day);
        break;
      }
      case 'lt': {
        if (!isDay && !isMidnight) {
          return undefined;
        }
        upper.push(shiftDay(day, -1));
        break;
      }
      default: {
        return undefined;
      }
    }
  }
  const after = lower.sort().at(-1);
  const before = upper.sort().at(0);
  return { ...(after && { after }), ...(before && { before }) };
};

/**
 * The FL-60 smart-album rule a palette search becomes (`SearchPalette.jsx` "Save search" → Smart album).
 * A rule matches any of its people, any of its tags, a media type, an inclusive capture-day range and
 * visual phrases, all together. A search that says anything else — an exclusion, all of several people,
 * a place, a camera, a rating, a collection, text in a text field — cannot become a rule without
 * changing what it matches, so the fields that stop it are returned instead and nothing is invented.
 */
export const smartAlbumCriteria = (
  query: DiscoveryQuery,
): { ok: true; criteria: SmartAlbumCriteria } | { ok: false; fields: string[] } => {
  const blocked: string[] = [];
  const criteria: SmartAlbumCriteria = {};
  const ids = (field: 'personIds' | 'tagIds') => {
    const condition = query.filter[field];
    if (!condition) {
      return;
    }
    const any = condition.any ?? [];
    const all = condition.all ?? [];
    if (condition.none?.length || (any.length > 0 && all.length > 0) || all.length > 1) {
      blocked.push(field);
      return;
    }
    criteria[field] = [...any, ...all];
  };
  for (const [field, condition] of Object.entries(query.filter) as [string, Record<string, unknown>][]) {
    switch (field) {
      case 'personIds':
      case 'tagIds': {
        ids(field);
        break;
      }
      case 'type': {
        const keys = Object.keys(condition);
        if (keys.length === 1 && (condition.eq === AssetTypeEnum.Image || condition.eq === AssetTypeEnum.Video)) {
          criteria.mediaType =
            condition.eq === AssetTypeEnum.Video ? ClassificationMediaType.Video : ClassificationMediaType.Photo;
        } else {
          blocked.push(field);
        }
        break;
      }
      case 'localDateTime': {
        // A rule compares the local capture day (classification.repository.ts), which is what
        // localDateTime holds; a UTC takenAt condition is a different column and cannot become a rule
        const bounds = smartAlbumDays(condition);
        if (!bounds) {
          blocked.push(field);
          break;
        }
        if (bounds.after) {
          criteria.takenAfter = bounds.after;
        }
        if (bounds.before) {
          criteria.takenBefore = bounds.before;
        }
        break;
      }
      default: {
        blocked.push(field);
      }
    }
  }
  const text = query.text.trim();
  if (text) {
    if (query.mode === 'smart') {
      criteria.visualQueries = [text];
    } else {
      blocked.push('text');
    }
  }
  if (query.imageEnrichment) {
    blocked.push('imageEnrichment');
  }
  if (query.queryAssetId || query.spaceId) {
    blocked.push(query.queryAssetId ? 'queryAssetId' : 'spaceId');
  }
  const says =
    !!criteria.personIds?.length ||
    !!criteria.tagIds?.length ||
    !!criteria.mediaType ||
    !!criteria.takenAfter ||
    !!criteria.takenBefore ||
    !!criteria.visualQueries?.length;
  if (blocked.length > 0 || !says) {
    return { ok: false, fields: blocked };
  }
  return { ok: true, criteria };
};

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
