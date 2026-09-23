import {
  AnalyticsMeasurementScope,
  AnalyticsRange,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AnalyticsState,
} from 'src/enum.js';
import {
  ANALYTICS_SERIES,
  AnalyticsSampleInsert,
  analyticsScopeKey,
  analyticsWindow,
  assertApprovedSample,
  bindGrowth,
  cameraName,
  collectedSeriesFor,
  groupCameras,
  historyState,
  parseAnalyticsScope,
  sumIntoBuckets,
  weekStartOf,
  windowDays,
} from 'src/utils/analytics.js';

const userId = '3f1c7b2e-9d0a-4f4e-8c1b-2a6d5e7f9a10';
const libraryId = '9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d';

const sample = (overrides: Partial<AnalyticsSampleInsert> = {}): AnalyticsSampleInsert => ({
  series: AnalyticsSeriesId.LibraryItems,
  scopeKey: 'host',
  userId: null,
  libraryId: null,
  grain: AnalyticsSampleGrain.Day,
  bucketStart: new Date('2026-09-01T00:00:00.000Z'),
  value: 10,
  observedAt: new Date('2026-09-01T00:05:00.000Z'),
  ...overrides,
});

describe('analytics series registry', () => {
  it('defines unit, grain, source, owner and scopes for every series', () => {
    for (const series of ANALYTICS_SERIES) {
      expect(series.unit).toBeTruthy();
      expect(series.grain).toBeTruthy();
      expect(series.source.length).toBeGreaterThan(0);
      expect(['library', 'host', 'processing']).toContain(series.owner);
      expect(series.scopes.length).toBeGreaterThan(0);
    }
  });

  it('keeps host volume series whole-host and never offers them for an account or library', () => {
    for (const id of [AnalyticsSeriesId.HostVolumeUsedBytes, AnalyticsSeriesId.HostCapacityBytes]) {
      const series = ANALYTICS_SERIES.find((item) => item.id === id)!;
      expect(series.measurementScope).toBe(AnalyticsMeasurementScope.Host);
      expect(series.scopes).toEqual([AnalyticsScopeKind.Host]);
    }
    expect(collectedSeriesFor(AnalyticsScopeKind.Account)).not.toContain(AnalyticsSeriesId.HostVolumeUsedBytes);
  });

  it('marks estimated cost as an estimate and defines no invoiced or GPU series', () => {
    const cost = ANALYTICS_SERIES.find((item) => item.id === AnalyticsSeriesId.ProcessingEstimatedCost)!;
    expect(cost.estimate).toBe(true);
    expect(cost.source).toMatch(/not a bill/);
    expect(ANALYTICS_SERIES.filter((item) => item.estimate)).toHaveLength(1);
    expect(ANALYTICS_SERIES.map((item) => item.id).join(' ')).not.toMatch(/gpu|invoice|billed|charged/i);
  });
});

describe('parseAnalyticsScope', () => {
  it('reads the three scope forms', () => {
    expect(parseAnalyticsScope('all')).toEqual({ kind: AnalyticsScopeKind.Host });
    expect(parseAnalyticsScope(`account:${userId}`)).toEqual({ kind: AnalyticsScopeKind.Account, userId });
    expect(parseAnalyticsScope(`library:${libraryId}`)).toEqual({ kind: AnalyticsScopeKind.Library, libraryId });
  });

  it('refuses names, paths and anything else', () => {
    for (const value of ['', 'taylor', 'account:taylor', `user:${userId}`, 'library:../etc', `account:${userId}x`]) {
      expect(parseAnalyticsScope(value)).toBeNull();
    }
  });

  it('stores scopes under id-only keys', () => {
    expect(analyticsScopeKey({ kind: AnalyticsScopeKind.Host })).toBe('host');
    expect(analyticsScopeKey({ kind: AnalyticsScopeKind.Account, userId })).toBe(`account:${userId}`);
  });
});

