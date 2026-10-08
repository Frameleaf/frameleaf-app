import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { coerce, gt } from 'semver';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BuddyRestoreDto } from 'src/dtos/buddy-backup.dto.js';
import type { DB } from 'src/schema/index.js';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import type { BuddyAlbumPlan } from 'src/utils/buddy-backup-metadata.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  AlbumUserRole,
  AssetStatus,
  AssetType,
  DatabaseLock,
  ImmichWorker,
  JobName,
  MaintenanceAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupFidelityRepository } from 'src/repositories/buddy-backup-fidelity.repository.js';
import { BuddyBackupMetadataRepository } from 'src/repositories/buddy-backup-metadata.repository.js';
import { BuddyBackupStudioRepository } from 'src/repositories/buddy-backup-studio.repository.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { BuddyBackupRecoveryService } from 'src/services/buddy-backup-recovery.service.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import {
  CloudBackupDetailsService,
  type OwnerRestoreDetailsContext,
} from 'src/services/cloud-backup-details.service.js';
import {
  type CloudBackupRestoreFile,
  type CloudBackupRestoreSnapshot,
  CloudBackupRestorer,
  emptyRestoreResult,
  restorePlan,
} from 'src/services/cloud-backup-restore.js';
import { MaintenanceService } from 'src/services/maintenance.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { BuddyExecutionError, BuddyPeerUnavailable } from 'src/utils/buddy-backup-client.js';
import { BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';
import { buddyFidelityFiles, buddyRestoreChecksum, readBuddyAssetFidelity } from 'src/utils/buddy-backup-fidelity.js';
import { assertBuddyAlbumPlan, buddyLibraryForOwner, selectBuddyAlbumIds } from 'src/utils/buddy-backup-metadata.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';
import { buddyFileHash } from 'src/utils/buddy-backup-recovery.js';
import {
  buddyStudioAssetIds,
  buddyStudioFiles,
  buddyStudioProjectIds,
  readBuddyStudioProject,
} from 'src/utils/buddy-backup-studio.js';
import { type BuddySignedSnapshot, writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  captureOwnerRestoreFile,
} from 'src/utils/cloud-backup-owner-path.js';
import {
  checkOwnerRestoreItems,
  ownerRestoreHash,
  readBackupAssetRecord,
} from 'src/utils/cloud-backup-owner-restore.js';
import { ownerBackupHistoryPage } from 'src/utils/cloud-backup-owner.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import { advanceExecutionProgress, assertExecutionActive, executionSignal } from 'src/utils/execution-signal.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { OperationDeadlineError, settleOperationStop, withOperationExecution } from 'src/utils/operation-execution.js';
import { isManagedStudioImportPath } from 'src/utils/studio-managed-paths.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';

type RestoreJob = {
  version: 1;
  request: BuddyRestoreDto;
  sessionId: string;
  admin: boolean;
  vaultId: string;
  fingerprint: string;
  owner: NonNullable<CloudBackupRestoreSnapshot['owner']>;
  manifestHash: string;
  albums?: BuddyAlbumPlan;
};
const LEASE_MS = 300_000;
class RestoreStopped extends Error {}

@Injectable()
export class BuddyBackupRestoreService {
  private active?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private backup: BuddyBackupService,
    private repository: BuddyBackupRepository,
    private index: CloudBackupIndexRepository,
    private operations: MediaOperationRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private logger: LoggingRepository,
    private details: CloudBackupDetailsService,
    private jobs: JobRepository,
    private recovery: BuddyBackupRecoveryService,
    private maintenance: MaintenanceService,
    private studioResources: StudioResourceService,
  ) {}

  private async auth(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink || !auth.session.hasElevatedPermission)
      throw new ForbiddenException('Unlock with your PIN to restore a backup.');
    return (await this.index.getOwnerRestoreAuth({ ownerId: auth.user.id, sessionId: auth.session.id })).auth;
  }

  private fingerprint(ring: unknown) {
    return createHash('sha256').update(JSON.stringify(ring)).digest('hex');
  }

  async administrator(auth: AuthDto) {
    const current = await this.auth(auth);
    if (!current.user.isAdmin) throw new ForbiddenException();
    return current;
  }

  async status(auth: AuthDto, id: string) {
    await this.auth(auth);
    const operation = await this.operations.getOfKind(id, MediaOperationKind.BuddyRestore);
    if (!operation || operation.ownerId !== auth.user.id) throw new NotFoundException('Restore unavailable');
    const preserved =
      operation.status === MediaOperationStatus.Completed && Array.isArray(operation.result?.preservedVersionAssetIds)
        ? operation.result.preservedVersionAssetIds.length
        : 0;
    return {
      id,
      state: operation.status,
      progress: operation.progress,
      phase: String(operation.result?.phase ?? operation.status),
      recoveryId: typeof operation.result?.recoveryId === 'string' ? operation.result.recoveryId : null,
      error:
        operation.error ??
        (preserved
          ? `Existing originals and their current saved versions were kept for ${preserved} item(s). Choose replace to restore their backed-up versions.`
          : null),
    };
  }

  async checkpoint(auth: AuthDto) {
    const current = await this.auth(auth);
    const { items } = await this.operations.list({
      ownerId: current.user.id,
      kind: MediaOperationKind.BuddyRestore,
      unfinishedFirst: true,
      take: 1,
      skip: 0,
    });
    if (!items[0]) return { operation: null };
    const operation = await this.status(current, items[0].id);
    if (operation.phase === 'ready-to-apply') {
      const journal = await readFile(
        join(this.repository.root(), 'recovery', operation.id, 'publication.json'),
        'utf8',
      ).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (journal && JSON.parse(journal).state === 'complete') return { operation: null };
      return { operation };
    }
    return { operation: ['completed', 'failed', 'cancelled'].includes(operation.state) ? null : operation };
  }

  async apply(auth: AuthDto, id: string) {
    const current = await this.administrator(auth);
    const status = await this.status(current, id);
    if (
      status.phase !== 'ready-to-apply' ||
      status.recoveryId !== id ||
      status.state !== MediaOperationStatus.Completed
    )
      throw new ConflictException('Wait for this restore to finish verification and staging.');
    const operation = await this.operations.getOfKind(id, MediaOperationKind.BuddyRestore);
    const job = operation!.snapshot as unknown as RestoreJob;
    await this.binding(job);
    if (!job.admin || !['server', 'settings'].includes(job.request.scope)) throw new ForbiddenException();
    const filename =
      job.request.scope === 'server'
        ? await this.recovery.prepare(id, async () => {
            await this.administrator(auth);
            await this.binding(job);
            const latest = await this.operations.getOfKind(id, MediaOperationKind.BuddyRestore);
            if (
              !latest ||
              latest.ownerId !== auth.user.id ||
              latest.status !== MediaOperationStatus.Completed ||
              latest.result?.recoveryId !== id ||
              latest.result?.phase !== 'ready-to-apply'
            )
              throw new ForbiddenException();
          })
        : undefined;
    return this.maintenance.startMaintenance(
      {
        action: MaintenanceAction.RestoreDatabase,
        buddyRecoveryId: id,
        restoreBackupFilename: filename,
        keepSafetyBackup: true,
        reason: 'Restoring Buddy Backup',
      },
      current.user.email,
    );
  }

  async open(snapshotId: string) {
    const client = await this.backup.client('read');
    const list = await client.request<Array<{ id: string; createdAt: string; sequence: number; keyVersion: number }>>(
      'GET',
      'snapshots',
    );
    const state = await this.repository.state();
    if ((list[0]?.sequence ?? 0) < state.lastSequence) throw new Error('Buddy snapshot rollback detected');
    if (list.every((entry) => entry.id !== snapshotId)) throw new NotFoundException('Backup unavailable');
    const envelope = await client.request<BuddySignedSnapshot>('GET', `snapshots/${snapshotId}`);
    const ring = await this.backup.keyring();
    const reader = new BuddyBackupReader(ring, envelope, (id) => client.request<Buffer>('GET', `objects/${id}`), {
      signal: executionSignal(),
      progress: advanceExecutionProgress,
    });
    const manifest = await reader.manifest();
    if (manifest.snapshotId !== snapshotId) throw new Error('Buddy snapshot identity mismatch');
    return { reader, manifest, envelope };
  }

  private async visible(auth: AuthDto, manifest: BuddyManifest) {
    const ids = Object.keys(manifest.library.assets).filter((id) => manifest.library.assets[id].owner === auth.user.id);
    const allowed: string[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const page = ids.slice(offset, offset + 100);
      const states = await this.index.getOwnerHistoryState(auth, page);
      const history = ownerBackupHistoryPage(
        auth,
        { ...manifest.library, assets: Object.fromEntries(page.map((id) => [id, manifest.library.assets[id]])) },
        states,
        { offset: 0, limit: 100 },
      );
      const historical = new Set(history.items.map((item) => item.assetId));
      for (const id of page) {
        const asset = manifest.library.assets[id];
        const state = states.get(id);
        if (
          historical.has(id) ||
          (state?.ownerId === auth.user.id &&
            state.allowed &&
            state.status === AssetStatus.Active &&
            asset.details?.visibility !== 'hidden' &&
            (asset.details?.visibility !== 'locked' || auth.session?.hasElevatedPermission))
        )
          allowed.push(id);
      }
    }
    return allowed;
  }

  async snapshots(auth: AuthDto, admin: boolean, offset = 0) {
    if (admin) await this.administrator(auth);
    const client = await this.backup.client('read');
    const snapshots = await client.request<
      Array<{ id: string; createdAt: string; sequence: number; keyVersion: number }>
    >('GET', 'snapshots');
    const page = snapshots.slice(offset, offset + 12);
    const nextOffset = offset + 12 < snapshots.length ? offset + 12 : null;
    if (admin) {
      await this.administrator(auth);
      return { snapshots: page, nextOffset };
    }
    const current = await this.auth(auth);
    const visible = [];
    for (const snapshot of page) {
      const { manifest } = await this.open(snapshot.id);
      const albums = manifest.metadata
        ? await new BuddyBackupMetadataRepository(this.repository.db).visibleAlbumIds(
            manifest.metadata,
            current.user.id,
          )
        : new Set<string>();
      if ((await this.visible(current, manifest)).length > 0 || albums.size > 0) {
        visible.push(snapshot);
      }
    }
    await this.auth(auth);
    return { snapshots: visible, nextOffset };
  }

  async browse(auth: AuthDto, snapshotId: string, admin: boolean, offset = 0) {
    const current = admin ? await this.administrator(auth) : await this.auth(auth);
    const { manifest } = await this.open(snapshotId);
    const library = buddyLibraryForOwner(manifest, current.user.id);
    const availableAlbums =
      !admin && manifest.metadata
        ? await new BuddyBackupMetadataRepository(this.repository.db).visibleAlbumIds(
            manifest.metadata,
            current.user.id,
          )
        : undefined;
    const ids = admin ? Object.keys(manifest.library.assets) : await this.visible(current, manifest);
    const permitted = new Set(ids);
    if (admin) await this.administrator(auth);
    else await this.auth(auth);
    return {
      items: ids.slice(offset, offset + 100).map((id) => ({
        id,
        name: manifest.library.assets[id].originalFileName ?? '',
        ownerId: manifest.library.assets[id].owner ?? undefined,
        bytes: manifest.library.assets[id].files.reduce((sum, file) => sum + file.size, 0),
      })),
      nextOffset: offset + 100 < ids.length ? offset + 100 : null,
      albums: Object.entries(library.albums)
        .filter(([, album]) => admin || album.ownerId === current.user.id)
        .filter(([id]) => !availableAlbums || availableAlbums.has(id))
        .flatMap(([id, album]) => {
          const members = Object.entries(manifest.library.assets).filter(
            ([assetId, asset]) => permitted.has(assetId) && asset.details?.albums.some((entry) => entry.id === id),
          );
          return members.length > 0 || manifest.metadata ? [{ id, name: album.name, items: members.length }] : [];
        }),
    };
  }

  private async selection(auth: AuthDto, request: BuddyRestoreDto, manifest: BuddyManifest, admin: boolean) {
    const library = buddyLibraryForOwner(manifest, auth.user.id);
    if (!admin && ['library', 'settings', 'server'].includes(request.scope))
      throw new ForbiddenException('Administrator restore required');
    if (request.scope === 'asset' && !request.assetIds?.length)
      throw new BadRequestException('Choose items to restore');
    if (
      request.scope === 'album' &&
      (!request.albumId ||
        !library.albums[request.albumId] ||
        (!admin && library.albums[request.albumId].ownerId !== auth.user.id))
    )
      throw new NotFoundException('Backup album unavailable');
    const all = Object.keys(manifest.library.assets);
    const albumIds =
      request.scope === 'album' && manifest.metadata
        ? new Set(
            selectBuddyAlbumIds(manifest.metadata, { ...request, assetIds: [] }, library.assets, auth.user.id, admin),
          )
        : new Set(request.albumId ? [request.albumId] : []);
    let ids =
      request.scope === 'asset'
        ? request.assetIds!
        : request.scope === 'album'
          ? all.filter((id) => manifest.library.assets[id].details?.albums.some((album) => albumIds.has(album.id)))
          : all;
    if (!admin) {
      const allowed = new Set(await this.visible(auth, manifest));
      if (request.scope === 'asset' && ids.some((id) => !allowed.has(id)))
        throw new NotFoundException('Backup item unavailable');
      ids = ids.filter((id) => allowed.has(id));
    }
    const requested = new Set(ids);
    for (const id of ids) {
      const motion = manifest.assetLinks?.[id]?.livePhotoVideoId;
      if (motion) {
        if (
          !manifest.library.assets[motion] ||
          manifest.library.assets[motion].owner !== manifest.library.assets[id]?.owner
        )
          throw new NotFoundException('A Live Photo component is unavailable');
        requested.add(motion);
      }
    }
    ids = [...requested];
    if (new Set(ids).size !== ids.length || ids.some((id) => !manifest.library.assets[id]))
      throw new BadRequestException('Invalid restore selection');
    return ids;
  }

  async prepare(auth: AuthDto, request: BuddyRestoreDto, admin: boolean) {
    const current = await this.auth(auth);
    if (admin && !current.user.isAdmin) throw new ForbiddenException();
    const { reader, manifest } = await this.open(request.snapshotId);
    const ids = await this.selection(current, request, manifest, admin);
    const projectIds = buddyStudioProjectIds(manifest, request.scope);
    for (const projectId of projectIds) {
      const project = readBuddyStudioProject(manifest, projectId);
      if (buddyStudioAssetIds(manifest, project).some((id) => !ids.includes(id)))
        throw new BadRequestException('A Studio project dependency is outside this restore');
      const currentProject = await this.repository.db
        .selectFrom('studio_project')
        .select('ownerId')
        .where('id', '=', projectId)
        .executeTakeFirst();
      if (currentProject && currentProject.ownerId !== project.ownerId)
        throw new ForbiddenException('Studio project ownership changed');
    }
    const version = coerce(manifest.frameleafVersion);
    const running = coerce(serverVersion.toString());
    if (!version || !running || gt(version, running))
      throw new BadRequestException('Update this Frameleaf server before restoring this snapshot.');
    const selectedFiles: Array<{ size: number }> =
      request.scope === 'settings'
        ? manifest.configurationFiles
        : ids.flatMap((id) =>
            manifest.library.assets[id].files.filter(
              (file) =>
                request.scope === 'server' ||
                file.role === 'original' ||
                file.role === 'sidecar' ||
                (!manifest.assetFidelity &&
                  manifest.assetFiles?.[id]?.some((row) => row.isEdited && row.path === file.path)),
            ),
          );
    if (!['settings', 'server'].includes(request.scope))
      for (const id of ids) selectedFiles.push(...(readBuddyAssetFidelity(manifest, id)?.files ?? []));
    for (const projectId of projectIds) selectedFiles.push(...readBuddyStudioProject(manifest, projectId).files);
    if (request.scope === 'server')
      selectedFiles.push(
        ...Object.values(manifest.library.profiles),
        ...manifest.dependencies,
        ...manifest.configurationFiles,
        ...(manifest.library.database ? [manifest.library.database] : []),
      );
    const bytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    const free = await statfs(StorageCore.getMediaLocation());
    if (bytes + 1024 ** 3 > free.bavail * free.bsize)
      throw new BadRequestException('More free space is needed to stage and verify this restore.');
    const identities = await this.index.getOwnerRestoreIdentities(ids);
    const albumIds = manifest.metadata
      ? selectBuddyAlbumIds(
          manifest.metadata,
          { ...request, assetIds: request.mode === 'keep' ? ids.filter((id) => !identities[id]) : ids },
          manifest.library.assets,
          current.user.id,
          admin,
        )
      : [];
    const albums = manifest.metadata
      ? await new BuddyBackupMetadataRepository(this.repository.db).plan(manifest.metadata, albumIds, request.mode)
      : undefined;
    const owner = {
      ownerId: current.user.id,
      sessionId: current.session!.id,
      current: identities,
      assetHashes: Object.fromEntries(
        ids.map((id) => [
          id,
          ownerRestoreHash(
            manifest.library.assets[id],
            buddyLibraryForOwner(manifest, manifest.library.assets[id].owner!),
          ),
        ]),
      ),
    };
    const projectConflicts =
      projectIds.length > 0
        ? await this.repository.db.selectFrom('studio_project').select('id').where('id', 'in', projectIds).execute()
        : [];
    const conflicts = ids.filter((id) => identities[id]).length + projectConflicts.length;
    const items = ids.length + projectIds.length;
    if (!request.confirm) {
      return {
        operationId: null,
        items,
        metadataItems: albumIds.length,
        bytes,
        conflicts,
        mode: request.mode,
        state: 'preview',
      };
    }
    const currentAuth = admin ? await this.administrator(auth) : await this.auth(auth);
    await this.selection(currentAuth, request, manifest, admin);
    const job: RestoreJob = {
      version: 1,
      request: { ...request, assetIds: ids },
      sessionId: current.session!.id,
      admin,
      vaultId: reader.ring.vaultId,
      fingerprint: this.fingerprint(reader.ring),
      owner,
      manifestHash: this.fingerprint(manifest),
      ...(albums && { albums }),
    };
    const result = await this.operations.createExclusive(
      {
        ownerId: current.user.id,
        kind: MediaOperationKind.BuddyRestore,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Restore Buddy Backup',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: job as unknown as Record<string, unknown>,
        settings: {},
        estimate: null,
        result: {},
        totalUnits: null,
      },
      DatabaseLock.BuddyBackup,
    );
    if (!('created' in result)) throw new ConflictException('Another Buddy restore is running');
    this.tick();
    return {
      operationId: result.created.id,
      items,
      metadataItems: albumIds.length,
      bytes,
      conflicts,
      mode: request.mode,
      state: 'queued',
    };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.timer = setInterval(() => this.tick(), 10_000);
    this.tick();
  }
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
  }
  tick() {
    if (this.active || this.stopped) return;
    this.active = this.drain()
      .catch(() => this.logger.warn('Buddy restore worker is waiting.'))
      .finally(() => {
        this.active = undefined;
      });
  }
  private async drain() {
    await this.drainRestoreJobs().catch(() => this.logger.warn('Buddy restore metadata jobs are waiting for retry.'));
    const claim = await this.operations.claimNext({
      kinds: [MediaOperationKind.BuddyRestore],
      workerId: `buddy-restore-${process.pid}`,
      leaseMs: LEASE_MS,
    });
    if (claim) await this.run(claim.operation, claim.claimToken);
  }

  private async binding(job: RestoreJob) {
    const ring = await this.backup.keyring(job.vaultId);
    if (ring.vaultId !== job.vaultId || this.fingerprint(ring) !== job.fingerprint)
      throw new Error('Buddy restore key binding changed');
  }

  private async restoreAlbums(
    operation: MediaOperation,
    token: string,
    job: RestoreJob,
    manifest: BuddyManifest,
    snapshot: CloudBackupRestoreSnapshot,
  ) {
    if (!manifest.metadata) {
      return;
    }
    if (!job.albums || job.owner.ownerId !== operation.ownerId || job.owner.sessionId !== job.sessionId) {
      throw new Error('Buddy restore album selection unavailable');
    }
    const selected = selectBuddyAlbumIds(
      manifest.metadata,
      {
        ...job.request,
        assetIds:
          job.request.mode === 'keep'
            ? job.request.assetIds?.filter((id) => !job.owner.current[id])
            : job.request.assetIds,
      },
      manifest.library.assets,
      operation.ownerId,
      job.admin,
    );
    assertBuddyAlbumPlan(manifest.metadata, job.albums, selected, job.request.mode);
    const metadata = new BuddyBackupMetadataRepository(this.repository.db);
    await metadata.withRestore(
      job.owner,
      { operationId: operation.id, claimToken: token },
      job.admin,
      async () => {
        await this.binding(job);
        if (this.fingerprint(manifest) !== job.manifestHash) {
          throw new Error('Buddy restore manifest changed');
        }
      },
      async (trx) => {
        const index = new CloudBackupIndexRepository(trx);
        const { auth } = await index.getOwnerRestoreAuth({ ownerId: operation.ownerId, sessionId: job.sessionId });
        if (!job.admin) {
          const library = buddyLibraryForOwner(manifest, auth.user.id);
          for (const id of job.request.assetIds ?? []) {
            const parent = job.request.assetIds?.find(
              (assetId) => manifest.assetLinks?.[assetId]?.livePhotoVideoId === id,
            );
            await checkOwnerRestoreItems(auth, library, snapshot, true, index, [id], true, parent);
          }
        }
        await new BuddyBackupMetadataRepository(trx).publish(job.albums!, operation.ownerId, job.admin);
      },
    );
  }

  private async guarded<T>(
    operation: MediaOperation,
    token: string,
    job: RestoreJob,
    manifest: BuddyManifest,
    snapshot: CloudBackupRestoreSnapshot,
    file: CloudBackupRestoreFile,
    action: (trx: Transaction<DB>, ownerId: string) => Promise<T>,
    inspect = false,
  ) {
    if (file.role === 'buddy-studio')
      return this.guardedStudio(
        operation,
        token,
        job,
        manifest,
        file.fileKey.split(':', 2)[1],
        (trx, owner) => action(trx, owner.user.id),
        file,
      );
    if (!file.assetId) throw new Error('Buddy restore item is missing');
    const assetId = file.assetId;
    const execute = async (trx: Transaction<DB>) => {
      const index = new CloudBackupIndexRepository(trx);
      const { auth } = await index.getOwnerRestoreAuth({ ownerId: operation.ownerId, sessionId: job.sessionId });
      if (job.admin ? !auth.user.isAdmin : auth.user.id !== job.owner.ownerId)
        throw new Error('Buddy restore authorization changed');
      if (!job.admin) {
        const parentId = snapshot.assetIds?.find((id) => manifest.assetLinks?.[id]?.livePhotoVideoId === assetId);
        if (parentId) {
          const parent = await trx
            .selectFrom('asset')
            .select(['ownerId', 'livePhotoVideoId'])
            .where('id', '=', parentId)
            .forShare()
            .executeTakeFirst();
          const motion = await trx.selectFrom('asset').select('id').where('id', '=', assetId).executeTakeFirst();
          if (
            parent &&
            (parent.ownerId !== auth.user.id ||
              (parent.livePhotoVideoId !== assetId &&
                (parent.livePhotoVideoId !== null ||
                  (motion && job.owner.current[parentId] && job.owner.current[assetId]))))
          )
            throw new Error('Live Photo relationship changed');
        }
        await checkOwnerRestoreItems(
          auth,
          buddyLibraryForOwner(manifest, auth.user.id),
          snapshot,
          true,
          index,
          [assetId],
          true,
          parentId,
        );
      }
      const ownerId = manifest.library.assets[assetId].owner!;
      const owner = await trx
        .selectFrom('user')
        .select(['id', 'storageLabel'])
        .where('id', '=', ownerId)
        .where('deletedAt', 'is', null)
        .executeTakeFirstOrThrow();
      const current = await trx
        .selectFrom('asset')
        .select(['originalPath', 'ownerId', 'libraryId'])
        .where('id', '=', assetId)
        .forUpdate()
        .executeTakeFirst();
      if (
        current &&
        (current.ownerId !== ownerId || (file.role === 'original' && current.originalPath !== file.target))
      )
        throw new Error('Buddy restore destination changed');
      const roots = [
        StorageCore.getFolderLocation(StorageFolder.Upload, ownerId),
        StorageCore.getLibraryFolder(owner),
        StorageCore.getFolderLocation(StorageFolder.Thumbnails, ownerId),
        StorageCore.getFolderLocation(StorageFolder.EncodedVideo, ownerId),
      ];
      const external = manifest.assetLinks?.[assetId];
      if (external?.isExternal) {
        if (!job.admin || !external.libraryId || (current && current.libraryId !== external.libraryId))
          throw new Error('External library identity changed');
        const library = await trx
          .selectFrom('library')
          .select('importPaths')
          .where('id', '=', external.libraryId)
          .where('ownerId', '=', ownerId)
          .where('deletedAt', 'is', null)
          .forShare()
          .executeTakeFirstOrThrow();
        roots.push(...library.importPaths);
      }
      if (file.role === 'buddy-version') {
        const expected = buddyFidelityFiles(manifest, assetId).find((entry) => entry.fileKey === file.fileKey);
        if (
          !expected ||
          expected.target !== file.target ||
          expected.sha256 !== file.sha256 ||
          expected.size !== file.size
        )
          throw new Error('Buddy version destination changed');
        // A deleted asset's owner directory may be gone. Only the recomputed private target
        // may be created below the current managed mount; all existing ancestors are checked.
        roots.push(StorageCore.getBaseFolder(StorageFolder.Thumbnails));
      }
      await assertOwnerRestorePath(roots, file.target);
      if (file.role === 'buddy-version' && inspect) {
        // These deterministic owner-private copies are immutable. Publication still uses the ordinary
        // unreferenced-path guard; inspection also permits a retry after their metadata committed.
        await lockFilePath(trx, file.target);
        return action(trx, ownerId);
      }
      const source = manifest.library.assets[assetId].files[Number(file.fileKey.split(':').at(-1))];
      const derivative =
        file.role === 'original' || file.role === 'buddy-version'
          ? undefined
          : manifest.assetFiles?.[assetId]?.find((entry) => entry.path === source?.path);
      const physical = new PhysicalFileRepository(trx);
      if (inspect) {
        await physical.inspectOwnerRestorePath(file.target, assetId, ownerId, derivative);
        return action(trx, ownerId);
      }
      return physical.withOwnerRestorePath(file.target, assetId, ownerId, () => action(trx, ownerId), derivative);
    };
    await this.binding(job);
    if (!job.admin)
      return this.index.withOwnerRestore(
        job.owner,
        snapshot,
        assetId,
        { operationId: operation.id, claimToken: token },
        execute,
        { authorize: () => this.binding(job) },
      );
    return this.repository.db.transaction().execute(async (trx) => {
      const session = await trx
        .selectFrom('session')
        .select('id')
        .where('id', '=', job.sessionId)
        .where('userId', '=', operation.ownerId)
        .where('pinExpiresAt', '>', sql<Date>`clock_timestamp()`)
        .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]))
        .forShare()
        .noWait()
        .executeTakeFirst();
      const user = await trx
        .selectFrom('user')
        .select('id')
        .where('id', '=', operation.ownerId)
        .where('isAdmin', '=', true)
        .where('deletedAt', 'is', null)
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (!session || !user) throw new ForbiddenException('Administrator recovery authorization changed');
      const current = await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', operation.id)
        .where('claimToken', '=', token)
        .where('kind', '=', MediaOperationKind.BuddyRestore)
        .where('status', '=', MediaOperationStatus.Rendering)
        .where('cancelRequestedAt', 'is', null)
        .where('pauseRequestedAt', 'is', null)
        .where('claimExpiresAt', '>', new Date())
        .forShare()
        .noWait()
        .executeTakeFirst();
      if (!current) throw new RestoreStopped();
      return execute(trx);
    });
  }

  private async guardedStudio<T>(
    operation: MediaOperation,
    token: string,
    job: RestoreJob,
    manifest: BuddyManifest,
    projectId: string,
    action: (trx: Transaction<DB>, owner: AuthDto) => Promise<T>,
    file?: CloudBackupRestoreFile,
  ) {
    if (
      !job.admin ||
      job.request.scope !== 'library' ||
      !buddyStudioProjectIds(manifest, 'library').includes(projectId)
    )
      throw new ForbiddenException('Studio projects require administrator library recovery');
    const project = readBuddyStudioProject(manifest, projectId);
    return new BuddyBackupStudioRepository(this.repository.db).guarded(
      {
        project,
        actorId: operation.ownerId,
        sessionId: job.sessionId,
        operationId: operation.id,
        claimToken: token,
        authorize: () => this.binding(job),
      },
      async (trx, owner) => {
        if (!file) return action(trx, owner);
        const expected = buddyStudioFiles(manifest, projectId).find((entry) => entry.fileKey === file.fileKey);
        if (
          !expected ||
          file.assetId !== null ||
          file.target !== expected.target ||
          file.sha256 !== expected.sha256 ||
          file.size !== expected.size
        )
          throw new Error('Buddy Studio destination changed');
        await assertOwnerRestorePath([StorageCore.getBaseFolder(StorageFolder.Exports)], file.target);
        return new PhysicalFileRepository(trx).withStudioRestorePath(
          file.target,
          projectId,
          project.ownerId,
          file.sha256,
          () => action(trx, owner),
        );
      },
    );
  }

  private fileJournal(operationId: string, file: CloudBackupRestoreFile) {
    return join(
      this.repository.root(),
      'restores',
      operationId,
      'files',
      createHash('sha256').update(file.fileKey).digest('hex'),
    );
  }

  private async recordFile(operationId: string, file: CloudBackupRestoreFile, preserve: boolean) {
    const evidence = await captureOwnerRestoreFile(file.target, async (path) =>
      (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
    );
    if (!evidence.identity || (!preserve && (evidence.sha256 !== file.sha256 || evidence.size !== BigInt(file.size))))
      throw new Error('Buddy restored file did not verify');
    const record = {
      target: file.target,
      identity: evidence.identity,
      sha256: evidence.sha256,
      size: String(evidence.size),
    };
    const path = this.fileJournal(operationId, file);
    try {
      const previous = JSON.parse(await readFile(path, 'utf8'));
      if (JSON.stringify(previous) !== JSON.stringify(record))
        throw new Error('Buddy restored file checkpoint changed');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await writeBuddyFile(path, JSON.stringify(record), true);
    }
  }

  private async verifyFiles(operationId: string, files: CloudBackupRestoreFile[]) {
    const evidence = new Map<string, { identity: string; sha256: string; size: string }>();
    for (const file of files) {
      const recorded = JSON.parse(await readFile(this.fileJournal(operationId, file), 'utf8'));
      if (recorded.target !== file.target || !recorded.identity || !/^[a-f0-9]{64}$/.test(recorded.sha256))
        throw new Error('Buddy restored file checkpoint unavailable');
      await assertOwnerRestoreFile(file.target, recorded.identity);
      evidence.set(file.fileKey, recorded);
    }
    return evidence;
  }

  /** Written before the metadata transaction commits; dispatched only after the complete restore verifies. */
  private async saveRestoreJobs(
    operationId: string,
    assetId: string,
    jobs: OwnerRestoreDetailsContext['jobs'],
    retainedEditedProjection = false,
  ) {
    if (jobs.length === 0 && !retainedEditedProjection) return;
    if (!BUDDY_UUID.test(operationId) || !BUDDY_UUID.test(assetId)) throw new Error('Invalid restore job identity');
    const path = join(this.repository.root(), 'restores', operationId, 'jobs', `${assetId}.json`);
    const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '[]';
    });
    const pending: OwnerRestoreDetailsContext['jobs'] = [...JSON.parse(previous), ...jobs];
    // A verified captured projection is already rendered. Also prune intent left by an
    // interrupted attempt, whose metadata transaction may have committed before publication.
    const filtered = retainedEditedProjection
      ? pending.filter((job) => job.name !== JobName.AssetEditThumbnailGeneration || job.data.id !== assetId)
      : pending;
    await writeBuddyFile(
      path,
      JSON.stringify(new Map(filtered.map((job) => [JSON.stringify(job), job])).values().toArray()),
    );
  }

  private async drainRestoreJobs() {
    const root = join(this.repository.root(), 'restores');
    const names = (path: string) =>
      readdir(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return [] as string[];
      });
    for (const id of await names(root)) {
      if (!BUDDY_UUID.test(id)) continue;
      const directory = join(root, id, 'jobs');
      const files = await names(directory);
      if (files.length === 0) continue;
      const operation = await this.operations.getOfKind(id, MediaOperationKind.BuddyRestore);
      if (operation?.status !== MediaOperationStatus.Completed || operation.claimToken) continue;
      for (const file of files) {
        if (!file.endsWith('.json') || !BUDDY_UUID.test(file.slice(0, -5))) continue;
        const path = join(directory, file);
        const pending = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return '[]';
        });
        await this.jobs.queueAll(JSON.parse(pending));
        // At-least-once dispatch: a crash before unlink may replay these idempotent metadata jobs.
        await rm(path, { force: true });
      }
    }
  }

  private async run(operation: MediaOperation, token: string) {
    return withOperationExecution(
      {
        renew: () => this.operations.heartbeat(operation.id, token, LEASE_MS, { requireActiveClaim: true }),
        stopped: () => this.stopped,
      },
      () => this.runClaim(operation, token),
    );
  }

  private async runClaim(operation: MediaOperation, token: string) {
    const job = operation.snapshot as unknown as RestoreJob;
    try {
      await this.binding(job);
      const { reader, manifest } = await this.open(job.request.snapshotId);
      if (this.fingerprint(manifest) !== job.manifestHash) throw new Error('Buddy restore manifest changed');
      const checkpoint = async () => {
        assertExecutionActive();
        const current = await this.operations.getOfKind(operation.id, MediaOperationKind.BuddyRestore);
        if (
          this.stopped ||
          !current ||
          current.claimToken !== token ||
          current.cancelRequestedAt ||
          current.pauseRequestedAt
        )
          throw new RestoreStopped();
        const { auth } = await this.index.getOwnerRestoreAuth({ ownerId: operation.ownerId, sessionId: job.sessionId });
        if (job.admin && !auth.user.isAdmin) throw new Error('Buddy administrator authorization changed');
        await this.binding(job);
      };
      if (
        !(await this.operations.reportProgress(operation.id, token, {
          status: MediaOperationStatus.Rendering,
          processedUnits: 0,
          totalUnits: null,
          progress: 0,
        }))
      )
        throw new RestoreStopped();
      await checkpoint();
      if (job.request.scope === 'server' || job.request.scope === 'settings') {
        await this.stageRecovery(operation, token, job, manifest, reader, checkpoint);
      } else {
        const ids = job.request.assetIds!;
        const snapshot: CloudBackupRestoreSnapshot = {
          version: 1,
          bucketRef: job.vaultId,
          keyFingerprint: job.fingerprint,
          manifestKey: manifest.snapshotId,
          scope: 'asset',
          assetIds: ids,
          details: job.request.mode,
          owner: job.owner,
        };
        const current = await this.index.getOwnerRestoreIdentities(ids);
        const plan = restorePlan({
          manifest: manifest.library,
          scope: 'asset',
          assetIds: ids,
          operationId: operation.id,
          mediaLocation: StorageCore.getMediaLocation(),
          currentOriginals: new Map(
            Object.entries(current)
              .filter(([, item]) => !item.isExternal)
              .map(([id, item]) => [id, item.originalPath]),
          ),
        });
        for (const file of plan.files) {
          const assetId = file.assetId!;
          const source = manifest.library.assets[assetId].files[Number(file.fileKey.split(':').at(-1))];
          const metadata = manifest.assetFiles?.[assetId]?.find((entry) => entry.path === source.path);
          if (metadata) {
            const existing = await this.repository.db
              .selectFrom('asset_file')
              .select('path')
              .where('assetId', '=', assetId)
              .where('type', '=', metadata.type)
              .where('isEdited', '=', metadata.isEdited)
              .executeTakeFirst();
            file.target = existing?.path ?? source.path;
            file.inPlace = true; // The current owner and mount guard validates every publication.
          }
          if (job.admin && manifest.assetLinks?.[assetId]?.isExternal && file.role === 'original') {
            file.target = current[assetId]?.originalPath ?? source.path;
            file.inPlace = true;
          }
        }
        plan.files = plan.files.filter(
          (file) =>
            file.role === 'original' ||
            file.role === 'sidecar' ||
            (!manifest.assetFidelity &&
              (job.request.mode === 'replace' || !job.owner.current[file.assetId!]) &&
              manifest.assetFiles?.[file.assetId!]?.some(
                (entry) =>
                  entry.isEdited &&
                  entry.path ===
                    manifest.library.assets[file.assetId!].files[Number(file.fileKey.split(':').at(-1))].path,
              )),
        );
        plan.files.push(...ids.flatMap((id) => buddyFidelityFiles(manifest, id)));
        const projectIds = buddyStudioProjectIds(manifest, job.request.scope);
        for (const projectId of projectIds) {
          if (
            buddyStudioAssetIds(manifest, readBuddyStudioProject(manifest, projectId)).some((id) => !ids.includes(id))
          )
            throw new Error('Buddy Studio dependency is outside this restore');
          plan.files.push(...buddyStudioFiles(manifest, projectId));
        }
        plan.files.sort((a, b) => compareCodeUnits(a.fileKey, b.fileKey));
        if (plan.files.some((file) => !file.inPlace))
          throw new Error('Restore the original storage mounts before restoring these items.');
        const restorer = new CloudBackupRestorer(null, this.storage, this.crypto, this.logger);
        const done = await restorer.restore({
          manifest: manifest.library,
          scope: 'asset',
          files: plan.files,
          destination: null,
          stageBesideTarget: true,
          read: async (_key, path, sha256) => {
            await checkpoint();
            return reader.download(manifest, sha256, path);
          },
          mediaLocation: StorageCore.getMediaLocation(),
          backupsFolder: StorageCore.getBaseFolder(StorageFolder.Backups),
          operationId: operation.id,
          start: { ...emptyRestoreResult(), ...operation.result },
          completedFile: (file, outcome) =>
            this.recordFile(
              operation.id,
              file,
              file.role !== 'buddy-version' &&
                file.role !== 'buddy-studio' &&
                job.request.mode === 'keep' &&
                outcome === 'skipped',
            ),
          checkpoint: async (result) => {
            await checkpoint();
            const saved = await this.operations.setBulkResult(operation.id, token, {
              result,
              processedUnits: result.files,
              totalUnits: result.filesTotal,
              progress: result.filesTotal ? (result.files * 100) / result.filesTotal : 100,
              leaseMs: LEASE_MS,
            });
            return !!saved && !saved.cancelRequestedAt && !saved.pauseRequestedAt;
          },
          publish: async (file, _staged, publish, phase) => {
            if (phase === 'inspect')
              return this.guarded(
                operation,
                token,
                job,
                manifest,
                snapshot,
                file,
                () => Promise.resolve('skipped' as const),
                true,
              );
            const evidence = await captureOwnerRestoreFile(file.target, async (path) =>
              (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
            );
            if (
              ['buddy-version', 'buddy-studio'].includes(file.role) &&
              evidence.identity &&
              evidence.sha256 !== file.sha256
            )
              throw new Error('A retained Buddy version copy changed');
            if (evidence.identity && (job.request.mode === 'keep' || evidence.sha256 === file.sha256))
              return this.guarded(
                operation,
                token,
                job,
                manifest,
                snapshot,
                file,
                async () => {
                  await assertOwnerRestoreFile(file.target, evidence.identity);
                  return 'skipped' as const;
                },
                true,
              );
            return this.guarded(operation, token, job, manifest, snapshot, file, publish);
          },
          library: async (result) => {
            const verified = await this.verifyFiles(operation.id, plan.files);
            const preservedVersionAssetIds: string[] = [];
            await this.restoreAlbums(operation, token, job, manifest, snapshot);
            for (const assetId of ids) {
              await checkpoint();
              const file = plan.files.find((entry) => entry.assetId === assetId && entry.role === 'original')!;
              const evidence = await captureOwnerRestoreFile(file.target, async (path) =>
                (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
              );
              if (evidence.sha256 !== file.sha256 && job.request.mode === 'replace')
                throw new Error('Buddy restored original changed');
              const queued: OwnerRestoreDetailsContext['jobs'] = [];
              await this.guarded(
                operation,
                token,
                job,
                manifest,
                snapshot,
                file,
                async (trx, ownerId) => {
                  await assertOwnerRestoreFile(file.target, evidence.identity);
                  const index = new CloudBackupIndexRepository(trx);
                  const existing = (await index.getAssetDetails([assetId])).get(assetId);
                  const asset = manifest.library.assets[assetId];
                  const library = buddyLibraryForOwner(manifest, ownerId);
                  const context: OwnerRestoreDetailsContext = {
                    db: trx,
                    ownerId,
                    jobs: queued,
                    buddyPeople: true,
                    buddyPeopleMode: job.request.mode,
                  };
                  const albums = [];
                  for (const album of existing && job.request.mode === 'keep' ? [] : (asset.details?.albums ?? [])) {
                    if (
                      library.albums[album.id]?.ownerId !== ownerId ||
                      (manifest.metadata && !job.albums?.albums[album.id])
                    ) {
                      continue;
                    }
                    const present = await trx
                      .selectFrom('album')
                      .select(['id', 'deletedAt'])
                      .where('id', '=', album.id)
                      .executeTakeFirst();
                    const owned =
                      !present ||
                      (!present.deletedAt &&
                        (await trx
                          .selectFrom('album_user')
                          .select('userId')
                          .where('albumId', '=', album.id)
                          .where('userId', '=', ownerId)
                          .where('role', '=', AlbumUserRole.Owner)
                          .executeTakeFirst()));
                    if (owned) {
                      await this.details.restoreAlbum(
                        { albumId: album.id, album: library.albums[album.id], memberIds: [] },
                        context,
                      );
                      albums.push(album);
                    }
                  }
                  const details = { ...asset.details!, albums };
                  if (existing) {
                    const currentChecksum = await trx
                      .selectFrom('asset')
                      .select(['checksum', 'checksumAlgorithm'])
                      .where('id', '=', assetId)
                      .executeTakeFirstOrThrow();
                    await this.details.putBack(
                      {
                        assetId,
                        ownerId,
                        type: existing.record.type,
                        current: existing.details,
                        backup: details,
                        mode: job.request.mode,
                        people: library.people,
                      },
                      context,
                    );
                    await new AssetRepository(trx).update({
                      id: assetId,
                      status: AssetStatus.Active,
                      deletedAt: null,
                      ...(evidence.sha256 === file.sha256 &&
                        buddyRestoreChecksum(readBuddyAssetFidelity(manifest, assetId), currentChecksum, file.sha256)),
                    });
                  } else {
                    if (evidence.sha256 !== file.sha256) throw new Error('Buddy original has not been restored');
                    const made = await this.details.recreate(
                      {
                        assetId,
                        ownerId,
                        record: readBackupAssetRecord(asset)!,
                        details,
                        originalPath: file.target,
                        sidecarPath:
                          plan.files.find((entry) => entry.assetId === assetId && entry.role === 'sidecar')?.target ??
                          null,
                        sha256: file.sha256,
                        size: file.size,
                        people: library.people,
                      },
                      context,
                    );
                    if (made.status !== 'created') throw new Error('Buddy item could not be recreated');
                    const external = manifest.assetLinks?.[assetId];
                    if (job.admin && external?.isExternal)
                      await trx
                        .updateTable('asset')
                        .set({ libraryId: external.libraryId, isExternal: true })
                        .where('id', '=', assetId)
                        .execute();
                  }
                  await this.saveRestoreJobs(operation.id, assetId, queued);
                },
                true,
              );
              for (const restored of plan.files) {
                if (restored.assetId !== assetId || restored.role === 'original' || restored.role === 'buddy-version')
                  continue;
                const source = manifest.library.assets[assetId].files[Number(restored.fileKey.split(':').at(-1))];
                const metadata = manifest.assetFiles?.[assetId]?.find((entry) => entry.path === source.path);
                if (!metadata) continue;
                await this.guarded(
                  operation,
                  token,
                  job,
                  manifest,
                  snapshot,
                  restored,
                  async (trx) => {
                    await assertOwnerRestoreFile(restored.target, verified.get(restored.fileKey)!.identity);
                    const existing = await trx
                      .selectFrom('asset_file')
                      .select(['id', 'path', 'physicalFileId'])
                      .where('assetId', '=', assetId)
                      .where('type', '=', metadata.type)
                      .where('isEdited', '=', metadata.isEdited)
                      .executeTakeFirst();
                    if (existing && job.request.mode === 'keep') return;
                    await trx
                      .insertInto('asset_file')
                      .values({ ...metadata, assetId, path: restored.target, physicalFileId: null })
                      .onConflict((conflict) =>
                        conflict.columns(['assetId', 'type', 'isEdited']).doUpdateSet({
                          path: restored.target,
                          physicalFileId: existing?.path === restored.target ? existing.physicalFileId : null,
                          isProgressive: metadata.isProgressive,
                          isTransparent: metadata.isTransparent,
                        }),
                      )
                      .execute();
                  },
                  true,
                );
              }
              const state = readBuddyAssetFidelity(manifest, assetId);
              if (state) {
                const versionFiles = buddyFidelityFiles(manifest, assetId);
                const published = await this.guarded(
                  operation,
                  token,
                  job,
                  manifest,
                  snapshot,
                  file,
                  async (trx, ownerId) => {
                    const current = await captureOwnerRestoreFile(file.target, async (path) =>
                      (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
                    );
                    const outcome = await new BuddyBackupFidelityRepository(trx).publish({
                      state,
                      ownerId,
                      originalSha256: current.sha256 ?? '',
                      mode: job.request.mode,
                      paths: new Map(state.files.map((source, index) => [source.path, versionFiles[index].target])),
                      verify: async () => {
                        await assertOwnerRestoreFile(file.target, current.identity);
                        const evidence = await this.verifyFiles(operation.id, versionFiles);
                        for (const restored of versionFiles)
                          if (evidence.get(restored.fileKey)?.sha256 !== restored.sha256)
                            throw new Error('Buddy retained version did not verify');
                      },
                    });
                    const projection = await trx
                      .selectFrom('asset_file')
                      .select(['path', 'type'])
                      .where('assetId', '=', assetId)
                      .where('isEdited', '=', true)
                      .execute();
                    const retainedEditedProjection =
                      outcome === 'restored' &&
                      state.source.type === AssetType.Image &&
                      state.projection.length > 0 &&
                      state.projection.every((source) =>
                        projection.some(
                          (current) =>
                            current.type === source.type &&
                            current.path ===
                              versionFiles[state.files.findIndex((file) => file.path === source.path)]?.target,
                        ),
                      );
                    return { outcome, retainedEditedProjection };
                  },
                  true,
                );
                // Remove the re-render only after the guarded publication commits. A crash before
                // this write cannot complete the restore; replay will prune the saved job again.
                if (published.retainedEditedProjection) await this.saveRestoreJobs(operation.id, assetId, [], true);
                if (published.outcome === 'preserved-source') preservedVersionAssetIds.push(assetId);
              }
            }
            for (const assetId of ids) {
              const motion = manifest.assetLinks?.[assetId]?.livePhotoVideoId;
              if (!motion || (job.request.mode === 'keep' && job.owner.current[assetId])) {
                continue;
              }
              const original = plan.files.find((entry) => entry.assetId === assetId && entry.role === 'original')!;
              await this.guarded(
                operation,
                token,
                job,
                manifest,
                snapshot,
                original,
                async (trx, ownerId) => {
                  await trx
                    .selectFrom('asset')
                    .select('id')
                    .where('id', '=', motion)
                    .where('ownerId', '=', ownerId)
                    .where('status', '=', AssetStatus.Active)
                    .forShare()
                    .executeTakeFirstOrThrow();
                  let update = trx.updateTable('asset').set({ livePhotoVideoId: motion }).where('id', '=', assetId);
                  if (job.request.mode === 'keep') update = update.where('livePhotoVideoId', 'is', null);
                  await update.execute();
                },
                true,
              );
            }
            for (const ownerId of new Set(ids.map((id) => manifest.library.assets[id].owner!))) {
              const members = ids.filter((id) => manifest.library.assets[id].owner === ownerId);
              const anchor = plan.files.find((file) => file.assetId === members[0] && file.role === 'original')!;
              await this.guarded(
                operation,
                token,
                job,
                manifest,
                snapshot,
                anchor,
                async (trx) => {
                  const current = await trx
                    .selectFrom('asset')
                    .select(['id', 'ownerId', 'stackId'])
                    .where('id', 'in', members)
                    .forUpdate()
                    .execute();
                  if (current.length !== members.length || current.some((item) => item.ownerId !== ownerId))
                    throw new Error('Buddy restore relationship ownership changed');
                  const queued: OwnerRestoreDetailsContext['jobs'] = [];
                  const library = buddyLibraryForOwner(manifest, ownerId);
                  const context: OwnerRestoreDetailsContext = {
                    db: trx,
                    ownerId,
                    jobs: queued,
                    buddyPeople: true,
                    buddyPeopleMode: job.request.mode,
                  };
                  for (const [albumId, album] of Object.entries(library.albums)) {
                    if (album.ownerId !== ownerId || (manifest.metadata && !job.albums?.albums[albumId])) {
                      continue;
                    }
                    const selected = members.filter(
                      (id) =>
                        (job.request.mode === 'replace' || !job.owner.current[id]) &&
                        manifest.library.assets[id].details?.albums.some((entry) => entry.id === albumId),
                    );
                    if (selected.length === 0) continue;
                    const owned = await trx
                      .selectFrom('album_user')
                      .select('userId')
                      .where('albumId', '=', albumId)
                      .where('userId', '=', ownerId)
                      .where('role', '=', AlbumUserRole.Owner)
                      .executeTakeFirst();
                    if (!owned) continue;
                    await this.details.restoreAlbum({ albumId, album, memberIds: selected }, context);
                    if (
                      album.coverAssetId &&
                      selected.includes(album.coverAssetId) &&
                      (job.request.mode === 'replace' || job.albums?.albums[albumId]?.before === null)
                    ) {
                      let cover = trx
                        .updateTable('album')
                        .set({ albumThumbnailAssetId: album.coverAssetId })
                        .where('id', '=', albumId);
                      if (job.request.mode === 'keep') cover = cover.where('albumThumbnailAssetId', 'is', null);
                      await cover.execute();
                    }
                  }
                  const stacks = members
                    .filter((id) => job.request.mode === 'replace' || !job.owner.current[id])
                    .map((assetId) => ({
                      assetId,
                      ownerId,
                      stack: manifest.library.assets[assetId].details?.stack ?? null,
                    }));
                  for (const { stack } of stacks) {
                    if (!stack) continue;
                    const currentStack = await trx
                      .selectFrom('stack')
                      .select('ownerId')
                      .where('id', '=', stack.id)
                      .executeTakeFirst();
                    if (currentStack && currentStack.ownerId !== ownerId)
                      throw new Error('Buddy restore stack ownership changed');
                  }
                  await this.details.restoreStacks(stacks, context);
                  await this.saveRestoreJobs(operation.id, members[0], queued);
                },
                true,
              );
            }
            const restoredProjectIds: string[] = [];
            for (const projectId of projectIds) {
              await checkpoint();
              const project = readBuddyStudioProject(manifest, projectId);
              const files = buddyStudioFiles(manifest, projectId);
              const paths = new Map(project.files.map((source, index) => [source.path, files[index].target]));
              await this.guardedStudio(operation, token, job, manifest, projectId, async (trx, owner) => {
                for (const file of files) {
                  await assertOwnerRestorePath([StorageCore.getBaseFolder(StorageFolder.Exports)], file.target);
                  await new PhysicalFileRepository(trx).withStudioRestorePath(
                    file.target,
                    projectId,
                    project.ownerId,
                    file.sha256,
                    async () => {},
                  );
                }
                await new BuddyBackupStudioRepository(trx).publish({
                  manifest,
                  projectId,
                  actorId: operation.ownerId,
                  operationId: operation.id,
                  mode: job.request.mode,
                  paths,
                  retireFile: async (previous) => {
                    if (
                      previous.importId &&
                      !isManagedStudioImportPath({
                        ...previous,
                        id: previous.importId,
                        projectId,
                        ownerId: project.ownerId,
                      })
                    )
                      return;
                    try {
                      await assertOwnerRestorePath(
                        [StorageCore.getFolderLocation(StorageFolder.Exports, project.ownerId)],
                        previous.path,
                      );
                    } catch {
                      return;
                    } // Preserve unknown or non-owned paths, including historical external declarations.
                    const evidence = await captureOwnerRestoreFile(previous.path, async (path) =>
                      (await this.crypto.hashFile(path, 'sha256')).toString('hex'),
                    );
                    if (
                      !evidence.identity ||
                      evidence.sha256 !== previous.checksum ||
                      (previous.size !== null && evidence.size !== BigInt(previous.size))
                    )
                      return;
                    await assertOwnerRestoreFile(previous.path, evidence.identity);
                    await this.jobs.queue({ name: JobName.FileDelete, data: { files: [previous.path] } });
                  },
                  verify: async () => {
                    const evidence = await this.verifyFiles(operation.id, files);
                    for (const file of files)
                      if (evidence.get(file.fileKey)?.sha256 !== file.sha256)
                        throw new Error('Buddy Studio retained file did not verify');
                  },
                  validateResources: async (project) => {
                    for (const revision of project.revisions) {
                      const resolution = await this.studioResources.resolveProjectResources(owner, {
                        projectId,
                        ownerId: project.ownerId,
                        revision: revision.revision,
                        destination: StudioDestination.Local,
                        graph: {
                          document: revision.envelope.graph,
                          retained: project.generated
                            .filter((row) => row.sourceRevision === revision.revision)
                            .map((row) => ({
                              $resource: { kind: StudioResourceKind.GeneratedIntermediate, id: row.id },
                            })),
                        },
                        imports: project.imports.map((row) => ({
                          ...row,
                          path: paths.get(row.path)!,
                          externalReferences: row.externalReferences ?? undefined,
                        })),
                        generated: project.generated.map((row) => ({ ...row, path: paths.get(row.path)! })),
                      });
                      if (
                        !resolution.manifest.complete ||
                        resolution.manifest.entries.some(
                          (entry) =>
                            entry.sourceAccess === 'shared' || (entry.ownerId && entry.ownerId !== project.ownerId),
                        )
                      )
                        throw new Error('Buddy Studio requires complete, currently owned resources');
                    }
                  },
                });
              });
              restoredProjectIds.push(projectId);
            }
            for (const projectId of projectIds) {
              await checkpoint();
              const project = readBuddyStudioProject(manifest, projectId);
              await this.guardedStudio(operation, token, job, manifest, projectId, (trx) =>
                new BuddyBackupStudioRepository(trx).restoreLineage(project, job.request.mode),
              );
            }
            return { ...result, preservedVersionAssetIds, restoredProjectIds };
          },
        });
        if (!done) throw new RestoreStopped();
        await this.verifyFiles(operation.id, plan.files);
        if (
          !(await this.operations.setBulkResult(operation.id, token, {
            result: done,
            processedUnits: done.files,
            totalUnits: done.filesTotal,
            progress: 100,
            leaseMs: LEASE_MS,
          }))
        )
          throw new RestoreStopped();
      }
      await checkpoint();
      await this.operations.beginValidation(operation.id, token, true);
      if (!(await this.operations.complete(operation.id, token, { resultAssetId: null }, undefined, true)))
        throw new RestoreStopped();
      await this.drainRestoreJobs().catch(() => this.logger.warn('Buddy restore metadata jobs are waiting for retry.'));
    } catch (caughtError) {
      const error = executionSignal()?.aborted ? executionSignal()!.reason : caughtError;
      if (await settleOperationStop(this.operations, operation, token)) return;
      if (error instanceof RestoreStopped) {
        const current = await this.operations.getOfKind(operation.id, MediaOperationKind.BuddyRestore);
        if (current?.cancelRequestedAt)
          await this.operations.acknowledgeCancel(operation.id, token, { released: true });
        else await this.operations.requeue(operation.id, token, { delayMs: 30_000, returnAttempt: true });
      } else if (
        error instanceof BuddyPeerUnavailable ||
        (error instanceof FrameleafCloudError && [401, 403, 429, 507].includes(error.status ?? 0))
      )
        await this.operations.requeue(operation.id, token, { delayMs: 60_000, returnAttempt: true });
      else {
        // Only fixed categories enter retained CI diagnostics; error text can contain keys, paths or identities.
        const invariants: Record<string, string> = {
          'Buddy restore key binding changed': 'key_binding',
          'Buddy restore album selection unavailable': 'album_selection',
          'Buddy restore manifest changed': 'manifest_changed',
          'Buddy restore item is missing': 'item_missing',
          'Buddy restore authorization changed': 'authorization_changed',
          'Buddy administrator authorization changed': 'administrator_changed',
          'Live Photo relationship changed': 'live_photo_changed',
          'Buddy restore destination changed': 'destination_changed',
          'External library identity changed': 'external_library_changed',
          'Buddy version destination changed': 'version_destination_changed',
          'Buddy restored file did not verify': 'file_verification',
          'Buddy restored file checkpoint changed': 'checkpoint_changed',
          'Buddy restored file checkpoint unavailable': 'checkpoint_unavailable',
          'Buddy restored original changed': 'original_changed',
          'Buddy original has not been restored': 'original_missing',
          'Buddy item could not be recreated': 'item_recreation',
          'Buddy retained version did not verify': 'version_verification',
          'Buddy restore relationship ownership changed': 'relationship_ownership',
          'Buddy restore stack ownership changed': 'stack_ownership',
          'Restore the original storage mounts before restoring these items.': 'storage_mounts',
        };
        const cause = error instanceof Error ? error.cause : undefined;
        const codes = new Set([
          'ENOENT',
          'EACCES',
          'EPERM',
          'ENOSPC',
          'EIO',
          '23503',
          '23505',
          '23514',
          '40001',
          '40P01',
          '57014',
          '55P03',
          '42P01',
          '42703',
        ]);
        const code =
          [error, cause].flatMap((value) =>
            value &&
            typeof value === 'object' &&
            'code' in value &&
            typeof value.code === 'string' &&
            codes.has(value.code)
              ? [value.code]
              : [],
          )[0] ?? 'UNKNOWN';
        const status =
          error instanceof FrameleafCloudError &&
          [400, 401, 403, 404, 409, 429, 500, 502, 503, 504, 507].includes(error.status ?? 0)
            ? error.status
            : null;
        const category =
          error instanceof Error && Object.hasOwn(invariants, error.message)
            ? invariants[error.message]
            : error instanceof BuddyExecutionError
              ? 'execution'
              : error instanceof OperationDeadlineError
                ? 'deadline'
                : error instanceof FrameleafCloudError
                  ? 'upstream'
                  : code === 'UNKNOWN'
                    ? 'unexpected'
                    : 'coded_error';
        this.logger.error(`BUDDY_RESTORE_DIAGNOSTIC ${JSON.stringify({ category, code, status })}`);
        await this.operations.fail(
          operation.id,
          token,
          {
            error: 'Restore stopped. Check your PIN session, mounts, recovery kit, and backup integrity.',
            errorCode: 'buddy_restore_failed',
          },
          {
            retry:
              // NOWAIT contention rolls back publication; replay rechecks every authority fence.
              code === '55P03' ||
              error instanceof BuddyExecutionError ||
              error instanceof OperationDeadlineError ||
              (error instanceof FrameleafCloudError && (error.status === null || error.status >= 500)),
          },
        );
      }
    }
  }

  private async stageRecovery(
    operation: MediaOperation,
    token: string,
    job: RestoreJob,
    manifest: BuddyManifest,
    reader: BuddyBackupReader,
    checkpoint: () => Promise<void>,
  ) {
    const directory = join(this.repository.root(), 'recovery', operation.id);
    const files =
      job.request.scope === 'settings'
        ? manifest.configurationFiles
        : [
            ...Object.values(manifest.library.assets).flatMap((asset) => asset.files),
            ...Object.values(manifest.library.profiles),
            ...manifest.dependencies,
            ...manifest.configurationFiles,
          ];
    let completed = 0;
    for (const file of files) {
      await checkpoint();
      const target = join(directory, 'objects', file.sha256);
      if (!(await lstat(target).catch(() => null))) await reader.download(manifest, file.sha256, target);
      const evidence = await buddyFileHash(target, { signal: executionSignal(), progress: advanceExecutionProgress });
      if (evidence.sha256 !== file.sha256 || evidence.size !== file.size)
        throw new Error('Staged recovery file changed');
      await this.operations.setBulkResult(operation.id, token, {
        result: { phase: 'staging', files: ++completed, filesTotal: files.length },
        processedUnits: completed,
        totalUnits: files.length,
        progress: (completed * 100) / files.length,
        leaseMs: LEASE_MS,
      });
    }
    if (job.request.scope === 'server') {
      if (!manifest.library.database) throw new Error('Buddy snapshot has no verified database dump');
      await reader.download(manifest, manifest.library.database.sha256, join(directory, 'database.sql.gz'));
    }
    if (manifest.bootConfiguration !== undefined) {
      const { stageBuddyBootConfiguration } = await import('../utils/buddy-boot-configuration.ts');
      await stageBuddyBootConfiguration(directory, manifest.snapshotId, manifest.bootConfiguration, checkpoint);
    }
    await writeBuddyFile(
      join(directory, 'prepared.json'),
      JSON.stringify({ version: 1, scope: job.request.scope, mode: job.request.mode, manifest, files }),
    );
    await this.operations.setBulkResult(operation.id, token, {
      result: { phase: 'ready-to-apply', recoveryId: operation.id, files: files.length, filesTotal: files.length },
      processedUnits: files.length,
      totalUnits: files.length,
      progress: 100,
      leaseMs: LEASE_MS,
    });
  }
}
