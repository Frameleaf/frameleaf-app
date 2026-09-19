import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { IEntityJob, JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  ICloudAuthDto,
  ICloudConnectionCreateDto,
  ICloudConnectionResponseDto,
  ICloudConnectionUpdateDto,
  ICloudConnectionsResponseDto,
  ICloudControlDto,
  ICloudInventoryResponseDto,
} from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ImmichWorker, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import {
  ICloudConnection,
  ICloudLibrary,
  ICloudResource,
  ICloudSyncRepository,
} from 'src/repositories/icloud-sync.repository.js';
import {
  ICloudPage,
  ICloudTransportError,
  ICloudTransportRepository,
} from 'src/repositories/icloud-transport.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { ICloudAlbumService } from 'src/services/icloud-album.service.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { checkAccess, requireElevatedPermission } from 'src/utils/access.js';

@Injectable()
export class ICloudSyncService {
  constructor(
    private repository: ICloudSyncRepository,
    private transport: ICloudTransportRepository,
    private staging: ICloudStagingService,
    private recovery: MediaRecoveryService,
    private jobs: JobRepository,
    private cron: CronRepository,
    private albums: ICloudAlbumService,
    private relations: ICloudRelationsService,
    private access: AccessRepository,
    private metadata: ICloudMetadataService,
  ) {}

  private async owned(auth: AuthDto, id: string): Promise<ICloudConnection> {
    if (!auth.session || auth.sharedLink || auth.apiKey) {
      throw new ForbiddenException('A signed-in web session is required');
    }
    const connection = await this.repository.get(id, auth.user.id);
    if (!connection) {
      throw new NotFoundException();
    }
    return connection;
  }

  private async response(connection: ICloudConnection): Promise<ICloudConnectionResponseDto> {
    return {
      id: connection.id,
      label: connection.label,
      state: connection.state,
      config: connection.config,
      lastError: connection.lastError,
      nextRunAt: connection.nextRunAt?.toISOString() ?? null,
      counts: {
        ...(await this.repository.counts(connection.id)),
        awaiting_auth: ['awaiting-2fa', 'awaiting-device-approval', 'reauthentication-required'].includes(
          connection.state,
        )
          ? 1
          : 0,
      },
    };
  }

  async list(auth: AuthDto): Promise<ICloudConnectionsResponseDto> {
    if (!auth.session) {
      throw new ForbiddenException();
    }
    const connections = await this.repository.list(auth.user.id);
    return {
      enabled: this.transport.enabled(),
      connections: await Promise.all(connections.map((row) => this.response(row))),
    };
  }

  async create(auth: AuthDto, dto: ICloudConnectionCreateDto): Promise<ICloudConnectionResponseDto> {
    if (!auth.session) {
      throw new ForbiddenException();
    }
    if (!this.transport.enabled()) {
      throw new BadRequestException('icloud_disabled');
    }
    await this.staging.root();
    this.checkLimits(dto.config);
    if (dto.config.includeHidden) {
      requireElevatedPermission(auth);
    }
    return this.response(await this.repository.create(auth.user.id, dto.label, dto.config));
  }

  private checkLimits(config: ICloudConnection['config']) {
    const limit = Number(process.env.IMMICH_ICLOUD_MAX_STAGING_BYTES ?? 100 * 1024 ** 3);
    const concurrency = Number(process.env.IMMICH_ICLOUD_MAX_CONCURRENCY ?? 4);
    if (
      !Number.isSafeInteger(limit) ||
      limit < config.stagingBytes ||
      !Number.isSafeInteger(concurrency) ||
      concurrency < config.concurrency
    ) {
      throw new BadRequestException('icloud_admin_limit_exceeded');
    }
  }

