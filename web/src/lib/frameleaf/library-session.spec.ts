import { ImageEnrichmentFilter } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import {
  createLibrarySession,
  DEFAULT_LIBRARY_LAYOUT,
  fromStoredLibrarySession,
  groupSelectionState,
  isCurrentResult,
  isLibraryFilter,
  libraryPreferenceKey,
  nextAnchor,
  parseLibraryView,
  parseLibraryViewValue,
  readLibraryView,
  readLibraryViewValue,
  reduceLibrarySession,
  selectGroup,
  selectRange,
  toStoredLibrarySession,
  toggleSelection,
  writeLibraryView,
  type LibrarySession,
  type LibrarySessionAction,
  type LibraryViewState,
} from '$lib/frameleaf/library-session';

const run = (session: LibrarySession, ...actions: LibrarySessionAction[]) => {
  let current = session;
  for (const action of actions) {
    current = reduceLibrarySession(current, action);
  }
  return current;
};

const day = ['a', 'b', 'c', 'd', 'e'];

const withFilter = (filter: DiscoveryQuery['filter']): DiscoveryQuery => ({ ...emptyDiscoveryQuery(), filter });

const viewState = (patch: Partial<LibraryViewState> = {}): LibraryViewState => ({
  version: 1,
  scope: { kind: 'library' },
  query: emptyDiscoveryQuery(),
  sort: 'captured-desc',
  grouping: 'all',
  view: 'grid',
  ...patch,
});

describe('library session defaults', () => {
  it('opens on Browse with nothing selected and nothing open', () => {
    const session = createLibrarySession();
    expect(DEFAULT_LIBRARY_LAYOUT).toBe('browse');
    expect(session.layout).toBe('browse');
    expect(session.selection).toEqual([]);
    expect(session.anchorId).toBeNull();
    expect(session.openAssetId).toBeUndefined();
    expect(session.page).toBe(1);
    expect(session.filterSection).toBeNull();
  });

  it('keys stored preferences per authenticated user', () => {
    expect(libraryPreferenceKey('user/1')).toBe('frameleaf:library:v1:user%2F1');
  });
});

describe('page state across layouts', () => {
  it('a layout switch changes only the layout', () => {
    const base = run(
      createLibrarySession(),
      { type: 'view', patch: { scope: { kind: 'album', id: 'album-1' }, sort: 'rating', grouping: 'days' } },
      { type: 'view', patch: { query: withFilter({ isFavorite: { eq: true } }) } },
      { type: 'selection', ids: ['a', 'b'] },
      { type: 'open', id: 'c', time: 4 },
      { type: 'show-more' },
      { type: 'draft', draft: { assetId: 'c', recipe: [], undo: [], redo: [] } },
    );

    const timeline = reduceLibrarySession(base, { type: 'layout', layout: 'timeline' });
    expect(timeline.layout).toBe('timeline');
    expect({ ...timeline, layout: base.layout }).toEqual(base);

    const back = reduceLibrarySession(timeline, { type: 'layout', layout: 'browse' });
    expect(back.state).toEqual(base.state);
    expect(back.selection).toEqual(['a', 'b']);
    expect(back.openAssetId).toBe('c');
    expect(back.playbackPosition).toBe(4);
    expect(back.page).toBe(2);
    expect(back.draft).toEqual(base.draft);
  });

  it('ignores an unknown layout and a repeat of the current one', () => {
    const session = createLibrarySession();
    expect(reduceLibrarySession(session, { type: 'layout', layout: 'browse' })).toBe(session);
    expect(reduceLibrarySession(session, { type: 'layout', layout: 'gallery' as never })).toBe(session);
  });
});

