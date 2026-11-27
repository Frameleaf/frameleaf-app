import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import MaintenanceBackupList from './MaintenanceBackupList.svelte';

// FL-1810: a list that reads itself never says "No backups yet" before, or instead of, an answer.
describe('MaintenanceBackupList', () => {
  beforeEach(() => {
    addMessages('dev', en);
    vi.resetAllMocks();
  });

  it('says nothing about backups while reading, then that there are none', async () => {
    let answer: (value: { backups: never[] }) => void = () => {};
    sdkMock.listDatabaseBackups.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    render(MaintenanceBackupList, { expectedVersion: '1.0.0' });

    expect(screen.queryByText(en.admin.frameleaf_maintenance_backups_empty)).toBeNull();
    answer({ backups: [] });
    expect(await screen.findByText(en.admin.frameleaf_maintenance_backups_empty)).toBeInTheDocument();
  });

  it('says a failed read in place with Try again, not "No backups yet"', async () => {
    sdkMock.listDatabaseBackups.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ backups: [] });
    render(MaintenanceBackupList, { expectedVersion: '1.0.0' });

    expect(await screen.findByTestId('frameleaf-inline-error')).toBeInTheDocument();
    expect(screen.queryByText(en.admin.frameleaf_maintenance_backups_empty)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_error_retry }));
    expect(await screen.findByText(en.admin.frameleaf_maintenance_backups_empty)).toBeInTheDocument();
  });
});
