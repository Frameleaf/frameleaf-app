import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { vitest } from 'vitest';
import type {
  AnalyticsInsightRows,
  AnalyticsInventory,
  AnalyticsScopeTargets,
} from 'src/repositories/analytics.repository.js';
import type { AnalyticsSampleInsert } from 'src/utils/analytics.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AnalyticsRange,
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AnalyticsState,
  JobName,
  JobStatus,
} from 'src/enum.js';
import { AnalyticsService } from 'src/services/analytics.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { factory } from 'test/small.factory.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '33333333-3333-4333-8333-333333333333';
const USER_LIBRARY = '44444444-4444-4444-8444-444444444444';
const OTHER_LIBRARY = '55555555-5555-4555-8555-555555555555';
const MISSING = '66666666-6666-4666-8666-666666666666';

const targets: AnalyticsScopeTargets = {
  users: [
    { id: ADMIN_ID, name: 'Admin', deletedAt: null },
    { id: USER_ID, name: 'Taylor', deletedAt: null },
    { id: OTHER_ID, name: 'Jamie', deletedAt: new Date('2026-09-01T00:00:00Z') },
  ],
  libraries: [
    { id: USER_LIBRARY, name: 'Family archive', ownerId: USER_ID, deletedAt: null },
    { id: OTHER_LIBRARY, name: 'Trail camera', ownerId: OTHER_ID, deletedAt: null },
  ],
};

const inventory = (overrides: Partial<AnalyticsInventory> = {}): AnalyticsInventory => ({
  photos: 90,
  videos: 10,
  raw: 5,
  timelinePhotos: 70,
  timelineVideos: 8,
  archivePhotos: 15,
  archiveVideos: 1,
  trashPhotos: 5,
  trashVideos: 1,
  favoritePhotos: 12,
  favoriteVideos: 2,
  withCaptureDate: 98,
  withLocation: 60,
  withCameraModel: 91,
  withAiDescription: 40,
  files: 104,
  unmeasuredFiles: 1,
  logicalBytes: 10_000,
  uploadedLogicalBytes: 7000,
  externalLogicalBytes: 3000,
  ...overrides,
});

const insightRows = (overrides: Partial<AnalyticsInsightRows> = {}): AnalyticsInsightRows => ({
  items: 100,
  years: [
    { year: 2024, count: 60 },
    { year: 2026, count: 40 },
  ],
  punchcard: [
    { weekday: 6, hour: 17, count: 70 },
    { weekday: 1, hour: 9, count: 30 },
  ],
  lenses: [
    { name: 'RF 24-70mm', count: 50 },
    { name: null, count: 50 },
  ],
  focalLengths: [
    { bucket: '17-28', count: 60 },
    { bucket: 'unknown', count: 40 },
  ],
  photoFormats: [
    { format: 'HEIC', count: 60 },
    { format: 'RAW', count: 5 },
    { format: 'JPEG', count: 25 },
  ],
  videoResolutions: [
    { resolution: '4K', count: 6 },
    { resolution: 'unknown', count: 4 },
  ],
  orientation: [
    { orientation: 'landscape', count: 70 },
    { orientation: 'portrait', count: 30 },
  ],
  livePhotos: 12,
  hdr: { probedVideos: 0, hdrVideos: 0, dolbyVisionVideos: 0 },
  coverage: { facesChecked: 90, searchIndexed: 95 },
  records: {
    oldest: { localDateTime: new Date('2009-06-14T08:00:00.000Z'), name: 'IMG_0001.JPG' },
    largest: { bytes: 9000, name: 'clip.mov' },
    longest: { durationMs: 5_400_000, name: 'clip.mov' },
    videoDurationMs: 9_000_000,
  },
  people: null,
  ...overrides,
});

