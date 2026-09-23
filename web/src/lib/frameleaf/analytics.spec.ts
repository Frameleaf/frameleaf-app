import { AnalyticsScopeKind, AnalyticsState } from '@immich/sdk';
import {
  analyticsCsv,
  analyticsTables,
  calendarWeeks,
  columnTotal,
  CSV_HEADER,
  historyNotice,
  parseCsv,
  scopeLabel,
  type Translate,
} from '$lib/frameleaf/analytics';
import { analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';

/** Keys stand in for copy, so the checks do not depend on wording. */
const t: Translate = (key, values) => (values ? `${key}(${Object.values(values).join(',')})` : key);

const csvRecords = (csv: string) => {
  const [header, ...rows] = parseCsv(csv);
  return { header, rows: rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]]))) };
};

/** Sum the CSV values of one table column, the way a spreadsheet would. */
const csvTotal = (csv: string, section: string, column: string) =>
  csvRecords(csv)
    .rows.filter((row) => row.section === section && row.column === column)
    .reduce((sum, row) => sum + (row.value === '' ? 0 : Number(row.value)), 0);

describe('analytics tables, charts and CSV', () => {
  it('writes one CSV record per numeric table cell, so table and CSV totals are identical', () => {
    for (const metric of ['items', 'storage'] as const) {
      const report = analyticsReportFixture();
      const tables = analyticsTables(report, metric, t);
      const csv = analyticsCsv(report, metric, t);
      const { header, rows } = csvRecords(csv);
      expect(header).toEqual([...CSV_HEADER]);

      for (const table of tables) {
        for (const [index, column] of table.columns.entries()) {
          if (column.unit === 'text' || column.unit === 'date') {
            continue;
          }
          expect(csvTotal(csv, table.title, column.label)).toBeCloseTo(columnTotal(table, index), 6);
        }
      }
      const numericCells = tables.reduce(
        (sum, table) =>
          sum + table.rows.length * table.columns.filter((c) => c.unit !== 'text' && c.unit !== 'date').length,
        0,
      );
      expect(rows).toHaveLength(numericCells);
    }
  });

  it('reconciles with the report: arrivals, calendars, processing, views and cameras add up', () => {
    const report = analyticsReportFixture();
    const tables = analyticsTables(report, 'items', t);
    const byId = (id: string) => tables.find((table) => table.id === id)!;
    const uploaded = report.days.reduce((sum, day) => sum + day.uploaded, 0);

    expect(columnTotal(byId('arrivals'), 1) + columnTotal(byId('arrivals'), 2)).toBe(uploaded);
    expect(columnTotal(byId('calendar-uploaded'), 1)).toBe(uploaded);
    expect(columnTotal(byId('calendar-captured'), 1)).toBe(7);
    expect(columnTotal(byId('processing'), 1) + columnTotal(byId('processing'), 2)).toBe(report.processing.attempts);
    expect(columnTotal(byId('cameras'), 1)).toBe(report.summary.items);
    const partition = byId('views').rows.filter((row) =>
      [
        'frameleaf_analytics_view_timeline',
        'frameleaf_analytics_view_archive',
        'frameleaf_analytics_view_trash',
      ].includes(row[0] as string),
    );
    expect(partition.reduce((sum, row) => sum + (row[3] as number), 0)).toBe(report.summary.items);
    expect(columnTotal(byId('originals'), 2)).toBe(report.summary.physicalBytes);
  });

  it('keeps gaps empty and marked missing, never zero', () => {
    const report = analyticsReportFixture();
    const growth = analyticsTables(report, 'items', t).find((table) => table.id === 'growth')!;
    expect(growth.rows[0]).toEqual(['2026-09-13', null]);
    const missing = csvRecords(analyticsCsv(report, 'items', t)).rows.filter(
      (row) => row.section === 'frameleaf_analytics_growth',
    );
    expect(missing[0]).toMatchObject({ value: '', state: 'missing' });
    expect(missing[1]).toMatchObject({ value: '100', state: 'measured' });
  });

  it('never invents host usage from the selection: no "other" row, host figures labelled whole server', () => {
    const report = analyticsReportFixture({
      scope: 'account:x',
      scopeKind: AnalyticsScopeKind.Account,
      scopeLabel: 'Taylor',
    });
    const csv = analyticsCsv(report, 'storage', t);
    expect(csv).not.toMatch(/other (libraries|host)/i);
    const volume = csvRecords(csv).rows.filter((row) => row.section === 'frameleaf_analytics_volume');
    expect(volume.every((row) => row.measurement_scope === 'frameleaf_analytics_whole_host')).toBe(true);
    expect(volume.find((row) => row.row === 'frameleaf_analytics_volume_used' && row.unit === 'bytes')?.value).toBe(
      '600000',
    );
    const originals = csvRecords(csv).rows.filter((row) => row.section === 'frameleaf_analytics_originals');
    expect(originals.every((row) => row.measurement_scope === 'Taylor')).toBe(true);
  });

  it('marks the cost estimate as an estimate and leaves processing out when the scope has none', () => {
    const csv = analyticsCsv(analyticsReportFixture(), 'items', t);
    expect(csvRecords(csv).rows.find((row) => row.section === 'frameleaf_analytics_estimate')).toMatchObject({
      value: '0.0123',
      unit: 'USD',
      state: 'estimate',
    });

    const account = analyticsReportFixture({
      scope: 'account:x',
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
    });
    const ids = analyticsTables(account, 'items', t).map((table) => table.id);
    expect(ids).not.toContain('processing');
    expect(ids).not.toContain('estimate');
    expect(analyticsCsv(account, 'items', t)).not.toMatch(/processing|estimate/);
  });

  it('writes the unknown volume as missing, not zero', () => {
    const report = analyticsReportFixture({
      host: {
        state: AnalyticsState.Unknown,
        observedAt: null,
        volumeUsedBytes: null,
        capacityBytes: null,
        freeBytes: null,
      },
    });
    const volume = csvRecords(analyticsCsv(report, 'items', t)).rows.filter(
      (row) => row.section === 'frameleaf_analytics_volume',
    );
    expect(volume).toHaveLength(6);
    expect(volume.every((row) => row.value === '' && row.state === 'missing')).toBe(true);
  });

  it('escapes quotes and commas in names', () => {
    const report = analyticsReportFixture();
    report.albums.albums[0].name = 'Jamie’s "best", ever';
    report.cameras[0].name = 'Make "X", 1';
    const { rows } = csvRecords(analyticsCsv(report, 'items', t));
    expect(rows.find((row) => row.section === 'frameleaf_analytics_cameras')?.row).toBe('Make "X", 1');
  });
});

