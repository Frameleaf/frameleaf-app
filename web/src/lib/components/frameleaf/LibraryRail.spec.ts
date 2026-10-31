import { LibraryViewScope, AlbumKind } from '@frameleaf/sdk';
import { mdiCameraBurst, mdiFolderOutline, mdiHeartOutline } from '@mdi/js';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { resetIconCatalogueCache } from '$lib/frameleaf/icon-catalogue';
import { helpPanel } from '$lib/frameleaf/help-panel.svelte';
import { RAIL_CLOSED_SECTIONS_KEY } from '$lib/frameleaf/navigation';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { albumTreeDropdown, sidebarCollapsed } from '$lib/stores/preferences.store';
import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
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
  albumTreeDropdown.set(false);
  resetIconCatalogueCache();
  app.page.url = new URL('http://localhost/photos');
  authManager.setUser(userAdminFactory.build());
  sdkMock.getAlbumHierarchy.mockResolvedValue({ roots: [] });
  sdkMock.getPartners.mockResolvedValue([]);
  sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [], revision: 'r0' } as never);
  sdkMock.searchLibraryItems.mockResolvedValue({ count: 0, countCapped: false, items: [], nextCursor: null });
});

afterEach(() => {
  authManager.reset();
  vi.unstubAllGlobals();
});

const treeWithIcon = (icon: string | null) => ({
  roots: [
    {
      album: albumFactory.build({ id: 'collection', albumName: 'Collection', kind: AlbumKind.Collection, icon }),
      children: [
        {
          album: albumFactory.build({
            id: 'child',
            albumName: 'Child',
            kind: AlbumKind.Album,
            parentId: 'collection',
            icon,
          }),
          children: [],
        },
      ],
    },
    { album: albumFactory.build({ id: 'album', albumName: 'Album', kind: AlbumKind.Album, icon }), children: [] },
    { album: albumFactory.build({ id: 'space', albumName: 'Space', kind: AlbumKind.Space, icon }), children: [] },
  ],
});

