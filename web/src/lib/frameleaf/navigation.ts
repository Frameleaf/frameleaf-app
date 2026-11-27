import {
  mdiAccountMultipleOutline,
  mdiAccountOutline,
  mdiCameraIris,
  mdiArchiveOutline,
  mdiClockOutline,
  mdiCogOutline,
  mdiDeleteOutline,
  mdiFolderMultipleOutline,
  mdiHandHeartOutline,
  mdiHeartOutline,
  mdiHistory,
  mdiImageAlbum,
  mdiImageMultipleOutline,
  mdiImageSearchOutline,
  mdiLinkVariant,
  mdiMapMarkerMultipleOutline,
  mdiMovieEditOutline,
  mdiProgressClock,
  mdiShieldCheckOutline,
  mdiShieldLockOutline,
  mdiStarOutline,
  mdiTagMultipleOutline,
  mdiTextBoxSearchOutline,
  mdiTrayArrowDown,
  mdiViewDashboardOutline,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import { Route } from '$lib/route';

/**
 * Frameleaf primary destinations (FL-30).
 *
 * The top bar's switcher in `design/frameleaf/template/src/App.jsx` (`.primary-nav`): Library,
 * Studio and Activity, in that order, as text only. They are the product's three workspaces, so
 * they live in the top bar and never in the rail.
 *
 * - Library opens the library home.
 * - Studio opens the project library (FL-91), where every project, the archive and the trash
 *   live; the editor itself is reached from there.
 * - Activity opens the Activity page (FL-104).
 *
 * The icons are the ones the prototype's command index gives the same pages; the switcher itself
 * shows only the labels.
 *
 * Clients (the photography-studio suite, formerly Photography) always sits in the top bar between
 * Boards and Studio (FL-1806, approved 2026-11-26): until the account starts using it, the page
 * opens its introduction (`ClientsIntro.jsx`).
 */

export type PrimaryDestinationId = 'library' | 'pro' | 'clients' | 'studio' | 'activity';

export interface PrimaryDestination {
  id: PrimaryDestinationId;
  /** Key in i18n/en.json. */
  labelKey: Translations;
  icon: string;
  href: string;
}

export const buildPrimaryDestinations = (): PrimaryDestination[] => [
  { id: 'library', labelKey: 'library', icon: mdiImageMultipleOutline, href: Route.photos() },
  { id: 'pro', labelKey: 'frameleaf_pro_title', icon: mdiViewDashboardOutline, href: '/pro' },
  { id: 'clients', labelKey: 'frameleaf_photography', icon: mdiCameraIris, href: Route.photography() },
  { id: 'studio', labelKey: 'frameleaf_studio_title', icon: mdiMovieEditOutline, href: Route.studioProjects() },
  { id: 'activity', labelKey: 'activity', icon: mdiProgressClock, href: Route.activity() },
];

/**
 * The sections that head the phone ☰ menu (UI review 2026-10-30 #8): phones have no top tabs, so
 * every section but Library (which the tab bar and the rail below already cover) opens from here.
 */
export const buildPhoneMenuDestinations = (): PrimaryDestination[] =>
  buildPrimaryDestinations().filter(({ id }) => id !== 'library');

/**
 * Whether the account has started using Clients. Missing from preferences written before Clients
 * existed (and from servers that predate it), which reads as off, the default.
 */
export const isClientsEnabled = (preferences: { clients?: { enabled: boolean } } | undefined): boolean =>
  !!preferences?.clients?.enabled;

const pathOf = (href: string) => href.split('?', 1)[0].split('#', 1)[0];

const isWithin = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

/**
 * Settings, account and administration: the prototype's `openSettings()` in App.jsx always sets
 * `screen("admin")`, whatever area it opens (account preferences, system administration,
 * utilities, trash settings), so the switcher leaves no workspace current there.
 */
const SETTINGS_ROOTS = ['/admin', '/user-settings'];

/** Whether `pathname` is one of the prototype's single "admin" screen's routes. */
export const isSettingsRoute = (pathname: string): boolean => SETTINGS_ROOTS.some((root) => isWithin(pathname, root));

/**
 * Index pages the prototype's own "collections" screen (`setScreen("collections")` in App.jsx):
 * browsing every album or every shared space. The switcher leaves Library uncurrent there.
 * Opening one specific album or space (`navigateCollection` in App.jsx) lands back on the
 * library screen, so only the index itself — not its children — is excluded.
 */
const LIBRARY_INDEX_ROOTS = new Set([pathOf(Route.albums()), pathOf(Route.sharing())]);

/**
 * Roots that are the prototype's "library" screen: every named collection reached through
 * `navigate()`/`navigateCollection()`/`exploreQuery()` in App.jsx (Library, Favorites, Recently
 * added, Best Photos, Archive, Locked, Pets, Documents, an individual album or shared space), plus the
 * "explore" screen (`goExplore()`). Each root's own child routes (an asset viewer, an
 * album/space's own photos) stay current with it. `/search` has no screen of its own in the
 * prototype — it opens as a panel over whatever screen was already current — so it is treated
 * as library, the screen search is always reached from.
 */
const LIBRARY_ROOTS = [
  Route.photos(),
  Route.favorites(),
  Route.recentlyAdded(),
  Route.bestPhotos(),
  Route.archive(),
  Route.locked(),
  // Unlinked (FL-83): the rule-suppressed listing stays reachable by URL, PIN-guarded, until the
  // Locked view becomes the prototype's union of lock records and rule matches (FL-34).
  Route.suppressed(),
  Route.pets(),
  Route.documents(),
  Route.albums(),
  Route.sharing(),
  Route.explore(),
  Route.search(),
].map((route) => pathOf(route));

/**
 * `people` is the prototype's "people" screen, in the Library-highlight set — but only its list.
 * Opening one person (`openPerson` in App.jsx) switches to a separate "person" screen that the
 * switcher leaves uncurrent, unlike every other library child route above.
 */
const PEOPLE_ROOT = pathOf(Route.people());

/**
 * Which workspace the current page belongs to, for the switcher's current state.
 *
 * Studio covers the project library and the editor (`/studio`, `/studio/projects`); Activity
 * covers its own page. Settings and administration belong to none. Library is current on its own
 * screens and "people"/"explore", exactly as the prototype's `.primary-nav` decides it in
 * App.jsx (`screen === value || (value === "library" && ["people", "explore"].includes(screen))`).
 * Every other screen the prototype has — Places, Map, Memories, Tags, Folders, the all-albums and
 * all-spaces indexes, a person's own page, a partner's library, Buy, Workflows, Trash, Utilities —
 * leaves the switcher without a current item there too, even though the rail still navigates them.
 */
export const currentPrimaryDestination = (pathname: string, proContext = false): PrimaryDestinationId | null => {
  if (isWithin(pathname, '/pro')) {
    return 'pro';
  }
  // Clients and its RAW develop editor.
  if (isWithin(pathname, pathOf(Route.photography()))) {
    return 'clients';
  }
  if (isWithin(pathname, pathOf(Route.studio()))) {
    return 'studio';
  }
  if (isWithin(pathname, pathOf(Route.activity()))) {
    return 'activity';
  }
  if (isSettingsRoute(pathname)) {
    return null;
  }
  if (pathname === PEOPLE_ROOT) {
    return 'library';
  }
  if (proContext && (LIBRARY_INDEX_ROOTS.has(pathname) || LIBRARY_ROOTS.some((root) => isWithin(pathname, root)))) {
    return 'pro';
  }
  if (LIBRARY_INDEX_ROOTS.has(pathname)) {
    return null;
  }
  if (LIBRARY_ROOTS.some((root) => isWithin(pathname, root))) {
    return 'library';
  }
  return null;
};

/**
 * Frameleaf rail destinations (FL-30).
 *
 * The order and grouping come from the September 24, 2026 polish pass of the interaction
 * requirements ("Navigation rail") and from `design/frameleaf/template/src/LibraryRail.jsx`:
 *
 *   Library, Favorites, Recently added, Best Photos, Archive, Locked
 *   Explore: Explore, People & pets, Places & map, Memories, Documents, Tags, Folders
 *   Albums (+ New album): All albums, each collection with its albums, All shared, Shared links
 *   Shared spaces (+ New shared space)
 *   Import, Library care, Trash, Settings, Support
 *
 * FL-1806 (approved 2026-11-26): the rail has no Tools section. Clients is always in the top bar
 * and RAW support opens from Clients; Workflows is part of Library care. "People & pets" opens
 * People and "Places & map" opens Places (Pets and the Map are one click from each). Import,
 * Library care and Trash are places: they open beside this rail, not inside Settings.
 *
 * Each labelled section folds away from its heading, remembered per device
 * (`RAIL_CLOSED_SECTIONS_KEY`); the icon-only rail always shows everything.
 *
 * Studio and Activity are primary destinations in the top bar (see above), not rail entries.
 *
 * Every entry points at a route that exists in production, so the rail never renders a
 * dead link. Pets landed with the identity model in FL-58 and is always on; an account can
 * only hide it from the sidebar (`pets.sidebarWeb`). Documents (FL-63) is unconditional for the same reason:
 * it lists the photos whose recognized text is visible, and says so when text
 * recognition is switched off rather than disappearing.
 *
 * Duplicate review, Missing media, Damaged media and Live Photo pairing deliberately have no
 * rail entry. Library Care opens the Library care settings area, the hub that lists them
 * beside health, repairs and duplicates (September 24, FL-71/FL-81).
 */

export type RailDestinationId =
  | 'library'
  | 'favorites'
  | 'recentlyAdded'
  | 'bestPhotos'
  | 'archive'
  | 'locked'
  | 'allAlbums'
  | 'sharedLinks'
  | 'explore'
  | 'people'
  | 'memories'
  | 'places'
  | 'tags'
  | 'folders'
  | 'documents'
  | 'allShared'
  | 'import'
  | 'trash'
  | 'libraryCare'
  | 'settings'
  | 'support';

export interface RailDestination {
  id: RailDestinationId;
  /** Key in i18n/en.json. */
  labelKey: Translations;
  icon: string;
  href: string;
  /** When true the entry is only current for its exact path, not for child routes. */
  exact?: boolean;
}

export type RailSectionId = 'library' | 'albums' | 'spaces' | 'explore' | 'footer';

export interface RailSection {
  id: RailSectionId;
  /** Key in i18n/en.json, or undefined for an unlabelled group. */
  labelKey?: Translations;
  destinations: RailDestination[];
}

/**
 * What the signed-in account can currently reach. Server capabilities come from the
 * feature flags manager; the rest are the account's own feature preferences, which are
 * display choices and never an access control (hiding a destination does not revoke
 * data or API access).
 */
export interface RailCapabilities {
  /** FL-146: the account's "Recently added in navigation" choice (on by default, as in the prototype). */
  recentlyAdded: boolean;
  search: boolean;
  trash: boolean;
  people: boolean;
  /** The account's "show Pets in sidebar" choice (on by default). */
  pets: boolean;
  memories: boolean;
  tags: boolean;
  folders: boolean;
  sharedLinks: boolean;
}

export const defaultRailCapabilities = (): RailCapabilities => ({
  recentlyAdded: false,
  search: false,
  trash: false,
  people: false,
  pets: false,
  memories: false,
  tags: false,
  folders: false,
  sharedLinks: false,
});

const destination = (
  id: RailDestinationId,
  labelKey: Translations,
  icon: string,
  href: string,
  options: { exact?: boolean } = {},
): RailDestination => ({ id, labelKey, icon, href, ...options });

export const buildRailSections = (capabilities: RailCapabilities): RailSection[] => {
  const keep = (available: boolean, value: RailDestination) => (available ? [value] : []);

  return [
    {
      id: 'library',
      destinations: [
        destination('library', 'library', mdiImageMultipleOutline, Route.photos()),
        destination('favorites', 'favorites', mdiHeartOutline, Route.favorites()),
        ...keep(
          capabilities.recentlyAdded,
          destination('recentlyAdded', 'recently_added', mdiClockOutline, Route.recentlyAdded()),
        ),
        destination('bestPhotos', 'best_photos', mdiStarOutline, Route.bestPhotos()),
        // S-26: the rail icons are LibraryRail.jsx's (Archive `mdiArchiveOutline`, Trash `mdiDeleteOutline`).
        destination('archive', 'archive', mdiArchiveOutline, Route.archive()),
        // The one Locked view (FL-34): every item its owner locked, whatever locked it, behind
        // the PIN. Locking is metadata; nothing is relocated.
        destination('locked', 'frameleaf_locked', mdiShieldLockOutline, Route.locked()),
      ],
    },
    {
      id: 'explore',
      labelKey: 'explore',
      destinations: [
        ...keep(capabilities.search, destination('explore', 'explore', mdiImageSearchOutline, Route.explore())),
        // People & pets opens People, which links to Pets; it shows while either is on in the sidebar.
        ...keep(
          capabilities.people || capabilities.pets,
          destination('people', 'frameleaf_rail_people_pets', mdiAccountOutline, Route.people()),
        ),
        // Places & map opens Places, which links to the Map.
        destination('places', 'frameleaf_rail_places_map', mdiMapMarkerMultipleOutline, Route.places()),
        ...keep(capabilities.memories, destination('memories', 'memories', mdiHistory, Route.memories())),
        destination('documents', 'frameleaf_documents_title', mdiTextBoxSearchOutline, Route.documents()),
        ...keep(capabilities.tags, destination('tags', 'tags', mdiTagMultipleOutline, Route.tags())),
        ...keep(capabilities.folders, destination('folders', 'folders', mdiFolderMultipleOutline, Route.folders())),
      ],
    },
    {
      id: 'albums',
      labelKey: 'albums',
      destinations: [
        destination('allAlbums', 'all_albums', mdiImageAlbum, Route.albums(), { exact: true }),
        // FL-1809: everything shared with you (spaces, partners, albums) had no way in from the rail.
        destination('allShared', 'frameleaf_rail_all_shared', mdiAccountMultipleOutline, Route.sharing(), {
          exact: true,
        }),
        ...keep(
          capabilities.sharedLinks,
          destination('sharedLinks', 'shared_links', mdiLinkVariant, Route.sharedLinks()),
        ),
      ],
    },
    {
      id: 'spaces',
      labelKey: 'frameleaf_shared_spaces',
      // A plain heading with one entry per space and per partner library (LibraryRail.jsx); the
      // rail renders them from `tree.spaces` and the account's partners. There is no "All shared
      // spaces" entry: the Albums page lists every space.
      destinations: [],
    },
    {
      id: 'footer',
      destinations: [
        destination('import', 'frameleaf_settings_area_backup', mdiTrayArrowDown, Route.importPlace()),
        // One entry into Library care, the page that lists every repair and tidying tool.
        destination('libraryCare', 'frameleaf_library_care', mdiShieldCheckOutline, Route.libraryCare()),
        ...keep(capabilities.trash, destination('trash', 'trash', mdiDeleteOutline, Route.trash())),
        destination('settings', 'settings', mdiCogOutline, Route.userSettings()),
        destination('support', 'frameleaf_support_product', mdiHandHeartOutline, Route.buy()),
      ],
    },
  ];
};

const ALSO_CURRENT: Partial<Record<RailDestinationId, string[]>> = {
  people: [pathOf(Route.pets())],
  places: [pathOf(Route.map())],
};

/** The rail entry a Command Center area belongs to when it is a place rather than a setting (FL-1806). */
const placeOfArea = (area: string | null): RailDestinationId | undefined => {
  switch (area) {
    case 'backup': {
      return 'import';
    }
    case 'care':
    case 'utilities': {
      return 'libraryCare';
    }
    case 'trash': {
      return 'trash';
    }
  }
};

/**
 * Whether a destination is the current page. Child routes keep their parent current
 * (`/photos/<id>` keeps Library current), except for entries marked `exact`, where a
 * child belongs to a more specific entry (an album page belongs to its tree item, not
 * to All albums).
 */
export const isDestinationCurrent = (current: string | URL, destination: RailDestination) => {
  const url = new URL(current, 'https://frameleaf.local');
  const target = new URL(destination.href, url);
  if (url.pathname === '/user-settings') {
    // FL-1806: Import, Library care and Trash are places with their own rail entries; Settings is
    // current everywhere else in the Command Center.
    const place = placeOfArea(url.searchParams.get('area'));
    if (destination.id === 'settings') {
      return !place;
    }
    if (destination.id === 'import' || destination.id === 'libraryCare' || destination.id === 'trash') {
      return place === destination.id;
    }
  }
  // People & pets and Places & map stand for both pages.
  const alsoCurrent = ALSO_CURRENT[destination.id];
  if (alsoCurrent?.some((root) => isWithin(url.pathname, root))) {
    return true;
  }
  // A search is the Library narrowed by it (prototype App.jsx; owner, 2026-11-05), so the rail's
  // Library entry stays current on the results and the viewer opened from them.
  if (destination.id === 'library' && isWithin(url.pathname, pathOf(Route.search()))) {
    return true;
  }
  if ([...target.searchParams].some(([key, value]) => url.searchParams.get(key) !== value)) {
    return false;
  }
  if (url.pathname === target.pathname) {
    return true;
  }
  return destination.exact ? false : url.pathname.startsWith(`${target.pathname}/`);
};

/* -------------------------------------------------------------------------- */
/* Folding rail sections (September 24 polish pass)                            */
/* -------------------------------------------------------------------------- */

/** The sections whose heading folds them away (`heading()` in LibraryRail.jsx). */
export const FOLDABLE_RAIL_SECTIONS: readonly RailSectionId[] = Object.freeze(['explore', 'albums', 'spaces']);

/** The prototype's per-device key (`CLOSED_KEY` in LibraryRail.jsx). */
export const RAIL_CLOSED_SECTIONS_KEY = 'frameleaf.rail.closedSections';

const isFoldable = (value: unknown): value is RailSectionId =>
  typeof value === 'string' && FOLDABLE_RAIL_SECTIONS.includes(value as RailSectionId);

/**
 * The sections folded on this device. Anything unreadable (no storage, a private window, a value
 * another version wrote) reads as "everything open", because this is a convenience only.
 */
export const readClosedRailSections = (storage: Pick<Storage, 'getItem'> | undefined): RailSectionId[] => {
  try {
    const value: unknown = JSON.parse(storage?.getItem(RAIL_CLOSED_SECTIONS_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((item) => isFoldable(item)))] : [];
  } catch {
    return [];
  }
};

/** Folds or unfolds one section and remembers the result on this device. */
export const toggleRailSection = (
  closed: readonly RailSectionId[],
  id: RailSectionId,
  storage?: Pick<Storage, 'setItem'>,
): RailSectionId[] => {
  const next = closed.includes(id) ? closed.filter((item) => item !== id) : [...closed, id];
  try {
    storage?.setItem(RAIL_CLOSED_SECTIONS_KEY, JSON.stringify(next));
  } catch {
    // Per-device convenience only; the rail still folds for this visit.
  }
  return next;
};

/* -------------------------------------------------------------------------- */
/* Phone tab bar (September 24, second pass #7)                                */
/* -------------------------------------------------------------------------- */

export type TabBarId = 'library' | 'memories' | 'albums' | 'search';

/**
 * Studio, Clients and the settings screens have no tab bar (`!["studio", "admin", "review",
 * "photography", …]` in App.jsx).
 */
export const showsTabBar = (pathname: string): boolean =>
  !isWithin(pathname, pathOf(Route.studio())) &&
  !isWithin(pathname, pathOf(Route.photography())) &&
  !isSettingsRoute(pathname);

/**
 * The tab that is current, as App.jsx's tab bar decides it: Memories on its screen, Albums on the
 * collections index (every album and every shared space), Search on its page, and Library on the
 * prototype's "library" screen — the library itself and every named collection, album or space
 * opened from it, but not People, Explore or the other screens the ☰ drawer reaches.
 */
export const currentTab = (pathname: string): TabBarId | null => {
  if (isWithin(pathname, pathOf(Route.memories()))) {
    return 'memories';
  }
  if (LIBRARY_INDEX_ROOTS.has(pathname)) {
    return 'albums';
  }
  if (isWithin(pathname, pathOf(Route.search()))) {
    return 'search';
  }
  if (
    isWithin(pathname, pathOf(Route.explore())) ||
    isWithin(pathname, PEOPLE_ROOT) ||
    isWithin(pathname, pathOf(Route.pets()))
  ) {
    return null;
  }
  return currentPrimaryDestination(pathname) === 'library' ? 'library' : null;
};
