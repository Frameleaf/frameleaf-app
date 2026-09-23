import type { SearchFilter } from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { discoveryTextField, type DiscoveryQuery, type DiscoveryTextField } from '$lib/components/discovery/query';
import type { FilterEntityKind } from '$lib/frameleaf/filter-entity-names';

/**
 * The /search results page's chip row for a structured `filter` (FL-49).
 *
 * A search from the search dialog carries its conditions as one structured `filter` next to the
 * flat fields. The chip row used to draw that whole object as a single raw chip; these helpers let it
 * draw one readable chip per condition instead (the labels come from `describeFilterChips`, the same
 * wording the search dialog shows), each removable on its own.
 *
 * Nothing here calls the network: the page resolves the names through the cached, access-checked
 * lookups in `filter-entity-names` and hands them back through `entityNameKey`.
 */

/** The id-list fields whose ids name an entity, and which lookup names it. */
export const FILTER_ENTITY_FIELDS: Readonly<Record<string, FilterEntityKind>> = {
  personIds: 'person',
  petIds: 'pet',
  tagIds: 'tag',
  albumIds: 'album',
};

/** i18n keys for an entity whose name could not be read (hidden, unnamed, gone or not allowed). */
export const FILTER_ENTITY_FALLBACK_KEYS: Readonly<Record<FilterEntityKind, Translations>> = {
  person: 'no_name',
  pet: 'frameleaf_pets_unnamed',
  tag: 'tag',
  album: 'album',
};

const ID_GROUPS = ['any', 'all', 'none', 'in', 'notIn'] as const;

export type FilterEntityIds = { field: string; kind: FilterEntityKind; ids: string[] };

/**
 * Every id a top-level id-list condition names, per field. Unlike the download-naming helpers this
 * includes excluded (`none`) ids: a chip names what it leaves out too ("Without Biscuit"). Ids
 * inside `or` branches are not collected; an `or` draws a single "any of N groups" chip.
 */
export const filterEntityIds = (filter: SearchFilter | undefined): FilterEntityIds[] => {
  if (!filter || typeof filter !== 'object') {
    return [];
  }
  const result: FilterEntityIds[] = [];
  for (const [field, kind] of Object.entries(FILTER_ENTITY_FIELDS)) {
    const condition = (filter as Record<string, unknown>)[field];
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
      continue;
    }
    const ids = new Set<string>();
    for (const group of ID_GROUPS) {
      const values = (condition as Record<string, unknown>)[group];
      if (Array.isArray(values)) {
        for (const id of values) {
          if (typeof id === 'string') {
            ids.add(id);
          }
        }
      }
    }
    if (ids.size > 0) {
      result.push({ field, kind, ids: [...ids] });
    }
  }
  return result;
};

/** The key under which the page stores a resolved name. */
export const entityNameKey = (field: string, id: string) => `${field}:${id}`;

/**
 * The search terms without one filter condition. When the last condition goes, `filter` goes with
 * it, so the terms fall back to a plain flat search (or to no search at all).
 */
export const withoutFilterField = <T extends { filter?: SearchFilter }>(terms: T, field: string): T => {
  const next = { ...terms };
  const filter = { ...terms.filter } as Record<string, unknown>;
  delete filter[field];
  if (Object.keys(filter).length === 0) {
    delete next.filter;
  } else {
    next.filter = filter as SearchFilter;
  }
  return next;
};

/* -------------------------------------------------------------------------- */
/* Search context chips (FL-48)                                                */
/* -------------------------------------------------------------------------- */

/**
 * The parts of a search that are not filter conditions but still decide what it finds: the typed
 * text, the photo a "view similar photos" search compares against, and the shared space it was
 * started in. On the results page each one is a chip of its own, so it can be seen and removed
 * without starting over; nothing else ever drops them.
 */
export type SearchContextKey = 'text' | 'queryAssetId' | 'spaceId';

export type SearchContextChip = {
  key: SearchContextKey;
  /** i18n key naming the chip. */
  labelKey: Translations;
  /** What was typed, for the text chip; null for the others, whose name says it all. */
  value: string | null;
};

const TEXT_FIELD_LABEL_KEYS: Readonly<Record<DiscoveryTextField, Translations>> = {
  originalFileName: 'file_name_text',
  description: 'description',
  ocr: 'ocr',
  originalPath: 'full_path_or_folder',
};

export const discoveryContextChips = (query: DiscoveryQuery): SearchContextChip[] => {
  const chips: SearchContextChip[] = [];
  const text = query.text.trim();
  if (text) {
    chips.push({
      key: 'text',
      labelKey: query.mode === 'smart' ? 'context' : TEXT_FIELD_LABEL_KEYS[discoveryTextField(query)],
      value: text,
    });
  }
  if (query.queryAssetId) {
    chips.push({ key: 'queryAssetId', labelKey: 'frameleaf_search_bridge_similar_photo', value: null });
  }
  if (query.spaceId) {
    chips.push({ key: 'spaceId', labelKey: 'frameleaf_search_kind_space', value: null });
  }
  return chips;
};

/** The query without one context part; everything else, filters included, is kept as it was. */
export const withoutDiscoveryContext = (query: DiscoveryQuery, key: SearchContextKey): DiscoveryQuery => {
  const result = structuredClone(query);
  if (key === 'text') {
    result.text = '';
  } else {
    delete result[key];
  }
  return result;
};