describe('selection is separate from the open item', () => {
  it('opening an item does not select it and selecting does not open it', () => {
    const opened = reduceLibrarySession(createLibrarySession(), { type: 'open', id: 'a' });
    expect(opened.openAssetId).toBe('a');
    expect(opened.selection).toEqual([]);

    const selected = reduceLibrarySession(opened, { type: 'select', id: 'b' });
    expect(selected.selection).toEqual(['b']);
    expect(selected.openAssetId).toBe('a');

    const closed = reduceLibrarySession(selected, { type: 'close' });
    expect(closed.openAssetId).toBeUndefined();
    expect(closed.selection).toEqual(['b']);
  });

  it('tracks playback only for the open item', () => {
    const session = run(createLibrarySession(), { type: 'open', id: 'a', time: 12 }, { type: 'playback', time: 30 });
    expect(session.playbackPosition).toBe(30);
    expect(reduceLibrarySession(session, { type: 'playback', time: NaN })).toBe(session);
    expect(reduceLibrarySession(session, { type: 'open', id: 'b' }).playbackPosition).toBe(0);
  });
});

describe('shift range and group select', () => {
  it('toggles, then extends a range from the anchor', () => {
    const first = reduceLibrarySession(createLibrarySession(), { type: 'select', id: 'b' });
    expect(first.selection).toEqual(['b']);
    expect(first.anchorId).toBe('b');

    const ranged = reduceLibrarySession(first, { type: 'select-range', orderedIds: day, id: 'd' });
    expect(ranged.selection).toEqual(['b', 'c', 'd']);
    // Prototype `App.jsx` toggleSelect returns before setAnchorId on a shift-click.
    expect(ranged.anchorId).toBe('b');
  });

  it('ranges every chained shift-click from the same original anchor', () => {
    const anchored = reduceLibrarySession(createLibrarySession(), { type: 'select', id: 'c' });
    const forward = reduceLibrarySession(anchored, { type: 'select-range', orderedIds: day, id: 'e' });
    expect(forward.selection).toEqual(['c', 'd', 'e']);
    expect(forward.anchorId).toBe('c');
    // The second shift-click reaches back from "c", not from "e": "d" is not re-anchored past.
    const backward = reduceLibrarySession(forward, { type: 'select-range', orderedIds: day, id: 'a' });
    expect(backward.selection).toEqual(['c', 'd', 'e', 'a', 'b']);
    expect(backward.anchorId).toBe('c');
    // A replaced selection, as the timeline's range retrieval dispatches it, keeps the anchor too.
    const retrieved = reduceLibrarySession(backward, { type: 'selection', ids: ['a', 'b', 'c'] });
    expect(retrieved.anchorId).toBe('c');
  });

  it('keeps a stale anchor after its day is unchecked, and ranges from it', () => {
    const anchored = reduceLibrarySession(createLibrarySession(), { type: 'select', id: 'b' });
    const unchecked = reduceLibrarySession(anchored, { type: 'select-group', ids: ['a', 'b', 'c'], checked: false });
    expect(unchecked.selection).toEqual([]);
    expect(unchecked.anchorId).toBe('b');
    const ranged = reduceLibrarySession(unchecked, { type: 'select-range', orderedIds: day, id: 'd' });
    expect(ranged.selection).toEqual(['b', 'c', 'd']);
    expect(ranged.anchorId).toBe('b');
  });

  it('keeps the anchor when the selection is cleared', () => {
    const anchored = run(
      createLibrarySession(),
      { type: 'select', id: 'b' },
      { type: 'select-range', orderedIds: day, id: 'c' },
    );
    const cleared = reduceLibrarySession(anchored, { type: 'clear-selection' });
    expect(cleared.selection).toEqual([]);
    expect(cleared.anchorId).toBe('b');
    expect(reduceLibrarySession(cleared, { type: 'clear-selection' })).toBe(cleared);
    const ranged = reduceLibrarySession(cleared, { type: 'select-range', orderedIds: day, id: 'd' });
    expect(ranged.selection).toEqual(['b', 'c', 'd']);
  });

  it('adds just the target when the anchor is outside the visible order, and keeps the anchor', () => {
    const anchored = reduceLibrarySession(createLibrarySession(), { type: 'select', id: 'gone' });
    const ranged = reduceLibrarySession(anchored, { type: 'select-range', orderedIds: day, id: 'c' });
    expect(ranged.selection).toEqual(['gone', 'c']);
    expect(ranged.anchorId).toBe('gone');
  });

  it('extends a range backwards in visible order', () => {
    const session = run(
      createLibrarySession(),
      { type: 'select', id: 'd' },
      { type: 'select-range', orderedIds: day, id: 'b' },
    );
    expect(session.selection).toEqual(['d', 'b', 'c']);
  });

  it('treats a shift-click with no anchor as a plain toggle, which sets the anchor', () => {
    const session = reduceLibrarySession(createLibrarySession(), { type: 'select-range', orderedIds: day, id: 'c' });
    expect(session.selection).toEqual(['c']);
    expect(session.anchorId).toBe('c');
    const grouped = reduceLibrarySession(createLibrarySession(), {
      type: 'select-group',
      ids: ['b', 'c'],
      checked: true,
    });
    expect(reduceLibrarySession(grouped, { type: 'select-range', orderedIds: day, id: 'c' }).selection).toEqual(['b']);
  });

  it('selects and clears a whole day group from its header', () => {
    const group = ['b', 'c'];
    const checked = reduceLibrarySession(createLibrarySession(), {
      type: 'select-group',
      ids: group,
      checked: true,
    });
    expect(checked.selection).toEqual(group);
    expect(groupSelectionState(group, checked.selection)).toBe('all');

    const unchecked = reduceLibrarySession(checked, { type: 'select-group', ids: group, checked: false });
    expect(unchecked.selection).toEqual([]);
    expect(unchecked.anchorId).toBeNull();
    expect(groupSelectionState(group, unchecked.selection)).toBe('none');
  });

  it('keeps the shift-click anchor where a tile set it when a day group is selected', () => {
    const dayGroup = reduceLibrarySession(createLibrarySession(), {
      type: 'select-group',
      ids: ['b', 'c'],
      checked: true,
    });
    expect(dayGroup.anchorId).toBeNull();
    const shifted = reduceLibrarySession(dayGroup, { type: 'select-range', orderedIds: day, id: 'e' });
    expect(shifted.selection).toEqual(['b', 'c', 'e']);

    const tile = reduceLibrarySession(createLibrarySession(), { type: 'select', id: 'a' });
    const withGroup = reduceLibrarySession(tile, { type: 'select-group', ids: ['c', 'd'], checked: true });
    expect(withGroup.anchorId).toBe('a');
  });

  it('reports a partly selected group', () => {
    expect(groupSelectionState(['a', 'b'], ['a'])).toBe('some');
    expect(groupSelectionState([], ['a'])).toBe('none');
  });

  it('selects everything on the page and clears again', () => {
    const all = reduceLibrarySession(createLibrarySession(), { type: 'select-all', orderedIds: day });
    expect(all.selection).toEqual(day);
    const cleared = reduceLibrarySession(all, { type: 'clear-selection' });
    expect(cleared.selection).toEqual([]);
    expect(reduceLibrarySession(cleared, { type: 'clear-selection' })).toBe(cleared);
  });

  it('snapshots the view state only for a select-everything-matching selection', () => {
    const base = reduceLibrarySession(createLibrarySession(), { type: 'view', patch: { sort: 'rating' } });
    expect(reduceLibrarySession(base, { type: 'selection', ids: day }).selectionSnapshot).toBeUndefined();
    const matching = reduceLibrarySession(base, { type: 'selection', ids: day, allMatching: true });
    expect(matching.selectionSnapshot).toEqual(base.state);
    // Touching the selection by hand invalidates the snapshot.
    expect(reduceLibrarySession(matching, { type: 'select', id: 'a' }).selectionSnapshot).toBeUndefined();
  });

  it('exposes the pure helpers the timeline uses directly', () => {
    expect(toggleSelection(['a'], 'a')).toEqual([]);
    expect(selectRange(day, null, 'c')).toEqual(['c']);
    expect(selectRange(day, 'a', 'missing', ['a'])).toEqual(['a']);
    expect(selectGroup(['a', 'b'], ['b'], false)).toEqual(['a']);
    expect(nextAnchor(['a'], 'b', 'a')).toBe('a');
    expect(nextAnchor([], 'b', 'a')).toBeNull();
  });
});

