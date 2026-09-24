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
  AnalyticsFocalLengthDtoKey,
  AnalyticsMeasurementScope,
  AnalyticsNamedCountKind,
  AnalyticsScopeKind,
  AnalyticsState,
  type AnalyticsBucketDto,
  type AnalyticsDayDto,
  type AnalyticsInsightsDto,
  type AnalyticsNamedCountDto,
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
  /** A caption that replaces the default "exact plotted values" one, for a table that needs a caveat. */
  caption?: string;
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

  const parts = volumeParts(report, t);
  const volumeParts_: AnalyticsTable[] = parts
    ? [
        {
          id: 'volume-parts',
          title: t('frameleaf_analytics_volume_parts'),
          // the donut falls back to used and free then; the table says why
          caption: report.host.breakdown?.exceedsUsed ? t('frameleaf_analytics_parts_exceed_caption') : undefined,
          measurementScope: AnalyticsMeasurementScope.Host,
          columns: bytesColumns,
          rows: parts.map((part) => [part.label, toGiB(part.bytes), part.bytes]),
        },
      ]
    : [];

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

  const insights = report.insights ? insightTables(report.insights, t) : [];

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
    ...volumeParts_,
    ...processing,
    metadata,
    views,
    albums,
    ...calendars,
    ...insights,
    inventoryTable,
    ...estimate,
  ];
};

// ── The library volume (FL-79, AnalyticsDashboard.jsx StoragePanel) ──────

export type VolumeSegment = { id: string; label: string; bytes: number; free?: boolean; otherDisk?: boolean };

/**
 * What uses the volume, from the whole-server report's `host.breakdown`: originals, previews and
 * thumbnails, encoded video, the database and other files. A generated folder not measured yet is
 * left out (its bytes are in "Other files"). Null when the report has no breakdown.
 */
export const volumeParts = (report: AnalyticsReportResponseDto, t: Translate): VolumeSegment[] | null => {
  const breakdown = report.host.breakdown;
  if (!breakdown) {
    return null;
  }
  const elsewhere = new Set<string>(breakdown.onOtherDisk);
  const parts: Array<[string, string, number | null, boolean]> = [
    ['originals', 'frameleaf_analytics_part_originals', breakdown.originalsBytes, false],
    ['previews', 'frameleaf_analytics_part_previews', breakdown.previewsBytes, elsewhere.has('previews')],
    [
      'encoded-video',
      'frameleaf_analytics_part_encoded_video',
      breakdown.encodedVideoBytes,
      elsewhere.has('encodedVideo'),
    ],
    ['database', 'frameleaf_analytics_part_database', breakdown.databaseBytes, false],
    ['other', 'frameleaf_analytics_part_other', breakdown.otherBytes, false],
  ];
  // A folder on another disk is listed, but it is not part of this volume.
  return parts.flatMap(([id, key, bytes, otherDisk]) =>
    bytes === null
      ? []
      : [
          otherDisk
            ? { id, label: t('frameleaf_analytics_on_other_disk', { part: t(key) }), bytes, otherDisk }
            : { id, label: t(key), bytes },
        ],
  );
};

/**
 * The storage donut's segments, which always add up to the volume's capacity, so the centre
 * percentage and every legend percentage share one denominator. The used part is split by the
 * breakdown when it reconciles, else shown whole. Free space is what the server read; the rest of
 * the capacity is reserved by the file system. With no free reading, the unused part is shown as
 * "Not in use". Null when the used or total size is unknown.
 */
export const volumeSegments = (report: AnalyticsReportResponseDto, t: Translate) => {
  const { volumeUsedBytes: used, capacityBytes: capacity, freeBytes: free, breakdown } = report.host;
  if (used === null || capacity === null || capacity <= 0) {
    return null;
  }
  const parts =
    breakdown && !breakdown.exceedsUsed ? (volumeParts(report, t)?.filter((part) => !part.otherDisk) ?? null) : null;
  const segments: VolumeSegment[] = parts ?? [{ id: 'used', label: t('frameleaf_analytics_volume_used'), bytes: used }];
  const unused = Math.max(0, capacity - used);
  if (free === null) {
    segments.push({ id: 'not-in-use', label: t('frameleaf_analytics_not_in_use'), bytes: unused, free: true });
  } else {
    const shownFree = Math.min(free, unused);
    segments.push({ id: 'free', label: t('frameleaf_analytics_volume_free'), bytes: shownFree, free: true });
    if (unused > shownFree) {
      segments.push({
        id: 'reserved',
        label: t('frameleaf_analytics_reserved'),
        bytes: unused - shownFree,
        free: true,
      });
    }
  }
  return { segments, capacity, used, usedPercent: (Math.min(used, capacity) / capacity) * 100 };
};

