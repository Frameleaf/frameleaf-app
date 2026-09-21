import { getAboutInfo, getStorage, getVersionHistory } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
import en from '../../../../../i18n/en.json';
import SettingsOverview from './SettingsOverview.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'actor', isAdmin: false, quotaUsageInBytes: 1024, quotaSizeInBytes: 4096 } },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: { trash: true } } }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getStorage: vi.fn(),
  getAboutInfo: vi.fn(),
  getVersionHistory: vi.fn(),
}));

const storage = {
  diskAvailable: '',
  diskAvailableRaw: 8192,
  diskSize: '',
  diskSizeRaw: 16_384,
  diskUsagePercentage: 50,
  diskUse: '',
  diskUseRaw: 8192,
};
const about = { version: 'v3.2.0', versionUrl: '', build: 'frameleaf-test-build', licensed: false };

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  authManager.user.isAdmin = false;
  authManager.user.quotaSizeInBytes = 4096;
  authManager.user.quotaUsageInBytes = 1024;
  featureFlagsManager.value.trash = true;
  vi.mocked(getStorage).mockResolvedValue(storage);
  vi.mocked(getAboutInfo).mockResolvedValue(about);
  vi.mocked(getVersionHistory).mockResolvedValue([]);
});

it('shows distinct account and filesystem values and the real server build', async () => {
  render(SettingsOverview);
  expect(await screen.findByText('frameleaf-test-build', { exact: false })).toBeInTheDocument();
  const account = screen.getByRole('region', { name: 'Your account storage' });
  const filesystem = screen.getByRole('region', { name: 'Server filesystem' });
  expect(within(account).getByText('1 KiB used of 4 KiB')).toBeInTheDocument();
  expect(within(filesystem).getByText('8 KiB used of 16 KiB')).toBeInTheDocument();
  expect(screen.getByText('v3.2.0')).toBeInTheDocument();
  expect(getVersionHistory).not.toHaveBeenCalled();
});

it('preserves successful version data when storage fails and retries the real request', async () => {
  vi.mocked(getStorage).mockRejectedValueOnce(new Error('unavailable'));
  render(SettingsOverview);
  expect(await screen.findByText(en.frameleaf_settings_overview.unavailable)).toBeInTheDocument();
  expect(screen.getByText('v3.2.0')).toBeInTheDocument();
  expect(screen.queryByText('0 B')).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('8 KiB used of 16 KiB')).toBeInTheDocument();
  expect(getStorage).toHaveBeenCalledTimes(2);
});

it('keeps no quota distinct from zero capacity and does not expose administrator utilities', async () => {
  authManager.user.quotaSizeInBytes = null;
  render(SettingsOverview);
  expect(screen.getByText('No account quota')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Review missing media' })).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Review corrupt media' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Review duplicates' })).toHaveAttribute('href', '/utilities/duplicates');
  expect(screen.getByRole('link', { name: 'Review large files' })).toHaveAttribute('href', '/utilities/large-files');
  expect(screen.getByRole('link', { name: en.relink_live_photos })).toHaveAttribute('href', '/utilities/live-photos');
  await screen.findByText('v3.2.0');
});

it('retains administrator utility actions and respects the Trash capability', async () => {
  authManager.user.isAdmin = true;
  featureFlagsManager.value.trash = false;
  render(SettingsOverview);
  expect(screen.getByRole('link', { name: 'Review missing media' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /Trash/ })).not.toBeInTheDocument();
  await screen.findByText('v3.2.0');
});

it('opens the existing About action with real history and recovers from a failed history request', async () => {
  const show = vi.spyOn(modalManager, 'show').mockImplementation(() => new Promise<never>(() => {}));
  vi.mocked(getVersionHistory).mockRejectedValueOnce(new Error('unavailable'));
  render(SettingsOverview);
  await fireEvent.click(await screen.findByRole('button', { name: 'About' }));
  expect(await screen.findByText(en.frameleaf_settings_overview.history_error)).toBeInTheDocument();
  expect(show).not.toHaveBeenCalled();
  await fireEvent.click(screen.getByRole('button', { name: 'About' }));
  await waitFor(() => expect(show).toHaveBeenCalledWith(expect.anything(), { info: about, versions: [] }));
  show.mockRestore();
});

it('shows unknown account usage without manufacturing a zero value', async () => {
  authManager.user.quotaUsageInBytes = null;
  render(SettingsOverview);
  const account = screen.getByRole('region', { name: 'Your account storage' });
  expect(within(account).getByText('Unknown')).toBeInTheDocument();
  expect(within(account).queryByText('0 B')).not.toBeInTheDocument();
  await screen.findByText('v3.2.0');
});

it('does not open a pending About dialog after rollout unmounts the overview', async () => {
  let finish!: (value: []) => void;
  vi.mocked(getVersionHistory).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const show = vi.spyOn(modalManager, 'show').mockImplementation(() => new Promise<never>(() => {}));
  const view = render(SettingsOverview);
  await fireEvent.click(await screen.findByRole('button', { name: 'About' }));
  view.unmount();
  finish([]);
  await Promise.resolve();
  expect(show).not.toHaveBeenCalled();
  show.mockRestore();
});
