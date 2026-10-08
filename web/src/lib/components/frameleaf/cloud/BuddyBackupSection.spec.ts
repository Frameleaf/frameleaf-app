import { State, Version, EnvironmentKeys, type BuddyStatusDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import BuddyBackupSection from './BuddyBackupSection.svelte';

vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    status: { state: 'linked' },
    license: { entitlements: { cloudBackup: true } },
    listen: () => () => {},
  },
}));
vi.mock('$lib/stores/preferences.store', async () => ({ locale: (await import('svelte/store')).writable('en') }));
vi.mock('$lib/frameleaf/cloud-ml', () => ({ formatDateTime: (value: string) => value }));
vi.mock('$lib/frameleaf/settings-areas', () => ({ commandCenterUrl: () => '/user-settings' }));
vi.mock('$lib/utils/handle-error', () => ({ getServerErrorMessage: () => undefined }));
vi.mock('./BuddyRestoreSection.svelte', () => ({ default: () => {} }));

let status: BuddyStatusDto;
beforeEach(() => {
  vi.resetAllMocks();
  addMessages('dev', en);
  status = {
    enabled: true,
    configured: true,
    instanceId: 'source',
    settings: {
      directory: '/buddy',
      quotaBytes: 10 * 1024 ** 3,
      timezone: 'UTC',
      bootConfiguration: {
        version: Version.$1,
        environmentKeys: [EnvironmentKeys.DbPassword, EnvironmentKeys.FrameleafPort],
      },
    },
    pairing: { version: 1, pairId: 'pair', state: State.Active, readUntil: null, vaults: [] },
    recoveryVerified: false,
    keyFingerprint: null,
    lastCompleteAt: null,
    lastVerifiedAt: null,
    run: null,
    connection: null,
    transferMbps: 0,
    pendingObjects: 0,
    availableBytes: null,
    capacityUpdatedAt: null,
    hosting: { committedBytes: 0, reservedBytes: 0, quotaBytes: 10 * 1024 ** 3 },
  };
  sdkMock.getBuddyBackupStatus.mockResolvedValue(status);
  sdkMock.configureBuddyBackup.mockImplementation(async ({ buddySettingsDto }) => ({
    ...status,
    settings: buddySettingsDto,
  }));
  sdkMock.checkBuddyBackupCoverage.mockResolvedValue({
    items: 0,
    originalBytes: 0,
    unknownSizes: 0,
    databaseBytes: 0,
    stagingAvailableBytes: 10 * 1024 ** 3,
    hostingAvailableBytes: 10 * 1024 ** 3,
    timezone: 'UTC',
    mounts: [],
    configurationFiles: [],
  });
});

const settings = async () => {
  render(BuddyBackupSection, { view: 'controls' });
  await fireEvent.click(await screen.findByRole('button', { name: en.frameleaf_buddy_hosting_transfer_settings }));
  return within(screen.getByRole('dialog', { name: en.frameleaf_buddy_hosting_transfer_settings }));
};

it('preserves declared deployment settings and secrets when hosting settings are saved', async () => {
  const dialog = await settings();
  await fireEvent.click(dialog.getByRole('button', { name: en.frameleaf_buddy_save_hosting_settings }));
  await waitFor(() =>
    expect(sdkMock.configureBuddyBackup).toHaveBeenCalledWith({
      buddySettingsDto: expect.objectContaining({
        bootConfiguration: { version: 1, environmentKeys: ['DB_PASSWORD', 'FRAMELEAF_PORT'] },
      }),
    }),
  );
});

it('submits only selected variable names and allows declaration capture to be removed', async () => {
  const dialog = await settings();
  const select = dialog.getByRole('listbox', { name: 'Deployment settings and secrets' }) as HTMLSelectElement;
  for (const option of select.options) {
    option.selected = option.value === 'FRAMELEAF_HOST';
  }
  await fireEvent.change(select);
  await fireEvent.click(dialog.getByRole('button', { name: en.frameleaf_buddy_save_hosting_settings }));
  await waitFor(() =>
    expect(sdkMock.configureBuddyBackup).toHaveBeenCalledWith({
      buddySettingsDto: expect.objectContaining({
        bootConfiguration: { version: 1, environmentKeys: ['FRAMELEAF_HOST'] },
      }),
    }),
  );
  await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_buddy_hosting_transfer_settings }));
  const reopened = within(screen.getByRole('dialog', { name: en.frameleaf_buddy_hosting_transfer_settings }));
  const empty = reopened.getByRole('listbox', { name: 'Deployment settings and secrets' }) as HTMLSelectElement;
  for (const option of empty.options) {
    option.selected = false;
  }
  await fireEvent.change(empty);
  await fireEvent.click(reopened.getByRole('button', { name: en.frameleaf_buddy_save_hosting_settings }));
  await waitFor(() => expect(sdkMock.configureBuddyBackup).toHaveBeenCalledTimes(2));
  expect(sdkMock.configureBuddyBackup.mock.calls[1][0].buddySettingsDto).not.toHaveProperty('bootConfiguration');
});

it('shows a plain failure with Try again when the status does not load, never the transport error', async () => {
  sdkMock.getBuddyBackupStatus.mockRejectedValueOnce(
    new Error('Expected a JSON response (http://127.0.0.1/api/admin/buddy-backup, HTTP 502, content-type: text/plain)'),
  );
  const { container } = render(BuddyBackupSection, { view: 'status' });
  // a placeholder in the shape of the page while the first read is out
  expect(container.querySelector('.buddy-loading[aria-busy="true"] .fl-skeleton')).not.toBeNull();
  const failure = await screen.findByRole('alert');
  expect(failure).toHaveTextContent(en.frameleaf_buddy_status_not_loaded);
  expect(container).not.toHaveTextContent(/JSON|HTTP 502/);
  expect(container.querySelector('.buddy-loading')).toBeNull();
  expect(screen.queryByText(en.frameleaf_buddy_loading_buddy_backup)).toBeNull();

  await fireEvent.click(within(failure).getByRole('button', { name: en.frameleaf_error_retry }));
  expect(await screen.findByText(en.frameleaf_buddy_my_backup)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});
