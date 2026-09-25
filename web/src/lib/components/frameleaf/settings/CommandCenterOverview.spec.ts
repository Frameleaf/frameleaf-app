import { AnalyticsScopeKind, AnalyticsVolumePart, type AnalyticsVolumeBreakdownDto } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
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
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('@immich/sdk', async (original) => ({ ...(await original<typeof import('@immich/sdk')>()), ...sdk }));
vi.mock('$lib/components/frameleaf/analytics/AnalyticsChart.svelte', async () => ({
  default: (await import('../../../../test-data/components/MockText.svelte')).default,
}));

describe('Command Center measured Overview', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.url = new SvelteURL('http://localhost/user-settings?area=overview');
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
    expect(screen.getByText('immich-db-backup-20260923T120000-v3.sql.gz')).toBeInTheDocument();
    expect(screen.queryByText('z-immich-db-backup-20260921T120000-v3.sql.gz')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review failed jobs/ })).toHaveAttribute(
      'href',
      '/user-settings?area=processing&section=queues',
    );
    // The template's links: the latest backup opens Database backups, the ML endpoint Compute & jobs.
    expect(screen.getByRole('link', { name: /Latest database backup/ })).toHaveAttribute(
      'href',
      '/user-settings?area=backup&section=backup',
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
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
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
      expect(screen.getByRole('link', { name: /Check worker compatibility/ })).toHaveTextContent(
        /No qualified GPU worker for .*,/,
      );
      expect(screen.getByText('Original-file restore drill overdue')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /GPU Studio/ })).toHaveTextContent('Compatibility check needed');
    });

    it('reads the ML endpoint and cloud destination from the routed destinations', async () => {
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
      expect(screen.getByRole('link', { name: /Cloud destination/ })).toHaveTextContent('Frameleaf Cloud selected');
      expect(screen.getByRole('link', { name: /GPU Studio/ })).toHaveTextContent('Qualified');
      expect(screen.queryByRole('link', { name: /Check worker compatibility/ })).toBeNull();
    });
  });
});
