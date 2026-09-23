/**
 * Library analytics (FL-79), ported from the design template's `analytics-data.mjs` and
 * `SettingsAnalytics.jsx`. The template computed a fictional journal in the browser; production
 * reads `GET /analytics` and this module only shapes that answer for the page.
 *
 * One rule matters more than the rest: every chart, its data table and the CSV export are built
 * from the same rows here (`analyticsTables`), so the three always show the same values and add up
 * to the same totals. A value the server does not have (`null`) stays empty in all three — a gap,
 * never a zero — and a series the server does not carry for the selection is left out.
 *
 * Nothing here talks to the network. The CSV is built in the browser from the report already shown.
 */
import {
  AnalyticsCameraKind,
  AnalyticsMeasurementScope,
  AnalyticsScopeKind,
  AnalyticsState,
  type AnalyticsBucketDto,
  type AnalyticsDayDto,
  type AnalyticsReportResponseDto,
  type AnalyticsScopeOptionDto,
} from '@immich/sdk';

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export type GrowthMetric = 'items' | 'storage';
export type CalendarKind = 'captured' | 'uploaded';

export const GiB = 1024 ** 3;

/** Bytes as GiB, two decimals, for charts and tables. Exact bytes stay in the tables and CSV. */
export const toGiB = (bytes: number | null) => (bytes === null ? null : Math.round((bytes / GiB) * 100) / 100);

export const scopeLabel = (option: Pick<AnalyticsScopeOptionDto, 'kind' | 'label' | 'removed'>, t: Translate) => {
  if (option.kind === AnalyticsScopeKind.Host) {
    return t('frameleaf_analytics_scope_all');
  }
  if (!option.removed) {
    return option.label;
  }
  return t(
    option.kind === AnalyticsScopeKind.Account
      ? 'frameleaf_analytics_scope_deleted_account'
      : 'frameleaf_analytics_scope_removed_library',
    { name: option.label },
  );
};

// ── Tables ────────────────────────────────────────────────────────────────

/** A cell: a number, text, or null for a value that was not observed. */
export type Cell = number | string | null;

export type AnalyticsColumn = {
  label: string;
  /** Unit for numeric columns; `text` for the row label and other words. */
  unit: 'items' | 'bytes' | 'GiB' | 'attempts' | 'percent' | 'USD' | 'albums' | 'text' | 'date' | 'row';
};

export type AnalyticsTable = {
  id: string;
  title: string;
  /** Whether the values describe the selection or always the whole host. */
  measurementScope: AnalyticsMeasurementScope;
  columns: AnalyticsColumn[];
  rows: Cell[][];
  /** The table's values are estimates, not measured or charged amounts. */
  estimate?: boolean;
  /** For a column whose unit is `row`: each row's own unit and a stable id. */
  rowUnits?: AnalyticsColumn['unit'][];
  rowIds?: string[];
};

const period = (row: Pick<AnalyticsBucketDto, 'from' | 'through'>) => `${row.from} – ${row.through}`;
const selection = AnalyticsMeasurementScope.Selection;

/**
 * Every table the page shows, in page order. Charts plot columns of these same rows and the CSV is
 * written from them, which is what keeps the three reconciled.
 */
