import { describe, expect, it } from 'vitest';
import {
  buildPrimaryDestinations,
  buildRailSections,
  currentPrimaryDestination,
  currentTab,
  defaultRailCapabilities,
  isDestinationCurrent,
  isSettingsRoute,
  RAIL_CLOSED_SECTIONS_KEY,
  readClosedRailSections,
  showsTabBar,
  toggleRailSection,
  type RailCapabilities,
  type RailDestination,
} from '$lib/frameleaf/navigation';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { Route } from '$lib/route';

const allCapabilities = (): RailCapabilities => ({
  search: true,
  map: true,
  trash: true,
  people: true,
  memories: true,
  tags: true,
  folders: true,
  sharedLinks: true,
});

const flatten = (capabilities: RailCapabilities) =>
  buildRailSections(capabilities).flatMap((section) => section.destinations);

const find = (capabilities: RailCapabilities, id: RailDestination['id']) =>
  flatten(capabilities).find((destination) => destination.id === id);

describe('Frameleaf rail destinations', () => {
  it('keeps the September 24 section order: Library, Explore, Albums, Shared spaces, Tools', () => {
    expect(buildRailSections(allCapabilities()).map((section) => section.id)).toEqual([
      'library',
      'explore',
      'albums',
      'spaces',
      'tools',
      'footer',
    ]);
  });

  it('opens with Library, Favorites, Recently added, Best Photos, Archive and Locked', () => {
    const [library] = buildRailSections(allCapabilities());

    expect(library.destinations.map((destination) => destination.id)).toEqual([
      'library',
      'favorites',
      'recentlyAdded',
      'bestPhotos',
      'archive',
      'locked',
    ]);
  });

  it('points Locked at the one Locked view, not the legacy suppressed-content page', () => {
    const locked = find(allCapabilities(), 'locked');

    expect(locked?.href).toBe(Route.locked());
    expect(locked?.href).not.toBe(Route.suppressed());
  });

  it('hides destinations the account has turned off, without touching the rest', () => {
    const capabilities = { ...allCapabilities(), map: false, tags: false, sharedLinks: false };
    const ids = new Set(flatten(capabilities).map((destination) => destination.id));

    expect(ids.has('map')).toBe(false);
    expect(ids.has('tags')).toBe(false);
    expect(ids.has('sharedLinks')).toBe(false);
    expect(ids.has('people')).toBe(true);
    expect(ids.has('allAlbums')).toBe(true);
  });

  it('keeps Pets next to People and never hides it behind an account preference', () => {
    const explore = buildRailSections(allCapabilities()).find((section) => section.id === 'explore');
    const ids = explore?.destinations.map((destination) => destination.id) ?? [];

    expect(ids.indexOf('pets')).toBe(ids.indexOf('people') + 1);
    // Pets is a Frameleaf feature with no upstream feature preference behind it, so no
    // capability can remove it.
    expect(flatten(defaultRailCapabilities()).some((destination) => destination.id === 'pets')).toBe(true);
    expect(find(allCapabilities(), 'pets')?.href).toBe(Route.pets());
  });

  it('always keeps the destinations that do not depend on a capability', () => {
    const ids = new Set(flatten(defaultRailCapabilities()).map((destination) => destination.id));

    expect([...ids]).toEqual([
      'library',
      'favorites',
      'recentlyAdded',
      'bestPhotos',
      'archive',
      'locked',
      'pets',
      'places',
      'documents',
      'allAlbums',
      'workflows',
      'libraryCare',
      'settings',
      'support',
    ]);
  });

  it('offers one utilities entry and no repeated utility shortcuts', () => {
    const hrefs = flatten(allCapabilities()).map((destination) => destination.href);

    expect(hrefs.filter((href) => href === Route.libraryCare())).toHaveLength(1);
    expect(hrefs).not.toContain(Route.utilities());
    expect(hrefs).not.toContain(Route.duplicatesUtility());
    expect(hrefs).not.toContain(Route.largeFileUtility());
    expect(hrefs).not.toContain(Route.livePhotosUtility());
  });

  it('never lists the same destination twice', () => {
    const ids = flatten(allCapabilities()).map((destination) => destination.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks a destination current for its own page and its child routes', () => {
    const library = find(allCapabilities(), 'library')!;

    expect(isDestinationCurrent(Route.photos(), library)).toBe(true);
    expect(isDestinationCurrent('/photos/asset-id', library)).toBe(true);
    expect(isDestinationCurrent('/photos-of-something', library)).toBe(false);
    expect(isDestinationCurrent(Route.favorites(), library)).toBe(false);
  });

  it('distinguishes utilities, workflows, Care and personal settings on their shared pathname', () => {
    const destinations = (['settings', 'libraryCare', 'workflows'] as const).map((id) => find(allCapabilities(), id)!);
    const active = (url: string) =>
      destinations.filter((item) => isDestinationCurrent(url, item)).map((item) => item.id);
    expect(active(Route.utilities())).toEqual(['libraryCare']);
    expect(active(Route.duplicatesUtility())).toEqual(['libraryCare']);
    expect(active(Route.libraryCare())).toEqual(['libraryCare']);
    expect(active(commandCenterUrl('care', 'repair'))).toEqual(['libraryCare']);
    expect(active(Route.workflows())).toEqual(['workflows']);
    expect(active(Route.userSettings())).toEqual(['settings']);
  });

  it('leaves an album page to its tree item instead of All albums', () => {
    const allAlbums = find(allCapabilities(), 'allAlbums')!;

    expect(isDestinationCurrent(Route.albums(), allAlbums)).toBe(true);
    expect(isDestinationCurrent(Route.viewAlbum({ id: 'album-id' }), allAlbums)).toBe(false);
  });

  it('keeps Studio and Activity out of the rail; Tools holds only Workflows and Trash', () => {
    const tools = buildRailSections(allCapabilities()).find((section) => section.id === 'tools');
    const hrefs = flatten(allCapabilities()).map((destination) => destination.href);

    expect(tools?.destinations.map((destination) => destination.id)).toEqual(['workflows', 'trash']);
    expect(hrefs).not.toContain(Route.studioProjects());
    expect(hrefs).not.toContain(Route.studio());
    expect(hrefs).not.toContain(Route.activity());
  });
});

describe('Frameleaf primary destinations', () => {
  it('offers Library, Studio and Activity in the prototype order', () => {
    expect(buildPrimaryDestinations().map((destination) => destination.id)).toEqual(['library', 'studio', 'activity']);
  });

  it('sends Library home, Studio to the project library and Activity to its page', () => {
    const hrefs = Object.fromEntries(buildPrimaryDestinations().map(({ id, href }) => [id, href]));

    expect(hrefs).toEqual({
      library: Route.photos(),
      studio: Route.studioProjects(),
      activity: Route.activity(),
    });
  });

  it('keeps Studio current in the project library and the editor', () => {
    expect(currentPrimaryDestination('/studio/projects')).toBe('studio');
    expect(currentPrimaryDestination('/studio')).toBe('studio');
  });

  it('keeps Activity current on its page only', () => {
    expect(currentPrimaryDestination('/activity')).toBe('activity');
    // A path that merely starts with "activity" is not the Activity screen, and is not one of
    // the prototype's library/people/explore screens either.
    expect(currentPrimaryDestination('/activity-log')).toBeNull();
  });

  it('keeps Library current on the screens the prototype maps to "library", "people" and "explore"', () => {
    for (const pathname of [
      Route.photos(),
      '/photos/asset-id',
      Route.favorites(),
      Route.recentlyAdded(),
      Route.bestPhotos(),
      Route.archive(),
      Route.locked(),
      Route.suppressed(),
      Route.pets(),
      Route.documents(),
      Route.viewDocumentAsset({ id: 'asset-id' }),
      Route.viewAlbum({ id: 'album-id' }),
      Route.viewSharedSpace({ id: 'space-id' }),
      Route.people(),
      Route.explore(),
      Route.search(),
    ]) {
      expect(currentPrimaryDestination(pathname)).toBe('library');
    }
    // A path that merely starts with "studio" is not Studio; with no prototype screen of its own it
    // leaves the switcher without a current item (fc7021f6e9 narrowed Library to the prototype's set).
    expect(currentPrimaryDestination('/studios')).toBeNull();
  });

  it('leaves the switcher without a current item on the prototype screens that are not library/people/explore', () => {
    for (const pathname of [
      // The all-albums and all-spaces indexes are the prototype's own "collections" screen.
      Route.albums(),
      Route.sharing(),
      // A person's own page is the prototype's "person" screen, distinct from "people".
      Route.viewPerson({ id: 'person-id' }),
      Route.places(),
      Route.map(),
      Route.memories(),
      Route.tags(),
      Route.folders(),
      Route.sharedLinks(),
      Route.viewPartner({ id: 'partner-id' }),
      Route.buy(),
      Route.workflows(),
      Route.trash(),
      Route.utilities(),
    ]) {
      expect(currentPrimaryDestination(pathname)).toBeNull();
    }
  });

  it('leaves the switcher without a current item in settings and administration', () => {
    expect(currentPrimaryDestination(Route.userSettings())).toBeNull();
    expect(currentPrimaryDestination(Route.systemSettings())).toBeNull();
    expect(currentPrimaryDestination(Route.users())).toBeNull();
  });

  it("treats /admin and /user-settings as the prototype's one settings screen", () => {
    expect(isSettingsRoute(Route.systemSettings())).toBe(true);
    // Users, Trash and every old administration page are Command Center sections now (FL-71).
    expect(isSettingsRoute(new URL(Route.users(), 'https://frameleaf.local').pathname)).toBe(true);
    expect(isSettingsRoute(new URL(Route.trash(), 'https://frameleaf.local').pathname)).toBe(true);
    expect(isSettingsRoute('/admin/users')).toBe(true);
    expect(isSettingsRoute(Route.userSettings())).toBe(true);
    expect(isSettingsRoute(Route.photos())).toBe(false);
  });
});

describe('Frameleaf rail folding', () => {
  const memoryStorage = (initial?: string) => {
    const values = new Map<string, string>(initial === undefined ? [] : [[RAIL_CLOSED_SECTIONS_KEY, initial]]);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      values,
    };
  };

  it('opens every section on a device that has folded nothing', () => {
    expect(readClosedRailSections(memoryStorage())).toEqual([]);
    expect(readClosedRailSections(undefined)).toEqual([]);
  });

  it('remembers a folded section on this device and unfolds it again', () => {
    const storage = memoryStorage();
    const folded = toggleRailSection([], 'albums', storage);

    expect(folded).toEqual(['albums']);
    expect(readClosedRailSections(storage)).toEqual(['albums']);
    expect(toggleRailSection(folded, 'albums', storage)).toEqual([]);
    expect(readClosedRailSections(storage)).toEqual([]);
  });

  it('ignores unreadable or foreign values instead of hiding the rail', () => {
    expect(readClosedRailSections(memoryStorage('not json'))).toEqual([]);
    expect(readClosedRailSections(memoryStorage('{"albums":true}'))).toEqual([]);
    expect(readClosedRailSections(memoryStorage('["library","footer","tools","tools"]'))).toEqual(['tools']);
  });

  it('still folds for this visit when storage refuses the write', () => {
    const storage = {
      setItem: () => {
        throw new Error('quota');
      },
    };

    expect(toggleRailSection([], 'explore', storage)).toEqual(['explore']);
  });
});

