import {
  AnalyticsGrain,
  AnalyticsMeasurementScope,
  AnalyticsRange,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AnalyticsState,
  AnalyticsUnit,
} from 'src/enum.js';

/**
 * Scoped library analytics (FL-79), kept free of the database so the rules can be read and tested
 * on their own.
 *
 * Four things live here:
 *
 * 1. The series registry. Every number the analytics report shows is one of these series, with its
 *    unit, grain, source, owner and the scopes it can be read for. Nothing else is collected.
 * 2. Scopes. `all` (the whole server), `account:<uuid>` and `library:<uuid>`, and the id-only keys
 *    the collector stores them under.
 * 3. The report window: a date range cut into month or week buckets, the first and last of which
 *    may be partial.
 * 4. Binding collector samples to buckets. A bucket with no observation stays `null` — a gap — and
 *    the value before a gap is never carried across it.
 *
 * Two rules the whole feature keeps:
 *
 * - Host figures (the volume's capacity and use) are whole-host readings. They are never split
 *   between accounts or libraries, and nothing is ever subtracted from them: an account's logical
 *   usage taken away from the volume's use is not "other files", and it is not a saving.
 * - Nothing leaves the server. The collector reads this server's tables and file system and writes
 *   this server's database.
 */

export type AnalyticsSeriesDefinition = {
  id: AnalyticsSeriesId;
  unit: AnalyticsUnit;
  /** The finest step the series is defined at. */
  grain: AnalyticsGrain;
  /** Where the number comes from. */
  source: string;
  /** Which part of the product answers for it. */
  owner: 'library' | 'host' | 'processing';
  /** The selections it can be read for. */
  scopes: readonly AnalyticsScopeKind[];
  /** `host` series always describe the whole host, whatever is selected. */
  measurementScope: AnalyticsMeasurementScope;
  /** Written by the nightly collector (history), rather than read live from existing tables. */
  collected: boolean;
  /** An estimate, never a charge. */
  estimate: boolean;
};

const ALL_SCOPES = [AnalyticsScopeKind.Host, AnalyticsScopeKind.Account, AnalyticsScopeKind.Library] as const;
const HOST_ONLY = [AnalyticsScopeKind.Host] as const;

const collectedLibrarySeries = (
  id: AnalyticsSeriesId,
  unit: AnalyticsUnit,
  source: string,
): AnalyticsSeriesDefinition => ({
  id,
  unit,
  grain: AnalyticsGrain.Day,
  source,
  owner: 'library',
  scopes: ALL_SCOPES,
  measurementScope: AnalyticsMeasurementScope.Selection,
  collected: true,
  estimate: false,
});

const hostSeries = (id: AnalyticsSeriesId, source: string): AnalyticsSeriesDefinition => ({
  id,
  unit: AnalyticsUnit.Bytes,
  grain: AnalyticsGrain.Day,
  source,
  owner: 'host',
  scopes: HOST_ONLY,
  measurementScope: AnalyticsMeasurementScope.Host,
  collected: true,
  estimate: false,
});

const liveSeries = (
  id: AnalyticsSeriesId,
  unit: AnalyticsUnit,
  source: string,
  owner: AnalyticsSeriesDefinition['owner'],
  estimate = false,
): AnalyticsSeriesDefinition => ({
  id,
  unit,
  grain: AnalyticsGrain.Day,
  source,
  owner,
  scopes: owner === 'processing' ? HOST_ONLY : ALL_SCOPES,
  measurementScope: owner === 'processing' ? AnalyticsMeasurementScope.Host : AnalyticsMeasurementScope.Selection,
  collected: false,
  estimate,
});