export const analyticsTables = (
  report: AnalyticsReportResponseDto,
  metric: GrowthMetric,
  t: Translate,
): AnalyticsTable[] => {
  const growth: AnalyticsTable = {
    id: 'growth',
    title: t('frameleaf_analytics_growth'),
    measurementScope: selection,
    columns:
      metric === 'storage'
        ? [
            { label: t('frameleaf_analytics_col_through'), unit: 'date' },
            { label: t('frameleaf_analytics_physical_originals'), unit: 'GiB' },
            { label: t('frameleaf_analytics_logical_originals'), unit: 'GiB' },
          ]
        : [
            { label: t('frameleaf_analytics_col_through'), unit: 'date' },
            { label: t('frameleaf_analytics_col_items'), unit: 'items' },
          ],
    rows: report.series.map((row) =>
      metric === 'storage'
        ? [row.through, toGiB(row.physicalBytes), toGiB(row.logicalBytes)]
        : [row.through, row.items],
    ),
  };

  const arrivals: AnalyticsTable = {
    id: 'arrivals',
    title: t('frameleaf_analytics_arrivals'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_period'), unit: 'text' },
      { label: t('photos'), unit: 'items' },
      { label: t('videos'), unit: 'items' },
    ],
    rows: report.series.map((row) => [period(row), row.photos, row.videos]),
  };

  const cameras: AnalyticsTable = {
    id: 'cameras',
    title: t('frameleaf_analytics_cameras'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_camera'), unit: 'text' },
      { label: t('frameleaf_analytics_col_items'), unit: 'items' },
    ],
    rows: report.cameras.map((row) => [cameraLabel(row, t), row.count]),
  };

  const bytesColumns: AnalyticsColumn[] = [
    { label: t('frameleaf_analytics_col_category'), unit: 'text' },
    { label: 'GiB', unit: 'GiB' },
    { label: t('frameleaf_analytics_col_exact_bytes'), unit: 'bytes' },
  ];

  const originals: AnalyticsTable = {
    id: 'originals',
    title: t('frameleaf_analytics_originals'),
    measurementScope: selection,
    columns: bytesColumns,
    rows: originalsRows(report, t).map(([name, bytes]) => [name, toGiB(bytes), bytes]),
  };

  const volume: AnalyticsTable = {
    id: 'volume',
    title: t('frameleaf_analytics_volume'),
    measurementScope: AnalyticsMeasurementScope.Host,
    columns: bytesColumns,
    rows: [
      [t('frameleaf_analytics_volume_used'), toGiB(report.host.volumeUsedBytes), report.host.volumeUsedBytes],
      [t('frameleaf_analytics_volume_free'), toGiB(report.host.freeBytes), report.host.freeBytes],
      [t('frameleaf_analytics_volume_capacity'), toGiB(report.host.capacityBytes), report.host.capacityBytes],
    ],
  };

  const processing: AnalyticsTable[] = report.processing.available
    ? [
        {
          id: 'processing',
          title: t('frameleaf_analytics_processing'),
          measurementScope: AnalyticsMeasurementScope.Host,
          columns: [
            { label: t('frameleaf_analytics_col_period'), unit: 'text' },
            { label: t('frameleaf_analytics_completed'), unit: 'attempts' },
            { label: t('frameleaf_analytics_failed'), unit: 'attempts' },
          ],
          rows: report.series.map((row) => [period(row), row.completed, row.failed]),
        },
      ]
    : [];

  const metadata: AnalyticsTable = {
    id: 'metadata',
    title: t('frameleaf_analytics_metadata'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_field'), unit: 'text' },
      { label: t('frameleaf_analytics_present'), unit: 'items' },
      { label: t('frameleaf_analytics_missing'), unit: 'items' },
      { label: t('frameleaf_analytics_col_complete'), unit: 'percent' },
    ],
    rows: report.metadata.map((row) => [
      t(`frameleaf_analytics_field_${row.field}`),
      row.present,
      row.missing,
      percent(row.present, row.total),
    ]),
  };

  const views: AnalyticsTable = {
    id: 'views',
    title: t('frameleaf_analytics_views'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_view'), unit: 'text' },
      { label: t('photos'), unit: 'items' },
      { label: t('videos'), unit: 'items' },
      { label: t('frameleaf_analytics_col_total'), unit: 'items' },
    ],
    rows: [
      ...report.views.map((row) => [
        row.overlaps
          ? t('frameleaf_analytics_view_overlaps', { view: t(`frameleaf_analytics_view_${row.view}`) })
          : t(`frameleaf_analytics_view_${row.view}`),
        row.photos,
        row.videos,
        row.total,
      ]),
      [t('frameleaf_analytics_view_all'), report.summary.photos, report.summary.videos, report.summary.items],
    ],
  };

  const albums: AnalyticsTable = {
    id: 'albums',
    title: t('frameleaf_analytics_albums'),
    measurementScope: selection,
    columns: [
      { label: t('album'), unit: 'text' },
      { label: t('owner'), unit: 'text' },
      { label: t('frameleaf_analytics_col_ownership'), unit: 'text' },
      { label: t('frameleaf_analytics_col_sharing'), unit: 'text' },
    ],
    rows: report.albums.albums.map((album) => [
      album.name,
      album.ownerName,
      t(album.owned ? 'frameleaf_analytics_owned' : 'frameleaf_analytics_member'),
      t(album.shared ? 'frameleaf_analytics_shared' : 'frameleaf_analytics_private'),
    ]),
  };

  const calendars = (['captured', 'uploaded'] as const).map((kind): AnalyticsTable => ({
    id: `calendar-${kind}`,
    title: t(kind === 'captured' ? 'frameleaf_analytics_capture_calendar' : 'frameleaf_analytics_upload_calendar'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_date'), unit: 'date' },
      { label: t('frameleaf_analytics_col_items'), unit: 'items' },
    ],
    rows: report.days.map((day) => [day.date, day[kind]]),
  }));

  const inventory = inventoryRows(report);
  const inventoryTable: AnalyticsTable = {
    id: 'inventory',
    title: t('frameleaf_analytics_under_the_hood'),
    measurementScope: selection,
    columns: [
      { label: t('frameleaf_analytics_col_metric'), unit: 'text' },
      { label: t('frameleaf_analytics_col_value'), unit: 'row' },
    ],
    rows: inventory.map(({ id, value }) => [t(`frameleaf_analytics_inventory_${id}`), value]),
    rowUnits: inventory.map(({ unit }) => unit),
    rowIds: inventory.map(({ id }) => id),
  };

  const estimate: AnalyticsTable[] = report.processing.available
    ? [
        {
          id: 'estimate',
          title: t('frameleaf_analytics_estimate'),
          measurementScope: AnalyticsMeasurementScope.Host,
          estimate: true,
          columns: [
            { label: t('frameleaf_analytics_col_metric'), unit: 'text' },
            { label: t('frameleaf_analytics_col_value'), unit: 'USD' },
          ],
          rows: [[t('frameleaf_analytics_estimate_value'), report.processing.estimatedCostUsd]],
        },
      ]
    : [];

  return [
    growth,
    arrivals,
    cameras,
    originals,
    volume,
    ...processing,
    metadata,
    views,
    albums,
    ...calendars,
    inventoryTable,
    ...estimate,
  ];
};

