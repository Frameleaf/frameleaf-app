import {
  getAlbumTree,
  getAllPeople,
  getSearchSuggestions,
  searchPerson,
  SearchSuggestionType,
  type AlbumTreeResponseDto,
  type PersonResponseDto,
} from '@immich/sdk';
import {
  mdiAccountGroupOutline,
  mdiAccountMultipleOutline,
  mdiAccountOutline,
  mdiApi,
  mdiBackupRestore,
  mdiBellOutline,
  mdiBookshelf,
  mdiClockOutline,
  mdiCogOutline,
  mdiContentDuplicate,
  mdiDatabaseOutline,
  mdiDevices,
  mdiDownload,
  mdiFeatureSearchOutline,
  mdiFileCheckOutline,
  mdiFileDocumentOutline,
  mdiFolderOutline,
  mdiFormTextboxPassword,
  mdiImageAlbum,
  mdiImageMultipleOutline,
  mdiImageOutline,
  mdiImageSizeSelectLarge,
  mdiImport,
  mdiKeyOutline,
  mdiLockOutline,
  mdiLockSmart,
  mdiMapMarkerOutline,
  mdiMemory,
  mdiPaletteOutline,
  mdiRobotOutline,
  mdiServerOutline,
  mdiShieldLockOutline,
  mdiSync,
  mdiTrashCanOutline,
  mdiUpdate,
  mdiVideoOutline,
  mdiWrench,
} from '@mdi/js';
import type { MessageFormatter, Translations } from 'svelte-i18n';
import { buildAlbumTree, type FrameleafAlbumNode } from '$lib/frameleaf/album-tree';
import type { CommandIndexInput, CommandInput } from '$lib/frameleaf/command-palette';
import { buildPrimaryDestinations, buildRailSections, type RailCapabilities } from '$lib/frameleaf/navigation';
import { areaForSection, commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { Route } from '$lib/route';

/**
 * The live command index for the Frameleaf palette (FL-49).
 *
 * The prototype's `command-palette.mjs` is fed sample arrays. Production feeds it real
 * destinations only:
 *
 * - **Pages** come from `buildPrimaryDestinations` (the top bar's Library, Studio and Activity) and
 *   `buildRailSections`, the same tables the shell renders, plus the admin pages, so the palette can
 *   never offer a route that does not exist.
 * - **Settings areas** are the section keys that `UserSettingsList.svelte` and
 *   `user-settings/SystemSettings.svelte` actually declare. Choosing one opens that section of
 *   the Command Center (`?isOpen=<key>` for an account section, `?area=&section=` for a server one).
 * - **People**, **albums** and **places** come from `/search/person`, `/people`, `/albums`
 *   and `/search/suggestions`. Each one is access scoped by the server for the signed-in
 *   account, so the palette shows exactly what that account can reach; nothing is derived
 *   from a local cache of somebody else's library.
 *
 * Feature preferences hide destinations here the way they hide them in the rail. That is a
 * display choice, not an access control — the underlying routes and APIs are unchanged.
 */

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

export interface CommandIndexContext {
  capabilities: RailCapabilities;
  isAdmin: boolean;
}

/**
 * The top bar's primary destinations first (Library, Studio, Activity), then the rail in rail order,
 * then the admin pages for an administrator. Library is both a primary destination and the rail's
 * first entry; it is offered once, as the primary one.
 */
export const buildPageCommands = ($t: MessageFormatter, context: CommandIndexContext): CommandInput[] => {
  const pages: CommandInput[] = Array.from(buildPrimaryDestinations(), (item) => ({
    id: `primary:${item.id}`,
    title: $t(item.labelKey),
    subtitle: $t('frameleaf_search_subtitle_page'),
    icon: item.icon,
    href: item.href,
  }));
  const primaryHrefs = new Set(pages.map((page) => page.href));

  for (const section of buildRailSections(context.capabilities)) {
    for (const item of section.destinations) {
      if (primaryHrefs.has(item.href)) {
        continue;
      }
      pages.push({
        id: `rail:${item.id}`,
        title: $t(item.labelKey),
        subtitle: $t('frameleaf_search_subtitle_page'),
        icon: item.icon,
        href: item.href,
      });
    }
  }

  // Destinations that are not rail entries but are real pages the palette should resolve.
  const extras: CommandInput[] = [
    { id: 'memories', title: $t('memories'), icon: mdiClockOutline, href: Route.memories() },
    { id: 'duplicates', title: $t('review_duplicates'), icon: mdiContentDuplicate, href: Route.duplicatesUtility() },
    {
      id: 'large-files',
      title: $t('review_large_files'),
      icon: mdiImageSizeSelectLarge,
      href: Route.largeFileUtility(),
    },
    {
      id: 'live-photos',
      title: $t('relink_live_photos'),
      icon: mdiImageMultipleOutline,
      href: Route.livePhotosUtility(),
    },
    { id: 'geolocation', title: $t('manage_geolocation'), icon: mdiMapMarkerOutline, href: Route.geolocationUtility() },
    { id: 'takeout', title: $t('frameleaf_takeout_title'), icon: mdiImport, href: Route.takeout() },
  ];
  for (const extra of extras) {
    pages.push({ ...extra, subtitle: $t('frameleaf_search_subtitle_page') });
  }

  if (context.isAdmin) {
    const adminPages: CommandInput[] = [
      { id: 'admin:users', title: $t('admin.user_management'), icon: mdiAccountMultipleOutline, href: Route.users() },
      { id: 'admin:settings', title: $t('admin.system_settings'), icon: mdiCogOutline, href: Route.systemSettings() },
      { id: 'admin:queues', title: $t('admin.queues'), icon: mdiSync, href: Route.queues() },
      {
        id: 'admin:render-workers',
        title: $t('admin.render_workers'),
        icon: mdiMemory,
        href: Route.renderWorkers(),
      },
      {
        id: 'admin:workers',
        title: $t('admin.frameleaf_workers_title'),
        icon: mdiRobotOutline,
        href: Route.systemWorkers(),
      },
      { id: 'admin:libraries', title: $t('external_libraries'), icon: mdiBookshelf, href: Route.libraries() },
      {
        id: 'admin:status',
        title: $t('frameleaf_analytics_title'),
        icon: mdiServerOutline,
        href: Route.libraryAnalytics(),
      },
      {
        id: 'admin:maintenance',
        title: $t('admin.maintenance_settings'),
        icon: mdiWrench,
        href: Route.systemMaintenance(),
      },
    ];
    for (const page of adminPages) {
      pages.push({ ...page, subtitle: $t('frameleaf_search_subtitle_admin_page') });
    }
  }

  return pages;
};

/* -------------------------------------------------------------------------- */
/* Settings areas                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Accordion keys declared by `UserSettingsList.svelte`. `accordionManager` reads the
 * `isOpen` query parameter as a space-separated set of these keys, so the link opens the
 * area directly. The keys are repeated here rather than imported because the settings list
 * is a component, not a table; the spec asserts the two stay in step.
 */
export const USER_SETTINGS_AREAS: readonly {
  key: string;
  titleKey: Translations;
  descriptionKey: Translations;
  icon: string;
}[] = [
  { key: 'app-settings', titleKey: 'app_settings', descriptionKey: 'manage_the_app_settings', icon: mdiCogOutline },
  {
    key: 'account',
    titleKey: 'frameleaf_access_profile_title',
    descriptionKey: 'frameleaf_access_profile_description',
    icon: mdiAccountOutline,
  },
  {
    key: 'user-usage-info',
    titleKey: 'user_usage_stats',
    descriptionKey: 'user_usage_stats_description',
    icon: mdiServerOutline,
  },
  {
    key: 'api-keys',
    titleKey: 'frameleaf_access_keys_title',
    descriptionKey: 'frameleaf_access_keys_description',
    icon: mdiApi,
  },
  {
    key: 'authorized-devices',
    titleKey: 'frameleaf_access_devices_title',
    descriptionKey: 'frameleaf_access_devices_description',
    icon: mdiDevices,
  },
  {
    key: 'download-settings',
    titleKey: 'download_settings',
    descriptionKey: 'download_settings_description',
    icon: mdiDownload,
  },
  {
    key: 'feature',
    titleKey: 'features',
    descriptionKey: 'features_setting_description',
    icon: mdiFeatureSearchOutline,
  },
  {
    // The older personal settings page called this group `notifications`; that link still works.
    key: 'email-preferences',
    titleKey: 'notifications',
    descriptionKey: 'notifications_setting_description',
    icon: mdiBellOutline,
  },
  {
    key: 'password',
    titleKey: 'frameleaf_access_password_title',
    descriptionKey: 'frameleaf_access_password_group_description',
    icon: mdiFormTextboxPassword,
  },
  {
    key: 'user-pin-code-settings',
    titleKey: 'frameleaf_access_pin_title',
    descriptionKey: 'frameleaf_access_pin_group_description',
    icon: mdiLockSmart,
  },
  {
    key: 'suppressed-content',
    titleKey: 'frameleaf_locked_rules_section_title',
    descriptionKey: 'frameleaf_locked_rules_section_description',
    icon: mdiShieldLockOutline,
  },
  {
    key: 'user-purchase-settings',
    titleKey: 'frameleaf_access_supporter_title',
    descriptionKey: 'frameleaf_access_supporter_group_description',
    icon: mdiKeyOutline,
  },
  {
    key: 'sharing',
    titleKey: 'sharing',
    descriptionKey: 'manage_sharing_with_other_users',
    icon: mdiAccountGroupOutline,
  },
] as const;

/** Server settings section keys declared by `user-settings/SystemSettings.svelte`. */
export const ADMIN_SETTINGS_AREAS: readonly {
  key: string;
  titleKey: Translations;
  descriptionKey: Translations;
  icon: string;
}[] = [
  {
    key: 'authentication',
    titleKey: 'admin.authentication_settings',
    descriptionKey: 'admin.authentication_settings_description',
    icon: mdiLockOutline,
  },
  {
    key: 'backup',
    titleKey: 'admin.backup_settings',
    descriptionKey: 'admin.backup_settings_description',
    icon: mdiBackupRestore,
  },
  {
    key: 'image',
    titleKey: 'admin.image_settings',
    descriptionKey: 'admin.image_settings_description',
    icon: mdiImageOutline,
  },
  {
    key: 'integrity-checks',
    titleKey: 'admin.integrity_checks_settings',
    descriptionKey: 'admin.integrity_checks_settings_description',
    icon: mdiFileCheckOutline,
  },
  { key: 'job', titleKey: 'admin.job_settings', descriptionKey: 'admin.job_settings_description', icon: mdiSync },
  {
    key: 'external-library',
    titleKey: 'admin.library_settings',
    descriptionKey: 'admin.library_settings_description',
    icon: mdiBookshelf,
  },
  {
    key: 'logging',
    titleKey: 'admin.logging_settings',
    descriptionKey: 'admin.manage_log_settings',
    icon: mdiFileDocumentOutline,
  },
  {
    key: 'machine-learning',
    titleKey: 'admin.machine_learning_settings',
    descriptionKey: 'admin.machine_learning_settings_description',
    icon: mdiRobotOutline,
  },
  {
    key: 'location',
    titleKey: 'admin.map_gps_settings',
    descriptionKey: 'admin.map_gps_settings_description',
    icon: mdiMapMarkerOutline,
  },
  {
    key: 'metadata',
    titleKey: 'admin.metadata_settings',
    descriptionKey: 'admin.metadata_settings_description',
    icon: mdiDatabaseOutline,
  },
  {
    key: 'nightly-tasks',
    titleKey: 'admin.nightly_tasks_settings',
    descriptionKey: 'admin.nightly_tasks_settings_description',
    icon: mdiClockOutline,
  },
  {
    key: 'notifications',
    titleKey: 'admin.notification_settings',
    descriptionKey: 'admin.notification_settings_description',
    icon: mdiBellOutline,
  },
  {
    key: 'server',
    titleKey: 'admin.server_settings',
    descriptionKey: 'admin.server_settings_description',
    icon: mdiServerOutline,
  },
  {
    key: 'smart-albums',
    titleKey: 'admin.smart_albums_settings',
    descriptionKey: 'admin.smart_albums_settings_description',
    icon: mdiImageMultipleOutline,
  },
  {
    key: 'storage-template',
    titleKey: 'admin.storage_template_settings',
    descriptionKey: 'admin.storage_template_settings_description',
    icon: mdiFolderOutline,
  },
  {
    key: 'theme',
    titleKey: 'admin.theme_settings',
    descriptionKey: 'admin.theme_settings_description',
    icon: mdiPaletteOutline,
  },
  {
    key: 'trash',
    titleKey: 'admin.trash_settings',
    descriptionKey: 'admin.trash_settings_description',
    icon: mdiTrashCanOutline,
  },
  {
    key: 'user-settings',
    titleKey: 'admin.user_settings',
    descriptionKey: 'admin.user_settings_description',
    icon: mdiAccountOutline,
  },
  {
    key: 'version-check',
    titleKey: 'admin.version_check_settings',
    descriptionKey: 'admin.version_check_settings_description',
    icon: mdiUpdate,
  },
  {
    key: 'video-transcoding',
    titleKey: 'admin.transcoding_settings',
    descriptionKey: 'admin.transcoding_settings_description',
    icon: mdiVideoOutline,
  },
] as const;

const settingsHref = (base: string, key: string) => `${base}?isOpen=${encodeURIComponent(key)}`;
/** A server settings section opens in its Command Center area (FL-71). */
const serverSettingsHref = (key: string) => commandCenterUrl(areaForSection(key), key);

export const buildSettingsCommands = ($t: MessageFormatter, context: CommandIndexContext): CommandInput[] => {
  const areas: CommandInput[] = USER_SETTINGS_AREAS.map((area) => ({
    id: `user:${area.key}`,
    title: $t(area.titleKey as Translations),
    subtitle: $t('frameleaf_search_subtitle_settings'),
    icon: area.icon,
    keywords: [$t(area.descriptionKey as Translations), $t('settings')],
    href: settingsHref(Route.userSettings(), area.key),
  }));

  if (!context.isAdmin) {
    return areas;
  }

  return [
    ...areas,
    ...ADMIN_SETTINGS_AREAS.map((area) => ({
      id: `admin:${area.key}`,
      title: $t(area.titleKey as Translations),
      subtitle: $t('frameleaf_search_subtitle_admin_settings'),
      icon: area.icon,
      keywords: [$t(area.descriptionKey as Translations), $t('admin.system_settings')],
      href: serverSettingsHref(area.key),
    })),
  ];
};

/* -------------------------------------------------------------------------- */
/* Live catalogue: people, albums, places                                      */
/* -------------------------------------------------------------------------- */

/** How many of each kind the palette offers. The ranking decides which ones survive. */
const PEOPLE_LIMIT = 40;
const ALBUM_LIMIT = 60;
const PLACE_LIMIT = 40;

export interface CommandCatalogue {
  people: PersonResponseDto[];
  albums: FrameleafAlbumNode[];
  places: { field: 'city' | 'state' | 'country'; value: string }[];
}

export const emptyCommandCatalogue = (): CommandCatalogue => ({ people: [], albums: [], places: [] });

const flattenTree = (nodes: FrameleafAlbumNode[]): FrameleafAlbumNode[] =>
  nodes.flatMap((node) => [node, ...flattenTree(node.children)]);

/**
 * Load the catalogue for a query term. Every request carries the caller's `AbortSignal`, so a
 * superseded keystroke's response is discarded by `fetch` before it can reach the palette: an
 * out-of-order answer can never overwrite a newer one.
 *
 * A failing group yields an empty list rather than failing the whole load, so the palette keeps
 * ranking pages and settings when, say, the people endpoint is unavailable.
 */
export const loadCommandCatalogue = async (term: string, signal?: AbortSignal): Promise<CommandCatalogue> => {
  const trimmed = term.trim();

  const settle = async <T>(work: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw error;
      }
      return fallback;
    }
  };

  const [people, albums, city, state, country] = await Promise.all([
    settle<PersonResponseDto[]>(
      trimmed
        ? searchPerson({ name: trimmed, withHidden: false }, { signal })
        : getAllPeople({ withHidden: false, page: 1, size: PEOPLE_LIMIT }, { signal }).then(
            (response) => response.people,
          ),
      [],
    ),
    settle<AlbumTreeResponseDto>(getAlbumTree({ signal }), { albums: [], collections: [], spaces: [] }),
    settle<string[]>(getSearchSuggestions({ $type: SearchSuggestionType.City }, { signal }), []),
    settle<string[]>(getSearchSuggestions({ $type: SearchSuggestionType.State }, { signal }), []),
    settle<string[]>(getSearchSuggestions({ $type: SearchSuggestionType.Country }, { signal }), []),
  ]);

  const tree = buildAlbumTree(albums);
  const places = [
    ...city.map((value) => ({ field: 'city' as const, value })),
    ...state.map((value) => ({ field: 'state' as const, value })),
    ...country.map((value) => ({ field: 'country' as const, value })),
  ].filter((place) => !!place.value);

  return {
    people: people.slice(0, PEOPLE_LIMIT),
    albums: [...flattenTree(tree.collections), ...tree.albums, ...tree.spaces].slice(0, ALBUM_LIMIT),
    places: places.slice(0, PLACE_LIMIT),
  };
};

