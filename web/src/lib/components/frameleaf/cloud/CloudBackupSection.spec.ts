import { CloudBackupKeyMode, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import CloudBackupSection from './CloudBackupSection.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn(), getServerErrorMessage: vi.fn() }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', () => ({ getSystemConfigDraft: () => undefined }));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    status: { state: 'linked', instanceId: 'instance-1' },
    license: { entitlements: { cloudBackup: true } },
  },
}));

const status = (readOnly: boolean, readOnlyReason: string | null) =>
  ({
    configured: true,
    target: 'managed',
    keyMode: CloudBackupKeyMode.Server,
    keyLoaded: true,
    keyFingerprint: '0B2A-E445',
    activeRun: null,
    activeRestore: null,
    lastRestore: null,
    lastRun: null,
    lastSuccessAt: null,
    lastVerify: null,
    usage: null,
    escrow: { stored: false },
    managedAvailable: true,
    bucket: 'fl-eu-0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53',
    endpoint: 'https://s3.eu-central-1.backup.frameleaf.cloud',
    region: 'eu-central-1',
    managed: {
      storageId: '0194b445-9c8a-7001-8000-000000000002',
      location: {
        locationId: 'loc-07',
        cityId: 'amsterdam',
        city: 'Amsterdam',
        country: 'Netherlands',
        countryCode: 'NL',
      },
      readOnly,
      readOnlyReason,
      quotaBytes: 1_000_000_000_000,
      usedBytes: null,
      objects: null,
      allowanceBytes: null,
      extraBlocks: null,
      checkedAt: '2026-10-01T12:00:00.000Z',
      refusal: null,
    },
  }) as unknown as CloudBackupStatusResponseDto;

describe('CloudBackupSection read-only storage (FL-301)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says backups are paused because the plan is full', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(status(true, 'plan_full'));
    render(CloudBackupSection);

    expect(await screen.findByText('Backup paused: plan full')).toBeInTheDocument();
    expect(screen.queryByText('Backups are read-only')).not.toBeInTheDocument();
  });

  it('words a read-only reason it does not know generically', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(status(true, 'something_new'));
    render(CloudBackupSection);

    expect(await screen.findByText('Backups are read-only')).toBeInTheDocument();
    expect(screen.queryByText('Backup paused: plan full')).not.toBeInTheDocument();
  });

  it('shows no pause once the storage is writable again', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(status(false, null));
    render(CloudBackupSection);

    await vi.waitFor(() => expect(sdkMock.getCloudBackupStatus).toHaveBeenCalled());
    expect(screen.queryByText('Backup paused: plan full')).not.toBeInTheDocument();
    expect(screen.queryByText('Backups are read-only')).not.toBeInTheDocument();
  });

  it('shows the selected city and country instead of a physical region or connection hostname', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue(status(false, null));
    render(CloudBackupSection);

    expect(await screen.findByText('Amsterdam, Netherlands')).toBeInTheDocument();
    expect(screen.getByText('Stored in')).toBeInTheDocument();
    expect(screen.queryByText('eu-central-1')).not.toBeInTheDocument();
    expect(screen.queryByText('s3.eu-central-1.backup.frameleaf.cloud')).not.toBeInTheDocument();
  });
});

describe('CloudBackupSection key unlock', () => {
  beforeAll(() => {
    addMessages('dev', en);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  it('keeps no backup key once the unlock dialog is closed', async () => {
    sdkMock.getCloudBackupStatus.mockResolvedValue({
      ...status(false, null),
      keyMode: CloudBackupKeyMode.OwnMemory,
      keyLoaded: false,
    } as CloudBackupStatusResponseDto);
    render(CloudBackupSection);

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_cloud_backup_unlock }));
    const field = screen.getByLabelText(en.frameleaf_cloud_backup_paste_key);
    await fireEvent.input(field, { target: { value: 'secret-backup-key' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_cancel }));
    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_cloud_backup_unlock })[0]);

    expect(screen.getByLabelText(en.frameleaf_cloud_backup_paste_key)).toHaveValue('');
  });
});

describe('CloudBackupSection setup', () => {
  beforeAll(() => {
    addMessages('dev', en);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  it('reads the status again however the setup dialog is closed', async () => {
    // A bucket claimed in the dialog and then closed with Close (not Done) must not leave the page
    // saying cloud backup is not set up.
    sdkMock.getCloudBackupStatus.mockResolvedValue({
      ...status(false, null),
      configured: false,
    } as CloudBackupStatusResponseDto);
    render(CloudBackupSection);

    await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_cloud_backup_set_up }));
    expect(sdkMock.getCloudBackupStatus).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole('button', { name: en.close }));

    await vi.waitFor(() => expect(sdkMock.getCloudBackupStatus).toHaveBeenCalledTimes(2));
  });
});
