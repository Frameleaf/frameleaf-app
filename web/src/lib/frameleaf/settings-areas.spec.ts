import { describe, expect, it } from 'vitest';
import {
  analyticsAreaUrl,
  areaForPersonalSection,
  areaForSection,
  commandCenterUrl,
  defaultSettingsArea,
  isAreaAvailable,
  isScreenArea,
  resolveSettingsArea,
  resolveSettingsSection,
  searchSettingsSections,
  sectionsForArea,
  SETTINGS_AREAS,
} from '$lib/frameleaf/settings-areas';

const sections = [
  {
    key: 'storage-template',
    title: 'Storage template',
    subtitle: 'Manage the folder structure of uploads',
    admin: true,
  },
  { key: 'trash', title: 'Trash settings', subtitle: 'Manage trash settings', admin: true },
  { key: 'job', title: 'Job settings', subtitle: 'Manage job concurrency', admin: true },
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

  it('puts the account settings under Your preferences in the Personal group', () => {
    expect(area('preferences').group).toBe('personal');
    for (const key of [
      'account',
      'app-settings',
      'api-keys',
      'authorized-devices',
      'oauth',
      'notifications',
      'sharing',
    ]) {
      expect(areaForPersonalSection(key)).toBe('preferences');
    }
  });

  it('opens Library analytics as a command center screen, as the template does (FL-79)', () => {
    expect(SETTINGS_AREAS[0]).toMatchObject({ id: 'analytics', group: 'command', sections: [] });
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
      'analytics',
      'storage',
      'backup',
      'intelligence',
      'editing',
      'care',
      'processing',
      'security',
      'notifications',
      'server',
      'preferences',
      'libraries',
      'utilities',
      'history',
    ]);
  });

  describe(isAreaAvailable.name, () => {
    it('offers an account without administration only areas it has something in', () => {
      const offered = SETTINGS_AREAS.filter((item) => isAreaAvailable(item, false)).map((item) => item.id);
      expect(offered).toEqual(['backup', 'preferences', 'utilities']);
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
      expect(resolveSettingsArea({})).toBe('storage');
      expect(resolveSettingsArea({ isAdmin: false })).toBe('preferences');
    });

    it('reads a bare key as the account section, as the old personal settings page did', () => {
      expect(resolveSettingsArea({ isOpen: 'notifications' })).toBe('preferences');
      expect(resolveSettingsArea({ isOpen: 'oauth' })).toBe('preferences');
      expect(resolveSettingsArea({ area: 'notifications', isOpen: 'notifications' })).toBe('notifications');
    });
  });

  describe(resolveSettingsSection.name, () => {
    it('opens the named section of the area, or the first isOpen key the area holds', () => {
      expect(resolveSettingsSection('server', { section: 'theme' })).toBe('theme');
      expect(resolveSettingsSection('server', { section: 'job' })).toBeUndefined();
      expect(resolveSettingsSection('processing', { isOpen: 'library-watch job' })).toBe('job');
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
        'job',
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
      expect(sectionsForArea(backup, 'backup').map((s) => s.key)).toEqual(['backup', 'takeout', 'preservation']);
    });

    it('keeps the server and account notifications apart', () => {
      const both = [
        { key: 'notifications', title: 'Email delivery', admin: true },
        { key: 'notifications', title: 'Your email notifications' },
      ];
      expect(sectionsForArea(both, 'notifications').map((s) => s.title)).toEqual(['Email delivery']);
      expect(sectionsForArea(both, 'preferences').map((s) => s.title)).toEqual(['Your email notifications']);
    });

    it('keeps the change history as its own personal area without settings forms (FL-66)', () => {
      expect(area('history')).toEqual({ id: 'history', group: 'personal', sections: [], adminOnly: true });
      expect(sectionsForArea(sections, 'history')).toEqual([]);
      expect(resolveSettingsArea({ area: 'history' })).toBe('history');
    });
  });
});
