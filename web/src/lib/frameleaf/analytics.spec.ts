import { AnalyticsCameraKind, AnalyticsScopeKind, AnalyticsState, AnalyticsVolumePart } from '@immich/sdk';
import {
  analyticsCsv,
  analyticsTables,
  breakdownTotal,
  calendarWeeks,
  captureSpan,
  dayRecords,
  punchcardPeak,
  rankRows,
  volumeSegments,
  yearRows,
  columnTotal,
  CSV_HEADER,
  historyNotice,
  parseCsv,
  scopeLabel,
  type Translate,
} from '$lib/frameleaf/analytics';
import { analyticsInsightsFixture, analyticsReportFixture } from '$lib/frameleaf/analytics.fixture';

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

  it.each(['=', '+', '-', '@', '\t', '\r', '\n'])(
    'neutralizes text cells starting with %j without changing numbers',
    (prefix) => {
      for (const scopeKind of [AnalyticsScopeKind.Account, AnalyticsScopeKind.Library]) {
        const label = `${prefix}SUM(1,2)`;
        const report = analyticsReportFixture({ scopeKind, scopeLabel: label });
        report.cameras[0].name = label;
        report.series[1].photos = -3;
        const { rows } = csvRecords(analyticsCsv(report, 'items', t));
        expect(rows.every((row) => row.selection_scope === `'${label}`)).toBe(true);
        expect(rows.find((row) => row.section === 'frameleaf_analytics_cameras')?.row).toBe(`'${label}`);
        expect(rows.some((row) => row.value === '-3')).toBe(true);
      }
    },
  );

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

describe('dashboard insights (FL-79)', () => {
  const INSIGHT_TABLES = ['years', 'punchcard', 'lenses', 'focal-lengths', 'orientation', 'places'];

  it('adds every breakdown up to the items less the hidden ones', () => {
    for (const hiddenItems of [0, 4]) {
      const base = analyticsInsightsFixture();
      const insights = {
        ...base,
        hiddenItems,
        // take the hidden items out of one bucket of each breakdown, as the server leaves them out
        capturesByYear: base.capturesByYear.map((row, i) =>
          i === 2 ? { ...row, count: row.count - hiddenItems } : row,
        ),
        punchcard: base.punchcard.map((cell) =>
          cell.weekday === 1 && cell.hour === 9 ? { ...cell, count: cell.count - hiddenItems } : cell,
        ),
        lenses: base.lenses.map((row, i) => (i === 0 ? { ...row, count: row.count - hiddenItems } : row)),
        focalLengths: base.focalLengths.map((row, i) => (i === 1 ? { ...row, count: row.count - hiddenItems } : row)),
        orientation: base.orientation.map((row, i) => (i === 0 ? { ...row, count: row.count - hiddenItems } : row)),
        photoFormats: base.photoFormats.map((row, i) => (i === 0 ? { ...row, count: row.count - hiddenItems } : row)),
        peopleAndPlaces: {
          ...base.peopleAndPlaces!,
          places: base.peopleAndPlaces!.places.map((row, i) =>
            i === 3 ? { ...row, count: row.count - hiddenItems } : row,
          ),
        },
      };
      // cameras leave out the same hidden items (server getCameras shares the insights privacy)
      const cameras = [
        { name: 'Apple iPhone 16 Pro', kind: AnalyticsCameraKind.Model, count: 80 - hiddenItems },
        { name: null, kind: AnalyticsCameraKind.Unknown, count: 20 },
      ];
      const report = analyticsReportFixture({ insights, cameras });
      const tables = analyticsTables(report, 'items', t);
      const byId = (id: string) => tables.find((table) => table.id === id)!;
      const total = breakdownTotal(report);
      expect(total).toBe(report.summary.items - hiddenItems);
      for (const id of INSIGHT_TABLES) {
        const table = byId(id);
        expect(columnTotal(table, table.columns.length - 1)).toBe(total);
      }
      expect(columnTotal(byId('photo-formats'), 1) + columnTotal(byId('video-resolutions'), 1)).toBe(total);
      expect(columnTotal(byId('cameras'), 1)).toBe(total);
    }
  });

  it('leaves people and places out of the tables and CSV when the server does', () => {
    const report = analyticsReportFixture({ insights: analyticsInsightsFixture({ peopleAndPlaces: null }) });
    const ids = analyticsTables(report, 'items', t).map((table) => table.id);
    expect(ids).not.toContain('places');
    expect(ids).not.toContain('people');
    expect(analyticsCsv(report, 'items', t)).not.toContain('Emma');
  });

  it('ranks real rows by count and keeps catch-alls last, out of the bar scale', () => {
    const { rows, scale } = rankRows([
      { id: 'a', label: 'A', count: 20, catchAll: false },
      { id: 'rest', label: 'Everywhere else', count: 90, catchAll: true },
      { id: 'b', label: 'B', count: 30, catchAll: false },
    ]);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a', 'rest']);
    expect(scale).toBe(30);
  });

  it('reads the span, the empty years between, and the punchcard peak', () => {
    const insights = analyticsInsightsFixture();
    expect(captureSpan(insights)).toEqual({ from: 2019, through: 2026, years: 8 });
    const years = yearRows(insights);
    expect(years).toHaveLength(8);
    expect(years.find((row) => row.year === 2020)!.count).toBe(0);
    expect(years.reduce((sum, row) => sum + row.count, 0)).toBe(100);
    expect(punchcardPeak(insights)).toEqual({ weekday: 1, hour: 9, count: 50 });
    expect(captureSpan(analyticsInsightsFixture({ capturesByYear: [] }))).toBeNull();
  });

  it('finds the busiest day, the longest streak and the daily average from the days', () => {
    expect(
      dayRecords([
        { date: '2026-09-01', captured: 2, uploaded: 0 },
        { date: '2026-09-02', captured: 5, uploaded: 0 },
        { date: '2026-09-03', captured: 0, uploaded: 0 },
        { date: '2026-09-04', captured: 1, uploaded: 0 },
      ]),
    ).toEqual({
      busiest: { date: '2026-09-02', count: 5 },
      streak: { length: 2, from: '2026-09-01', through: '2026-09-02' },
      perDay: 2,
    });
    expect(dayRecords([])).toEqual({ busiest: null, streak: null, perDay: 0 });
  });

  it('names every punchcard row by its weekday and hour in the CSV', () => {
    const report = analyticsReportFixture();
    const rows = csvRecords(analyticsCsv(report, 'items', t)).rows.filter(
      (row) => row.section === 'frameleaf_analytics_punchcard_table',
    );
    expect(rows).toHaveLength(168);
    expect(new Set(rows.map((row) => row.row)).size).toBe(168);
    expect(rows).toContainEqual(
      expect.objectContaining({
        row: 'frameleaf_analytics_weekday_1 · 09:00',
        column: 'frameleaf_analytics_col_items',
        value: '50',
      }),
    );
  });
});

