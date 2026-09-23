import { AnalyticsScopeKind, AnalyticsState } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LibraryAnalytics from '$lib/components/frameleaf/analytics/LibraryAnalytics.svelte';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
import en from '../../../../../../i18n/en.json';

/**
 * FL-79: the Library analytics page. The pure table/CSV reconciliation is in `analytics.spec.ts`;
 * this checks what the page renders from a report — real stale/unknown states, processing left out
 * for an account, data tables holding the plotted values, and a CSV export that never touches the
 * network.
 */

const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/admin/system-settings?area=analytics') } }));
const downloadBlob = vi.hoisted(() => vi.fn());
vi.mock('$lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils')>()),
  downloadBlob,
}));

const scopes = [
  { value: 'all', kind: AnalyticsScopeKind.Host, label: '', userId: null, libraryId: null, removed: false },
  {
    value: 'account:11111111-1111-4111-8111-111111111111',
    kind: AnalyticsScopeKind.Account,
    label: 'Taylor',
    userId: '11111111-1111-4111-8111-111111111111',
    libraryId: null,
    removed: false,
  },
];

describe('LibraryAnalytics', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    goto.mockReset();
    downloadBlob.mockReset();
  });

  it('shows measured values, the whole volume beside the selection, and no sample-data badge', () => {
    render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
    expect(screen.getByRole('heading', { level: 1, name: 'A closer look at your library' })).toBeInTheDocument();
    expect(screen.queryByText(/sample data/i)).not.toBeInTheDocument();
    expect(screen.getByText('Whole volume used')).toBeInTheDocument();
    expect(screen.queryByText(/other libraries|host files/i)).not.toBeInTheDocument();
    expect(
      screen.getByText('Periods without a nightly reading are shown as gaps.', { exact: false }),
    ).toBeInTheDocument();
  });

  it('shows unknown history instead of a chart, and an unreadable volume as unknown', () => {
    const base = analyticsReportFixture();
    render(LibraryAnalytics, {
      scopes,
      report: analyticsReportFixture({
        history: { ...base.history, state: AnalyticsState.Unknown, lastObservedAt: null },
        host: {
          state: AnalyticsState.Unknown,
          observedAt: null,
          volumeUsedBytes: null,
          capacityBytes: null,
          freeBytes: null,
        },
      }),
    });
    expect(screen.getByText('No history yet')).toBeInTheDocument();
    expect(screen.getByText(/Growth history starts with the first nightly collection/)).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getAllByText(/could not be read/).length).toBeGreaterThan(0);
  });

  it('marks stale history with when it was last collected', () => {
    const base = analyticsReportFixture();
    render(LibraryAnalytics, {
      scopes,
      report: analyticsReportFixture({ history: { ...base.history, state: AnalyticsState.Stale } }),
    });
    expect(screen.getByText('Out of date')).toBeInTheDocument();
    expect(screen.getByText(/was last collected/)).toBeInTheDocument();
  });

  it('leaves processing out for an account instead of drawing zeros', () => {
    render(LibraryAnalytics, {
      scopes,
      report: analyticsReportFixture({
        scope: scopes[1].value,
        scopeKind: AnalyticsScopeKind.Account,
        scopeLabel: 'Taylor',
        processing: {
          available: false,
          attempts: 0,
          completed: 0,
          failed: 0,
          durationMs: 0,
          estimatedCostUsd: null,
          costedAttempts: 0,
          uncostedAttempts: 0,
        },
      }),
    });
    expect(screen.getByText(/Processing is recorded for the whole server/)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Processing outcomes/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated cloud processing/)).not.toBeInTheDocument();
  });

  it('labels the processing cost as an estimate, never a charge', () => {
    render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
    const row = screen.getByRole('rowheader', { name: 'Estimated cloud processing' }).closest('tr')!;
    expect(within(row).getByText(/Not a bill\./)).toBeInTheDocument();
  });

  it('puts the plotted arrivals in the data table, totalling the upload calendar', () => {
    const report = analyticsReportFixture();
    const { container } = render(LibraryAnalytics, { scopes, report });
    const arrivals = container.querySelector(':scope [data-table-id="arrivals"] tbody')!;
    const cells = [...arrivals.querySelectorAll(':scope > tr')].map((row) =>
      [...row.querySelectorAll(':scope > td')].reduce((sum, cell) => sum + Number(cell.textContent), 0),
    );
    const uploaded = report.days.reduce((sum, day) => sum + day.uploaded, 0);
    expect(cells.reduce((sum, value) => sum + value, 0)).toBe(uploaded);
    // the chart draws one bar per non-empty value, with the value in its title
    const chart = screen.getByRole('img', { name: /Photo and video arrivals/ });
    const bars = [...chart.querySelectorAll(':scope rect title')].map((title) =>
      Number(/: ([\d,.]+)/.exec(title.textContent!)![1]),
    );
    expect(bars.reduce((sum, value) => sum + value, 0)).toBe(uploaded);
  });

  it('exports the CSV in the browser without any request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
    await fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = downloadBlob.mock.calls[0] as [Blob, string];
    expect(name).toBe('frameleaf-analytics-all-90days-items-2026-09-19.csv');
    expect(await blob.text()).toContain('"section","row","column"');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/CSV download started/)).toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it('changes scope through the address so the page load reads the new report', async () => {
    render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
    await fireEvent.change(screen.getByLabelText('Library scope'), { target: { value: scopes[1].value } });
    expect(goto).toHaveBeenCalledWith(
      expect.stringContaining(`scope=${encodeURIComponent(scopes[1].value)}`),
      expect.anything(),
    );
  });
});
