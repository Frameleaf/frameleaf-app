import type { MessageFormatter } from 'svelte-i18n';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_SETTINGS_AREAS,
  buildCatalogueCommands,
  buildPageCommands,
  buildSettingsCommands,
  emptyCommandCatalogue,
  USER_SETTINGS_AREAS,
  type CommandIndexContext,
} from '$lib/frameleaf/command-index';
import { buildCommandIndex } from '$lib/frameleaf/command-palette';
import { defaultRailCapabilities } from '$lib/frameleaf/navigation';

const $t = ((key: string) => key) as unknown as MessageFormatter;

const context = (overrides: Partial<CommandIndexContext> = {}): CommandIndexContext => ({
  capabilities: defaultRailCapabilities(),
  isAdmin: false,
  ...overrides,
});

const everything = (): CommandIndexContext =>
  context({
    capabilities: {
      search: true,
      map: true,
      trash: true,
      people: true,
      memories: true,
      tags: true,
      folders: true,
      sharedLinks: true,
    },
  });

describe('buildPageCommands', () => {
  it('offers only destinations that resolve to an in-app path', () => {
    const pages = buildPageCommands($t, everything());
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.href?.startsWith('/')).toBe(true);
      expect(page.title).toBeTruthy();
    }
  });

  it('hides destinations the account has switched off, exactly as the rail does', () => {
    const withAll = buildPageCommands($t, everything()).map((page) => page.id);
    const withNone = buildPageCommands($t, context()).map((page) => page.id);
    expect(withAll).toContain('rail:people');
    expect(withNone).not.toContain('rail:people');
    // Destinations that are not behind a preference stay in both.
    expect(withNone).toContain('rail:favorites');
    expect(withNone).toContain('primary:library');
  });

  it('offers the top bar destinations: Library home, Studio projects and Activity', () => {
    const pages = buildPageCommands($t, context());
    const hrefOf = (id: string) => pages.find((page) => page.id === id)?.href;

    expect(pages.slice(0, 3).map((page) => page.id)).toEqual(['primary:library', 'primary:studio', 'primary:activity']);
    expect(hrefOf('primary:library')).toBe('/photos');
    expect(hrefOf('primary:studio')).toBe('/studio/projects');
    expect(hrefOf('primary:activity')).toBe('/activity');
  });

  it('offers Library once and no Studio rail entry', () => {
    const pages = buildPageCommands($t, everything());
    const ids = pages.map((page) => page.id);

    expect(pages.filter((page) => page.href === '/photos')).toHaveLength(1);
    expect(ids).not.toContain('rail:library');
    expect(ids).not.toContain('rail:studio');
    expect(pages.filter((page) => page.href === '/studio/projects')).toHaveLength(1);
  });

  it('adds the admin pages only for an administrator', () => {
    const asUser = buildPageCommands($t, context()).map((page) => page.id);
    const asAdmin = buildPageCommands($t, context({ isAdmin: true })).map((page) => page.id);
    expect(asUser.some((id) => id.startsWith('admin:'))).toBe(false);
    expect(asAdmin).toContain('admin:users');
    expect(asAdmin).toContain('admin:maintenance');
  });
});

describe('settings areas', () => {
  it('declares unique keys', () => {
    for (const areas of [USER_SETTINGS_AREAS, ADMIN_SETTINGS_AREAS]) {
      expect(new Set(areas.map((area) => area.key)).size).toBe(areas.length);
    }
  });

  it('deep-links each account section by its key and each server section by its Command Center area', () => {
    const commands = buildSettingsCommands($t, context({ isAdmin: true }));
    const appSettings = commands.find((command) => command.id === 'user:app-settings');
    const adminTheme = commands.find((command) => command.id === 'admin:theme');
    expect(appSettings?.href).toBe('/user-settings?isOpen=app-settings');
    expect(adminTheme?.href).toBe('/user-settings?area=server&section=theme');
  });

  it('withholds the system settings areas from a non-administrator', () => {
    const commands = buildSettingsCommands($t, context({ frameleafCloud: true }));
    expect(commands).toHaveLength(USER_SETTINGS_AREAS.length);
    expect(commands.some((command) => command.id.startsWith('admin:'))).toBe(false);
  });

  it('offers "Frameleaf account" only when the server is configured for Frameleaf Cloud (FL-158)', () => {
    const ids = (frameleafCloud: boolean) =>
      buildSettingsCommands($t, context({ frameleafCloud })).map((command) => command.id);
    expect(ids(false)).not.toContain('user:frameleaf-account');
    expect(ids(true)).toContain('user:frameleaf-account');
  });
});

describe('buildCatalogueCommands', () => {
  it('produces nothing before the catalogue has loaded', () => {
    const commands = buildCatalogueCommands($t, emptyCommandCatalogue());
    expect(commands.people).toEqual([]);
    expect(commands.collections).toEqual([]);
    expect(commands.places).toEqual([]);
  });

  it('points people and albums at their own pages and a place at its search results', () => {
    const commands = buildCatalogueCommands($t, {
      people: [{ id: 'p1', name: 'Ada' }] as never,
      albums: [{ id: 'a1', name: 'Iceland', icon: null, kind: 'album', assetCount: 12, shared: false, children: [] }],
      places: [{ field: 'city', value: 'Banff' }],
    });
    expect(commands.people[0].href).toBe('/people/p1');
    expect(commands.collections[0].href).toBe('/albums/a1');
    expect(commands.places[0].href).toContain('/search?query=');
    expect(decodeURIComponent(commands.places[0].href as string)).toContain('"city":"Banff"');
  });

  it('opens a shared space on its own page', () => {
    const commands = buildCatalogueCommands($t, {
      ...emptyCommandCatalogue(),
      albums: [{ id: 's1', name: 'Family', icon: null, kind: 'space', assetCount: 3, shared: true, children: [] }],
    });
    expect(commands.collections[0].href).toBe('/sharing/s1');
  });

  it('names an unnamed person rather than offering a blank row', () => {
    const commands = buildCatalogueCommands($t, {
      ...emptyCommandCatalogue(),
      people: [{ id: 'p2', name: '' }] as never,
    });
    expect(commands.people[0].title).toBe('no_name');
  });

  it('combines with the static groups into one index', () => {
    const index = buildCommandIndex({
      pages: buildPageCommands($t, everything()),
      settings: buildSettingsCommands($t, context({ isAdmin: true })),
      ...buildCatalogueCommands($t, {
        people: [{ id: 'p1', name: 'Ada' }] as never,
        albums: [],
        places: [],
      }),
    });
    expect(index.some((item) => item.group === 'pages')).toBe(true);
    expect(index.some((item) => item.group === 'settings')).toBe(true);
    expect(index.some((item) => item.id === 'people:p1')).toBe(true);
  });
});
