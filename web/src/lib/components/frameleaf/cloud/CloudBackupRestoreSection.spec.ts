import {
  CloudBackupAlbumState,
  CloudBackupItemState,
  CloudBackupKeyMode,
  CloudBackupManifestStatus,
  CloudBackupRestoreDetails,
  CloudBackupRestoreScope,
  CloudBackupRestoreStatus,
  type CloudBackupManifestItemDto,
  type CloudBackupStatusResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudBackupRestoreSection from './CloudBackupRestoreSection.svelte';

const MANIFEST_KEY = 'm/20260926T030000Z.json.gz';
const ALBUM_ID = '5b0c4e8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d';

const status = (overrides: Partial<CloudBackupStatusResponseDto> = {}) =>
  ({
    configured: true,
    keyMode: CloudBackupKeyMode.Server,
    keyLoaded: true,
    keyFingerprint: '0B2A-E445',
    activeRun: null,
    activeRestore: null,
    lastRestore: null,
    ...overrides,
  }) as unknown as CloudBackupStatusResponseDto;

const item = (overrides: Partial<CloudBackupManifestItemDto> = {}): CloudBackupManifestItemDto => ({
  assetId: '8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1',
  name: 'Elk.jpg',
  locked: false,
  ownerId: 'owner-1',
  ownerName: 'Taylor',
  files: 1,
  bytes: 5_100_000,
  modifiedAt: '2026-08-14T09:12:00.000Z',
  state: CloudBackupItemState.Active,
  hasDetails: true,
  ...overrides,
});

const renderSection = (overrides: Partial<CloudBackupStatusResponseDto> = {}) => {
  const onStatus = vi.fn();
  render(CloudBackupRestoreSection, {
    props: { status: status(overrides), formatWhen: (value: string | null | undefined) => value ?? '—', onStatus },
  });
  return { onStatus };
};

describe('CloudBackupRestoreSection (FL-164)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getCloudBackupManifests.mockResolvedValue({
      manifests: [
        {
          key: MANIFEST_KEY,
          status: CloudBackupManifestStatus.Complete,
          createdAt: '2026-09-26T03:00:00.000Z',
          finishedAt: null,
          assets: 2,
          files: 2,
          bytes: 8_300_000,
          databaseKey: null,
        },
      ],
    });
    sdkMock.searchCloudBackupManifestItems.mockResolvedValue({ manifestKey: MANIFEST_KEY, total: 0, items: [] });
    sdkMock.restoreCloudBackup.mockResolvedValue(status());
  });

  it('brings a deleted item back as it was when the backup holds its details', async () => {
    sdkMock.searchCloudBackupManifestItems.mockResolvedValue({
      manifestKey: MANIFEST_KEY,
      total: 2,
      items: [
        item({ state: CloudBackupItemState.Deleted }),
        item({
          assetId: '1d7c9e02-5b1a-4c3e-9f7d-2a6b8c0d1e2f',
          name: 'Old.jpg',
          state: CloudBackupItemState.Deleted,
          hasDetails: false,
        }),
      ],
    });
    renderSection();

    const rows = await screen.findAllByRole('row');
    await fireEvent.click(within(rows[1]).getByRole('button', { name: /Restore/ }));
    await waitFor(() =>
      expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
        cloudBackupRestoreDto: {
          manifestKey: MANIFEST_KEY,
          scope: CloudBackupRestoreScope.Asset,
          assetIds: ['8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1'],
        },
      }),
    );

    // a backup made before details were recorded brings the file back for Library Care
    await fireEvent.click(within(rows[2]).getByRole('button', { name: /Restore/ }));
    await waitFor(() =>
      expect(sdkMock.restoreCloudBackup).toHaveBeenLastCalledWith({
        cloudBackupRestoreDto: {
          manifestKey: MANIFEST_KEY,
          scope: CloudBackupRestoreScope.Files,
          assetIds: ['1d7c9e02-5b1a-4c3e-9f7d-2a6b8c0d1e2f'],
        },
      }),
    );
  });

  it('asks how an item still in the library gets its details back, keeping them by default', async () => {
    sdkMock.searchCloudBackupManifestItems.mockResolvedValue({ manifestKey: MANIFEST_KEY, total: 1, items: [item()] });
    renderSection();

    await fireEvent.click(await screen.findByRole('button', { name: /Restore…/ }));
    const dialog = await screen.findByRole('dialog');
    const details = within(dialog).getByRole('group', { name: 'Details' });
    expect(within(details).getByRole('radio', { name: /Keep current details/ })).toBeChecked();
    expect(within(details).getByText(/Only the file comes back/)).toBeInTheDocument();
    await fireEvent.click(within(details).getByRole('radio', { name: /Fill in missing details/ }));
    await fireEvent.click(within(dialog).getByRole('button', { name: /^Restore$/ }));

    await waitFor(() =>
      expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
        cloudBackupRestoreDto: {
          manifestKey: MANIFEST_KEY,
          scope: CloudBackupRestoreScope.Asset,
          assetIds: ['8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1'],
          details: CloudBackupRestoreDetails.Fill,
        },
      }),
    );
  });

  it('lists deleted albums and albums missing items, and restores or repairs one', async () => {
    sdkMock.listCloudBackupManifestAlbums.mockResolvedValue({
      manifestKey: MANIFEST_KEY,
      hasDetails: true,
      albums: [
        {
          albumId: ALBUM_ID,
          name: 'Lake house weekend',
          ownerId: 'owner-1',
          ownerName: 'Taylor',
          items: 84,
          missing: 84,
          state: CloudBackupAlbumState.Deleted,
        },
        {
          albumId: '0f0d1e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
          name: 'Moraine Lake',
          ownerId: 'owner-1',
          ownerName: 'Taylor',
          items: 212,
          missing: 3,
          state: CloudBackupAlbumState.MissingItems,
        },
      ],
    });
    renderSection();

    await fireEvent.click(await screen.findByRole('radio', { name: 'Albums' }));
    expect(await screen.findByText('Lake house weekend')).toBeInTheDocument();
    expect(screen.getByText('84 items')).toBeInTheDocument();
    expect(screen.getByText('3 items missing')).toBeInTheDocument();
    expect(sdkMock.listCloudBackupManifestAlbums).toHaveBeenCalledWith({
      cloudBackupManifestAlbumsDto: { manifestKey: MANIFEST_KEY },
    });

    await fireEvent.click(screen.getByRole('button', { name: /Restore album/ }));
    await waitFor(() =>
      expect(sdkMock.restoreCloudBackup).toHaveBeenCalledWith({
        cloudBackupRestoreDto: { manifestKey: MANIFEST_KEY, scope: CloudBackupRestoreScope.Album, albumId: ALBUM_ID },
      }),
    );
    await fireEvent.click(screen.getByRole('button', { name: /Repair album/ }));
    await waitFor(() =>
      expect(sdkMock.restoreCloudBackup).toHaveBeenLastCalledWith({
        cloudBackupRestoreDto: {
          manifestKey: MANIFEST_KEY,
          scope: CloudBackupRestoreScope.Album,
          albumId: '0f0d1e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
        },
      }),
    );
  });

  it('asks for a newer backup when this one was made before albums were recorded', async () => {
    sdkMock.listCloudBackupManifestAlbums.mockResolvedValue({
      manifestKey: MANIFEST_KEY,
      hasDetails: false,
      albums: [],
    });
    renderSection();

    await fireEvent.click(await screen.findByRole('radio', { name: 'Albums' }));
    expect(await screen.findByText(/made before albums were recorded/)).toBeInTheDocument();
  });

  it('says how many deleted items came back and whose details were put back', async () => {
    renderSection({
      lastRestore: {
        operationId: 'restore-1',
        scope: CloudBackupRestoreScope.Album,
        manifestKey: MANIFEST_KEY,
        status: CloudBackupRestoreStatus.Completed,
        at: '2026-09-26T04:00:00.000Z',
        files: 3,
        bytes: 300,
        skipped: 0,
        replaced: 0,
        destination: null,
        databaseFile: null,
        recreated: 2,
        detailsRestored: 1,
        error: null,
      },
    });

    expect(await screen.findByText(/2 deleted items came back with their details/)).toBeInTheDocument();
    expect(screen.getByText(/Details came back for 1 item/)).toBeInTheDocument();
  });
});
