import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { vitest } from 'vitest';
import type { AnalyticsInventory, AnalyticsScopeTargets } from 'src/repositories/analytics.repository.js';
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
  };
  const storageRepository = { checkDiskUsage: vitest.fn() };
  const jobRepository = { queue: vitest.fn() };

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
    storageRepository.checkDiskUsage.mockResolvedValue({ total: 1_000_000, free: 400_000, available: 350_000 });
    sut = new AnalyticsService(
      logger as never,
      analyticsRepository as never,
      storageRepository as never,
      jobRepository as never,
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
      expect(result.host).toEqual({
        state: AnalyticsState.Stale,
        observedAt: '2026-09-10T00:00:00.000Z',
        volumeUsedBytes: 500,
        capacityBytes: 900,
        freeBytes: null,
      });
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
      // host 5 library series + 2 volume series; 3 accounts and 2 libraries × 5 series
      expect(samples).toHaveLength(7 + 5 * 5);
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
      expect(analyticsRepository.applyRetention).toHaveBeenCalledWith(
        new Date('2026-05-22T00:00:00.000Z'),
        new Date('2024-07-11T00:00:00.000Z'),
      );
    });

    it('leaves a gap for the volume when it cannot be read, rather than writing zero', async () => {
      storageRepository.checkDiskUsage.mockRejectedValue(new Error('EIO'));
      await sut.handleCollect();
      expect(written().some((row) => row.series.startsWith('host.'))).toBe(false);
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
});