describe('selection is scope bound', () => {
  it('survives narrowing inside a scope', () => {
    const session = run(
      createLibrarySession(),
      { type: 'select-all', orderedIds: day },
      { type: 'view', patch: { query: withFilter({ isFavorite: { eq: true } }) } },
    );
    expect(session.selection).toEqual(day);
  });

  it('is dropped when the scope changes', () => {
    const session = run(
      createLibrarySession(),
      { type: 'select-all', orderedIds: day },
      { type: 'scope', scope: { kind: 'album', id: 'album-1' } },
    );
    expect(session.selection).toEqual([]);
    expect(session.anchorId).toBeNull();
    expect(session.state.scope).toEqual({ kind: 'album', id: 'album-1' });
  });
});

describe('cumulative paging and stale responses', () => {
  it('raises the page for Show more and restarts it when the result set changes', () => {
    const paged = run(createLibrarySession(), { type: 'show-more' }, { type: 'show-more' });
    expect(paged.page).toBe(3);
    expect(reduceLibrarySession(paged, { type: 'view', patch: { sort: 'filename' } }).page).toBe(1);
    const narrowed = reduceLibrarySession(paged, {
      type: 'view',
      patch: { query: withFilter({ hasTags: { eq: false } }) },
    });
    expect(narrowed.page).toBe(1);
  });

  it('keeps the page across a presentation-only change', () => {
    const paged = run(createLibrarySession(), { type: 'show-more' });
    expect(reduceLibrarySession(paged, { type: 'view', patch: { view: 'list' } }).page).toBe(2);
    expect(reduceLibrarySession(paged, { type: 'view', patch: { grouping: 'days' } }).page).toBe(2);
    expect(reduceLibrarySession(paged, { type: 'layout', layout: 'timeline' }).page).toBe(2);
  });

  it('accepts an explicit page and refuses an unusable one', () => {
    const session = createLibrarySession();
    expect(reduceLibrarySession(session, { type: 'page', page: 4 }).page).toBe(4);
    expect(reduceLibrarySession(session, { type: 'page', page: 0 }).page).toBe(1);
    expect(reduceLibrarySession(session, { type: 'page', page: 1.5 })).toBe(session);
  });

  it('invalidates in-flight responses when the result set changes but not when it does not', () => {
    const session = createLibrarySession();
    const issued = session.revision;
    expect(isCurrentResult(session, issued)).toBe(true);

    const presentation = reduceLibrarySession(session, { type: 'view', patch: { view: 'list' } });
    expect(isCurrentResult(presentation, issued)).toBe(true);

    const narrowed = reduceLibrarySession(presentation, {
      type: 'view',
      patch: { query: withFilter({ isFavorite: { eq: true } }) },
    });
    expect(isCurrentResult(narrowed, issued)).toBe(false);
  });
});