describe(AnalyticsService.name, () => {
  const logger = { setContext: vitest.fn(), warn: vitest.fn(), error: vitest.fn(), log: vitest.fn() };
  const analyticsRepository = {
    getScopeTargets: vitest.fn(),
    getInventory: vitest.fn(),
    getPhysical: vitest.fn(),
    getArrivalsByDay: vitest.fn(),
    getCapturesByDay: vitest.fn(),
    getCameras: vitest.fn(),
    getAlbums: vitest.fn(),
    getProcessingByDay: vitest.fn(),
    getSamples: vitest.fn(),
    getLatestObservation: vitest.fn(),
    getLatestHostSamples: vitest.fn(),
    getCollectorSnapshot: vitest.fn(),
    upsertSamples: vitest.fn(),
    applyRetention: vitest.fn(),
    getInsights: vitest.fn(),
    getDatabaseBytes: vitest.fn(),
  };
  const storageRepository = { checkDiskUsage: vitest.fn(), getFolderBytes: vitest.fn(), getDevice: vitest.fn() };
  const jobRepository = { queue: vitest.fn() };
  const configRepository = { getEnv: () => ({ configFile: undefined }) };
  const systemMetadataRepository = { get: vitest.fn() };
  const forkSchemaRepository = { overlayConfig: (config: unknown) => Promise.resolve(config) };

  let sut: AnalyticsService;

  const admin = () => factory.auth({ user: { id: ADMIN_ID, isAdmin: true } });
  const user = () => factory.auth({ user: { id: USER_ID, isAdmin: false } });

  beforeEach(() => {
    vitest.resetAllMocks();
    StorageCore.setMediaLocation('/data');
    vitest.useFakeTimers({ now: new Date('2026-09-19T12:00:00.000Z'), toFake: ['Date'] });
    analyticsRepository.getScopeTargets.mockResolvedValue(targets);
    analyticsRepository.getInventory.mockResolvedValue(inventory());
    analyticsRepository.getPhysical.mockResolvedValue({
      physicalBytes: 8000,
      uploadedPhysicalBytes: 5000,
      externalPhysicalBytes: 3000,
      sharedReferences: 4,
    });
    analyticsRepository.getArrivalsByDay.mockResolvedValue([
      { day: '2026-09-18', photos: 3, videos: 1 },
      { day: '2026-01-02', photos: 2, videos: 0 },
    ]);
    analyticsRepository.getCapturesByDay.mockResolvedValue([{ day: '2026-09-18', items: 2 }]);
    analyticsRepository.getCameras.mockResolvedValue([
      { make: 'Apple', model: 'iPhone 16 Pro', items: 80 },
      { make: null, model: null, items: 20 },
    ]);
    analyticsRepository.getAlbums.mockResolvedValue([]);
    analyticsRepository.getProcessingByDay.mockResolvedValue([
      { day: '2026-09-18', completed: 9, failed: 1, durationMs: 1000, costUsd: 0, costed: 0 },
    ]);
    analyticsRepository.getSamples.mockResolvedValue([]);
    analyticsRepository.getLatestObservation.mockResolvedValue(null);
    analyticsRepository.getLatestHostSamples.mockResolvedValue([]);
    analyticsRepository.getCollectorSnapshot.mockResolvedValue([]);
    analyticsRepository.applyRetention.mockResolvedValue({ downsampled: 0, deleted: 0 });
    analyticsRepository.getInsights.mockResolvedValue(insightRows());
    analyticsRepository.getDatabaseBytes.mockResolvedValue(50_000);
    storageRepository.getFolderBytes.mockResolvedValue(0);
    storageRepository.getDevice.mockResolvedValue(1);
    storageRepository.checkDiskUsage.mockResolvedValue({ total: 1_000_000, free: 400_000, available: 350_000 });
    clearConfigCache();
    systemMetadataRepository.get.mockResolvedValue({});
    sut = new AnalyticsService(
      logger as never,
      analyticsRepository as never,
      storageRepository as never,
      jobRepository as never,
      configRepository as never,
      systemMetadataRepository as never,
      forkSchemaRepository as never,
    );
  });

  afterEach(() => {
    vitest.useRealTimers();
  });

  describe('getScopes', () => {
    it('offers administrators the whole server, every account and every library', async () => {
      const { scopes } = await sut.getScopes(admin());
      expect(scopes.map((scope) => scope.value)).toEqual([
        'all',
        `account:${ADMIN_ID}`,
        `account:${USER_ID}`,
        `account:${OTHER_ID}`,
        `library:${USER_LIBRARY}`,
        `library:${OTHER_LIBRARY}`,
      ]);
      expect(
        scopes.find((scope) => scope.userId === OTHER_ID && scope.kind === AnalyticsScopeKind.Account)?.removed,
      ).toBe(true);
    });

    it('offers anybody else only their own account and libraries', async () => {
      const { scopes } = await sut.getScopes(user());
      expect(scopes.map((scope) => scope.value)).toEqual([`account:${USER_ID}`, `library:${USER_LIBRARY}`]);
    });
  });

  describe('getReport authorization', () => {
    const report = (auth: ReturnType<typeof admin>, scope: string) =>
      sut.getReport(auth, { scope, range: AnalyticsRange.Year });

    it('refuses the whole server to non-administrators', async () => {
      await expect(report(user(), 'all')).rejects.toBeInstanceOf(ForbiddenException);
      expect(analyticsRepository.getInventory).not.toHaveBeenCalled();
    });

    it("refuses another account's analytics to non-administrators", async () => {
      await expect(report(user(), `account:${OTHER_ID}`)).rejects.toBeInstanceOf(ForbiddenException);
      expect(analyticsRepository.getInventory).not.toHaveBeenCalled();
    });

    it("refuses another owner's library, and a missing library the same way", async () => {
      await expect(report(user(), `library:${OTHER_LIBRARY}`)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(report(user(), `library:${MISSING}`)).rejects.toBeInstanceOf(ForbiddenException);
      expect(analyticsRepository.getInventory).not.toHaveBeenCalled();
    });

    it('refuses scopes that are not ids', async () => {
      await expect(report(admin(), 'Taylor')).rejects.toBeInstanceOf(BadRequestException);
      await expect(report(admin(), 'account:../x')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets an account read itself and its own libraries', async () => {
      await expect(report(user(), `account:${USER_ID}`)).resolves.toMatchObject({ scopeLabel: 'Taylor' });
      await expect(report(user(), `library:${USER_LIBRARY}`)).resolves.toMatchObject({ scopeLabel: 'Family archive' });
      expect(analyticsRepository.getInventory).toHaveBeenCalledWith({
        kind: AnalyticsScopeKind.Library,
        libraryId: USER_LIBRARY,
      });
    });

    it('lets administrators read any account or library and tells them when one does not exist', async () => {
      await expect(report(admin(), `account:${OTHER_ID}`)).resolves.toMatchObject({ scopeLabel: 'Jamie' });
      await expect(report(admin(), `library:${OTHER_LIBRARY}`)).resolves.toBeDefined();
      await expect(report(admin(), `account:${MISSING}`)).rejects.toBeInstanceOf(NotFoundException);
      await expect(report(admin(), `library:${MISSING}`)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getReport', () => {
    it('reports the selection and the whole host separately, without inventing other usage', async () => {
      const result = await sut.getReport(admin(), { scope: `account:${USER_ID}`, range: AnalyticsRange.Year });
      expect(result.summary).toMatchObject({
        items: 100,
        logicalBytes: 10_000,
        physicalBytes: 8000,
        savedBytes: 2000,
        externalLogicalBytes: 3000,
        duplicateReferences: 4,
      });
      expect(result.host).toEqual({
        state: AnalyticsState.Measured,
        observedAt: '2026-09-19T12:00:00.000Z',
        volumeUsedBytes: 600_000,
        capacityBytes: 1_000_000,
        freeBytes: 350_000,
        breakdown: null,
      });
      expect(JSON.stringify(result)).not.toMatch(/other (libraries|host files)/i);
    });

    it('omits processing for an account instead of filling it', async () => {
      const result = await sut.getReport(admin(), { scope: `account:${USER_ID}`, range: AnalyticsRange.Year });
      expect(analyticsRepository.getProcessingByDay).not.toHaveBeenCalled();
      expect(result.processing).toMatchObject({ available: false, attempts: 0, estimatedCostUsd: null });
      expect(result.series.every((bucket) => bucket.completed === null && bucket.failed === null)).toBe(true);
      expect(result.definitions.find((item) => item.id === AnalyticsSeriesId.ProcessingCompleted)?.available).toBe(
        false,
      );
    });

    it('reports processing for the whole server, with no cost estimate when no attempt had a rate', async () => {
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(result.processing).toEqual({
        available: true,
        attempts: 10,
        completed: 9,
        failed: 1,
        durationMs: 1000,
        estimatedCostUsd: null,
        costedAttempts: 0,
        uncostedAttempts: 10,
      });
      expect(result.series.at(-1)).toMatchObject({ completed: 9, failed: 1 });
    });

    it('labels a cost from configured rates as an estimate', async () => {
      analyticsRepository.getProcessingByDay.mockResolvedValue([
        { day: '2026-09-18', completed: 3, failed: 1, durationMs: 10, costUsd: 0.0123, costed: 3 },
      ]);
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(result.processing).toMatchObject({ estimatedCostUsd: 0.0123, costedAttempts: 3, uncostedAttempts: 1 });
      expect(result.definitions.find((item) => item.id === AnalyticsSeriesId.ProcessingEstimatedCost)?.estimate).toBe(
        true,
      );
    });

    it('keeps days and buckets reconciled and leaves unobserved growth as gaps', async () => {
      analyticsRepository.getSamples.mockResolvedValue([
        { series: AnalyticsSeriesId.LibraryItems, value: 99, observedAt: new Date('2026-09-18T00:05:00Z') },
      ]);
      analyticsRepository.getLatestObservation.mockResolvedValue(new Date('2026-09-18T00:05:00Z'));
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      const uploaded = result.days.reduce((sum, row) => sum + row.uploaded, 0);
      const arrivals = result.series.reduce((sum, row) => sum + row.photos + row.videos, 0);
      expect(uploaded).toBe(arrivals);
      expect(uploaded).toBe(6);
      expect(result.days.reduce((sum, row) => sum + row.captured, 0)).toBe(2);
      expect(result.series.at(-1)).toMatchObject({ items: 99, logicalBytes: null });
      expect(result.series[0]).toMatchObject({ items: null, observedAt: null });
      expect(result.history.state).toBe(AnalyticsState.Measured);
    });

    it('shows history as unknown before the first collection', async () => {
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.NinetyDays });
      expect(result.history.state).toBe(AnalyticsState.Unknown);
      expect(result.series.every((bucket) => bucket.items === null)).toBe(true);
    });

    it('falls back to the last collected volume reading, marked stale, and never derives free space', async () => {
      storageRepository.checkDiskUsage.mockRejectedValue(new Error('EACCES'));
      analyticsRepository.getLatestHostSamples.mockResolvedValue([
        { series: AnalyticsSeriesId.HostVolumeUsedBytes, value: 500, observedAt: new Date('2026-09-10T00:00:00Z') },
        { series: AnalyticsSeriesId.HostCapacityBytes, value: 900, observedAt: new Date('2026-09-10T00:00:00Z') },
      ]);
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(result.host).toMatchObject({
        state: AnalyticsState.Stale,
        observedAt: '2026-09-10T00:00:00.000Z',
        volumeUsedBytes: 500,
        capacityBytes: 900,
        freeBytes: null,
      });
      // a stale volume is never mixed with live originals and database sizes
      expect(result.host.breakdown).toBeNull();
      expect(analyticsRepository.getDatabaseBytes).not.toHaveBeenCalled();
    });

    it('breaks the volume down for the whole server so the parts add up to the volume used', async () => {
      analyticsRepository.getLatestHostSamples.mockImplementation((series?: AnalyticsSeriesId[]) =>
        Promise.resolve(
          series?.includes(AnalyticsSeriesId.HostThumbnailBytes)
            ? [
                {
                  series: AnalyticsSeriesId.HostThumbnailBytes,
                  value: 20_000,
                  observedAt: new Date('2026-09-19T00:05:00Z'),
                },
                {
                  series: AnalyticsSeriesId.HostEncodedVideoBytes,
                  value: 30_000,
                  observedAt: new Date('2026-09-19T00:06:00Z'),
                },
              ]
            : [],
        ),
      );
      const { host } = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(host.breakdown).toEqual({
        originalsBytes: 5000,
        previewsBytes: 20_000,
        encodedVideoBytes: 30_000,
        onOtherDisk: [],
        generatedObservedAt: '2026-09-19T00:05:00.000Z',
        databaseBytes: 50_000,
        otherBytes: 600_000 - 5000 - 20_000 - 30_000 - 50_000,
        exceedsUsed: false,
      });
      const { originalsBytes, previewsBytes, encodedVideoBytes, databaseBytes, otherBytes } = host.breakdown!;
      expect(originalsBytes + previewsBytes! + encodedVideoBytes! + databaseBytes + otherBytes).toBe(
        host.volumeUsedBytes,
      );
    });

    it('keeps a generated folder on another disk out of the volume subtraction', async () => {
      analyticsRepository.getLatestHostSamples.mockImplementation((series?: AnalyticsSeriesId[]) =>
        Promise.resolve(
          series?.includes(AnalyticsSeriesId.HostThumbnailBytes)
            ? [
                // an older reading on the volume, then the folder moved to another disk
                {
                  series: AnalyticsSeriesId.HostThumbnailBytes,
                  value: 20_000,
                  observedAt: new Date('2026-09-17T00:05:00Z'),
                },
                {
                  series: AnalyticsSeriesId.HostThumbnailOtherDiskBytes,
                  value: 200_000,
                  observedAt: new Date('2026-09-19T00:05:00Z'),
                },
                {
                  series: AnalyticsSeriesId.HostEncodedVideoBytes,
                  value: 30_000,
                  observedAt: new Date('2026-09-19T00:06:00Z'),
                },
              ]
            : [],
        ),
      );
      const { host } = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(host.breakdown).toMatchObject({
        previewsBytes: 200_000,
        onOtherDisk: ['previews'],
        otherBytes: 600_000 - 5000 - 30_000 - 50_000,
        exceedsUsed: false,
      });
    });

    it('leaves generated sizes unknown before the first collection', async () => {
      const { host } = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(host.breakdown).toMatchObject({ previewsBytes: null, encodedVideoBytes: null, generatedObservedAt: null });
    });

    it('never reads the database size or the breakdown for an account or library', async () => {
      const { host } = await sut.getReport(user(), { scope: `account:${USER_ID}`, range: AnalyticsRange.Year });
      expect(host.breakdown ?? null).toBeNull();
      expect(analyticsRepository.getDatabaseBytes).not.toHaveBeenCalled();
    });

    it('reads cameras with the same hidden-content rules as the insights, and passes coverage through', async () => {
      const result = await sut.getReport(user(), { scope: `account:${USER_ID}`, range: AnalyticsRange.Year });
      expect(analyticsRepository.getCameras.mock.calls[0][1]).toEqual(
        analyticsRepository.getInsights.mock.calls[0][1].privacy,
      );
      expect(result.insights!.coverage).toEqual({ facesChecked: 90, searchIndexed: 95 });
    });

    it('shows the volume as unknown with neither a live nor a collected reading', async () => {
      storageRepository.checkDiskUsage.mockRejectedValue(new Error('EACCES'));
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      expect(result.host).toMatchObject({ state: AnalyticsState.Unknown, volumeUsedBytes: null, capacityBytes: null });
    });

    it('partitions timeline, archive and trash, with favorites overlapping', async () => {
      const result = await sut.getReport(admin(), { scope: 'all', range: AnalyticsRange.Year });
      const partition = result.views.filter((view) => !view.overlaps).reduce((sum, view) => sum + view.total, 0);
      expect(partition).toBe(result.summary.items);
      expect(result.views.find((view) => view.view === 'favorites')).toMatchObject({ total: 14, overlaps: true });
      expect(result.metadata.find((row) => row.field === 'location')).toEqual({
        field: 'location',
        present: 60,
        missing: 40,
        total: 100,
      });
      expect(result.cameras).toEqual([
        { name: 'Apple iPhone 16 Pro', count: 80, kind: 'model' },
        { name: null, count: 20, kind: 'unknown' },
      ]);
    });

    it('counts every album in scope but names only albums the viewer owns or belongs to', async () => {
      analyticsRepository.getAlbums.mockResolvedValue([
        { id: 'a1', name: 'Rockies', ownerId: USER_ID, ownerName: 'Taylor', members: 2, viewerHasAccess: true },
        { id: 'a2', name: 'Winter', ownerId: USER_ID, ownerName: 'Taylor', members: 0, viewerHasAccess: true },
        {
          id: 'a3',
          name: 'Private to Jamie',
          ownerId: OTHER_ID,
          ownerName: 'Jamie',
          members: 1,
          viewerHasAccess: false,
        },
      ]);
      const result = await sut.getReport(user(), { scope: `account:${USER_ID}`, range: AnalyticsRange.Year });
      expect(result.albums).toEqual({
        total: 3,
        owned: 2,
        shared: 2,
        ownedShared: 1,
        notShared: 1,
        unlisted: 1,
        albums: [
          { id: 'a1', name: 'Rockies', ownerName: 'Taylor', owned: true, shared: true },
          { id: 'a2', name: 'Winter', ownerName: 'Taylor', owned: true, shared: false },
        ],
      });
      expect(analyticsRepository.getAlbums).toHaveBeenCalledWith(expect.anything(), USER_ID);
    });
  });

  describe('handleCollect', () => {
    const written = () => analyticsRepository.upsertSamples.mock.calls[0][0] as AnalyticsSampleInsert[];

    it('keeps one generated folder when the other cannot be read', async () => {
      storageRepository.getFolderBytes.mockImplementation((folder: string) =>
        folder.endsWith('thumbs') ? Promise.reject(new Error('EACCES')) : Promise.resolve(700),
      );
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Success);
      const samples = written();
      expect(samples.find((row) => row.series === AnalyticsSeriesId.HostEncodedVideoBytes)?.value).toBe(700);
      expect(samples.some((row) => row.series === AnalyticsSeriesId.HostThumbnailBytes)).toBe(false);
    });

    it('records a generated folder on another device as on another disk', async () => {
      storageRepository.getDevice.mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('thumbs') ? 2 : 1),
      );
      storageRepository.getFolderBytes.mockResolvedValue(500);
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Success);
      const series = written().map((row) => row.series);
      expect(series).toContain(AnalyticsSeriesId.HostThumbnailOtherDiskBytes);
      expect(series).not.toContain(AnalyticsSeriesId.HostThumbnailBytes);
      expect(series).toContain(AnalyticsSeriesId.HostEncodedVideoBytes);
    });

    it('still measures the generated folders when the volume cannot be read', async () => {
      storageRepository.checkDiskUsage.mockRejectedValue(new Error('EIO'));
      storageRepository.getFolderBytes.mockResolvedValue(10);
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Success);
      const series = written().map((row) => row.series);
      expect(series).not.toContain(AnalyticsSeriesId.HostVolumeUsedBytes);
      expect(series).toContain(AnalyticsSeriesId.HostThumbnailBytes);
    });

    it('records every scope with id-only keys, zero for empty accounts and libraries', async () => {
      analyticsRepository.getCollectorSnapshot.mockResolvedValue([
        {
          kind: AnalyticsScopeKind.Host,
          id: null,
          items: 5,
          photos: 4,
          videos: 1,
          logicalBytes: 50,
          physicalBytes: 40,
        },
        {
          kind: AnalyticsScopeKind.Account,
          id: USER_ID,
          items: 5,
          photos: 4,
          videos: 1,
          logicalBytes: 50,
          physicalBytes: 40,
        },
      ]);
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Success);
      const samples = written();
      // host 5 library series + 2 volume series + 2 generated folders; 3 accounts and 2 libraries × 5 series
      expect(samples).toHaveLength(9 + 5 * 5);
      expect(storageRepository.getFolderBytes.mock.calls.map(([folder]) => folder)).toEqual([
        '/data/thumbs',
        '/data/encoded-video',
      ]);
      expect(samples.map((row) => row.series)).toEqual(
        expect.arrayContaining([AnalyticsSeriesId.HostThumbnailBytes, AnalyticsSeriesId.HostEncodedVideoBytes]),
      );
      expect(samples.every((row) => /^(host|account:[0-9a-f-]{36}|library:[0-9a-f-]{36})$/.test(row.scopeKey))).toBe(
        true,
      );
      expect(JSON.stringify(samples)).not.toMatch(/Taylor|Jamie|Family archive|Trail camera/);
      expect(samples.every((row) => row.grain === AnalyticsSampleGrain.Day)).toBe(true);
      expect(
        samples.find((row) => row.scopeKey === `account:${OTHER_ID}` && row.series === AnalyticsSeriesId.LibraryItems),
      ).toMatchObject({ value: 0, userId: OTHER_ID, libraryId: null });
      expect(samples.find((row) => row.series === AnalyticsSeriesId.HostVolumeUsedBytes)?.value).toBe(600_000);
      expect(samples.some((row) => row.scopeKey !== 'host' && row.series.startsWith('host.'))).toBe(false);
      // 120 days of daily readings and, by default, 730 days of weekly ones (FL-71 `analytics.historyDays`)
      expect(analyticsRepository.applyRetention).toHaveBeenCalledWith(
        new Date('2026-05-22T00:00:00.000Z'),
        new Date('2024-09-19T00:00:00.000Z'),
      );
    });

    it('keeps the history the administrator chose (FL-71)', async () => {
      systemMetadataRepository.get.mockResolvedValue({ analytics: { enabled: true, historyDays: 90 } });
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Success);
      expect(analyticsRepository.applyRetention).toHaveBeenCalledWith(
        new Date('2026-06-21T00:00:00.000Z'),
        new Date('2026-06-21T00:00:00.000Z'),
      );
    });

    it('collects nothing while local metrics are off, keeping the history (FL-71)', async () => {
      systemMetadataRepository.get.mockResolvedValue({ analytics: { enabled: false, historyDays: 365 } });
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Skipped);
      expect(analyticsRepository.upsertSamples).not.toHaveBeenCalled();
      expect(analyticsRepository.applyRetention).not.toHaveBeenCalled();
    });

    it('leaves a gap for the volume when it cannot be read, rather than writing zero', async () => {
      storageRepository.checkDiskUsage.mockRejectedValue(new Error('EIO'));
      await sut.handleCollect();
      expect(
        written().some((row) =>
          [AnalyticsSeriesId.HostVolumeUsedBytes, AnalyticsSeriesId.HostCapacityBytes].includes(row.series),
        ),
      ).toBe(false);
    });

    it('retries once automatically, then waits for the next run', async () => {
      analyticsRepository.getCollectorSnapshot.mockRejectedValue(new Error('connection reset'));
      await expect(sut.handleCollect()).resolves.toBe(JobStatus.Failed);
      expect(jobRepository.queue).toHaveBeenCalledWith({ name: JobName.AnalyticsCollect, data: { attempt: 1 } });

      jobRepository.queue.mockClear();
      await expect(sut.handleCollect({ attempt: 1 })).resolves.toBe(JobStatus.Failed);
      expect(jobRepository.queue).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  describe('insights (FL-79)', () => {
    const read = (auth: ReturnType<typeof user>, scope: string) =>
      sut.getReport(auth, { scope, range: AnalyticsRange.Year });

    it('fills every bucket so each breakdown adds up to the summary', async () => {
      const { insights, summary } = await read(user(), `account:${USER_ID}`);
      const total = (rows: Array<{ count: number }>) => rows.reduce((sum, { count }) => sum + count, 0);

      expect(insights!.punchcard).toHaveLength(168);
      expect(insights!.punchcard[0]).toEqual({ weekday: 1, hour: 0, count: 0 });
      expect(insights!.punchcard.find((cell) => cell.weekday === 6 && cell.hour === 17)?.count).toBe(70);
      expect(total(insights!.punchcard)).toBe(summary.items);
      expect(total(insights!.capturesByYear)).toBe(summary.items);
      expect(insights!.focalLengths.map(({ key }) => key)).toEqual([
        '0-16',
        '17-28',
        '29-40',
        '41-70',
        '71-135',
        '136-300',
        '301+',
        'unknown',
      ]);
      expect(total(insights!.focalLengths)).toBe(summary.items);
      expect(insights!.photoFormats).toEqual([
        { key: 'HEIC', count: 60 },
        { key: 'JPEG', count: 25 },
        { key: 'RAW', count: 5 },
        { key: 'PNG', count: 0 },
        { key: 'OTHER', count: 0 },
      ]);
      expect(total(insights!.photoFormats)).toBe(summary.photos);
      expect(insights!.photoFormats.find(({ key }) => key === 'RAW')?.count).toBe(summary.raw);
      expect(total(insights!.videoResolutions)).toBe(summary.videos);
      expect(total(insights!.orientation)).toBe(summary.items);
      expect(insights!.lenses).toEqual([
        { name: 'RF 24-70mm', kind: 'named', count: 50 },
        { name: null, kind: 'unknown', count: 50 },
      ]);
      expect(insights!.livePhotos).toBe(12);
    });

    it('leaves HDR out until a video stream has been read', async () => {
      await expect(read(user(), `account:${USER_ID}`)).resolves.toMatchObject({ insights: { hdr: null } });
      analyticsRepository.getInsights.mockResolvedValue(
        insightRows({ hdr: { probedVideos: 8, hdrVideos: 3, dolbyVisionVideos: 1 } }),
      );
      await expect(read(user(), `account:${USER_ID}`)).resolves.toMatchObject({
        insights: { hdr: { probedVideos: 8, hdrVideos: 3, dolbyVisionVideos: 1 } },
      });
    });

    it('reports records with dates and hours', async () => {
      const { insights } = await read(user(), `account:${USER_ID}`);
      expect(insights!.records).toEqual({
        oldestCapture: { date: '2009-06-14', name: 'IMG_0001.JPG' },
        largestFile: { bytes: 9000, name: 'clip.mov' },
        longestVideo: { durationMs: 5_400_000, name: 'clip.mov' },
        videoDurationMs: 9_000_000,
        videoHours: 2.5,
      });
    });

    it("reads names, people and places only for the owner's own scope", async () => {
      await read(user(), `account:${USER_ID}`);
      await read(user(), `library:${USER_LIBRARY}`);
      await read(admin(), `account:${OTHER_ID}`);
      await read(admin(), `library:${OTHER_LIBRARY}`);
      await read(admin(), 'all');
      expect(analyticsRepository.getInsights.mock.calls.map(([, options]) => options.ownerId)).toEqual([
        USER_ID,
        USER_ID,
        null,
        null,
        null,
      ]);
    });

    it('never names a Locked person or pet while the session is locked', async () => {
      const auth = {
        ...user(),
        hiddenContent: {
          userId: USER_ID,
          includeNsfw: false,
          tagIds: [],
          personIds: ['person-locked'],
          petIds: ['pet-locked'],
          scope: 'owned' as const,
        },
      };
      await read(auth, `account:${USER_ID}`);
      expect(analyticsRepository.getInsights).toHaveBeenCalledWith(
        { kind: AnalyticsScopeKind.Account, userId: USER_ID },
        {
          ownerId: USER_ID,
          suppressedPersonIds: ['person-locked'],
          suppressedPetIds: ['pet-locked'],
          privacy: { hiddenContent: auth.hiddenContent },
        },
      );
    });

    it('reports the items the session keeps hidden, which the breakdowns leave out', async () => {
      analyticsRepository.getInsights.mockResolvedValue(insightRows({ items: 97 }));
      const auth = { ...user(), hideNsfwAssets: true };
      const { insights, summary } = await read(auth, `account:${USER_ID}`);
      expect(insights!.hiddenItems).toBe(3);
      expect(summary.items - insights!.hiddenItems).toBe(97);
      expect(analyticsRepository.getInsights.mock.calls[0][1].privacy).toEqual({ excludeNsfw: true });
    });

    it('reconciles people and places to the items', async () => {
      analyticsRepository.getInsights.mockResolvedValue(
        insightRows({
          people: {
            faces: 150,
            itemsWithFaces: 58,
            namedPeople: 2,
            pets: 1,
            topPeople: [{ id: 'person-1', name: 'Emma', count: 40 }],
            geotagged: 64,
            countries: 2,
            cities: 3,
            places: [
              { name: 'Banff', count: 40 },
              { name: 'Jasper', count: 20 },
              { name: null, count: 40 },
            ],
          },
        }),
      );
      const { insights, summary } = await read(user(), `account:${USER_ID}`);
      const people = insights!.peopleAndPlaces!;
      expect(people.itemsWithFaces + people.itemsWithoutFaces).toBe(summary.items);
      expect(people.places.reduce((sum, { count }) => sum + count, 0)).toBe(summary.items);
      expect(people.places.at(-1)).toEqual({ name: null, kind: 'unknown', count: 40 });
    });
  });
});