export const ANALYTICS_SERIES: readonly AnalyticsSeriesDefinition[] = Object.freeze([
  collectedLibrarySeries(AnalyticsSeriesId.LibraryItems, AnalyticsUnit.Items, 'asset table, nightly collector'),
  collectedLibrarySeries(AnalyticsSeriesId.LibraryPhotos, AnalyticsUnit.Items, 'asset table, nightly collector'),
  collectedLibrarySeries(AnalyticsSeriesId.LibraryVideos, AnalyticsUnit.Items, 'asset table, nightly collector'),
  collectedLibrarySeries(
    AnalyticsSeriesId.LibraryLogicalBytes,
    AnalyticsUnit.Bytes,
    'original file sizes, every reference counted, nightly collector',
  ),
  collectedLibrarySeries(
    AnalyticsSeriesId.LibraryPhysicalBytes,
    AnalyticsUnit.Bytes,
    'original files, each shared file counted once, nightly collector',
  ),
  hostSeries(AnalyticsSeriesId.HostVolumeUsedBytes, 'library volume file system, nightly collector'),
  hostSeries(AnalyticsSeriesId.HostCapacityBytes, 'library volume file system, nightly collector'),
  hostSeries(AnalyticsSeriesId.HostThumbnailBytes, 'thumbnail and preview folder, nightly collector'),
  hostSeries(AnalyticsSeriesId.HostEncodedVideoBytes, 'encoded video folder, nightly collector'),
  hostSeries(
    AnalyticsSeriesId.HostThumbnailOtherDiskBytes,
    'thumbnail and preview folder when it is on another disk than the library, nightly collector',
  ),
  hostSeries(
    AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes,
    'encoded video folder when it is on another disk than the library, nightly collector',
  ),
  liveSeries(AnalyticsSeriesId.Arrivals, AnalyticsUnit.Items, 'asset table, by the day each item was added', 'library'),
  liveSeries(
    AnalyticsSeriesId.Captures,
    AnalyticsUnit.Items,
    'asset table, by the local date each item was taken',
    'library',
  ),
  liveSeries(
    AnalyticsSeriesId.ProcessingCompleted,
    AnalyticsUnit.Attempts,
    'machine-learning request accounting',
    'processing',
  ),
  liveSeries(
    AnalyticsSeriesId.ProcessingFailed,
    AnalyticsUnit.Attempts,
    'machine-learning request accounting',
    'processing',
  ),
  liveSeries(
    AnalyticsSeriesId.ProcessingEstimatedCost,
    AnalyticsUnit.Usd,
    'machine-learning request accounting at each destination’s configured hourly rate; not a bill',
    'processing',
    true,
  ),
]);

/** Series the collector writes for one kind of scope. */
export const collectedSeriesFor = (kind: AnalyticsScopeKind) =>
  ANALYTICS_SERIES.filter((series) => series.collected && series.scopes.includes(kind)).map((series) => series.id);

/** The series a scope's growth history is drawn from. */
export const GROWTH_SERIES = [
  AnalyticsSeriesId.LibraryItems,
  AnalyticsSeriesId.LibraryLogicalBytes,
  AnalyticsSeriesId.LibraryPhysicalBytes,
] as const;

export type GrowthSeriesId = (typeof GROWTH_SERIES)[number];

// ── Retention ─────────────────────────────────────────────────────────────

/** Day samples are kept this long: the 90-day view at daily resolution, with margin. */
export const ANALYTICS_DAY_RETENTION_DAYS = 120;
// Week samples (downsampled days) are kept for the administrator's `analytics.historyDays` (FL-71).
/** A collector reading older than this is shown as stale. The collector runs nightly. */
export const ANALYTICS_STALE_AFTER_HOURS = 36;
/** Automatic retries a failed collection gets before it waits for the next night or a manual run. */
export const ANALYTICS_AUTO_RETRIES = 1;
/** How long the collector's automatic retry waits. */
export const ANALYTICS_AUTO_RETRY_DELAY_MS = 5 * 60_000;

// ── Scopes ────────────────────────────────────────────────────────────────

