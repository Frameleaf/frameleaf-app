import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages, locale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { AlbumSortBy, SortOrder, albumViewSettings, type AlbumViewSettings } from '$lib/stores/preferences.store';
import type { AlbumSortOptionMetadata } from '$lib/utils/album-utils';
import AlbumsTableHeader from './AlbumsTableHeader.svelte';

const initialSettings = get(albumViewSettings);
const initialLocale = get(locale);
const labels = [
  [AlbumSortBy.Title, 'sort_title'],
  [AlbumSortBy.ItemCount, 'sort_items'],
  [AlbumSortBy.DateModified, 'sort_modified'],
  [AlbumSortBy.DateCreated, 'sort_created'],
  [AlbumSortBy.MostRecentPhoto, 'sort_recent'],
  [AlbumSortBy.OldestPhoto, 'sort_oldest'],
] as const;

const option = (id = AlbumSortBy.Title, defaultOrder = SortOrder.Asc): AlbumSortOptionMetadata => ({
  id,
  defaultOrder,
  columnStyle: 'text-start',
});

beforeEach(async () => {
  albumViewSettings.set({ ...initialSettings, sortBy: AlbumSortBy.MostRecentPhoto, sortOrder: SortOrder.Desc });
  addMessages('en', Object.fromEntries(labels.map(([, key]) => [key, `English ${key}`])));
  addMessages('fr', Object.fromEntries(labels.map(([, key]) => [key, `French ${key}`])));
  await locale.set('en');
  await tick();
});

afterEach(async () => {
  cleanup();
  albumViewSettings.set(initialSettings);
  await locale.set(initialLocale);
});

it.each(labels)('renders and translates the %s column after locale changes', async (id, key) => {
  const view = render(AlbumsTableHeader, { option: option(id) });
  expect(view.getByRole('button')).toHaveTextContent(`English ${key}`);
  expect(view.container.querySelector('th')).toHaveClass('text-start');
  await locale.set('fr');
  await tick();
  expect(view.getByRole('button')).toHaveTextContent(`French ${key}`);
});

it('updates the label and click target when the column option changes', async () => {
  const view = render(AlbumsTableHeader, { option: option() });
  await view.rerender({ option: option(AlbumSortBy.ItemCount, SortOrder.Desc) });
  expect(view.getByRole('button')).toHaveTextContent('English sort_items');
  await fireEvent.click(view.getByRole('button'));
  expect(get(albumViewSettings)).toMatchObject({ sortBy: AlbumSortBy.ItemCount, sortOrder: SortOrder.Desc });
});

it.each([SortOrder.Asc, SortOrder.Desc])('publishes a new column and its %s default together', async (defaultOrder) => {
  const before = { ...get(albumViewSettings), showAllAlbums: true, collapsedGroups: { Year: ['2026'] } };
  albumViewSettings.set(before);
  const view = render(AlbumsTableHeader, { option: option(AlbumSortBy.Title, defaultOrder) });
  const updates: AlbumViewSettings[] = [];
  const unsubscribe = albumViewSettings.subscribe((settings) => {
    updates.push(structuredClone(settings));
  });
  updates.length = 0;
  try {
    await fireEvent.click(view.getByRole('button'));
    expect(updates).toEqual([{ ...before, sortBy: AlbumSortBy.Title, sortOrder: defaultOrder }]);
    expect(view.getByRole('button')).toHaveTextContent(defaultOrder === SortOrder.Asc ? '↑' : '↓');
  } finally {
    unsubscribe();
  }
});

it('toggles an active column on each click and shows external settings changes', async () => {
  const view = render(AlbumsTableHeader, { option: option(AlbumSortBy.MostRecentPhoto) });
  const button = view.getByRole('button');
  expect(button).toHaveTextContent('↓');
  await fireEvent.click(button);
  expect(get(albumViewSettings).sortOrder).toBe(SortOrder.Asc);
  expect(button).toHaveTextContent('↑');
  await fireEvent.click(button);
  expect(get(albumViewSettings).sortOrder).toBe(SortOrder.Desc);
  albumViewSettings.update((settings) => ({ ...settings, sortBy: AlbumSortBy.Title }));
  await tick();
  expect(button.textContent?.trim()).toBe('English sort_recent');
});