// ── Formatting ────────────────────────────────────────────────────────────

const TiB = 1024 ** 4;

/** The dashboard's number, size, date and duration formats for one locale (AnalyticsDashboard.jsx:7-28). */
export const analyticsFormats = (locale: string | undefined, t: Translate) => {
  const number = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const compact = (value: number) =>
    new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  const longDate = (value: string) =>
    new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${value.slice(0, 10)}T00:00:00Z`),
    );
  /** Bytes in GiB, or TiB from one tebibyte up, as the prototype writes volume sizes. */
  const size = (bytes: number) =>
    bytes >= TiB
      ? t('frameleaf_analytics_tib', {
          value: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / TiB),
        })
      : t('frameleaf_analytics_gib', {
          value: new Intl.NumberFormat(locale, { maximumFractionDigits: bytes >= 10 * GiB ? 0 : 1 }).format(
            bytes / GiB,
          ),
        });
  const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
  const duration = (milliseconds: number) => {
    const seconds = Math.round(milliseconds / 1000);
    return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60]
      .map((part, index) => (index ? String(part).padStart(2, '0') : String(part)))
      .join(':');
  };
  const hour = (value: number) =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 5, value)));
  return { number, compact, longDate, size, percent, duration, hour };
};

// ── Dashboard insights (FL-79, AnalyticsDashboard.jsx) ────────────────────

/** The ISO weekdays in punchcard order, Monday first, as the server numbers them. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** A bucket row with an optional catch-all flag: the "other" and "not recorded" rows. */
export type BreakdownRow = { id: string; label: string; count: number; catchAll: boolean };

/**
 * Leaderboard order (AnalyticsDashboard.jsx:143-173): real rows ranked by count, catch-all rows
 * ("Everywhere else", "Not recorded") after them in their own order. The bar scale is the largest
 * ranked row, so a catch-all never outshines the leaders.
 */
export const rankRows = (rows: BreakdownRow[]) => {
  const ranked = rows.filter((row) => !row.catchAll).sort((a, b) => b.count - a.count);
  const rest = rows.filter((row) => row.catchAll);
  return { rows: [...ranked, ...rest], scale: Math.max(1, ...ranked.map((row) => row.count)) };
};

const namedRows = (
  rows: AnalyticsNamedCountDto[],
  labels: { other: string; unknown: string },
  prefix: string,
): BreakdownRow[] =>
  rows.map((row, index) =>
    row.kind === AnalyticsNamedCountKind.Named && row.name
      ? { id: `${prefix}:${index}`, label: row.name, count: row.count, catchAll: false }
      : {
          id: `${prefix}:${row.kind}`,
          label: row.kind === AnalyticsNamedCountKind.Other ? labels.other : labels.unknown,
          count: row.count,
          catchAll: true,
        },
  );

export const lensRows = (insights: AnalyticsInsightsDto, t: Translate) =>
  namedRows(
    insights.lenses,
    { other: t('frameleaf_analytics_lens_other'), unknown: t('frameleaf_analytics_not_recorded') },
    'lens',
  );

export const placeRows = (insights: AnalyticsInsightsDto, t: Translate) =>
  namedRows(
    insights.peopleAndPlaces?.places ?? [],
    { other: t('frameleaf_analytics_place_other'), unknown: t('frameleaf_analytics_place_unknown') },
    'place',
  );

export const cameraRows = (report: AnalyticsReportResponseDto, t: Translate): BreakdownRow[] =>
  report.cameras.map((row, index) => ({
    id: `camera:${row.kind}:${index}`,
    label: cameraLabel(row, t),
    count: row.count,
    catchAll: row.kind !== AnalyticsCameraKind.Model,
  }));

const FOCAL_LABELS: Record<AnalyticsFocalLengthDtoKey, string> = {
  [AnalyticsFocalLengthDtoKey.$016]: '≤16',
  [AnalyticsFocalLengthDtoKey.$1728]: '17–28',
  [AnalyticsFocalLengthDtoKey.$2940]: '29–40',
  [AnalyticsFocalLengthDtoKey.$4170]: '41–70',
  [AnalyticsFocalLengthDtoKey.$71135]: '71–135',
  [AnalyticsFocalLengthDtoKey.$136300]: '136–300',
  [AnalyticsFocalLengthDtoKey.$301]: '300+',
  [AnalyticsFocalLengthDtoKey.Unknown]: '',
};

/** Focal lengths in bucket order; the unrecorded bucket is the catch-all, last. */
export const focalRows = (insights: AnalyticsInsightsDto, t: Translate): BreakdownRow[] =>
  insights.focalLengths.map((row) => ({
    id: `focal:${row.key}`,
    label:
      row.key === AnalyticsFocalLengthDtoKey.Unknown
        ? t('frameleaf_analytics_not_recorded')
        : t('frameleaf_analytics_focal_mm', { range: FOCAL_LABELS[row.key] }),
    count: row.count,
    catchAll: row.key === AnalyticsFocalLengthDtoKey.Unknown,
  }));

const keyedRows = (
  rows: Array<{ key: string; count: number }>,
  catchAll: readonly string[],
  label: (key: string) => string,
  prefix: string,
): BreakdownRow[] => {
  const mapped = rows.map((row) => ({
    id: `${prefix}:${row.key}`,
    label: label(row.key),
    count: row.count,
    catchAll: catchAll.includes(row.key),
  }));
  return [...mapped.filter((row) => !row.catchAll), ...mapped.filter((row) => row.catchAll)];
};

export const photoFormatRows = (insights: AnalyticsInsightsDto, t: Translate) =>
  keyedRows(
    insights.photoFormats,
    ['OTHER'],
    (key) => (key === 'OTHER' ? t('frameleaf_analytics_format_other') : key),
    'format',
  );

export const videoResolutionRows = (insights: AnalyticsInsightsDto, t: Translate) =>
  keyedRows(
    insights.videoResolutions,
    ['unknown'],
    (key) => (key === 'unknown' ? t('frameleaf_analytics_not_recorded') : key),
    'resolution',
  );

export const orientationRows = (insights: AnalyticsInsightsDto, t: Translate) =>
  keyedRows(insights.orientation, ['unknown'], (key) => t(`frameleaf_analytics_orientation_${key}`), 'orientation');

/**
 * What every insight breakdown adds up to: the report's items less the ones this session keeps
 * hidden (Locked people and tags, sensitive content), which the server leaves out of them.
 */
export const breakdownTotal = (report: AnalyticsReportResponseDto) =>
  report.summary.items - (report.insights?.hiddenItems ?? 0);

/** The capture years the library spans, first to last, or null with none recorded. */
export const captureSpan = (insights: AnalyticsInsightsDto) => {
  const years = insights.capturesByYear.filter((row) => row.count > 0).map((row) => row.year);
  if (years.length === 0) {
    return null;
  }
  const from = Math.min(...years);
  const through = Math.max(...years);
  return { from, through, years: through - from + 1 };
};

/** Every year from the first capture to the last, with the years in between as zero. */
export const yearRows = (insights: AnalyticsInsightsDto) => {
  const span = captureSpan(insights);
  if (!span) {
    return [];
  }
  const counts = new Map(insights.capturesByYear.map((row) => [row.year, row.count]));
  return Array.from({ length: span.years }, (_, index) => ({
    year: span.from + index,
    count: counts.get(span.from + index) ?? 0,
  }));
};

/** The busiest weekday and hour of the punchcard, or null for an empty one. */
export const punchcardPeak = (insights: AnalyticsInsightsDto) => {
  let peak: AnalyticsInsightsDto['punchcard'][number] | null = null;
  for (const cell of insights.punchcard) {
    if (cell.count > 0 && (!peak || cell.count > peak.count)) {
      peak = cell;
    }
  }
  return peak;
};

/** The busiest capture day and the longest run of days with captures, from the report's days. */
export const dayRecords = (days: AnalyticsDayDto[]) => {
  let busiest: AnalyticsDayDto | null = null;
  let best = { length: 0, from: '', through: '' };
  let run = { length: 0, from: '' };
  let total = 0;
  for (const day of days) {
    total += day.captured;
    if (day.captured > (busiest?.captured ?? 0)) {
      busiest = day;
    }
    if (day.captured > 0) {
      run = { length: run.length + 1, from: run.from || day.date };
      if (run.length > best.length) {
        best = { length: run.length, from: run.from, through: day.date };
      }
    } else {
      run = { length: 0, from: '' };
    }
  }
  return {
    busiest: busiest ? { date: busiest.date, count: busiest.captured } : null,
    streak: best.length > 0 ? best : null,
    perDay: days.length > 0 ? Math.round(total / days.length) : 0,
  };
};

/** The dashboard's breakdown tables, each adding up to `breakdownTotal` (or its photos/videos share). */
const insightTables = (insights: AnalyticsInsightsDto, t: Translate): AnalyticsTable[] => {
  const itemsColumn: AnalyticsColumn = { label: t('frameleaf_analytics_col_items'), unit: 'items' };
  const breakdown = (id: string, title: string, label: string, rows: BreakdownRow[]): AnalyticsTable => ({
    id,
    title,
    measurementScope: selection,
    columns: [{ label, unit: 'text' }, itemsColumn],
    rows: rows.map((row) => [row.label, row.count]),
  });
  const people = insights.peopleAndPlaces;
  return [
    {
      id: 'years',
      title: t('frameleaf_analytics_years_table'),
      measurementScope: selection,
      columns: [{ label: t('frameleaf_analytics_col_year'), unit: 'text' }, itemsColumn],
      rows: insights.capturesByYear.map((row) => [String(row.year), row.count]),
    },
    {
      id: 'punchcard',
      title: t('frameleaf_analytics_punchcard_table'),
      measurementScope: selection,
      columns: [
        { label: t('frameleaf_analytics_col_weekday'), unit: 'text' },
        { label: t('frameleaf_analytics_col_hour'), unit: 'text' },
        itemsColumn,
      ],
      rows: insights.punchcard.map((cell) => [
        t(`frameleaf_analytics_weekday_${cell.weekday}`),
        `${String(cell.hour).padStart(2, '0')}:00`,
        cell.count,
      ]),
    },
    breakdown('lenses', t('frameleaf_analytics_lenses'), t('frameleaf_analytics_col_lens'), lensRows(insights, t)),
    breakdown(
      'focal-lengths',
      t('frameleaf_analytics_focal_lengths'),
      t('frameleaf_analytics_col_focal_length'),
      focalRows(insights, t),
    ),
    breakdown(
      'photo-formats',
      t('frameleaf_analytics_photo_formats'),
      t('frameleaf_analytics_col_format'),
      photoFormatRows(insights, t),
    ),
    breakdown(
      'video-resolutions',
      t('frameleaf_analytics_video_resolution'),
      t('frameleaf_analytics_col_resolution'),
      videoResolutionRows(insights, t),
    ),
    breakdown(
      'orientation',
      t('frameleaf_analytics_orientation'),
      t('frameleaf_analytics_col_orientation'),
      orientationRows(insights, t),
    ),
    ...(people
      ? [
          breakdown(
            'places',
            t('frameleaf_analytics_places'),
            t('frameleaf_analytics_col_place'),
            placeRows(insights, t),
          ),
          {
            id: 'people',
            title: t('frameleaf_analytics_top_people'),
            measurementScope: selection,
            columns: [{ label: t('frameleaf_analytics_col_person'), unit: 'text' }, itemsColumn],
            rows: people.topPeople.map((person) => [person.name, person.count]),
          } satisfies AnalyticsTable,
        ]
      : []),
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
  const safe = typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
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
    // Every text and date column names the row, so a row keyed by two columns (the punchcard's
    // weekday and hour) keeps both: "Monday · 09:00".
    const isLabel = (column: AnalyticsColumn) => column.unit === 'text' || column.unit === 'date';
    const labelColumns = table.columns.flatMap((column, index) => (isLabel(column) ? [index] : []));
    for (const [rowIndex, row] of table.rows.entries()) {
      const rowLabel = labelColumns.map((index) => row[index] ?? '').join(' · ');
      for (const [index, column] of table.columns.entries()) {
        if (isLabel(column)) {
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
