/**
 * The settings information architecture for the Frameleaf admin settings page (FL-71), ported
 * from the design template's `settings-catalog.mjs` areas. Sections are the existing
 * system-config forms; this module only decides where each one lives, which area a legacy
 * `?isOpen=<key>` deep link opens, and what a search over the page returns.
 */
import type { Component } from 'svelte';

export type SettingsGroupId = 'command' | 'library' | 'server' | 'personal';

/** One settings form as the host renders it: an existing system-config section with its copy. */
export type SettingsHostSection = {
  key: string;
  title: string;
  subtitle: string;
  icon: string;
  component: Component;
};

export type SettingsAreaId =
  | 'analytics'
  | 'storage'
  | 'backup'
  | 'intelligence'
  | 'editing'
  | 'care'
  | 'libraries'
  | 'processing'
  | 'security'
  | 'notifications'
  | 'server'
  | 'history';

export type SettingsAreaDefinition = {
  id: SettingsAreaId;
  group: SettingsGroupId;
  /** Section keys, in display order. These are the legacy accordion keys, kept for deep links. */
  sections: string[];
};

export const SETTINGS_AREAS: readonly SettingsAreaDefinition[] = Object.freeze([
  // FL-79: the template's Command center group. Library analytics is a screen, not a set of
  // config forms, so it owns no sections; the host renders it in place of the section list.
  { id: 'analytics', group: 'command', sections: [] },
  // FL-75: `migration` is the template's "Move or export your library", last in this area.
  { id: 'storage', group: 'library', sections: ['storage-template', 'trash', 'user-settings', 'migration'] },
  // FL-74: "Originals & preservation" sits with imports and database backups, as in the design.
  { id: 'backup', group: 'library', sections: ['takeout', 'backup', 'preservation'] },
  { id: 'intelligence', group: 'library', sections: ['machine-learning', 'smart-albums', 'metadata'] },
  { id: 'editing', group: 'library', sections: ['image', 'video-transcoding'] },
  { id: 'care', group: 'library', sections: ['integrity-checks'] },
  // FL-78: the template moves external library settings out of "Import & protection" into their own
  // area, where the Libraries manager sits above them (`moveSection("backup", "libraries", "sources")`).
  { id: 'libraries', group: 'library', sections: ['external-library'] },
  { id: 'processing', group: 'server', sections: ['job', 'nightly-tasks'] },
  { id: 'security', group: 'server', sections: ['authentication'] },
  { id: 'notifications', group: 'server', sections: ['notifications'] },
  { id: 'server', group: 'server', sections: ['server', 'version-check', 'logging', 'location', 'theme'] },
  // FL-66: the template's "Change history" area. It holds no settings form; the host shows the
  // saved settings changes there.
  { id: 'history', group: 'personal', sections: [] },
]);

export const SETTINGS_GROUP_ORDER: readonly SettingsGroupId[] = Object.freeze([
  'command',
  'library',
  'server',
  'personal',
]);

export const DEFAULT_SETTINGS_AREA: SettingsAreaId = 'storage';

export const isSettingsAreaId = (value: string | null | undefined): value is SettingsAreaId =>
  SETTINGS_AREAS.some((area) => area.id === value);

/** Areas that are screens of their own rather than lists of settings sections (FL-79). */
export const SCREEN_AREAS: readonly SettingsAreaId[] = Object.freeze(['analytics']);

export const isScreenArea = (area: SettingsAreaId) => SCREEN_AREAS.includes(area);

/** The address of Library analytics in the command center, optionally for one scope and range. */
export const analyticsAreaUrl = (params: { scope?: string; range?: string } = {}) => {
  const search = new URLSearchParams({ area: 'analytics' });
  if (params.scope) {
    search.set('scope', params.scope);
  }
  if (params.range) {
    search.set('range', params.range);
  }
  return `/admin/system-settings?${search.toString()}`;
};

/** The area that owns a section key, for `?isOpen=` links written before the areas existed. */
export const areaForSection = (sectionKey: string): SettingsAreaId | undefined =>
  SETTINGS_AREAS.find((area) => area.sections.includes(sectionKey))?.id;

/**
 * Which area to show for a URL. An explicit `area` wins; otherwise the first `isOpen` key that
 * names a known section picks its area; otherwise the default.
 */
export const resolveSettingsArea = (params: { area?: string | null; isOpen?: string | null }): SettingsAreaId => {
  if (isSettingsAreaId(params.area)) {
    return params.area;
  }
  for (const key of (params.isOpen ?? '').split(' ')) {
    const area = areaForSection(key);
    if (area) {
      return area;
    }
  }
  return DEFAULT_SETTINGS_AREA;
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

/** Sections of one area, ordered as the area lists them; unknown keys are ignored. */
export const sectionsForArea = <T extends { key: string }>(sections: readonly T[], areaId: SettingsAreaId): T[] => {
  const area = SETTINGS_AREAS.find((item) => item.id === areaId);
  if (!area) {
    return [];
  }
  return area.sections
    .map((key) => sections.find((section) => section.key === key))
    .filter((section): section is T => section !== undefined);
};
