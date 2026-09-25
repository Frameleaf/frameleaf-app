import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { IAnalyticsCollectJob } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import {
  ANALYTICS_FOCAL_BUCKETS,
  ANALYTICS_ORIENTATIONS,
  ANALYTICS_PHOTO_FORMATS,
  ANALYTICS_VIDEO_RESOLUTIONS,
  AnalyticsBucketDto,
  AnalyticsInsightsDto,
  AnalyticsQueryDto,
  AnalyticsReportResponseDto,
  AnalyticsScopeOption,
  AnalyticsScopesResponseDto,
  AnalyticsVolumeBreakdownDto,
} from 'src/dtos/analytics.dto.js';
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
import {
  AnalyticsInsightRows,
  AnalyticsRepository,
  AnalyticsScopeTargets,
} from 'src/repositories/analytics.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import {
  ANALYTICS_AUTO_RETRIES,
  ANALYTICS_DAY_RETENTION_DAYS,
  ANALYTICS_LENS_LIMIT,
  ANALYTICS_PLACE_LIMIT,
  ANALYTICS_SERIES,
  ANALYTICS_STALE_AFTER_HOURS,
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
  fixedBuckets,
  groupCameras,
  groupNamed,
  historyState,
  isoDay,
  parseAnalyticsScope,
  parseIsoDay,
  sumIntoBuckets,
  windowDays,
} from 'src/utils/analytics.js';
import { getConfig } from 'src/utils/config.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