describe('Frameleaf phone tab bar', () => {
  it('is absent from Studio and the settings screens', () => {
    expect(showsTabBar(Route.photos())).toBe(true);
    expect(showsTabBar(Route.albums())).toBe(true);
    expect(showsTabBar(Route.studio())).toBe(false);
    expect(showsTabBar(Route.studioProjects())).toBe(false);
    expect(showsTabBar('/user-settings')).toBe(false);
    expect(showsTabBar('/admin/users')).toBe(false);
  });

  it('marks Library current on the library screen and on collections opened from it', () => {
    expect(currentTab(Route.photos())).toBe('library');
    expect(currentTab(Route.favorites())).toBe('library');
    expect(currentTab(Route.viewAlbum({ id: 'album-id' }))).toBe('library');
  });

  it('marks Albums current on the albums and shared spaces indexes only', () => {
    expect(currentTab(Route.albums())).toBe('albums');
    expect(currentTab(Route.sharing())).toBe('albums');
  });

  it('marks Memories and Search on their own screens', () => {
    expect(currentTab(Route.memories())).toBe('memories');
    expect(currentTab('/memories/memory-id')).toBe('memories');
    expect(currentTab('/search')).toBe('search');
  });

  it('leaves every tab uncurrent on screens only the drawer reaches', () => {
    expect(currentTab(Route.people())).toBeNull();
    expect(currentTab(Route.explore())).toBeNull();
    expect(currentTab(Route.map())).toBeNull();
    expect(currentTab(Route.places())).toBeNull();
    expect(currentTab(Route.activity())).toBeNull();
  });
});
