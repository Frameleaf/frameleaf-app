import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import { SemVer, diff, intersects, lt } from 'semver';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { VersionCheckMetadata } from 'src/types.js';
import { serverVersion } from 'src/constants.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ReleaseEventV1, ReleaseType, ServerVersionResponseDto } from 'src/dtos/server.dto.js';
import {
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  ReleaseChannel,
  SystemMetadataKey,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { handlePromiseError } from 'src/utils/misc.js';

// can't use gt because it's broken for release candidates https://github.com/npm/node-semver/issues/483
const isNewer = (channel: ReleaseChannel, releaseVersion: string) =>
  intersects(`>${serverVersion}`, releaseVersion, { includePrerelease: channel === ReleaseChannel.ReleaseCandidate });

const asNotification = (
  channel: ReleaseChannel,
  { checkedAt, releaseVersion }: VersionCheckMetadata,
): ReleaseEventV1 => {
  return {
    isAvailable: isNewer(channel, releaseVersion),
    checkedAt,
    serverVersion: ServerVersionResponseDto.fromSemVer(serverVersion),
    releaseVersion: ServerVersionResponseDto.fromSemVer(new SemVer(releaseVersion)),
    type: diff(serverVersion, releaseVersion) as ReleaseType,
  };
};

const MANUAL_CHECK_INTERVAL_SECONDS = 60;

const checkedWithin = (state: VersionCheckMetadata | null | undefined, seconds: number) =>
  !!state?.checkedAt && DateTime.now().diff(DateTime.fromISO(state.checkedAt)).as('seconds') < seconds;

/** The error and its causes, so a log names the HTTP status and any rate-limit reset. */
const describeError = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current && parts.length < 4) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(' <- ');
};

/**
 * Version history and the Frameleaf version check (FL-80 S-4 / O-8). The owner's privacy direction
 * applies to Immich-origin calls only (FL-146, 2026-09-25): the check asks Frameleaf's own GitHub
 * releases (`ServerInfoRepository.getLatestRelease`), hourly while `newVersionCheck.enabled` is on,
 * and on demand from About → "Check for updates". A release build is compared by its base version;
 * a rebuild of the running version (a higher tag sequence) is not announced, because a running
 * server does not know its own sequence.
 */
@Injectable()
export class VersionService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    const hasLock = await this.databaseRepository.tryLock(DatabaseLock.VersionCheck);
    if (hasLock) {
      // The first check runs in the background: a slow or unreachable release feed must never delay
      // the cron setup or the rest of the bootstrap (the lookup itself gives up after 10 seconds).
      handlePromiseError(this.handleVersionCheck(), this.logger);

      const randomMinute = Math.floor(Math.random() * 60);
      const expression = `${randomMinute} * * * *`;
      this.logger.debug(`Scheduling version check for cron ${expression}`);
      this.cronRepository.create({
        name: CronJob.VersionCheck,
        expression,
        onTick: () => handlePromiseError(this.handleQueueVersionCheck(), this.logger),
      });
    }

    await this.databaseRepository.withLock(DatabaseLock.VersionHistory, async () => {
      const previous = await this.versionRepository.getLatest();
      const current = serverVersion.toString();

      if (!previous) {
        await this.versionRepository.create({ version: current });
        return;
      }

      if (previous.version !== current) {
        const previousVersion = new SemVer(previous.version);

        this.logger.log(`Adding ${current} to upgrade history`);
        await this.versionRepository.create({ version: current });

        const isNeedsNewMemories = lt(previousVersion, '1.129.0');
        if (isNeedsNewMemories) {
          await this.jobRepository.queue({ name: JobName.MemoryGenerate });
        }
      }
    });
  }

  getVersion() {
    return ServerVersionResponseDto.fromSemVer(serverVersion);
  }

  getVersionHistory() {
    return this.versionRepository.getAll();
  }

  @OnEvent({ name: 'ConfigUpdate' })
  async onConfigUpdate({ oldConfig, newConfig }: ArgOf<'ConfigUpdate'>) {
    if (!oldConfig.newVersionCheck.enabled && newConfig.newVersionCheck.enabled) {
      await this.handleQueueVersionCheck();
    }
  }

  async handleQueueVersionCheck() {
    await this.jobRepository.queue({ name: JobName.VersionCheck, data: {} });
  }

  @OnJob({ name: JobName.VersionCheck, queue: QueueName.BackgroundTask })
  async handleVersionCheck(): Promise<JobStatus> {
    try {
      if (!this.configRepository.isProduction()) {
        return JobStatus.Skipped;
      }

      this.logger.debug('Running version check');

      const { newVersionCheck } = await this.getConfig({ withCache: true });
      if (!newVersionCheck.enabled) {
        return JobStatus.Skipped;
      }

      const versionCheck = await this.systemMetadataRepository.get(SystemMetadataKey.VersionCheckState);
      if (checkedWithin(versionCheck, 50)) {
        return JobStatus.Skipped;
      }

      await this.checkAndNotify(newVersionCheck.channel);
    } catch (error: any) {
      this.logger.warn(`Unable to run version check: ${describeError(error)}\n${error?.stack}`);
      return JobStatus.Failed;
    }

    return JobStatus.Success;
  }

  /**
   * About → "Check for updates" (S-4): an administrator asks now, whether or not the automatic check
   * is on. Only Frameleaf's release feed is contacted; a failure is reported to the caller.
   */
  async checkNow(): Promise<ReleaseEventV1> {
    const { newVersionCheck } = await this.getConfig({ withCache: true });
    // Throttled like the job: a check in the last minute is answered from the stored state, and
    // simultaneous requests share one lookup, so the endpoint cannot hammer GitHub's rate limit.
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.VersionCheckState);
    if (stored && checkedWithin(stored, MANUAL_CHECK_INTERVAL_SECONDS)) {
      return asNotification(newVersionCheck.channel, stored);
    }

    this.manualCheck ??= this.checkAndNotify(newVersionCheck.channel).finally(() => {
      this.manualCheck = undefined;
    });
    try {
      const metadata = await this.manualCheck;
      return asNotification(newVersionCheck.channel, metadata);
    } catch (error) {
      this.logger.warn(`Unable to check for updates: ${describeError(error)}`);
      throw error;
    }
  }

  private manualCheck?: Promise<VersionCheckMetadata>;

  private async checkAndNotify(channel: ReleaseChannel): Promise<VersionCheckMetadata> {
    const { version: releaseVersion, published_at: publishedAt } =
      await this.serverInfoRepository.getLatestRelease(channel);
    const metadata: VersionCheckMetadata = { checkedAt: DateTime.utc().toISO(), releaseVersion };

    await this.systemMetadataRepository.set(SystemMetadataKey.VersionCheckState, metadata);

    if (isNewer(channel, releaseVersion)) {
      this.logger.log(`Found ${releaseVersion}, released at ${new Date(publishedAt).toLocaleString()}`);
      this.websocketRepository.clientBroadcast('on_new_release', asNotification(channel, metadata));
    }
    return metadata;
  }

  @OnEvent({ name: 'WebsocketConnect' })
  async onWebsocketConnection({ userId }: ArgOf<'WebsocketConnect'>) {
    this.websocketRepository.clientSend(
      'on_server_version',
      userId,
      ServerVersionResponseDto.fromSemVer(serverVersion),
    );

    const { newVersionCheck } = await this.getConfig({ withCache: true });
    if (!newVersionCheck.enabled) {
      return;
    }

    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.VersionCheckState);
    if (metadata) {
      this.websocketRepository.clientSend('on_new_release', userId, asNotification(newVersionCheck.channel, metadata));
    }
  }
}
