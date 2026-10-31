import { get } from 'svelte/store';
import { albumViewSettings, placesViewSettings, type AlbumViewSettings } from '$lib/stores/preferences.store';
import { isAlbumGroupCollapsed, toggleAlbumGroupCollapsing } from './album-utils';
import {
  collapseAllPlacesGroups,
  expandAllPlacesGroups,
  isPlacesGroupCollapsed,
  togglePlacesGroupCollapsing,
} from './places-utils';

const initialAlbums = structuredClone(get(albumViewSettings));
const initialPlaces = structuredClone(get(placesViewSettings));

afterEach(() => {
  albumViewSettings.set(structuredClone(initialAlbums));
  placesViewSettings.set(structuredClone(initialPlaces));
});

describe.each([
  ['albums', isAlbumGroupCollapsed],
  ['places', isPlacesGroupCollapsed],
] as const)('%s collapse queries', (_, isCollapsed) => {
  it('does not create a saved entry when reading an unconfigured group', () => {
    const settings = { ...initialAlbums, groupBy: 'test-group', collapsedGroups: {} };
    expect(isCollapsed(settings, 'a')).toBe(false);
    expect(settings.collapsedGroups).toEqual({});
  });

  it('does not initialize a missing legacy collapse map while reading', () => {
    const settings: AlbumViewSettings = {
      ...initialAlbums,
      groupBy: 'test-group',
      collapsedGroups: undefined as unknown as AlbumViewSettings['collapsedGroups'],
    };
    expect(isCollapsed(settings, 'a')).toBe(false);
    expect(settings.collapsedGroups).toBeUndefined();
  });

  it('can read a frozen unconfigured preference snapshot', () => {
    const settings = Object.freeze({ ...initialAlbums, groupBy: 'test-group', collapsedGroups: Object.freeze({}) });
    expect(isCollapsed(settings, 'a')).toBe(false);
  });

  it('reads only the selected grouping and treats None as expanded', () => {
    const settings = { ...initialAlbums, groupBy: 'one', collapsedGroups: { one: ['a'], two: ['b'], None: ['a'] } };
    expect(isCollapsed(settings, 'a')).toBe(true);
    expect(isCollapsed(settings, 'b')).toBe(false);
    expect(isCollapsed({ ...settings, groupBy: 'two' }, 'b')).toBe(true);
    expect(isCollapsed({ ...settings, groupBy: 'None' }, 'a')).toBe(false);
  });
});

it('toggles album groups without changing other grouping preferences', () => {
  albumViewSettings.set({ ...initialAlbums, groupBy: 'Year', collapsedGroups: { Owner: ['owner'] } });
  toggleAlbumGroupCollapsing('2026');
  expect(get(albumViewSettings)).toEqual({
    ...initialAlbums,
    groupBy: 'Year',
    collapsedGroups: { Owner: ['owner'], Year: ['2026'] },
  });
  toggleAlbumGroupCollapsing('2026');
  expect(get(albumViewSettings).collapsedGroups).toEqual({ Owner: ['owner'], Year: [] });
});

it('toggles Places groups without changing other grouping preferences', () => {
  placesViewSettings.set({ ...initialPlaces, groupBy: 'Country', collapsedGroups: { CountryState: ['state'] } });
  togglePlacesGroupCollapsing('country');
  expect(get(placesViewSettings).collapsedGroups).toEqual({ CountryState: ['state'], Country: ['country'] });
  togglePlacesGroupCollapsing('country');
  expect(get(placesViewSettings).collapsedGroups).toEqual({ CountryState: ['state'], Country: [] });
});

it('copies a Places collapse list without clearing an aliased input', () => {
  const ids = ['one', 'two'];
  placesViewSettings.set({ ...initialPlaces, groupBy: 'Country', collapsedGroups: { Country: ids } });
  collapseAllPlacesGroups(ids);
  expect(ids).toEqual(['one', 'two']);
  expect(get(placesViewSettings).collapsedGroups.Country).toEqual(ids);
  expect(get(placesViewSettings).collapsedGroups.Country).not.toBe(ids);
});

it('preserves collapse order, duplicates and other groupings without retaining caller arrays', () => {
  placesViewSettings.set({ ...initialPlaces, groupBy: 'Country', collapsedGroups: { CountryState: ['state'] } });
  const ids = ['two', 'one', 'two'];
  collapseAllPlacesGroups(ids);
  ids.push('later');
  expect(get(placesViewSettings).collapsedGroups).toEqual({ CountryState: ['state'], Country: ['two', 'one', 'two'] });
  expandAllPlacesGroups();
  expect(get(placesViewSettings).collapsedGroups).toEqual({ CountryState: ['state'], Country: [] });
});

it('keeps None toggles inactive for both stores', () => {
  const albums = { ...initialAlbums, groupBy: 'None', collapsedGroups: {} };
  const places = { ...initialPlaces, groupBy: 'None', collapsedGroups: {} };
  albumViewSettings.set(albums);
  placesViewSettings.set(places);
  toggleAlbumGroupCollapsing('a');
  togglePlacesGroupCollapsing('b');
  expect(get(albumViewSettings)).toEqual(albums);
  expect(get(placesViewSettings)).toEqual(places);
});
