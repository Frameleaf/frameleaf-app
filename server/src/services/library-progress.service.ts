import { Injectable } from '@nestjs/common';
import type { VideoCardState } from 'src/types.js';
import {
  LIBRARY_PROGRESS_FEATURES,
  LibraryProgressResponseDto,
  LibraryRedoDto,
  LibraryRedoResponseDto,
  MediaCopiesResponseDto,
  REDO_QUEUES,
  VideoCardDto,
} from 'src/dtos/library-progress.dto.js';
import { AnalyticsSeriesId, QueueCommand, SystemMetadataKey } from 'src/enum.js';
import { AnalyticsRepository } from 'src/repositories/analytics.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { HardwareProbeRepository } from 'src/repositories/hardware-probe.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { QueueService } from 'src/services/queue.service.js';

/** A reading is kept at most this often, so a page left open does not fill the list. */
export const PROGRESS_SAMPLE_EVERY_MS = 10 * 60_000;
/** The rate is measured over at most this long, so it follows what the server does lately. */
export const PROGRESS_RATE_WINDOW_MS = 6 * 60 * 60_000;
/** Readings kept. */
const PROGRESS_SAMPLES_KEPT = 48;

type RedoQueue = (typeof REDO_QUEUES)[number];

const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

/** The card's state for the page. */
const videoCardOf = (state: VideoCardState | null | undefined): VideoCardDto => ({
  failedAt: state?.failedAt ?? null,
  slowdown: state?.slowdown ?? null,
  lastTest: state?.lastTest ?? null,
});

/**
 * FL-521: Library care's "N of M read" for each reading feature with a time estimate from the recent
 * rate, what the copies beside the originals take for Editing & playback, and "Save and … now/tonight":
 * starting a feature again over every photo now, or in the next overnight run.
 *
 * The rate has no history of its own: each time the counts are read (at most every ten minutes) they
 * are kept, and the rate is the change over the oldest reading of the last six hours. Until there are
 * two readings far enough apart, the rate and the estimate are unknown.
 */
@Injectable()
export class LibraryProgressService {
  constructor(
    private logger: LoggingRepository,
    private assetJobRepository: AssetJobRepository,
    private analyticsRepository: AnalyticsRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private queueService: QueueService,
    private hardwareProbeRepository: HardwareProbeRepository,
  ) {
    this.logger.setContext(LibraryProgressService.name);
  }

  async getProgress(now = new Date()): Promise<LibraryProgressResponseDto> {
    const counts = await this.assetJobRepository.countFeatureProgress();
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.LibraryProgressSamples);
    const samples = stored?.samples ?? [];
    const done = Object.fromEntries(LIBRARY_PROGRESS_FEATURES.map((feature) => [feature, counts[feature][0]]));

    const newest = samples.at(-1);
    if (!newest || now.getTime() - new Date(newest.at).getTime() >= PROGRESS_SAMPLE_EVERY_MS) {
      const kept = [...samples, { at: now.toISOString(), done }].slice(-PROGRESS_SAMPLES_KEPT);
      await this.systemMetadataRepository.set(SystemMetadataKey.LibraryProgressSamples, { samples: kept });
    }

    const since = samples.find((sample) => now.getTime() - new Date(sample.at).getTime() <= PROGRESS_RATE_WINDOW_MS);
    const hours = since ? (now.getTime() - new Date(since.at).getTime()) / 3_600_000 : 0;
    const measured = since !== undefined && hours * 3_600_000 >= PROGRESS_SAMPLE_EVERY_MS;

