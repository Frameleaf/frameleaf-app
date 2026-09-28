import { AnalyticsCameraKind, AnalyticsScopeKind, AnalyticsState } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LibraryAnalytics from '$lib/components/frameleaf/analytics/LibraryAnalytics.svelte';
import { analyticsInsightsFixture, analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';
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
const auth = vi.hoisted(() => ({ user: { id: 'me', isAdmin: true } }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
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
    auth.user = { id: 'me', isAdmin: true };
  });

  it('shows measured values, the whole volume beside the selection, and no sample-data badge', () => {
    render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
    expect(screen.getByRole('heading', { level: 1, name: 'Library analytics' })).toBeInTheDocument();
    expect(screen.queryByText(/sample data/i)).not.toBeInTheDocument();
    expect(screen.getByText('Volume used')).toBeInTheDocument();
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

  describe('the dashboard (FL-79, AnalyticsDashboard.jsx)', () => {
    /** The exact counts a panel's data table holds, summed. */
    const tableTotal = (container: HTMLElement, id: string) =>
      [...container.querySelectorAll(`:scope [data-table-id="${CSS.escape(id)}"] tbody > tr`)].reduce(
        (sum, row) => sum + Number(row.querySelector(':scope > td:last-child')!.textContent!.replaceAll(',', '')),
        0,
      );
    const panel = (container: HTMLElement, id: string) =>
      container.querySelector<HTMLElement>(`[data-panel="${CSS.escape(id)}"]`)!;

    it('opens with the library total, its span, fact chips and the four tiles', () => {
      render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      const hero = screen.getByRole('region', { name: 'Library at a glance' });
      expect(within(hero).getByText('100')).toBeInTheDocument();
      expect(within(hero).getByText('8 years')).toBeInTheDocument();
      expect(hero).toHaveTextContent('2019–2026');
      for (const fact of ['2 countries', '3 places', '3 people named', '5 RAW photos', '1 Dolby Vision video']) {
        expect(within(hero).getByText(fact)).toBeInTheDocument();
      }
      for (const tile of ['Added in this period', 'Volume used', 'Saved by deduplication', 'Photos · videos']) {
        expect(within(hero).getByText(tile)).toBeInTheDocument();
      }
      expect(within(hero).getByRole('img', { name: '60% of the volume used' })).toBeInTheDocument();
    });

    it('makes every breakdown add up to the report total', () => {
      const report = analyticsReportFixture();
      const { container } = render(LibraryAnalytics, { scopes, report });
      const total = report.summary.items - report.insights!.hiddenItems;
      for (const id of ['years', 'punchcard', 'lenses', 'focal-lengths', 'orientation', 'places']) {
        expect(tableTotal(container, id)).toBe(total);
      }
      expect(tableTotal(container, 'photo-formats') + tableTotal(container, 'video-resolutions')).toBe(total);
      expect(tableTotal(container, 'cameras')).toBe(total);
      expect(screen.queryByRole('note')).not.toBeInTheDocument();
    });

    it('notes the hidden items the breakdowns leave out, and still reconciles to what remains', () => {
      const insights = analyticsInsightsFixture({
        hiddenItems: 4,
        capturesByYear: [
          { year: 2019, count: 10 },
          { year: 2024, count: 36 },
          { year: 2026, count: 50 },
        ],
      });
      const report = analyticsReportFixture({
        insights,
        cameras: [
          { name: 'Apple iPhone 16 Pro', kind: AnalyticsCameraKind.Model, count: 76 },
          { name: null, kind: AnalyticsCameraKind.Unknown, count: 20 },
        ],
      });
      const { container } = render(LibraryAnalytics, { scopes, report });
      expect(tableTotal(container, 'cameras')).toBe(report.summary.items - insights.hiddenItems);
      expect(screen.getByRole('note')).toHaveTextContent(
        '4 hidden items are left out of the breakdowns below, so they add up to 96.',
      );
      expect(tableTotal(container, 'years')).toBe(report.summary.items - insights.hiddenItems);
    });

    it('ranks leaders and keeps catch-all rows last without setting the bar scale', () => {
      const { container } = render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      const places = within(panel(container, 'places')).getByRole('list', { name: 'Where they were taken' });
      const rows = within(places).getAllByRole('listitem');
      expect(rows.map((row) => row.querySelector(':scope .name')!.textContent)).toEqual([
        'Banff',
        'Lisbon',
        'Everywhere else',
        'No location',
      ]);
      // "No location" (40) is larger than Banff (30), yet Banff sets the scale.
      const width = (row: Element) => row.querySelector<HTMLElement>(':scope .bar > span')!.style.width;
      expect(width(rows[0])).toBe('100%');
      expect(width(rows[3])).toBe('100%');
      expect(width(rows[1])).toBe(`${(20 / 30) * 100}%`);
      const lenses = within(panel(container, 'gear')).getByRole('list', { name: 'Favourite lenses' });
      expect(within(lenses).getAllByRole('listitem').at(-1)).toHaveTextContent('Not recorded');
    });

    it('draws captures per year, the punchcard peak, formats and coverage from the report', () => {
      const { container } = render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      expect(
        within(panel(container, 'years')).getByRole('heading', { name: '8 years, 2019 to today' }),
      ).toBeInTheDocument();
      expect(panel(container, 'years').querySelectorAll('.an-year')).toHaveLength(8);
      expect(
        within(panel(container, 'punchcard')).getByRole('heading', { name: /Most often on Mondays around 9/ }),
      ).toBeInTheDocument();
      const formats = panel(container, 'formats');
      expect(within(formats).getByText('3 HDR videos')).toBeInTheDocument();
      expect(within(formats).getByText(/HDR is known for 8 of 10 videos/)).toBeInTheDocument();
      const coverage = within(panel(container, 'coverage'));
      expect(coverage.getByRole('img', { name: 'Located: 60%' })).toBeInTheDocument();
      expect(coverage.getByRole('img', { name: 'Described by AI: 40%' })).toBeInTheDocument();
      // faces checked and search indexed are shares of the items the session may see
      expect(coverage.getByRole('img', { name: 'Faces checked: 90%' })).toBeInTheDocument();
      expect(coverage.getByRole('img', { name: 'Search indexed: 95%' })).toBeInTheDocument();
      expect(coverage.getAllByRole('img').map((ring) => ring.getAttribute('aria-label')!.split(':', 1)[0])).toEqual([
        'Dated',
        'Located',
        'Described by AI',
        'Faces checked',
        'Search indexed',
        'Checksummed',
      ]);
    });

    it('shows the daily heatmap with an exact-count table for the chosen date', async () => {
      const report = analyticsReportFixture();
      const { container } = render(LibraryAnalytics, { scopes, report });
      const days = panel(container, 'days');
      expect(within(days).getByRole('heading', { name: '7 captures over 7 days' })).toBeInTheDocument();
      // the accessible name starts with the visible text (WCAG 2.5.3)
      expect(within(days).getByText('View daily counts').closest('summary')!.getAttribute('aria-label')).toMatch(
        /^View daily counts/,
      );
      expect(tableTotal(container, 'calendar-captured')).toBe(7);
      await fireEvent.change(within(days).getByLabelText('Show'), { target: { value: 'uploaded' } });
      expect(within(days).getByRole('heading', { name: '4 uploads over 7 days' })).toBeInTheDocument();
    });

    it('hides people and places outside the owner scope and says why', () => {
      const { container } = render(LibraryAnalytics, {
        scopes,
        report: analyticsReportFixture({ insights: analyticsInsightsFixture({ peopleAndPlaces: null }) }),
      });
      expect(panel(container, 'people')).toBeNull();
      expect(panel(container, 'places')).toBeNull();
      expect(screen.getByText('People and places are shown only when you view your own library.')).toBeInTheDocument();
      expect(screen.queryByText('Emma')).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Library at a glance' })).not.toHaveTextContent('countries');
    });

    it('shows the library records without inventing names it was not given', () => {
      const base = analyticsInsightsFixture();
      const { container } = render(LibraryAnalytics, {
        scopes,
        report: analyticsReportFixture({
          insights: { ...base, records: { ...base.records, largestFile: { bytes: 3 * 1024 ** 3, name: null } } },
        }),
      });
      const records = within(panel(container, 'records'));
      expect(records.getByText('Oldest memory')).toBeInTheDocument();
      expect(records.getByText('7 years ago')).toBeInTheDocument();
      expect(records.getByText('Busiest day')).toBeInTheDocument();
      expect(records.getByText('1:42:10')).toBeInTheDocument();
      expect(records.getByText('Name shown only to its owner')).toBeInTheDocument();
    });

    it('puts every insight breakdown in the CSV export', async () => {
      render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      await fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));
      const [blob] = downloadBlob.mock.calls[0] as [Blob, string];
      const csv = await blob.text();
      for (const section of ['Captures per year', 'Favourite lenses', 'Photo formats', 'Where they were taken']) {
        expect(csv).toContain(`"${section}"`);
      }
    });

    it('links the People panel to recognition settings for an administrator, and to People otherwise', () => {
      const { container, unmount } = render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      expect(within(panel(container, 'people')).getByRole('link', { name: /Recognition/ })).toHaveAttribute(
        'href',
        '/user-settings?area=intelligence',
      );
      unmount();
      auth.user = { id: 'me', isAdmin: false };
      const { container: own } = render(LibraryAnalytics, { scopes, report: analyticsReportFixture() });
      expect(within(panel(own, 'people')).queryByRole('link', { name: /Recognition/ })).toBeNull();
      expect(within(panel(own, 'people')).getByRole('link', { name: /People/ })).toHaveAttribute('href', '/people');
    });

    it('splits the whole volume by what the server measured, as shares of the capacity', () => {
      const base = analyticsReportFixture();
      const { container } = render(LibraryAnalytics, {
        scopes,
        report: analyticsReportFixture({
          host: {
            ...base.host,
            breakdown: {
              originalsBytes: 300_000,
              previewsBytes: 100_000,
              encodedVideoBytes: 50_000,
              onOtherDisk: [],
              generatedObservedAt: '2026-09-19T00:05:00.000Z',
              databaseBytes: 30_000,
              otherBytes: 120_000,
              exceedsUsed: false,
            },
          },
        }),
      });
      const storage = within(panel(container, 'storage'));
      const legend = within(panel(container, 'storage').querySelector<HTMLElement>(':scope .an-legend')!);
      for (const part of ['Originals', 'Previews & thumbnails', 'Encoded video', 'Database', 'Other files', 'Free']) {
        expect(legend.getByText(part)).toBeInTheDocument();
      }
      expect(storage.getByText('60%')).toBeInTheDocument();
      // legend shares and the centre use one denominator: 300,000 of 1,000,000 is 30.0%
      expect(storage.getByText('30.0%')).toBeInTheDocument();
      expect(tableTotal(container, 'volume-parts')).toBe(600_000);
    });

    it('still draws the volume when free space could not be read', () => {
      const base = analyticsReportFixture();
      const { container } = render(LibraryAnalytics, {
        scopes,
        report: analyticsReportFixture({ host: { ...base.host, freeBytes: null } }),
      });
      const storage = within(panel(container, 'storage'));
      expect(storage.queryByText(/could not be read\. /)).toBeNull();
      expect(storage.getByText('Not in use')).toBeInTheDocument();
      expect(storage.getByText('60%')).toBeInTheDocument();
      expect(storage.getByText('60.0%')).toBeInTheDocument();
      expect(storage.getByText('40.0%')).toBeInTheDocument();
    });
  });
});
