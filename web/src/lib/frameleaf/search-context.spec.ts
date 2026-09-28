import { describe, expect, it } from 'vitest';
import { discoveryUrl, emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { createLibrarySession, writeLibraryView, type LibraryViewState } from '$lib/frameleaf/library-session';
import { discoveryContextChips, withoutDiscoveryContext } from '$lib/frameleaf/search-chips';
import { searchContextFor } from '$lib/frameleaf/search-context';

const albumId = '11111111-2222-4333-8444-555555555555';
const petId = '99999999-8888-4777-8666-555555555555';
const spaceId = '66666666-7777-4888-9999-aaaaaaaaaaaa';

const state = (patch: Partial<LibraryViewState> = {}): LibraryViewState => ({
  ...createLibrarySession().state,
  ...patch,
});

const onPage = (path: string, view?: LibraryViewState) => {
  const url = new URL(`http://localhost${path}`);
  return view ? writeLibraryView(url, view) : url;
};

describe('the query the top bar search opens on (FL-48)', () => {
  it('opens a library page on the filters its toolbar shows as chips', () => {
    const view = state({ query: { ...emptyDiscoveryQuery(), filter: { tagIds: { any: ['tag-1'] } } } });
    expect(searchContextFor(onPage('/photos', view))).toEqual({ query: view.query, unsupported: [] });
  });

  it('keeps an album page scoped to its album on top of the session filters', () => {
    const view = state({ query: { ...emptyDiscoveryQuery(), filter: { isFavorite: { eq: true } } } });
    expect(searchContextFor(onPage(`/albums/${albumId}`, view)).query.filter).toEqual({
      isFavorite: { eq: true },
      albumIds: { any: [albumId] },
    });
  });

  it('requires the route album beside an album condition the session already has', () => {
    const view = state({ query: { ...emptyDiscoveryQuery(), filter: { albumIds: { none: ['album-x'] } } } });
    expect(searchContextFor(onPage(`/albums/${albumId}`, view)).query.filter.albumIds).toEqual({
      none: ['album-x'],
      all: [albumId],
    });
  });

  it('carries the session scope into the query', () => {
    expect(
      searchContextFor(onPage('/photos', state({ scope: { kind: 'album', id: albumId } }))).query.filter.albumIds,
    ).toEqual({ any: [albumId] });
    expect(searchContextFor(onPage('/photos', state({ scope: { kind: 'space', id: spaceId } }))).query.spaceId).toBe(
      spaceId,
    );
  });

  it('keeps the pet and the space when the page has no session state', () => {
    expect(searchContextFor(onPage(`/pets/${petId}`)).query.filter).toEqual({ petIds: { any: [petId] } });
    expect(searchContextFor(onPage(`/sharing/${spaceId}`)).query.spaceId).toBe(spaceId);
  });

  it('adds the route scope to a pet page that also carries session state', () => {
    const view = state({ query: { ...emptyDiscoveryQuery(), text: 'garden', mode: 'smart' } });
    expect(searchContextFor(onPage(`/pets/${petId}`, view)).query).toMatchObject({
      text: 'garden',
      filter: { petIds: { any: [petId] } },
    });
  });

  it('opens the map page unscoped, matching the prototype (FL-48 map/space follow-ups)', () => {
    // App.jsx's `exploreQuery`/`MapView`'s "Search this area" always land a submitted search on the
    // plain grid results, so /map contributes no scope and no view — unlike /pets/:id or /sharing/:id.
    expect(searchContextFor(onPage('/map')).query.view).toBe('photos');
    const view = state({ query: { ...emptyDiscoveryQuery(), text: 'garden', mode: 'smart' } });
    expect(searchContextFor(onPage('/map', view)).query.view).toBe('photos');
  });

  it('reads the search page from its own query, never from session state', () => {
    const query = { ...emptyDiscoveryQuery(), text: 'receipt', textField: 'ocr' as const };
    const url = writeLibraryView(new URL(`http://localhost${discoveryUrl(query)}`), state({ sort: 'filename' }));
    expect(searchContextFor(url)).toEqual({ query, unsupported: [] });
  });

  it('falls back to the route when the session state cannot be read', () => {
    const url = new URL(`http://localhost/pets/${petId}?fl=not-json`);
    expect(searchContextFor(url).query.filter).toEqual({ petIds: { any: [petId] } });
  });
});

describe('search context chips (FL-48)', () => {
  it('names the text by the field it searches, and the similar-photo and space context', () => {
    const query = {
      ...emptyDiscoveryQuery(),
      text: ' receipt ',
      textField: 'ocr' as const,
      queryAssetId: 'asset-1',
      spaceId,
    };
    expect(discoveryContextChips(query)).toEqual([
      { key: 'text', labelKey: 'ocr', value: 'receipt' },
      { key: 'queryAssetId', labelKey: 'frameleaf_search_bridge_similar_photo', value: null },
      { key: 'spaceId', labelKey: 'frameleaf_search_kind_space', value: null },
    ]);
    expect(discoveryContextChips({ ...emptyDiscoveryQuery(), text: 'dog', mode: 'smart' })).toEqual([
      { key: 'text', labelKey: 'context', value: 'dog' },
    ]);
    expect(discoveryContextChips({ ...emptyDiscoveryQuery(), text: 'IMG' })[0].labelKey).toBe('file_name_text');
    expect(discoveryContextChips(emptyDiscoveryQuery())).toEqual([]);
  });

  it('removes one context part and keeps everything else', () => {
    const query = {
      ...emptyDiscoveryQuery(),
      text: 'dog',
      mode: 'smart' as const,
      queryAssetId: 'asset-1',
      spaceId,
      filter: { isFavorite: { eq: true } },
    };
    expect(withoutDiscoveryContext(query, 'text')).toEqual({ ...query, text: '' });
    {
      const { queryAssetId: _, ...withoutReference } = query;
      expect(withoutDiscoveryContext(query, 'queryAssetId')).toEqual(withoutReference);
    }
    {
      const { spaceId: _, ...withoutSpace } = query;
      expect(withoutDiscoveryContext(query, 'spaceId')).toEqual(withoutSpace);
    }
    expect(query.queryAssetId).toBe('asset-1');
  });
});