describe('calendarWeeks', () => {
  it('starts weeks on Monday, blanks days outside the report and scales levels to the busiest day', () => {
    const weeks = calendarWeeks(analyticsReportFixture().days, 'captured').slice(1);
    expect(calendarWeeks(analyticsReportFixture().days, 'captured')).toHaveLength(2);
    expect(calendarWeeks(analyticsReportFixture().days, 'captured')[0][0]).toEqual({
      date: '2026-09-07',
      value: null,
      level: 'empty',
    });
    expect(weeks[0].map((cell) => cell.date)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
    ]);
    expect(weeks[0][6]).toEqual({ date: '2026-09-20', value: null, level: 'empty' });
    expect(weeks[0][4]).toMatchObject({ value: 5, level: 4 });
    expect(weeks[0][1]).toMatchObject({ value: 2, level: 2 });
    expect(weeks[0][0]).toMatchObject({ value: 0, level: 0 });
  });
});

describe('states', () => {
  it('reports unknown, stale and gaps', () => {
    expect(historyNotice(analyticsReportFixture())).toBe('gaps');
    const history = analyticsReportFixture().history;
    expect(historyNotice(analyticsReportFixture({ history: { ...history, state: AnalyticsState.Unknown } }))).toBe(
      'unknown',
    );
    expect(historyNotice(analyticsReportFixture({ history: { ...history, state: AnalyticsState.Stale } }))).toBe(
      'stale',
    );
  });

  it('labels scopes, including removed accounts and libraries', () => {
    expect(scopeLabel({ kind: AnalyticsScopeKind.Host, label: '', removed: false }, t)).toBe(
      'frameleaf_analytics_scope_all',
    );
    expect(scopeLabel({ kind: AnalyticsScopeKind.Account, label: 'Jamie', removed: true }, t)).toBe(
      'frameleaf_analytics_scope_deleted_account(Jamie)',
    );
    expect(scopeLabel({ kind: AnalyticsScopeKind.Library, label: 'Trail', removed: false }, t)).toBe('Trail');
  });
});
