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
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  AlbumUserRole,
  AssetStatus,
  ChecksumAlgorithm,
  DatabaseLock,
  ImmichWorker,
  MaintenanceAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
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
import { BuddyPeerUnavailable } from 'src/utils/buddy-backup-client.js';
import { BUDDY_UUID } from 'src/utils/buddy-backup-crypto.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';
import { buddyFileHash } from 'src/utils/buddy-backup-recovery.js';
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
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

type RestoreJob = {
  version: 1;
  request: BuddyRestoreDto;
  sessionId: string;
  admin: boolean;
  vaultId: string;
  fingerprint: string;
  owner: NonNullable<CloudBackupRestoreSnapshot['owner']>;
  manifestHash: string;
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
    return {
      id,
      state: operation.status,
      progress: operation.progress,
      phase: String(operation.result?.phase ?? operation.status),
      recoveryId: typeof operation.result?.recoveryId === 'string' ? operation.result.recoveryId : null,
      error: operation.error ?? null,
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
    const filename = job.request.scope === 'server' ? await this.recovery.prepare(id) : undefined;
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
    const reader = new BuddyBackupReader(ring, envelope, (id) => client.request<Buffer>('GET', `objects/${id}`));
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
    for (const snapshot of page)
      if ((await this.visible(current, (await this.open(snapshot.id)).manifest)).length > 0) visible.push(snapshot);
    await this.auth(auth);
    return { snapshots: visible, nextOffset };
  }

  async browse(auth: AuthDto, snapshotId: string, admin: boolean, offset = 0) {
    const current = admin ? await this.administrator(auth) : await this.auth(auth);
    const { manifest } = await this.open(snapshotId);
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
      albums: Object.entries(manifest.library.albums)
        .filter(([, album]) => admin || album.ownerId === current.user.id)
        .flatMap(([id, album]) => {
          const members = Object.entries(manifest.library.assets).filter(
            ([assetId, asset]) => permitted.has(assetId) && asset.details?.albums.some((entry) => entry.id === id),
          );
          return members.length > 0 ? [{ id, name: album.name, items: members.length }] : [];
        }),
    };
  }

  private async selection(auth: AuthDto, request: BuddyRestoreDto, manifest: BuddyManifest, admin: boolean) {
    if (!admin && ['library', 'settings', 'server'].includes(request.scope))
      throw new ForbiddenException('Administrator restore required');
    if (request.scope === 'asset' && !request.assetIds?.length)
      throw new BadRequestException('Choose items to restore');
    if (
      request.scope === 'album' &&
      (!request.albumId ||
        !manifest.library.albums[request.albumId] ||
        (!admin && manifest.library.albums[request.albumId].ownerId !== auth.user.id))
    )
      throw new NotFoundException('Backup album unavailable');
    const all = Object.keys(manifest.library.assets);
    let ids =
      request.scope === 'asset'
        ? request.assetIds!
        : request.scope === 'album'
          ? all.filter((id) =>
              manifest.library.assets[id].details?.albums.some((album) => album.id === request.albumId),
            )
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
    const version = coerce(manifest.frameleafVersion);
    const running = coerce(serverVersion.toString());
    if (!version || !running || gt(version, running))
      throw new BadRequestException('Update this Frameleaf server before restoring this snapshot.');
    const selectedFiles: Array<{ size: number }> =
      request.scope === 'settings'
        ? manifest.configurationFiles
        : ids.flatMap((id) => manifest.library.assets[id].files);
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
    const owner = {
      ownerId: current.user.id,
      sessionId: current.session!.id,
      current: identities,
      assetHashes: Object.fromEntries(
        ids.map((id) => [id, ownerRestoreHash(manifest.library.assets[id], manifest.library)]),
      ),
    };
    const conflicts = ids.filter((id) => identities[id]).length;
    if (!request.confirm)
      return { operationId: null, items: ids.length, bytes, conflicts, mode: request.mode, state: 'preview' };
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
    return { operationId: result.created.id, items: ids.length, bytes, conflicts, mode: request.mode, state: 'queued' };
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
        await checkOwnerRestoreItems(auth, manifest.library, snapshot, true, index, [assetId], true, parentId);
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
      await assertOwnerRestorePath(roots, file.target);
      const source = manifest.library.assets[assetId].files[Number(file.fileKey.split(':').at(-1))];
      const derivative =
        file.role === 'original'
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
  private async saveRestoreJobs(operationId: string, assetId: string, jobs: OwnerRestoreDetailsContext['jobs']) {
    if (jobs.length === 0) return;
    if (!BUDDY_UUID.test(operationId) || !BUDDY_UUID.test(assetId)) throw new Error('Invalid restore job identity');
    const path = join(this.repository.root(), 'restores', operationId, 'jobs', `${assetId}.json`);
    const previous = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return '[]';
    });
    const pending = [...JSON.parse(previous), ...jobs];
    await writeBuddyFile(
      path,
      JSON.stringify(new Map(pending.map((job) => [JSON.stringify(job), job])).values().toArray()),
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
    const job = operation.snapshot as unknown as RestoreJob;
    const heartbeat = setInterval(() => {
      void this.operations.heartbeat(operation.id, token, LEASE_MS).catch(() => false);
    }, LEASE_MS / 4);
    try {
      await this.binding(job);
      const { reader, manifest } = await this.open(job.request.snapshotId);
      if (this.fingerprint(manifest) !== job.manifestHash) throw new Error('Buddy restore manifest changed');
      const checkpoint = async () => {
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
            manifest.assetFiles?.[file.assetId!]?.some(
              (entry) =>
                entry.isEdited &&
                entry.path ===
                  manifest.library.assets[file.assetId!].files[Number(file.fileKey.split(':').at(-1))].path,
            ),
        );
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
            this.recordFile(operation.id, file, job.request.mode === 'keep' && outcome === 'skipped'),
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
                  const context = { db: trx, ownerId, jobs: queued };
                  const albums = [];
                  for (const album of asset.details?.albums ?? []) {
                    if (manifest.library.albums[album.id]?.ownerId !== ownerId) continue;
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
                        { albumId: album.id, album: manifest.library.albums[album.id], memberIds: [] },
                        context,
                      );
                      albums.push(album);
                    }
                  }
                  const details = { ...asset.details!, albums };
                  if (existing) {
                    await this.details.putBack(
                      {
                        assetId,
                        ownerId,
                        type: existing.record.type,
                        current: existing.details,
                        backup: details,
                        mode: job.request.mode === 'keep' ? 'fill' : 'replace',
                        people: manifest.library.people,
                      },
                      context,
                    );
                    await new AssetRepository(trx).update({
                      id: assetId,
                      status: AssetStatus.Active,
                      deletedAt: null,
                      ...(evidence.sha256 === file.sha256 && {
                        checksum: Buffer.from(file.sha256, 'hex'),
                        checksumAlgorithm: ChecksumAlgorithm.sha256File,
                      }),
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
                        people: manifest.library.people,
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
                if (restored.assetId !== assetId || restored.role === 'original') continue;
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
            }
            for (const assetId of ids) {
              const motion = manifest.assetLinks?.[assetId]?.livePhotoVideoId;
              if (!motion) continue;
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
                  const context = { db: trx, ownerId, jobs: queued };
                  for (const [albumId, album] of Object.entries(manifest.library.albums)) {
                    if (album.ownerId !== ownerId) continue;
                    const selected = members.filter((id) =>
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
                    if (album.coverAssetId && selected.includes(album.coverAssetId)) {
                      let cover = trx
                        .updateTable('album')
                        .set({ albumThumbnailAssetId: album.coverAssetId })
                        .where('id', '=', albumId);
                      if (job.request.mode === 'keep') cover = cover.where('albumThumbnailAssetId', 'is', null);
                      await cover.execute();
                    }
                  }
                  const stacks = members
                    .filter((id) => job.request.mode === 'replace' || !current.find((item) => item.id === id)?.stackId)
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
            return result;
          },
        });
        if (!done) throw new RestoreStopped();
        await this.verifyFiles(operation.id, plan.files);
      }
      await checkpoint();
      await this.operations.beginValidation(operation.id, token);
      if (!(await this.operations.complete(operation.id, token, { resultAssetId: null }))) throw new RestoreStopped();
      await this.drainRestoreJobs().catch(() => this.logger.warn('Buddy restore metadata jobs are waiting for retry.'));
    } catch (error) {
      if (error instanceof RestoreStopped) {
        const current = await this.operations.getOfKind(operation.id, MediaOperationKind.BuddyRestore);
        if (current?.cancelRequestedAt)
          await this.operations.acknowledgeCancel(operation.id, token, { released: true });
        else await this.operations.requeue(operation.id, token, { delayMs: 30_000, returnAttempt: true });
      } else if (error instanceof BuddyPeerUnavailable || error instanceof FrameleafCloudError)
        await this.operations.requeue(operation.id, token, { delayMs: 60_000, returnAttempt: true });
      else
        await this.operations.fail(
          operation.id,
          token,
          {
            error: 'Restore stopped. Check your PIN session, mounts, recovery kit, and backup integrity.',
            errorCode: 'buddy_restore_failed',
          },
          { retry: false },
        );
    } finally {
      clearInterval(heartbeat);
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
      const evidence = await buddyFileHash(target);
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
