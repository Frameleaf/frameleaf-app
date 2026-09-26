/**
 * The Command Center's information architecture (FL-71), ported from the design template's
 * `settings-catalog.mjs` areas. One Command Center serves every account (`/user-settings`); an
 * area or section an account may not use is simply not offered to it. This module decides where
 * each existing settings form lives, which area an older `?isOpen=<key>` link opens, the address of
 * an area or section, and what a search over the Command Center returns.
 */
import type { Component } from 'svelte';

export type SettingsGroupId = 'command' | 'library' | 'server' | 'personal';

/** One settings page as the Command Center renders it: an existing form with its copy. */
export type SettingsHostSection = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  /** The form. Account sections without one are drawn by the host's `sectionBody` snippet. */
  component?: Component;
  /** True for server settings, which only administrators see. */
  admin?: boolean;
};

export type SettingsAreaId =
  | 'overview'
  | 'analytics'
  | 'storage'
  | 'backup'
  | 'intelligence'
  | 'editing'
  | 'care'
  | 'processing'
  | 'cloud'
  | 'security'
  | 'notifications'
  | 'server'
  | 'sharing'
  | 'maintenance'
  | 'preferences'
  | 'users'
  | 'libraries'
  | 'utilities'
  | 'trash'
  | 'history';

export type SettingsAreaDefinition = {
  id: SettingsAreaId;
  group: SettingsGroupId;
  /** Server settings sections (system-config forms), in display order. Legacy accordion keys, kept for deep links. */
  sections: string[];
  /** Account sections every signed-in account has, in display order after the server sections. */
  personal?: string[];
  /** Areas only an administrator opens (screens of their own, or areas holding only server settings). */
  adminOnly?: boolean;
  /**
   * The display order when the template interleaves server and account sections; otherwise server
   * sections come first. Lists every key of `sections` and `personal`.
   */
  order?: string[];
};

