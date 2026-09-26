import { beforeEach, describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { libraryPreferenceKey, writeLibraryView, type LibraryViewState } from '$lib/frameleaf/library-session';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const viewState = (overrides: Partial<LibraryViewState> = {}): LibraryViewState => ({
  version: 1,
  scope: { kind: 'album', id: 'album-1' },
  query: { ...emptyDiscoveryQuery(), text: 'harbour', mode: 'smart', filter: { isFavorite: { eq: true } } },
  sort: 'rating',
  grouping: 'months',
  view: 'detail',
  ...overrides,
});

/** The same state as a reducer patch; `version` is the reducer's to set. */
const viewPatch = (overrides: Partial<LibraryViewState> = {}) => {
  const { version: _, ...patch } = viewState(overrides);
  return patch;
};

describe('LibrarySessionStore', () => {
  let storage: MemoryStorage;
  let store: LibrarySessionStore;

  beforeEach(() => {
    storage = new MemoryStorage();
    store = new LibrarySessionStore({ userId: 'user-1', pageSize: 10, storage });
  });

  it('starts on Browse with nothing selected', () => {
    expect(store.layout).toBe('browse');
    expect(store.selection).toEqual([]);
    expect(store.openAssetId).toBeUndefined();
  });

  it('keeps the query, scope, selection, open asset, playhead and scroll anchor across a layout switch', () => {
    store.patchView(viewPatch());
    store.select('asset-1');
    store.select('asset-2');
    store.open('asset-9', 42);
    store.setScrollAnchor('asset-2');
    store.showMore();
    const before = { ...store.session, selection: [...store.selection] };

    for (const layout of ['timeline', 'work', 'browse', 'timeline'] as const) {
      store.setLayout(layout);
      expect(store.layout).toBe(layout);
      expect(store.state).toEqual(before.state);
      expect(store.selection).toEqual(before.selection);
      expect(store.openAssetId).toBe('asset-9');
      expect(store.playbackPosition).toBe(42);
      expect(store.session.scrollAnchor).toBe('asset-2');
      expect(store.session.page).toBe(before.page);
      expect(store.revision).toBe(before.revision);
    }
  });

  it('switching to the layout already shown is a no-op', () => {
    const before = store.session;
    store.setLayout('browse');
    expect(store.session).toBe(before);
  });

  it('restarts cumulative paging when the result set changes but not when only the presentation does', () => {
    store.showMore();
    store.showMore();
    expect(store.session.page).toBe(3);

    store.patchView({ grouping: 'years', view: 'list' });
    expect(store.session.page).toBe(3);

    store.setQuery({ ...emptyDiscoveryQuery(), text: 'lighthouse' });
    expect(store.session.page).toBe(1);
    expect(store.revision).toBe(1);
  });

  it('drops a response issued against a superseded query', () => {
    const issued = store.revision;
    expect(store.applyTotal(120, issued)).toBe(true);
    expect(store.total).toBe(120);

    store.setQuery({ ...emptyDiscoveryQuery(), text: 'new' });
    expect(store.total).toBeNull();
    expect(store.isCurrent(issued)).toBe(false);
    expect(store.applyTotal(120, issued)).toBe(false);
    expect(store.total).toBeNull();

    expect(store.applyTotal(7, store.revision)).toBe(true);
    expect(store.total).toBe(7);
  });

  it('summarises paging cumulatively and reports no results honestly', () => {
    store.applyTotal(25, store.revision);
    expect(store.paging.shown).toBe(10);
    expect(store.pageSummary).toEqual({
      key: 'frameleaf_library_showing_of',
      values: { shown: 10, total: 25 },
      hasMore: true,
    });

    store.showMore();
    expect(store.paging.shown).toBe(20);
    store.showMore();
    expect(store.paging.shown).toBe(25);
    expect(store.pageSummary.hasMore).toBe(false);
    expect(store.pageSummary.key).toBe('frameleaf_library_showing_all');

    store.setQuery({ ...emptyDiscoveryQuery(), text: 'nothing matches' });
    store.applyTotal(0, store.revision);
    expect(store.pageSummary.key).toBe('no_results');
    expect(store.pageSummary.hasMore).toBe(false);
  });

  it('keeps Show more available while the total is still unknown', () => {
    expect(store.total).toBeNull();
    expect(store.paging.hasMore).toBe(true);
    expect(store.pageSummary.key).toBe('frameleaf_library_showing_of');
  });

  it('opens an item without selecting it, and clears the open item when it is revoked', () => {
    store.select('asset-1');
    store.open('asset-2', 12);
    expect(store.selection).toEqual(['asset-1']);

    store.mutated(['asset-2', 'asset-1']);
    expect(store.openAssetId).toBeUndefined();
    expect(store.playbackPosition).toBe(0);
    expect(store.selection).toEqual([]);
    // Page state survives a mutation of the assets on the page.
    expect(store.layout).toBe('browse');
    expect(store.session.page).toBe(1);
  });

  it('clamps a restored playhead into the media it is restored against', () => {
    store.open('asset-1', 500);
    expect(store.restorePlayback(120)).toBe(120);
    expect(store.playbackPosition).toBe(120);

    store.open('asset-2', NaN);
    expect(store.playbackPosition).toBe(0);
    expect(store.restorePlayback(60)).toBe(0);

    store.open('asset-3', -5);
    expect(store.restorePlayback(60)).toBe(0);

    store.open('asset-4', 30);
    expect(store.restorePlayback(null)).toBe(30);
    expect(store.restorePlayback(NaN)).toBe(30);
  });

  it('selects ranges and whole day groups from one ordered list', () => {
    const ordered = ['a', 'b', 'c', 'd', 'e'];
    store.select('b');
    store.select('d', { range: true, orderedIds: ordered });
    expect(store.selection).toEqual(['b', 'c', 'd']);

    store.selectGroup(['d', 'e'], false);
    expect(store.selection).toEqual(['b', 'c']);
    store.selectGroup(['d', 'e'], true);
    expect(store.selection).toEqual(['b', 'c', 'd', 'e']);

    store.clearSelection();
    expect(store.selection).toEqual([]);
    store.selectAll(ordered);
    expect(store.selection).toEqual(ordered);
  });

  it('drops the selection when the scope changes but keeps it when the query narrows inside it', () => {
    store.select('a');
    store.setQuery({ ...emptyDiscoveryQuery(), text: 'narrower' });
    expect(store.selection).toEqual(['a']);
    store.setScope({ kind: 'album', id: 'album-2' });
    expect(store.selection).toEqual([]);
  });

  it('counts active filters, deep-links into a section and removes chips', () => {
    store.setQuery({
      ...emptyDiscoveryQuery(),
      filter: { isFavorite: { eq: true }, personIds: { any: ['person-1'] }, city: { eq: 'Halifax' } },
    });
    expect(store.filterCount).toBe(3);
    expect(store.filterActive).toBe(true);
    expect(store.filterSections).toEqual(['people', 'places', 'media']);
    expect(store.sectionForField('personIds')).toBe('people');
    expect(store.fieldsInSection('places')).toEqual(['city']);

    store.openFilterSection('places');
    expect(store.filterSection).toBe('places');
    store.openFilterSection(null);
    expect(store.filterSection).toBeNull();

    store.destination = { kind: 'favorites' };
    expect(store.chipFields).toEqual(['city', 'personIds']);

    store.removeFilter('city');
    expect(store.filterCount).toBe(2);
    store.clearFilters();
    expect(store.filterActive).toBe(false);
    expect(store.chipFields).toEqual([]);
  });

  it('restores portable state from a URL over the stored view, and never restores a selection', () => {
    const state = viewState();
    storage.setItem(
      libraryPreferenceKey('user-1'),
      JSON.stringify({
        version: 1,
        layout: 'work',
        state: viewState({ sort: 'filename', scope: { kind: 'library' } }),
        openAssetId: 'asset-7',
        playbackPosition: 9,
      }),
    );
    store.select('leftover');

    const url = writeLibraryView(new URL('https://example.test/photos'), state);
    store.restore(url, 'user-1');

    // Layout is device-local: it comes from storage, never from the link.
    expect(store.layout).toBe('work');
    expect(store.state).toEqual(state);
    expect(store.openAssetId).toBe('asset-7');
    expect(store.playbackPosition).toBe(9);
    expect(store.selection).toEqual([]);
    expect(store.session.page).toBe(1);
  });

  it('comes back from the editor or Studio to the same query, sort, grouping, layout and open item (FL-31)', () => {
    store.setLayout('work');
    store.patchView({ sort: 'filename', grouping: 'months' });
    store.open('asset-3', 42);
    expect(store.persist('user-1')).toBe(true);

    // Studio is a separate page: the library mounts again and restores from this device
    const back = new LibrarySessionStore({ userId: 'user-1', storage });
    back.restore(new URL('https://example.test/photos'), 'user-1');
    expect(back.layout).toBe('work');
    expect(back.state.sort).toBe('filename');
    expect(back.state.grouping).toBe('months');
    expect(back.openAssetId).toBe('asset-3');
    expect(back.playbackPosition).toBe(42);
  });

  it('falls back to the stored view when the link carries none, and to defaults when neither does', () => {
    storage.setItem(
      libraryPreferenceKey('user-1'),
      JSON.stringify({ version: 1, layout: 'timeline', state: viewState() }),
    );
    store.restore(new URL('https://example.test/photos'), 'user-1');
    expect(store.layout).toBe('timeline');
    expect(store.state.sort).toBe('rating');

    const fresh = new LibrarySessionStore({ userId: 'nobody', storage });
    fresh.restore(new URL('https://example.test/photos'), 'nobody');
    expect(fresh.layout).toBe('browse');
    expect(fresh.state).toEqual({
      version: 1,
      scope: { kind: 'library' },
      query: emptyDiscoveryQuery(),
      sort: 'captured-desc',
      grouping: 'all',
      view: 'grid',
    });
  });

  it('ignores a tampered or unparsable stored session instead of failing to load', () => {
    storage.setItem(libraryPreferenceKey('user-1'), '{not json');
    store.restore(new URL('https://example.test/photos'), 'user-1');
    expect(store.layout).toBe('browse');

    storage.setItem(
      libraryPreferenceKey('user-1'),
      JSON.stringify({ version: 1, layout: 'admin', state: { evil: true } }),
    );
    store.restore(new URL('https://example.test/photos'), 'user-1');
    expect(store.layout).toBe('browse');
    expect(store.state.scope).toEqual({ kind: 'library' });
  });

  it('round-trips the portable state through a URL without leaking the layout or selection', () => {
    store.patchView(viewPatch());
    store.setLayout('work');
    store.select('asset-1');
    const url = store.viewUrl(new URL('https://example.test/photos'));
    expect(url.searchParams.get('fl')).toContain('album-1');
    expect(url.searchParams.get('fl')).not.toContain('work');
    expect(url.searchParams.get('fl')).not.toContain('asset-1');

    const restored = new LibrarySessionStore({ storage: null });
    restored.restore(url);
    expect(restored.state).toEqual(store.state);
    expect(restored.layout).toBe('browse');
    expect(restored.selection).toEqual([]);
  });

  it('persists the device-local session and survives a storage that refuses to write', () => {
    store.setLayout('timeline');
    store.open('asset-3', 8);
    expect(store.persist()).toBe(true);
    const stored = JSON.parse(storage.getItem(libraryPreferenceKey('user-1')) as string);
    expect(stored).toMatchObject({ version: 1, layout: 'timeline', openAssetId: 'asset-3', playbackPosition: 8 });
    expect(stored.selection).toBeUndefined();

    const blocked = new LibrarySessionStore({
      userId: 'user-1',
      storage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    expect(() => blocked.restore(new URL('https://example.test/photos'), 'user-1')).not.toThrow();
    expect(blocked.persist()).toBe(false);
    expect(new LibrarySessionStore({ storage: null }).persist('user-1')).toBe(false);
  });

  it('refuses a newer link out loud and keeps it in the address bar until the view changes (FL-48)', () => {
    const newer = new URL('https://example.test/photos');
    newer.searchParams.set('fl', JSON.stringify({ ...viewState(), version: 2, somethingNew: true }));
    store.restore(newer, 'user-1');
    expect(store.refusedView).toBe('unsupported-version');
    // The page falls back to the stored (here: default) view but does not overwrite the link.
    expect(store.viewUrl(newer).href).toBe(newer.href);

    store.patchView({ sort: 'filename' });
    expect(store.viewUrl(newer).searchParams.get('fl')).toContain('filename');

    store.restore(new URL('https://example.test/photos'), 'user-1');
    expect(store.refusedView).toBeNull();
  });

  it('keeps every part of the query through the URL, including its search context (FL-48)', () => {
    store.patchView(
      viewPatch({
        query: {
          ...emptyDiscoveryQuery(),
          text: 'receipt',
          textField: 'ocr',
          queryAssetId: 'asset-9',
          spaceId: 'space-1',
          filter: { takenAt: { gte: '2026-08-01' }, personIds: { none: ['p1'] } },
        },
      }),
    );
    const restored = new LibrarySessionStore({ storage: null });
    restored.restore(store.viewUrl(new URL('https://example.test/photos')));
    expect(restored.refusedView).toBeNull();
    expect(restored.query).toEqual(store.query);
  });
});
