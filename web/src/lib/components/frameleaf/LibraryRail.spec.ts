import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { RAIL_CLOSED_SECTIONS_KEY } from '$lib/frameleaf/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { sidebarCollapsed } from '$lib/stores/preferences.store';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import LibraryRail from './LibraryRail.svelte';

const app = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/photos'), route: { id: '/(user)/photos' }, params: {} },
}));

vi.mock('$app/state', () => ({ page: app.page }));
const media = vi.hoisted(() => ({ isFullSidebar: true, maxMd: false, pointerCoarse: false, reducedMotion: false }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({ mediaQueryManager: media }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { search: true, map: true, trash: true } },
}));

const headings = () =>
  screen
    .getAllByRole('button', { expanded: true })
    .concat(screen.queryAllByRole('button', { expanded: false }))
    .filter((button) => button.classList.contains('fl-heading-toggle'))
    .map((button) => button.textContent?.trim());

beforeEach(() => {
  addMessages('dev', en);
  localStorage.clear();
  sidebarCollapsed.set(false);
  authManager.setUser(userAdminFactory.build());
  sdkMock.getAlbumTree.mockResolvedValue({ collections: [], albums: [], spaces: [] });
});

afterEach(() => {
  authManager.reset();
});

describe('LibraryRail', () => {
  it('lists the sections in the September 24 order: Explore, Albums, Shared spaces, Tools', () => {
    render(LibraryRail);

    expect(headings()).toEqual(['Explore', 'Albums', 'Shared spaces', 'Tools']);
  });

  it('folds a section from its heading and remembers it on this device', async () => {
    render(LibraryRail);
    const explore = screen.getByRole('button', { name: 'Explore' });
    expect(screen.getByRole('link', { name: 'Places' })).toBeVisible();

    await fireEvent.click(explore);

    expect(explore).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Places' })).toBeNull();
    expect(JSON.parse(localStorage.getItem(RAIL_CLOSED_SECTIONS_KEY) ?? '[]')).toEqual(['explore']);
  });

  it('opens a section folded on an earlier visit closed', () => {
    localStorage.setItem(RAIL_CLOSED_SECTIONS_KEY, JSON.stringify(['tools']));
    render(LibraryRail);

    expect(screen.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull();
  });

  it('offers New album and New shared space as requests to the Albums page', () => {
    render(LibraryRail);

    expect(screen.getByRole('link', { name: 'New album' })).toHaveAttribute('href', Route.newAlbum({ kind: 'album' }));
    expect(screen.getByRole('link', { name: 'New shared space' })).toHaveAttribute(
      'href',
      Route.newAlbum({ kind: 'space' }),
    );
    // All albums itself never carries the request, so opening it cannot replay one.
    expect(screen.getByRole('link', { name: 'All albums' })).toHaveAttribute('href', Route.albums());
  });

  it('opens Library Care at the Library care hub', () => {
    render(LibraryRail);

    expect(screen.getByRole('link', { name: 'Library Care' })).toHaveAttribute('href', Route.libraryCare());
  });

  it('shows every section in the icon-only rail, whatever was folded', () => {
    localStorage.setItem(RAIL_CLOSED_SECTIONS_KEY, JSON.stringify(['explore', 'tools']));
    sidebarCollapsed.set(true);
    const { container } = render(LibraryRail);

    // No headings to reopen a section from, so nothing stays folded.
    expect(container.querySelectorAll('.fl-heading-toggle')).toHaveLength(0);
    const rail = within(container as HTMLElement);
    expect(rail.getByRole('link', { name: 'Places' })).toBeInTheDocument();
    expect(rail.getByRole('link', { name: 'Workflows' })).toBeInTheDocument();
  });
});