export const cameraLabel = (row: AnalyticsReportResponseDto['cameras'][number], t: Translate) =>
  row.kind === AnalyticsCameraKind.Model && row.name
    ? row.name
    : t(
        row.kind === AnalyticsCameraKind.Other
          ? 'frameleaf_analytics_camera_other'
          : 'frameleaf_analytics_camera_unknown',
      );

/** The selection's originals by where they live. No "other" row: nothing is derived from the host. */
export const originalsRows = (report: AnalyticsReportResponseDto, t: Translate): Array<[string, number]> => [
  [t('frameleaf_analytics_originals_uploaded'), report.summary.uploadedPhysicalBytes],
  [t('frameleaf_analytics_originals_external'), report.summary.externalPhysicalBytes],
];

const percent = (present: number, total: number) => (total ? Math.round((present / total) * 1000) / 10 : 0);

/** The "Under the hood" rows. Each id has a label and a definition string. */
export const inventoryRows = (report: AnalyticsReportResponseDto) => {
  const { summary } = report;
  const rows: Array<{ id: string; value: number; unit: 'items' | 'bytes' }> = [
    { id: 'raw', value: summary.raw, unit: 'items' },
    { id: 'duplicate_references', value: summary.duplicateReferences, unit: 'items' },
    { id: 'logical', value: summary.logicalBytes, unit: 'bytes' },
    { id: 'physical', value: summary.physicalBytes, unit: 'bytes' },
    { id: 'saved', value: summary.savedBytes, unit: 'bytes' },
    { id: 'external', value: summary.externalLogicalBytes, unit: 'bytes' },
    { id: 'unmeasured', value: summary.unmeasuredFiles, unit: 'items' },
  ];
  return rows;
};

// ── Totals ────────────────────────────────────────────────────────────────

/** Sum one numeric column of a table, ignoring gaps. */
export const columnTotal = (table: AnalyticsTable, column: number) =>
  table.rows.reduce((sum, row) => sum + (typeof row[column] === 'number' ? (row[column] as number) : 0), 0);

// ── CSV ───────────────────────────────────────────────────────────────────