/** The template's area order (`settingsAreas` in settings-catalog.mjs); the rail groups them by `group`. */
export const SETTINGS_AREAS: readonly SettingsAreaDefinition[] = Object.freeze([
  // The template's Command center group: the Overview (status, storage and what needs attention)
  // and, FL-79, Library analytics. Both are screens of their own rather than section directories.
  { id: 'overview', group: 'command', sections: [], adminOnly: true },
  { id: 'analytics', group: 'command', sections: [], adminOnly: true },
  // FL-75: `migration` is the template's "Move or export your library", last in this area. FL-71:
  // physical deduplication (the old /admin/physical-deduplication page) is the template's
  // `deduplication` section, after the folder layout.
  {
    id: 'storage',
    group: 'library',
    sections: ['storage-template', 'deduplication', 'trash', 'user-settings', 'migration'],
  },
  // FL-74 / FL-65: imports and "Originals & preservation" belong to every account; database backups
  // are the server's. One mount of each, in the template's order.
  // Imports first, then protection, as the template lists them (settings-catalog.mjs `backup`).
  {
    id: 'backup',
    group: 'library',
    sections: ['backup'],
    personal: ['takeout', 'preservation'],
    order: ['takeout', 'backup', 'preservation'],
  },
  { id: 'intelligence', group: 'library', sections: ['machine-learning', 'smart-albums', 'metadata'] },
  { id: 'editing', group: 'library', sections: ['image', 'video-transcoding'] },
  // The template's People & sharing: partner sharing moved out of the personal settings list.
  { id: 'sharing', group: 'library', sections: [], personal: ['sharing'] },
  // The template's Library care (settings-catalog.mjs:905-977): media health & integrity with its
  // integrity check settings, repair queues and enrichment completeness.
  {
    id: 'care',
    group: 'library',
    sections: ['integrity-checks', 'enrichment-care'],
    personal: ['repair'],
    order: ['integrity-checks', 'repair', 'enrichment-care'],
  },
  // FL-71: the old /admin/processing-destinations (workers, workload destinations), /admin/queues
  // and /admin/render-workers pages are sections of Compute & jobs, with the nightly settings. As in
  // the template, queue concurrency is edited only in the Job manager's concurrency dialog; the old
  // job settings key (`isOpen=job`) opens the Job manager.
  {
    id: 'processing',
    group: 'server',
    sections: ['workers', 'hardware', 'routing', 'queues', 'render-workers', 'nightly-tasks'],
  },
  // FL-154 and FL-159 (handoff §3.1): the template's Frameleaf Cloud area (settings-catalog.mjs:125-131,
  // 1711-1799), after Compute & jobs in "Your server": Account & link, Plan, Licence, Remote access
  // (FL-161) and Cloud processing; backup joins it with its story. Optional: the server works fully
  // without it.
  {
    id: 'cloud',
    group: 'server',
    sections: ['cloud-account', 'cloud-plan', 'cloud-license', 'cloud-remote', 'cloud-processing', 'cloud-backup'],
    adminOnly: true,
  },
  // The template's Access & security holds each account's own sign-in (password, PIN, provider),
  // Locked tags & people, and devices & API keys next to the server's sign-in methods.
  {
    id: 'security',
    group: 'server',
    // FL-158: Sign in with Frameleaf sits beside the administrator's own provider.
    sections: ['authentication', 'frameleaf-signin'],
    personal: ['password', 'user-pin-code-settings', 'oauth', 'suppressed-content', 'authorized-devices', 'api-keys'],
  },
  // The account's own email notifications sit with the server's email delivery, as in the template.
  { id: 'notifications', group: 'server', sections: ['notifications'], personal: ['email-preferences'] },
  {
    id: 'server',
    group: 'server',
    sections: ['server', 'version-check', 'logging', 'location', 'theme', 'configuration'],
  },
  // FL-71: the old /admin/maintenance page (Maintenance.jsx): mode, database backups, integrity.
  { id: 'maintenance', group: 'server', sections: ['mode', 'backups', 'integrity'] },
  // The signed-in account's own settings (the template's "Your preferences").
  {
    id: 'preferences',
    group: 'personal',
    sections: [],
    // Profile, appearance, downloads and library features, as in the template. Usage and supporter
    // status have no other home in the template yet.
    personal: [
      'account',
      'frameleaf-account',
      'app-settings',
      'download-settings',
      'feature',
      'user-usage-info',
      'user-purchase-settings',
    ],
  },
  // FL-71: the old /admin/users pages; one account opens inside the section (`?user=<id>`).
  { id: 'users', group: 'server', sections: ['accounts'] },
  // FL-78: the template moves external library settings out of "Import & protection" into their own
  // area, where the Libraries manager sits above them (`moveSection("backup", "libraries", "sources")`).
  { id: 'libraries', group: 'library', sections: ['external-library'], adminOnly: true },
  // FL-69: utilities belong to every account; the area draws its own tool directory.
  { id: 'utilities', group: 'library', sections: [] },
  // FL-71: the account's Trash (the old /trash page); the rail's Trash opens it.
  { id: 'trash', group: 'library', sections: [], personal: ['contents'] },
  // FL-66: the template's "Change history" area. It holds no settings form; the host shows the
  // saved settings changes there.
  // FL-71 (CC-10): every account has its own preference history here; administrators also see the settings history.
  { id: 'history', group: 'personal', sections: [] },
]);

/**
 * Each area's coloured icon tile in the settings navigation, like System Settings (FL-76; the
 * template's apple-style.css:565-640 `--tile` per area). The icon is drawn white on the tile.
 */
