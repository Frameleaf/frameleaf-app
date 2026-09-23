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
  mdiPawOutline,
  mdiShieldCheckOutline,
  mdiShieldLockOutline,
  mdiStarOutline,
  mdiTagMultipleOutline,
  mdiTrashCanOutline,
  mdiTuneVariant,
} from '@mdi/js';
import { Route } from '$lib/route';

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
 * Every entry points at a route that exists in production, so the rail never renders a
 * dead link. Pets landed with the identity model in FL-58 and is unconditional: it is a
 * Frameleaf feature with no upstream account preference behind it, so there is nothing
 * for an account to switch off. One Explore destination from the design is still absent:
 * Documents waits on the discovery work in FL-46/FL-62 (the search DTO carries no
 * document media filter today, only a free-text `ocr` term). Add it here when that route
 * exists.
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
      destinations: [destination('sharing', 'sharing', mdiAccountMultipleOutline, Route.sharing())],
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