const countLabel = ($t: MessageFormatter, count: number) => $t('items_count', { values: { count } });

export const buildCatalogueCommands = (
  $t: MessageFormatter,
  catalogue: CommandCatalogue,
): Required<Pick<CommandIndexInput, 'people' | 'collections' | 'places'>> => ({
  people: catalogue.people.map((person) => ({
    id: person.id,
    title: person.name || $t('no_name'),
    subtitle: $t('person'),
    icon: mdiAccountOutline,
    keywords: [$t('people')],
    href: Route.viewPerson({ id: person.id }),
  })),
  collections: catalogue.albums.map((album) => ({
    id: album.id,
    title: album.name,
    subtitle: [albumKindLabel($t, album), countLabel($t, album.assetCount)].filter(Boolean).join(' · '),
    icon: album.kind === 'space' ? mdiAccountMultipleOutline : mdiImageAlbum,
    href: album.kind === 'space' ? Route.viewSharedSpace({ id: album.id }) : Route.viewAlbum({ id: album.id }),
  })),
  places: catalogue.places.map((place) => ({
    id: `${place.field}:${place.value}`,
    title: place.value,
    subtitle: $t(PLACE_FIELD_LABELS[place.field]),
    icon: mdiMapMarkerOutline,
    keywords: [$t('places')],
    // A place opens the search results for that field, which is exactly the filter a chip
    // would carry, so the destination and the filter stay one thing.
    href: placeHref(place.field, place.value),
  })),
});

const PLACE_FIELD_LABELS = { city: 'city', state: 'state', country: 'country' } as const;

/** `city`, `state` and `country` are real `MetadataSearchDto` fields, so the link is a real search. */
const placeHref = (field: 'city' | 'state' | 'country', value: string) => {
  switch (field) {
    case 'state': {
      return Route.search({ state: value });
    }
    case 'country': {
      return Route.search({ country: value });
    }
    default: {
      return Route.search({ city: value });
    }
  }
};

const albumKindLabel = ($t: MessageFormatter, album: FrameleafAlbumNode) => {
  switch (album.kind) {
    case 'collection': {
      return $t('frameleaf_search_kind_collection');
    }
    case 'space': {
      return $t('frameleaf_search_kind_space');
    }
    default: {
      return $t('album');
    }
  }
};
