import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  MediaCapabilitiesDto,
  MediaConnectionCreateDto,
  MediaConnectionRefreshDto,
  MediaImportCreateDto,
  MediaImportResponseDto,
  MediaInspectDto,
  MediaSubscriptionCreateDto,
  MediaSubscriptionResponseDto,
  MediaSubscriptionUpdateDto,
} from 'src/dtos/media-import.dto.js';
import type { MediaImport, MediaImportAuthority, MediaSubscription } from 'src/repositories/media-import.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { FrameleafWorker, JobName, JobStatus, Permission, QueueName, StorageFolder } from 'src/enum.js';
import { advanceJobProgress, jobSignal } from 'src/queue/context.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaDownloadError,
  type MediaDownloadInspection,
  MediaDownloaderRepository,
} from 'src/repositories/media-downloader.repository.js';
import { MediaImportRepository } from 'src/repositories/media-import.repository.js';
import { MediaSessionRepository } from 'src/repositories/media-session.repository.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { mediaSourceKey, subscriptionSince } from 'src/utils/media-import.js';

class MediaCapacityWait extends Error {}

@Injectable()
export class MediaImportService {
  private scheduling?: Promise<void>;
  constructor(
    private repository: MediaImportRepository,
    private downloader: MediaDownloaderRepository,
    private sessions: MediaSessionRepository,
    private jobs: JobRepository,
    private uploads: AssetUploadResourceService,
    private cron: CronRepository,
    private logger: LoggingRepository,
  ) {}

