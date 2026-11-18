import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BackupRestore from '$lib/components/frameleaf/backup/BackupRestore.svelte';
import en from '../../../../../../i18n/en.json';

const state = vi.hoisted(() => ({ url: new URL('http://localhost/settings?area=backups&section=restore') }));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto }));
// The restore tools below the page have their own specs.
vi.mock('$lib/components/frameleaf/backup/RestoreDrillCard.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/cloud/CloudBackupRestoreSection.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/cloud/BuddyBackupSection.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/MaintenanceRestoreTest.svelte', () => ({ default: () => {} }));

const today = new Date();
today.setHours(2, 29, 0, 0);

describe('Backup › Restore: files or folders (FL-1666)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
    state.url = new URL('http://localhost/settings?area=backups&section=restore');
    sdkMock.getBuddyBackupStatus.mockResolvedValue({ enabled: false, pairing: null } as never);
    sdkMock.listDatabaseBackups.mockResolvedValue({ backups: [] } as never);
    sdkMock.getCloudBackupManifests.mockResolvedValue({
      manifests: [{ key: 'today', createdAt: today.toISOString() }],
    } as never);
    sdkMock.browseCloudBackup.mockResolvedValue({ path: '/', total: 0, entries: [], hiddenLocked: 0 } as never);
  });

  it('greys "Files or folders" without Cloud Backup', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue({ configured: false } as never);
    render(BackupRestore);
    const choice = await screen.findByRole('button', { name: /^Files or folders, as they were stored/ });
    expect(choice).toBeDisabled();
    expect(choice).toHaveTextContent('Needs Cloud Backup.');
    expect(screen.queryByRole('button', { name: /^Browse the files/ })).toBeNull();
  });

  it('opens the browse from the choice and from a date with a Cloud Backup', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue({ configured: true } as never);
    render(BackupRestore);
    const choice = await screen.findByRole('link', { name: /^Files or folders, as they were stored/ });
    expect(choice.getAttribute('href')).toContain('browse=');

    await fireEvent.click(await screen.findByRole('button', { name: /^Browse the files in the backup of Today/ }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('browse=today'));
  });

  it('shows the browse in place of the page while one is open', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue({ configured: true } as never);
    state.url = new URL('http://localhost/settings?area=backups&section=restore&browse=today');
    render(BackupRestore);
    expect(await screen.findByRole('region', { name: 'Restore files or folders' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: en.frameleaf_backup_restore_what })).toBeNull();
    expect(sdkMock.browseCloudBackup).toHaveBeenCalledWith({
      cloudBackupBrowseDto: { manifestKey: 'today', path: '/', offset: 0, limit: 200 },
    });
  });
});
