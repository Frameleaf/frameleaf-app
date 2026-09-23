import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import {
  AnalyticsBucketDto,
  AnalyticsQueryDto,
  AnalyticsReportResponseDto,
  AnalyticsScopeOption,
  AnalyticsScopesResponseDto,
} from 'src/dtos/analytics.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AnalyticsSampleGrain,
  AnalyticsScopeKind,
  AnalyticsSeriesId,
  AnalyticsState,
  JobName,
  JobStatus,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AnalyticsRepository, AnalyticsScopeTargets } from 'src/repositories/analytics.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import type { IAnalyticsCollectJob } from 'src/types.js';
import {
  ANALYTICS_AUTO_RETRIES,
  ANALYTICS_DAY_RETENTION_DAYS,
  ANALYTICS_SERIES,
  ANALYTICS_STALE_AFTER_HOURS,
  ANALYTICS_WEEK_RETENTION_DAYS,
  AnalyticsSampleInsert,
  AnalyticsScope,
  GROWTH_SERIES,
  addDays,
  analyticsScopeKey,
  analyticsScopeValue,
  analyticsWindow,
  bindGrowth,
  cameraName,
  collectedSeriesFor,
  groupCameras,
  historyState,
  isoDay,
  parseAnalyticsScope,
  parseIsoDay,
  sumIntoBuckets,
  windowDays,
} from 'src/utils/analytics.js';

type ResolvedScope = { scope: AnalyticsScope; label: string; ownerId: string | null };

