import { persisted } from 'svelte-persisted-store';
import { SvelteSet } from 'svelte/reactivity';
import { isTagSort, type TagSort } from '$lib/frameleaf/tag-tree';

export const tagsIndexViews = ['cards', 'list'] as const;
export type TagsIndexViewMode = (typeof tagsIndexViews)[number];

export interface TagsIndexView {
  view: TagsIndexViewMode;
  sort: TagSort;
}

export const defaultTagsIndexView: TagsIndexView = { view: 'cards', sort: 'used' };

/** Repair a kept view so a stale or hand-edited value never breaks the page. */
export const normalizeTagsIndexView = (value: unknown): TagsIndexView => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    view: tagsIndexViews.includes(raw.view as TagsIndexViewMode)
      ? (raw.view as TagsIndexViewMode)
      : defaultTagsIndexView.view,
    sort: isTagSort(raw.sort) ? raw.sort : defaultTagsIndexView.sort,
  };
};

/**
 * Cards or List, and the order, kept on this device the way the Albums page keeps its view
 * (`albumDirectoryView` in preferences.store.ts): a convenience, never authority.
 */
export const tagsIndexView = persisted<TagsIndexView>('frameleaf-tags-index', { ...defaultTagsIndexView });

/**
 * Which branches of the list are open, kept while the app stays open so that coming Back from a
 * tag finds the list as it was left. One set per account: tag ids mean nothing to another one.
 */
let listExpansion: { owner: string; ids: SvelteSet<string> } | undefined;

export const tagListExpansion = (owner: string, initial: () => Iterable<string>): SvelteSet<string> => {
  if (listExpansion?.owner !== owner) {
    listExpansion = { owner, ids: new SvelteSet(initial()) };
  }
  return listExpansion.ids;
};

/** For specs: forget the kept list state. */
export const resetTagListExpansion = () => {
  listExpansion = undefined;
};