export const CSV_HEADER = [
  'section',
  'row',
  'column',
  'value',
  'unit',
  'selection_scope',
  'measurement_scope',
  'state',
  'from',
  'through',
  'generated_at',
] as const;

const escape = (value: Cell) => {
  const text = value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

/**
 * The CSV export: one record per numeric cell of every table, in page order. A gap is written as an
 * empty value with state `missing`, never as zero; an estimate is marked `estimate`.
 */
export const analyticsCsv = (report: AnalyticsReportResponseDto, metric: GrowthMetric, t: Translate) => {
  const selected =
    report.scopeKind === AnalyticsScopeKind.Host ? t('frameleaf_analytics_scope_all') : report.scopeLabel;
  const records: Cell[][] = [];
  for (const table of analyticsTables(report, metric, t)) {
    const labelColumn = table.columns.findIndex((column) => column.unit === 'text' || column.unit === 'date');
    for (const row of table.rows) {
      const rowLabel = labelColumn === -1 ? '' : row[labelColumn];
      const rowIndex = table.rows.indexOf(row);
      for (const [index, column] of table.columns.entries()) {
        if (index === labelColumn || column.unit === 'text' || column.unit === 'date') {
          continue;
        }
        const unit = column.unit === 'row' ? (table.rowUnits?.[rowIndex] ?? 'items') : column.unit;
        const value = row[index];
        const state = value === null ? 'missing' : table.estimate ? 'estimate' : 'measured';
        records.push([
          table.title,
          rowLabel,
          column.label,
          value,
          unit,
          selected,
          table.measurementScope === AnalyticsMeasurementScope.Host ? t('frameleaf_analytics_whole_host') : selected,
          state,
          report.from,
          report.through,
          report.generatedAt,
        ]);
      }
    }
  }
  return (
    [
      CSV_HEADER.map((value) => escape(value)).join(','),
      ...records.map((row) => row.map((value) => escape(value)).join(',')),
    ].join('\r\n') + '\r\n'
  );
};

export const csvFileName = (report: AnalyticsReportResponseDto, metric: GrowthMetric) =>
  `frameleaf-analytics-${report.scope.replace(':', '-')}-${report.range}-${metric}-${report.through}.csv`;

/** Parse the export back into records, for checks. Handles only what `analyticsCsv` writes. */
export const parseCsv = (csv: string) =>
  csv
    .trim()
    .split('\r\n')
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((match) => match[1].replaceAll('""', '"')));

// ── Calendars ─────────────────────────────────────────────────────────────

export type CalendarCell = { date: string; value: number | null; level: 0 | 1 | 2 | 3 | 4 | 'empty' };

const DAY_MS = 86_400_000;
const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Weeks of seven days starting Monday. Days outside the report are `null`, drawn as blank. */
export const calendarWeeks = (days: AnalyticsDayDto[], kind: CalendarKind): CalendarCell[][] => {
  if (days.length === 0) {
    return [];
  }
  const byDate = new Map(days.map((day) => [day.date, day[kind]]));
  const maximum = Math.max(1, ...days.map((day) => day[kind]));
  const first = Date.parse(`${days[0].date}T00:00:00Z`);
  const start = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY_MS;
  const last = Date.parse(`${days.at(-1)!.date}T00:00:00Z`);
  const weeks: CalendarCell[][] = [];
  for (let time = start; time <= last; time += 7 * DAY_MS) {
    weeks.push(
      Array.from({ length: 7 }, (_, index) => {
        const date = iso(time + index * DAY_MS);
        const value = byDate.get(date) ?? null;
        const level =
          value === null ? 'empty' : value === 0 ? 0 : (Math.min(4, Math.ceil((value / maximum) * 4)) as 1 | 2 | 3 | 4);
        return { date, value, level };
      }),
    );
  }
  return weeks;
};

// ── States ────────────────────────────────────────────────────────────────

/** Whether growth history can be drawn at all, and why not. */
export const historyNotice = (report: AnalyticsReportResponseDto) => {
  if (report.history.state === AnalyticsState.Unknown) {
    return 'unknown' as const;
  }
  if (report.history.state === AnalyticsState.Stale) {
    return 'stale' as const;
  }
  return report.series.some((row) => row.observedAt === null) ? ('gaps' as const) : null;
};