export const AREA_TILE_COLORS: Readonly<Record<SettingsAreaId, string>> = Object.freeze({
  overview: '#0a84ff',
  analytics: '#bf5af2',
  storage: '#8e8e93',
  backup: '#30b0c7',
  intelligence: '#5e5ce6',
  editing: '#ff9f0a',
  sharing: '#0a84ff',
  care: '#30d158',
  libraries: '#64d2ff',
  utilities: '#636366',
  trash: '#8e8e93',
  processing: '#636366',
  cloud: '#0a84ff',
  security: '#0a84ff',
  notifications: '#ff453a',
  server: '#8e8e93',
  maintenance: '#636366',
  users: '#0a84ff',
  preferences: '#8e8e93',
  history: '#636366',
});

export const SETTINGS_GROUP_ORDER: readonly SettingsGroupId[] = Object.freeze([
  'command',
  'library',
  'server',
  'personal',
]);

/** Where the Command Center opens without an area: the first area the account can use. */
export const defaultSettingsArea = (isAdmin: boolean): SettingsAreaId => (isAdmin ? 'overview' : 'preferences');

export const isSettingsAreaId = (value: string | null | undefined): value is SettingsAreaId =>
  SETTINGS_AREAS.some((area) => area.id === value);

/** Areas that are screens of their own rather than directories of settings sections (FL-79). */
export const SCREEN_AREAS: readonly SettingsAreaId[] = Object.freeze(['overview', 'analytics', 'utilities', 'history']);

/** Areas whose one section opens directly, as the template's `navigate()` does for them. */
export const DIRECT_SECTION: Partial<Record<SettingsAreaId, string>> = Object.freeze({
  users: 'accounts',
  trash: 'contents',
});

export const isScreenArea = (area: SettingsAreaId) => SCREEN_AREAS.includes(area);

/** Whether an account may open an area at all. Section-level gating is the caller's section list. */
export const isAreaAvailable = (area: SettingsAreaDefinition, isAdmin: boolean) =>
  isAdmin ||
  (!area.adminOnly && ((area.personal?.length ?? 0) > 0 || (isScreenArea(area.id) && area.sections.length === 0)));

/** The one address of the Command Center (FL-71), for an area and optionally one of its sections. */
export const COMMAND_CENTER_PATH = '/user-settings';

