import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import en from '../../../../../../i18n/en.json';
import CommandCenterOverview from './CommandCenterOverview.svelte';

const state = vi.hoisted(() => ({ url: new URL('http://localhost/user-settings?area=overview') }));
const sdk = vi.hoisted(() => ({
  getAnalyticsReport: vi.fn(),
  getAboutInfo: vi.fn(),
  getStorage: vi.fn(),
  getQueues: vi.fn(),
  listDatabaseBackups: vi.fn(),
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
    expect(screen.getByText(en.frameleaf_cc_storage_unmeasured)).toBeInTheDocument();
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
});
