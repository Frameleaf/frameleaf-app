import { describe, expect, it } from 'vitest';
import {
  analyticsAreaUrl,
  AREA_TILE_COLORS,
  areaForPersonalSection,
  areaSectionKeys,
  areaForSection,
  BACKUP_PLACE_PAGES,
  BACKUP_TABS,
  backupPageUrl,
  backupPageFor,
  commandCenterUrl,
  defaultSettingsArea,
  directoryGroup,
  honoursScope,
  isAreaAvailable,
  isBackupSection,
  isPlainArea,
  isScreenArea,
  presentedArea,
  presentedAreaForSection,
  resolveSettingsArea,
  resolveSettingsSection,
  searchSettingsSections,
  sectionScope,
  sectionsForArea,
  SETTINGS_AREAS,
  usualScope,
  serverSectionKey,
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
    // Sign-in, Locked tags & people, devices and API keys: Your sign-in & privacy (FL-367).
    for (const key of [
      'password',
      'user-pin-code-settings',
      'oauth',
      'suppressed-content',
      'locked-encryption',
      'api-keys',
      'authorized-devices',
    ]) {
      expect(areaForPersonalSection(key)).toBe('privacy');
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

  it('opens Backup for administrators and keeps the old Cloud and database addresses', () => {
    expect(isScreenArea('backups')).toBe(true);
    expect(resolveSettingsArea({ area: 'backups' })).toBe('backups');
    expect(isAreaAvailable(area('backups'), false)).toBe(false);
    expect(isAreaAvailable(area('backups'), true)).toBe(true);
    expect(areaForSection('cloud-backup')).toBe('cloud');
    expect(areaForSection('backup')).toBe('backup');
  });

  it('shows every backup page under the one Backup area without moving its address (FL-362, design review finding 66)', () => {
    expect([...BACKUP_TABS]).toEqual(['overview', 'schedule', 'restore']);
    expect([...BACKUP_PLACE_PAGES]).toEqual(['cloud', 'buddy', 'local']);
    // The schedule, the backups manager and Cloud backup are shown in Backup…
    expect(presentedArea('backup', 'backup')).toBe('backups');
    expect(presentedArea('maintenance', 'backups')).toBe('backups');
    expect(presentedArea('cloud', 'cloud-backup')).toBe('backups');
    expect(presentedAreaForSection('backup')).toBe('backups');
    // …each on the page that took its place.
    expect(backupPageFor('backup', 'backup')).toBe('schedule');
    expect(backupPageFor('maintenance', 'backups')).toBe('local');
    expect(backupPageFor('cloud', 'cloud-backup')).toBe('cloud');
    // Inside Backup the page is the address's own section, or the view an older link names.
    expect(backupPageFor('backups')).toBe('overview');
    expect(backupPageFor('backups', undefined, { section: 'restore' })).toBe('restore');
    expect(backupPageFor('backups', undefined, { section: 'buddy' })).toBe('buddy');
    expect(backupPageFor('backups', undefined, { section: 'unknown' })).toBe('overview');
    expect(backupPageFor('backups', undefined, { backupView: 'controls' })).toBe('buddy');
    expect(backupPageFor('backups', undefined, { backupView: 'cloud' })).toBe('cloud');
    expect(backupPageFor('backups', undefined, { section: 'local', backupView: 'cloud' })).toBe('local');
    expect(backupPageUrl()).toBe('/user-settings?area=backups');
    expect(backupPageUrl('cloud')).toBe('/user-settings?area=backups&section=cloud');
    // …and nothing else moves.
    expect(presentedArea('backup', 'takeout')).toBe('backup');
    expect(presentedArea('maintenance', 'integrity')).toBe('maintenance');
    expect(presentedArea('cloud', 'cloud-plan')).toBe('cloud');
    expect(presentedAreaForSection('trash')).toBe('storage');
    expect(isBackupSection('maintenance', 'mode')).toBe(false);
    expect(backupPageFor('storage', 'trash')).toBeUndefined();
    // The addresses older links, the redirects and the command palette use are unchanged.
    expect(areaForSection('backup')).toBe('backup');
    expect(areaForSection('backups')).toBe('maintenance');
    expect(areaForSection('cloud-backup')).toBe('cloud');
  });

  it('offers the Viewing scope only where a page reads it (design review finding 65)', () => {
    expect(honoursScope('overview')).toBe(false);
    expect(honoursScope('analytics')).toBe(true);
    expect(honoursScope('care', 'repair')).toBe(true);
    expect(honoursScope('processing', 'queues')).toBe(true);
    expect(honoursScope('processing', 'workers')).toBe(false);
    expect(honoursScope('storage')).toBe(false);
    expect(honoursScope('utilities')).toBe(false);
  });

  it('lists the areas in the template catalogue order', () => {
    expect(SETTINGS_AREAS.map((item) => item.id)).toEqual([
      'overview',
      'analytics',
      'backups',
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
      'privacy',
      'users',
      'libraries',
      'utilities',
      'trash',
      'history',
    ]);
  });

  it('places Frameleaf Cloud after Compute & jobs with its account, plan, licence, remote access, processing and backup pages (FL-154, FL-160)', () => {
    expect(SETTINGS_AREAS.find((item) => item.id === 'cloud')).toEqual({
      id: 'cloud',
      group: 'server',
      sections: ['cloud-account', 'cloud-plan', 'cloud-remote', 'cloud-processing', 'cloud-backup'],
      adminOnly: true,
    });
    expect(directoryGroup('cloud', 'cloud-processing')).toBe('cloud_services');
    expect(directoryGroup('cloud', 'cloud-backup')).toBe('cloud_services');
    expect(AREA_TILE_COLORS.cloud).toBeDefined();
    expect(directoryGroup('cloud', 'cloud-account')).toBe('account_link');
    expect(directoryGroup('cloud', 'cloud-plan')).toBe('licensing');
    // FL-544: Licence folded into Your Frameleaf Cloud; old links still land there
    expect(serverSectionKey('cloud-license')).toBe('cloud-plan');
    expect(areaForSection('cloud-license')).toBe('cloud');
    expect(directoryGroup('cloud', 'cloud-remote')).toBe('remote');
    expect(areaForSection('cloud-remote')).toBe('cloud');
  });

  describe(isAreaAvailable.name, () => {
    it('offers an account without administration only areas it has something in', () => {
      const offered = SETTINGS_AREAS.filter((item) => isAreaAvailable(item, false)).map((item) => item.id);
      expect(offered).toEqual([
        'backup',
        'sharing',
        'care',
        'notifications',
        'preferences',
        // FL-367: a person's own sign-in; Who can sign in is for administrators.
        'privacy',
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
      expect(resolveSettingsArea({ isOpen: 'oauth' })).toBe('privacy');
      expect(resolveSettingsSection('privacy', { isOpen: 'oauth' })).toBe('oauth');
      // FL-367: an address written before the split still opens the person's own page.
      expect(resolveSettingsArea({ area: 'security', section: 'api-keys' })).toBe('privacy');
      expect(resolveSettingsArea({ area: 'security', section: 'authentication' })).toBe('security');
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

    it("interleaves server and account sections where the template does (Library care's health, repair, deduplication, enrichment)", () => {
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
      expect(areaSectionKeys('care')).toEqual([
        'integrity-checks',
        'repair',
        'duplicates',
        'enrichment-care',
        'unused-files',
      ]);
      expect(sectionsForArea([care[1]], 'care').map((s) => s.key)).toEqual(['repair']);
    });

    it('opens the prototype addresses and the folded tuning pages on the page that took them (FL-366)', () => {
      expect(resolveSettingsSection('care', { section: 'health' })).toBe('integrity-checks');
      expect(resolveSettingsSection('care', { section: 'advanced-integrity-budget' })).toBe('integrity-checks');
      expect(resolveSettingsSection('care', { section: 'exact-copies' })).toBe('duplicates');
      // FL-413: the retired Merge older copies opens Duplicates
      expect(resolveSettingsSection('care', { section: 'deduplication' })).toBe('duplicates');
      // FL-416: File trash is Unused files
      expect(resolveSettingsSection('care', { section: 'file-trash' })).toBe('unused-files');
      expect(resolveSettingsSection('care', { section: 'advanced-duplicate-matching' })).toBe('duplicates');
      expect(resolveSettingsSection('intelligence', { section: 'metadata' })).toBe('faces');
      expect(resolveSettingsSection('intelligence', { section: 'smart-album-pets' })).toBe('smart-albums');
      expect(resolveSettingsSection('intelligence', { section: 'advanced-search-labels' })).toBe('descriptions');
      expect(resolveSettingsSection('editing', { section: 'previews' })).toBe('image');
      expect(resolveSettingsSection('editing', { section: 'advanced-hls' })).toBe('video-transcoding');
      // The old Search & recognition page is the area's landing page now.
      expect(resolveSettingsSection('intelligence', { section: 'machine-learning' })).toBeUndefined();
      expect(resolveSettingsArea({ isOpen: 'machine-learning' })).toBe('intelligence');
      expect(areaForSection('metadata')).toBe('intelligence');
      for (const area of ['care', 'intelligence', 'editing', 'maintenance'] as const) {
        expect(isPlainArea(area)).toBe(true);
      }
    });

    it('keeps the server and account notifications apart', () => {
      const both = [
        { key: 'email-preferences', title: 'Your email notifications' },
        { key: 'notifications', title: 'Email delivery', admin: true },
      ];
      // FL-368: the account's own page is listed first, because every account has it.
      expect(sectionsForArea(both, 'notifications').map((s) => s.title)).toEqual([
        'Your email notifications',
        'Email delivery',
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
      expect(directoryGroup('care', 'deduplication')).toBe('identical_files');
      expect(directoryGroup('privacy', 'suppressed-content')).toBe('locked_content');
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
