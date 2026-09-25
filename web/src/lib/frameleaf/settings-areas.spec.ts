import { describe, expect, it } from 'vitest';
import {
  analyticsAreaUrl,
  AREA_TILE_COLORS,
  areaForPersonalSection,
  areaSectionKeys,
  areaForSection,
  commandCenterUrl,
  defaultSettingsArea,
  directoryGroup,
  isAreaAvailable,
  isScreenArea,
  resolveSettingsArea,
  resolveSettingsSection,
  searchSettingsSections,
  sectionScope,
  sectionsForArea,
  SETTINGS_AREAS,
  usualScope,
} from '$lib/frameleaf/settings-areas';

const sections = [
  {
    key: 'storage-template',
    title: 'Storage template',
    subtitle: 'Manage the folder structure of uploads',
    admin: true,
  },
  { key: 'trash', title: 'Trash settings', subtitle: 'Manage trash settings', admin: true },
  { key: 'queues', title: 'Job manager', subtitle: 'Manage queues & jobs', admin: true },
  { key: 'authentication', title: 'Authentication settings', subtitle: 'Manage password, OAuth', admin: true },
];

const area = (id: string) => SETTINGS_AREAS.find((item) => item.id === id)!;

describe('Frameleaf settings areas', () => {
  it('lists every server section key and every account section key exactly once', () => {
    const server = SETTINGS_AREAS.flatMap((item) => item.sections);
    const personal = SETTINGS_AREAS.flatMap((item) => item.personal ?? []);
    expect(new Set(server).size).toBe(server.length);
    expect(new Set(personal).size).toBe(personal.length);
  });

  it('keeps every legacy accordion key that other pages deep link to', () => {
    // OpenQueryParam.JOB, OpenQueryParam.STORAGE_TEMPLATE, OpenQueryParam.OAUTH's section, OpenQueryParam.NOTIFICATIONS
    // The old job settings key opens the Job manager, where queue concurrency is edited.
    expect(areaForSection('job')).toBe('processing');
    expect(areaForSection('storage-template')).toBe('storage');
    expect(areaForSection('authentication')).toBe('security');
    expect(areaForSection('notifications')).toBe('notifications');
    // External library settings live with the Libraries manager (FL-78).
    expect(areaForSection('external-library')).toBe('libraries');
    // Server migration is the last Storage & originals section, as in the template (FL-75).
    expect(areaForSection('migration')).toBe('storage');
    expect(area('storage').sections.at(-1)).toBe('migration');
    // The template's "Configuration transfer" closes Server & updates.
    expect(areaForSection('configuration')).toBe('server');
    expect(areaForSection('unknown')).toBeUndefined();
  });

  it('keeps imports and Originals & preservation with database backups, for every account (FL-65, FL-74)', () => {
    expect(areaForPersonalSection('takeout')).toBe('backup');
    expect(areaForPersonalSection('preservation')).toBe('backup');
    expect(areaForSection('backup')).toBe('backup');
    expect(resolveSettingsArea({ isOpen: 'preservation' })).toBe('backup');
  });

  it('places the account settings where the template does', () => {
    expect(area('preferences').group).toBe('personal');
    for (const key of ['account', 'app-settings', 'download-settings', 'feature']) {
      expect(areaForPersonalSection(key)).toBe('preferences');
    }
    // Sign-in, Locked tags & people, devices and API keys: Access & security.
    for (const key of [
      'password',
      'user-pin-code-settings',
      'oauth',
      'suppressed-content',
      'api-keys',
      'authorized-devices',
    ]) {
      expect(areaForPersonalSection(key)).toBe('security');
    }
    // The account's email notifications, under their old name too: Notifications.
    expect(areaForPersonalSection('email-preferences')).toBe('notifications');
    expect(areaForPersonalSection('notifications')).toBe('notifications');
  });

  it('opens Library analytics as a command center screen, as the template does (FL-79)', () => {
    expect(SETTINGS_AREAS[1]).toMatchObject({ id: 'analytics', group: 'command', sections: [] });
    expect(isScreenArea('analytics')).toBe(true);
    expect(isScreenArea('storage')).toBe(false);
    expect(resolveSettingsArea({ area: 'analytics' })).toBe('analytics');
    expect(analyticsAreaUrl()).toBe('/user-settings?area=analytics');
    expect(analyticsAreaUrl({ scope: 'library:abc', range: '90days' })).toBe(
      '/user-settings?area=analytics&scope=library%3Aabc&range=90days',
    );
  });

  it('lists the areas in the template catalogue order', () => {
    expect(SETTINGS_AREAS.map((item) => item.id)).toEqual([
      'overview',
      'analytics',
      'storage',
      'backup',
      'intelligence',
      'editing',
      'sharing',
      'care',
      'processing',
      'cloud',
      'security',
      'notifications',
      'server',
      'maintenance',
      'preferences',
      'users',
      'libraries',
      'utilities',
      'trash',
      'history',
    ]);
  });

  describe(isAreaAvailable.name, () => {
    it('offers an account without administration only areas it has something in', () => {
      const offered = SETTINGS_AREAS.filter((item) => isAreaAvailable(item, false)).map((item) => item.id);
      expect(offered).toEqual([
        'backup',
        'sharing',
        'care',
        'security',
        'notifications',
        'preferences',
        'utilities',
        'trash',
        // FL-71 (CC-10): every account's own preference history.
        'history',
      ]);
      expect(SETTINGS_AREAS.every((item) => isAreaAvailable(item, true))).toBe(true);
    });
  });

  describe(commandCenterUrl.name, () => {
    it('builds the one Command Center address', () => {
      expect(commandCenterUrl()).toBe('/user-settings');
      expect(commandCenterUrl('storage')).toBe('/user-settings?area=storage');
      expect(commandCenterUrl('server', 'theme', { scope: 'user:1', skip: undefined })).toBe(
        '/user-settings?area=server&section=theme&scope=user%3A1',
      );
    });
  });

  describe(resolveSettingsArea.name, () => {
    it('prefers an explicit area, then the first known isOpen key, then the account default', () => {
      expect(resolveSettingsArea({ area: 'server' })).toBe('server');
      expect(resolveSettingsArea({ area: 'nope', isOpen: 'job' })).toBe('processing');
      expect(resolveSettingsArea({ isOpen: 'nope storage-template' })).toBe('storage');
      expect(resolveSettingsArea({ isOpen: 'nope' })).toBe(defaultSettingsArea(true));
      // The template's rail Settings opens the Overview (App.jsx onSettings).
      expect(resolveSettingsArea({})).toBe('overview');
      expect(resolveSettingsArea({ isAdmin: false })).toBe('preferences');
    });

    it('reads a bare key as the account section, as the old personal settings page did', () => {
      expect(resolveSettingsArea({ isOpen: 'notifications' })).toBe('notifications');
      expect(resolveSettingsSection('notifications', { isOpen: 'notifications' })).toBe('email-preferences');
      expect(resolveSettingsArea({ isOpen: 'oauth' })).toBe('security');
      expect(resolveSettingsSection('security', { isOpen: 'oauth' })).toBe('oauth');
      expect(resolveSettingsSection('notifications', { section: 'notifications' })).toBe('notifications');
    });
  });

  describe(resolveSettingsSection.name, () => {
    it('opens the named section of the area, or the first isOpen key the area holds', () => {
      expect(resolveSettingsSection('server', { section: 'theme' })).toBe('theme');
      expect(resolveSettingsSection('server', { section: 'job' })).toBeUndefined();
      expect(resolveSettingsSection('processing', { isOpen: 'library-watch job' })).toBe('queues');
      expect(resolveSettingsSection('notifications', { isOpen: 'notifications' })).toBe('email-preferences');
      expect(resolveSettingsSection('backup', { isOpen: 'preservation' })).toBe('preservation');
      expect(resolveSettingsSection('storage', {})).toBeUndefined();
    });
  });

  describe(searchSettingsSections.name, () => {
    it('matches title or help case-insensitively and returns nothing for a blank query', () => {
      expect(searchSettingsSections(sections, 'TRASH').map((s) => s.key)).toEqual(['trash']);
      expect(searchSettingsSections(sections, 'manage').map((s) => s.key)).toEqual([
        'storage-template',
        'trash',
        'queues',
        'authentication',
      ]);
      expect(searchSettingsSections(sections, ' '.repeat(3))).toEqual([]);
    });
  });

  describe(sectionsForArea.name, () => {
    it('returns the offered area sections in area order, server sections before account sections', () => {
      expect(sectionsForArea(sections, 'storage').map((s) => s.key)).toEqual(['storage-template', 'trash']);
      expect(sectionsForArea(sections, 'care')).toEqual([]);
      const backup = [
        { key: 'preservation', title: 'Preservation' },
        { key: 'backup', title: 'Database backups', admin: true },
        { key: 'takeout', title: 'Imports' },
      ];
      // Imports first, then protection, as the template lists them.
      expect(sectionsForArea(backup, 'backup').map((s) => s.key)).toEqual(['takeout', 'backup', 'preservation']);
    });

    it("interleaves server and account sections where the template does (Library care's health, repair, enrichment)", () => {
      const care = [
        { key: 'enrichment-care', title: 'Enrichment completeness', admin: true },
        { key: 'repair', title: 'Repair queues' },
        { key: 'integrity-checks', title: 'Media health & integrity', admin: true },
      ];
      expect(sectionsForArea(care, 'care').map((s) => s.key)).toEqual([
        'integrity-checks',
        'repair',
        'enrichment-care',
      ]);
      expect(areaSectionKeys('care')).toEqual(['integrity-checks', 'repair', 'enrichment-care']);
      expect(sectionsForArea([care[1]], 'care').map((s) => s.key)).toEqual(['repair']);
    });

    it('keeps the server and account notifications apart', () => {
      const both = [
        { key: 'email-preferences', title: 'Your email notifications' },
        { key: 'notifications', title: 'Email delivery', admin: true },
      ];
      expect(sectionsForArea(both, 'notifications').map((s) => s.title)).toEqual([
        'Email delivery',
        'Your email notifications',
      ]);
      expect(sectionsForArea(both, 'preferences')).toEqual([]);
    });

    it('keeps the change history as its own personal area without settings forms (FL-66)', () => {
      expect(area('history')).toEqual({ id: 'history', group: 'personal', sections: [] });
      expect(sectionsForArea(sections, 'history')).toEqual([]);
      expect(resolveSettingsArea({ area: 'history' })).toBe('history');
    });
  });

  describe('area directories (FL-71, FL-10)', () => {
    it('gives every area a tile colour (FL-76)', () => {
      for (const item of SETTINGS_AREAS) {
        expect(AREA_TILE_COLORS[item.id]).toMatch(/^#[\da-f]{6}$/);
      }
    });

    it('tells server, account and device sections apart', () => {
      expect(sectionScope({ key: 'backup', admin: true })).toBe('server');
      expect(sectionScope({ key: 'takeout' })).toBe('account');
      expect(sectionScope({ key: 'app-settings' })).toBe('device');
    });

    it('finds the scope most rows share, the first one on a tie', () => {
      expect(usualScope(['server', 'account', 'server'])).toBe('server');
      expect(usualScope(['account', 'server'])).toBe('account');
      expect(usualScope([])).toBeUndefined();
    });

    it("groups each area's sections as the template's directory does, with More for strays and none for Maintenance", () => {
      expect(directoryGroup('storage', 'storage-template')).toBe('storage');
      expect(directoryGroup('storage', 'deduplication')).toBe('identical_files');
      expect(directoryGroup('security', 'suppressed-content')).toBe('locked_content');
      expect(directoryGroup('storage', 'something-new')).toBe('more');
      expect(directoryGroup('maintenance', 'mode')).toBeUndefined();
      // Every section an area lists has a group of its own, not More.
      const ungrouped = new Set(['maintenance', 'users', 'libraries', 'trash']);
      for (const item of SETTINGS_AREAS) {
        if (ungrouped.has(item.id)) {
          continue;
        }
        for (const key of areaSectionKeys(item.id)) {
          expect(directoryGroup(item.id, key)).not.toBe('more');
        }
      }
    });
  });
});
