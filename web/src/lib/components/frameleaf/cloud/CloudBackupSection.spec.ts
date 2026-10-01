import { CloudBackupKeyMode, type CloudBackupStatusResponseDto } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
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
    endpoint: 'https://s3.eu-central-1.wasabisys.com',
    region: 'eu-central-1',
    managed: {
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
});
