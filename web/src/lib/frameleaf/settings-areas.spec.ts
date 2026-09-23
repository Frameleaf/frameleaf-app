import { describe, expect, it } from 'vitest';
import {
  analyticsAreaUrl,
  areaForSection,
  isScreenArea,
  DEFAULT_SETTINGS_AREA,
  resolveSettingsArea,
  searchSettingsSections,
  sectionsForArea,
  SETTINGS_AREAS,
} from '$lib/frameleaf/settings-areas';

const sections = [
  { key: 'storage-template', title: 'Storage template', subtitle: 'Manage the folder structure of uploads' },
  { key: 'trash', title: 'Trash settings', subtitle: 'Manage trash settings' },
  { key: 'job', title: 'Job settings', subtitle: 'Manage job concurrency' },
  { key: 'authentication', title: 'Authentication settings', subtitle: 'Manage password, OAuth' },
];

describe('Frameleaf settings areas', () => {
  it('lists every section key exactly once', () => {
    const keys = SETTINGS_AREAS.flatMap((area) => area.sections);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps every legacy accordion key that other pages deep link to', () => {
    // OpenQueryParam.JOB, OpenQueryParam.STORAGE_TEMPLATE, OpenQueryParam.OAUTH's section, OpenQueryParam.NOTIFICATIONS
    expect(areaForSection('job')).toBe('processing');
    expect(areaForSection('storage-template')).toBe('storage');
    expect(areaForSection('authentication')).toBe('security');
    expect(areaForSection('notifications')).toBe('notifications');
    // Google Photos imports sit with the other imports (FL-65).
    expect(areaForSection('takeout')).toBe('backup');
    // Server migration is the last Storage & originals section, as in the template (FL-75).
    expect(areaForSection('migration')).toBe('storage');
    expect(SETTINGS_AREAS.find((area) => area.id === 'storage')?.sections.at(-1)).toBe('migration');
    expect(areaForSection('unknown')).toBeUndefined();
  });

  it('opens Library analytics as a command center screen, as the template does (FL-79)', () => {
    expect(SETTINGS_AREAS[0]).toEqual({ id: 'analytics', group: 'command', sections: [] });
    expect(isScreenArea('analytics')).toBe(true);
    expect(isScreenArea('storage')).toBe(false);
    expect(resolveSettingsArea({ area: 'analytics' })).toBe('analytics');
    expect(analyticsAreaUrl()).toBe('/admin/system-settings?area=analytics');
    expect(analyticsAreaUrl({ scope: 'library:abc', range: '90days' })).toBe(
      '/admin/system-settings?area=analytics&scope=library%3Aabc&range=90days',
    );
  });

  it('keeps Originals & preservation with imports and database backups (FL-74)', () => {
    expect(areaForSection('preservation')).toBe('backup');
    expect(resolveSettingsArea({ isOpen: 'preservation' })).toBe('backup');
  });

  describe(resolveSettingsArea.name, () => {
    it('prefers an explicit area, then the first known isOpen key, then the default', () => {
      expect(resolveSettingsArea({ area: 'server' })).toBe('server');
      expect(resolveSettingsArea({ area: 'nope', isOpen: 'job' })).toBe('processing');
      expect(resolveSettingsArea({ isOpen: 'oauth storage-template' })).toBe('storage');
      expect(resolveSettingsArea({ isOpen: 'oauth' })).toBe(DEFAULT_SETTINGS_AREA);
      expect(resolveSettingsArea({})).toBe(DEFAULT_SETTINGS_AREA);
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
    it('returns the area sections in area order and skips keys with no component', () => {
      expect(sectionsForArea(sections, 'storage').map((s) => s.key)).toEqual(['storage-template', 'trash']);
      expect(sectionsForArea(sections, 'care')).toEqual([]);
    });

    it('keeps the change history as its own personal area without settings forms (FL-66)', () => {
      const history = SETTINGS_AREAS.find((area) => area.id === 'history');
      expect(history).toEqual({ id: 'history', group: 'personal', sections: [] });
      expect(sectionsForArea(sections, 'history')).toEqual([]);
      expect(resolveSettingsArea({ area: 'history' })).toBe('history');
    });
  });
});