  async capabilities(auth: AuthDto): Promise<MediaCapabilitiesDto> {
    await this.repository.actor(auth, Permission.CaptureCatalogRead);
    return {
      version: 1 as const,
      ...(await this.downloader.capabilities()),
      individualMedia: 'installed-extractors' as const,
      creatorFeeds: 'per-url' as const,
      authentication: ['cookies', 'credentials', 'token'],
      qualifiedProviders: [],
    };
  }
  async inspect(auth: AuthDto, dto: MediaInspectDto, subscription = false) {
    await this.repository.actor(auth, subscription ? Permission.MediaSubscriptionWrite : Permission.MediaImportCreate);
    const row = await this.repository.inspect(
      auth.user.id,
      auth.apiKey?.id ?? null,
      dto,
      subscription ? Permission.MediaSubscriptionWrite : Permission.MediaImportCreate,
    );
    await this.queue(row);
    return this.response(row);
  }
  async create(auth: AuthDto, dto: MediaImportCreateDto) {
    await this.repository.actor(auth, Permission.MediaImportCreate);
    const row = await this.repository.create(auth, dto);
    await this.queue(row);
    return this.response(row);
  }
  async list(auth: AuthDto) {
    await this.repository.actor(auth, Permission.MediaImportRead);
    return { imports: await Promise.all((await this.repository.list(auth.user.id)).map((row) => this.response(row))) };
  }
  async get(auth: AuthDto, id: string) {
    await this.repository.actor(auth, Permission.MediaImportRead);
    return this.response(await this.repository.get(auth.user.id, id));
  }
  async cancel(auth: AuthDto, id: string) {
    await this.repository.actor(auth, Permission.MediaImportUpdate);
    await this.repository.cancel(auth.user.id, id);
    return this.response(await this.repository.get(auth.user.id, id));
  }
  async retry(auth: AuthDto, id: string, key: string) {
    await this.repository.actor(auth, Permission.MediaImportUpdate);
    const row = await this.repository.retry(auth.user.id, id, key);
    await this.queue(row);
    return this.response(row);
  }
  private async response(row: MediaImport): Promise<MediaImportResponseDto> {
    const items = (await this.repository.items(row.id)).map((item) => ({
      id: item.id,
      provider: item.entry.provider,
      creatorId: item.entry.creatorId,
      postId: item.entry.postId,
      attachmentId: item.entry.attachmentId,
      pageUrl: item.entry.pageUrl,
      title: item.entry.title,
      description: item.entry.description,
      creator: item.entry.creator,
      publishedAt: item.entry.publishedAt,
      kind: item.entry.kind,
      state: item.state,
      assetId: item.assetId,
      error: item.error,
      bytes: item.bytes,
    }));
    return {
      id: row.id,
      state: row.state,
      albumId: row.albumId,
      subscriptionId: row.subscriptionId,
      connectionId: row.connectionId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      error: row.error,
      kind: row.inspection?.kind ?? null,
      provider: row.inspection?.provider ?? null,
      creatorId: row.inspection?.creatorId ?? null,
      creator: row.inspection?.creator ?? null,
      complete: row.inspection?.complete ?? false,
      limitation: row.inspection?.limitation ?? null,
      items,
      discovered: items.length,
      saved: items.filter((item) => item.state === 'saved').length,
      skipped: items.filter((item) => item.state === 'skipped').length,
      failed: items.filter((item) => item.state === 'failed').length,
    };
  }
  private connectionResponse(row: Awaited<ReturnType<MediaImportRepository['connection']>>) {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      domains: row.domains,
      revision: row.revision,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  async connections(auth: AuthDto) {
    await this.repository.actor(auth, Permission.MediaConnectionRead);
    return {
      connections: (await this.repository.connections(auth.user.id)).map((row) => this.connectionResponse(row)),
    };
  }
  async connect(auth: AuthDto, dto: MediaConnectionCreateDto) {
    await this.repository.actor(auth, Permission.MediaConnectionWrite);
    const id = randomUUID();
    const encryptedSession = await this.sessions.encrypt(auth.user.id, id, dto.session);
    return this.connectionResponse(
      await this.repository.createConnection({
        id,
        ownerId: auth.user.id,
        provider: dto.provider,
        label: dto.label,
        domains: dto.session.domains,
        encryptedSession,
      }),
    );
  }
  async refresh(auth: AuthDto, id: string, dto: MediaConnectionRefreshDto) {
    await this.repository.actor(auth, Permission.MediaConnectionWrite);
    await this.repository.connection(auth.user.id, id);
    const ciphertext = await this.sessions.encrypt(auth.user.id, id, dto.session);
    return this.connectionResponse(
      await this.repository.updateConnection(auth.user.id, id, ciphertext, dto.session.domains),
    );
  }
  async disconnect(auth: AuthDto, id: string) {
    await this.repository.actor(auth, Permission.MediaConnectionWrite);
    return this.connectionResponse(await this.repository.updateConnection(auth.user.id, id, null));
  }
  private async session(row: MediaImport) {
    if (!row.connectionId) return;
    const connection = await this.repository.connection(row.ownerId, row.connectionId);
    if (
      connection.status !== 'connected' ||
      !connection.encryptedSession ||
      connection.revision !== row.connectionRevision
    )
      throw new MediaDownloadError('authentication_required');
    if (
      row.urls.some((value) => {
        const host = new URL(value).hostname;
        return connection.domains.every((domain) => !(host === domain || host.endsWith(`.${domain}`)));
      })
    )
      throw new MediaDownloadError('unsupported_session');
    return this.sessions.decrypt(row.ownerId, connection.id, connection.encryptedSession);
  }
  async subscriptions(auth: AuthDto) {
    await this.repository.actor(auth, Permission.MediaSubscriptionRead);
    return {
      subscriptions: await Promise.all(
        (await this.repository.subscriptions(auth.user.id)).map((row) => this.subscriptionResponse(row)),
      ),
    };
  }
  async subscribe(auth: AuthDto, dto: MediaSubscriptionCreateDto) {
    await this.repository.actor(auth, Permission.MediaSubscriptionWrite);
    const row = await this.repository.createSubscription(auth, dto);
    await this.schedule();
    return this.subscriptionResponse(row);
  }
  async updateSubscription(auth: AuthDto, id: string, dto: MediaSubscriptionUpdateDto) {
    await this.repository.actor(auth, Permission.MediaSubscriptionWrite);
    const row = await this.repository.updateSubscription(auth.user.id, id, dto);
    await this.schedule();
    return this.subscriptionResponse(row);
  }
  private async subscriptionResponse(row: MediaSubscription): Promise<MediaSubscriptionResponseDto> {
    return {
      id: row.id,
      provider: row.provider,
      creatorId: row.creatorId,
      creator: row.creator,
      url: row.url,
      albumId: row.albumId,
      connectionId: row.connectionId,
      history: row.history,
      intervalMinutes: row.intervalMinutes,
      status: row.status,
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      nextCheckAt: row.nextCheckAt.toISOString(),
      historyComplete: row.historyComplete,
      limitation: row.limitation,
      error: row.error,
      ...(await this.repository.subscriptionCounts(row.id)),
    };
  }
  private async queue(row: MediaImport) {
    if (
      !['inspecting', 'queued', 'downloading', 'assembling', 'importing'].includes(row.state) ||
      row.availableAt > new Date()
    )
      return;
    const runId = await this.jobs.createRun('media-import', { ownerId: row.ownerId, importId: row.id }, () =>
      this.jobs.queue({ name: JobName.MediaImport, data: { id: row.id } }),
    );
    await this.repository.setRun(row.id, runId);
  }
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap() {
    this.cron.create({
      name: 'media-imports',
      expression: '* * * * *',
      onTick: () => {
        void this.schedule();
      },
    });
    await this.schedule();
  }
  private schedule() {
    return (this.scheduling ??= (async () => {
      await this.repository.schedule();
      for (const row of await this.repository.recoverable()) await this.queue(row);
    })()
      .catch(() => this.logger.warn('Media import scheduling will retry'))
      .finally(() => {
        this.scheduling = undefined;
      }));
  }

  @OnJob({ name: JobName.MediaImport, queue: QueueName.BackgroundTask })
  async handleImport({ id }: { id: string }): Promise<JobStatus> {
    const row = await this.repository.getWorker(id);
    if (
      !row ||
      !['inspecting', 'queued', 'downloading', 'assembling', 'importing'].includes(row.state) ||
      row.availableAt > new Date()
    )
      return JobStatus.Skipped;
    const authority = this.repository.authority(row);
    try {
      await this.repository.assertAuthority(authority);
      await this.process(row, authority);
      return JobStatus.Success;
    } catch (error) {
      if (jobSignal()?.aborted) throw error;
      if (error instanceof MediaCapacityWait) {
        await this.repository.defer(authority, 30, 'Waiting for download capacity', false);
        return JobStatus.Success;
      }
      const message =
        error instanceof MediaDownloadError
          ? error.message
          : 'Media import could not continue; check access, destination and storage';
      const retryable =
        error instanceof MediaDownloadError && ['rate_limited', 'timeout', 'incomplete', 'failed'].includes(error.code);
      try {
        if (retryable && row.retries < 4)
          await this.repository.defer(
            authority,
            Math.min(
              86_400,
              Math.max(Number.isFinite(error.retryAfter) ? error.retryAfter! : 0, 30 * 2 ** row.retries),
            ),
            message,
          );
        else
          await this.repository.failAttempt(
            authority,
            message,
            error instanceof MediaDownloadError
              ? (await this.repository.items(row.id)).some((item) => item.state === 'saved')
                ? 'partial'
                : 'failed'
              : 'paused',
            error instanceof MediaDownloadError && error.code === 'authentication_required',
          );
      } catch {
        /* A revoked claim cannot change its owner's new state. */
      }
      return JobStatus.Failed;
    }
  }
  private async extract<T>(
    row: MediaImport,
    provider: string | null,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const result = await this.repository.withCapacity(row, provider, async () => {
      const controller = new AbortController();
      const job = jobSignal();
      const signal = AbortSignal.any([controller.signal, ...(job ? [job] : [])]);
      const authority = this.repository.authority(row);
      let checking: Promise<void> | undefined;
      const timer = setInterval(() => {
        checking ??= this.repository
          .assertAuthority(authority)
          .then(() => {})
          .catch((error: unknown) => {
            controller.abort(error);
          })
          .finally(() => {
            checking = undefined;
          });
      }, 5000);
      timer.unref();
      try {
        await this.repository.assertAuthority(authority);
        const value = await action(signal);
        signal.throwIfAborted();
        return { value };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        clearInterval(timer);
        await checking;
      }
    });
    if (!result) throw new MediaCapacityWait();
    return result.value;
  }

  private async process(initial: MediaImport, authority: MediaImportAuthority) {
    let row = initial;
    const session = await this.session(row);
    const signal = jobSignal();
    if (row.state === 'inspecting') {
      let inspection: MediaDownloadInspection;
      if (row.subscriptionId) {
        const subscription = await this.repository.subscription(row.ownerId, row.subscriptionId);
        const since = subscriptionSince(subscription);
        inspection = await this.extract(row, null, (signal) =>
          this.downloader.enumerate(subscription.extractionUrl ?? subscription.url, {
            session,
            signal,
            checkpoint: subscription.checkpoint,
            since,
            limit: 100,
          }),
        );
        if (inspection.creatorId !== subscription.creatorId || inspection.provider !== subscription.provider) {
          await this.repository.failAttempt(
            authority,
            'Creator identity changed; inspect the account before continuing',
            'paused',
          );
          return;
        }
        if (since)
          inspection.entries = inspection.entries.filter(
            (entry) => !!entry.publishedAt && Date.parse(entry.publishedAt) >= Date.parse(since),
          );
      } else {
        const inspections: MediaDownloadInspection[] = [];
        for (const url of row.urls)
          inspections.push(
            await this.extract(row, null, (signal) => this.downloader.inspect(url, { session, signal })),
          );
        const entries = inspections.flatMap((item) => item.entries);
        inspection = {
          ...inspections[0],
          entries: entries.slice(0, 500),
          complete: entries.length <= 500 && inspections.every((item) => item.complete),
          limitation:
            entries.length > 500
              ? 'Preview is limited to 500 attachments'
              : (inspections.find((item) => item.limitation)?.limitation ?? null),
          kind: inspections.some((item) => item.kind === 'feed') ? 'feed' : 'item',
        };
        if (row.urls.length > 1) {
          inspection.creatorId = null;
          inspection.creator = null;
        }
      }
      await this.repository.discovered(authority, inspection, !row.subscriptionId);
      if (!row.subscriptionId) return;
      if (!inspection.complete && !inspection.checkpoint && inspection.entries.length === 0)
        throw new MediaDownloadError('incomplete');
      await this.repository.transition(authority, 'queued');
      row = (await this.repository.getWorker(row.id))!;
    }
    const root = join(StorageCore.getBaseFolder(StorageFolder.Upload), '.media-imports');
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const item of await this.repository.items(row.id)) {
      if (['saved', 'skipped'].includes(item.state)) continue;
      const itemAuthority = { ...authority, itemId: item.id };
      await this.repository.assertAuthority(itemAuthority);
      if (await this.repository.suppressed(row, item)) {
        await this.repository.progress(itemAuthority, 'skipped', undefined, 'Removed locally');
        continue;
      }
      if (await this.repository.reusePublished(itemAuthority, item)) continue;
      const directory = await mkdtemp(join(root, 'attempt-'));
      let pendingProgress = Promise.resolve();
      let lastProgressAt = 0;
      try {
        await this.repository.progress(itemAuthority, 'downloading');
        await this.repository.transition(authority, 'downloading');
        let reported = 0;
        const maxBytes = (await this.uploads.limits()).maxSize;
        const files = await this.extract(row, item.entry.provider, (signal) =>
          this.downloader.download(item.entry, {
            directory,
            session,
            signal,
            streamMp4: row.streamMp4,
            maxBytes,
            onProgress: (bytes, phase) => {
              if (bytes > reported) {
                advanceJobProgress(bytes - reported);
                reported = bytes;
              }
              // Progress is advisory; publication rechecks all authority in its transaction.
              if (Date.now() - lastProgressAt >= 1000) {
                lastProgressAt = Date.now();
                pendingProgress = pendingProgress
                  .then(() => this.repository.progress(itemAuthority, phase, bytes))
                  .catch(() => {});
              }
            },
          }),
        );
        await pendingProgress;
        if (files.length !== 1 || mediaSourceKey(files[0].entry) !== item.sourceKey)
          throw new BadRequestException('Inspect individual attachments before downloading');
        await this.repository.progress(itemAuthority, 'importing', files[0].size);
        await this.repository.transition(authority, 'importing');
        await this.uploads.importMedia(itemAuthority, files[0], item.createdAt);
      } catch (error) {
        await pendingProgress;
        if (signal?.aborted || error instanceof MediaCapacityWait) throw error;
        await this.repository.progress(
          itemAuthority,
          'failed',
          undefined,
          error instanceof MediaDownloadError ? error.message : 'Media could not be saved',
        );
        if (!(error instanceof MediaDownloadError) || ['authentication_required', 'rate_limited'].includes(error.code))
          throw error;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    const items = await this.repository.items(row.id);
    const failed = items.some((item) => item.state === 'failed');
    if (failed && row.retries < 4) throw new MediaDownloadError('incomplete');
    if (row.subscriptionId && row.inspection)
      await this.repository.finishSubscription(authority, { ...row.inspection, entries: [] }, failed);
    await this.repository.transition(authority, failed ? 'partial' : 'saved');
  }
}