describe('assertApprovedSample', () => {
  it('accepts approved samples', () => {
    expect(() => assertApprovedSample(sample())).not.toThrow();
    expect(() =>
      assertApprovedSample(
        sample({ scopeKey: `account:${userId}`, userId, series: AnalyticsSeriesId.LibraryPhysicalBytes }),
      ),
    ).not.toThrow();
    expect(() => assertApprovedSample(sample({ scopeKey: `library:${libraryId}`, libraryId }))).not.toThrow();
  });

  it('refuses labels that could carry a name, path, prompt, credential or payload', () => {
    for (const scopeKey of ['account:Jamie', 'host:/mnt/photos', 'library:{"prompt":"x"}', 'Bearer abc', '']) {
      expect(() => assertApprovedSample(sample({ scopeKey }))).toThrow();
    }
  });

  it('refuses series that are not collected or not defined for the scope', () => {
    expect(() => assertApprovedSample(sample({ series: AnalyticsSeriesId.ProcessingEstimatedCost }))).toThrow();
    expect(() => assertApprovedSample(sample({ series: 'gpu.utilization' as AnalyticsSeriesId }))).toThrow();
    expect(() =>
      assertApprovedSample(
        sample({ series: AnalyticsSeriesId.HostCapacityBytes, scopeKey: `account:${userId}`, userId }),
      ),
    ).toThrow();
  });

  it('refuses ids that disagree with the key and values that are not whole counts', () => {
    expect(() => assertApprovedSample(sample({ scopeKey: `account:${userId}`, userId: null }))).toThrow();
    expect(() => assertApprovedSample(sample({ userId }))).toThrow();
    expect(() => assertApprovedSample(sample({ value: -1 }))).toThrow();
    expect(() => assertApprovedSample(sample({ value: 1.5 }))).toThrow();
    expect(() => assertApprovedSample(sample({ value: NaN }))).toThrow();
  });
});

describe('analyticsWindow', () => {
  it('cuts twelve months into month buckets ending today', () => {
    const window = analyticsWindow(AnalyticsRange.Year, new Date('2026-09-19T12:00:00.000Z'));
    expect(window.from).toBe('2025-10-01');
    expect(window.through).toBe('2026-09-19');
    expect(window.buckets).toHaveLength(12);
    expect(window.buckets[0]).toEqual({ key: '2025-10', from: '2025-10-01', through: '2025-10-31', partial: false });
    expect(window.buckets[4]).toEqual({ key: '2026-02', from: '2026-02-01', through: '2026-02-28', partial: false });
    expect(window.buckets.at(-1)).toEqual({ key: '2026-09', from: '2026-09-01', through: '2026-09-19', partial: true });
  });

  it('cuts ninety days into Monday weeks and marks the clipped edges partial (reset window)', () => {
    const window = analyticsWindow(AnalyticsRange.NinetyDays, new Date('2026-09-19T23:59:00.000Z'));
    expect(window.from).toBe('2026-06-22');
    expect(windowDays(window)).toHaveLength(90);
    const first = window.buckets[0];
    expect(first.key).toBe(weekStartOf('2026-06-22'));
    expect(first.from).toBe('2026-06-22');
    const last = window.buckets.at(-1)!;
    expect(last).toMatchObject({ key: '2026-09-14', from: '2026-09-14', through: '2026-09-19', partial: true });
    // Buckets tile the window exactly: no day counted twice, none left out.
    const covered = window.buckets.flatMap((bucket) => windowDays(bucket));
    expect(covered).toEqual(windowDays(window));
  });

  it('keeps the window edge at the report date when the week began before it', () => {
    const window = analyticsWindow(AnalyticsRange.NinetyDays, new Date('2026-09-17T00:00:00.000Z'));
    const first = window.buckets[0];
    expect(first.from).toBe(window.from);
    expect(first.partial).toBe(first.key !== window.from);
  });
});

