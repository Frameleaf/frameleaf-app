import {
  mdiAccountMultipleOutline,
  mdiAccountOutline,
  mdiArchiveArrowDownOutline,
  mdiClockOutline,
  mdiCogOutline,
  mdiFolderMultipleOutline,
  mdiHandHeartOutline,
  mdiHeartOutline,
  mdiHistory,
  mdiImageAlbum,
  mdiImageMultipleOutline,
  mdiImageSearchOutline,
  mdiLinkVariant,
  mdiMapMarkerMultipleOutline,
  mdiMapOutline,
  mdiMovieEditOutline,
  mdiPawOutline,
  mdiProgressClock,
  mdiShieldCheckOutline,
  mdiShieldLockOutline,
  mdiStarOutline,
  mdiTagMultipleOutline,
  mdiTextBoxSearchOutline,
  mdiTrashCanOutline,
  mdiTuneVariant,
} from '@mdi/js';
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
 */

export type PrimaryDestinationId = 'library' | 'studio' | 'activity';

export interface PrimaryDestination {
  id: PrimaryDestinationId;
  /** Key in i18n/en.json. */
  labelKey: string;
  icon: string;
  href: string;
}

export const buildPrimaryDestinations = (): PrimaryDestination[] => [
  { id: 'library', labelKey: 'library', icon: mdiImageMultipleOutline, href: Route.photos() },
  { id: 'studio', labelKey: 'frameleaf_studio_title', icon: mdiMovieEditOutline, href: Route.studioProjects() },
  { id: 'activity', labelKey: 'activity', icon: mdiProgressClock, href: Route.activity() },
];

const pathOf = (href: string) => href.split('?')[0].split('#')[0];

const isWithin = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

/**
 * Settings, account and administration: the prototype's `openSettings()` in App.jsx always sets
 * `screen("admin")`, whatever area it opens (account preferences, system administration,
 * utilities, trash settings), so the switcher leaves no workspace current there.
 */
const SETTINGS_ROOTS = ['/admin', '/user-settings'];

/** Whether `pathname` is one of the prototype's single "admin" screen's routes. */
export const isSettingsRoute = (pathname: string): boolean =>
  SETTINGS_ROOTS.some((root) => isWithin(pathname, root));

/**
 * Index pages the prototype's own "collections" screen (`setScreen("collections")` in App.jsx):
 * browsing every album or every shared space. The switcher leaves Library uncurrent there.
 * Opening one specific album or space (`navigateCollection` in App.jsx) lands back on the
 * library screen, so only the index itself — not its children — is excluded.
 */
