import { AnalyticsScopeKind, AnalyticsVolumePart, type AnalyticsVolumeBreakdownDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import { formatBytes } from '$lib/frameleaf/physical-dedup';
import en from '../../../../../../i18n/en.json';
import CommandCenterOverview from './CommandCenterOverview.svelte';

const state = vi.hoisted(() => ({ url: new URL('http://localhost/user-settings?area=overview') }));
const sdk = vi.hoisted(() => ({
  getAnalyticsReport: vi.fn(),
  getAboutInfo: vi.fn(),
  getStorage: vi.fn(),
  getQueues: vi.fn(),
  listDatabaseBackups: vi.fn(),
  getBackupRestoreVerification: vi.fn(),
  getRenderWorkerCompatibility: vi.fn(),
  listMlDestinations: vi.fn(),
  getMlWorkloadRoutes: vi.fn(),
  getBuddyBackupStatus: vi.fn().mockRejectedValue(new Error('not read')),
  getCloudBackupStatus: vi.fn().mockRejectedValue(new Error('not read')),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { isAdmin: true } } }));
const cloud = vi.hoisted(() => ({ status: null as unknown, license: null as unknown }));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: {
    listen: () => () => {},
    get status() {
      return cloud.status;
    },
    get license() {
      return cloud.license;
    },
  },
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('$lib/components/frameleaf/analytics/AnalyticsChart.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

describe('Command Center measured Overview', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.url = new SvelteURL('http://localhost/user-settings?area=overview');
    cloud.status = null;
    cloud.license = null;
    sdk.getAnalyticsReport.mockReset().mockResolvedValue(analyticsReportFixture());
    sdk.getAboutInfo.mockResolvedValue({ version: '3.2.0', licensed: false });
    sdk.getStorage.mockResolvedValue({
      diskUse: '60 GiB',
      diskSize: '100 GiB',
      diskAvailable: '40 GiB',
      diskUseRaw: 60,
      diskSizeRaw: 100,
      diskUsagePercentage: 60,
    });
    sdk.getQueues.mockResolvedValue([
      { name: 'thumbnailGeneration', statistics: { active: 2, waiting: 3, failed: 4 } },
    ]);
    sdk.getBackupRestoreVerification.mockReset().mockRejectedValue(new Error('not read'));
    sdk.getRenderWorkerCompatibility.mockReset().mockRejectedValue(new Error('not read'));
    sdk.listMlDestinations.mockReset().mockRejectedValue(new Error('not read'));
    sdk.getMlWorkloadRoutes.mockReset().mockRejectedValue(new Error('not read'));
    sdk.listDatabaseBackups.mockResolvedValue({
      backups: [
        { filename: 'z-immich-db-backup-20260921T120000-v3.sql.gz' },
        { filename: 'immich-db-backup-20260923T120000-v3.sql.gz' },
      ],
    });
  });
  it('renders real inventory and storage, sorts backup dates independently of filename prefixes, and labels absent telemetry', async () => {
    render(CommandCenterOverview);
    await screen.findByRole('link', { name: /All accounts.*100/ });
    expect(screen.getByText('60 GiB')).toBeInTheDocument();
    expect(screen.getByText('3.2.0')).toBeInTheDocument();
    // The latest backup reads as a time and a date; its file name is the tooltip (design review finding 77).
    const latest = screen.getByTitle('immich-db-backup-20260923T120000-v3.sql.gz');
    expect(latest).toHaveTextContent(/12:00/);
    expect(latest).toHaveTextContent(/23/);
    expect(screen.queryByTitle('z-immich-db-backup-20260921T120000-v3.sql.gz')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review failed jobs/ })).toHaveAttribute(
      'href',
      '/user-settings?area=processing&section=queues',
    );
    // The latest backup opens Backup → Backups & restore (finding 66), the ML endpoint Compute & jobs.
    expect(screen.getByRole('link', { name: /Latest database backup/ })).toHaveAttribute(
      'href',
      '/user-settings?area=maintenance&section=backups',
    );
    expect(screen.getByRole('link', { name: /ML endpoint/ })).toHaveAttribute('href', '/user-settings?area=processing');
    expect(screen.getByText('GPU Studio')).toBeInTheDocument();
    expect(screen.getByText('1 thing needs attention')).toBeInTheDocument();
    expect(screen.getAllByText(en.frameleaf_cc_unmeasured).length).toBeGreaterThanOrEqual(2);
    // a whole-server report without a breakdown (no live volume reading) leaves the parts unmeasured
    expect(screen.getByText(en.frameleaf_cc_storage_volume_unread)).toBeInTheDocument();
  });
  it('points an account or library view to the whole server for the parts', async () => {
    sdk.getAnalyticsReport.mockResolvedValue(
      analyticsReportFixture({ scope: 'account:me', scopeKind: AnalyticsScopeKind.Account, scopeLabel: 'Ada' }),
    );
    render(CommandCenterOverview);
    expect(await screen.findByText(en.frameleaf_cc_storage_whole_server)).toBeInTheDocument();
  });
  const breakdown: AnalyticsVolumeBreakdownDto = {
    originalsBytes: 300 * 1024 ** 2,
    previewsBytes: 100 * 1024 ** 2,
    encodedVideoBytes: 50 * 1024 ** 2,
    onOtherDisk: [],
    generatedObservedAt: '2026-09-19T00:05:00.000Z',
    databaseBytes: 30 * 1024 ** 2,
    otherBytes: 120 * 1024 ** 2,
    exceedsUsed: false,
  };
  const withBreakdown = (parts: Partial<AnalyticsVolumeBreakdownDto>) => {
    const base = analyticsReportFixture();
    return analyticsReportFixture({ host: { ...base.host, breakdown: { ...breakdown, ...parts } } });
  };
  const storageRow = (label: string) => screen.getByText(label).closest('div')!.querySelector('dd')!.textContent;
  it("reads thumbnails & proxies and database & other from the whole server's measured breakdown (FL-79)", async () => {
    sdk.getAnalyticsReport.mockResolvedValue(withBreakdown({}));
    render(CommandCenterOverview);
    await screen.findByText(en.frameleaf_cc_storage_note);
    expect(storageRow(en.frameleaf_cc_derivatives)).toBe(formatBytes(150 * 1024 ** 2));
    expect(storageRow(en.frameleaf_cc_other)).toBe(formatBytes(150 * 1024 ** 2));
  });
  it('says when the whole-server volume could not be read instead of pointing to the server view', async () => {
    const base = analyticsReportFixture();
    sdk.getAnalyticsReport.mockResolvedValue(analyticsReportFixture({ host: { ...base.host, breakdown: null } }));
    render(CommandCenterOverview);
    await screen.findByText(en.frameleaf_cc_storage_volume_unread);
    expect(storageRow(en.frameleaf_cc_derivatives)).toBe(en.frameleaf_cc_unmeasured);
  });
  it('notes a generated folder on another disk', async () => {
    sdk.getAnalyticsReport.mockResolvedValue(withBreakdown({ onOtherDisk: [AnalyticsVolumePart.EncodedVideo] }));
    render(CommandCenterOverview);
    expect(await screen.findByText(en.frameleaf_cc_storage_elsewhere)).toBeInTheDocument();
  });
  it('shows both as not yet measured before the first nightly reading', async () => {
    sdk.getAnalyticsReport.mockResolvedValue(withBreakdown({ previewsBytes: null, encodedVideoBytes: null }));
    render(CommandCenterOverview);
    await screen.findByText(en.frameleaf_cc_storage_pending);
    expect(storageRow(en.frameleaf_cc_derivatives)).toBe(en.frameleaf_cc_not_yet_measured);
    expect(storageRow(en.frameleaf_cc_other)).toBe(en.frameleaf_cc_not_yet_measured);
  });
  it('takes a new snapshot on returning to the window, at most twice a minute (finding 77)', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      render(CommandCenterOverview);
      await screen.findByRole('link', { name: /All accounts.*100/ });
      expect(sdk.getAnalyticsReport).toHaveBeenCalledTimes(1);

      await fireEvent.focus(globalThis as never);
      expect(sdk.getAnalyticsReport).toHaveBeenCalledTimes(1);

      now.mockReturnValue(start + 31_000);
      await fireEvent.focus(globalThis as never);
      await waitFor(() => expect(sdk.getAnalyticsReport).toHaveBeenCalledTimes(2));
    } finally {
      now.mockRestore();
    }
  });
  it('never turns failed subsystem requests into zero usage or no backups', async () => {
    sdk.getStorage.mockRejectedValue(new Error('unavailable'));
    sdk.listDatabaseBackups.mockRejectedValue(new Error('unavailable'));
    sdk.getQueues.mockRejectedValue(new Error('unavailable'));
    render(CommandCenterOverview);
    await screen.findByRole('link', { name: /All accounts.*100/ });
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_cc_no_backup)).not.toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_cc_no_attention)).not.toBeInTheDocument();
  });
  it('withholds the old scope while loading and rejects a late response from the previous scope', async () => {
    let resolveOld!: (value: ReturnType<typeof analyticsReportFixture>) => void;
    sdk.getAnalyticsReport.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    );
    render(CommandCenterOverview);
    await waitFor(() => expect(sdk.getAnalyticsReport).toHaveBeenCalledOnce());
    state.url.searchParams.set('scope', 'account:alex');
    sdk.getAnalyticsReport.mockResolvedValue(analyticsReportFixture({ scope: 'account:alex', scopeLabel: 'Alex' }));
    await screen.findAllByText(/Alex/);
    resolveOld(analyticsReportFixture({ scopeLabel: 'Obsolete account' }));
    await waitFor(() => expect(screen.queryByText('Obsolete account')).not.toBeInTheDocument());
    expect(sdk.getAnalyticsReport).toHaveBeenLastCalledWith({ scope: 'account:alex', range: 'year' });
  });
  it('shows a failed report and can retry the requested scope', async () => {
    sdk.getAnalyticsReport.mockRejectedValueOnce(new Error('unavailable'));
    render(CommandCenterOverview);
    await screen.findByRole('alert');
    expect(screen.queryByText('100')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('link', { name: /All accounts.*100/ });
  });

  describe('readiness rows (CC-9, CommandCenter.jsx:1790-1812, 1905-1935)', () => {
    const destination = (id: string, kind: string, status: string) => ({ id, kind, health: { status } });

    it('asks to prove the backup restores and to check worker compatibility, from the server', async () => {
      sdk.getBackupRestoreVerification.mockResolvedValue({
        metadataVerifiedAt: '2026-09-01T00:00:00.000Z',
        originalsVerifiedAt: null,
        verifiedBy: null,
        overdue: true,
        dueAt: null,
        intervalDays: 90,
      });
      sdk.getRenderWorkerCompatibility.mockResolvedValue({
        qualified: ['quick_edit'],
        unavailable: ['studio_export', 'restoration'],
      });
      render(CommandCenterOverview);

      expect(await screen.findByRole('link', { name: /Prove your backup can restore/ })).toHaveTextContent(
        'Metadata is backed up. Original-file verification has not been recorded.',
      );
      expect(screen.getByRole('link', { name: /Check what your computers can run/ })).toHaveTextContent(
        /No computer is set up to run .*,/,
      );
      expect(screen.getByText('Original-file restore drill overdue')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /GPU Studio/ })).toHaveTextContent('Compatibility check needed');
    });

    it('reads the ML endpoint from the routed destinations', async () => {
      sdk.listMlDestinations.mockResolvedValue([
        destination('local', 'local', 'healthy'),
        destination('pod', 'frameleaf-cloud', 'healthy'),
      ]);
      sdk.getMlWorkloadRoutes.mockResolvedValue({
        routes: [
          { workload: 'clip', destinationId: 'local' },
          { workload: 'face', destinationId: 'pod' },
        ],
      });
      sdk.getRenderWorkerCompatibility.mockResolvedValue({ qualified: ['studio_export'], unavailable: [] });
      render(CommandCenterOverview);

      await waitFor(() => expect(screen.getByRole('link', { name: /ML endpoint/ })).toHaveTextContent('Reachable'));
      expect(screen.getByRole('link', { name: /GPU Studio/ })).toHaveTextContent('Qualified');
      expect(screen.queryByRole('link', { name: /Check what your computers can run/ })).toBeNull();
    });
  });

  describe('Frameleaf Cloud tile (FL-168)', () => {
    const entitlements = {
      cloudBackup: false,
      cloudMl: false,
      frameleafCloud: false,
      remoteAccess: false,
      supporter: false,
    };
    const plan = { activatedAt: '2026-09-01T00:00:00.000Z', expiresAt: null, graceUntil: null };
    const tile = () => screen.getByTestId('overview-cloud-tile');

    it('replaces the cloud destination tile and opens Frameleaf Cloud', async () => {
      cloud.status = { configured: false, state: 'not-configured', remoteAccessEnabled: false };
      render(CommandCenterOverview);

      await waitFor(() => expect(tile()).toHaveTextContent('Frameleaf Cloud'));
      expect(tile()).toHaveTextContent('Not set up');
      expect(tile()).not.toHaveTextContent('·');
      expect(tile()).toHaveAttribute('href', '/user-settings?area=cloud');
      expect(screen.queryByText('Cloud destination')).toBeNull();
    });

    it('reads an unlinked server', async () => {
      cloud.status = { configured: true, state: 'unlinked', remoteAccessEnabled: false };
      cloud.license = { state: 'none', plan: null, entitlements };
      render(CommandCenterOverview);

      await waitFor(() => expect(tile()).toHaveTextContent('Not linked · Remote off · No plan'));
      expect(tile()).not.toHaveClass('attention');
    });

    it('reads a linked server with remote access and an active plan', async () => {
      cloud.status = { configured: true, state: 'linked', remoteAccessEnabled: true };
      cloud.license = { state: 'active', plan, entitlements };
      render(CommandCenterOverview);

      await waitFor(() => expect(tile()).toHaveTextContent('Linked · Remote on · Plan active'));
      expect(tile()).not.toHaveClass('attention');
    });

    it('asks for attention while the plan is in its grace period', async () => {
      cloud.status = { configured: true, state: 'linked', remoteAccessEnabled: true };
      cloud.license = { state: 'grace', plan, entitlements };
      render(CommandCenterOverview);

      await waitFor(() => expect(tile()).toHaveTextContent('Linked · Remote on · Plan in grace period'));
      expect(tile()).toHaveClass('attention');
    });
  });
});