describe('the single Filter control deep-links into the panel', () => {
  it('opens and closes a section without disturbing the page state', () => {
    const base = run(createLibrarySession(), { type: 'select-all', orderedIds: day }, { type: 'show-more' });
    const opened = reduceLibrarySession(base, { type: 'filter-section', section: 'people' });
    expect(opened.filterSection).toBe('people');
    expect(opened.selection).toEqual(day);
    expect(opened.page).toBe(2);
    expect(reduceLibrarySession(opened, { type: 'filter-section', section: null }).filterSection).toBeNull();
  });

  it('refuses an unknown section', () => {
    const session = createLibrarySession();
    expect(reduceLibrarySession(session, { type: 'filter-section', section: 'cameras' as never })).toBe(session);
  });
});

describe('page state across mutations', () => {
  it('keeps scope, query, sort, grouping, view, layout and paging when assets are removed', () => {
    const base = run(
      createLibrarySession(),
      { type: 'layout', layout: 'timeline' },
      { type: 'view', patch: { scope: { kind: 'album', id: 'album-1' }, sort: 'rating', grouping: 'days' } },
      { type: 'view', patch: { query: withFilter({ isFavorite: { eq: true } }) } },
      { type: 'show-more' },
      { type: 'select-all', orderedIds: day },
      { type: 'open', id: 'c', time: 9 },
      { type: 'anchor', id: 'c' },
      { type: 'draft', draft: { assetId: 'c', recipe: [], undo: [], redo: [] } },
    );

    const mutated = reduceLibrarySession(base, { type: 'mutated', removedIds: ['c', 'd'] });
    expect(mutated.layout).toBe('timeline');
    expect(mutated.state).toEqual(base.state);
    expect(mutated.page).toBe(2);
    expect(mutated.revision).toBe(base.revision);
    expect(mutated.selection).toEqual(['a', 'b', 'e']);
    expect(mutated.openAssetId).toBeUndefined();
    expect(mutated.playbackPosition).toBe(0);
    expect(mutated.scrollAnchor).toBeUndefined();
    expect(mutated.draft).toBeNull();
  });

  it('leaves untouched references alone and ignores an empty mutation', () => {
    const base = run(
      createLibrarySession(),
      { type: 'select-all', orderedIds: day },
      { type: 'open', id: 'a', time: 3 },
      { type: 'anchor', id: 'a' },
    );
    expect(reduceLibrarySession(base, { type: 'mutated', removedIds: [] })).toBe(base);

    const mutated = reduceLibrarySession(base, { type: 'mutated', removedIds: ['e'] });
    expect(mutated.openAssetId).toBe('a');
    expect(mutated.playbackPosition).toBe(3);
    expect(mutated.scrollAnchor).toBe('a');
    expect(mutated.selection).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops the anchor when the anchored asset is removed', () => {
    const base = run(createLibrarySession(), { type: 'select', id: 'b' });
    expect(reduceLibrarySession(base, { type: 'mutated', removedIds: ['b'] }).anchorId).toBeNull();
  });
});