describe('the storage donut (FL-79)', () => {
  const base = analyticsReportFixture();
  const sum = (segments: Array<{ bytes: number }>) => segments.reduce((total, segment) => total + segment.bytes, 0);

  it('splits the used space by the breakdown, and every segment is a share of the capacity', () => {
    const report = analyticsReportFixture({
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
    });
    const volume = volumeSegments(report, t)!;
    expect(volume.segments.map((segment) => segment.id)).toEqual([
      'originals',
      'previews',
      'encoded-video',
      'database',
      'other',
      'free',
      'reserved',
    ]);
    expect(sum(volume.segments)).toBe(report.host.capacityBytes);
    expect(sum(volume.segments.filter((segment) => !segment.free))).toBe(report.host.volumeUsedBytes);
    expect(volume.usedPercent).toBe(60);
    const parts = analyticsTables(report, 'items', t).find((table) => table.id === 'volume-parts')!;
    expect(columnTotal(parts, 2)).toBe(report.host.volumeUsedBytes);
  });

  it('shows the unused part when free space could not be read, with the same denominator', () => {
    const report = analyticsReportFixture({ host: { ...base.host, freeBytes: null } });
    const volume = volumeSegments(report, t)!;
    expect(volume.segments.map((segment) => [segment.id, segment.bytes])).toEqual([
      ['used', 600_000],
      ['not-in-use', 400_000],
    ]);
    expect(sum(volume.segments)).toBe(report.host.capacityBytes);
  });

  it('shows used and free when the measured parts exceed the space used', () => {
    const report = analyticsReportFixture({
      host: {
        ...base.host,
        breakdown: {
          originalsBytes: 500_000,
          previewsBytes: null,
          encodedVideoBytes: null,
          onOtherDisk: [],
          generatedObservedAt: null,
          databaseBytes: 900_000,
          otherBytes: 0,
          exceedsUsed: true,
        },
      },
    });
    expect(volumeSegments(report, t)!.segments.map((segment) => segment.id)).toEqual(['used', 'free', 'reserved']);
    // the parts table carries the same fallback as its caption
    const table = analyticsTables(report, 'items', t).find((item) => item.id === 'volume-parts')!;
    expect(table.caption).toBe('frameleaf_analytics_parts_exceed_caption');
    expect(volumeSegments(analyticsReportFixture({ host: { ...base.host, capacityBytes: null } }), t)).toBeNull();
  });

  it('lists a generated folder on another disk but leaves it out of the donut', () => {
    const report = analyticsReportFixture({
      host: {
        ...base.host,
        breakdown: {
          originalsBytes: 300_000,
          previewsBytes: 2_000_000,
          encodedVideoBytes: 50_000,
          onOtherDisk: [AnalyticsVolumePart.Previews],
          generatedObservedAt: '2026-09-19T00:05:00.000Z',
          databaseBytes: 30_000,
          otherBytes: 220_000,
          exceedsUsed: false,
        },
      },
    });
    const volume = volumeSegments(report, t)!;
    expect(volume.segments.map((segment) => segment.id)).not.toContain('previews');
    expect(sum(volume.segments)).toBe(report.host.capacityBytes);
    expect(sum(volume.segments.filter((segment) => !segment.free))).toBe(report.host.volumeUsedBytes);
    const table = analyticsTables(report, 'items', t).find((item) => item.id === 'volume-parts')!;
    expect(table.rows.map((row) => row[0])).toContain(
      'frameleaf_analytics_on_other_disk(frameleaf_analytics_part_previews)',
    );
    expect(table.caption).toBeUndefined();
  });
});