const LIBRARY_INDEX_ROOTS = [pathOf(Route.albums()), pathOf(Route.sharing())];

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
  Route.suppressed(),
  Route.pets(),
  Route.documents(),
  Route.albums(),
  Route.sharing(),
  Route.explore(),
  Route.search(),
].map(pathOf);

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
export const currentPrimaryDestination = (pathname: string): PrimaryDestinationId | null => {
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
  if (LIBRARY_INDEX_ROOTS.includes(pathname)) {
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
 * The order and grouping come from the September 22, 2026 revision of the interaction
 * requirements and from `design/frameleaf/template/src/LibraryRail.jsx`:
 *
 *   Library, Favorites, Recently added, Best Photos, Archive, Locked
 *   Albums: All albums, each collection with its albums, Shared links
 *   Shared spaces
 *   Explore: Explore, People, Pets, Memories, Places, Map, Tags, Folders, Documents
 *   Tools: Workflows, Trash
 *   Library Care, Settings, Support
 *
 * Studio and Activity are primary destinations in the top bar (see above), not rail entries, so
 * the rail's Tools section holds only Workflows and Trash, as in the prototype.
 *
 * Every entry points at a route that exists in production, so the rail never renders a
 * dead link. Pets landed with the identity model in FL-58 and is unconditional: it is a
 * Frameleaf feature with no upstream account preference behind it, so there is nothing
 * for an account to switch off. Documents (FL-63) is unconditional for the same reason:
 * it lists the photos whose recognized text is visible, and says so when text
 * recognition is switched off rather than disappearing.
 *
 * Duplicate review, large files and Live Photo pairing deliberately have no rail entry.
 * They stay under Settings -> Utilities, reached through the single Library Care entry.
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
  | 'sharing'
  | 'explore'
  | 'people'
  | 'pets'
  | 'memories'
  | 'places'
  | 'map'
  | 'tags'
  | 'folders'
  | 'documents'
  | 'workflows'
  | 'trash'
  | 'libraryCare'
  | 'settings'
  | 'support';

export interface RailDestination {
  id: RailDestinationId;
  /** Key in i18n/en.json. */
  labelKey: string;
  icon: string;
  href: string;
  /** When true the entry is only current for its exact path, not for child routes. */
  exact?: boolean;
}

export type RailSectionId = 'library' | 'albums' | 'spaces' | 'explore' | 'tools' | 'footer';

export interface RailSection {
  id: RailSectionId;
  /** Key in i18n/en.json, or undefined for an unlabelled group. */
  labelKey?: string;
  destinations: RailDestination[];
}

/**
 * What the signed-in account can currently reach. Server capabilities come from the
 * feature flags manager; the rest are the account's own feature preferences, which are
 * display choices and never an access control (hiding a destination does not revoke
 * data or API access).
 */
export interface RailCapabilities {
  search: boolean;
  map: boolean;
  trash: boolean;
  people: boolean;
  memories: boolean;
  tags: boolean;
  folders: boolean;
  sharedLinks: boolean;
}

export const defaultRailCapabilities = (): RailCapabilities => ({
  search: false,
  map: false,
  trash: false,
  people: false,
  memories: false,
  tags: false,
  folders: false,
  sharedLinks: false,
});

const destination = (
  id: RailDestinationId,
  labelKey: string,
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
        destination('recentlyAdded', 'recently_added', mdiClockOutline, Route.recentlyAdded()),
        destination('bestPhotos', 'best_photos', mdiStarOutline, Route.bestPhotos()),
        destination('archive', 'archive', mdiArchiveArrowDownOutline, Route.archive()),
        // Frameleaf "Locked" is the filtered timeline of media marked sensitive, backed
        // by the elevated session. It is not the upstream move-to-Locked folder, which
        // relocates assets and stays reachable on its own route.
        destination('locked', 'frameleaf_locked', mdiShieldLockOutline, Route.suppressed()),
      ],
    },
    {
      id: 'albums',
      labelKey: 'albums',
      destinations: [
        destination('allAlbums', 'all_albums', mdiImageAlbum, Route.albums(), { exact: true }),
        ...keep(
          capabilities.sharedLinks,
          destination('sharedLinks', 'shared_links', mdiLinkVariant, Route.sharedLinks()),
        ),
      ],
    },
    {
      id: 'spaces',
      labelKey: 'frameleaf_shared_spaces',
      // The workspace at Route.sharing() (FL-55) lists every shared space and the
      // account's partners; each space also gets its own entry below, rendered from
      // `tree.spaces` the same way collections and albums are.
      destinations: [destination('sharing', 'frameleaf_spaces_all', mdiAccountMultipleOutline, Route.sharing())],
    },
    {
      id: 'explore',
      labelKey: 'explore',
      destinations: [
        ...keep(capabilities.search, destination('explore', 'explore', mdiImageSearchOutline, Route.explore())),
        ...keep(capabilities.people, destination('people', 'people', mdiAccountOutline, Route.people())),
        destination('pets', 'frameleaf_pets_title', mdiPawOutline, Route.pets()),
        ...keep(capabilities.memories, destination('memories', 'memories', mdiHistory, Route.memories())),
        destination('places', 'places', mdiMapMarkerMultipleOutline, Route.places()),
        ...keep(capabilities.map, destination('map', 'map', mdiMapOutline, Route.map())),
        ...keep(capabilities.tags, destination('tags', 'tags', mdiTagMultipleOutline, Route.tags())),
        ...keep(capabilities.folders, destination('folders', 'folders', mdiFolderMultipleOutline, Route.folders())),
        destination('documents', 'frameleaf_documents_title', mdiTextBoxSearchOutline, Route.documents()),
      ],
    },
    {
      id: 'tools',
      labelKey: 'frameleaf_tools',
      destinations: [
        destination('workflows', 'workflows', mdiTuneVariant, Route.workflows()),
        ...keep(capabilities.trash, destination('trash', 'trash', mdiTrashCanOutline, Route.trash())),
      ],
    },
    {
      id: 'footer',
      destinations: [
        // One entry into the utilities hub. The individual repair workflows stay under
        // Settings -> Utilities, so the rail never repeats them.
        destination('libraryCare', 'frameleaf_library_care', mdiShieldCheckOutline, Route.utilities()),
        destination('settings', 'settings', mdiCogOutline, Route.userSettings()),
        destination('support', 'frameleaf_support_product', mdiHandHeartOutline, Route.buy()),
      ],
    },
  ];
};

/**
 * Whether a destination is the current page. Child routes keep their parent current
 * (`/photos/<id>` keeps Library current), except for entries marked `exact`, where a
 * child belongs to a more specific entry (an album page belongs to its tree item, not
 * to All albums).
 */
export const isDestinationCurrent = (pathname: string, destination: RailDestination) => {
  const href = destination.href.split('?')[0].split('#')[0];

  if (pathname === href) {
    return true;
  }

  return destination.exact ? false : pathname.startsWith(`${href}/`);
};