describe('portable URL state', () => {
  it('round-trips a full view state', () => {
    const state = viewState({
      scope: { kind: 'album', id: 'album-1' },
      query: { ...withFilter({ personIds: { any: ['p1'] } }), text: 'lake', mode: 'smart' },
      sort: 'rating',
      grouping: 'days',
      view: 'list',
    });
    expect(readLibraryView(writeLibraryView(new URL('http://localhost/photos'), state))).toEqual(state);
  });

  it('never carries selection, layout or edit history', () => {
    const session = run(
      createLibrarySession(),
      { type: 'layout', layout: 'work' },
      { type: 'select-all', orderedIds: day },
    );
    const url = writeLibraryView(new URL('http://localhost/photos'), session.state);
    expect(url.searchParams.get('fl')).not.toContain('work');
    expect(url.searchParams.get('fl')).not.toContain('selection');
  });

  it('rejects a malformed, oversized or wrongly versioned value', () => {
    expect(readLibraryView(new URL('http://localhost/photos'))).toBeNull();
    expect(readLibraryView(new URL('http://localhost/photos?fl=not-json'))).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), version: 2 })).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), sort: 'popularity' })).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), view: 'wall' })).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), grouping: 'hours' })).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), scope: { kind: 'album' } })).toBeNull();
    expect(readLibraryViewValue({ ...viewState(), scope: { kind: 'folder', id: 'x' } })).toBeNull();
    const oversized = new URL('http://localhost/photos');
    oversized.searchParams.set('fl', 'x'.repeat(32_769));
    expect(readLibraryView(oversized)).toBeNull();
  });

  it('drops the scope id for the whole library', () => {
    const restored = readLibraryViewValue({ ...viewState(), scope: { kind: 'library', id: 'ignored' } });
    expect(restored?.scope).toEqual({ kind: 'library' });
  });

  it('repairs the legacy rating value earlier prototype links wrote', () => {
    // FL-48, matching the prototype's `normalizeFilter`: that select was a minimum rating, so the
    // string it stored means "at least", not "exactly".
    const legacy = { rating: { eq: '4' } } as unknown as DiscoveryQuery['filter'];
    const restored = readLibraryViewValue(viewState({ query: withFilter(legacy) }));
    expect(restored?.query.filter.rating).toEqual({ gte: 4 });
  });

  it('round-trips every part of the query, context included (FL-48)', () => {
    const state = viewState({
      scope: { kind: 'space', id: 'space-1' },
      query: {
        ...withFilter({
          personIds: { any: ['p1'], none: ['p2'] },
          takenAt: { gte: '2026-08-01', lte: '2026-08-31' },
          rating: { eq: null },
          or: [{ city: { eq: 'Banff' } }, { hasTags: { eq: false } }],
        }),
        text: 'receipt',
        mode: 'text',
        textField: 'ocr',
        queryAssetId: 'asset-1',
        spaceId: 'space-1',
        imageEnrichment: ImageEnrichmentFilter.MissingImageDescription,
        grouping: 'years',
        view: 'map',
      },
    });
    expect(readLibraryView(writeLibraryView(new URL('http://localhost/photos'), state))).toEqual(state);
    expect(readLibraryViewValue(state)).toEqual(state);
  });

  it('tells a newer link apart from a missing or damaged one (FL-48)', () => {
    const newer = new URL('http://localhost/photos');
    newer.searchParams.set('fl', JSON.stringify({ ...viewState(), version: 2 }));
    expect(parseLibraryView(newer)).toEqual({ ok: false, problem: 'unsupported-version' });

    const newerQuery = new URL('http://localhost/photos');
    newerQuery.searchParams.set(
      'fl',
      JSON.stringify(viewState({ query: { ...emptyDiscoveryQuery(), version: 2 } as never })),
    );
    expect(parseLibraryView(newerQuery)).toEqual({ ok: false, problem: 'unsupported-version' });

    expect(parseLibraryView(new URL('http://localhost/photos?fl=not-json'))).toEqual({
      ok: false,
      problem: 'malformed',
    });
    expect(parseLibraryViewValue(viewState({ query: withFilter({ city: { like: 'x' } } as never) }))).toEqual({
      ok: false,
      problem: 'invalid',
    });
    expect(parseLibraryView(new URL('http://localhost/photos'))).toBeNull();
  });

  it('refuses a filter a URL should not be able to inject', () => {
    expect(isLibraryFilter({ isFavorite: { eq: true } })).toBe(true);
    expect(isLibraryFilter({ personIds: { any: ['p1'] } })).toBe(true);
    expect(isLibraryFilter({ city: { eq: null } })).toBe(true);
    expect(isLibraryFilter({ or: [{ city: { eq: 'Banff' } }] })).toBe(true);

    expect(isLibraryFilter('nope')).toBe(false);
    expect(isLibraryFilter({ city: {} })).toBe(false);
    expect(isLibraryFilter({ isFavorite: { eq: 'yes' } })).toBe(false);
    expect(isLibraryFilter({ personIds: { eq: 'p1' } })).toBe(false);
    expect(isLibraryFilter({ personIds: { any: [] } })).toBe(false);
    expect(isLibraryFilter({ rating: { gte: 'four' } })).toBe(false);
    expect(isLibraryFilter({ unknownField: { eq: 'x' } })).toBe(false);
    expect(isLibraryFilter({ or: [{ or: [{ city: { eq: 'Banff' } }] }] })).toBe(false);
    expect(isLibraryFilter({ city: { eq: 'x'.repeat(4097) } })).toBe(false);
  });

  it('carries pets as an ordinary id-list condition (FL-58)', () => {
    expect(isLibraryFilter({ petIds: { any: ['pet-1'] } })).toBe(true);
    expect(isLibraryFilter({ petIds: { all: ['pet-1', 'pet-2'], none: ['pet-3'] } })).toBe(true);
    expect(isLibraryFilter({ or: [{ petIds: { any: ['pet-1'] } }, { personIds: { any: ['p1'] } }] })).toBe(true);
    expect(isLibraryFilter({ petIds: { eq: 'pet-1' } })).toBe(false);
    expect(isLibraryFilter({ petIds: { any: [] } })).toBe(false);

    const state = viewState({ query: withFilter({ petIds: { any: ['pet-1'] } }) });
    expect(readLibraryView(writeLibraryView(new URL('http://localhost/photos'), state))).toEqual(state);
  });

  it('folds the prototype top-level pet list into the filter it never reached', () => {
    const legacy = { ...emptyDiscoveryQuery(), petIds: ['pet-1', 'pet-1', 'pet-2'] } as unknown as DiscoveryQuery;
    const restored = readLibraryViewValue(viewState({ query: legacy }));
    expect(restored?.query.filter.petIds).toEqual({ any: ['pet-1', 'pet-2'] });
    expect(restored?.query).not.toHaveProperty('petIds');

    const explicit = {
      ...withFilter({ petIds: { none: ['pet-3'] } }),
      petIds: ['pet-1'],
    } as unknown as DiscoveryQuery;
    expect(readLibraryViewValue(viewState({ query: explicit }))?.query.filter.petIds).toEqual({ none: ['pet-3'] });

    const malformed = { ...emptyDiscoveryQuery(), petIds: [1] } as unknown as DiscoveryQuery;
    expect(readLibraryViewValue(viewState({ query: malformed }))).toBeNull();
  });
});

