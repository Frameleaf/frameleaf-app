import { CloudBackupBucketState } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudBackupSetupDialog from '$lib/components/frameleaf/cloud/CloudBackupSetupDialog.svelte';
import { createBackupKey } from '$lib/frameleaf/cloud-backup';
import en from '../../../../../../i18n/en.json';

const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils')>()),
  downloadBlob,
}));

describe('managed backup recovery authority', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => vi.clearAllMocks());

  const start = async () => {
    render(CloudBackupSetupDialog, {
      open: true,
      instanceId: 'f0000000-0000-4000-8000-000000000001',
      managedAvailable: true,
      onDone: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
  };
  const activate = async () => {
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_turn_on }));
    await waitFor(() => expect(sdkMock.setupCloudBackup).toHaveBeenCalledOnce());
    return JSON.parse(sdkMock.setupCloudBackup.mock.calls[0][0].cloudBackupSetupDto.key);
  };
  const checkRoots = (file: {
    key: string;
    client: { vaultId: string; current: number; keys: Record<string, string> };
  }) => {
    expect(file.client.vaultId).toBe('f0000000-0000-4000-8000-000000000001');
    expect(file.client.current).toBe(1);
    expect(atob(file.client.keys[1])).toHaveLength(32);
    expect(file.client.keys[1]).not.toBe(file.key);
  };

  it('puts the complete generated recovery kit into the local setup request', async () => {
    sdkMock.generateCloudBackupKey.mockResolvedValue({
      ...createBackupKey(),
      recoveryCode: 'FLRK-synthetic',
      createdAt: new Date().toISOString(),
    });
    await start();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
    const kit = (await screen.findByTestId('recovery-kit')).textContent!;
    checkRoots(JSON.parse(kit));
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_kit_saved }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
    expect(await activate()).toEqual(JSON.parse(kit));
  });

  it.each([true, false])('retains downloaded roots with a stored local copy=%s', async (stored) => {
    await start();
    await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_key_own) }));
    if (!stored) {
      await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_cloud_backup_keep_copy }));
      await fireEvent.input(screen.getByRole('textbox', { name: en.frameleaf_cloud_backup_acknowledge }), {
        target: { value: 'I understand' },
      });
    }
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_key_download }));
    const blob = downloadBlob.mock.calls[0][0] as Blob;
    const file = JSON.parse(await blob.text());
    checkRoots(file);
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_key_saved_elsewhere }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
    expect(await activate()).toEqual(file);
  });

  it('sends your own bucket the complete recovery file with client roots', async () => {
    sdkMock.checkCloudBackupBucket.mockResolvedValue({ ok: true, state: CloudBackupBucketState.Empty, message: 'Ok' });
    sdkMock.setupCloudBackup.mockResolvedValue({} as never);
    render(CloudBackupSetupDialog, {
      open: true,
      instanceId: 'f0000000-0000-4000-8000-000000000001',
      managedAvailable: true,
      onDone: vi.fn(),
    });
    await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_byo) }));
    for (const [label, value] of [
      [en.frameleaf_cloud_backup_endpoint, 'https://storage.example.test'],
      [en.frameleaf_cloud_backup_bucket, 'own-backup'],
      [en.frameleaf_cloud_backup_access_key, 'synthetic-access'],
      [en.frameleaf_cloud_backup_secret, 'synthetic-secret'],
    ]) {
      await fireEvent.input(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
    }
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_check }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
    await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_key_own) }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_key_download }));
    const file = JSON.parse(await (downloadBlob.mock.calls[0][0] as Blob).text());
    checkRoots(file);
    await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_key_saved_elsewhere }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_claim }));
    await waitFor(() => expect(sdkMock.setupCloudBackup).toHaveBeenCalledOnce());
    expect(JSON.parse(sdkMock.setupCloudBackup.mock.calls[0][0].cloudBackupSetupDto.key)).toEqual(file);
  });

  it.each(['generated', 'own'] as const)(
    'requires saving the new managed %s authority after changing destinations',
    async (choice) => {
      sdkMock.checkCloudBackupBucket.mockResolvedValue({
        ok: true,
        state: CloudBackupBucketState.Empty,
        message: 'Connected',
      });
      sdkMock.generateCloudBackupKey.mockResolvedValue({
        ...createBackupKey(),
        recoveryCode: 'FLRK-synthetic',
        createdAt: new Date().toISOString(),
      });
      render(CloudBackupSetupDialog, {
        open: true,
        instanceId: 'f0000000-0000-4000-8000-000000000001',
        managedAvailable: true,
        onDone: vi.fn(),
      });
      await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_byo) }));
      for (const [label, value] of [
        [en.frameleaf_cloud_backup_endpoint, 'https://storage.example.test'],
        [en.frameleaf_cloud_backup_bucket, 'own-backup'],
        [en.frameleaf_cloud_backup_access_key, 'synthetic-access'],
        [en.frameleaf_cloud_backup_secret, 'synthetic-secret'],
      ]) {
        await fireEvent.input(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });
      }
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_check }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue })).toBeEnabled(),
      );
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
      if (choice === 'own') {
        await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_key_own) }));
        await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_key_download }));
        await fireEvent.click(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_key_saved_elsewhere }));
      } else {
        await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
        await fireEvent.click(await screen.findByRole('checkbox', { name: en.frameleaf_cloud_backup_kit_saved }));
        await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_back }));
      }
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_back }));
      await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_cloud_backup_managed) }));
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
      if (choice === 'generated') {
        await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue }));
        checkRoots(JSON.parse((await screen.findByTestId('recovery-kit')).textContent!));
        expect(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_kit_saved })).not.toBeChecked();
      } else {
        expect(screen.getByRole('checkbox', { name: en.frameleaf_cloud_backup_key_saved_elsewhere })).not.toBeChecked();
      }
      expect(screen.getByRole('button', { name: en.frameleaf_cloud_backup_continue })).toBeDisabled();
      expect(sdkMock.setupCloudBackup).not.toHaveBeenCalled();
    },
  );
});