/**
 * Scoped library analytics (FL-79): the report behind the command center's Library analytics
 * page, and the nightly local collector that gives it history.
 *
 * Who may read what:
 * - `all`, the whole server: administrators.
 * - `account:<id>`: administrators, and the account itself.
 * - `library:<id>`: administrators, and the library's owner.
 * Anybody else gets 403, and a library the reader does not own reads as forbidden whether or not it
 * exists, so the answer never says which ids are real.
 *
 * Nothing here talks to anything but this server's database and library volume.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private logger: LoggingRepository,
    private analyticsRepository: AnalyticsRepository,
    private storageRepository: StorageRepository,
    private jobRepository: JobRepository,
  ) {
    this.logger.setContext(AnalyticsService.name);
  }

  async getScopes(auth: AuthDto): Promise<AnalyticsScopesResponseDto> {
    const targets = await this.analyticsRepository.getScopeTargets();
    const isAdmin = auth.user.isAdmin;
    const scopes: AnalyticsScopeOption[] = [];
    if (isAdmin) {
      scopes.push({
        value: 'all',
        kind: AnalyticsScopeKind.Host,
        label: '',
        userId: null,
        libraryId: null,
        removed: false,
      });
    }
    for (const user of targets.users) {
      if (isAdmin || user.id === auth.user.id) {
        scopes.push({
          value: analyticsScopeValue({ kind: AnalyticsScopeKind.Account, userId: user.id }),
          kind: AnalyticsScopeKind.Account,
          label: user.name,
          userId: user.id,
          libraryId: null,
          removed: !!user.deletedAt,
        });
      }
    }
    for (const library of targets.libraries) {
      if (isAdmin || library.ownerId === auth.user.id) {
        scopes.push({
          value: analyticsScopeValue({ kind: AnalyticsScopeKind.Library, libraryId: library.id }),
          kind: AnalyticsScopeKind.Library,
          label: library.name,
          userId: library.ownerId,
          libraryId: library.id,
          removed: !!library.deletedAt,
        });
      }
    }
    return { scopes };
  }

  async getReport(auth: AuthDto, dto: AnalyticsQueryDto): Promise<AnalyticsReportResponseDto> {
    const now = new Date();
    const { scope, label, ownerId } = await this.resolveScope(auth, dto.scope);
    const window = analyticsWindow(dto.range, now);
    const scopeKey = analyticsScopeKey(scope);
    const isHost = scope.kind === AnalyticsScopeKind.Host;

    const [inventory, physical, arrivals, captures, cameras, albums, processing, samples, lastObservedAt, host] =
      await Promise.all([
        this.analyticsRepository.getInventory(scope),
        this.analyticsRepository.getPhysical(scope),
        this.analyticsRepository.getArrivalsByDay(scope, window.from, window.through),
        this.analyticsRepository.getCapturesByDay(scope, window.from, window.through),
        this.analyticsRepository.getCameras(scope),
        this.analyticsRepository.getAlbums(scope, auth.user.id),
        isHost ? this.analyticsRepository.getProcessingByDay(window.from, window.through) : Promise.resolve(null),
        this.analyticsRepository.getSamples(scopeKey, GROWTH_SERIES, parseIsoDay(window.from)),
        this.analyticsRepository.getLatestObservation(scopeKey),
        this.readHost(now),
      ]);

    const items = inventory.photos + inventory.videos;
    const growth = bindGrowth(window.buckets, samples);
    const arrivalTotals = sumIntoBuckets(window.buckets, arrivals, ['photos', 'videos'] as const);
    const processingTotals = processing
      ? sumIntoBuckets(window.buckets, processing, ['completed', 'failed'] as const)
      : null;

    const series: AnalyticsBucketDto[] = window.buckets.map((bucket, index) => ({
      key: bucket.key,
      from: bucket.from,
      through: bucket.through,
      partial: bucket.partial,
      photos: arrivalTotals[index].photos,
      videos: arrivalTotals[index].videos,
      completed: processingTotals ? processingTotals[index].completed : null,
      failed: processingTotals ? processingTotals[index].failed : null,
      items: growth[index][AnalyticsSeriesId.LibraryItems],
      logicalBytes: growth[index][AnalyticsSeriesId.LibraryLogicalBytes],
      physicalBytes: growth[index][AnalyticsSeriesId.LibraryPhysicalBytes],
      observedAt: growth[index].observedAt?.toISOString() ?? null,
    }));

    const capturedByDay = new Map(captures.map((row) => [row.day, row.items]));
    const uploadedByDay = new Map(arrivals.map((row) => [row.day, row.photos + row.videos]));
    const days = windowDays(window).map((date) => ({
      date,
      captured: capturedByDay.get(date) ?? 0,
      uploaded: uploadedByDay.get(date) ?? 0,
    }));

    const albumRows = albums.map((album) => ({
      ...album,
      owned: isHost || album.ownerId === ownerId,
      shared: album.members > 0,
    }));
    const listed = albumRows.filter((album) => album.viewerHasAccess);

    const attempts = processing?.reduce((sum, row) => sum + row.completed + row.failed, 0) ?? 0;
    const costed = processing?.reduce((sum, row) => sum + row.costed, 0) ?? 0;
    const cost = processing?.reduce((sum, row) => sum + row.costUsd, 0) ?? 0;

    const favorite = inventory.favoritePhotos + inventory.favoriteVideos;
    const metadataRow = (field: 'captureDate' | 'location' | 'cameraModel' | 'aiDescription' | 'checksum', present: number) => ({
      field,
      present,
      missing: items - present,
      total: items,
    });

    return {
      scope: analyticsScopeValue(scope),
      scopeKind: scope.kind,
      scopeLabel: label,
      range: dto.range,
      from: window.from,
      through: window.through,
      generatedAt: now.toISOString(),
      definitions: ANALYTICS_SERIES.map((definition) => ({
        ...definition,
        scopes: [...definition.scopes],
        available: definition.scopes.includes(scope.kind),
      })),
      summary: {
        items,
        photos: inventory.photos,
        videos: inventory.videos,
        raw: inventory.raw,
        files: inventory.files,
        unmeasuredFiles: inventory.unmeasuredFiles,
        logicalBytes: inventory.logicalBytes,
        uploadedLogicalBytes: inventory.uploadedLogicalBytes,
        externalLogicalBytes: inventory.externalLogicalBytes,
        physicalBytes: physical.physicalBytes,
        uploadedPhysicalBytes: physical.uploadedPhysicalBytes,
        externalPhysicalBytes: physical.externalPhysicalBytes,
        savedBytes: Math.max(0, inventory.logicalBytes - physical.physicalBytes),
        duplicateReferences: physical.sharedReferences,
      },
      host,
      history: {
        state: historyState(lastObservedAt, now),
        lastObservedAt: lastObservedAt?.toISOString() ?? null,
        staleAfterHours: ANALYTICS_STALE_AFTER_HOURS,
        dayRetentionDays: ANALYTICS_DAY_RETENTION_DAYS,
        weekRetentionDays: ANALYTICS_WEEK_RETENTION_DAYS,
      },
      series,
      days,
      cameras: groupCameras(cameras.map((row) => ({ name: cameraName(row.make, row.model), count: row.items }))),
      metadata: [
        metadataRow('captureDate', inventory.withCaptureDate),
        metadataRow('location', inventory.withLocation),
        metadataRow('cameraModel', inventory.withCameraModel),
        metadataRow('aiDescription', inventory.withAiDescription),
        metadataRow('checksum', items),
      ],
      views: [
        {
          view: 'timeline',
          photos: inventory.timelinePhotos,
          videos: inventory.timelineVideos,
          total: inventory.timelinePhotos + inventory.timelineVideos,
          overlaps: false,
        },
        {
          view: 'favorites',
          photos: inventory.favoritePhotos,
          videos: inventory.favoriteVideos,
          total: favorite,
          overlaps: true,
        },
        {
          view: 'archive',
          photos: inventory.archivePhotos,
          videos: inventory.archiveVideos,
          total: inventory.archivePhotos + inventory.archiveVideos,
          overlaps: false,
        },
        {
          view: 'trash',
          photos: inventory.trashPhotos,
          videos: inventory.trashVideos,
          total: inventory.trashPhotos + inventory.trashVideos,
          overlaps: false,
        },
      ],
      albums: {
        total: albumRows.length,
        owned: albumRows.filter((album) => album.owned).length,
        shared: albumRows.filter((album) => album.shared).length,
        ownedShared: albumRows.filter((album) => album.owned && album.shared).length,
        notShared: albumRows.filter((album) => album.owned && !album.shared).length,
        unlisted: albumRows.length - listed.length,
        albums: listed.map((album) => ({
          id: album.id,
          name: album.name,
          ownerName: album.ownerName,
          owned: album.owned,
          shared: album.shared,
        })),
      },
      processing: {
        available: isHost,
        attempts,
        completed: processing?.reduce((sum, row) => sum + row.completed, 0) ?? 0,
        failed: processing?.reduce((sum, row) => sum + row.failed, 0) ?? 0,
        durationMs: processing?.reduce((sum, row) => sum + row.durationMs, 0) ?? 0,
        estimatedCostUsd: costed > 0 ? Number(cost.toFixed(4)) : null,
        costedAttempts: costed,
        uncostedAttempts: attempts - costed,
      },
    };
  }

  /**
   * The nightly collector, its retention and its downsampling. Idempotent: a second run the same
   * day rewrites that day's readings. A failure gets exactly one automatic retry a few minutes
   * later; a second failure is logged and waits for the next night or a manual run from the jobs
   * page (`analytics-collect`).
   */
  @OnJob({ name: JobName.AnalyticsCollect, queue: QueueName.BackgroundTask })
  async handleCollect(data: IAnalyticsCollectJob = {}): Promise<JobStatus> {
    const attempt = data.attempt ?? 0;
    try {
      await this.collect(new Date());
      return JobStatus.Success;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < ANALYTICS_AUTO_RETRIES) {
        this.logger.warn(`Analytics collection failed; retrying once: ${message}`);
        await this.jobRepository.queue({ name: JobName.AnalyticsCollect, data: { attempt: attempt + 1 } });
      } else {
        this.logger.error(`Analytics collection failed again; history has a gap until the next run: ${message}`);
      }
      return JobStatus.Failed;
    }
  }

  private async collect(now: Date) {
    const day = isoDay(now);
    const bucketStart = parseIsoDay(day);
    const [targets, snapshot] = await Promise.all([
      this.analyticsRepository.getScopeTargets(),
      this.analyticsRepository.getCollectorSnapshot(),
    ]);

    const samples: AnalyticsSampleInsert[] = [];
    const add = (scope: AnalyticsScope, series: AnalyticsSeriesId, value: number) =>
      samples.push({
        series,
        scopeKey: analyticsScopeKey(scope),
        userId: scope.kind === AnalyticsScopeKind.Account ? scope.userId : null,
        libraryId: scope.kind === AnalyticsScopeKind.Library ? scope.libraryId : null,
        grain: AnalyticsSampleGrain.Day,
        bucketStart,
        value,
        observedAt: now,
      });

    const find = (kind: AnalyticsScopeKind, id: string | null) =>
      snapshot.find((row) => row.kind === kind && row.id === id);
    const addLibrarySeries = (scope: AnalyticsScope, id: string | null) => {
      const row = find(scope.kind, id);
      add(scope, AnalyticsSeriesId.LibraryItems, row?.items ?? 0);
      add(scope, AnalyticsSeriesId.LibraryPhotos, row?.photos ?? 0);
      add(scope, AnalyticsSeriesId.LibraryVideos, row?.videos ?? 0);
      add(scope, AnalyticsSeriesId.LibraryLogicalBytes, row?.logicalBytes ?? 0);
      add(scope, AnalyticsSeriesId.LibraryPhysicalBytes, row?.physicalBytes ?? 0);
    };

    addLibrarySeries({ kind: AnalyticsScopeKind.Host }, null);
    for (const user of targets.users) {
      addLibrarySeries({ kind: AnalyticsScopeKind.Account, userId: user.id }, user.id);
    }
    for (const library of targets.libraries) {
      addLibrarySeries({ kind: AnalyticsScopeKind.Library, libraryId: library.id }, library.id);
    }

    try {
      const disk = await this.storageRepository.checkDiskUsage(StorageCore.getBaseFolder(StorageFolder.Library));
      add({ kind: AnalyticsScopeKind.Host }, AnalyticsSeriesId.HostVolumeUsedBytes, disk.total - disk.free);
      add({ kind: AnalyticsScopeKind.Host }, AnalyticsSeriesId.HostCapacityBytes, disk.total);
    } catch (error) {
      // A volume that cannot be read tonight is a gap in its history, never a zero.
      this.logger.warn(`Analytics could not read the library volume: ${error instanceof Error ? error.message : error}`);
    }

    // Only series the registry marks as collected for each scope kind reach the table.
    const allowed = new Set(
      [AnalyticsScopeKind.Host, AnalyticsScopeKind.Account, AnalyticsScopeKind.Library].flatMap((kind) =>
        collectedSeriesFor(kind).map((series) => `${kind}:${series}`),
      ),
    );
    const scopeKindOf = (key: string) => (key === 'host' ? AnalyticsScopeKind.Host : key.split(':')[0]);
    await this.analyticsRepository.upsertSamples(
      samples.filter((sample) => allowed.has(`${scopeKindOf(sample.scopeKey)}:${sample.series}`)),
    );

    const retention = await this.analyticsRepository.applyRetention(
      parseIsoDay(addDays(day, -ANALYTICS_DAY_RETENTION_DAYS)),
      parseIsoDay(addDays(day, -ANALYTICS_WEEK_RETENTION_DAYS)),
    );
    this.logger.log(
      `Analytics collected ${samples.length} readings; downsampled ${retention.downsampled}, removed ${retention.deleted}`,
    );
  }

  /**
   * The library volume now. If it cannot be read, the newest collected reading stands in, marked
   * stale when it is old; with neither, every value is unknown. Never an estimate.
   */
  private async readHost(now: Date): Promise<AnalyticsReportResponseDto['host']> {
    try {
      const disk = await this.storageRepository.checkDiskUsage(StorageCore.getBaseFolder(StorageFolder.Library));
      return {
        state: AnalyticsState.Measured,
        observedAt: now.toISOString(),
        volumeUsedBytes: disk.total - disk.free,
        capacityBytes: disk.total,
        freeBytes: disk.available,
      };
    } catch {
      const samples = await this.analyticsRepository.getLatestHostSamples();
      const used = samples.find((sample) => sample.series === AnalyticsSeriesId.HostVolumeUsedBytes);
      const capacity = samples.find((sample) => sample.series === AnalyticsSeriesId.HostCapacityBytes);
      if (!used || !capacity) {
        return {
          state: AnalyticsState.Unknown,
          observedAt: null,
          volumeUsedBytes: null,
          capacityBytes: null,
          freeBytes: null,
        };
      }
      const observedAt = used.observedAt < capacity.observedAt ? used.observedAt : capacity.observedAt;
      return {
        state: historyState(observedAt, now),
        observedAt: observedAt.toISOString(),
        volumeUsedBytes: used.value,
        capacityBytes: capacity.value,
        // Free space is only ever read, never derived from other readings.
        freeBytes: null,
      };
    }
  }

  private async resolveScope(auth: AuthDto, value: string): Promise<ResolvedScope> {
    const scope = parseAnalyticsScope(value);
    if (!scope) {
      throw new BadRequestException('Scope must be all, account:<id> or library:<id>');
    }
    const isAdmin = auth.user.isAdmin;
    switch (scope.kind) {
      case AnalyticsScopeKind.Host: {
        if (!isAdmin) {
          throw new ForbiddenException('Only administrators can read analytics for the whole server');
        }
        return { scope, label: '', ownerId: null };
      }
      case AnalyticsScopeKind.Account: {
        if (!isAdmin && scope.userId !== auth.user.id) {
          throw new ForbiddenException('You can only read analytics for your own account');
        }
        const user = (await this.getTargets()).users.find((item) => item.id === scope.userId);
        if (!user) {
          throw new NotFoundException('Account not found');
        }
        return { scope, label: user.name, ownerId: user.id };
      }
      case AnalyticsScopeKind.Library: {
        const library = (await this.getTargets()).libraries.find((item) => item.id === scope.libraryId);
        if (!isAdmin && library?.ownerId !== auth.user.id) {
          throw new ForbiddenException('You can only read analytics for your own libraries');
        }
        if (!library) {
          throw new NotFoundException('Library not found');
        }
        return { scope, label: library.name, ownerId: library.ownerId };
      }
    }
  }

  private getTargets(): Promise<AnalyticsScopeTargets> {
    return this.analyticsRepository.getScopeTargets();
  }
}