describe('what survives a reload', () => {
  it('stores layout and view state but never the selection', () => {
    const session = run(
      createLibrarySession(),
      { type: 'layout', layout: 'timeline' },
      { type: 'view', patch: { scope: { kind: 'album', id: 'album-1' }, sort: 'rating' } },
      { type: 'select-all', orderedIds: day },
      { type: 'open', id: 'c', time: 8 },
    );
    const stored = toStoredLibrarySession(session);
    expect(JSON.stringify(stored)).not.toContain('"selection"');
    expect(stored).toEqual({
      version: 1,
      layout: 'timeline',
      state: session.state,
      openAssetId: 'c',
      playbackPosition: 8,
    });

    const restored = fromStoredLibrarySession(JSON.stringify(stored));
    expect(restored.layout).toBe('timeline');
    expect(restored.state).toEqual(session.state);
    expect(restored.openAssetId).toBe('c');
    expect(restored.playbackPosition).toBe(8);
    expect(restored.selection).toEqual([]);
    expect(restored.anchorId).toBeNull();
    expect(restored.page).toBe(1);
  });

  it('never restores a selection even when one was written into storage by hand', () => {
    const restored = fromStoredLibrarySession({ version: 1, layout: 'browse', selection: day });
    expect(restored.selection).toEqual([]);
  });

  it('falls back to Browse and the empty library for unusable storage', () => {
    for (const raw of [null, 'not-json', {}, { layout: 'gallery', state: { version: 9 } }]) {
      const restored = fromStoredLibrarySession(raw);
      expect(restored.layout).toBe('browse');
      expect(restored.state).toEqual(createLibrarySession().state);
    }
  });

  it('lets a shared URL win over the stored view while layout stays device-local', () => {
    const stored = toStoredLibrarySession(
      run(createLibrarySession(), { type: 'layout', layout: 'work' }, { type: 'view', patch: { sort: 'filename' } }),
    );
    const incoming = viewState({ scope: { kind: 'space', id: 'space-1' }, sort: 'rating' });
    const restored = fromStoredLibrarySession(stored, incoming);
    expect(restored.state).toEqual(incoming);
    expect(restored.layout).toBe('work');
  });
});
