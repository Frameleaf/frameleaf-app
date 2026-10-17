import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackupOverview from '$lib/components/frameleaf/backup/BackupOverview.svelte';
import en from '../../../../../../i18n/en.json';

vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    status: { state: 'linked' },
    license: { entitlements: { cloudBackup: true } },
  },
}));

const GB = 1000 ** 3;
const recently = () => new Date(Date.now() - 3_600_000).toISOString();
const cloud = (patch: Record<string, unknown> = {}) =>
  ({
    configured: true,
    target: 'managed',
    keyMode: 'server',
    keyLoaded: true,
    activeRun: null,
    lastRun: null,
    lastSuccessAt: recently(),
    usage: null,
    managed: { readOnly: false, quotaBytes: 1024 * GB, allowanceBytes: 1024 * GB, usedBytes: 512 * GB },
    ...patch,
  }) as never;

describe('Backup › Overview (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getServerStatistics.mockResolvedValue({ photos: 10, videos: 2, usage: 3 * GB } as never);
    sdkMock.listDatabaseBackups.mockResolvedValue({ backups: [] });
    sdkMock.getBuddyBackupStatus.mockResolvedValue({ enabled: false, pairing: null, settings: null } as never);
    sdkMock.getCloudBackupStatus.mockResolvedValue({ configured: false } as never);
  });

  it('says there is no backup away from home and offers the two ways to start', async () => {
    render(BackupOverview);
    const status = await screen.findByRole('region', { name: 'Backup status' });
    expect(within(status).getByRole('heading', { name: en.frameleaf_backup_hero_none })).toBeInTheDocument();
    expect(within(status).getByText('12 items · 3 GB')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up Cloud Backup' })).toHaveAttribute(
      'href',
      '/user-settings?area=backups&section=cloud',
    );
    expect(screen.getByRole('link', { name: 'Set up Buddy Backup' })).toHaveAttribute(
      'href',
      '/user-settings?area=backups&section=buddy',
    );
    // Only the place that is in use is listed until another is set up.
    expect(screen.queryByRole('link', { name: 'Manage Cloud Backup' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage On this server' })).toBeInTheDocument();
  });

  it('lists a set-up place with its status, last backup and storage, and a place that is off', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(cloud());
    render(BackupOverview);
    expect(await screen.findByRole('heading', { name: en.frameleaf_backup_hero_ok })).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: 'Cloud Backup storage used' });
    expect(meter).toHaveAttribute('aria-valuenow', '50');
    expect(meter).toHaveAttribute('aria-valuetext', '512 GB of 1 TB');
    expect(screen.getByRole('link', { name: 'Manage Cloud Backup' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up Buddy Backup' })).toBeInTheDocument();
    // Nothing is lent until a buddy is paired.
    expect(screen.queryByRole('heading', { name: en.frameleaf_backup_lend_title })).toBeNull();
  });

  it('points at the backup that needs attention', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(cloud({ lastRun: { status: 'failed' } }));
    render(BackupOverview);
    expect(await screen.findByRole('heading', { name: 'One backup needs attention' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_backup_see_whats_wrong })).toHaveAttribute(
      'href',
      '/user-settings?area=backups&section=cloud',
    );
  });

  it('says which place could not be checked instead of calling it off', async () => {
    sdkMock.getCloudBackupStatus.mockRejectedValue(new Error('500'));
    render(BackupOverview);
    expect(await screen.findByRole('alert')).toHaveTextContent('Frameleaf couldn’t check Cloud Backup just now');
  });
});