describe('bindGrowth', () => {
  const window = analyticsWindow(AnalyticsRange.Year, new Date('2026-09-19T12:00:00.000Z'));
  const at = (iso: string, series: AnalyticsSeriesId, value: number) => ({ series, value, observedAt: new Date(iso) });

  it('leaves buckets without observations as gaps instead of zero or carried values (missing observations)', () => {
    const bound = bindGrowth(window.buckets, [
      at('2026-06-10T00:00:00Z', AnalyticsSeriesId.LibraryItems, 900),
      at('2026-08-31T00:00:00Z', AnalyticsSeriesId.LibraryItems, 1000),
    ]);
    const byKey = Object.fromEntries(window.buckets.map((bucket, index) => [bucket.key, bound[index]]));
    expect(byKey['2026-06'][AnalyticsSeriesId.LibraryItems]).toBe(900);
    expect(byKey['2026-07'][AnalyticsSeriesId.LibraryItems]).toBeNull();
    expect(byKey['2026-07'].observedAt).toBeNull();
    expect(byKey['2026-08'][AnalyticsSeriesId.LibraryItems]).toBe(1000);
    expect(byKey['2026-09'][AnalyticsSeriesId.LibraryItems]).toBeNull();
    expect(byKey['2025-10'][AnalyticsSeriesId.LibraryLogicalBytes]).toBeNull();
  });

  it('takes the newest reading in a bucket and shows a drop as read (reset or deletion)', () => {
    const bound = bindGrowth(window.buckets, [
      at('2026-08-01T00:00:00Z', AnalyticsSeriesId.LibraryItems, 5000),
      at('2026-08-20T00:00:00Z', AnalyticsSeriesId.LibraryItems, 120),
      at('2026-08-05T00:00:00Z', AnalyticsSeriesId.LibraryItems, 5100),
      at('2026-08-20T00:00:00Z', AnalyticsSeriesId.LibraryPhysicalBytes, 42),
    ]);
    const august = bound[window.buckets.findIndex((bucket) => bucket.key === '2026-08')];
    expect(august[AnalyticsSeriesId.LibraryItems]).toBe(120);
    expect(august[AnalyticsSeriesId.LibraryPhysicalBytes]).toBe(42);
    expect(august[AnalyticsSeriesId.LibraryLogicalBytes]).toBeNull();
    expect(august.observedAt?.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('ignores readings outside the window', () => {
    const bound = bindGrowth(window.buckets, [at('2025-09-30T23:00:00Z', AnalyticsSeriesId.LibraryItems, 1)]);
    expect(bound.every((bucket) => bucket[AnalyticsSeriesId.LibraryItems] === null)).toBe(true);
  });
});

describe('sumIntoBuckets', () => {
  it('adds daily rows into the bucket holding each day, and the totals reconcile', () => {
    const window = analyticsWindow(AnalyticsRange.NinetyDays, new Date('2026-09-19T12:00:00.000Z'));
    const rows = [
      { day: '2026-06-22', photos: 3, videos: 1 },
      { day: '2026-06-28', photos: 2, videos: 0 },
      { day: '2026-09-19', photos: 7, videos: 2 },
      { day: '2026-06-21', photos: 100, videos: 100 },
    ];
    const sums = sumIntoBuckets(window.buckets, rows, ['photos', 'videos'] as const);
    expect(sums[0]).toEqual({ photos: 5, videos: 1 });
    expect(sums.at(-1)).toEqual({ photos: 7, videos: 2 });
    expect(sums.reduce((total, row) => total + row.photos + row.videos, 0)).toBe(15);
  });
});

describe('historyState', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  it('is unknown before the first collection, stale after 36 hours, measured otherwise', () => {
    expect(historyState(null, now)).toBe(AnalyticsState.Unknown);
    expect(historyState(new Date('2026-09-19T00:00:00.000Z'), now)).toBe(AnalyticsState.Measured);
    expect(historyState(new Date('2026-09-17T23:00:00.000Z'), now)).toBe(AnalyticsState.Stale);
  });
});

describe('cameras', () => {
  it('names the leading models, groups the rest and keeps unknown visible, adding up to every item', () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, index) => ({ name: `Model ${index}`, count: 10 + index })),
      { name: null, count: 4 },
      { name: 'Model 8', count: 1 },
    ];
    const groups = groupCameras(rows);
    expect(groups.filter((group) => group.kind === 'model')).toHaveLength(7);
    expect(groups[0]).toEqual({ name: 'Model 8', count: 19, kind: 'model' });
    expect(groups.find((group) => group.kind === 'unknown')?.count).toBe(4);
    expect(groups.reduce((sum, group) => sum + group.count, 0)).toBe(rows.reduce((sum, row) => sum + row.count, 0));
  });

  it('builds names without repeating the make', () => {
    expect(cameraName('Canon', 'Canon EOS R6')).toBe('Canon EOS R6');
    expect(cameraName('Apple', 'iPhone 16 Pro')).toBe('Apple iPhone 16 Pro');
    expect(cameraName('Sony', ' ')).toBeNull();
    expect(cameraName(null, 'X100V')).toBe('X100V');
  });
});