describe('LibraryRail', () => {
  it('heads the phone menu with Boards, Studio, Activity and Help (UI review 2026-10-30 #8)', async () => {
    const { container } = render(LibraryRail);
    const group = container.querySelector<HTMLElement>('.fl-phone-sections')!;
    expect(within(group).getByRole('link', { name: 'Boards' })).toHaveAttribute('href', '/pro');
    expect(within(group).getByRole('link', { name: 'Studio' })).toHaveAttribute('href', Route.studioProjects());
    expect(within(group).getByRole('link', { name: 'Activity' })).toHaveAttribute('href', Route.activity());
    expect(within(group).queryByRole('link', { name: 'Library' })).not.toBeInTheDocument();
    helpPanel.open = false;
    await fireEvent.click(within(group).getByRole('button', { name: 'Help' }));
    expect(helpPanel.open).toBe(true);
    helpPanel.open = false;
  });

  it('uses the shared Design hierarchy and keeps Pro context on album/create links', async () => {
    app.page.url = new URL('http://localhost/pro');
    sdkMock.getAlbumHierarchy.mockResolvedValue(treeWithIcon(null));
    render(LibraryRail);
    const album = await screen.findByRole('link', { name: /^Album/ });
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledWith({ libraryScope: LibraryViewScope.Design });
    const url = new URL(album.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe('/albums/album');
    expect(url.searchParams.has('fl')).toBe(true);
  });

  it.each([
    ['mdiCameraBurst', mdiCameraBurst],
    ['heart', mdiHeartOutline],
    [null, mdiFolderOutline],
    ['__proto__', mdiFolderOutline],
    ['mdiUnknown', mdiFolderOutline],
  ])('renders stored %s geometry for every tree node while preserving its link', async (icon, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ mdiCameraBurst })));
    sdkMock.getAlbumHierarchy.mockResolvedValue(treeWithIcon(icon));
    albumTreeDropdown.set(true);
    app.page.url = new URL(Route.viewAlbum({ id: 'child' }), 'http://localhost');
    render(LibraryRail);

    for (const [name, id] of [
      ['Collection', 'collection'],
      ['Child', 'child'],
      ['Album', 'album'],
      ['Space', 'space'],
    ]) {
      const link = await screen.findByRole('link', { name });
      await waitFor(() => expect(link.querySelector('path')).toHaveAttribute('d', expected));
      expect(link).toHaveAttribute('href', id === 'space' ? Route.viewSharedSpace({ id }) : Route.viewAlbum({ id }));
      expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.getByRole('link', { name: 'Child' })).toHaveAttribute('aria-current', 'page');
    expect(fetch).toHaveBeenCalledTimes(icon?.startsWith('mdi') ? 1 : 0);
  });

  it('expands each nested branch without hiding its own page link', async () => {
    sdkMock.getAlbumHierarchy.mockResolvedValue({
      roots: [
        {
          album: albumFactory.build({ id: 'root', albumName: 'Root', kind: AlbumKind.Album }),
          children: [
            {
              album: albumFactory.build({
                id: 'nested',
                albumName: 'Nested',
                kind: AlbumKind.Collection,
                parentId: 'root',
              }),
              children: [
                {
                  album: albumFactory.build({
                    id: 'leaf',
                    albumName: 'Leaf',
                    kind: AlbumKind.Album,
                    parentId: 'nested',
                  }),
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
    render(LibraryRail);
    expect(await screen.findByRole('link', { name: 'Root' })).toHaveAttribute('href', Route.viewAlbum({ id: 'root' }));
    expect(screen.queryByRole('link', { name: 'Leaf' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: /Expand Root/ }));
    await fireEvent.click(await screen.findByRole('button', { name: /Expand Nested/ }));
    expect(await screen.findByRole('link', { name: 'Leaf' })).toHaveAttribute('href', Route.viewAlbum({ id: 'leaf' }));
    await fireEvent.click(screen.getByRole('button', { name: /Collapse Root/ }));
    expect(screen.queryByRole('link', { name: 'Leaf' })).toBeNull();
  });

  it('updates stored icon geometry after an album event and releases the subscription on unmount', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ mdiCameraBurst, mdiHeartOutline })));
    sdkMock.getAlbumHierarchy.mockResolvedValue(treeWithIcon('mdiCameraBurst'));
    const { unmount } = render(LibraryRail);
    const link = await screen.findByRole('link', { name: 'Album' });
    await waitFor(() => expect(link.querySelector('path')).toHaveAttribute('d', mdiCameraBurst));

    sdkMock.getAlbumHierarchy.mockResolvedValue(treeWithIcon('mdiHeartOutline'));
    eventManager.emit('AlbumUpdate', albumFactory.build({ icon: 'mdiHeartOutline' }));
    await waitFor(() => expect(link.querySelector('path')).toHaveAttribute('d', mdiHeartOutline));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledTimes(2);
    unmount();
    eventManager.emit('AlbumUpdate', albumFactory.build());
    expect(sdkMock.getAlbumHierarchy).toHaveBeenCalledTimes(2);
  });

  it('lists the sections in the September 24 order: Explore, Albums, Shared spaces, Tools', () => {
    render(LibraryRail);

    expect(headings()).toEqual(['Explore', 'Albums', 'Shared spaces', 'Tools']);
  });

  it('is the "Library navigation" landmark, as LibraryRail.jsx names it, not a second "Primary"', () => {
    render(LibraryRail);

    expect(screen.getByRole('navigation', { name: 'Library navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
  });

  it('lists saved searches in Albums, after the album tree and before Shared links', async () => {
    authManager.setPreferences(preferencesFactory.build({ sharedLinks: { enabled: true, sidebarWeb: true } } as never));
    sdkMock.getAlbumHierarchy.mockResolvedValue({
      roots: [{ album: { id: 'album-1', albumName: 'Porto', kind: AlbumKind.Album }, children: [] }],
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

  // FL-146 (owner decision 2026-09-27): what the prototype rail shows is on by default.
  const prototypeDefaults = {
    folders: { enabled: true, sidebarWeb: true },
    memories: { enabled: true, duration: 5, sidebarWeb: true },
    people: { enabled: true, sidebarWeb: true },
    recentlyAdded: { sidebarWeb: true },
    sharedLinks: { enabled: true, sidebarWeb: true },
    tags: { enabled: true, sidebarWeb: true },
  };

  it("shows every LibraryRail.jsx destination with the server's default preferences", () => {
    authManager.setPreferences(preferencesFactory.build(prototypeDefaults as never));
    render(LibraryRail);

    for (const name of ['Recently added', 'People', 'Memories', 'Tags', 'Folders', 'Shared links']) {
      expect(screen.getByRole('link', { name }), name).toBeInTheDocument();
    }
  });

  it('leaves out Recently added, Tags and Folders when the account or an administrator hid them', () => {
    authManager.setPreferences(
      preferencesFactory.build({
        ...prototypeDefaults,
        recentlyAdded: { sidebarWeb: false },
        tags: { enabled: true, sidebarWeb: false },
        folders: { enabled: false, sidebarWeb: true },
      } as never),
    );
    render(LibraryRail);

    expect(screen.queryByRole('link', { name: 'Recently added' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Tags' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Folders' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Favorites' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toBeInTheDocument();
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
    const { container } = render(LibraryRail);
    const toggle = screen.getByRole('button', { name: 'Collapse navigation' });

    expect(toggle.parentElement?.querySelector('.fl-rail-title')).toHaveTextContent('Library');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toHaveAttribute('aria-expanded', 'false');
    // The icon-only rail has no room for the label.
    await waitFor(() => expect(container.querySelector('.fl-rail-title')).toBeNull());
  });

  it('keeps Library Care, Settings and Support in the footer, after the list that scrolls', () => {
    const { container } = render(LibraryRail);
    const list = container.querySelector<HTMLElement>('.fl-sidebar-list')!;
    const footer = container.querySelector<HTMLElement>('.fl-rail-footer')!;

    expect(
      within(footer)
        .getAllByRole('link')
        .map((link) => link.textContent?.trim()),
    ).toEqual(['Library Care', 'Settings', 'Support Frameleaf']);
    expect(list).not.toContainElement(footer);
    expect(within(list).queryByRole('link', { name: 'Settings' })).toBeNull();
    // Reading and tab order stay list first, footer last.
    expect(list.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('thanks a supporter in place of "Support Frameleaf" once the server or the person has a key', () => {
    authManager.isPurchased = true;
    const { container } = render(LibraryRail);
    const footer = container.querySelector<HTMLElement>('.fl-rail-footer')!;

    expect(within(footer).getByRole('link', { name: 'Thanks for supporting' })).toHaveAttribute('href', Route.buy());
    expect(within(footer).queryByRole('link', { name: 'Support Frameleaf' })).toBeNull();
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

/** Boards (FL-622, README points 1, 11, 13 and 22): the rail of the Design workspace. */
describe('LibraryRail in Boards', () => {
  const boardsTree = {
    roots: [
      {
        album: albumFactory.build({
          id: 'brand',
          albumName: 'Brand refresh',
          kind: AlbumKind.Album,
          assetCount: 7,
          color: 'teal',
          icon: null,
        }),
        children: [
          {
            album: albumFactory.build({
              id: 'mood',
              albumName: 'Moodboard',
              kind: AlbumKind.Album,
              parentId: 'brand',
              assetCount: 4,
              color: null,
              icon: null,
            }),
            children: [],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    app.page.url = new URL('http://localhost/pro');
    sdkMock.getAlbumHierarchy.mockResolvedValue(boardsTree as never);
  });

  afterEach(async () => {
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [], revision: 'r9' } as never);
    await savedSearchesStore.load(true);
  });

  it('is titled Boards with a Free badge and lists All items, Images, Videos, Links and Unfiled with counts', async () => {
    sdkMock.searchLibraryItems.mockImplementation((({
      libraryItemSearchDto,
    }: {
      libraryItemSearchDto: { kinds?: string[] };
    }) =>
      Promise.resolve({
        count: libraryItemSearchDto.kinds?.includes('bookmark') ? 2 : 9,
        countCapped: false,
        items: [],
        nextCursor: null,
      })) as never);
    render(LibraryRail);

    expect(document.querySelector('.fl-boards-title')).toHaveTextContent(/^Boards\s*Free$/);
    expect(screen.queryByRole('button', { name: 'Albums' })).toBeNull();
    const items = within(screen.getByRole('navigation', { name: 'Boards items' }));
    const links = items.getAllByRole('link');
    expect(links.map((link) => link.querySelector('.fl-label')?.textContent)).toEqual([
      'All items',
      'Images',
      'Videos',
      'Links',
      'Unfiled',
    ]);
    expect(links[0]).toHaveAttribute('aria-current', 'page');
    expect(new URL(links[3].getAttribute('href')!, 'http://localhost').searchParams.get('kinds')).toBe('bookmark');
    await waitFor(() => expect(links[3]).toHaveTextContent('2'));
    expect(links[1]).toHaveTextContent('9');
    expect(sdkMock.searchLibraryItems).toHaveBeenCalledWith({
      libraryItemSearchDto: { filter: { libraryScope: LibraryViewScope.Design }, limit: 1, kinds: ['bookmark'] },
    });
  });

  it('marks Links current from the kinds parameter', () => {
    app.page.url = new URL('http://localhost/pro?kinds=bookmark');
    render(LibraryRail);
    const items = within(screen.getByRole('navigation', { name: 'Boards items' }));
    expect(items.getByRole('link', { name: /^Links/ })).toHaveAttribute('aria-current', 'page');
    expect(items.getByRole('link', { name: /^All items/ })).not.toHaveAttribute('aria-current');
  });

  it('shows collections as a nested tree with their own colour, counts and a "+" for a new one', async () => {
    albumTreeDropdown.set(true);
    render(LibraryRail);
    const brand = await screen.findByRole('link', { name: /^Brand refresh/ });
    expect(brand).toHaveTextContent('7');
    expect(brand.querySelector('[data-color="teal"]')).not.toBeNull();
    expect(await screen.findByRole('link', { name: /^Moodboard/ })).toHaveTextContent('4');
    const toggle = screen.getByRole('button', { name: /Brand refresh/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Moodboard/ })).toBeNull());
    const create = screen.getByRole('link', { name: 'New collection' });
    expect(new URL(create.getAttribute('href')!, 'http://localhost').searchParams.has('fl')).toBe(true);
  });

  it('lists smart collections saved in Boards, and leaves out searches saved in the Library', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({
      savedSearches: [
        {
          name: 'Teal and blue',
          query: {
            ...emptyDiscoveryQuery(),
            filter: { libraryScope: LibraryViewScope.Design, color: { hex: '#3d7f8f' } },
          },
        },
        { name: 'Lisbon', query: { ...emptyDiscoveryQuery(), filter: { city: { eq: 'Lisbon' } } } },
      ],
      revision: 'r3',
    } as never);
    await savedSearchesStore.load(true);
    render(LibraryRail);
    const smart = within(await screen.findByRole('navigation', { name: 'Smart collections' }));
    const link = smart.getByRole('link', { name: 'Teal and blue' });
    expect(new URL(link.getAttribute('href')!, 'http://localhost').pathname).toBe('/pro');
    expect(smart.queryByRole('link', { name: 'Lisbon' })).toBeNull();
  });

  it('opens "Get the browser extension" with its three steps', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    render(LibraryRail);
    await fireEvent.click(screen.getByRole('button', { name: 'Get the browser extension' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Save to Frameleaf from your browser' }));
    expect(dialog.getByText('Add the extension')).toBeInTheDocument();
    expect(dialog.getByText('For Chrome and Edge. Free.')).toBeInTheDocument();
    // FL-655: sign in with your Frameleaf account; a key is only the fallback
    expect(dialog.getByText('Sign in with your Frameleaf account')).toBeInTheDocument();
    expect(
      dialog.getByText(
        'In the extension, choose this server and press Sign in, then Allow. It can only save things and list your collections and tags. It can’t see your photos.',
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText('Start saving')).toBeInTheDocument();
    const key = dialog.getByRole('link', { name: 'Browser can’t sign in? Use a key instead' });
    expect(key.getAttribute('href')).toContain('section=api-keys');
    expect(dialog.queryByText('Paste it into the extension')).toBeNull();
    expect(dialog.queryByRole('link', { name: 'Make a browser key' })).toBeNull();
  });

  it('turns the drawer into the "Collections and filters" sheet only in Boards', () => {
    const { unmount } = render(LibraryRail);
    expect(document.documentElement).toHaveAttribute('data-fl-boards-rail');
    expect(screen.getByRole('heading', { name: 'Collections and filters' })).toBeInTheDocument();
    unmount();
    expect(document.documentElement).not.toHaveAttribute('data-fl-boards-rail');
    app.page.url = new URL('http://localhost/photos');
    render(LibraryRail);
    expect(document.documentElement).not.toHaveAttribute('data-fl-boards-rail');
  });
});
