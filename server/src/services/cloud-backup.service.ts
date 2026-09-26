import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { CloudBackupKeyMode, FrameleafCloudBackup, FrameleafCloudBackupRun } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  CloudBackupCheckDto,
  CloudBackupCheckResponseDto,
  CloudBackupGeneratedKeyDto,
  CloudBackupRunState,
  CloudBackupS3,
  CloudBackupSetupDto,
  CloudBackupStatusResponseDto,
  CloudBackupUnlockDto,
} from 'src/dtos/cloud-backup.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import {
  DatabaseLock,
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  NotificationLevel,
  NotificationType,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import {
  CloudBackupAsset,
  CloudBackupEntry,
  CloudBackupIndexRepository,
} from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import {
  CloudBackupClaimError,
  CloudBackupConnection,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
} from 'src/repositories/cloud-backup-store.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import {
  CLOUD_BACKUP_BATCH,
  CLOUD_BACKUP_DB_DUMPS_KEPT,
  CLOUD_BACKUP_DB_PREFIX,
  CLOUD_BACKUP_MANIFEST_FORMAT,
  CLOUD_BACKUP_OBJECT_PREFIX,
  CLOUD_BACKUP_OWN_MEMORY_ACKNOWLEDGEMENT,
  CloudBackupManifestFile,
  CloudBackupRunResult,
  backupKeyFile,
  bucketRef,
  emptyRunResult,
  isSha256Hex,
  keyFingerprint,
  manifestKey,
  objectKey,
  parseBackupKey,
  parseRunResult,
  recoveryCode,
  runProgress,
  s3SettingsProblem,
  signingRegion,
} from 'src/utils/cloud-backup.js';
import { compareCodeUnits } from 'src/utils/compare.js';
import { getConfig, readConfig, updateConfig } from 'src/utils/config.js';
import { CLOUD_BACKUP_DUMP_PREFIX, isCloudBackupDumpName } from 'src/utils/database-backups.js';
import { identityDirectory, loadInstanceIdentity } from 'src/utils/frameleaf-cloud-gateway.js';

const KIND = MediaOperationKind.CloudBackup;

/** How often the worker looks for a queued run. */
export const CLOUD_BACKUP_TICK_MS = 5000;
/** The claim lease, renewed on a timer while a file is in hand: a large video can take a while to upload. */
export const CLOUD_BACKUP_LEASE_MS = 10 * 60_000;
/** How long a run waits before it looks for an own-memory key again. */
export const CLOUD_BACKUP_KEY_WAIT_MS = 60_000;
/** Manifest entries read per page while the manifest is streamed to the bucket. */
export const CLOUD_BACKUP_MANIFEST_PAGE = 1000;
/** How often a worker ends the manifests of runs that are over. */
const ABANDONED_SWEEP_INTERVAL_MS = 60_000;
/** A worker asks the others for an own-memory key at most this often. */
const KEY_ASK_INTERVAL_MS = 10_000;

/** Frameleaf-managed storage waits for Frameleaf Cloud backup grants (FC-33), which are not published yet. */
export const MANAGED_STORAGE_UNAVAILABLE =
  'Frameleaf-managed storage is not available yet. Use your own S3-compatible bucket.';

