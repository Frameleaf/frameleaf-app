import { describe, expect, it } from 'vitest';
import {
  buildPhoneMenuDestinations,
  buildPrimaryDestinations,
  buildRailSections,
  currentPrimaryDestination,
  currentTab,
  defaultRailCapabilities,
  isClientsEnabled,
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
  recentlyAdded: true,
  search: true,
  map: true,
  trash: true,
  people: true,
  pets: true,
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
  it('keeps the section order Library, Explore, Albums, Shared spaces, with no Tools section (FL-1806)', () => {
    expect(buildRailSections(allCapabilities()).map((section) => section.id)).toEqual([
      'library',
      'explore',
      'albums',
      'spaces',
      'footer',
    ]);
  });

  it('lists Explore as Explore, People & pets, Places & map, Memories, Documents, Tags, Folders', () => {
    const explore = buildRailSections(allCapabilities()).find((section) => section.id === 'explore');

    expect(explore?.destinations.map(({ id, labelKey }) => [id, labelKey])).toEqual([
      ['explore', 'explore'],
      ['people', 'frameleaf_rail_people_pets'],
      ['places', 'frameleaf_rail_places_map'],
      ['memories', 'memories'],
      ['documents', 'frameleaf_documents_title'],
      ['tags', 'tags'],
      ['folders', 'folders'],
    ]);
  });

  it('puts All shared under All albums, above Shared links (FL-1809)', () => {
    const albums = buildRailSections(allCapabilities()).find((section) => section.id === 'albums');

    expect(albums?.destinations.map(({ id }) => id)).toEqual(['allAlbums', 'allShared', 'sharedLinks']);
    expect(find(allCapabilities(), 'allShared')?.href).toBe(Route.sharing());
    // A shared space's own page belongs to its rail row, not to All shared.
    expect(isDestinationCurrent(Route.viewSharedSpace({ id: 'space-id' }), find(allCapabilities(), 'allShared')!)).toBe(
      false,
    );
  });

  it('ends with Import, Library care, Trash, Settings and Support in the footer', () => {
    const footer = buildRailSections(allCapabilities()).find((section) => section.id === 'footer');

    expect(footer?.destinations.map(({ id }) => id)).toEqual(['import', 'libraryCare', 'trash', 'settings', 'support']);
    expect(find(allCapabilities(), 'import')?.href).toBe(Route.importPlace());
    expect(find({ ...allCapabilities(), trash: false }, 'trash')).toBeUndefined();
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

  it('drops Recently added when the account or an administrator hid it (FL-146)', () => {
    const [library] = buildRailSections({ ...allCapabilities(), recentlyAdded: false });

    expect(library.destinations.map((destination) => destination.id)).toEqual([
      'library',
      'favorites',
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
    const capabilities = { ...allCapabilities(), tags: false, sharedLinks: false };
    const ids = new Set(flatten(capabilities).map((destination) => destination.id));

    expect(ids.has('tags')).toBe(false);
    expect(ids.has('sharedLinks')).toBe(false);
    expect(ids.has('people')).toBe(true);
    expect(ids.has('allAlbums')).toBe(true);
  });

  it('keeps People & pets while either People or Pets is in the sidebar, and current on both pages', () => {
    expect(find({ ...allCapabilities(), pets: false }, 'people')?.href).toBe(Route.people());
    expect(find({ ...allCapabilities(), people: false, pets: false }, 'people')).toBeUndefined();

    const people = find(allCapabilities(), 'people')!;
    expect(isDestinationCurrent(Route.people(), people)).toBe(true);
    expect(isDestinationCurrent(Route.pets(), people)).toBe(true);
    expect(isDestinationCurrent(Route.viewPet({ id: 'pet-id' }), people)).toBe(true);
  });

  it('opens Pets from People & pets when People is the one turned off, and says Places without the map', () => {
    expect(find({ ...allCapabilities(), people: false }, 'people')?.href).toBe(Route.pets());
    expect(find({ ...allCapabilities(), map: false }, 'places')?.labelKey).toBe('places');
    expect(find(allCapabilities(), 'places')?.labelKey).toBe('frameleaf_rail_places_map');
  });

  it('keeps Places & map current on the map', () => {
    const places = find(allCapabilities(), 'places')!;

    expect(isDestinationCurrent(Route.places(), places)).toBe(true);
    expect(isDestinationCurrent(Route.map(), places)).toBe(true);
  });

  it('always keeps the destinations that do not depend on a capability', () => {
    const ids = new Set(flatten(defaultRailCapabilities()).map((destination) => destination.id));

    expect([...ids]).toEqual([
      'library',
      'favorites',
      'bestPhotos',
      'archive',
      'locked',
      'places',
      'documents',
      'allAlbums',
      'allShared',
      'import',
      'libraryCare',
      'settings',
      'support',
    ]);
  });

  it('offers one utilities entry and no repeated utility shortcuts', () => {
    const hrefs = flatten(allCapabilities()).map((destination) => destination.href);

    expect(hrefs.filter((href) => href === Route.libraryCare())).toHaveLength(1);
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

  it('keeps the rail’s Library current on search results, which are the Library narrowed by a search', () => {
    const destinations = buildRailSections(defaultRailCapabilities()).flatMap((section) => section.destinations);
    const active = (url: string) =>
      destinations.filter((item) => isDestinationCurrent(url, item)).map((item) => item.id);
    expect(active('/search?dq=%7B%7D')).toEqual(['library']);
    expect(active('/search/photos/asset-id?dq=%7B%7D')).toEqual(['library']);
    expect(active('/searching')).toEqual([]);
  });

  it('tells the places (Import, Library care, Trash) from Settings on their shared pathname', () => {
    const destinations = flatten(allCapabilities()).filter(({ id }) =>
      ['import', 'libraryCare', 'trash', 'settings'].includes(id),
    );
    const active = (url: string) =>
      destinations.filter((item) => isDestinationCurrent(url, item)).map((item) => item.id);
    expect(active(Route.utilities())).toEqual(['libraryCare']);
    expect(active(Route.duplicatesUtility())).toEqual(['libraryCare']);
    expect(active(Route.libraryCare())).toEqual(['libraryCare']);
    expect(active(commandCenterUrl('care', 'repair'))).toEqual(['libraryCare']);
    expect(active(Route.workflows())).toEqual(['libraryCare']);
    expect(active(Route.importPlace())).toEqual(['import']);
    // FL-1808: iCloud Photos and the phone apps are ways photos come in.
    expect(active(Route.icloudSyncUtility())).toEqual(['import']);
    expect(active(Route.downloadsUtility())).toEqual(['import']);
    expect(active(Route.takeout())).toEqual(['import']);
    expect(active(Route.trash())).toEqual(['trash']);
    expect(active(Route.userSettings())).toEqual(['settings']);
    expect(active(commandCenterUrl('preferences'))).toEqual(['settings']);
  });

  it('leaves an album page to its tree item instead of All albums', () => {
    const allAlbums = find(allCapabilities(), 'allAlbums')!;

    expect(isDestinationCurrent(Route.albums(), allAlbums)).toBe(true);
    expect(isDestinationCurrent(Route.viewAlbum({ id: 'album-id' }), allAlbums)).toBe(false);
  });

  it('keeps Studio, Activity, Clients, RAW support and Workflows out of the rail', () => {
    const hrefs = flatten(allCapabilities()).map((destination) => destination.href);

    for (const href of [
      Route.studioProjects(),
      Route.studio(),
      Route.activity(),
      Route.photography(),
      Route.rawSupport(),
      Route.workflows(),
      Route.pets(),
      Route.map(),
    ]) {
      expect(hrefs).not.toContain(href);
    }
  });

  it('reads Clients as off when the preference is missing', () => {
    expect(isClientsEnabled(undefined)).toBe(false);
    expect(isClientsEnabled({})).toBe(false);
    expect(isClientsEnabled({ clients: { enabled: false } })).toBe(false);
    expect(isClientsEnabled({ clients: { enabled: true } })).toBe(true);
  });
});

describe('Frameleaf primary destinations', () => {
  it('always puts Clients between Boards and Studio (FL-1806)', () => {
    const destinations = buildPrimaryDestinations();

    expect(destinations.map((destination) => destination.id)).toEqual([
      'library',
      'pro',
      'clients',
      'studio',
      'activity',
    ]);
    expect(destinations.find(({ id }) => id === 'clients')).toMatchObject({
      labelKey: 'frameleaf_photography',
      href: Route.photography(),
    });
  });

  it('heads the phone menu with every section but Library (UI review 2026-10-30 #8)', () => {
    expect(buildPhoneMenuDestinations().map(({ id }) => id)).toEqual(['pro', 'clients', 'studio', 'activity']);
  });

  it('keeps Clients current in its workspace and the RAW develop editor', () => {
    expect(currentPrimaryDestination(Route.photography())).toBe('clients');
    expect(currentPrimaryDestination(Route.photographyDevelop({ shoot: 'shoot-id' }))).toBe('clients');
    expect(currentPrimaryDestination('/photographyx')).toBeNull();
  });

  it('sends Library home, Studio to the project library and Activity to its page', () => {
    const hrefs = Object.fromEntries(buildPrimaryDestinations().map(({ id, href }) => [id, href]));

    expect(hrefs).toEqual({
      library: Route.photos(),
      pro: '/pro',
      clients: Route.photography(),
      studio: Route.studioProjects(),
      activity: Route.activity(),
    });
  });

  it('keeps Pro current while viewing design assets', () => {
    expect(currentPrimaryDestination('/pro')).toBe('pro');
    expect(currentPrimaryDestination('/pro/photos/asset')).toBe('pro');
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
    expect(readClosedRailSections(memoryStorage('["library","footer","tools","albums","albums"]'))).toEqual(['albums']);
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
  it('is absent from Studio, Clients and the settings screens', () => {
    expect(showsTabBar(Route.photography())).toBe(false);
    expect(showsTabBar(Route.photographyDevelop({ shoot: 'shoot-id' }))).toBe(false);
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
    expect(currentTab(Route.pets())).toBeNull();
    expect(currentTab('/pets/pet-id')).toBeNull();
    expect(currentTab(Route.map())).toBeNull();
    expect(currentTab(Route.places())).toBeNull();
    expect(currentTab(Route.activity())).toBeNull();
  });
});