const mapInsights = (rows: AnalyticsInsightRows, items: number): AnalyticsInsightsDto => {
  const punch = new Map(rows.punchcard.map((cell) => [`${cell.weekday}:${cell.hour}`, cell.count]));
  const keyed = <T extends string>(values: readonly T[], list: Array<{ count: number }>, field: string) =>
    fixedBuckets(
      values,
      list.map((row) => ({ key: (row as Record<string, unknown>)[field] as string, count: row.count })),
    ) as Array<{ key: T; count: number }>;
  const { oldest, largest, longest, videoDurationMs } = rows.records;
  const people = rows.people;

  return {
    hiddenItems: Math.max(0, items - rows.items),
    capturesByYear: rows.years,
    punchcard: Array.from({ length: 7 * 24 }, (_, index) => {
      const weekday = Math.floor(index / 24) + 1;
      const hour = index % 24;
      return { weekday, hour, count: punch.get(`${weekday}:${hour}`) ?? 0 };
    }),
    lenses: groupNamed(rows.lenses, ANALYTICS_LENS_LIMIT),
    focalLengths: keyed(ANALYTICS_FOCAL_BUCKETS, rows.focalLengths, 'bucket'),
    photoFormats: keyed(ANALYTICS_PHOTO_FORMATS, rows.photoFormats, 'format'),
    videoResolutions: keyed(ANALYTICS_VIDEO_RESOLUTIONS, rows.videoResolutions, 'resolution'),
    orientation: keyed(ANALYTICS_ORIENTATIONS, rows.orientation, 'orientation'),
    livePhotos: rows.livePhotos,
    // HDR is only known from a read video stream; with none read the breakdown is left out
    hdr: rows.hdr.probedVideos > 0 ? rows.hdr : null,
    coverage: rows.coverage,
    peopleAndPlaces: people
      ? {
          faces: people.faces,
          itemsWithFaces: people.itemsWithFaces,
          itemsWithoutFaces: Math.max(0, rows.items - people.itemsWithFaces),
          namedPeople: people.namedPeople,
          pets: people.pets,
          topPeople: people.topPeople,
          geotagged: people.geotagged,
          countries: people.countries,
          cities: people.cities,
          places: groupNamed(people.places, ANALYTICS_PLACE_LIMIT),
        }
      : null,
    records: {
      oldestCapture: oldest ? { date: isoDay(oldest.localDateTime), name: oldest.name || null } : null,
      largestFile: largest ? { bytes: largest.bytes, name: largest.name || null } : null,
      longestVideo: longest ? { durationMs: longest.durationMs, name: longest.name || null } : null,
      videoDurationMs,
      videoHours: Math.round(videoDurationMs / 360_000) / 10,
    },
  };
};

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
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private forkSchemaRepository: ForkSchemaRepository,
  ) {
    this.logger.setContext(AnalyticsService.name);
  }

  /**
   * FL-71: the administrator's "Collect local metrics" and "Keep analytics history for" settings
   * (`analytics` in the system configuration). Daily readings are kept for at most
   * `ANALYTICS_DAY_RETENTION_DAYS`, weekly ones for the chosen history.
   */
  private async getRetention() {
    const { analytics } = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
        forkSchemaRepo: this.forkSchemaRepository,
      },
      { withCache: true },
    );
    return {
      enabled: analytics.enabled,
      dayRetentionDays: Math.min(ANALYTICS_DAY_RETENTION_DAYS, analytics.historyDays),
      weekRetentionDays: analytics.historyDays,
    };
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

    // FL-79: people, places and file names are the owner's own; nobody else (an administrator, the
    // whole server) is told them, and Locked people and pets stay unnamed while the session is locked
    const readsOwnScope = !!ownerId && ownerId === auth.user.id;
    const [
      inventory,
      physical,
      arrivals,
      captures,
      cameras,
      albums,
      processing,
      samples,
      lastObservedAt,
      host,
      insights,
      retention,
    ] = await Promise.all([
      this.analyticsRepository.getInventory(scope),
      this.analyticsRepository.getPhysical(scope),
      this.analyticsRepository.getArrivalsByDay(scope, window.from, window.through),
      this.analyticsRepository.getCapturesByDay(scope, window.from, window.through),
      this.analyticsRepository.getCameras(scope, getHiddenContentQueryOptions(auth)),
      this.analyticsRepository.getAlbums(scope, auth.user.id),
      isHost ? this.analyticsRepository.getProcessingByDay(window.from, window.through) : Promise.resolve(null),
      this.analyticsRepository.getSamples(scopeKey, GROWTH_SERIES, parseIsoDay(window.from)),
      this.analyticsRepository.getLatestObservation(scopeKey),
      this.readHost(now),
      this.analyticsRepository.getInsights(scope, {
        ownerId: readsOwnScope ? ownerId : null,
        suppressedPersonIds: auth.hiddenContent?.personIds ?? [],
        suppressedPetIds: auth.hiddenContent?.petIds ?? [],
        privacy: getHiddenContentQueryOptions(auth),
      }),
      this.getRetention(),
    ]);

    const items = inventory.photos + inventory.videos;
    // FL-79: what uses the volume, for the administrator's whole-server report only
    // Only against a live volume reading: a stale or unknown volume is never mixed with the live
    // originals and database sizes.
    host.breakdown =
      isHost && host.state === AnalyticsState.Measured
        ? await this.readVolumeBreakdown(host.volumeUsedBytes, physical.uploadedPhysicalBytes)
        : null;
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
    const metadataRow = (
      field: 'captureDate' | 'location' | 'cameraModel' | 'aiDescription' | 'checksum',
      present: number,
    ) => ({
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
        dayRetentionDays: retention.dayRetentionDays,
        weekRetentionDays: retention.weekRetentionDays,
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
      insights: mapInsights(insights, items),
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
      const retention = await this.getRetention();
      if (!retention.enabled) {
        // FL-71: local metrics are off; the history already kept stays until it is turned back on
        return JobStatus.Skipped;
      }
      await this.collect(new Date(), retention);
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

  private async collect(now: Date, retention: { dayRetentionDays: number; weekRetentionDays: number }) {
    const day = isoDay(now);
    const bucketStart = parseIsoDay(day);
    const [targets, snapshot] = await Promise.all([
      this.analyticsRepository.getScopeTargets(),
      this.analyticsRepository.getCollectorSnapshot(),
    ]);

    const samples: AnalyticsSampleInsert[] = [];
    const add = (scope: AnalyticsScope, series: AnalyticsSeriesId, value: number) => {
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
    };

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
      this.logger.warn(
        `Analytics could not read the library volume: ${error instanceof Error ? error.message : error}`,
      );
    }

    // FL-79: the generated files (thumbnails and previews, encoded video) behind the storage donut,
    // each read on its own so one failure keeps the other's reading. A folder on another device than
    // the library is recorded as on another disk, so it is never subtracted from the library volume.
    const libraryDevice = await this.storageRepository.getDevice(StorageCore.getBaseFolder(StorageFolder.Library));
    const folders = [
      [StorageFolder.Thumbnails, AnalyticsSeriesId.HostThumbnailBytes, AnalyticsSeriesId.HostThumbnailOtherDiskBytes],
      [
        StorageFolder.EncodedVideo,
        AnalyticsSeriesId.HostEncodedVideoBytes,
        AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes,
      ],
    ] as const;
    for (const [folder, onVolume, otherDisk] of folders) {
      try {
        const path = StorageCore.getBaseFolder(folder);
        const device = await this.storageRepository.getDevice(path);
        const elsewhere = device !== null && libraryDevice !== null && device !== libraryDevice;
        add(
          { kind: AnalyticsScopeKind.Host },
          elsewhere ? otherDisk : onVolume,
          await this.storageRepository.getFolderBytes(path),
        );
      } catch (error) {
        this.logger.warn(
          `Analytics could not measure the ${folder} folder: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    // Only series the registry marks as collected for each scope kind reach the table.
    const allowed = new Set(
      [AnalyticsScopeKind.Host, AnalyticsScopeKind.Account, AnalyticsScopeKind.Library].flatMap((kind) =>
        collectedSeriesFor(kind).map((series) => `${kind}:${series}`),
      ),
    );
    const scopeKindOf = (key: string) => (key === 'host' ? AnalyticsScopeKind.Host : key.split(':', 1)[0]);
    await this.analyticsRepository.upsertSamples(
      samples.filter((sample) => allowed.has(`${scopeKindOf(sample.scopeKey)}:${sample.series}`)),
    );

    const removed = await this.analyticsRepository.applyRetention(
      parseIsoDay(addDays(day, -retention.dayRetentionDays)),
      parseIsoDay(addDays(day, -retention.weekRetentionDays)),
    );
    this.logger.log(
      `Analytics collected ${samples.length} readings; downsampled ${removed.downsampled}, removed ${removed.deleted}`,
    );
  }

  /**
   * What uses the library volume (FL-79, the template's storage donut): uploaded originals,
   * generated previews and encoded video (measured by the nightly collector), the database, and
   * the rest of the volume used. The parts and `otherBytes` add up to `volumeUsedBytes`; when the
   * measured parts are larger (a database on another disk, say) `otherBytes` is 0 and
   * `exceedsUsed` says so. Nothing here is estimated.
   */
  private async readVolumeBreakdown(
    volumeUsedBytes: number | null,
    originalsBytes: number,
  ): Promise<AnalyticsVolumeBreakdownDto | null> {
    if (volumeUsedBytes === null) {
      return null;
    }
    const [databaseBytes, generated] = await Promise.all([
      this.analyticsRepository.getDatabaseBytes(),
      this.analyticsRepository.getLatestHostSamples([
        AnalyticsSeriesId.HostThumbnailBytes,
        AnalyticsSeriesId.HostThumbnailOtherDiskBytes,
        AnalyticsSeriesId.HostEncodedVideoBytes,
        AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes,
      ]),
    ]);
    // The newest reading of a folder decides where it is, on the library volume or another disk.
    const newest = (onVolume: AnalyticsSeriesId, otherDisk: AnalyticsSeriesId) => {
      const here = generated.find((sample) => sample.series === onVolume);
      const there = generated.find((sample) => sample.series === otherDisk);
      if (here && (!there || here.observedAt >= there.observedAt)) {
        return { value: here.value, observedAt: here.observedAt, elsewhere: false };
      }
      return there ? { value: there.value, observedAt: there.observedAt, elsewhere: true } : undefined;
    };
    const previews = newest(AnalyticsSeriesId.HostThumbnailBytes, AnalyticsSeriesId.HostThumbnailOtherDiskBytes);
    const encoded = newest(AnalyticsSeriesId.HostEncodedVideoBytes, AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes);
    const observed = [previews, encoded].filter((sample) => sample !== undefined).map((sample) => sample.observedAt);
    const onVolume = (part?: { value: number; elsewhere: boolean }) => (part && !part.elsewhere ? part.value : 0);
    const measured = originalsBytes + onVolume(previews) + onVolume(encoded) + databaseBytes;
    return {
      originalsBytes,
      previewsBytes: previews?.value ?? null,
      encodedVideoBytes: encoded?.value ?? null,
      onOtherDisk: [
        ...(previews?.elsewhere ? (['previews'] as const) : []),
        ...(encoded?.elsewhere ? (['encodedVideo'] as const) : []),
      ],
      generatedObservedAt:
        observed.length > 0 ? new Date(Math.min(...observed.map((date) => date.getTime()))).toISOString() : null,
      databaseBytes,
      otherBytes: Math.max(0, volumeUsedBytes - measured),
      exceedsUsed: measured > volumeUsedBytes,
    };
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
      const observedAt = new Date(Math.min(used.observedAt.getTime(), capacity.observedAt.getTime()));
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