/** An unfinished run's state as the status card shows it. */
const runState = (status: MediaOperationStatus, pauseRequested: boolean): CloudBackupRunState => {
  switch (status) {
    case MediaOperationStatus.Queued: {
      return 'queued';
    }
    case MediaOperationStatus.Paused: {
      return 'paused';
    }
    case MediaOperationStatus.Cancelling:
    case MediaOperationStatus.Cancelled: {
      return 'cancelling';
    }
    case MediaOperationStatus.Preparing:
    case MediaOperationStatus.Rendering:
    case MediaOperationStatus.Validating:
    case MediaOperationStatus.Completed:
    case MediaOperationStatus.Failed: {
      return pauseRequested ? 'pausing' : 'running';
    }
  }
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const asIso = (value: Date | string | null | undefined): string | null =>
  value ? (value instanceof Date ? value : new Date(value)).toISOString() : null;

type FileToBackUp = {
  fileKey: string;
  assetId: string | null;
  ownerId: string | null;
  role: string;
  path: string;
  recorded: { sha256: string; size: number; verifiedAt: Date | null } | null;
};

type HashedFile = FileToBackUp & { sha256: string; size: number; mtime: Date };

/**
 * Cloud backup (FL-160, CLD-301): claim one bucket per server, keep its SSE-C key in one of three key
 * modes, and back up content-addressed runs as durable jobs.
 *
 * - **One bucket per server.** Setup claims an empty bucket by writing `frameleaf-backup.json` with this
 *   server's instance id; a bucket claimed by another server, claimed with another key, or holding
 *   other files is refused. The claim is recorded in `SystemMetadataKey.FrameleafCloudBackup`.
 * - **Key modes.** `server`: this server generates the key and keeps it in a 0600 file under the
 *   identity directory, and the recovery kit is shown once. `own-stored`: a key made in the browser,
 *   with a copy in that file. `own-memory`: never saved; `POST admin/cloud/backup/key/unlock` loads it
 *   after each restart, handed to the other workers in memory, and runs wait until it is loaded. The
 *   key never goes into the configuration, a database dump, a log or a response.
 * - **Runs.** A run is a `media_operation` of kind `cloud_backup`: the database dump first (`db/`), then
 *   every original, sidecar and profile image by SHA-256 (`o/<sha256>`, uploaded once, never twice),
 *   then the manifest (`m/<ISO>.json.gz`). The cursor is written every 25 assets, a pause or cancel is
 *   honoured there, and a claim after a restart finishes the same manifest. Nothing on this server is
 *   ever deleted or changed by a run except its own temporary database dump; Locked media is backed up
 *   like any other (backend work reaches it), and nothing a run reads is shown to anybody.
 */
@Injectable()
export class CloudBackupService {
  private memoryKey?: { fingerprint: string; key: Buffer };
  /** Callers waiting for another worker to share the own-memory key. */
  private keyWaiters = new Set<() => void>();
  private lastKeyAskAt = 0;
  private lastAbandonedSweepAt = 0;
  /** How long a status read or "Back up now" waits for another worker to share an own-memory key. */
  keyAskMs = 1000;
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private readonly workerId = `cloud-backup-${randomUUID()}`;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private forkSchemaRepository: ForkSchemaRepository,
    private databaseRepository: DatabaseRepository,
    private instanceIdentityRepository: InstanceIdentityRepository,
    private frameleafCloudRepository: FrameleafCloudRepository,
    private eventRepository: EventRepository,
    private websocketRepository: WebsocketRepository,
    private operations: MediaOperationRepository,
    private storageRepository: StorageRepository,
    private cryptoRepository: CryptoRepository,
    private store: CloudBackupStoreRepository,
    private index: CloudBackupIndexRepository,
    private keys: CloudBackupKeyRepository,
    private databaseBackup: DatabaseBackupService,
  ) {
    this.logger.setContext(CloudBackupService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Status and setup                                                    */
  /* ------------------------------------------------------------------ */

  async getStatus(): Promise<CloudBackupStatusResponseDto> {
    const [config, metadata, active] = await Promise.all([
      this.readSettings(),
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup),
      this.operations.getActiveOfKind(KIND),
    ]);
    const settings = config.frameleafCloud.cloudBackup;
    const configured = !!metadata && settings.enabled && settings.target !== 'off';
    const activeRow = active ? await this.operations.getOfKind(active.id, KIND) : undefined;

    return {
      configured,
      target: settings.enabled ? settings.target : 'off',
      managedAvailable: false,
      endpoint: metadata?.endpoint ?? null,
      region: metadata?.region ?? null,
      bucket: metadata?.bucket ?? null,
      instanceId: metadata?.instanceId ?? null,
      claimedAt: metadata?.claimedAt ?? null,
      keyMode: metadata?.keyMode ?? null,
      keyFingerprint: metadata?.keyFingerprint ?? null,
      keyLoaded: metadata ? !!(await this.loadKeyOrAsk(metadata).catch(() => null)) : false,
      lastRun: metadata?.lastRun ? this.mapLastRun(metadata.lastRun) : null,
      lastSuccessAt: metadata?.lastSuccessAt ?? null,
      lastManifestKey: metadata?.lastManifestKey ?? null,
      usage: metadata ? await this.index.getUsage(metadata.bucketRef) : null,
      activeRun: activeRow ? this.mapActiveRun(activeRow) : null,
    };
  }

  /**
   * "Check bucket": the credentials can list the bucket and the provider encrypts with a customer key
   * (SSE-C). A throwaway test file is written and deleted; nothing is claimed and nothing is saved.
   */
  async check(dto: CloudBackupCheckDto): Promise<CloudBackupCheckResponseDto> {
    const connection = await this.connectionFor(dto.s3);
    let state: 'empty' | 'claimed' | 'not-empty';
    try {
      ({ state } = await this.store.probe(connection));
    } catch (error) {
      throw this.asRequestError(error);
    }
    switch (state) {
      case 'empty': {
        return {
          ok: true,
          state,
          message: 'Connected. The provider accepted and returned a test file encrypted with a customer key (SSE-C).',
        };
      }
      case 'claimed': {
        return {
          ok: true,
          state,
          message:
            'Connected, and SSE-C works. This bucket already holds a Frameleaf claim: only the server that claimed it, with its key, can use it.',
        };
      }
      case 'not-empty': {
        return {
          ok: false,
          state,
          message:
            'Connected, and SSE-C works, but this bucket already contains other files. Use an empty bucket dedicated to this server.',
        };
      }
    }
  }

  /**
   * "Generate a key for me": a new 256-bit key made by this server, returned this once so the recovery kit
   * can show it. Nothing is stored until setup claims the bucket with it.
   */
  generateKey(): CloudBackupGeneratedKeyDto {
    const key = this.cryptoRepository.randomBytes(32);
    return {
      key: key.toString('base64'),
      fingerprint: keyFingerprint(key),
      recoveryCode: recoveryCode(key),
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Claim the bucket with the chosen key and turn cloud backup on. Refused while a run is active, for
   * Frameleaf-managed storage (not available yet), without the typed acknowledgement in own-memory mode,
   * and for any bucket the claim refuses. The key is stored only in the stored key modes, in its 0600
   * file; the secret access key goes into the configuration as a write-only credential.
   */
  async setup(auth: AuthDto, dto: CloudBackupSetupDto): Promise<CloudBackupStatusResponseDto> {
    this.requireEditableConfig();
    if (await this.operations.getActiveOfKind(KIND)) {
      throw new ConflictException('Wait for the running backup to finish, or cancel it, before changing the setup.');
    }
    if (dto.target === 'managed') {
      throw new ConflictException(MANAGED_STORAGE_UNAVAILABLE);
    }
    if (!dto.s3) {
      throw new BadRequestException('Enter your bucket’s storage address, name and access key.');
    }
    if (
      dto.keyMode === 'own-memory' &&
      dto.acknowledgement?.trim().toLowerCase() !== CLOUD_BACKUP_OWN_MEMORY_ACKNOWLEDGEMENT
    ) {
      throw new BadRequestException(
        'Type “I understand” to confirm that a lost key means every backup in this bucket is permanently unreadable.',
      );
    }

    const key = this.parseKey(dto.key);
    const fingerprint = keyFingerprint(key);
    const connection = await this.connectionFor(dto.s3);
    const identity = await loadInstanceIdentity({
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    });

    // The stored key modes write and read back the key file first, so a bucket is never claimed with a
    // key this server could not keep; a claim that then fails takes away only a file this setup created.
    const keyFile =
      dto.keyMode === 'own-memory'
        ? null
        : await this.storeKey(dto.keyMode, key, { instanceId: identity.instanceId, bucket: connection.bucket });

    let claim: { existing: boolean; claimedAt: string };
    try {
      claim = await this.store.claim(connection, key, {
        instanceId: identity.instanceId,
        keyFingerprint: fingerprint,
        now: new Date(),
      });
    } catch (error) {
      if (keyFile?.created) {
        await this.keys.remove(identityDirectory(this.configRepository), fingerprint);
      }
      throw this.asRequestError(error);
    }

    const { oldConfig, newConfig } = await this.databaseRepository.withLock(
      DatabaseLock.SystemConfigUpdate,
      async () => {
        const current = await readConfig(this.configRepos());
        const next = structuredClone(current);
        next.frameleafCloud.cloudBackup = {
          ...current.frameleafCloud.cloudBackup,
          enabled: true,
          target: 'byo-s3',
          s3: {
            endpoint: connection.endpoint,
            region: dto.s3?.region?.trim() ?? '',
            bucket: connection.bucket,
            accessKeyId: connection.accessKeyId,
            secretAccessKey: connection.secretAccessKey,
          },
          keyMode: dto.keyMode,
        };
        return { oldConfig: current, newConfig: await updateConfig(this.configRepos(), next) };
      },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });

    const ref = bucketRef(connection.endpoint, connection.bucket);
    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    // A new claim means the bucket was empty: whatever the index remembers of it (an emptied or recreated
    // bucket) is gone, and the first run reads the bucket's listing again.
    if (!claim.existing) {
      await this.index.deleteBucket(ref);
    }
    const sameBucket = claim.existing && previous?.bucketRef === ref && previous.keyFingerprint === fingerprint;
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudBackup, {
      target: 'byo-s3',
      bucketRef: ref,
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      instanceId: identity.instanceId,
      claimedAt: claim.claimedAt,
      keyMode: dto.keyMode,
      keyFingerprint: fingerprint,
      lastCheckAt: new Date().toISOString(),
      ...(sameBucket && {
        reconciledAt: previous.reconciledAt,
        lastRun: previous.lastRun,
        lastSuccessAt: previous.lastSuccessAt,
        lastManifestKey: previous.lastManifestKey,
      }),
    });

    // Own-memory: held here, and shared once the claim is saved so the other workers accept it.
    if (dto.keyMode === 'own-memory') {
      this.memoryKey = { fingerprint, key };
      this.websocketRepository.serverSend('CloudBackupKeyShare', { key: key.toString('base64') });
    }

    this.logger.log(
      `Cloud backup set up by ${auth.user.id}: bucket ${connection.bucket} ${claim.existing ? 'reclaimed' : 'claimed'}, key ${fingerprint} (${dto.keyMode})`,
    );
    return this.getStatus();
  }

  /** Own-memory mode: load the key after a restart. It is held in memory by every worker, never saved. */
  async unlock(dto: CloudBackupUnlockDto): Promise<CloudBackupStatusResponseDto> {
    const metadata = await this.requireClaim();
    if (metadata.keyMode !== 'own-memory') {
      throw new BadRequestException('This server keeps its backup key, so there is nothing to unlock.');
    }
    const key = this.parseKey(dto.key);
    if (keyFingerprint(key) !== metadata.keyFingerprint) {
      throw new BadRequestException('This key is for a different bucket.');
    }
    this.memoryKey = { fingerprint: metadata.keyFingerprint, key };
    this.websocketRepository.serverSend('CloudBackupKeyShare', { key: key.toString('base64') });
    this.logger.log(`Cloud backup key ${metadata.keyFingerprint} loaded into memory`);
    return this.getStatus();
  }

  /**
   * Turn cloud backup off: no more runs. The claim, the key file and everything in the bucket are kept,
   * so the backups stay readable with the recovery kit or key file and setup can claim the bucket again.
   */
  async turnOff(auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    this.requireEditableConfig();
    if (await this.operations.getActiveOfKind(KIND)) {
      throw new ConflictException('Cancel the running backup before turning cloud backup off.');
    }
    const { oldConfig, newConfig } = await this.databaseRepository.withLock(
      DatabaseLock.SystemConfigUpdate,
      async () => {
        const current = await readConfig(this.configRepos());
        const next = structuredClone(current);
        next.frameleafCloud.cloudBackup.enabled = false;
        return { oldConfig: current, newConfig: await updateConfig(this.configRepos(), next) };
      },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    this.logger.log(`Cloud backup turned off by ${auth.user.id}; the bucket and its backups are kept`);
    return this.getStatus();
  }

  /** "Back up now": queue a run, or answer with the one already queued or running. */
  async startRun(auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    const metadata = await this.requireClaim();
    const { frameleafCloud } = await this.readSettings();
    if (!frameleafCloud.cloudBackup.enabled) {
      throw new BadRequestException('Cloud backup is off. Set it up again to back up.');
    }
    if (metadata.keyMode === 'own-memory' && !(await this.loadKeyOrAsk(metadata))) {
      throw new ConflictException('Load the backup key to back up. This server does not keep it.');
    }

    await this.operations.createExclusive(
      {
        ownerId: auth.user.id,
        kind: KIND,
        // Uploaded by this server's own workers, straight to the claimed bucket.
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Cloud backup',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: { version: 1, bucketRef: metadata.bucketRef, keyFingerprint: metadata.keyFingerprint },
        settings: { bucket: metadata.bucket },
        estimate: null,
        result: emptyRunResult() as unknown as Record<string, unknown>,
        totalUnits: null,
      },
      DatabaseLock.FrameleafCloudBackup,
    );
    return this.getStatus();
  }

  async pauseRun(id: string): Promise<CloudBackupStatusResponseDto> {
    const operation = await this.requireRun(id);
    await this.operations.requestPause(id, operation.ownerId, [KIND]);
    return this.getStatus();
  }

  async resumeRun(id: string): Promise<CloudBackupStatusResponseDto> {
    const operation = await this.requireRun(id);
    await this.operations.resume(id, operation.ownerId);
    return this.getStatus();
  }

  async cancelRun(id: string): Promise<CloudBackupStatusResponseDto> {
    const operation = await this.requireRun(id);
    await this.operations.requestCancel(id, operation.ownerId);
    return this.getStatus();
  }

  /** Your own bucket needs a storage address and a bucket whenever cloud backup is on. */
  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    const backup = newConfig.frameleafCloud.cloudBackup;
    if (!backup.enabled || backup.target !== 'byo-s3') {
      return;
    }
    if (!backup.s3.endpoint || !backup.s3.bucket) {
      throw new Error('Cloud backup to your own bucket needs a storage address and a bucket name.');
    }
    if (!backup.s3.endpoint.startsWith('https://')) {
      throw new Error('Encrypted uploads with your key (SSE-C) need an HTTPS storage address.');
    }
  }

  /** Another worker loaded the own-memory key: keep it in memory here too, if it is this bucket's. */
  @OnEvent({ name: 'CloudBackupKeyShare', server: true })
  async onKeyShare({ key }: ArgOf<'CloudBackupKeyShare'>) {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (metadata?.keyMode !== 'own-memory') {
      return;
    }
    const bytes = Buffer.from(key, 'base64');
    if (keyFingerprint(bytes) !== metadata.keyFingerprint) {
      return;
    }
    this.memoryKey = { fingerprint: metadata.keyFingerprint, key: bytes };
    for (const wake of this.keyWaiters) {
      wake();
    }
  }

  /** A worker that restarted asks for the own-memory key; one that holds it shares it again. */
  @OnEvent({ name: 'CloudBackupKeyRequest', server: true })
  onKeyRequest() {
    if (this.memoryKey) {
      this.websocketRepository.serverSend('CloudBackupKeyShare', { key: this.memoryKey.key.toString('base64') });
    }
  }

  /* ------------------------------------------------------------------ */
  /* The worker                                                          */
  /* ------------------------------------------------------------------ */

  /** Every worker that starts asks the others for an own-memory key they may hold. */
  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrapAskForKey() {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (metadata?.keyMode === 'own-memory') {
      this.websocketRepository.serverSend('CloudBackupKeyRequest');
    }
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), CLOUD_BACKUP_TICK_MS);
    this.tick();
  }

  /** Stop taking work and let the file in hand land; the lease hands the run to the next worker. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Cloud backup worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /** Lapsed claims are recovered by `MediaOperationSweepService`, for every kind, not here. */
  async drain(): Promise<void> {
    // A run the lease sweep failed, or one removed, leaves its manifest running: end it and its entries,
    // at most once a minute.
    if (Date.now() - this.lastAbandonedSweepAt >= ABANDONED_SWEEP_INTERVAL_MS) {
      this.lastAbandonedSweepAt = Date.now();
      const ended = await this.index.endAbandonedManifests();
      if (ended > 0) {
        this.logger.log(`Ended ${ended} cloud backup manifest(s) whose run is over`);
      }
    }
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [KIND],
        workerId: this.workerId,
        leaseMs: CLOUD_BACKUP_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.run(claim.operation, claim.claimToken);
    }
  }

  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const keepAlive = setInterval(() => {
      this.operations.heartbeat(operation.id, claimToken, CLOUD_BACKUP_LEASE_MS).catch(() => false);
    }, CLOUD_BACKUP_LEASE_MS / 4);
    const progress = { result: parseRunResult(operation.result) };
    try {
      await this.process(operation, claimToken, progress);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(`Cloud backup run ${operation.id} failed: ${message}`);
      const outcome = await this.operations.fail(operation.id, claimToken, {
        error: message,
        errorCode: 'cloud_backup_failed',
      });
      if (outcome === 'failed') {
        await this.endManifest(progress.result, 'failed');
        await this.recordRun(operation, progress.result, 'failed', message);
        this.notify({
          level: NotificationLevel.Error,
          title: 'Cloud backup failed',
          description: `The last cloud backup stopped: ${message}`,
          dedupeKey: 'cloud-backup:failed',
          dedupeDays: 1,
        });
      }
    } finally {
      clearInterval(keepAlive);
    }
  }

  /**
   * One claim of a run, from wherever its result says it got to. Every step is safe to do twice: an
   * object already in the bucket is skipped, an upload is repeated whole, and a manifest file recorded
   * twice is replaced.
   */
  private async process(operation: MediaOperation, claimToken: string, progress: { result: CloudBackupRunResult }) {
    const { id } = operation;
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    const snapshot = operation.snapshot as { bucketRef?: string; keyFingerprint?: string };
    if (!metadata || metadata.bucketRef !== snapshot.bucketRef || metadata.keyFingerprint !== snapshot.keyFingerprint) {
      throw new Error('The backup bucket changed since this run was queued. Start a new backup.');
    }
    const { frameleafCloud } = await this.readSettings();
    const settings = frameleafCloud.cloudBackup;
    if (!settings.enabled || settings.target !== 'byo-s3') {
      throw new Error('Cloud backup is off.');
    }
    if (bucketRef(settings.s3.endpoint, settings.s3.bucket) !== metadata.bucketRef) {
      throw new Error('The bucket in the settings is not the one this server claimed. Set up cloud backup again.');
    }
    if (!settings.s3.secretAccessKey) {
      throw new Error('The bucket’s secret access key is not stored on this server.');
    }

    const bucketKey = await this.loadKey(metadata);
    if (!bucketKey) {
      if (metadata.keyMode !== 'own-memory') {
        throw new Error(
          'The backup key file is missing from this server. Restore it from the key file or recovery kit.',
        );
      }
      // Own-memory key not loaded here: ask the other workers, and wait without failing the run.
      this.websocketRepository.serverSend('CloudBackupKeyRequest');
      await this.recordRun(operation, progress.result, 'waiting-for-key');
      this.notify({
        level: NotificationLevel.Warning,
        title: 'Cloud backup is waiting for its key',
        description: 'This server does not keep the backup key. Load it in Settings › Frameleaf Cloud › Cloud backup.',
        dedupeKey: 'cloud-backup:key-locked',
        dedupeDays: 1,
      });
      await this.operations.requeue(id, claimToken, { delayMs: CLOUD_BACKUP_KEY_WAIT_MS, returnAttempt: true });
      return;
    }

    const connection: CloudBackupConnection = {
      endpoint: settings.s3.endpoint,
      region: signingRegion(settings.s3.endpoint, settings.s3.region),
      bucket: settings.s3.bucket,
      accessKeyId: settings.s3.accessKeyId,
      secretAccessKey: settings.s3.secretAccessKey,
    };
    // The claim is read again on every run: a bucket another server claimed since, or one emptied or
    // recreated (its index would no longer match it), is refused rather than backed up into.
    const marker = await this.store.readMarker(connection, bucketKey);
    if (marker.instanceId !== metadata.instanceId) {
      throw new Error('This bucket is now claimed by another Frameleaf server. Set up cloud backup again.');
    }
    const run: Run = { id, claimToken, operation, metadata, connection, bucketKey, progress, uploadedNow: new Set() };

    const running = await this.operations.reportProgress(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: progress.result.assets,
      totalUnits: progress.result.total,
      progress: runProgress(progress.result),
    });
    if (!running) {
      // Cancelled between the claim and this write, or the claim is gone.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      return;
    }

    await this.openManifest(run);
    await this.recordRun(operation, progress.result, 'running');

    if (progress.result.phase === 'database' && !(await this.backUpDatabase(run))) {
      return;
    }
    if (progress.result.phase === 'reconcile' && !(await this.reconcile(run))) {
      return;
    }
    while (progress.result.phase === 'assets') {
      if (this.stopping || !(await this.backUpAssetPage(run, settings))) {
        return;
      }
    }
    if (progress.result.phase === 'profiles' && !(await this.backUpProfiles(run))) {
      return;
    }
    if (progress.result.phase === 'manifest' && !(await this.writeManifest(run))) {
      return;
    }
    await this.finish(run);
  }

  /** The run's manifest row, created on its first claim; a later claim carries on with the same one. */
  private async openManifest(run: Run) {
    const { result } = run.progress;
    if (result.manifestId && (await this.index.getManifest(result.manifestId))) {
      return;
    }
    const manifest = await this.index.createManifest({
      bucket: run.metadata.bucketRef,
      key: manifestKey(new Date()),
      operationId: run.id,
    });
    run.progress.result = { ...result, manifestId: manifest.id, manifestKey: manifest.key };
  }

  /** The database first: a fresh dump to `db/<file>`, the oldest dumps beyond the last seven removed. */
  private async backUpDatabase(run: Run): Promise<boolean> {
    await this.removeLeftoverDumps();
    const path = await this.databaseBackup.createDatabaseBackup(CLOUD_BACKUP_DUMP_PREFIX);
    try {
      const sha256 = (await this.cryptoRepository.hashFile(path, 'sha256')).toString('hex');
      const key = `${CLOUD_BACKUP_DB_PREFIX}${basename(path)}`;
      const { size } = await this.store.uploadFile(run.connection, key, path, run.bucketKey, sha256);
      run.progress.result = {
        ...run.progress.result,
        database: { key, sha256, size },
        bytesUploaded: run.progress.result.bytesUploaded + size,
      };
      await this.index.setManifestDatabase(run.progress.result.manifestId!, key);
      await this.pruneDatabaseDumps(run, key);
    } finally {
      // Only the dump this run made is removed; it is in the bucket now, or the run failed.
      await this.storageRepository.unlink(path);
    }
    run.progress.result = { ...run.progress.result, phase: 'reconcile' };
    return this.checkpoint(run);
  }

  /**
   * A dump a run made and could not remove (the process stopped between making and uploading it) is
   * removed by the next run: it is only ever this run's temporary file, never a restore point.
   */
  private async removeLeftoverDumps() {
    const folder = StorageCore.getBaseFolder(StorageFolder.Backups);
    const names = await this.storageRepository.readdir(folder).catch((): string[] => []);
    for (const name of names.filter((name) => isCloudBackupDumpName(name))) {
      await this.storageRepository.unlink(join(folder, name));
    }
  }

  /**
   * Keep the newest seven dumps and the dump the newest complete manifest names (so the latest complete
   * backup always has its database); remove the rest. Only dumps (`db/`) are ever removed here.
   */
  private async pruneDatabaseDumps(run: Run, current: string) {
    const dumps: string[] = [];
    await this.store.listAll(run.connection, CLOUD_BACKUP_DB_PREFIX, (objects) => {
      dumps.push(...objects.map(({ key }) => key));
      return Promise.resolve();
    });
    const latest = await this.index.getLatestManifestDatabaseKey(run.metadata.bucketRef);
    const newest = new Set(
      [current, ...dumps.filter((key) => key !== current).toSorted((a, b) => compareCodeUnits(b, a))].slice(
        0,
        CLOUD_BACKUP_DB_DUMPS_KEPT,
      ),
    );
    for (const key of dumps) {
      if (!newest.has(key) && key !== latest) {
        await this.store.delete(run.connection, key);
      }
    }
  }

  /** The first run in a bucket fills the index from its listing, so nothing already there uploads again. */
  private async reconcile(run: Run): Promise<boolean> {
    if (!run.metadata.reconciledAt) {
      // Every object the listing finds is stamped now; any row it did not stamp is not in the bucket.
      const since = await this.index.currentTime();
      const found = await this.store.listAll(run.connection, CLOUD_BACKUP_OBJECT_PREFIX, (objects) =>
        this.index.record(
          run.metadata.bucketRef,
          objects
            .map(({ key, size, etag }) => ({ sha256: key.slice(CLOUD_BACKUP_OBJECT_PREFIX.length), size, etag }))
            .filter(({ sha256 }) => isSha256Hex(sha256)),
        ),
      );
      const dropped = await this.index.pruneUnseen(run.metadata.bucketRef, since);
      if (dropped > 0) {
        this.logger.warn(`Cloud backup run ${run.id}: ${dropped} recorded objects are no longer in the bucket`);
      }
      const reconciledAt = new Date().toISOString();
      run.metadata = { ...run.metadata, reconciledAt, lastCheckAt: reconciledAt };
      await this.updateMetadata((current) => ({ ...current, reconciledAt, lastCheckAt: reconciledAt }));
      this.logger.log(`Cloud backup run ${run.id}: ${found} objects already in the bucket`);
    }
    run.progress.result = { ...run.progress.result, phase: 'assets', total: await this.index.countAssets() };
    return this.checkpoint(run);
  }

  /** The next 25 assets from the cursor: their originals, sidecars and any files asked for. */
  private async backUpAssetPage(run: Run, settings: SystemConfig['frameleafCloud']['cloudBackup']): Promise<boolean> {
    const page = await this.index.listAssets({
      afterId: run.progress.result.cursor,
      limit: CLOUD_BACKUP_BATCH,
      includeThumbs: settings.include.thumbs,
      includeEncodedVideo: settings.include.encodedVideo,
    });
    if (page.length === 0) {
      run.progress.result = { ...run.progress.result, phase: 'profiles' };
      return this.checkpoint(run);
    }

    await this.backUpFiles(
      run,
      page.flatMap((asset) => this.filesOf(asset)),
    );
    run.progress.result = {
      ...run.progress.result,
      cursor: page.at(-1)!.id,
      assets: run.progress.result.assets + page.length,
      total: Math.max(run.progress.result.total ?? 0, run.progress.result.assets + page.length),
    };
    return this.checkpoint(run);
  }

  private filesOf(asset: CloudBackupAsset): FileToBackUp[] {
    return [
      {
        fileKey: `${asset.id}:original`,
        assetId: asset.id,
        ownerId: asset.ownerId,
        role: 'original',
        path: asset.originalPath,
        // trusted only when it was verified at this very path
        recorded:
          asset.sha256 && isSha256Hex(asset.sha256) && asset.checksumSize !== null && asset.checksumPathVerified
            ? { sha256: asset.sha256, size: asset.checksumSize, verifiedAt: asset.verifiedAt }
            : null,
      },
      ...asset.files.map((file) => ({
        fileKey: `${asset.id}:${file.type}:${file.path}`,
        assetId: asset.id,
        ownerId: asset.ownerId,
        role: file.type,
        path: file.path,
        recorded: null,
      })),
    ];
  }

  /** Every account's profile image, hashed on the fly. */
  private async backUpProfiles(run: Run): Promise<boolean> {
    const profiles = await this.index.listProfileImages();
    await this.backUpFiles(
      run,
      profiles.map(({ userId, path }) => ({
        fileKey: `profile:${userId}`,
        assetId: null,
        ownerId: userId,
        role: 'profile',
        path,
        recorded: null,
      })),
    );
    run.progress.result = { ...run.progress.result, phase: 'manifest' };
    return this.checkpoint(run);
  }

  /**
   * Back up a batch of files: hash what the index cannot vouch for, upload each hash the bucket does not
   * have yet (once, however many files share it), and record every file in the manifest. A file that is
   * gone is counted and left out; one that changes while it uploads is hashed again and uploaded once
   * more, then left for the next run.
   */
  private async backUpFiles(run: Run, files: FileToBackUp[]) {
    const hashed: HashedFile[] = [];
    for (const file of files) {
      const found = await this.hashed(run, file);
      if (found) {
        hashed.push(found);
      }
    }

    const existing = await this.index.getExisting(
      run.metadata.bucketRef,
      hashed.map(({ sha256 }) => sha256),
    );
    const recorded: CloudBackupEntry[] = [];
    const skipped: string[] = [];
    for (const file of hashed) {
      if (existing.has(file.sha256) || run.uploadedNow.has(file.sha256)) {
        skipped.push(file.sha256);
        run.progress.result = { ...run.progress.result, skipped: run.progress.result.skipped + 1 };
        recorded.push(this.entryOf(file));
        continue;
      }

      const uploaded = await this.upload(run, file);
      if (uploaded) {
        recorded.push(this.entryOf(uploaded));
      }
    }

    await this.index.touch(run.metadata.bucketRef, skipped);
    await this.index.upsertEntries(run.progress.result.manifestId!, recorded);
  }

  private async hashed(run: Run, file: FileToBackUp): Promise<HashedFile | null> {
    let stats: { size: number; mtime: Date };
    try {
      stats = await this.storageRepository.stat(file.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      run.progress.result = { ...run.progress.result, missing: run.progress.result.missing + 1 };
      return null;
    }

    // The checksum on record stands for the file only while its size is the same and it has not been
    // written since the checksum was taken; anything else is hashed now.
    const { recorded } = file;
    if (
      recorded?.verifiedAt &&
      recorded.size === stats.size &&
      stats.mtime.getTime() <= recorded.verifiedAt.getTime()
    ) {
      return { ...file, sha256: recorded.sha256, size: stats.size, mtime: stats.mtime };
    }

    const sha256 = (await this.cryptoRepository.hashFile(file.path, 'sha256')).toString('hex');
    if (recorded && recorded.sha256 !== sha256) {
      run.progress.result = { ...run.progress.result, changed: run.progress.result.changed + 1 };
    }
    return { ...file, sha256, size: stats.size, mtime: stats.mtime };
  }

  private async upload(run: Run, file: HashedFile): Promise<HashedFile | null> {
    let current = file;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { etag, size } = await this.store.uploadFile(
          run.connection,
          objectKey(current.sha256),
          current.path,
          run.bucketKey,
          current.sha256,
        );
        await this.index.record(run.metadata.bucketRef, [{ sha256: current.sha256, size, etag }]);
        run.uploadedNow.add(current.sha256);
        run.progress.result = {
          ...run.progress.result,
          uploaded: run.progress.result.uploaded + 1,
          bytesUploaded: run.progress.result.bytesUploaded + size,
        };
        return { ...current, size };
      } catch (error) {
        if (!(error instanceof CloudBackupFileChangedError)) {
          throw error;
        }
        const again = await this.hashed(run, { ...file, recorded: null });
        if (!again) {
          return null;
        }
        current = again;
      }
    }
    this.logger.warn(`Cloud backup run ${run.id}: a file kept changing while it uploaded; the next run backs it up`);
    run.progress.result = { ...run.progress.result, changed: run.progress.result.changed + 1 };
    return null;
  }

  private entryOf(file: HashedFile): CloudBackupEntry {
    return {
      fileKey: file.fileKey,
      assetId: file.assetId,
      ownerId: file.ownerId,
      role: file.role,
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      mtime: file.mtime,
    };
  }

  /**
   * The manifest, streamed to `m/<ISO>.json.gz` from the files the run recorded, a page at a time: memory
   * holds one page and one asset's files, however large the library. A manifest already complete (a claim
   * that stopped after writing it) is never written again. The `done` checkpoint is saved before the
   * recorded files are removed (in `finish`), so a retry can never find the entries gone and the manifest
   * still to write. Answers whether to carry on (no when the claim was lost).
   */
  private async writeManifest(run: Run): Promise<boolean> {
    const { result } = run.progress;
    const manifestId = result.manifestId!;
    const row = await this.index.getManifest(manifestId);
    if (row?.status !== 'complete') {
      const counts = { assets: 0, files: 0, bytes: 0 };
      await pipeline(
        Readable.from(this.manifestChunks(run, manifestId, counts)),
        createGzip(),
        async (source: AsyncIterable<Buffer>) => {
          await this.store.uploadStream(run.connection, result.manifestKey!, source, run.bucketKey, 'application/gzip');
        },
      );
      await this.index.finishManifest(manifestId, {
        status: 'complete',
        assetCount: counts.assets,
        fileCount: counts.files,
        bytes: counts.bytes,
      });
    }

    run.progress.result = { ...run.progress.result, phase: 'done' };
    // Written whatever a pause or cancel asks: the backup is complete, and `finish` settles either.
    const written = await this.operations.setBulkResult(run.id, run.claimToken, {
      result: run.progress.result as unknown as Record<string, unknown>,
      processedUnits: run.progress.result.assets,
      totalUnits: run.progress.result.total ?? run.progress.result.assets,
      progress: runProgress(run.progress.result),
      leaseMs: CLOUD_BACKUP_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Cloud backup run ${run.id}: claim lost after its manifest was written`);
      return false;
    }
    return true;
  }

  /**
   * The manifest's JSON in pieces: the header, then each asset with its files (an asset's entries are
   * adjacent in `fileKey` order), then the profile images. Counts what it wrote into `counts`.
   */
  private async *manifestChunks(
    run: Run,
    manifestId: string,
    counts: { assets: number; files: number; bytes: number },
  ): AsyncGenerator<string> {
    const header = {
      format: CLOUD_BACKUP_MANIFEST_FORMAT,
      version: 1,
      instanceId: run.metadata.instanceId,
      createdAt: new Date().toISOString(),
      database: run.progress.result.database,
    };
    yield `${JSON.stringify(header).slice(0, -1)},"assets":{`;

    const profiles: string[] = [];
    type ManifestAsset = { id: string; owner: string | null; files: CloudBackupManifestFile[] };
    // held in an object: the asset in hand changes inside the loop, which narrowing a local cannot follow
    const pending: { asset: ManifestAsset | null } = { asset: null };
    const assetJson = (current: ManifestAsset) => {
      const body = JSON.stringify({ owner: current.owner, files: current.files });
      const text = `${counts.assets > 0 ? ',' : ''}${JSON.stringify(current.id)}:${body}`;
      counts.assets += 1;
      return text;
    };

    let after: string | null = null;
    let more = true;
    while (more) {
      const page = await this.index.getEntriesPage(manifestId, after, CLOUD_BACKUP_MANIFEST_PAGE);
      for (const entry of page) {
        counts.files += 1;
        counts.bytes += entry.size;
        const file: CloudBackupManifestFile = {
          role: entry.role,
          path: entry.path,
          sha256: entry.sha256,
          size: entry.size,
          mtime: asIso(entry.mtime),
        };
        if (!entry.assetId) {
          if (entry.ownerId) {
            profiles.push(`${JSON.stringify(entry.ownerId)}:${JSON.stringify(file)}`);
          }
          continue;
        }
        let asset = pending.asset;
        if (asset?.id !== entry.assetId) {
          if (asset) {
            yield assetJson(asset);
          }
          asset = { id: entry.assetId, owner: entry.ownerId, files: [] };
          pending.asset = asset;
        }
        asset.files.push(file);
      }
      more = page.length === CLOUD_BACKUP_MANIFEST_PAGE;
      after = page.at(-1)?.fileKey ?? after;
    }
    if (pending.asset) {
      yield assetJson(pending.asset);
    }
    yield `},"profiles":{${profiles.join(',')}}}`;
  }

  private async finish(run: Run) {
    const { id, claimToken, operation } = run;
    const { result } = run.progress;
    // The manifest is in the bucket and the `done` checkpoint saved: its recorded files can go now.
    if (result.manifestId) {
      await this.index.deleteEntries(result.manifestId);
    }
    // The manifest is in the bucket: the backup is complete, even when a cancel arrived after it.
    const finishedAt = new Date().toISOString();
    await this.recordRun(operation, result, 'completed');
    await this.updateMetadata((current) => ({
      ...current,
      lastSuccessAt: finishedAt,
      lastManifestKey: result.manifestKey ?? current.lastManifestKey,
    }));
    const completed =
      (await this.operations.beginValidation(id, claimToken)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }));
    if (!completed) {
      // Cancelled after the manifest was written: the backup stands as recorded; settle the cancel.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    }
    this.logger.log(
      `Cloud backup run ${id} finished: ${result.uploaded} uploaded, ${result.skipped} already backed up, ${result.missing} missing`,
    );
  }

  /** Write the cursor and counts; answer whether to carry on (no on a lost claim, a cancel or a pause). */
  private async checkpoint(run: Run): Promise<boolean> {
    const { id, claimToken, operation } = run;
    const { result } = run.progress;
    const written = await this.operations.setBulkResult(id, claimToken, {
      result: result as unknown as Record<string, unknown>,
      processedUnits: result.assets,
      totalUnits: result.total ?? result.assets,
      progress: runProgress(result),
      leaseMs: CLOUD_BACKUP_LEASE_MS,
    });
    return this.proceed(id, claimToken, written, operation, result);
  }

  private async proceed(
    id: string,
    claimToken: string,
    written: MediaOperationWriteState | undefined,
    operation: MediaOperation,
    result: CloudBackupRunResult,
  ): Promise<boolean> {
    if (!written) {
      this.logger.warn(`Cloud backup run ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      await this.endManifest(result, 'cancelled');
      await this.recordRun(operation, result, 'cancelled');
      this.logger.log(`Cloud backup run ${id} cancelled`);
      return false;
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      this.logger.log(`Cloud backup run ${id} paused`);
      return false;
    }
    return true;
  }

  /** A run that ends without a manifest keeps nothing of it; what it uploaded stays in the index. */
  private async endManifest(result: CloudBackupRunResult, status: 'cancelled' | 'failed') {
    if (!result.manifestId) {
      return;
    }
    // A manifest already in the bucket stays complete, whatever happens to its run afterwards.
    const row = await this.index.getManifest(result.manifestId);
    if (row?.status === 'complete') {
      return;
    }
    await this.index.finishManifest(result.manifestId, { status });
    await this.index.deleteEntries(result.manifestId);
  }

  private async recordRun(
    operation: MediaOperation,
    result: CloudBackupRunResult,
    status: FrameleafCloudBackupRun['status'],
    error?: string,
  ) {
    const finished = status === 'completed' || status === 'failed' || status === 'cancelled';
    await this.updateMetadata((current) => ({
      ...current,
      lastRun: {
        operationId: operation.id,
        status,
        startedAt: asIso(operation.createdAt) ?? new Date().toISOString(),
        ...(finished && { finishedAt: new Date().toISOString() }),
        uploaded: result.uploaded,
        skipped: result.skipped,
        missing: result.missing,
        bytesUploaded: result.bytesUploaded,
        ...(result.manifestKey && { manifestKey: result.manifestKey }),
        ...(error && { error }),
      },
    }));
  }

  private async updateMetadata(change: (current: FrameleafCloudBackup) => FrameleafCloudBackup) {
    const current = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (current) {
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudBackup, change(current));
    }
  }

  private notify(notice: {
    level: NotificationLevel;
    title: string;
    description: string;
    dedupeKey: string;
    dedupeDays?: number;
  }) {
    this.eventRepository
      .emit('AdminNotify', { type: NotificationType.BackupFailed, ...notice })
      .catch((error) => this.logger.warn(`Could not notify administrators: ${errorMessage(error)}`));
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * The bucket key, or null when it is not available: in own-memory mode until it is unlocked on this
   * worker; in the stored modes when the key file is missing. A key that does not match the claim's
   * fingerprint is never used.
   */
  private async loadKey(metadata: FrameleafCloudBackup): Promise<Buffer | null> {
    if (metadata.keyMode === 'own-memory') {
      return this.memoryKey?.fingerprint === metadata.keyFingerprint ? this.memoryKey.key : null;
    }
    const content = await this.keys.read(identityDirectory(this.configRepository), metadata.keyFingerprint);
    if (!content) {
      return null;
    }
    const key = parseBackupKey(content);
    return keyFingerprint(key) === metadata.keyFingerprint ? key : null;
  }

  /**
   * The own-memory key, asking the other workers for it when this one does not hold it (a restarted
   * worker): the request goes out at most every ten seconds and waits up to `keyAskMs` for an answer.
   */
  private async loadKeyOrAsk(metadata: FrameleafCloudBackup): Promise<Buffer | null> {
    const key = await this.loadKey(metadata);
    if (key || metadata.keyMode !== 'own-memory') {
      return key;
    }
    const now = Date.now();
    if (now - this.lastKeyAskAt < KEY_ASK_INTERVAL_MS) {
      return null;
    }
    this.lastKeyAskAt = now;
    this.websocketRepository.serverSend('CloudBackupKeyRequest');
    if (this.keyAskMs > 0) {
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(timer);
          this.keyWaiters.delete(done);
          resolve();
        };
        this.keyWaiters.add(done);
        timer = setTimeout(done, this.keyAskMs);
      });
    }
    return this.loadKey(metadata);
  }

  /** Write and read back the key file of a stored key mode (0600). */
  private async storeKey(
    mode: Exclude<CloudBackupKeyMode, 'own-memory'>,
    key: Buffer,
    options: { instanceId: string; bucket: string },
  ): Promise<{ created: boolean }> {
    const file = backupKeyFile({
      key,
      instanceId: options.instanceId,
      bucket: options.bucket,
      mode,
      createdAt: new Date(),
    });
    try {
      return await this.keys.write(
        identityDirectory(this.configRepository),
        keyFingerprint(key),
        JSON.stringify(file, null, 2),
      );
    } catch (error) {
      throw new BadRequestException(`The backup key could not be stored on this server: ${errorMessage(error)}`);
    }
  }

  private parseKey(value: string): Buffer {
    try {
      return parseBackupKey(value);
    } catch (error) {
      throw new BadRequestException(errorMessage(error));
    }
  }

  /** The connection for your own bucket; an empty secret uses the stored one for the same bucket and key. */
  private async connectionFor(s3: CloudBackupS3): Promise<CloudBackupConnection> {
    const endpoint = s3.endpoint.trim().replace(/\/+$/, '');
    const bucket = s3.bucket.trim();
    const accessKeyId = s3.accessKeyId.trim();
    let secretAccessKey = s3.secretAccessKey;
    if (!secretAccessKey) {
      const stored = (await this.readSettings()).frameleafCloud.cloudBackup.s3;
      if (stored.endpoint === endpoint && stored.bucket === bucket && stored.accessKeyId === accessKeyId) {
        secretAccessKey = stored.secretAccessKey;
      }
    }
    const problem = s3SettingsProblem({ endpoint, bucket, accessKeyId, secretAccessKey });
    if (problem) {
      throw new BadRequestException(problem);
    }
    return { endpoint, region: signingRegion(endpoint, s3.region ?? ''), bucket, accessKeyId, secretAccessKey };
  }

  private asRequestError(error: unknown) {
    if (error instanceof CloudBackupClaimError) {
      return new ConflictException(error.message);
    }
    if (error instanceof CloudBackupStoreError) {
      if (error.status === 403 || error.status === 401) {
        return new BadRequestException('The storage provider refused these credentials for this bucket.');
      }
      if (error.status === 404) {
        return new BadRequestException('The storage provider has no bucket by that name.');
      }
      return new BadRequestException(`The bucket could not be checked: ${error.message}`);
    }
    return error;
  }

  /** Setup and turning off change the settings, which a configuration file holds instead when one is in use. */
  private requireEditableConfig() {
    if (this.configRepository.getEnv().configFile) {
      throw new BadRequestException('Cannot update configuration while IMMICH_CONFIG_FILE is in use');
    }
  }

  private async requireClaim(): Promise<FrameleafCloudBackup> {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (!metadata) {
      throw new BadRequestException('Cloud backup is not set up.');
    }
    return metadata;
  }

  private async requireRun(id: string): Promise<MediaOperation> {
    const operation = await this.operations.getOfKind(id, KIND);
    if (!operation) {
      throw new NotFoundException('Backup run not found');
    }
    return operation;
  }

  private mapLastRun(run: FrameleafCloudBackupRun) {
    return {
      operationId: run.operationId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
      uploaded: run.uploaded,
      skipped: run.skipped,
      missing: run.missing,
      bytesUploaded: run.bytesUploaded,
      error: run.error ?? null,
    };
  }

  private mapActiveRun(operation: MediaOperation) {
    const result = parseRunResult(operation.result);
    return {
      operationId: operation.id,
      state: runState(operation.status as MediaOperationStatus, !!operation.pauseRequestedAt),
      phase: result.phase,
      progress: Number(operation.progress ?? 0),
      uploaded: result.uploaded,
      skipped: result.skipped,
    };
  }

  private configRepos() {
    return {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
      forkSchemaRepo: this.forkSchemaRepository,
    };
  }

  private readSettings() {
    return getConfig(this.configRepos(), { withCache: false });
  }
}

type Run = {
  id: string;
  claimToken: string;
  operation: MediaOperation;
  metadata: FrameleafCloudBackup;
  connection: CloudBackupConnection;
  bucketKey: Buffer;
  progress: { result: CloudBackupRunResult };
  /** Hashes this claim uploaded, so a second file with the same content in this run is never uploaded. */
  uploadedNow: Set<string>;
};
