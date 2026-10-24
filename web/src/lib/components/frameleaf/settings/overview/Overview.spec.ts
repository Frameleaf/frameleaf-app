import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import en from '../../../../../../../i18n/en.json';
import Overview from './Overview.svelte';
import { byUrgency, growthPerDay, overviewLevel, roomLeft, sentence } from './overview';

const sdk = vi.hoisted(() => ({
  getAttention: vi.fn(),
  setAttentionDismissed: vi.fn(),
  getAnalyticsReport: vi.fn(),
  getStorage: vi.fn(),
  getAboutInfo: vi.fn(),
  getBackupRestoreVerification: vi.fn(),
  getRenderWorkerCompatibility: vi.fn(),
  listMlDestinations: vi.fn(),
  getMlWorkloadRoutes: vi.fn(),
  getOvernight: vi.fn(),
  listAllBackupDevices: vi.fn(),
  createJob: vi.fn(),
}));
vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: { listen: () => () => {}, status: null, license: null },
}));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('$lib/components/frameleaf/analytics/AnalyticsChart.svelte', async () => ({
  default: (await import('../../../../../test-data/components/MockText.svelte')).default,
}));

const healthy = {
  checkedAt: '2026-10-20T16:00:00.000Z',
  items: [],
  checks: [
    { kind: 'backup', state: 'ok' },
    { kind: 'storage', state: 'ok' },
    { kind: 'work', state: 'ok' },
    { kind: 'version', state: 'ok' },
  ],
  dismissed: [] as string[],
};

describe('Overview (FL-363)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdk.getAttention.mockReset().mockResolvedValue(healthy);
    sdk.setAttentionDismissed.mockReset();
    sdk.getAnalyticsReport.mockReset().mockResolvedValue(analyticsReportFixture());
    sdk.getStorage.mockResolvedValue({
      diskUseRaw: 60e9,
      diskSizeRaw: 100e9,
      diskAvailableRaw: 40e9,
      diskUsagePercentage: 60,
    });
    sdk.getAboutInfo.mockResolvedValue({ version: '3.2.0' });
    sdk.getBackupRestoreVerification.mockResolvedValue({ metadataVerifiedAt: '2026-10-01T00:00:00.000Z' });
    sdk.getRenderWorkerCompatibility.mockResolvedValue({ unavailable: [] });
    sdk.listMlDestinations.mockResolvedValue([]);
    sdk.getMlWorkloadRoutes.mockResolvedValue({ routes: [] });
    sdk.getOvernight.mockResolvedValue({ timezone: 'UTC', nextRunAt: null, steps: [], run: null, nights: [] });
    sdk.listAllBackupDevices.mockReset().mockResolvedValue({ devices: [], nextOffset: null });
  });

  it('reads every phone and says when one stopped sending photos (FL-518)', async () => {
    const phone = (displayName: string, quietForDays: number | null) => ({
      id: displayName,
      displayName,
      quietForDays,
      ownerId: 'u',
      deviceKey: displayName,
      platform: 'ios',
      model: 'iPhone',
      appVersion: '1.0',
      pendingCount: 0,
      lastSuccessfulBackupAt: null,
      reportedAt: '2026-10-20T00:00:00.000Z',
    });
    sdk.listAllBackupDevices.mockResolvedValue({
      devices: [phone('Taylor’s iPhone', 0), phone('Emma’s phone', 9), phone('New phone', null)],
      nextOffset: null,
    });
    render(Overview);

    expect(await screen.findByText('Emma’s phone hasn’t sent photos for 9 days')).toBeInTheDocument();
    expect(screen.getByText('1 phone behind')).toBeInTheDocument();
    expect(screen.getByText('Emma’s phone, 9 days')).toBeInTheDocument();
  });

  it('says there are no phones yet (FL-518)', async () => {
    render(Overview);
    expect(await screen.findByText('No phones yet')).toBeInTheDocument();
    expect(screen.getByText('Install the app to send photos here')).toBeInTheDocument();
  });

  it('says everything is working when nothing needs the person', async () => {
    render(Overview);
    expect(await screen.findByRole('heading', { name: 'Everything is working' })).toBeInTheDocument();
    expect(screen.getByText(/Your library is backed up/)).toBeInTheDocument();
    expect(screen.queryByText('Library available')).not.toBeInTheDocument();
    expect(screen.getByText('What was checked')).toBeInTheDocument();
    expect(screen.getByText('40 GB free')).toBeInTheDocument();
  });

  it('says something needs the person now, most urgent first', async () => {
    sdk.getAttention.mockResolvedValue({
      ...healthy,
      items: [
        {
          id: 'version',
          kind: 'version',
          reason: 'new-version',
          level: 'soon',
          since: null,
          storage: null,
          backup: null,
          work: null,
          version: { current: '3.2.0', available: '3.3.0' },
        },
        {
          id: 'storage',
          kind: 'storage',
          reason: 'out-of-space',
          level: 'now',
          since: null,
          storage: { availableBytes: 8e9, totalBytes: 500e9, usedPercent: 98 },
          backup: null,
          work: null,
          version: null,
        },
      ],
      checks: healthy.checks.map((check) =>
        check.kind === 'storage' || check.kind === 'version' ? { ...check, state: 'attention' } : check,
      ),
    });
    render(Overview);
    expect(await screen.findByRole('heading', { name: 'Something needs you now' })).toBeInTheDocument();
    expect(screen.getAllByText(/almost out of space/i).length).toBeGreaterThan(0);
    const list = screen.getByRole('list', { name: 'Needs your attention' });
    expect(list.querySelector('li')).toHaveClass('is-now');
  });

  it('lets Studio’s need be dismissed, kept on the server', async () => {
    sdk.getRenderWorkerCompatibility.mockResolvedValue({ unavailable: ['studio-export'] });
    sdk.setAttentionDismissed.mockResolvedValue({ ...healthy, dismissed: ['studio'] });
    render(Overview);
    expect(await screen.findByRole('heading', { name: 'Working, with 1 thing to look at' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(sdk.setAttentionDismissed).toHaveBeenCalledWith({ attentionDismissDto: { id: 'studio', dismissed: true } });
    expect(await screen.findByRole('heading', { name: 'Everything is working' })).toBeInTheDocument();
    expect(screen.getByText('Needs a computer')).toBeInTheDocument();
  });
});

describe('overview rules', () => {
  it('answers with three levels', () => {
    expect(overviewLevel([])).toBe('ok');
    expect(overviewLevel(['look'])).toBe('attention');
    expect(overviewLevel(['look', 'now'])).toBe('urgent');
    expect(
      byUrgency([
        { level: 'look' as const, id: 1 },
        { level: 'now' as const, id: 2 },
      ]).map((n) => n.id),
    ).toEqual([2, 1]);
  });

  it('works out the room left at the pace photos are added', () => {
    const series = [
      { through: '2026-01-31T00:00:00.000Z', physicalBytes: 100e9 },
      { through: '2026-07-31T00:00:00.000Z', physicalBytes: 281e9 },
    ];
    const perDay = growthPerDay(series)!;
    expect(perDay).toBeCloseTo(1e9, -7);
    expect(roomLeft(120e9, perDay)).toEqual({ unit: 'months', count: 4 });
    expect(roomLeft(10e9, perDay)).toEqual({ unit: 'days', count: 10 });
    expect(roomLeft(10e9, null)).toBeNull();
    expect(growthPerDay(series.slice(0, 1))).toBeNull();
  });

  it('builds a sentence from phrases', () => {
    expect(sentence('your library is backed up')).toBe('Your library is backed up.');
  });
});
