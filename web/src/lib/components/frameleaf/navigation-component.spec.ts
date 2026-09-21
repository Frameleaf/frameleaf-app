import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { page } from '$app/state';
import { preferencesFactory } from '$lib/../test-data/factories/preferences-factory';
import { albumTreeDropdown, recentAlbumsDropdown } from '$lib/stores/preferences.store';
import en from '../../../../../i18n/en.json';
import Navigation from './Navigation.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/photos') } }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    preferences: preferencesFactory.build({ recentlyAdded: { sidebarWeb: true } }),
  },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { search: true, map: false, trash: true } },
}));

beforeEach(() => {
  albumTreeDropdown.set(false);
  recentAlbumsDropdown.set(false);
  addMessages('dev', en);
});

it.each([false, true])('renders real named destinations in iconOnly=%s mode', (iconOnly) => {
  render(Navigation, { iconOnly });
  expect(screen.getByRole('link', { name: 'Timeline' })).toHaveAttribute('href', '/photos');
  expect(screen.getByRole('link', { name: 'Best Photos' })).toHaveAttribute('href', '/best-photos');
  expect(screen.getByRole('link', { name: 'Locked' })).toHaveAttribute('href', '/locked');
  expect(screen.getByRole('link', { name: 'Explore' })).toHaveAttribute('href', '/explore');
  expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/user-settings');
  expect(screen.getByRole('link', { name: 'Utilities' })).toHaveAttribute('href', '/utilities');
  expect(screen.queryByRole('link', { name: 'Map' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Studio' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Library' }) !== null).toBe(!iconOnly);
});

it.each([
  ['/photos/asset-id?at=anchor', 'Timeline'],
  ['/best-photos/photos/asset-id', 'Best Photos'],
  ['/locked/photos/asset-id', 'Locked'],
  ['/albums/album-id/photos/asset-id', 'Albums'],
])('retains active navigation for deep link %s', (path, label) => {
  page.url = new URL(path, 'http://localhost') as typeof page.url;
  render(Navigation);
  expect(screen.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
});