    return {
      measuredSince: measured ? since.at : null,
      features: LIBRARY_PROGRESS_FEATURES.map((feature) => {
        const [read, total] = counts[feature];
        const perHour = measured ? Math.max(0, (read - (since.done[feature] ?? read)) / hours) : null;
        const left = Math.max(0, total - read);
        const secondsLeft = left === 0 ? 0 : perHour && perHour > 0 ? Math.round((left / perHour) * 3600) : null;
        return { feature, done: read, total, perHour: perHour === null ? null : Math.round(perHour), secondsLeft };
      }),
    };
  }

  async getMediaCopies(): Promise<MediaCopiesResponseDto> {
    const [{ videoMs, copyMs, ...counts }, samples, redo, card] = await Promise.all([
      this.assetJobRepository.countMediaCopies(),
      this.analyticsRepository.getLatestHostSamples([
        AnalyticsSeriesId.HostThumbnailBytes,
        AnalyticsSeriesId.HostThumbnailOtherDiskBytes,
        AnalyticsSeriesId.HostEncodedVideoBytes,
        AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes,
      ]),
      this.systemMetadataRepository.get(SystemMetadataKey.OvernightRedo),
      this.systemMetadataRepository.get(SystemMetadataKey.VideoCardState),
    ]);
    // The newest reading of each folder, wherever it is (the library volume or another disk).
    const newest = (...series: AnalyticsSeriesId[]) =>
      samples
        .filter((sample) => series.includes(sample.series as AnalyticsSeriesId))
        .toSorted((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
    const previews = newest(AnalyticsSeriesId.HostThumbnailBytes, AnalyticsSeriesId.HostThumbnailOtherDiskBytes);
    const playback = newest(AnalyticsSeriesId.HostEncodedVideoBytes, AnalyticsSeriesId.HostEncodedVideoOtherDiskBytes);
    const observed = [previews, playback].flatMap((sample) => (sample ? [sample.observedAt.getTime()] : []));
    return {
      ...counts,
      previewsBytes: previews ? Math.round(previews.value) : null,
      playbackBytes: playback ? Math.round(playback.value) : null,
      measuredAt: observed.length > 0 ? new Date(Math.min(...observed)).toISOString() : null,
      tonight: this.tonight(redo?.queues),
      videoMinutes: minutes(videoMs),
      copyMinutes: minutes(copyMs),
      videoCard: videoCardOf(card),
    };
  }

  /**
   * FL-537: "Test it": a short test encode on the graphics card, and one on the processor to say how
   * much slower copies are without the card. A test that works does not clear "stopped helping": the
   * next copy made on the card does.
   */
  async testVideoCard(now = new Date()): Promise<VideoCardDto> {
    const result = await this.hardwareProbeRepository.testVideoCard();
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.VideoCardState);
    // The slowdown is kept from the last test that measured both, so a failed card still has one.
    const measured =
      result.speed && result.softwareSpeed
        ? Math.max(1, Math.round((result.speed / result.softwareSpeed) * 10) / 10)
        : null;
    const next: VideoCardState = {
      failedAt: stored?.failedAt ?? null,
      accel: stored?.accel ?? null,
      slowdown: measured ?? stored?.slowdown ?? null,
      lastTest: { at: now.toISOString(), ok: result.encoder !== null && result.speed !== null, ...result },
    };
    await this.systemMetadataRepository.set(SystemMetadataKey.VideoCardState, next);
    return videoCardOf(next);
  }

  /**
   * "Save and … now": the work starts over every photo at once, as the Job manager's "All" does.
   * "… tonight": it waits for the next overnight run (`OvernightService.startRequestedRedo`).
   */
  async redo({ queue, when }: LibraryRedoDto): Promise<LibraryRedoResponseDto> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.OvernightRedo);
    const waiting = this.tonight(stored?.queues).filter((name) => name !== queue);
    if (when === 'now') {
      await this.queueService.runCommandLegacy(queue, { command: QueueCommand.Start, force: true });
    } else {
      waiting.push(queue);
    }
    await this.systemMetadataRepository.set(SystemMetadataKey.OvernightRedo, { queues: waiting });
    return { tonight: waiting };
  }

  private tonight(queues?: string[]): RedoQueue[] {
    return (queues ?? []).filter((queue): queue is RedoQueue => (REDO_QUEUES as readonly string[]).includes(queue));
  }
}