export type AnalyticsScope =
  | { kind: AnalyticsScopeKind.Host }
  | { kind: AnalyticsScopeKind.Account; userId: string }
  | { kind: AnalyticsScopeKind.Library; libraryId: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SCOPE_VALUE = new RegExp(`^(?:all|account:${UUID}|library:${UUID})$`);
const SCOPE_KEY = new RegExp(`^(?:host|account:${UUID}|library:${UUID})$`);

/** `all`, `account:<uuid>` or `library:<uuid>`; anything else is `null`. */
export const parseAnalyticsScope = (value: string): AnalyticsScope | null => {
  const normalized = value.trim().toLowerCase();
  if (!SCOPE_VALUE.test(normalized)) {
    return null;
  }
  if (normalized === 'all') {
    return { kind: AnalyticsScopeKind.Host };
  }
  const [kind, id] = normalized.split(':', 2);
  return kind === 'account'
    ? { kind: AnalyticsScopeKind.Account, userId: id }
    : { kind: AnalyticsScopeKind.Library, libraryId: id };
};

/** The value a client selects: `all`, `account:<uuid>` or `library:<uuid>`. */
export const analyticsScopeValue = (scope: AnalyticsScope) => {
  switch (scope.kind) {
    case AnalyticsScopeKind.Host: {
      return 'all';
    }
    case AnalyticsScopeKind.Account: {
      return `account:${scope.userId}`;
    }
    case AnalyticsScopeKind.Library: {
      return `library:${scope.libraryId}`;
    }
  }
};

/** The key the collector stores a scope under. Ids only: never a name. */
export const analyticsScopeKey = (scope: AnalyticsScope) =>
  scope.kind === AnalyticsScopeKind.Host ? 'host' : analyticsScopeValue(scope);

export type AnalyticsSampleInsert = {
  series: AnalyticsSeriesId;
  scopeKey: string;
  userId: string | null;
  libraryId: string | null;
  grain: AnalyticsSampleGrain;
  bucketStart: Date;
  value: number;
  observedAt: Date;
};

/**
 * Refuse any sample that is not an approved collected series for its scope, whose key is not ids
 * alone, or whose value is not a whole, non-negative number. This is what keeps names, paths,
 * prompts, credentials and job payloads out of stored history: there is nowhere for them to go.
 */
export const assertApprovedSample = (sample: AnalyticsSampleInsert) => {
  const definition = ANALYTICS_SERIES.find((series) => series.id === sample.series);
  if (!definition?.collected) {
    throw new Error(`Analytics series ${sample.series} is not collected`);
  }
  if (!SCOPE_KEY.test(sample.scopeKey)) {
    throw new Error('Analytics scope keys are host, account:<uuid> or library:<uuid>');
  }
  const [prefix, id = null] = sample.scopeKey.split(':', 2);
  const kind = prefix === 'host' ? AnalyticsScopeKind.Host : (prefix as AnalyticsScopeKind);
  if (!definition.scopes.includes(kind)) {
    throw new Error(`Analytics series ${sample.series} is not defined for the ${kind} scope`);
  }
  const expectedUser = kind === AnalyticsScopeKind.Account ? id : null;
  const expectedLibrary = kind === AnalyticsScopeKind.Library ? id : null;
  if (sample.userId !== expectedUser || sample.libraryId !== expectedLibrary) {
    throw new Error('Analytics sample ids must match its scope key');
  }
  if (!Number.isSafeInteger(sample.value) || sample.value < 0) {
    throw new Error('Analytics sample values are whole, non-negative numbers');
  }
  if (!Object.values(AnalyticsSampleGrain).includes(sample.grain)) {
    throw new Error('Unknown analytics sample grain');
  }
  return sample;
};

// ── Dates and windows ─────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a UTC instant. */
export const isoDay = (value: Date | number) => new Date(value).toISOString().slice(0, 10);

export const parseIsoDay = (day: string) => new Date(`${day}T00:00:00.000Z`);

export const addDays = (day: string, days: number) => isoDay(parseIsoDay(day).getTime() + days * DAY_MS);

/** The later of two `YYYY-MM-DD` days (they compare as strings, not numbers). */
const laterDay = (a: string, b: string) => [a, b].toSorted().at(-1)!;

/** The earlier of two `YYYY-MM-DD` days. */
const earlierDay = (a: string, b: string) => [a, b].toSorted()[0];

/** The Monday that starts the ISO week holding `day`. */
export const weekStartOf = (day: string) => addDays(day, -((parseIsoDay(day).getUTCDay() + 6) % 7));

export type AnalyticsBucketWindow = {
  /** `YYYY-MM` for a month bucket, the Monday's `YYYY-MM-DD` for a week bucket. */
  key: string;
  from: string;
  through: string;
  /** The bucket is cut short by the edge of the selected dates. */
  partial: boolean;
};

export type AnalyticsWindow = {
  range: AnalyticsRange;
  from: string;
  through: string;
  buckets: AnalyticsBucketWindow[];
};

/**
 * The dates a report covers, through today (UTC).
 *
 * - `year`: twelve calendar months, the current one included, bucketed by month. The current month
 *   is partial until its last day.
 * - `90days`: the last ninety days, bucketed by ISO week (Monday first). The first and last weeks
 *   are cut to the window and marked partial.
 */
export const analyticsWindow = (range: AnalyticsRange, now: Date): AnalyticsWindow => {
  const through = isoDay(now);
  if (range === AnalyticsRange.Year) {
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    const buckets: AnalyticsBucketWindow[] = [];
    for (let offset = 11; offset >= 0; offset--) {
      const start = new Date(Date.UTC(year, month - offset, 1));
      const monthEnd = isoDay(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
      const bucketThrough = offset === 0 ? through : monthEnd;
      buckets.push({
        key: isoDay(start).slice(0, 7),
        from: isoDay(start),
        through: bucketThrough,
        partial: bucketThrough !== monthEnd,
      });
    }
    return { range, from: buckets[0].from, through, buckets };
  }

  const from = addDays(through, -89);
  const buckets: AnalyticsBucketWindow[] = [];
  for (let week = weekStartOf(from); week <= through; week = addDays(week, 7)) {
    const lastDay = addDays(week, 6);
    const bucketFrom = laterDay(week, from);
    const bucketThrough = earlierDay(lastDay, through);
    buckets.push({
      key: week,
      from: bucketFrom,
      through: bucketThrough,
      partial: bucketFrom !== week || bucketThrough !== lastDay,
    });
  }
  return { range, from, through, buckets };
};

/** Every day of the window, in order. */
export const windowDays = (window: Pick<AnalyticsWindow, 'from' | 'through'>) => {
  const days: string[] = [];
  for (let day = window.from; day <= window.through; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
};

// ── Binding samples and daily rows to buckets ─────────────────────────────

export type AnalyticsSampleRow = { series: AnalyticsSeriesId; value: number; observedAt: Date };

export type BoundGrowth = Record<GrowthSeriesId, number | null> & { observedAt: Date | null };

/**
 * The latest observation of each growth series inside each bucket, by the day it was observed.
 *
 * A bucket without an observation of a series gets `null`: a gap, shown as missing. The last value
 * before a gap is never carried into it, and a value that went down (items removed, a library
 * detached, history cleared and started again) is shown as it was read, not smoothed.
 */
export const bindGrowth = (buckets: AnalyticsBucketWindow[], samples: AnalyticsSampleRow[]): BoundGrowth[] =>
  buckets.map((bucket) => {
    const inBucket = samples.filter((sample) => {
      const day = isoDay(sample.observedAt);
      return day >= bucket.from && day <= bucket.through;
    });
    const bound = { observedAt: null } as BoundGrowth;
    for (const series of GROWTH_SERIES) {
      let latest: AnalyticsSampleRow | null = null;
      for (const sample of inBucket) {
        if (sample.series === series && (!latest || sample.observedAt > latest.observedAt)) {
          latest = sample;
        }
      }
      bound[series] = latest ? latest.value : null;
      if (latest && (!bound.observedAt || latest.observedAt > bound.observedAt)) {
        bound.observedAt = latest.observedAt;
      }
    }
    return bound;
  });

/**
 * Sum per-day rows into buckets. A day the table has no row for counts as zero: these series are
 * read from tables that hold every retained item or recorded request, so a missing day had none.
 */
export const sumIntoBuckets = <K extends string>(
  buckets: AnalyticsBucketWindow[],
  rows: Array<{ day: string } & Record<K, number>>,
  keys: readonly K[],
) =>
  buckets.map((bucket) => {
    const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
    for (const row of rows) {
      if (row.day >= bucket.from && row.day <= bucket.through) {
        for (const key of keys) {
          totals[key] += row[key];
        }
      }
    }
    return totals;
  });

/** Whether the newest collector reading is missing, too old, or current. */
export const historyState = (lastObservedAt: Date | null, now: Date) => {
  if (!lastObservedAt) {
    return AnalyticsState.Unknown;
  }
  return now.getTime() - lastObservedAt.getTime() > ANALYTICS_STALE_AFTER_HOURS * 3_600_000
    ? AnalyticsState.Stale
    : AnalyticsState.Measured;
};

// ── Cameras ───────────────────────────────────────────────────────────────

/** How many camera models the report names before grouping the rest. */
export const ANALYTICS_CAMERA_LIMIT = 7;

export type CameraRow = { name: string | null; count: number };
export type CameraGroup = { name: string | null; count: number; kind: 'model' | 'other' | 'unknown' };

/**
 * The most common models by name, then every other model as one row, then items with no model.
 * The rows always add up to every item counted.
 */
export const groupCameras = (rows: CameraRow[], limit = ANALYTICS_CAMERA_LIMIT): CameraGroup[] => {
  const merged = new Map<string, number>();
  let unknown = 0;
  for (const row of rows) {
    if (row.name) {
      merged.set(row.name, (merged.get(row.name) ?? 0) + row.count);
    } else {
      unknown += row.count;
    }
  }
  const known = [...merged].toSorted(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b));
  const groups: CameraGroup[] = known.slice(0, limit).map(([name, count]) => ({ name, count, kind: 'model' }));
  const rest = known.slice(limit).reduce((sum, [, count]) => sum + count, 0);
  if (rest > 0) {
    groups.push({ name: null, count: rest, kind: 'other' });
  }
  if (unknown > 0) {
    groups.push({ name: null, count: unknown, kind: 'unknown' });
  }
  return groups;
};

// ── Insights (FL-79) ──────────────────────────────────────────────────────

/** How many lenses, places and people the dashboard names before grouping the rest. */
export const ANALYTICS_LENS_LIMIT = 7;
export const ANALYTICS_PLACE_LIMIT = 8;
export const ANALYTICS_TOP_PEOPLE_LIMIT = 5;

export type NamedGroup = { name: string | null; count: number; kind: 'named' | 'other' | 'unknown' };

/**
 * The same partition as `groupCameras` for any named breakdown (lenses, places): the most common
 * names, one row for every other name, one for items without one. Always adds up to every item.
 */
export const groupNamed = (rows: CameraRow[], limit: number): NamedGroup[] =>
  groupCameras(rows, limit).map((row) => ({ ...row, kind: row.kind === 'model' ? 'named' : row.kind }));

/** Fixed rows in a fixed order, zero-filled, so a breakdown always lists every bucket. */
export const fixedBuckets = <K extends string>(keys: readonly K[], rows: Array<{ key: string; count: number }>) =>
  keys.map((key) => ({ key, count: rows.filter((row) => row.key === key).reduce((sum, row) => sum + row.count, 0) }));

/** A camera label from EXIF make and model, without repeating the make ("Canon Canon EOS R6"). */
export const cameraName = (make: string | null, model: string | null) => {
  const cleanMake = make?.trim() || '';
  const cleanModel = model?.trim() || '';
  if (!cleanModel) {
    return null;
  }
  if (!cleanMake || cleanModel.toLowerCase().startsWith(cleanMake.toLowerCase())) {
    return cleanModel;
  }
  return `${cleanMake} ${cleanModel}`;
};