  async update(auth: AuthDto, id: string, dto: ICloudConnectionUpdateDto): Promise<ICloudConnectionResponseDto> {
    const connection = await this.owned(auth, id);
    const config = dto.config ? { ...connection.config, ...dto.config } : undefined;
    if (config) {
      if (config.includeHidden) {
        requireElevatedPermission(auth);
      }
      this.checkLimits(config);
    }
    await this.repository.update(id, auth.user.id, { ...dto, config });
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  async authenticate(
    auth: AuthDto,
    id: string,
    dto: ICloudAuthDto,
    secure: boolean,
  ): Promise<ICloudConnectionResponseDto> {
    await this.owned(auth, id);
    if (!secure) {
      throw new BadRequestException('icloud_requires_https');
    }
    if (!(await this.repository.admitAuth(id, auth.user.id))) {
      throw new BadRequestException('icloud_auth_rate_limited');
    }
    await this.repository.update(id, auth.user.id, { state: 'authenticating', lastError: null });
    try {
      await this.repository.withSession(id, auth.user.id, async (connection) => {
        const session =
          dto.action === 'login' ? undefined : await this.transport.decodeSession(id, connection.encryptedSession);
        const result = await this.transport.authenticate(dto, session);
        return {
          value: undefined,
          state: result.state,
          encryptedSession: await this.transport.encodeSession(id, result.session),
        };
      });
      await this.repository.update(id, auth.user.id, { lastError: null, nextRunAt: new Date() });
      await this.jobs.queue({ name: JobName.ICloudSync, data: { id } });
    } catch (error) {
      await this.failure(id, auth.user.id, error);
    }
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  async control(auth: AuthDto, id: string, dto: ICloudControlDto): Promise<ICloudConnectionResponseDto> {
    const connection = await this.owned(auth, id);
    if (dto.action === 'pause' || dto.action === 'cancel') {
      await this.repository.update(id, auth.user.id, { state: 'paused', nextRunAt: null });
    } else {
      if (!connection.encryptedSession) {
        throw new BadRequestException('reauthentication_required');
      }
      if (dto.action === 'rescan') {
        await this.repository.resetInventory(id);
      } else if (dto.action === 'retry') {
        await this.repository.retryFailures(id);
      }
      await this.repository.update(id, auth.user.id, { state: 'connected', nextRunAt: new Date(), lastError: null });
      await this.jobs.queue({ name: JobName.ICloudSync, data: { id } });
    }
    return this.response((await this.repository.get(id, auth.user.id))!);
  }

  async disconnect(auth: AuthDto, id: string): Promise<void> {
    await this.owned(auth, id);
    await this.repository.disconnect(id, auth.user.id);
  }

  async inventory(auth: AuthDto, id: string): Promise<ICloudInventoryResponseDto> {
    await this.owned(auth, id);
    const inventory = await this.repository.inventory(id);
    const receipts = await this.repository.receipts(id, auth.user.id);
    const allowed = await checkAccess(this.access, {
      auth,
      permission: Permission.AssetRead,
      ids: receipts.map(({ assetId }) => assetId),
    });
    return {
      libraries: inventory.libraries.map(({ id, fields }) => ({ id, name: fields.zoneID.zoneName, supported: true })),
      albums: inventory.albums,
      recent: receipts.filter(({ assetId }) => allowed.has(assetId)),
      complete: !!(await this.repository.checkpoint(id, 'inventory-complete').then((result) => result?.complete)),
    };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap(): Promise<void> {
    if (!this.transport.enabled()) {
      return;
    }
    await this.schedule();
    this.cron.create({
      name: 'icloud-sync',
      expression: '*/5 * * * *',
      onTick: () => {
        void this.schedule().catch(() => {});
      },
    });
  }

  private async schedule(): Promise<void> {
    for (const id of await this.repository.readyConnections()) {
      await this.jobs.queue({ name: JobName.ICloudSync, data: { id } });
    }
  }

  @OnJob({ name: JobName.ICloudSync, queue: QueueName.BackgroundTask })
  async handleSync({ id }: JobOf<JobName.ICloudSync>): Promise<JobStatus> {
    const connection = await this.repository.get(id);
    if (!connection || connection.state !== 'connected') {
      return JobStatus.Skipped;
    }
    try {
      await this.repository.startRun(connection);
      const inventoryComplete = await this.enumerate(connection);
      const resources: ICloudResource[] = [];
      for (let i = 0; i < connection.config.concurrency; i++) {
        const resource = await this.repository.claim(id, connection.config.stagingBytes);
        if (!resource) {
          break;
        }
        resources.push(resource);
      }
      await Promise.all(resources.map((resource) => this.transfer(connection, resource)));
      const albumsComplete = inventoryComplete && (await this.albums.reconcile(id, connection.ownerId));
      const relationsComplete = albumsComplete && (await this.relations.reconcile(id, connection.ownerId));
      const metadataComplete = relationsComplete && (await this.metadata.reconcile(id, connection.ownerId));
      if (resources.length > 0 || !inventoryComplete || !albumsComplete || !relationsComplete || !metadataComplete) {
        await this.jobs.queue({ name: JobName.ICloudSync, data: { id } });
      } else if (!(await this.repository.hasPending(id))) {
        await this.repository.completeRun(connection);
      }
      return JobStatus.Success;
    } catch (error) {
      await this.failure(id, connection.ownerId, error);
      return JobStatus.Failed;
    }
  }

  /** One inventory page or one keyset materialization batch per job. */
  private async enumerate(connection: ICloudConnection): Promise<boolean> {
    return this.repository.withSession(connection.id, connection.ownerId, async (current, db) => {
      if (current.state !== 'connected') {
        return { value: false };
      }
      let encryptedSession = current.encryptedSession!;
      const page = async (
        kind: 'libraries' | 'albums' | 'assets' | 'changes' | 'memberships',
        scope: string,
        libraryKey: string,
        library?: ICloudLibrary,
        albumId?: string,
      ): Promise<boolean> => {
        const checkpoint = await this.repository.checkpoint(current.id, scope, db);
        if (checkpoint?.complete) {
          return true;
        }
        const response: ICloudPage = await this.transport.inventory({
          session: await this.transport.decodeSession(current.id, encryptedSession),
          kind,
          library,
          albumId,
          cursor: checkpoint?.cursor,
        });
        encryptedSession = await this.transport.encodeSession(current.id, response.session);
        let records = response.records;
        switch (kind) {
          case 'libraries': {
            records = records.map((raw) => {
              const zone = raw as unknown as ICloudLibrary;
              if (!zone.zoneID?.zoneName || !['private', 'shared'].includes(zone.area)) {
                throw new Error('icloud_library_invalid');
              }
              const id = createHash('sha256')
                .update(
                  JSON.stringify([
                    zone.area,
                    zone.zoneID.zoneName,
                    zone.zoneID.ownerRecordName ?? '',
                    zone.zoneID.zoneType ?? '',
                  ]),
                )
                .digest('hex');
              return { recordName: id, recordType: 'Library', fields: zone as unknown as Record<string, unknown> };
            });

            break;
          }
          case 'albums': {
            await this.repository.saveAlbums(current.id, libraryKey, records, db);

            break;
          }
          case 'memberships': {
            const snapshotId = checkpoint?.snapshotId ?? randomUUID();
            // Initialize a stable snapshot before any page can mark memberships absent.
            if (!checkpoint) {
              await this.repository.initializeCheckpoint(current.id, scope, snapshotId, db);
            }
            await this.repository.saveMembershipPage(
              current.id,
              libraryKey,
              albumId!,
              records,
              snapshotId,
              response.complete,
              db,
            );

            break;
          }
          // No default
        }
        await this.repository.savePage(
          current.id,
          scope,
          libraryKey,
          records,
          response.nextCursor,
          response.complete,
          db,
        );
        return false;
      };
      if (!(await page('libraries', 'libraries', ''))) {
        return { value: false, encryptedSession };
      }
      const inventory = await this.repository.inventory(current.id, db);
      for (const { id: libraryKey, fields: library } of inventory.libraries) {
        if (current.config.libraries.length > 0 && !current.config.libraries.includes(libraryKey)) {
          continue;
        }
        if (!(await page('albums', `albums:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        if (!(await page('assets', `assets:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        if (!(await page('changes', `changes:${libraryKey}`, libraryKey, library))) {
          return { value: false, encryptedSession };
        }
        for (const album of inventory.albums) {
          if (album.libraryId !== libraryKey) {
            continue;
          }
          if (current.config.albums.length > 0 && !current.config.albums.includes(album.id)) {
            continue;
          }
          const sourceId = album.id.slice(libraryKey.length + 1);
          if (!(await page('memberships', `memberships:${album.id}`, libraryKey, library, sourceId))) {
            return { value: false, encryptedSession };
          }
        }
        if (!(await this.repository.materialize(current, libraryKey, library, db))) {
          return { value: false, encryptedSession };
        }
      }
      await this.repository.savePage(current.id, 'inventory-complete', '', [], null, true, db);
      return { value: true, encryptedSession };
    });
  }

  private async transfer(connection: ICloudConnection, resource: ICloudResource): Promise<void> {
    try {
      if (resource.status !== 'committed') {
        const authority = {
          resourceId: resource.id,
          leaseToken: resource.leaseToken!,
          ownerId: connection.ownerId,
          includeHidden: connection.config.includeHidden,
          recoverExternalAsManaged: connection.config.recoverExternalAsManaged,
        };
        const reused = await this.recovery.verifyMapped(authority);
        if (reused && reused.outcome !== 'reused') {
          await this.repository.finish(resource, reused.outcome, reused.reason ?? null);
          return;
        }
        if (!reused) {
          const path = await this.staging.download(connection, resource);
          const type = resource.source.type;
          if (type !== AssetType.Image && type !== AssetType.Video) {
            await this.repository.finish(resource, 'unsupported', 'media_type_unsupported');
            return;
          }
          const result = await this.recovery.reconcile({
            ...authority,
            stagedPath: path,
            originalFileName:
              typeof resource.source.originalFileName === 'string' ? resource.source.originalFileName : resource.id,
            type,
            sourceHidden: resource.source.isHidden === true,
            sourceCreatedAt:
              typeof resource.source.fileCreatedAt === 'string' ? new Date(resource.source.fileCreatedAt) : undefined,
          });
          if (!['imported', 'reused', 'repaired-missing', 'repaired-corrupt'].includes(result.outcome)) {
            await this.repository.finish(resource, result.outcome, result.reason ?? null);
            return;
          }
        }
      }
      const committed = await this.repository.resource(resource.id);
      if (committed?.status !== 'committed') {
        return;
      }
      for (const job of committed.pendingJobs) {
        if (job.name === JobName.AssetExtractMetadata || job.name === JobName.AssetGenerateThumbnails) {
          const data: IEntityJob = { id: job.data.id };
          if (job.data.source === 'upload') {
            data.source = job.data.source;
          }
          if ('notify' in job.data && typeof job.data.notify === 'boolean') {
            data.notify = job.data.notify;
          }
          await this.jobs.queue({ name: job.name, data });
        } else {
          throw new Error('icloud_outbox_job_invalid');
        }
      }
      await this.repository.clearOutbox(resource);
      await this.repository.finalize(resource, () => this.staging.cleanup(committed));
    } catch (error) {
      const reason = error instanceof ICloudTransportError ? error.code : 'icloud_transfer_failed';
      const current = await this.repository.resource(resource.id);
      await this.repository.finish(resource, current?.status === 'committed' ? 'committed' : 'retry', reason);
      if (error instanceof ICloudTransportError && error.code === 'resource_changed') {
        await this.repository.refreshResource(resource);
        return;
      }
      if (error instanceof ICloudTransportError) {
        throw error;
      }
    }
  }

  private async failure(id: string, ownerId: string, error: unknown): Promise<void> {
    const code = error instanceof ICloudTransportError ? error.code : 'icloud_operation_failed';
    if (code === 'invalid_change_token') {
      await this.repository.invalidateCursor(id, ownerId);
      return;
    }
    if (['rate_limited', 'icloud_transport_failed', 'icloud_transport_timeout'].includes(code)) {
      await this.repository.defer(id, ownerId, code);
      return;
    }
    const state =
      code === 'reauthentication_required'
        ? 'reauthentication-required'
        : code === 'device_approval_required'
          ? 'awaiting-device-approval'
          : 'error';
    await this.repository.block(id, ownerId, state, code);
  }
}
