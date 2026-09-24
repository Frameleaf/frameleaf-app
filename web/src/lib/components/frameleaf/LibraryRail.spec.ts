import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { RAIL_CLOSED_SECTIONS_KEY } from '$lib/frameleaf/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { Route } from '$lib/route';
import { sidebarCollapsed } from '$lib/stores/preferences.store';
import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
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
  sdkMock.getPartners.mockResolvedValue([]);
  sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [], revision: 'r0' } as never);
});

afterEach(() => {
  authManager.reset();
});

describe('LibraryRail', () => {
  it('lists the sections in the September 24 order: Explore, Albums, Shared spaces, Tools', () => {
    render(LibraryRail);

    expect(headings()).toEqual(['Explore', 'Albums', 'Shared spaces', 'Tools']);
  });

  it('lists saved searches in Albums, after the album tree and before Shared links', async () => {
    authManager.setPreferences(preferencesFactory.build({ sharedLinks: { enabled: true, sidebarWeb: true } } as never));
    sdkMock.getAlbumTree.mockResolvedValue({
      collections: [],
      albums: [{ id: 'album-1', albumName: 'Porto' }],
      spaces: [],
    } as never);
    sdkMock.getMyPreferences.mockResolvedValue({
      savedSearches: [{ name: 'Lisbon', query: { ...emptyDiscoveryQuery(), filter: { city: { eq: 'Lisbon' } } } }],
      revision: 'r1',
    } as never);
    await savedSearchesStore.load(true); // a shared singleton
    render(LibraryRail);
    const albums = screen.getByRole('button', { name: 'Albums' }).getAttribute('aria-controls')!;
    const section = within(document.querySelector<HTMLElement>(`#${albums}`)!);
    await section.findByRole('link', { name: 'Porto' });
    await section.findByRole('link', { name: 'Lisbon' });
    const names = section.getAllByRole('link').map((link) => link.textContent?.trim());
    expect(names).toEqual(['All albums', 'Porto', 'Lisbon', 'Shared links']);
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [], revision: 'r2' } as never);
    await savedSearchesStore.load(true);
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

  it('heads the rail with "Library" and the double-chevron collapse toggle', async () => {
    render(LibraryRail);
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('lists each partner library under Shared spaces, and no "All shared spaces" entry', async () => {
    sdkMock.getPartners.mockResolvedValue([
      { id: 'jamie', name: 'Jamie', email: 'jamie@example.test', profileImagePath: '', avatarColor: 'primary' },
    ] as never);
    render(LibraryRail);

    const partner = await screen.findByRole('link', { name: 'Jamie’s library' });
    expect(partner).toHaveAttribute('href', Route.viewPartner({ id: 'jamie' }));
    expect(sdkMock.getPartners).toHaveBeenCalledWith({ direction: 'shared-with' });
    expect(screen.queryByRole('link', { name: 'All shared spaces' })).toBeNull();
  });
});
