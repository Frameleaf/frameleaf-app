import { State as BuddyPairingState } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import BackupSummary from './BackupSummary.svelte';

const state = vi.hoisted(() => ({
  user: { isAdmin: true },
  getBuddyBackupStatus: vi.fn(),
  getCloudBackupStatus: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getBuddyBackupStatus: state.getBuddyBackupStatus,
  getCloudBackupStatus: state.getCloudBackupStatus,
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return state.user;
    },
  },
}));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    status: { state: 'linked' },
    license: { entitlements: { cloudBackup: false } },
  },
}));

describe('Backup operational summary', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.user = { isAdmin: true };
    state.getBuddyBackupStatus.mockReset().mockResolvedValue({
      enabled: true,
      configured: true,
      pairing: { state: BuddyPairingState.Active },
      recoveryVerified: true,
      keyFingerprint: 'key',
      settings: { pausedSending: false, pausedReceiving: false },
      lastCompleteAt: null,
      lastVerifiedAt: null,
      connection: null,
      transferMbps: 0,
      hosting: { committedBytes: 1024, reservedBytes: 128, quotaBytes: 4096 },
    });
    state.getCloudBackupStatus.mockReset().mockResolvedValue({ configured: false, usage: null });
  });

  it('shows both encrypted directions after expiry, and replaces stale values when refresh fails', async () => {
    render(BackupSummary, { analytics: true });
    const outgoing = await screen.findByRole('link', { name: /My backup · outgoing.*Recovery only/ });
    expect(outgoing).toHaveAttribute('href', '/user-settings?area=backups&backupView=status');
    expect(screen.getByRole('link', { name: /Hosting for my buddy · incoming.*Recovery only/ })).toHaveAttribute(
      'href',
      '/user-settings?area=backups&backupView=controls',
    );
    expect(screen.getByText(/Independent of the library filters/)).toBeInTheDocument();
    expect(screen.getByText(/Hosting is encrypted storage only/)).toBeInTheDocument();
    state.getBuddyBackupStatus.mockRejectedValue(new Error('offline'));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('link', { name: /My backup · outgoing/ })).not.toHaveTextContent('Recovery only');
  });

  it('does not request server-wide status for an ordinary account', () => {
    state.user = { isAdmin: false };
    render(BackupSummary);
    expect(screen.queryByRole('region', { name: 'Backup & hosting' })).not.toBeInTheDocument();
    expect(state.getBuddyBackupStatus).not.toHaveBeenCalled();
    expect(state.getCloudBackupStatus).not.toHaveBeenCalled();
  });
});
