import { describe, expect, it } from 'vitest';
import {
  areaForSection,
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
    expect(areaForSection('unknown')).toBeUndefined();
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
  });
});