export const commandCenterUrl = (
  area?: SettingsAreaId,
  section?: string,
  params: Record<string, string | number | undefined> = {},
) => {
  const search = new URLSearchParams();
  if (area) {
    search.set('area', area);
  }
  if (section) {
    search.set('section', section);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `${COMMAND_CENTER_PATH}?${query}` : COMMAND_CENTER_PATH;
};

/** The address of Library analytics in the command center, optionally for one scope and range. */
export const analyticsAreaUrl = (params: { scope?: string; range?: string } = {}) =>
  commandCenterUrl('analytics', undefined, { scope: params.scope, range: params.range });

/** Server section keys older links use for a section that now has another key. */
const SERVER_ALIASES: Record<string, string> = { job: 'queues' };

/** The server section a legacy key names. */
export const serverSectionKey = (key: string) => SERVER_ALIASES[key] ?? key;

/** The area that owns a server settings section key, for `?isOpen=` links written before the areas existed. */
export const areaForSection = (sectionKey: string): SettingsAreaId | undefined =>
  SETTINGS_AREAS.find((area) => area.sections.includes(serverSectionKey(sectionKey)))?.id;

/** Account section keys the older personal settings page used under another name. */
const PERSONAL_ALIASES: Record<string, string> = { notifications: 'email-preferences' };

/** The account section a legacy key names. */
export const personalSectionKey = (key: string) => PERSONAL_ALIASES[key] ?? key;

/** The area that owns an account section key (or its older name). */
export const areaForPersonalSection = (sectionKey: string): SettingsAreaId | undefined =>
  SETTINGS_AREAS.find((area) => area.personal?.includes(personalSectionKey(sectionKey)))?.id;

/** Orders an area's keys as it displays them: its `order`, else server sections first. */
const inDisplayOrder = <T>(area: SettingsAreaDefinition, items: T[], key: (item: T) => string): T[] =>
  area.order ? [...items].sort((a, b) => area.order!.indexOf(key(a)) - area.order!.indexOf(key(b))) : items;

/** Every section key of an area, in display order (server sections first unless the area orders them). */
export const areaSectionKeys = (areaId: SettingsAreaId): string[] => {
  const area = SETTINGS_AREAS.find((item) => item.id === areaId);
  return area ? inDisplayOrder(area, [...area.sections, ...(area.personal ?? [])], (key) => key) : [];
};

/**
 * Which area and section a Command Center address shows. An explicit `area` wins; otherwise the
 * first `isOpen` key that names a known section picks its area (account sections first: the older
 * personal settings page used the bare `/user-settings?isOpen=` form, the old administrator page's
 * links are rewritten with an explicit area when they redirect); otherwise the account's default.
 */
export const resolveSettingsArea = (params: {
  area?: string | null;
  isOpen?: string | null;
  isAdmin?: boolean;
}): SettingsAreaId => {
  if (isSettingsAreaId(params.area)) {
    return params.area;
  }
  for (const key of (params.isOpen ?? '').split(' ')) {
    const area = areaForPersonalSection(key) ?? areaForSection(key);
    if (area) {
      return area;
    }
  }
  return defaultSettingsArea(params.isAdmin ?? true);
};

/** The section a Command Center address opens inside `area`: `section`, else the first matching `isOpen` key. */
export const resolveSettingsSection = (
  area: SettingsAreaId,
  params: { section?: string | null; isOpen?: string | null },
): string | undefined => {
  const keys = areaSectionKeys(area);
  if (params.section && keys.includes(params.section)) {
    return params.section;
  }
  const area_ = SETTINGS_AREAS.find((item) => item.id === area);
  // A bare legacy key names the account's section first, as `resolveSettingsArea` reads it; server
  // links (`Route.systemSettings`) name their section explicitly.
  for (const key of (params.isOpen ?? '').split(' ')) {
    if (area_?.personal?.includes(personalSectionKey(key))) {
      return personalSectionKey(key);
    }
    if (area_?.sections.includes(serverSectionKey(key))) {
      return serverSectionKey(key);
    }
  }
  return DIRECT_SECTION[area];
};

export type SearchableSection = { key: string; title: string; subtitle?: string };

export const normalizeSettingsQuery = (query: string | null | undefined) => (query ?? '').trim().toLowerCase();

/** Sections whose title or help mentions the query, in their area order. Empty query matches nothing. */
export const searchSettingsSections = <T extends SearchableSection>(sections: readonly T[], query: string): T[] => {
  const needle = normalizeSettingsQuery(query);
  if (!needle) {
    return [];
  }
  return sections.filter(
    (section) =>
      section.title.toLowerCase().includes(needle) || (section.subtitle ?? '').toLowerCase().includes(needle),
  );
};

/** Sections of one area that the caller offers, in the area's display order; unknown keys are ignored. */
export const sectionsForArea = <T extends { key: string; admin?: boolean }>(
  sections: readonly T[],
  areaId: SettingsAreaId,
): T[] => {
  const area = SETTINGS_AREAS.find((item) => item.id === areaId);
  if (!area) {
    return [];
  }
  const pick = (keys: readonly string[], admin: boolean) =>
    keys
      .map((key) => sections.find((section) => section.key === key && Boolean(section.admin) === admin))
      .filter((section): section is T => section !== undefined);
  return inDisplayOrder(area, [...pick(area.sections, true), ...pick(area.personal ?? [], false)], ({ key }) => key);
};

// ── Area directories (FL-71, FL-10) ─────────────────────────────────────────

/**
 * Who a section applies to. Most areas are server-wide, so a directory tags only the rows whose
 * scope differs from the rest of their area (the template's `SectionDirectory` and
 * `directoryScope`, CommandCenter.jsx:2586-2757).
 */
export type SectionScope = 'server' | 'account' | 'device';

/** Account sections stored in this browser rather than on the server (the template's `device` scope). */
const DEVICE_SECTIONS: ReadonlySet<string> = new Set(['app-settings']);

export const sectionScope = (section: { key: string; admin?: boolean }): SectionScope =>
  section.admin ? 'server' : DEVICE_SECTIONS.has(section.key) ? 'device' : 'account';

/** The scope most rows of a directory share; ties go to the first row's scope. */
export const usualScope = (scopes: readonly SectionScope[]): SectionScope | undefined => {
  let usual: SectionScope | undefined;
  let most = 0;
  for (const scope of scopes) {
    const count = scopes.filter((item) => item === scope).length;
    if (count > most) {
      usual = scope;
      most = count;
    }
  }
  return usual;
};

/** Directory group headings (`frameleaf_cc_group_<id>`), the template's `directoryGroups` and `sectionGroup`. */
export type DirectoryGroupId =
  | 'storage'
  | 'identical_files'
  | 'trash'
  | 'import'
  | 'protection'
  | 'search'
  | 'smart_albums'
  | 'recognition'
  | 'photos'
  | 'video_playback'
  | 'sharing'
  | 'health'
  | 'repairs'
  | 'tools'
  | 'workers'
  | 'job_management'
  | 'schedules'
  | 'sign_in'
  | 'locked_content'
  | 'devices'
  | 'email'
  | 'this_server'
  | 'updates'
  | 'maps'
  | 'account'
  | 'library'
  | 'downloads'
  | 'account_link'
  | 'licensing'
  | 'remote'
  | 'cloud_services'
  | 'more';

const DIRECTORY_GROUPS: Partial<Record<SettingsAreaId, Record<string, DirectoryGroupId>>> = {
  storage: {
    'storage-template': 'storage',
    migration: 'storage',
    deduplication: 'identical_files',
    trash: 'trash',
    'user-settings': 'trash',
  },
  backup: { takeout: 'import', backup: 'protection', preservation: 'protection' },
  intelligence: { 'machine-learning': 'search', 'smart-albums': 'smart_albums', metadata: 'recognition' },
  editing: { image: 'photos', 'video-transcoding': 'video_playback' },
  sharing: { sharing: 'sharing' },
  care: { 'integrity-checks': 'health', repair: 'repairs', 'enrichment-care': 'repairs' },
  processing: {
    workers: 'workers',
    routing: 'workers',
    'render-workers': 'workers',
    hardware: 'workers',
    queues: 'job_management',
    'nightly-tasks': 'schedules',
  },
  cloud: {
    'cloud-account': 'account_link',
    'cloud-plan': 'licensing',
    'cloud-license': 'licensing',
    'cloud-remote': 'remote',
    'cloud-processing': 'cloud_services',
    'cloud-backup': 'cloud_services',
  },
  security: {
    authentication: 'sign_in',
    'frameleaf-signin': 'sign_in',
    password: 'sign_in',
    oauth: 'sign_in',
    'user-pin-code-settings': 'locked_content',
    'suppressed-content': 'locked_content',
    'authorized-devices': 'devices',
    'api-keys': 'devices',
  },
  notifications: { notifications: 'email', 'email-preferences': 'email' },
  server: {
    server: 'this_server',
    theme: 'this_server',
    'version-check': 'updates',
    logging: 'updates',
    configuration: 'updates',
    location: 'maps',
  },
  preferences: {
    account: 'account',
    'user-usage-info': 'account',
    'user-purchase-settings': 'account',
    'frameleaf-account': 'account',
    'app-settings': 'library',
    feature: 'library',
    'download-settings': 'downloads',
  },
};

/**
 * The group heading a section sits under in its area's directory. Areas without groups (Maintenance)
 * have none; an unlisted section of a grouped area goes under "More".
 */
export const directoryGroup = (area: SettingsAreaId, key: string): DirectoryGroupId | undefined => {
  const groups = DIRECTORY_GROUPS[area];
  return groups ? (groups[key] ?? 'more') : undefined;
};
