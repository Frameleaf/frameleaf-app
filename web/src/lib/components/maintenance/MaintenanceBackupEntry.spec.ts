import { fireEvent, screen } from '@testing-library/svelte';
import { DateTime } from 'luxon';
import { addMessages } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { locale } from '$lib/stores/preferences.store';
import { renderWithTooltips } from '$tests/helpers';
import en from '../../../../../i18n/en.json';
import MaintenanceBackupEntry from './MaintenanceBackupEntry.svelte';

const restoreDatabaseBackup = vi.fn();

vi.mock('$lib/services/database-backups.service', () => ({
  getDatabaseBackupActions: () => ({
    Download: { type: 'command', title: 'Download', onAction: vi.fn() },
    Delete: { type: 'command', title: 'Delete', onAction: vi.fn() },
  }),
  restoreDatabaseBackup: (...args: unknown[]) => restoreDatabaseBackup(...args),
}));

describe('MaintenanceBackupEntry', () => {
  beforeAll(() => {
    // The assertions read the English copy the administrator sees.
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T12:00:00Z'));
    locale.set('en');
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreDatabaseBackup.mockClear();
  });

  it('renders relative backup time using the user timezone instead of UTC', () => {
    const backupTimestamp = '20260324T110000';

    const expectedRelativeTime = DateTime.fromFormat(backupTimestamp, "yyyyMMdd'T'HHmmss", {
      zone: 'Asia/Tokyo',
    })
      .toLocal()
      .toRelative({ locale: 'en' });

    const utcRelativeTime = DateTime.fromFormat(backupTimestamp, "yyyyMMdd'T'HHmmss", {
      zone: 'UTC',
    })
      .toLocal()
      .toRelative({ locale: 'en' });

    expect(expectedRelativeTime).toBeTruthy();
    expect(expectedRelativeTime).not.toEqual(utcRelativeTime);

    renderWithTooltips(MaintenanceBackupEntry, {
      expectedVersion: '1.2.3',
      filename: 'immich-db-backup-20260324T110000-v1.2.3-snapshot.sql.gz',
      filesize: 1024,
      timezone: 'Asia/Tokyo',
    });

    expect(screen.getByText(expectedRelativeTime!)).toBeInTheDocument();
  });

  it('opens the typed-confirmation dialog instead of restoring immediately', async () => {
    renderWithTooltips(MaintenanceBackupEntry, {
      expectedVersion: '1.2.3',
      filename: 'immich-db-backup-20260324T110000-v1.2.3-snapshot.sql.gz',
      filesize: 1024,
      timezone: 'UTC',
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    // The restore does not run until the administrator types RESTORE in the dialog.
    expect(restoreDatabaseBackup).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Restore this backup?' })).toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Restore backup' });
    expect(confirmButton).toBeDisabled();

    await fireEvent.input(screen.getByLabelText('Type RESTORE to confirm'), { target: { value: 'RESTORE' } });
    expect(confirmButton).toBeEnabled();

    await fireEvent.click(confirmButton);

    // The template's "Create a safety backup of the current database first" is off by default.
    expect(restoreDatabaseBackup).toHaveBeenCalledWith('immich-db-backup-20260324T110000-v1.2.3-snapshot.sql.gz', {
      keepSafetyBackup: false,
    });
  });

  it('shows what a restore changes and keeps the safety backup when asked', async () => {
    renderWithTooltips(MaintenanceBackupEntry, {
      expectedVersion: '1.2.3',
      filename: 'restore-point-immich-db-backup-20260324T110000-v1.2.3-pg14.sql.gz',
      filesize: 1024,
      timezone: 'UTC',
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(screen.getByText(/^Before restore backup from .+ · 1 KiB$/)).toBeInTheDocument();
    expect(screen.getByText('Original files on disk are not touched.')).toBeInTheDocument();
    expect(screen.getByText(/The restore runs in 4 steps/)).toBeInTheDocument();

    const backupFirst = screen.getByRole('checkbox', { name: 'Create a safety backup of the current database first' });
    expect(backupFirst).not.toBeChecked();
    await fireEvent.click(backupFirst);

    await fireEvent.input(screen.getByLabelText('Type RESTORE to confirm'), { target: { value: 'RESTORE' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Restore backup' }));

    expect(restoreDatabaseBackup).toHaveBeenCalledWith(
      'restore-point-immich-db-backup-20260324T110000-v1.2.3-pg14.sql.gz',
      { keepSafetyBackup: true },
    );
  });
});
