import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CronTime } from 'cron';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  CloudBackupOwnerSetupResponseDto,
  OwnerBackupHistoryDto,
  OwnerBackupHistoryResponseDto,
  OwnerBackupPageDto,
  OwnerBackupsResponseDto,
} from 'src/dtos/cloud-backup-owner.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { OwnerRestoreDetailsContext } from 'src/services/cloud-backup-details.service.js';
import type {
  CloudBackupKeyMode,
  FrameleafCloudBackup,
  FrameleafCloudBackupManaged,
  FrameleafCloudBackupRestore,
  FrameleafCloudBackupRun,
} from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CloudBackupCheckDto,
  CloudBackupCheckResponseDto,
  CloudBackupEscrowDto,
  CloudBackupGeneratedKeyDto,
  CloudBackupManifestAlbum,
  CloudBackupManifestAlbumsDto,
  CloudBackupManifestAlbumsResponseDto,
  CloudBackupManifestItem,
  CloudBackupManifestItemsDto,
  CloudBackupManifestItemsResponseDto,
  CloudBackupManifestsResponseDto,
  CloudBackupPruneDto,
  CloudBackupRestoreDto,
  CloudBackupRunState,
  CloudBackupS3,
  CloudBackupSetupDto,
  CloudBackupStatusResponseDto,
  CloudBackupUnlockDto,
  CloudBackupVerifyDto,
} from 'src/dtos/cloud-backup.dto.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import {
  AssetStatus,
  ChecksumAlgorithm,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  NotificationLevel,
  NotificationType,
  PushEventType,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import {
  CloudBackupAsset,
  CloudBackupEntry,
  CloudBackupIndexRepository,
  CloudBackupLibraryAsset,
} from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import {
  CLOUD_BACKUP_FRESH_KEY_MS,
  CloudBackupClaimError,
  CloudBackupConnection,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
  CloudBackupStoreRepository,
} from 'src/repositories/cloud-backup-store.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import {
  FrameleafCloudBackupRepository,
  ManagedBackupApi,
} from 'src/repositories/frameleaf-cloud-backup.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { CloudBackupDetailsService } from 'src/services/cloud-backup-details.service.js';
import {
  CloudBackupBucket,
  CloudBackupMaintenance,
  CloudBackupVerifyResult,
  emptyPruneResult,
  emptyVerifyResult,
} from 'src/services/cloud-backup-maintenance.js';
import {
  CloudBackupRestoreFile,
  CloudBackupRestoreResult,
  CloudBackupRestoreScope,
  CloudBackupRestoreSnapshot,
  CloudBackupRestorer,
  IN_PLACE_SCOPES,
  RESTORE_REPLACED_FOLDER,
  emptyRestoreResult,
  restorePlan,
} from 'src/services/cloud-backup-restore.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { selectBackupLocation } from 'src/utils/backup-location-selection.js';
import { escrowPassphraseProblem, unwrapBucketKey, wrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
import {
  assertOwnerRestoreFile,
  assertOwnerRestorePath,
  captureOwnerRestoreFile,
} from 'src/utils/cloud-backup-owner-path.js';
import { checkOwnerRestoreItems, ownerRestoreHash } from 'src/utils/cloud-backup-owner-restore.js';
import { ownerBackupHistoryPage, ownerThumbnail } from 'src/utils/cloud-backup-owner.js';
import { manifestTime, readManifest, verificationDue } from 'src/utils/cloud-backup-retention.js';
import {
  CLOUD_BACKUP_BATCH,
  CLOUD_BACKUP_DB_PREFIX,
  CLOUD_BACKUP_MANIFEST_FORMAT,
  CLOUD_BACKUP_MANIFEST_PREFIX,
  CLOUD_BACKUP_MANIFEST_VERSION,
  CLOUD_BACKUP_OBJECT_PREFIX,
  CLOUD_BACKUP_OWN_MEMORY_ACKNOWLEDGEMENT,
  CloudBackupAssetDetails,
  CloudBackupAssetRecord,
  CloudBackupManifest,
  CloudBackupManifestFile,
  CloudBackupRunResult,
  backupKeyFile,
  bucketRef,
  compactIso,
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
import { recordConfigHistory } from 'src/utils/config-history.js';
import { getConfig, readConfig, updateConfig, withEffectiveConfigWrite } from 'src/utils/config.js';
import { CLOUD_BACKUP_DUMP_PREFIX, isCloudBackupDumpName } from 'src/utils/database-backups.js';
import {
  advanceExecutionProgress,
  assertExecutionActive,
  executionSignal,
  reportExecutionProgress,
} from 'src/utils/execution-signal.js';
import {
  BackupGrantResponse,
  MANAGED_ENTITLEMENT_MISSING_REFUSAL,
  backupGrantProblem,
  managedBackupRefusal,
  managedStorageRef,
} from 'src/utils/frameleaf-cloud-backup.js';
import {
  CLONE_SUSPECTED_NOTICE,
  identityDirectory,
  loadInstanceIdentity,
  readCloudLink,
} from 'src/utils/frameleaf-cloud-gateway.js';
import { FrameleafCloudError, errorEnvelopeSchema, pausedException } from 'src/utils/frameleaf-cloud.js';
import {
  CloudBackupActivationProgress,
  type PushJobRef,
  activationLine,
  cloudBackupActivationProgress,
  pushJobData,
} from 'src/utils/frameleaf-push.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { settleOperationStop, withOperationExecution } from 'src/utils/operation-execution.js';

const KIND = MediaOperationKind.CloudBackup;
/** FL-164: a restore uses the bucket too, so it never runs beside a backup operation, nor they beside it. */
const RESTORE_KIND = MediaOperationKind.CloudRestore;
const BUCKET_KINDS = [KIND, RESTORE_KIND];

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
/** FL-164: the cron jobs of the one server holding `DatabaseLock.FrameleafCloudBackupCheck`. */
export const CLOUD_BACKUP_SCHEDULE_CRON = 'cloudBackupSchedule';
export const CLOUD_BACKUP_VERIFY_CRON = 'cloudBackupVerify';
/** FL-164: whether a verification is due is looked at hourly; it runs when nothing else holds the bucket. */
const VERIFY_CHECK_EXPRESSION = '23 * * * *';
/** FL-164: a retryable refusal of managed storage waits this long when Frameleaf Cloud names no time. */
const MANAGED_RETRY_MS = 15 * 60_000;
/** FL-164: while this server is not linked, a managed operation waits this long before it looks again. */
const MANAGED_UNLINKED_RETRY_MS = 60 * 60_000;
/** FL-164: the usage a status read shows is asked for again after this long. */
const MANAGED_USAGE_REFRESH_MS = 10 * 60_000;
/** FL-164: a check that failed is not tried again by the schedule for this long. */
const VERIFY_FAILED_BACKOFF_MS = 24 * 60 * 60_000;
/** FL-164: no check starts this close before the scheduled backup. */
const VERIFY_QUIET_MS = 60 * 60_000;
/** FL-164: a clean-up needs a dry run from the last day, with no backup since. */
const PRUNE_PREVIEW_VALID_MS = 24 * 60 * 60_000;
/** FL-164: items a restore list reads the library state of per query. */
const LIBRARY_STATE_BATCH = 5000;

/** FL-164: what `frameleaf-admin cloud-backup restore` restores from, and how much of it. */
export type CloudBackupBareMetalRestore = {
  s3: CloudBackupS3;
  /** The key file's content, the base64 key, or the recovery code. Never logged. */
  key: string;
  manifestKey?: string;
  scope: Extract<CloudBackupRestoreScope, 'files' | 'database' | 'library'>;
  restoreDatabase: boolean;
};

/** FL-164: what a `cloud_backup` operation does; a row from before FL-164 has no task and is a backup run. */
type BackupTask = 'backup' | 'verify' | 'prune';

const taskOf = (operation: Pick<MediaOperation, 'snapshot'>): BackupTask => {
  const task = (operation.snapshot as { task?: unknown } | null)?.task;
  return task === 'verify' || task === 'prune' ? task : 'backup';
};

const TASK_LABEL: Record<BackupTask, string> = {
  backup: 'Cloud backup',
  verify: 'Cloud backup check',
  prune: 'Cloud backup clean-up',
};

/**
 * FL-164: a refusal of Frameleaf-managed storage that this server decides itself (not linked, a copy
 * suspected) rather than one Frameleaf Cloud answered.
 */
class ManagedStorageRefusal extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
    readonly cloneSuspected = false,
  ) {
    super(message);
    this.name = 'ManagedStorageRefusal';
  }
}

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
 *
 * FL-164 (CLD-302) completes it:
 *
 * - **Schedule.** The one server holding `DatabaseLock.FrameleafCloudBackupCheck` runs the schedule's cron
 *   (`frameleafCloud.cloudBackup.schedule.cronExpression`) and the hourly verification check. Every
 *   operation on the bucket is created under `DatabaseLock.FrameleafCloudBackup` and refused while another
 *   `cloud_backup` or `cloud_restore` operation is unfinished, so a scheduled run never duplicates one in
 *   progress and nothing ever uses the bucket beside anything else.
 * - **Retention** (`prune`) after every scheduled run, or by hand after a dry run: see
 *   `CloudBackupMaintenance`. **Verification** (`verify`): a weekly sample and a monthly full pass.
 * - **Frameleaf-managed storage.** Setup asks Frameleaf Cloud for this server's bucket
 *   (`POST /v1/backup/grant`); every operation rotates the bucket-scoped key first
 *   (`POST /v1/backup/grant/rotate`) and holds it in memory for that operation only, never persisted. A
 *   read-only grant stops uploads and clean-ups without touching this server's files; restores and
 *   verifications keep working. A suspected copy of this server, a withdrawn grant or a missing plan stops
 *   with its reason; a rate limit or an unreachable cloud waits and tries again.
 * - **Escrow** (server key mode only): the key wrapped under a passphrase with scrypt and stored with
 *   Frameleaf Cloud, which cannot unwrap it.
 * - **Restore** by manifest as a `cloud_restore` operation: see `CloudBackupRestorer`.
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
  /** FL-164: this process holds the schedule (`DatabaseLock.FrameleafCloudBackupCheck`). */
  private scheduleLock = false;
  /** FL-164: the last manifest a restore list read, so paging through it reads the bucket once. */
  private manifestCache?: { bucketRef: string; key: string; binding: string; manifest: CloudBackupManifest };
  private readonly maintenance: CloudBackupMaintenance;
  private readonly restorer: CloudBackupRestorer;

  constructor(
    private logger: LoggingRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private forkSchemaRepository: AssetChecksumRepository,
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
    private cloudBackup: FrameleafCloudBackupRepository,
    private userRepository: UserRepository,
    private cronRepository: CronRepository,
    private jobRepository: JobRepository,
    private details: CloudBackupDetailsService,
  ) {
    this.logger.setContext(CloudBackupService.name);
    this.maintenance = new CloudBackupMaintenance(store, index, logger);
    this.restorer = new CloudBackupRestorer(store, storageRepository, cryptoRepository, logger);
  }

  /* ------------------------------------------------------------------ */
  /* Status and setup                                                    */
  /* ------------------------------------------------------------------ */

  async getStatus(): Promise<CloudBackupStatusResponseDto> {
    const [config, stored, active, activeRestore, link] = await Promise.all([
      this.readSettings(),
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup),
      this.operations.getActiveOfKind(KIND),
      this.operations.getActiveOfKind(RESTORE_KIND),
      readCloudLink(this.gatewayDeps()),
    ]);
    const settings = config.frameleafCloud.cloudBackup;
    const metadata = stored?.target === 'managed' ? await this.refreshManagedUsage(stored, link.linked) : stored;
    const configured = !!metadata && settings.enabled && settings.target !== 'off';
    const activeRow = active ? await this.operations.getOfKind(active.id, KIND) : undefined;
    const restoreRow = activeRestore ? await this.operations.getOfKind(activeRestore.id, RESTORE_KIND) : undefined;
    const usage = metadata?.managed?.usage;

    return {
      configured,
      target: settings.enabled ? settings.target : 'off',
      managedAvailable: link.linked,
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
      usage: usage
        ? { objects: usage.objects, bytes: usage.bytesCurrent }
        : metadata
          ? await this.index.getUsage(metadata.bucketRef)
          : null,
      activeRun: activeRow ? this.mapActiveRun(activeRow) : null,
      activeRestore: restoreRow ? this.mapActiveRestore(restoreRow) : null,
      lastRestore: metadata?.lastRestore ? this.mapLastRestore(metadata.lastRestore) : null,
      lastVerify: metadata?.lastVerify ? { ...metadata.lastVerify, error: metadata.lastVerify.error ?? null } : null,
      lastPrune: metadata?.lastPrune ?? null,
      managed: metadata?.managed
        ? {
            storageId: metadata.managed.storageId ?? null,
            location: metadata.managed.location ?? null,
            readOnly: metadata.managed.readOnly,
            readOnlyReason: metadata.managed.readOnlyReason,
            quotaBytes: metadata.managed.quotaBytes,
            usedBytes: usage?.bytesCurrent ?? null,
            objects: usage?.objects ?? null,
            allowanceBytes: usage?.allowanceBytes ?? null,
            extraBlocks: usage?.extraBlocks ?? null,
            measuredAt: usage?.measuredAt ?? null,
            refusal: metadata.managed.refusal ?? null,
          }
        : null,
      escrow: {
        available: metadata?.keyMode === 'server' && link.linked,
        stored: !!metadata?.escrow,
        storedAt: metadata?.escrow?.storedAt ?? null,
      },
    };
  }

  /**
   * FL-234: the activation chain for the server's owner (an administrator) to poll. Stored metadata and
   * the active operation only: no Frameleaf Cloud call, and nothing about the bucket, key, usage or files.
   */
  async getOwnerSetup(auth: AuthDto): Promise<CloudBackupOwnerSetupResponseDto> {
    if (auth.sharedLink || !auth.user.isAdmin) {
      throw new ForbiddenException('Only the server owner can read the cloud backup setup');
    }
    return this.ownerSetupState();
  }

  /** The owner setup state behind `getOwnerSetup`, for the server's own use (FL-228 activation pushes). */
  private async ownerSetupState(): Promise<CloudBackupOwnerSetupResponseDto> {
    const [config, metadata, active, link] = await Promise.all([
      this.readSettings(),
      this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup),
      this.operations.getActiveOfKind(KIND),
      readCloudLink(this.gatewayDeps()),
    ]);
    const settings = config.frameleafCloud.cloudBackup;
    const target = settings.enabled ? settings.target : 'off';
    const activeRow = active ? await this.operations.getOfKind(active.id, KIND) : undefined;
    const activeBackup = activeRow && taskOf(activeRow) === 'backup' ? activeRow : undefined;

    let entitlement: CloudBackupOwnerSetupResponseDto['entitlement'] = 'not-applicable';
    if (target === 'managed') {
      const refused = metadata?.managed?.refusal === MANAGED_ENTITLEMENT_MISSING_REFUSAL;
      entitlement = link.linked && !refused ? 'seen' : 'pending';
    }

    let firstRun: CloudBackupOwnerSetupResponseDto['firstRun'] = 'not-started';
    if (metadata?.lastSuccessAt) {
      firstRun = 'done';
    } else if (activeBackup) {
      const state = runState(activeBackup.status as MediaOperationStatus, !!activeBackup.pauseRequestedAt);
      firstRun = state === 'queued' ? 'queued' : 'running';
    } else if (metadata?.lastRun?.status === 'failed') {
      firstRun = 'failed';
    }

    return {
      target,
      entitlement,
      bucketClaimed: !!metadata,
      claimedAt: metadata?.claimedAt ?? null,
      keyLoaded: metadata ? !!(await this.loadKeyOrAsk(metadata).catch(() => null)) : false,
      firstRun,
      nextRunAt: metadata && target !== 'off' ? this.nextScheduledRun(settings.schedule.cronExpression) : null,
    };
  }

  /** FL-234: when the configured schedule next starts a backup, or null for an expression that never does. */
  private nextScheduledRun(cronExpression: string): string | null {
    try {
      return new CronTime(cronExpression).sendAt().toUTC().toISO();
    } catch {
      return null;
    }
  }

  /** Internal availability only: no grants, remote usage calls or admin settings in the public DTO. */
  async getSafetyAvailability(): Promise<{
    state: 'off' | 'not-linked' | 'not-configured' | 'paused-key-unloaded' | 'ready';
    bucket: string | null;
    /** FL-301: Frameleaf-managed storage is read-only, so new items wait; restores keep working. */
    readOnly: boolean;
    /** Why, as Frameleaf Cloud last said (`plan_full`, …); open-ended, null when it did not say. */
    readOnlyReason: string | null;
  }> {
    const unavailable = { bucket: null, readOnly: false, readOnlyReason: null };
    const settings = (await this.readSettings()).frameleafCloud.cloudBackup;
    if (!settings.enabled || settings.target === 'off') return { state: 'off', ...unavailable };
    if (settings.target === 'managed' && !(await readCloudLink(this.gatewayDeps())).linked)
      return { state: 'not-linked', ...unavailable };
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (!metadata || metadata.target !== settings.target) return { state: 'not-configured', ...unavailable };
    if (settings.target === 'byo-s3' && bucketRef(settings.s3.endpoint, settings.s3.bucket) !== metadata.bucketRef)
      return { state: 'not-configured', ...unavailable };
    const key = await this.loadKeyOrAsk(metadata).catch(() => null);
    const readOnly = settings.target === 'managed' && !!metadata.managed?.readOnly;
    return {
      state: key ? 'ready' : 'paused-key-unloaded',
      bucket: metadata.bucketRef,
      readOnly,
      readOnlyReason: readOnly ? (metadata.managed?.readOnlyReason ?? null) : null,
    };
  }

  /**
   * FL-164: Frameleaf-managed storage's usage and read-only state, asked for again when the last answer is
   * older than ten minutes. `GET /v1/backup/usage` issues no key, so it never disturbs a running
   * operation. A failure keeps what was last known.
   */
  private async refreshManagedUsage(metadata: FrameleafCloudBackup, linked: boolean): Promise<FrameleafCloudBackup> {
    const measured = metadata.managed?.usage ? Date.parse(metadata.managed.checkedAt) : NaN;
    if (!linked || Date.now() - measured < MANAGED_USAGE_REFRESH_MS) {
      return metadata;
    }
    try {
      const usage = await this.cloudBackup.usage(await this.managedApi());
      const managed = {
        ...metadata.managed,
        quotaBytes: usage.includedBytes,
        readOnly: usage.readOnly,
        readOnlyReason: usage.readOnlyReason,
        usage: {
          measuredAt: usage.measuredAt,
          bytesCurrent: usage.bytesCurrent,
          objects: usage.objects,
          allowanceBytes: usage.allowanceBytes,
          extraBlocks: usage.extraBlocks,
        },
        checkedAt: new Date().toISOString(),
      };
      await this.updateMetadata((current) => ({ ...current, managed }));
      return { ...metadata, managed };
    } catch (error) {
      this.logger.warn(`Could not read the managed backup usage: ${errorMessage(error)}`);
      return metadata;
    }
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
   * Claim the bucket with the chosen key and turn cloud backup on. Refused while an operation is active,
   * without the typed acknowledgement in own-memory mode, and for any bucket the claim refuses. The key is
   * stored only in the stored key modes, in its 0600 file; your own bucket's secret access key goes into
   * the configuration as a write-only credential. FL-164: Frameleaf-managed storage asks Frameleaf Cloud for
   * this server's bucket and a key for it, used for the claim and then forgotten.
   */
  async setup(auth: AuthDto, dto: CloudBackupSetupDto): Promise<CloudBackupStatusResponseDto> {
    this.requireEditableConfig();
    // the check that nothing holds the bucket, the managed key and the claim happen under the bucket lock,
    // so no operation starts (or rotates the key) in between
    await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudBackup, () => this.setupLocked(auth, dto));
    return this.getStatus();
  }

  private async setupLocked(auth: AuthDto, dto: CloudBackupSetupDto): Promise<void> {
    if (await this.activeBucketOperation()) {
      throw new ConflictException('Wait for the running backup to finish, or cancel it, before changing the setup.');
    }
    if (dto.target === 'byo-s3' && !dto.s3) {
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
    if (dto.target === 'managed') {
      // FL-228: the plan is active and the server has it; storage is being prepared (step 3 of 4)
      await this.announceActivation({ preparing: true });
    }
    const managed = dto.target === 'managed' ? await this.managedGrantForSetup() : null;
    const connection = managed ? managed.connection : await this.connectionFor(dto.s3!);
    const identity = await loadInstanceIdentity(this.gatewayDeps());

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
        const result = await withEffectiveConfigWrite(this.configRepos(), async (repos) => {
          const current = await readConfig(repos);
          const next = structuredClone(current);
          next.frameleafCloud.cloudBackup = {
            ...current.frameleafCloud.cloudBackup,
            enabled: true,
            target: dto.target,
            // managed storage's key is issued per operation and never kept; your own bucket's is
            s3: managed
              ? current.frameleafCloud.cloudBackup.s3
              : {
                  endpoint: connection.endpoint,
                  region: dto.s3?.region?.trim() ?? '',
                  bucket: connection.bucket,
                  accessKeyId: connection.accessKeyId,
                  secretAccessKey: connection.secretAccessKey,
                },
            keyMode: dto.keyMode,
            // escrow belongs to one server-generated key; a new setup starts without it
            escrow: false,
          };
          const saved = await updateConfig(repos, next);
          return { oldConfig: current, newConfig: saved };
        });
        // FL-146 (FL-66): listed in the settings history as a Frameleaf Cloud change, under the same lock
        await recordConfigHistory(this.historyRecorder(), result.oldConfig, result.newConfig, auth.user, {
          kind: 'settings',
          source: 'frameleaf-cloud',
        });
        return result;
      },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });

    const previous = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    const legacyClaim =
      managed &&
      claim.existing &&
      previous?.target === 'managed' &&
      !previous.managed?.storageId &&
      previous.bucketRef.startsWith('https://') &&
      previous.bucketRef.endsWith(`/${previous.bucket}`) &&
      previous.bucket === connection.bucket &&
      previous.region === connection.region &&
      previous.instanceId === identity.instanceId &&
      previous.keyFingerprint === fingerprint;
    const ref = legacyClaim
      ? previous.bucketRef
      : managed
        ? managedStorageRef(managed.state.storageId)
        : bucketRef(connection.endpoint, connection.bucket);
    const managedState = managed && { ...managed.state, ...(legacyClaim && { storageId: undefined }) };
    // A new claim means the bucket was empty: whatever the index remembers of it (an emptied or recreated
    // bucket) is gone, and the first run reads the bucket's listing again.
    if (!claim.existing) {
      await this.index.deleteBucket(ref);
    }
    const sameBucket = claim.existing && previous?.bucketRef === ref && previous.keyFingerprint === fingerprint;
    await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafCloudBackup, {
      target: dto.target,
      bucketRef: ref,
      endpoint: connection.endpoint,
      region: connection.region,
      bucket: connection.bucket,
      instanceId: identity.instanceId,
      claimedAt: claim.claimedAt,
      keyMode: dto.keyMode,
      keyFingerprint: fingerprint,
      lastCheckAt: new Date().toISOString(),
      ...(managedState && { managed: managedState }),
      ...(sameBucket && {
        reconciledAt: previous.reconciledAt,
        lastRun: previous.lastRun,
        lastSuccessAt: previous.lastSuccessAt,
        lastManifestKey: previous.lastManifestKey,
        lastVerify: previous.lastVerify,
        lastFullVerifyAt: previous.lastFullVerifyAt,
        lastPrune: previous.lastPrune,
        lastRestore: previous.lastRestore,
      }),
    });

    // Own-memory: held here, and shared once the claim is saved so the other workers accept it.
    if (dto.keyMode === 'own-memory') {
      this.memoryKey = { fingerprint, key };
      this.websocketRepository.serverSend('CloudBackupKeyShare', { key: key.toString('base64') });
    }
    // Frameleaf Cloud keeps escrow for the server key mode only, and warns when a schedule stops running
    await this.reportAgentSettings(dto.keyMode, true);
    // a copy of another key would only mislead a recovery: it goes when the key changes
    if (previous?.keyFingerprint !== fingerprint) {
      await this.deleteStaleEscrow();
    }

    this.logger.log(
      `Cloud backup set up by ${auth.user.id}: ${dto.target === 'managed' ? 'Frameleaf-managed' : 'own'} bucket ${connection.bucket} ${claim.existing ? 'reclaimed' : 'claimed'}, key ${fingerprint} (${dto.keyMode})`,
    );
    // FL-228: storage is ready; the activation chain moves on to the first backup
    if (!sameBucket || !previous?.lastSuccessAt) {
      await this.announceActivation();
    }
  }

  /**
   * FL-228: the Cloud Backup activation chain for the owner's devices (the Live Activity on iOS, a
   * progress notification on Android). Only Frameleaf-managed storage has the chain, and once the first
   * backup is done it is over: `completed` says that this call reports that very backup. Never fails the
   * caller.
   */
  private async announceActivation({ completed = false, preparing = false } = {}) {
    try {
      const progress: CloudBackupActivationProgress | null = preparing
        ? {
            step: 3,
            total: 4,
            stage: 'preparing-storage',
            state: 'active',
            firstRun: 'not-started',
            nextRunAt: null,
          }
        : cloudBackupActivationProgress(await this.ownerSetupState());
      if (!progress || (progress.state === 'complete' && !completed)) {
        return;
      }
      await this.eventRepository.emit('PushNotify', {
        type: PushEventType.CloudBackupActivation,
        admins: true,
        title: 'Cloud Backup setup',
        body: activationLine(progress),
        systemTemplate: {
          version: 1,
          key:
            progress.stage === 'first-backup'
              ? progress.state === 'complete'
                ? 'activation-first-backup-complete'
                : progress.state === 'failed'
                  ? 'activation-first-backup-failed'
                  : progress.firstRun === 'running'
                    ? 'activation-first-backup-running'
                    : 'activation-first-backup-scheduled'
              : (
                  {
                    'plan-active': 'activation-plan-active',
                    'server-notified': 'activation-server-notified',
                    'preparing-storage': 'activation-preparing-storage',
                  } as const
                )[progress.stage],
          args: { step: progress.step, total: progress.total },
        },
        data: { step: progress.step, total: progress.total, stage: progress.stage, state: progress.state },
        activation: progress,
      });
    } catch (error) {
      this.logger.warn(`Could not announce the cloud backup activation: ${errorMessage(error)}`);
    }
  }

  /** FL-164: remove a key copy Frameleaf Cloud may hold for an earlier key; a failure is only logged. */
  private async deleteStaleEscrow() {
    const { linked } = await readCloudLink(this.gatewayDeps());
    if (!linked) {
      return;
    }
    try {
      await this.cloudBackup.deleteEscrow(await this.managedApi());
    } catch (error) {
      if (!(error instanceof FrameleafCloudError && error.status === 404)) {
        this.logger.warn(
          `Could not remove the key copy of an earlier key from Frameleaf Cloud: ${errorMessage(error)}`,
        );
      }
    }
  }

  /**
   * FL-164: this server's managed bucket and a key for the claim. A first grant answers with a key; a repeated
   * one does not, and is followed by a rotation. Refusals are answered with what they mean.
   */
  private async managedGrantForSetup(): Promise<{
    connection: CloudBackupConnection;
    state: NonNullable<FrameleafCloudBackup['managed']> & {
      storageId: string;
      location: BackupGrantResponse['location'];
    };
  }> {
    let issued: BackupGrantResponse;
    try {
      const api = await this.managedApi();
      const recorded = await this.cloudBackup.metadata(api);
      let locationId = recorded?.location.locationId;
      if (!locationId) {
        const catalog = await this.cloudBackup.locations(api);
        try {
          locationId = (await selectBackupLocation(catalog.locations)).locationId;
        } catch {
          throw new ManagedStorageRefusal('No backup location could be reached reliably. Try setup again.', 30_000);
        }
      }
      const grant = await this.cloudBackup.grant(api, locationId);
      issued = 'credentials' in grant ? grant : await this.cloudBackup.rotate(api);
      if (
        issued.location.locationId !== locationId ||
        issued.storageId !== grant.storageId ||
        issued.bucket !== grant.bucket ||
        issued.region !== grant.region ||
        (recorded &&
          (issued.storageId !== recorded.storageId ||
            issued.bucket !== recorded.bucket ||
            issued.region !== recorded.region))
      ) {
        throw new ManagedStorageRefusal('Frameleaf Cloud offered a different storage binding. Try setup again.', null);
      }
    } catch (error) {
      // FC-62: new backup grants are paused; the cloud's own message, as a 503 the page shows whole
      throw pausedException(error) ?? new ConflictException(this.refusalOf(error).message);
    }
    const problem = backupGrantProblem(issued);
    if (problem) {
      throw new ConflictException(problem);
    }
    if (issued.readOnly) {
      throw new ConflictException(
        'Frameleaf-managed storage is read-only for this server right now, so it cannot be set up. Check your plan on your Frameleaf account.',
      );
    }
    return {
      connection: this.managedConnection(issued),
      state: {
        storageId: issued.storageId,
        location: issued.location,
        readOnly: false,
        readOnlyReason: null,
        quotaBytes: issued.quotaBytes,
        checkedAt: new Date().toISOString(),
      },
    };
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
    if (await this.activeBucketOperation()) {
      throw new ConflictException('Cancel the running backup before turning cloud backup off.');
    }
    const { oldConfig, newConfig } = await this.databaseRepository.withLock(
      DatabaseLock.SystemConfigUpdate,
      async () => {
        const result = await withEffectiveConfigWrite(this.configRepos(), async (repos) => {
          const current = await readConfig(repos);
          const next = structuredClone(current);
          next.frameleafCloud.cloudBackup.enabled = false;
          const saved = await updateConfig(repos, next);
          return { oldConfig: current, newConfig: saved };
        });
        // FL-146 (FL-66): listed in the settings history as a Frameleaf Cloud change, under the same lock
        await recordConfigHistory(this.historyRecorder(), result.oldConfig, result.newConfig, auth.user, {
          kind: 'settings',
          source: 'frameleaf-cloud',
        });
        return result;
      },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (metadata) {
      await this.reportAgentSettings(metadata.keyMode, false);
    }
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
    const created = await this.createOperation(auth.user.id, metadata, 'backup', {});
    // a run already queued or running is the answer; a check, a clean-up or a restore holds the bucket
    if (!created.created && created.activeTask !== 'backup') {
      throw new ConflictException(
        'A cloud backup check, clean-up or restore is running. Back up again when it has finished.',
      );
    }
    return this.getStatus();
  }

  /**
   * FL-164: check the backed-up files now: `sample` fetches this week's 1/52 of them and checks each
   * against its SHA-256; `full` checks every file every kept backup names is there.
   */
  async startVerify(auth: AuthDto, dto: CloudBackupVerifyDto): Promise<CloudBackupStatusResponseDto> {
    const metadata = await this.requireClaim();
    await this.requireKeyForRequest(metadata);
    const created = await this.createOperation(auth.user.id, metadata, 'verify', { depth: dto.depth });
    if (!created.created) {
      throw new ConflictException('Another cloud backup operation is running. Check the backup when it has finished.');
    }
    return this.getStatus();
  }

  /**
   * FL-164: clean up runs past retention by hand. The first request must be a dry run, which counts what
   * would go; the clean-up itself is accepted only after a dry run from the last day with no backup since,
   * and plans again from the bucket as it is then.
   */
  async startPrune(auth: AuthDto, dto: CloudBackupPruneDto): Promise<CloudBackupStatusResponseDto> {
    const metadata = await this.requireClaim();
    await this.requireKeyForRequest(metadata);
    if (!dto.dryRun) {
      const preview = metadata.lastPrune;
      const previewAt = preview?.dryRun ? Date.parse(preview.at) : NaN;
      const backedUpSince = !!metadata.lastSuccessAt && Date.parse(metadata.lastSuccessAt) > previewAt;
      if (Number.isNaN(previewAt) || Date.now() - previewAt > PRUNE_PREVIEW_VALID_MS || backedUpSince) {
        throw new ConflictException('Preview the clean-up first, then remove what it found.');
      }
    }
    const created = await this.createOperation(auth.user.id, metadata, 'prune', { dryRun: dto.dryRun });
    if (!created.created) {
      throw new ConflictException('Another cloud backup operation is running. Clean up when it has finished.');
    }
    return this.getStatus();
  }

  async pauseRun(id: string): Promise<CloudBackupStatusResponseDto> {
    const operation = await this.requireRun(id);
    await this.operations.requestPause(id, operation.ownerId, BUCKET_KINDS);
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

  /**
   * Your own bucket needs a storage address and a bucket whenever cloud backup is on. FL-164: escrow is for
   * a key this server generated, and nothing else.
   */
  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    const backup = newConfig.frameleafCloud.cloudBackup;
    if (backup.escrow && backup.keyMode !== 'server') {
      throw new Error('Key escrow is only available when this server generates its own backup key.');
    }
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

  /* ------------------------------------------------------------------ */
  /* FL-164: the schedule and the verification check                      */
  /* ------------------------------------------------------------------ */

  /**
   * One server holds the schedule, as Library Care's does: the one that takes
   * `DatabaseLock.FrameleafCloudBackupCheck` runs the cron that queues scheduled runs and the hourly check
   * that queues a verification when one is due.
   */
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig }: ArgOf<'ConfigInit'>) {
    this.scheduleLock = await this.databaseRepository.tryLock(DatabaseLock.FrameleafCloudBackupCheck);
    if (!this.scheduleLock) {
      return;
    }
    const backup = newConfig.frameleafCloud.cloudBackup;
    this.cronRepository.create({
      name: CLOUD_BACKUP_SCHEDULE_CRON,
      expression: backup.schedule.cronExpression,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.CloudBackupSchedule, data: {} }), this.logger),
      start: backup.enabled && backup.target !== 'off',
    });
    this.cronRepository.create({
      name: CLOUD_BACKUP_VERIFY_CRON,
      expression: VERIFY_CHECK_EXPRESSION,
      onTick: () =>
        handlePromiseError(this.jobRepository.queue({ name: JobName.CloudBackupVerify, data: {} }), this.logger),
      start: backup.enabled && backup.target !== 'off' && backup.verifyWeekly,
    });
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig }: ArgOf<'ConfigUpdate'>) {
    if (!this.scheduleLock) {
      return;
    }
    const backup = newConfig.frameleafCloud.cloudBackup;
    this.cronRepository.update({
      name: CLOUD_BACKUP_SCHEDULE_CRON,
      expression: backup.schedule.cronExpression,
      start: backup.enabled && backup.target !== 'off',
    });
    this.cronRepository.update({
      name: CLOUD_BACKUP_VERIFY_CRON,
      expression: VERIFY_CHECK_EXPRESSION,
      start: backup.enabled && backup.target !== 'off' && backup.verifyWeekly,
    });
  }

  /**
   * The schedule's tick: queue a backup run, owned by the first administrator so it shows in their
   * Activity. An operation already queued or running is never duplicated: the run is created under
   * `DatabaseLock.FrameleafCloudBackup` only when no backup operation or restore is unfinished.
   */
  @OnJob({ name: JobName.CloudBackupSchedule, queue: QueueName.BackgroundTask })
  async handleSchedule(): Promise<JobStatus> {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    const { frameleafCloud } = await this.readSettings();
    const settings = frameleafCloud.cloudBackup;
    if (!metadata || !settings.enabled || settings.target === 'off') {
      return JobStatus.Skipped;
    }
    const owner = await this.userRepository.getAdmin();
    if (!owner) {
      return JobStatus.Skipped;
    }
    const created = await this.createOperation(owner.id, metadata, 'backup', { scheduled: true });
    if (!created.created) {
      if (created.activeTask !== 'backup') {
        // a check, a clean-up or a restore holds the bucket: the run starts as soon as it has finished
        await this.updateMetadata((current) => ({ ...current, scheduledRunDueAt: new Date().toISOString() }));
        this.logger.log('Scheduled cloud backup waits for the cloud backup operation in progress');
        return JobStatus.Success;
      }
      this.logger.log('Scheduled cloud backup skipped: a backup run is still unfinished');
      return JobStatus.Skipped;
    }
    await this.clearScheduledRunDue();
    return JobStatus.Success;
  }

  /**
   * FL-164: a scheduled run that found the bucket busy starts once the operation holding it has ended,
   * whichever way it ended.
   */
  private async startDueScheduledRun() {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (!metadata?.scheduledRunDueAt) {
      return;
    }
    const { frameleafCloud } = await this.readSettings();
    const owner = await this.userRepository.getAdmin();
    if (!owner || !frameleafCloud.cloudBackup.enabled || frameleafCloud.cloudBackup.target === 'off') {
      await this.clearScheduledRunDue();
      return;
    }
    // The operation that held the bucket may only have paused, waited or be retrying: then it still holds
    // it and the run stays due for the next ending. A backup run holding it is the run that was due.
    const created = await this.createOperation(owner.id, metadata, 'backup', { scheduled: true });
    if (created.created || created.activeTask === 'backup') {
      await this.clearScheduledRunDue();
    }
  }

  private async clearScheduledRunDue() {
    await this.updateMetadata(({ scheduledRunDueAt: _due, ...current }) => current);
  }

  /** FL-164: whether the scheduled backup starts within the next hour, when a check would hold it up. */
  private backupStartsSoon(cronExpression: string, now: Date) {
    try {
      const next = new CronTime(cronExpression).sendAt().toMillis();
      return next - now.getTime() < VERIFY_QUIET_MS;
    } catch {
      return false;
    }
  }

  /**
   * The hourly verification check: the monthly full pass when a month has gone by since the last one,
   * else the weekly sample when a week has. It waits while anything else holds the bucket.
   */
  @OnJob({ name: JobName.CloudBackupVerify, queue: QueueName.BackgroundTask })
  async handleVerifyCheck(): Promise<JobStatus> {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    const { frameleafCloud } = await this.readSettings();
    const settings = frameleafCloud.cloudBackup;
    if (!metadata || !settings.enabled || settings.target === 'off') {
      return JobStatus.Skipped;
    }
    const now = new Date();
    // a check that failed waits a day before the next try, whichever kind it was
    const lastVerify = metadata.lastVerify;
    if (lastVerify?.status === 'failed' && now.getTime() - Date.parse(lastVerify.at) < VERIFY_FAILED_BACKOFF_MS) {
      return JobStatus.Skipped;
    }
    // and none starts in the hour before the scheduled backup, which it would hold up
    if (this.backupStartsSoon(settings.schedule.cronExpression, now)) {
      return JobStatus.Skipped;
    }
    const depth = verificationDue(
      {
        verifyWeekly: settings.verifyWeekly,
        lastFullAt: metadata.lastFullVerifyAt,
        lastSampleAt: lastVerify?.status === 'failed' ? null : lastVerify?.at,
      },
      now,
    );
    const owner = depth ? await this.userRepository.getAdmin() : undefined;
    if (!depth || !owner) {
      return JobStatus.Skipped;
    }
    const created = await this.createOperation(owner.id, metadata, 'verify', { depth, scheduled: true });
    return created.created ? JobStatus.Success : JobStatus.Skipped;
  }

  /**
   * Create a `cloud_backup` operation, unless a backup operation or a restore is unfinished. Answers which
   * kind holds the bucket when it was not created.
   */
  private async createOperation(
    ownerId: string,
    metadata: FrameleafCloudBackup,
    task: BackupTask,
    options: { scheduled?: boolean; depth?: 'sample' | 'full'; dryRun?: boolean },
  ): Promise<{ created: true } | { created: false; activeTask: BackupTask | 'restore' }> {
    const label = task === 'prune' && options.dryRun ? `${TASK_LABEL.prune} preview` : TASK_LABEL[task];
    const result =
      task === 'backup'
        ? emptyRunResult()
        : task === 'verify'
          ? emptyVerifyResult(options.depth ?? 'sample', new Date())
          : emptyPruneResult(!!options.dryRun);
    const outcome = await this.operations.createExclusive(
      {
        ownerId,
        kind: KIND,
        // Done by this server's own workers, straight against the claimed bucket.
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label,
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: {
          version: 1,
          bucketRef: metadata.bucketRef,
          keyFingerprint: metadata.keyFingerprint,
          task,
          scheduled: !!options.scheduled,
          ...(options.depth && { depth: options.depth }),
          ...(task === 'prune' && { dryRun: !!options.dryRun }),
        },
        settings: { bucket: metadata.bucket },
        estimate: null,
        result: result as unknown as Record<string, unknown>,
        totalUnits: null,
      },
      DatabaseLock.FrameleafCloudBackup,
      { alsoKinds: [RESTORE_KIND] },
    );
    if ('created' in outcome) {
      return { created: true };
    }
    const active = await this.operations.getOfKind(outcome.active.id, KIND);
    return { created: false, activeTask: active ? taskOf(active) : 'restore' };
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
        kinds: BUCKET_KINDS,
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
    return withOperationExecution(
      {
        renew: () =>
          this.operations.heartbeat(operation.id, claimToken, CLOUD_BACKUP_LEASE_MS, { requireActiveClaim: true }),
        stopped: () => this.stopping,
      },
      () => this.runClaim(operation, claimToken),
    );
  }

  private async runClaim(operation: MediaOperation, claimToken: string): Promise<void> {
    if (operation.kind === RESTORE_KIND) {
      await this.runRestore(operation, claimToken);
    } else {
      switch (taskOf(operation)) {
        case 'verify': {
          await this.runVerify(operation, claimToken);
          break;
        }
        case 'prune': {
          await this.runPrune(operation, claimToken);
          break;
        }
        case 'backup': {
          await this.runBackup(operation, claimToken);
          break;
        }
      }
    }
    if (operation.kind === RESTORE_KIND || taskOf(operation) !== 'backup') {
      await this.startDueScheduledRun().catch((error: unknown) =>
        this.logger.warn(`Could not start the scheduled cloud backup: ${errorMessage(error)}`),
      );
    }
  }

  private async runBackup(operation: MediaOperation, claimToken: string): Promise<void> {
    const progress = { result: parseRunResult(operation.result) };
    try {
      await this.process(operation, claimToken, progress);
    } catch (error) {
      if (await settleOperationStop(this.operations, operation, claimToken)) return;
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
          job: { id: operation.id, type: 'cloud-backup-run', actions: ['retry'] },
        });
      }
    }
  }

  /**
   * One claim of a run, from wherever its result says it got to. Every step is safe to do twice: an
   * object already in the bucket is skipped, an upload is repeated whole, and a manifest file recorded
   * twice is replaced.
   */
  private async process(operation: MediaOperation, claimToken: string, progress: { result: CloudBackupRunResult }) {
    const { id } = operation;
    const opened = await this.openBucket(operation, claimToken, () =>
      this.recordRun(operation, progress.result, 'waiting-for-key'),
    );
    if (!opened) {
      return;
    }
    const { metadata, settings, connection, bucketKey } = opened;
    if (opened.readOnly) {
      // Nothing is uploaded and nothing on this server is touched; restores keep working.
      throw new Error(
        `Frameleaf-managed storage is read-only for this server${readOnlyReason(metadata)}, so backups are paused. Your library is untouched and restores keep working.`,
      );
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

  /**
   * FL-164: open the claimed bucket for one operation: the claim and the key checked, the connection made
   * (for Frameleaf-managed storage, with a key rotated for this operation only) and the bucket's claim read
   * again. Answers null when the operation was handed back to wait (an own-memory key not loaded here, or
   * managed storage asking to wait); `waiting` records why, for a backup run.
   */
  private async openBucket(
    operation: MediaOperation,
    claimToken: string,
    waiting: () => Promise<void>,
  ): Promise<OpenedBucket | null> {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    const snapshot = operation.snapshot as { bucketRef?: string; keyFingerprint?: string };
    if (!metadata || metadata.bucketRef !== snapshot.bucketRef || metadata.keyFingerprint !== snapshot.keyFingerprint) {
      throw new Error('The backup bucket changed since this was queued. Start again.');
    }
    const { frameleafCloud } = await this.readSettings();
    const settings = frameleafCloud.cloudBackup;
    // turning cloud backup off stops runs, checks and clean-ups; the bucket stays readable for a restore
    if (operation.kind === KIND && (!settings.enabled || settings.target === 'off')) {
      throw new Error('Cloud backup is off.');
    }

    const bucketKey = await this.loadKey(metadata);
    if (!bucketKey) {
      if (metadata.keyMode !== 'own-memory') {
        throw new Error(
          'The backup key file is missing from this server. Restore it from the key file or recovery kit.',
        );
      }
      // Own-memory key not loaded here: ask the other workers, and wait without failing.
      this.websocketRepository.serverSend('CloudBackupKeyRequest');
      await waiting();
      this.notify({
        level: NotificationLevel.Warning,
        title: 'Cloud backup is waiting for its key',
        description: 'This server does not keep the backup key. Load it in Settings › Frameleaf Cloud › Cloud backup.',
        dedupeKey: 'cloud-backup:key-locked',
        dedupeDays: 1,
        job: { id: operation.id, type: 'cloud-backup-run', actions: ['pause', 'cancel'] },
      });
      await this.operations.requeue(operation.id, claimToken, {
        delayMs: CLOUD_BACKUP_KEY_WAIT_MS,
        returnAttempt: true,
      });
      return null;
    }

    let connection: CloudBackupConnection;
    let readOnly = false;
    let current = metadata;
    if (metadata.target === 'managed') {
      const opened = await this.openManaged(metadata, operation, claimToken);
      if (!opened) {
        return null;
      }
      connection = opened.connection;
      readOnly = opened.managed.readOnly;
      // FL-301: the grant just issued decides the read-only state and its wording, not the one last saved
      current = { ...metadata, managed: opened.managed };
    } else {
      connection = this.ownBucketConnection(metadata, settings);
    }

    // The claim is read again on every operation: a bucket another server claimed since, or one emptied or
    // recreated (its index would no longer match it), is refused rather than used.
    const marker = await this.store.readMarker(connection, bucketKey);
    if (marker.instanceId !== metadata.instanceId) {
      throw new Error('This bucket is now claimed by another Frameleaf server. Set up cloud backup again.');
    }
    return { bucketRef: metadata.bucketRef, metadata: current, settings, connection, bucketKey, readOnly };
  }

  /** Your own bucket, as the settings name it; it must still be the bucket this server claimed. */
  private ownBucketConnection(
    metadata: FrameleafCloudBackup,
    settings: SystemConfig['frameleafCloud']['cloudBackup'],
  ): CloudBackupConnection {
    if (settings.target !== 'byo-s3') {
      throw new Error('The bucket in the settings is not the one this server claimed. Set up cloud backup again.');
    }
    if (bucketRef(settings.s3.endpoint, settings.s3.bucket) !== metadata.bucketRef) {
      throw new Error('The bucket in the settings is not the one this server claimed. Set up cloud backup again.');
    }
    if (!settings.s3.secretAccessKey) {
      throw new Error('The bucket’s secret access key is not stored on this server.');
    }
    return {
      endpoint: settings.s3.endpoint,
      region: signingRegion(settings.s3.endpoint, settings.s3.region),
      bucket: settings.s3.bucket,
      accessKeyId: settings.s3.accessKeyId,
      secretAccessKey: settings.s3.secretAccessKey,
    };
  }

  /**
   * FL-164: Frameleaf-managed storage for one operation: a key rotated now and kept in memory for this
   * operation only. A refusal Frameleaf Cloud asks to wait out (a rate limit, a region without storage, an
   * unreachable cloud, an unlinked server) hands the operation back to wait; any other stops it with its
   * reason, and a suspected copy of this server also tells the administrators.
   */
  private async openManaged(
    metadata: FrameleafCloudBackup,
    operation: MediaOperation,
    claimToken: string,
  ): Promise<{ connection: CloudBackupConnection; managed: FrameleafCloudBackupManaged } | null> {
    let grant: BackupGrantResponse;
    try {
      // under the bucket lock, so a request reading the bucket never has its key revoked mid-read
      grant = await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudBackup, async () =>
        this.cloudBackup.rotate(await this.managedApi()),
      );
    } catch (error) {
      const refusal = this.refusalOf(error);
      await this.updateMetadata((current) => ({
        ...current,
        managed: {
          readOnly: current.managed?.readOnly ?? false,
          readOnlyReason: current.managed?.readOnlyReason ?? null,
          quotaBytes: current.managed?.quotaBytes ?? 0,
          ...current.managed,
          checkedAt: new Date().toISOString(),
          refusal: refusal.message,
        },
      }));
      if (refusal.cloneSuspected) {
        this.notify({ ...CLONE_SUSPECTED_NOTICE, type: NotificationType.SystemMessage });
      }
      if (refusal.retryAfterMs === null) {
        throw new Error(refusal.message, { cause: error });
      }
      this.logger.warn(`Cloud backup operation ${operation.id} waits for managed storage: ${refusal.message}`);
      await this.operations.requeue(operation.id, claimToken, { delayMs: refusal.retryAfterMs, returnAttempt: true });
      return null;
    }
    const connection = this.managedConnection(grant, metadata);
    const problem = backupGrantProblem(grant);
    if (problem) {
      throw new Error(problem);
    }
    const managedOf = (current: FrameleafCloudBackup): FrameleafCloudBackupManaged => ({
      ...current.managed,
      ...(current.managed?.storageId && { storageId: grant.storageId }),
      location: grant.location,
      readOnly: grant.readOnly,
      readOnlyReason: grant.readOnly ? (grant.readOnlyReason ?? current.managed?.readOnlyReason ?? null) : null,
      quotaBytes: grant.quotaBytes,
      checkedAt: new Date().toISOString(),
      refusal: undefined,
    });
    let managed = managedOf(metadata);
    await this.updateMetadata((current) => {
      managed = managedOf(current);
      return { ...current, managed };
    });
    return { connection, managed };
  }

  /** The connection a managed grant's key opens, waited on for a few seconds while the new key goes live. */
  private managedConnection(grant: BackupGrantResponse, metadata?: FrameleafCloudBackup): CloudBackupConnection {
    if (metadata) {
      const sameIdentity = metadata.managed?.storageId
        ? grant.storageId === metadata.managed.storageId &&
          managedStorageRef(grant.storageId) === metadata.bucketRef &&
          grant.location.locationId === metadata.managed.location?.locationId
        : // Legacy claims keep their address-based index, but still require the recorded bucket and region below.
          metadata.bucketRef.startsWith('https://') && metadata.bucketRef.endsWith(`/${metadata.bucket}`);
      const sameLocation =
        !metadata.managed?.location || grant.location.locationId === metadata.managed.location.locationId;
      if (!sameIdentity || !sameLocation || grant.bucket !== metadata.bucket || grant.region !== metadata.region) {
        throw new Error(
          'Frameleaf Cloud offered a different storage binding than the one this server claimed. Set up cloud backup again.',
        );
      }
    }
    return {
      endpoint: grant.endpoint.replace(/\/+$/, ''),
      region: grant.region,
      bucket: grant.bucket,
      accessKeyId: grant.credentials.accessKeyId,
      secretAccessKey: grant.credentials.secretAccessKey,
      freshKeyUntil: Date.now() + CLOUD_BACKUP_FRESH_KEY_MS,
    };
  }

  /**
   * FL-164: Frameleaf Cloud's API and an instance token for it, for the backup routes. Refused without a
   * link, and while Frameleaf Cloud suspects a copy of this server (a check-in said so): backup storage is
   * not asked for at all until that is resolved.
   */
  private async managedApi(): Promise<ManagedBackupApi> {
    const { cloudUrl, link, linked } = await readCloudLink(this.gatewayDeps());
    if (!cloudUrl || !linked || !link?.instanceId) {
      throw new ManagedStorageRefusal(
        'This server is not linked to Frameleaf Cloud, so managed backups are paused until it is linked again.',
        MANAGED_UNLINKED_RETRY_MS,
      );
    }
    if (link.heartbeat?.cloneSuspected) {
      throw new ManagedStorageRefusal(managedBackupRefusal(cloneSuspectedError()).message, null, true);
    }
    const document = await this.frameleafCloudRepository.discovery(cloudUrl);
    await loadInstanceIdentity(this.gatewayDeps());
    const token = await this.frameleafCloudRepository.accessToken(
      document,
      link.instanceId,
      document.api,
      this.instanceIdentityRepository.currentSigner(),
    );
    return { api: document.api, token };
  }

  /** What a refusal of managed storage means, and how long to wait before asking again (null: don't). */
  private refusalOf(error: unknown): { message: string; retryAfterMs: number | null; cloneSuspected: boolean } {
    if (error instanceof ManagedStorageRefusal) {
      return { message: error.message, retryAfterMs: error.retryAfterMs, cloneSuspected: error.cloneSuspected };
    }
    if (!(error instanceof FrameleafCloudError)) {
      throw error;
    }
    const refusal = managedBackupRefusal(error);
    const retryAfterMs = refusal.retry
      ? Math.max(60_000, (refusal.retryAfterSeconds ?? MANAGED_RETRY_MS / 1000) * 1000)
      : null;
    return { message: refusal.message, retryAfterMs, cloneSuspected: refusal.cloneSuspected };
  }

  /** FL-164: tell Frameleaf Cloud the key mode and whether a schedule is on; a failure never stops the caller. */
  private async reportAgentSettings(keyMode: CloudBackupKeyMode, scheduleEnabled: boolean) {
    const { linked } = await readCloudLink(this.gatewayDeps());
    if (!linked) {
      return;
    }
    try {
      await this.cloudBackup.putSettings(await this.managedApi(), { keyMode, scheduleEnabled });
    } catch (error) {
      this.logger.warn(`Could not tell Frameleaf Cloud about the cloud backup settings: ${errorMessage(error)}`);
    }
  }

  /** FL-164: a managed run's telemetry (counts, bytes, times), never a path; a failure is only logged. */
  private async reportManagedRun(
    operation: MediaOperation,
    result: CloudBackupRunResult,
    status: 'succeeded' | 'failed' | 'cancelled',
  ) {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (metadata?.target !== 'managed') {
      return;
    }
    try {
      await this.cloudBackup.reportRun(await this.managedApi(), {
        runId: operation.id,
        status,
        startedAt: asIso(operation.createdAt) ?? new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        bytesUploaded: result.bytesUploaded,
        objectsUploaded: result.uploaded,
        objectsSkipped: result.skipped,
        // the contract takes `m/<extended ISO>.json.gz`; this server names manifests in the basic format
        manifestKey: null,
        errorCode: status === 'failed' ? 'cloud_backup_failed' : null,
      });
    } catch (error) {
      this.logger.warn(`Could not report the cloud backup run to Frameleaf Cloud: ${errorMessage(error)}`);
    }
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

  /**
   * The database first: a fresh dump to `db/<file>`. FL-164: old dumps are removed only by the clean-up,
   * which reads the kept manifests in the bucket itself, never by a run from this server's index.
   */
  private async backUpDatabase(run: Run): Promise<boolean> {
    await this.removeLeftoverDumps();
    const path = await this.databaseBackup.createDatabaseBackup(CLOUD_BACKUP_DUMP_PREFIX, {
      signal: executionSignal(),
      progress: advanceExecutionProgress,
    });
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
    for (const name of names) {
      if (isCloudBackupDumpName(name)) {
        await this.storageRepository.unlink(join(folder, name));
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
    await this.adoptManifests(run);
    run.progress.result = { ...run.progress.result, phase: 'assets', total: await this.index.countAssets() };
    return this.checkpoint(run);
  }

  /**
   * FL-164: every manifest in the bucket that this server has no record of (a bucket claimed again, or a
   * database restored from before later runs) is read and recorded as a kept backup, so it can be listed
   * and restored from. A manifest that cannot be read is left out and logged; the clean-up still keeps it.
   */
  private async adoptManifests(run: Run) {
    const listed: string[] = [];
    await this.store.listAll(run.connection, CLOUD_BACKUP_MANIFEST_PREFIX, (objects) => {
      listed.push(...objects.map(({ key }) => key).filter((key) => manifestTime(key)));
      return Promise.resolve();
    });
    const known = await this.index.getManifestKeys(run.metadata.bucketRef, listed);
    const adopted = [];
    for (const key of listed) {
      if (known.has(key) || key === run.progress.result.manifestKey) {
        continue;
      }
      try {
        const manifest = readManifest(await this.store.get(run.connection, key, run.bucketKey));
        const files = [
          ...Object.values(manifest.assets).flatMap((asset) => asset.files),
          ...Object.values(manifest.profiles),
        ];
        adopted.push({
          key,
          createdAt: manifestTime(key)!,
          databaseKey: manifest.database?.key ?? null,
          assetCount: Object.keys(manifest.assets).length,
          fileCount: files.length,
          bytes: files.reduce((total, file) => total + file.size, 0),
        });
      } catch (error) {
        this.logger.warn(`Cloud backup run ${run.id}: manifest ${key} could not be read: ${errorMessage(error)}`);
      }
    }
    if (adopted.length > 0) {
      await this.index.adoptManifests(run.metadata.bucketRef, adopted);
      this.logger.log(`Cloud backup run ${run.id}: recorded ${adopted.length} earlier backups found in the bucket`);
    }
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
        { signal: executionSignal() },
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
      version: CLOUD_BACKUP_MANIFEST_VERSION,
      instanceId: run.metadata.instanceId,
      createdAt: new Date().toISOString(),
      database: run.progress.result.database,
    };
    yield `${JSON.stringify(header).slice(0, -1)},"assets":{`;

    const profiles: string[] = [];
    type ManifestAsset = { id: string; owner: string | null; files: CloudBackupManifestFile[] };
    // held in an object: the asset in hand changes inside the loop, which narrowing a local cannot follow
    const pending: { asset: ManifestAsset | null } = { asset: null };
    // manifest v2 (FL-164): each item's record and details, read a page at a time, and the albums and
    // people they name, listed once at the end
    const details = new Map<string, { record: CloudBackupAssetRecord; details: CloudBackupAssetDetails }>();
    const albumIds = new Set<string>();
    const people = new Map<string, { ownerId: string; personId: string }>();
    const assetJson = (current: ManifestAsset) => {
      const known = details.get(current.id);
      details.delete(current.id);
      if (known) {
        for (const album of known.details.albums) {
          albumIds.add(album.id);
        }
        for (const face of known.details.faces) {
          if (face.personId && current.owner) {
            people.set(`${current.owner}:${face.personId}`, { ownerId: current.owner, personId: face.personId });
          }
        }
      }
      const body = JSON.stringify({
        owner: current.owner,
        files: current.files,
        ...(known && { ...known.record, details: known.details }),
      });
      const text = `${counts.assets > 0 ? ',' : ''}${JSON.stringify(current.id)}:${body}`;
      counts.assets += 1;
      return text;
    };

    let after: string | null = null;
    let more = true;
    while (more) {
      const page = await this.index.getEntriesPage(manifestId, after, CLOUD_BACKUP_MANIFEST_PAGE);
      const unread = [
        ...new Set(page.map(({ assetId }) => assetId).filter((id): id is string => !!id && !details.has(id))),
      ];
      for (const [id, found] of await this.index.getAssetDetails(unread)) {
        details.set(id, found);
      }
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
    const albums = await this.index.getAlbumRecords([...albumIds]);
    const persons = await this.index.getPersonRecords(people.values().toArray());
    yield `},"profiles":{${profiles.join(',')}},"albums":${JSON.stringify(Object.fromEntries(albums))},"people":${JSON.stringify(Object.fromEntries(persons))}}`;
  }

  private async finish(run: Run) {
    assertExecutionActive();
    const { id, claimToken, operation } = run;
    const { result } = run.progress;
    // The manifest is in the bucket and the `done` checkpoint saved: its recorded files can go now.
    if (result.manifestId) {
      await this.index.deleteEntries(result.manifestId);
    }
    // The manifest is in the bucket: the backup is complete, even when a cancel arrived after it.
    const finishedAt = new Date().toISOString();
    const firstBackup = !run.metadata.lastSuccessAt;
    await this.recordRun(operation, result, 'completed');
    await this.updateMetadata((current) => ({
      ...current,
      lastSuccessAt: finishedAt,
      lastManifestKey: result.manifestKey ?? current.lastManifestKey,
    }));
    const completed =
      (await this.operations.beginValidation(id, claimToken, true)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }, undefined, true));
    if (!completed) {
      // Cancelled after the manifest was written: the backup stands as recorded; settle the cancel.
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    }
    this.logger.log(
      `Cloud backup run ${id} finished: ${result.uploaded} uploaded, ${result.skipped} already backed up, ${result.missing} missing`,
    );
    if (firstBackup) {
      await this.announceActivation({ completed: true });
    }
    await this.reportManagedRun(operation, result, 'succeeded');
    // FL-164: a scheduled run is followed by the clean-up of runs past retention, once it has finished
    if ((operation.snapshot as { scheduled?: boolean }).scheduled) {
      await this.createOperation(operation.ownerId, run.metadata, 'prune', { scheduled: true, dryRun: false });
    }
  }

  /** Write the cursor and counts; answer whether to carry on (no on a lost claim, a cancel or a pause). */
  private async checkpoint(run: Run): Promise<boolean> {
    assertExecutionActive();
    const { id, claimToken, operation } = run;
    const { result } = run.progress;
    reportExecutionProgress('assets', result.assets);
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
      await this.reportManagedRun(operation, result, 'cancelled');
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
    const finished = (['completed', 'failed', 'cancelled'] as FrameleafCloudBackupRun['status'][]).includes(status);
    const before = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    // FL-228: a first backup that starts or fails moves the activation chain; a claim resumed is no news
    const changed = before?.lastRun?.operationId !== operation.id || before.lastRun.status !== status;
    const announce = changed && !before?.lastSuccessAt && (status === 'running' || status === 'failed');
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
    if (announce) {
      await this.announceActivation();
    }
  }

  /* ------------------------------------------------------------------ */
  /* FL-164: verification, clean-up and restore                          */
  /* ------------------------------------------------------------------ */

  /**
   * A checkpoint for a verification, a clean-up or a restore: the result and counts written, then whether
   * to carry on. A cancel is settled here; a pause hands the operation back, to carry on from its cursor.
   */
  private async checkpointTask(
    operation: MediaOperation,
    claimToken: string,
    result: object,
    units: { processed: number; total: number; progress: number },
  ): Promise<TaskCheckpoint> {
    assertExecutionActive();
    const written = await this.operations.setBulkResult(operation.id, claimToken, {
      result: result as Record<string, unknown>,
      processedUnits: units.processed,
      totalUnits: units.total,
      progress: Math.min(100, Math.max(0, Math.floor(units.progress))),
      leaseMs: CLOUD_BACKUP_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Cloud backup operation ${operation.id}: claim lost, stopping`);
      return 'stopped';
    }
    reportExecutionProgress(`task:${taskOf(operation)}`, units.processed);
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false });
      this.logger.log(`Cloud backup operation ${operation.id} cancelled`);
      return 'cancelled';
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(operation.id, claimToken))) {
      this.logger.log(`Cloud backup operation ${operation.id} paused`);
      return 'stopped';
    }
    return 'continue';
  }

  /** Mark a verification, a clean-up or a restore running; answers false when it was cancelled meanwhile. */
  private async startTask(operation: MediaOperation, claimToken: string): Promise<boolean> {
    const running = await this.operations.reportProgress(operation.id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: Number(operation.processedUnits ?? 0),
      totalUnits: operation.totalUnits === null ? null : Number(operation.totalUnits),
      progress: Number(operation.progress ?? 0),
    });
    if (!running) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false });
    }
    return !!running;
  }

  /** Complete an operation whose work is done; a cancel that arrived at the very end is settled instead. */
  private async completeTask(operation: MediaOperation, claimToken: string): Promise<boolean> {
    const completed =
      (await this.operations.beginValidation(operation.id, claimToken, true)) &&
      (await this.operations.complete(operation.id, claimToken, { resultAssetId: null }, undefined, true));
    if (!completed) {
      await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false });
    }
    return completed;
  }

  /** A verification, a clean-up or a restore failed: after its automatic retry, the administrators hear why. */
  private async failTask(operation: MediaOperation, claimToken: string, error: unknown, what: string) {
    if (await settleOperationStop(this.operations, operation, claimToken)) return false;
    // a file system error names its path: shown to administrators, it names it below the media folder only
    const diagnostic = maskMediaPath(errorMessage(error));
    this.logger.error(`${what} ${operation.id} failed: ${diagnostic}`);
    const message =
      operation.kind === RESTORE_KIND && (operation.snapshot as CloudBackupRestoreSnapshot).owner
        ? 'The owner backup restore stopped. Already restored work is retained; check access and backup availability.'
        : diagnostic;
    const outcome = await this.operations.fail(operation.id, claimToken, {
      error: message,
      errorCode: operation.kind === RESTORE_KIND ? 'cloud_restore_failed' : `cloud_backup_${taskOf(operation)}_failed`,
    });
    if (outcome === 'failed') {
      this.notify({
        level: NotificationLevel.Error,
        title: `${what} failed`,
        description: message,
        dedupeKey: `cloud-backup:${operation.kind === RESTORE_KIND ? 'restore' : taskOf(operation)}-failed`,
        dedupeDays: 1,
        // named so a device can open it; a verification, clean-up or restore is started again from settings
        job: { id: operation.id, type: 'cloud-backup-run', actions: [] },
      });
    }
    return outcome === 'failed';
  }

  private async runVerify(operation: MediaOperation, claimToken: string): Promise<void> {
    const snapshot = operation.snapshot as { depth?: 'sample' | 'full' };
    const depth = snapshot.depth === 'full' ? 'full' : 'sample';
    const stored = operation.result as Partial<CloudBackupVerifyResult> | null;
    const fresh = emptyVerifyResult(depth, new Date());
    const start: CloudBackupVerifyResult = stored?.task === 'verify' ? { ...fresh, ...stored } : fresh;
    try {
      const opened = await this.openBucket(operation, claimToken, () => Promise.resolve());
      if (!opened || !(await this.startTask(operation, claimToken))) {
        return;
      }
      const result = await this.maintenance.verify(
        opened,
        start,
        async (current) =>
          (await this.checkpointTask(operation, claimToken, current, {
            processed: current.checked,
            total: current.total,
            progress: current.total > 0 ? (current.checked / current.total) * 100 : 0,
          })) === 'continue',
        { operationId: operation.id, claimToken },
      );
      if (!result) {
        return;
      }
      const final = await this.checkpointTask(operation, claimToken, result, {
        processed: result.checked,
        total: result.total,
        progress: 100,
      });
      if (final !== 'continue') {
        return;
      }
      const at = new Date().toISOString();
      const degraded = result.missing + result.mismatched > 0;
      await this.updateMetadata((current) => ({
        ...current,
        lastVerify: {
          operationId: operation.id,
          depth,
          at,
          status: degraded ? 'degraded' : 'passed',
          checked: result.checked,
          missing: result.missing,
          mismatched: result.mismatched,
          degradedManifests: result.degradedManifests,
        },
        ...(depth === 'full' && { lastFullVerifyAt: at }),
      }));
      await this.completeTask(operation, claimToken);
      this.logger.log(
        `Cloud backup check ${operation.id} (${depth}): ${result.checked} checked, ${result.missing} missing, ${result.mismatched} damaged`,
      );
      if (degraded) {
        this.notify({
          level: NotificationLevel.Warning,
          title: 'Cloud backup check found problems',
          description: [
            `${result.missing} backed-up files are missing and ${result.mismatched} are damaged.`,
            'The next backup uploads them again from this server;',
            `${result.degradedManifests} earlier backups are marked incomplete.`,
          ].join(' '),
          dedupeKey: `cloud-backup:verify:${operation.id}`,
          dedupeDays: 7,
        });
      }
    } catch (error) {
      if (await this.failTask(operation, claimToken, error, 'Cloud backup check')) {
        await this.updateMetadata((current) => ({
          ...current,
          lastVerify: {
            operationId: operation.id,
            depth,
            at: new Date().toISOString(),
            status: 'failed',
            checked: start.checked,
            missing: start.missing,
            mismatched: start.mismatched,
            degradedManifests: start.degradedManifests,
            error: errorMessage(error),
          },
        }));
      }
    }
  }

  private async runPrune(operation: MediaOperation, claimToken: string): Promise<void> {
    const snapshot = operation.snapshot as { dryRun?: boolean };
    const dryRun = snapshot.dryRun !== false;
    try {
      const opened = await this.openBucket(operation, claimToken, () => Promise.resolve());
      if (!opened) {
        return;
      }
      if (opened.readOnly && !dryRun) {
        throw new Error(
          `Frameleaf-managed storage is read-only for this server${readOnlyReason(opened.metadata)}, so nothing can be cleaned up.`,
        );
      }
      if (!(await this.startTask(operation, claimToken))) {
        return;
      }
      const result = await this.maintenance.prune(
        opened,
        opened.settings.retention,
        dryRun,
        async (current) =>
          (await this.checkpointTask(operation, claimToken, current, {
            processed: current.deleted,
            total: current.objectsRemoved,
            progress: current.objectsRemoved > 0 ? (current.deleted / current.objectsRemoved) * 100 : 0,
          })) === 'continue',
      );
      if (!result) {
        return;
      }
      // a dry run that was cancelled or paused at its end records nothing, so it never unlocks a clean-up
      const final = await this.checkpointTask(operation, claimToken, result, {
        processed: result.deleted,
        total: result.objectsRemoved,
        progress: 100,
      });
      if (final !== 'continue') {
        return;
      }
      await this.updateMetadata((current) => ({
        ...current,
        lastPrune: {
          operationId: operation.id,
          dryRun,
          at: new Date().toISOString(),
          manifestsKept: result.manifestsKept,
          manifestsRemoved: result.manifestsRemoved,
          objectsRemoved: result.objectsRemoved,
          bytesRemoved: result.bytesRemoved,
          dumpsRemoved: result.dumpsRemoved,
        },
      }));
      await this.completeTask(operation, claimToken);
    } catch (error) {
      await this.failTask(operation, claimToken, error, 'Cloud backup clean-up');
    }
  }

  private async runRestore(operation: MediaOperation, claimToken: string): Promise<void> {
    const snapshot = operation.snapshot as CloudBackupRestoreSnapshot;
    const stored = operation.result as Partial<CloudBackupRestoreResult> | null;
    let result: CloudBackupRestoreResult =
      stored?.task === 'restore' ? { ...emptyRestoreResult(), ...stored } : emptyRestoreResult();
    let stop: TaskCheckpoint = 'continue';
    try {
      const opened = await this.openBucket(operation, claimToken, () => Promise.resolve());
      if (!opened || !(await this.startTask(operation, claimToken))) {
        return;
      }
      const manifest = readManifest(await this.store.get(opened.connection, snapshot.manifestKey, opened.bucketKey));
      if (snapshot.owner) {
        const { auth } = await this.index.getOwnerRestoreAuth(snapshot.owner);
        await this.checkOwnerRestoreItems(auth, manifest, snapshot, true);
      }
      const inPlace = IN_PLACE_SCOPES.has(snapshot.scope);
      const library = inPlace
        ? await this.libraryState(snapshot.assetIds ?? Object.keys(manifest.assets))
        : new Map<string, CloudBackupLibraryAsset>();
      const currentOriginals = new Map(
        [...library].filter(([, asset]) => !asset.isExternal).map(([id, asset]) => [id, asset.originalPath]),
      );
      const mediaLocation = StorageCore.getMediaLocation();
      const plan = restorePlan({
        manifest,
        scope: snapshot.scope,
        assetIds: snapshot.assetIds,
        operationId: operation.id,
        mediaLocation,
        currentOriginals,
      });
      if (snapshot.owner) {
        plan.files = plan.files.filter((file) => file.role === 'original' || file.role === 'sidecar');
        if (plan.files.some((file) => !file.inPlace)) throw new Error('Owner restore destination unavailable');
      }
      if (snapshot.assetIds && plan.files.length === 0 && snapshot.scope !== 'album') {
        throw new Error('This backup does not hold the chosen items.');
      }
      const done = await this.restorer.restore({
        bucket: opened,
        manifest,
        scope: snapshot.scope,
        files: plan.files,
        destination: plan.destination,
        mediaLocation,
        backupsFolder: StorageCore.getBaseFolder(StorageFolder.Backups),
        operationId: operation.id,
        start: result,
        checkpoint: async (current) => {
          result = current;
          stop = await this.checkpointTask(operation, claimToken, current, restoreUnits(current));
          return stop === 'continue';
        },
        ...(snapshot.owner && {
          publish: (
            file: CloudBackupRestoreFile,
            _staged: string,
            publish: () => Promise<'written' | 'skipped' | 'replaced'>,
          ) => this.withOwnerRestoreFile(operation, claimToken, manifest, snapshot, file, publish),
        }),
        library: (current) =>
          snapshot.owner
            ? this.restoreOwnerLibrary(operation, claimToken, manifest, snapshot, plan.files, current)
            : this.restoreLibrary(manifest, snapshot, plan.files, library, current),
      });
      if (done) {
        result = done;
        stop = await this.checkpointTask(operation, claimToken, done, { ...restoreUnits(done), progress: 100 });
      }
      if (!done || stop !== 'continue') {
        if (stop === 'cancelled') {
          await this.recordRestore(operation, snapshot, result, 'cancelled');
        }
        return;
      }
      // what went back in place gets its thumbnails and previews again
      const regenerate = done.restoredAssetIds.filter((assetId) => library.has(assetId));
      if (regenerate.length > 0) {
        await this.jobRepository.queueAll(
          regenerate.map((assetId) => ({ name: JobName.AssetGenerateThumbnails, data: { id: assetId } })),
        );
      }
      if (snapshot.owner) {
        await this.ownerBackupClaim();
        for (const id of snapshot.assetIds ?? [])
          await this.index.withOwnerRestore(
            snapshot.owner,
            snapshot,
            id,
            { operationId: operation.id, claimToken },
            async (trx) => {
              const index = new CloudBackupIndexRepository(trx);
              const { auth } = await index.getOwnerRestoreAuth(snapshot.owner!);
              await this.checkOwnerRestoreItems(auth, manifest, snapshot, true, index, [id]);
            },
          );
      }
      await this.recordRestore(operation, snapshot, done, 'completed');
      await this.completeTask(operation, claimToken);
      this.logger.log(
        `Cloud backup restore ${operation.id} (${snapshot.scope}) finished: ${done.files} files, ${done.skipped} already in place, ${done.replaced} moved aside`,
      );
    } catch (error) {
      if (await this.failTask(operation, claimToken, error, 'Restore from cloud backup')) {
        const message = maskMediaPath(errorMessage(error));
        await this.recordRestore(operation, snapshot, result, 'failed', message);
      }
    }
  }

  /**
   * The library side of an `asset` or `album` restore once its files are back (manifest v2): a deleted
   * item is made again from its record with its details, an item still in the library gets its details
   * back as asked, stacks that are gone are made again, and an album is made again or gets its lost
   * members back. Running it again finds the items it made in the library and changes nothing more.
   */
  private async restoreLibrary(
    manifest: CloudBackupManifest,
    snapshot: CloudBackupRestoreSnapshot,
    files: CloudBackupRestoreFile[],
    before: Map<string, CloudBackupLibraryAsset>,
    result: CloudBackupRestoreResult,
  ): Promise<CloudBackupRestoreResult> {
    if (snapshot.scope !== 'asset' && snapshot.scope !== 'album') {
      return result;
    }
    const mode = snapshot.details ?? 'keep';
    const assetIds = snapshot.assetIds ?? [];
    // read again: a resumed restore finds the items it already made in the library
    const library = await this.libraryState(assetIds);
    const current = mode === 'keep' ? new Map() : await this.index.getAssetDetails(library.keys().toArray());
    const members: string[] = [];
    const made: Array<{ assetId: string; ownerId: string; stack: CloudBackupAssetDetails['stack'] }> = [];
    let { recreated, detailsRestored } = result;

    for (const assetId of assetIds) {
      const asset = manifest.assets[assetId];
      const inLibrary = library.get(assetId);
      if (!asset) {
        continue;
      }
      if (inLibrary) {
        members.push(assetId);
        const now = current.get(assetId);
        if (asset.details && now && before.has(assetId)) {
          const changed = await this.details.putBack({
            assetId,
            ownerId: inLibrary.ownerId,
            type: now.record.type,
            current: now.details,
            backup: asset.details,
            mode,
            people: manifest.people,
          });
          detailsRestored += changed ? 1 : 0;
        }
        continue;
      }
      const original = files.find((file) => file.assetId === assetId && file.role === 'original' && file.inPlace);
      const record = asset.type ? readRecord(asset) : null;
      if (!record || !asset.owner || !original) {
        // a backup made before items were recorded: the file is back in place, without its record
        continue;
      }
      const sidecar = files.find((file) => file.assetId === assetId && file.role === 'sidecar' && file.inPlace);
      const outcome = await this.details.recreate({
        assetId,
        ownerId: asset.owner,
        record,
        details: asset.details,
        sha256: original.sha256,
        size: original.size,
        originalPath: original.target,
        sidecarPath: sidecar?.target ?? null,
        people: manifest.people,
      });
      if (outcome.status === 'created') {
        recreated += 1;
        members.push(assetId);
        made.push({ assetId, ownerId: asset.owner, stack: asset.details?.stack ?? null });
      } else if (outcome.status === 'duplicate') {
        members.push(outcome.assetId);
      }
    }
    await this.details.restoreStacks(made);
    if (snapshot.scope === 'album' && snapshot.albumId) {
      await this.details.restoreAlbum({
        albumId: snapshot.albumId,
        album: manifest.albums[snapshot.albumId],
        memberIds: members,
      });
    }
    return { ...result, recreated, detailsRestored };
  }

  /** The library's current state of these assets (every one the library still has, trashed or not). */
  private async libraryState(assetIds: string[]) {
    const state = new Map<string, CloudBackupLibraryAsset>();
    for (let at = 0; at < assetIds.length; at += LIBRARY_STATE_BATCH) {
      for (const [id, asset] of await this.index.getLibraryState(assetIds.slice(at, at + LIBRARY_STATE_BATCH))) {
        state.set(id, asset);
      }
    }
    return state;
  }

  private async recordRestore(
    operation: MediaOperation,
    snapshot: CloudBackupRestoreSnapshot,
    result: CloudBackupRestoreResult,
    status: FrameleafCloudBackupRestore['status'],
    error?: string,
  ) {
    if (snapshot.owner) return; // Owner jobs never replace global admin restore status/history.
    await this.updateMetadata((current) => ({
      ...current,
      lastRestore: {
        operationId: operation.id,
        scope: snapshot.scope,
        manifestKey: snapshot.manifestKey,
        status,
        at: new Date().toISOString(),
        files: result.files,
        bytes: result.bytes,
        skipped: result.skipped,
        replaced: result.replaced,
        ...(result.destination && { destination: result.destination }),
        ...(result.databaseFile && { databaseFile: result.databaseFile }),
        ...(result.recreated > 0 && { recreated: result.recreated }),
        ...(result.detailsRestored > 0 && { detailsRestored: result.detailsRestored }),
        ...(error && { error }),
      },
    }));
  }

  /* ------------------------------------------------------------------ */
  /* FL-164: restore requests                                            */
  /* ------------------------------------------------------------------ */

  /** Reauthenticate normal credentials after remote work; owner projections never accept a shared link. */
  private async ownerBackupAuth(ownerId: string, refresh: () => Promise<AuthDto>): Promise<AuthDto> {
    const auth = await refresh();
    if (auth.sharedLink || auth.user.id !== ownerId) throw new ForbiddenException('Owner backup access required');
    return auth;
  }

  private async ownerBackupClaim() {
    const metadata = await this.requireClaim();
    const settings = (await this.readSettings()).frameleafCloud.cloudBackup;
    if (
      !settings.enabled ||
      settings.target === 'off' ||
      settings.target !== metadata.target ||
      (settings.target === 'byo-s3' && bucketRef(settings.s3.endpoint, settings.s3.bucket) !== metadata.bucketRef)
    )
      throw new ConflictException('Cloud backup is not configured');
    await this.requireKeyForRequest(metadata);
    return metadata;
  }

  private async ownerHistory(auth: AuthDto, dto: OwnerBackupHistoryDto, refresh: () => Promise<AuthDto>) {
    await this.ownerBackupAuth(auth.user.id, refresh);
    const metadata = await this.ownerBackupClaim();
    const manifest = await this.readManifestForRequest(metadata, dto.manifestKey);
    const ids = Object.entries(manifest.assets)
      .filter(([, item]) => item.owner === auth.user.id)
      .map(([id]) => id);
    const latest = await this.ownerBackupClaim();
    if (latest.bucketRef !== metadata.bucketRef || latest.keyFingerprint !== metadata.keyFingerprint)
      throw new ConflictException('Cloud backup changed during the request');
    if ((await this.index.listKeptManifests(metadata.bucketRef)).every((row) => row.key !== dto.manifestKey))
      throw new NotFoundException('Backup unavailable');
    const finalAuth = await this.ownerBackupAuth(auth.user.id, refresh);
    // Read current owner/lock/classification again after I/O and auth refresh, not an earlier browse snapshot.
    const finalStates = await this.index.getOwnerHistoryState(finalAuth, ids);
    return { metadata: latest, manifest, page: ownerBackupHistoryPage(finalAuth, manifest, finalStates, dto) };
  }

  async listOwnerHistory(
    auth: AuthDto,
    dto: OwnerBackupHistoryDto,
    refresh: () => Promise<AuthDto>,
  ): Promise<OwnerBackupHistoryResponseDto> {
    return (await this.ownerHistory(auth, dto, refresh)).page;
  }

  /** Discovery exposes only kept backups with a currently authorized history item, never global counts. */
  async listOwnerBackups(
    auth: AuthDto,
    page: OwnerBackupPageDto,
    refresh: () => Promise<AuthDto>,
  ): Promise<OwnerBackupsResponseDto> {
    await this.ownerBackupAuth(auth.user.id, refresh);
    const metadata = await this.ownerBackupClaim();
    const candidates: Array<{ manifestKey: string; manifest: CloudBackupManifest }> = [];
    for (const row of await this.index.listKeptManifests(metadata.bucketRef)) {
      const found = await this.ownerHistory(auth, { manifestKey: row.key, offset: 0, limit: 1 }, refresh);
      if (found.metadata.bucketRef !== metadata.bucketRef)
        throw new ConflictException('Cloud backup changed during the request');
      candidates.push({ manifestKey: row.key, manifest: found.manifest });
    }
    const finalMetadata = await this.ownerBackupClaim();
    if (finalMetadata.bucketRef !== metadata.bucketRef || finalMetadata.keyFingerprint !== metadata.keyFingerprint)
      throw new ConflictException('Cloud backup changed during the request');
    const kept = new Map((await this.index.listKeptManifests(metadata.bucketRef)).map((row) => [row.key, row]));
    const finalAuth = await this.ownerBackupAuth(auth.user.id, refresh);
    const ids = [
      ...new Set(
        candidates.flatMap(({ manifest }) =>
          Object.entries(manifest.assets)
            .filter(([, asset]) => asset.owner === auth.user.id)
            .map(([id]) => id),
        ),
      ),
    ];
    const states = await this.index.getOwnerHistoryState(finalAuth, ids);
    const visible: OwnerBackupsResponseDto['backups'] = [];
    for (const row of candidates) {
      const record = kept.get(row.manifestKey);
      if (record && ownerBackupHistoryPage(finalAuth, row.manifest, states, { offset: 0, limit: 1 }).total > 0)
        visible.push({ manifestKey: row.manifestKey, backupDate: row.manifest.createdAt, status: record.status });
    }
    return {
      backups: visible.slice(page.offset, page.offset + page.limit),
      nextOffset: page.offset + page.limit < visible.length ? page.offset + page.limit : null,
    };
  }

  async readOwnerThumbnail(
    auth: AuthDto,
    assetId: string,
    manifestKey: string,
    refresh: () => Promise<AuthDto>,
  ): Promise<Buffer> {
    const dto = { manifestKey, limit: 100, offset: 0 };
    const found = await this.ownerHistory(auth, dto, refresh);
    const entry = found.manifest.assets[assetId];
    // A specific item is authorized using the same pre-search projection, independently of paging.
    const only = { ...found.manifest, assets: entry ? { [assetId]: entry } : {} };
    const current = await this.ownerBackupAuth(auth.user.id, refresh);
    const states = await this.index.getOwnerHistoryState(current, [assetId]);
    const file = ownerThumbnail(entry?.files ?? []);
    if (!file || ownerBackupHistoryPage(current, only, states, dto).total !== 1)
      throw new NotFoundException('Backup preview unavailable');
    const key = await this.requireKeyForRequest(found.metadata);
    const read = async (connection: CloudBackupConnection) =>
      this.store.getPreview(connection, objectKey(file.sha256), key, file.sha256, file.size);
    let bytes: Buffer;
    try {
      bytes =
        found.metadata.target === 'managed'
          ? await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudBackup, async () => {
              if (await this.activeBucketOperation()) throw new ConflictException('Cloud backup is busy');
              return read(
                this.managedConnection(await this.cloudBackup.rotate(await this.managedApi()), found.metadata),
              );
            })
          : await read(
              this.ownBucketConnection(found.metadata, (await this.readSettings()).frameleafCloud.cloudBackup),
            );
    } catch {
      throw new ConflictException('Backup preview unavailable');
    }
    const final = await this.ownerHistory(auth, dto, refresh);
    const finalAuth = await this.ownerBackupAuth(auth.user.id, refresh);
    const finalStates = await this.index.getOwnerHistoryState(finalAuth, [assetId]);
    const finalEntry = final.manifest.assets[assetId];
    const finalFile = ownerThumbnail(finalEntry?.files ?? []);
    const finalOnly = { ...final.manifest, assets: finalEntry ? { [assetId]: finalEntry } : {} };
    if (
      final.metadata.bucketRef !== found.metadata.bucketRef ||
      final.metadata.keyFingerprint !== found.metadata.keyFingerprint ||
      !finalFile ||
      finalFile.sha256 !== file.sha256 ||
      finalFile.size !== file.size ||
      ownerBackupHistoryPage(finalAuth, finalOnly, finalStates, dto).total !== 1
    )
      throw new NotFoundException('Backup preview unavailable');
    return bytes;
  }

  /** The kept backups a restore can be made from, newest first. */
  async listManifests(): Promise<CloudBackupManifestsResponseDto> {
    const metadata = await this.requireClaim();
    const manifests = await this.index.listKeptManifests(metadata.bucketRef);
    return {
      manifests: manifests.map((manifest) => ({
        key: manifest.key,
        status: manifest.status,
        createdAt: manifest.createdAt.toISOString(),
        finishedAt: asIso(manifest.finishedAt),
        assets: manifest.assetCount,
        files: manifest.fileCount,
        bytes: manifest.bytes,
        databaseKey: manifest.databaseKey,
      })),
    };
  }

  /**
   * The items one kept backup holds, found by file name, with whether each is in the library now. The
   * manifest is read from the bucket (with Frameleaf-managed storage, only while no other operation holds
   * the bucket: reading it rotates the key).
   */
  async listManifestItems(dto: CloudBackupManifestItemsDto): Promise<CloudBackupManifestItemsResponseDto> {
    const metadata = await this.requireClaim();
    const manifest = await this.readManifestForRequest(metadata, dto.manifestKey);
    const query = dto.query?.trim().toLowerCase() ?? '';
    const filter = dto.filter ?? 'all';
    const limit = dto.limit ?? 100;

    const candidates = Object.entries(manifest.assets).flatMap(([assetId, asset]) => {
      const original = asset.files.find((file) => file.role === 'original') ?? asset.files[0];
      if (!original) {
        return [];
      }
      const name = basename(original.path);
      return [{ assetId, asset, original, name }];
    });
    const library = await this.libraryState(candidates.map(({ assetId }) => assetId));
    // a search by name never finds a Locked item, so its name cannot be guessed at
    const named = candidates.filter(
      ({ assetId, name }) => !query || (!library.get(assetId)?.locked && name.toLowerCase().includes(query)),
    );
    const stateOf = (assetId: string) => library.get(assetId)?.status ?? 'deleted';
    const byName = (a: { name: string }, b: { name: string }) =>
      compareCodeUnits(a.name.toLowerCase(), b.name.toLowerCase());
    const matching = named
      .filter(({ assetId }) => {
        const state = stateOf(assetId);
        return filter === 'all' || (filter === 'deleted' ? state === 'deleted' : state !== 'deleted');
      })
      .toSorted(
        (a, b) =>
          Number(!!library.get(a.assetId)?.locked) - Number(!!library.get(b.assetId)?.locked) ||
          (library.get(a.assetId)?.locked ? 0 : byName(a, b)) ||
          compareCodeUnits(a.assetId, b.assetId),
      );
    const page = matching.slice(0, limit);
    const owners = await this.index.getOwnerNames(
      page.map(({ asset }) => asset.owner).filter((owner): owner is string => !!owner),
    );
    const items: CloudBackupManifestItem[] = page.map(({ assetId, asset, original, name }) => ({
      assetId,
      // a Locked item is never named here, whoever looks; it can still be restored
      name: library.get(assetId)?.locked ? '' : name,
      locked: !!library.get(assetId)?.locked,
      ownerId: asset.owner,
      ownerName: asset.owner ? (owners.get(asset.owner) ?? null) : null,
      files: asset.files.length,
      bytes: asset.files.reduce((total, file) => total + file.size, 0),
      modifiedAt: original.mtime,
      state: stateOf(assetId),
      hasDetails: !!asset.details && !!asset.type,
    }));
    return { manifestKey: dto.manifestKey, total: matching.length, items };
  }

  /**
   * The albums one kept backup records (manifest v2) that a restore can bring back: deleted ones, and
   * ones that no longer hold every item they held then. By name; a backup made before albums were
   * recorded lists none.
   */
  async listManifestAlbums(dto: CloudBackupManifestAlbumsDto): Promise<CloudBackupManifestAlbumsResponseDto> {
    const metadata = await this.requireClaim();
    const manifest = await this.readManifestForRequest(metadata, dto.manifestKey);
    const members = albumMembersOf(manifest);
    const held = await this.index.getAlbumMembers(Object.keys(manifest.albums));
    const owners = await this.index.getOwnerNames(Object.values(manifest.albums).map(({ ownerId }) => ownerId));
    const albums = Object.entries(manifest.albums).flatMap(([albumId, album]): CloudBackupManifestAlbum[] => {
      const items = members.get(albumId) ?? [];
      const now = held.get(albumId);
      const missing = now ? items.filter((assetId) => !now.has(assetId)).length : items.length;
      const state = now ? (missing > 0 ? 'missing-items' : 'complete') : 'deleted';
      if (state === 'complete') {
        return [];
      }
      return [
        {
          albumId,
          name: album.name,
          ownerId: album.ownerId,
          ownerName: owners.get(album.ownerId) ?? null,
          items: items.length,
          missing,
          state,
        },
      ];
    });
    return {
      manifestKey: dto.manifestKey,
      hasDetails: manifest.version >= 2,
      albums: albums.toSorted(
        (a, b) =>
          compareCodeUnits(a.name.toLowerCase(), b.name.toLowerCase()) || compareCodeUnits(a.albumId, b.albumId),
      ),
    };
  }

  private ownerRestoreHash(asset: CloudBackupManifest['assets'][string], manifest: CloudBackupManifest): string {
    return ownerRestoreHash(asset, manifest);
  }

  private async checkOwnerRestoreItems(
    auth: AuthDto,
    manifest: CloudBackupManifest,
    snapshot: CloudBackupRestoreSnapshot,
    resumed: boolean,
    index = this.index,
    ids = snapshot.assetIds ?? [],
  ) {
    return checkOwnerRestoreItems(auth, manifest, snapshot, resumed, index, ids);
  }

  async startOwnerRestore(
    auth: AuthDto,
    dto: { manifestKey: string; assetIds: string[] },
    refresh: () => Promise<AuthDto>,
  ) {
    if (dto.assetIds.length === 0 || dto.assetIds.length > 100 || new Set(dto.assetIds).size !== dto.assetIds.length)
      throw new BadRequestException('Choose 1 to 100 distinct backup items');
    const current = await this.ownerBackupAuth(auth.user.id, refresh);
    if (!current.session?.hasElevatedPermission || current.apiKey)
      throw new ForbiddenException('Unlock with your PIN to restore backup items');
    const metadata = await this.ownerBackupClaim();
    const manifest = await this.readManifestForRequest(metadata, dto.manifestKey);
    const snapshot: CloudBackupRestoreSnapshot = {
      version: 1,
      bucketRef: metadata.bucketRef,
      keyFingerprint: metadata.keyFingerprint,
      manifestKey: dto.manifestKey,
      scope: 'asset',
      assetIds: dto.assetIds,
      details: 'replace',
      owner: {
        ownerId: current.user.id,
        sessionId: current.session.id,
        current: await this.index.getOwnerRestoreIdentities(dto.assetIds),
        assetHashes: Object.fromEntries(
          dto.assetIds.map((id) => [
            id,
            manifest.assets[id] ? this.ownerRestoreHash(manifest.assets[id], manifest) : '',
          ]),
        ),
      },
    };
    await this.checkOwnerRestoreItems(await this.ownerBackupAuth(auth.user.id, refresh), manifest, snapshot, false);
    const latest = await this.ownerBackupClaim();
    if (latest.bucketRef !== snapshot.bucketRef || latest.keyFingerprint !== snapshot.keyFingerprint)
      throw new ConflictException('Cloud backup changed during the request');
    if ((await this.index.listKeptManifests(snapshot.bucketRef)).every((row) => row.key !== snapshot.manifestKey))
      throw new NotFoundException('Backup unavailable');
    const outcome = await this.operations.createExclusive(
      {
        ownerId: auth.user.id,
        kind: RESTORE_KIND,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: 'Restore own backup items',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: snapshot as unknown as Record<string, unknown>,
        settings: {},
        estimate: null,
        result: emptyRestoreResult() as unknown as Record<string, unknown>,
        totalUnits: null,
      },
      DatabaseLock.FrameleafCloudBackup,
      { alsoKinds: [KIND] },
    );
    if (!('created' in outcome)) throw new ConflictException('Another backup operation is running');
    return { operationId: outcome.created.id, status: outcome.created.status };
  }

  /** Same short current-authority guard for read preflight and final file publication. */
  private async withOwnerRestoreFile(
    operation: MediaOperation,
    claimToken: string,
    manifest: CloudBackupManifest,
    snapshot: CloudBackupRestoreSnapshot,
    file: CloudBackupRestoreFile,
    publish: () => Promise<'written' | 'skipped' | 'replaced'>,
  ) {
    if (!file.assetId) throw new Error('Owner restore item unavailable');
    await this.ownerBackupClaim();
    return this.index.withOwnerRestore(
      snapshot.owner!,
      snapshot,
      file.assetId,
      { operationId: operation.id, claimToken },
      async (trx) => {
        const scoped = new CloudBackupIndexRepository(trx);
        const { auth, storageLabel } = await scoped.getOwnerRestoreAuth(snapshot.owner!);
        await this.checkOwnerRestoreItems(auth, manifest, snapshot, true, scoped, [file.assetId!]);
        const current = await trx
          .selectFrom('asset')
          .select(['originalPath', 'isExternal', 'libraryId', 'ownerId'])
          .where('id', '=', file.assetId!)
          .executeTakeFirst();
        const roots = [
          StorageCore.getFolderLocation(StorageFolder.Upload, auth.user.id),
          StorageCore.getLibraryFolder({ id: auth.user.id, storageLabel }),
        ];
        if (file.role === 'original' && current && current.originalPath !== file.target)
          throw new Error('Owner restore destination changed');
        await assertOwnerRestorePath(roots, file.target);
        return new PhysicalFileRepository(trx).withOwnerRestorePath(
          file.target,
          file.assetId!,
          auth.user.id,
          async () => {
            await assertOwnerRestorePath(roots, file.target);
            return publish();
          },
        );
      },
    );
  }

  private async restoreOwnerLibrary(
    operation: MediaOperation,
    claimToken: string,
    manifest: CloudBackupManifest,
    snapshot: CloudBackupRestoreSnapshot,
    files: CloudBackupRestoreFile[],
    result: CloudBackupRestoreResult,
  ): Promise<CloudBackupRestoreResult> {
    const owner = snapshot.owner!;
    let { recreated, detailsRestored } = result;
    for (const assetId of snapshot.assetIds ?? []) {
      const jobs: OwnerRestoreDetailsContext['jobs'] = [];
      const originalFile = files.find((file) => file.assetId === assetId && file.role === 'original' && file.inPlace);
      if (!originalFile) throw new Error('Owner restore original unavailable');
      await this.withOwnerRestoreFile(operation, claimToken, manifest, snapshot, originalFile, () =>
        Promise.resolve('skipped'),
      );
      const evidence = await captureOwnerRestoreFile(originalFile.target, async (target) =>
        (await this.cryptoRepository.hashFile(target, 'sha256')).toString('hex'),
      );
      if (evidence.sha256 !== originalFile.sha256) throw new Error('Owner restore original changed');
      await this.ownerBackupClaim();
      const outcome = await this.index.withOwnerRestore(
        owner,
        snapshot,
        assetId,
        { operationId: operation.id, claimToken },
        async (trx) => {
          const index = new CloudBackupIndexRepository(trx);
          const { auth, storageLabel } = await index.getOwnerRestoreAuth(owner);
          await this.checkOwnerRestoreItems(auth, manifest, snapshot, true, index, [assetId]);
          const roots = [
            StorageCore.getFolderLocation(StorageFolder.Upload, auth.user.id),
            StorageCore.getLibraryFolder({ id: auth.user.id, storageLabel }),
          ];
          await assertOwnerRestorePath(roots, originalFile.target);
          await assertOwnerRestoreFile(originalFile.target, evidence.identity);
          return new PhysicalFileRepository(trx).withOwnerRestorePath(
            originalFile.target,
            assetId,
            owner.ownerId,
            async () => {
              await assertOwnerRestoreFile(originalFile.target, evidence.identity);
              const current = (await index.getAssetDetails([assetId])).get(assetId);
              const context: OwnerRestoreDetailsContext = { db: trx, ownerId: owner.ownerId, jobs };
              const asset = manifest.assets[assetId];
              for (const { id: albumId } of asset.details!.albums) {
                await this.details.restoreAlbum({ albumId, album: manifest.albums[albumId], memberIds: [] }, context);
              }
              if (current) {
                const changed = await this.details.putBack(
                  {
                    assetId,
                    ownerId: owner.ownerId,
                    type: current.record.type,
                    current: current.details,
                    backup: asset.details!,
                    mode: 'replace',
                    people: manifest.people,
                  },
                  context,
                );
                await assertOwnerRestoreFile(originalFile.target, evidence.identity);
                await new AssetRepository(trx).update({
                  id: assetId,
                  status: AssetStatus.Active,
                  deletedAt: null,
                  checksum: Buffer.from(originalFile.sha256, 'hex'),
                  checksumAlgorithm: ChecksumAlgorithm.sha256File,
                });
                await assertOwnerRestoreFile(originalFile.target, evidence.identity);
                return { recreated: 0, detailsRestored: changed ? 1 : 0 };
              }
              const original = files.find(
                (file) => file.assetId === assetId && file.role === 'original' && file.inPlace,
              );
              if (!original) throw new Error('Owner restore destination unavailable');
              const record = readRecord(asset)!;
              const sidecar = files.find((file) => file.assetId === assetId && file.role === 'sidecar' && file.inPlace);
              const made = await this.details.recreate(
                {
                  assetId,
                  ownerId: owner.ownerId,
                  record,
                  details: asset.details,
                  sha256: original.sha256,
                  size: original.size,
                  originalPath: original.target,
                  sidecarPath: sidecar?.target ?? null,
                  people: manifest.people,
                },
                context,
              );
              if (made.status !== 'created') throw new Error('Owner restore item could not be recreated');
              await assertOwnerRestoreFile(originalFile.target, evidence.identity);
              return { recreated: made.status === 'created' ? 1 : 0, detailsRestored: 0 };
            },
          );
        },
      );
      recreated += outcome.recreated;
      detailsRestored += outcome.detailsRestored;
      result = { ...result, recreated, detailsRestored };
      if ((await this.checkpointTask(operation, claimToken, result, restoreUnits(result))) !== 'continue')
        throw new Error('Owner restore interrupted');
      await this.jobRepository.queueAll(jobs);
    }
    return { ...result, recreated, detailsRestored };
  }

  /**
   * Queue a restore from a kept backup. Refused while any other backup operation or restore is unfinished,
   * and in own-memory mode until the key is loaded.
   */
  async startRestore(auth: AuthDto, dto: CloudBackupRestoreDto): Promise<CloudBackupStatusResponseDto> {
    const metadata = await this.requireClaim();
    const kept = await this.index.listKeptManifests(metadata.bucketRef);
    const manifest = kept.find(({ key }) => key === dto.manifestKey);
    if (!manifest) {
      throw new NotFoundException('This backup is not one of the kept backups.');
    }
    if (dto.scope === 'asset' && dto.assetIds?.length !== 1) {
      throw new BadRequestException('Choose exactly one item to restore in place.');
    }
    if (dto.scope === 'album' && (!dto.albumId || dto.assetIds?.length)) {
      throw new BadRequestException('Choose one album to restore.');
    }
    if (dto.details && dto.scope !== 'asset' && dto.scope !== 'album') {
      throw new BadRequestException('Only an item or an album restore brings details back.');
    }
    if ((dto.scope === 'database' || dto.scope === 'library') && dto.assetIds?.length) {
      throw new BadRequestException('A database or whole-library restore does not take items.');
    }
    if ((dto.scope === 'database' || dto.scope === 'library') && !manifest.databaseKey) {
      throw new BadRequestException('This backup has no database dump to restore.');
    }
    await this.requireKeyForRequest(metadata);
    let assetIds = dto.scope === 'files' || dto.scope === 'asset' ? (dto.assetIds ?? null) : null;
    if (dto.scope === 'album') {
      const backedUp = await this.readManifestForRequest(metadata, dto.manifestKey);
      if (!backedUp.albums[dto.albumId!]) {
        throw new NotFoundException(
          backedUp.version >= 2
            ? 'This backup does not hold the album.'
            : 'This backup was made before albums were recorded in backups. Choose a newer backup.',
        );
      }
      assetIds = albumMembersOf(backedUp).get(dto.albumId!) ?? [];
    }

    const snapshot: CloudBackupRestoreSnapshot = {
      version: 1,
      bucketRef: metadata.bucketRef,
      keyFingerprint: metadata.keyFingerprint,
      manifestKey: dto.manifestKey,
      scope: dto.scope,
      assetIds,
      ...(dto.scope === 'album' && { albumId: dto.albumId }),
      ...((dto.scope === 'asset' || dto.scope === 'album') && { details: dto.details ?? 'keep' }),
    };
    const outcome = await this.operations.createExclusive(
      {
        ownerId: auth.user.id,
        kind: RESTORE_KIND,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        // never an item's name: a Locked item must not be named in Activity
        label: RESTORE_LABEL[dto.scope],
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: snapshot as unknown as Record<string, unknown>,
        settings: { bucket: metadata.bucket },
        estimate: null,
        result: emptyRestoreResult() as unknown as Record<string, unknown>,
        totalUnits: null,
      },
      DatabaseLock.FrameleafCloudBackup,
      { alsoKinds: [KIND] },
    );
    if (!('created' in outcome)) {
      throw new ConflictException(
        'Another cloud backup operation or restore is running. Restore when it has finished.',
      );
    }
    this.logger.log(`Restore ${outcome.created.id} (${dto.scope}) from ${dto.manifestKey} queued by ${auth.user.id}`);
    return this.getStatus();
  }

  /** A manifest for a request: from the bucket, once; managed storage only while nothing else holds it. */
  private async readManifestForRequest(metadata: FrameleafCloudBackup, key: string): Promise<CloudBackupManifest> {
    const kept = await this.index.listKeptManifests(metadata.bucketRef);
    if (kept.every((manifest) => manifest.key !== key)) {
      throw new NotFoundException('This backup is not one of the kept backups.');
    }
    const binding = JSON.stringify([
      metadata.bucketRef,
      metadata.region,
      metadata.bucket,
      metadata.keyFingerprint,
      metadata.managed?.storageId ?? null,
      metadata.managed?.location?.locationId ?? null,
    ]);
    if (
      this.manifestCache?.bucketRef === metadata.bucketRef &&
      this.manifestCache.key === key &&
      this.manifestCache.binding === binding
    ) {
      return this.manifestCache.manifest;
    }
    const bucketKey = await this.requireKeyForRequest(metadata);
    const read = async (connection: CloudBackupConnection) => {
      try {
        return readManifest(await this.store.get(connection, key, bucketKey));
      } catch (error) {
        throw this.asRequestError(error);
      }
    };
    let manifest: CloudBackupManifest;
    if (metadata.target === 'managed') {
      // A new key revokes the one a running operation holds: under the bucket lock, which every operation
      // is created under and every rotation takes, nothing else can hold the bucket while this reads.
      manifest = await this.databaseRepository.withLock(DatabaseLock.FrameleafCloudBackup, async () => {
        if (await this.activeBucketOperation()) {
          throw new ConflictException(
            'Wait for the running cloud backup operation to finish before browsing a backup.',
          );
        }
        let connection: CloudBackupConnection;
        try {
          connection = this.managedConnection(await this.cloudBackup.rotate(await this.managedApi()), metadata);
        } catch (error) {
          throw new ConflictException(this.refusalOf(error).message);
        }
        return read(connection);
      });
    } else {
      const { frameleafCloud } = await this.readSettings();
      let connection: CloudBackupConnection;
      try {
        connection = this.ownBucketConnection(metadata, frameleafCloud.cloudBackup);
      } catch (error) {
        throw new ConflictException(errorMessage(error));
      }
      manifest = await read(connection);
    }
    this.manifestCache = { bucketRef: metadata.bucketRef, key, binding, manifest };
    return manifest;
  }

  /**
   * FL-164: `frameleaf-admin cloud-backup restore`, for disaster recovery on a server whose web app is not
   * running (or whose database is empty): everything comes from the bucket and the key alone. The key
   * must open the bucket's claim; the newest manifest (or the one named) is read, its files are
   * restored in place under the media folder and its database dump into `<media>/backups`, each checked
   * against its SHA-256. With `restoreDatabase` the dump is then restored through the maintenance
   * restore's own procedure. Nothing is recorded as a cloud backup claim: set cloud backup up again
   * afterwards, which reclaims the same bucket.
   */
  async restoreFromBucket(
    options: CloudBackupBareMetalRestore,
    report: (line: string) => void,
  ): Promise<CloudBackupRestoreResult & { manifestKey: string; databaseRestored: boolean }> {
    const key = parseBackupKey(options.key);
    const connection = await this.connectionFor(options.s3);
    const marker = await this.store.readMarker(connection, key);
    report(`The key opens bucket ${connection.bucket}, claimed by server ${marker.instanceId} on ${marker.claimedAt}.`);

    const listed: string[] = [];
    await this.store.listAll(connection, CLOUD_BACKUP_MANIFEST_PREFIX, (page) => {
      listed.push(...page.map(({ key: name }) => name).filter((name) => manifestTime(name)));
      return Promise.resolve();
    });
    const manifestKey = options.manifestKey ?? listed.toSorted((a, b) => compareCodeUnits(b, a))[0];
    if (!manifestKey || !listed.includes(manifestKey)) {
      throw new Error(
        manifestKey ? `This bucket holds no backup named ${manifestKey}.` : 'This bucket holds no complete backup yet.',
      );
    }
    const manifest = readManifest(await this.store.get(connection, manifestKey, key));
    report(
      `Restoring ${manifestKey}: ${Object.keys(manifest.assets).length} items${manifest.database ? ' and the database' : ''}.`,
    );

    const operationId = `command-${compactIso(new Date())}`;
    const mediaLocation = StorageCore.getMediaLocation();
    const plan = restorePlan({
      manifest,
      scope: options.scope,
      assetIds: null,
      operationId,
      mediaLocation,
      currentOriginals: new Map(),
    });
    let reportedAt = 0;
    const result = await this.restorer.restore({
      bucket: { bucketRef: bucketRef(connection.endpoint, connection.bucket), connection, bucketKey: key },
      manifest,
      scope: options.scope,
      files: plan.files,
      destination: plan.destination,
      mediaLocation,
      backupsFolder: StorageCore.getBaseFolder(StorageFolder.Backups),
      operationId,
      start: emptyRestoreResult(),
      checkpoint: (current) => {
        if (Date.now() - reportedAt >= 5000) {
          reportedAt = Date.now();
          report(`${current.files} of ${current.filesTotal} files restored and checked.`);
        }
        return Promise.resolve(true);
      },
    });
    if (!result) {
      throw new Error('The restore stopped before it finished.');
    }
    report(
      `${result.files} files restored and checked: ${result.skipped} were already in place, ${result.replaced} were moved aside to ${join(mediaLocation, RESTORE_REPLACED_FOLDER, operationId)}.`,
    );

    let databaseRestored = false;
    if (options.restoreDatabase && result.databaseFile) {
      report(`Restoring the database from ${result.databaseFile}…`);
      await this.databaseBackup.restoreDatabaseBackup(result.databaseFile, (action, progress) =>
        report(`Database ${action}: ${Math.round(progress * 100)}%`),
      );
      databaseRestored = true;
    }
    return { ...result, manifestKey, databaseRestored };
  }

  /* ------------------------------------------------------------------ */
  /* FL-164: key escrow                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Keep a copy of the bucket key with Frameleaf Cloud, wrapped under a passphrase with scrypt (server key
   * mode only). The copy is checked to open with the passphrase before it is sent; the passphrase itself
   * is never stored or sent.
   */
  async storeEscrow(auth: AuthDto, dto: CloudBackupEscrowDto): Promise<CloudBackupStatusResponseDto> {
    this.requireEditableConfig();
    const metadata = await this.requireClaim();
    if (metadata.keyMode !== 'server') {
      throw new BadRequestException('Key escrow is only available when this server generates its own backup key.');
    }
    const problem = escrowPassphraseProblem(dto.passphrase);
    if (problem) {
      throw new BadRequestException(problem);
    }
    const key = await this.loadKey(metadata);
    if (!key) {
      throw new ConflictException(
        'The backup key file is missing from this server. Restore it from the key file or recovery kit first.',
      );
    }
    const blob = await wrapBucketKey(key, dto.passphrase);
    if (!(await unwrapBucketKey(blob, dto.passphrase)).equals(key)) {
      throw new ConflictException('The key copy could not be checked, so it was not sent.');
    }
    const { frameleafCloud } = await this.readSettings();
    try {
      const api = await this.managedApi();
      await this.cloudBackup.putSettings(api, {
        keyMode: 'server',
        scheduleEnabled: frameleafCloud.cloudBackup.enabled,
      });
      await this.cloudBackup.putEscrow(api, blob);
    } catch (error) {
      throw new ConflictException(this.refusalOf(error).message);
    }
    await this.setEscrowConfig(true);
    await this.updateMetadata((current) => ({ ...current, escrow: { storedAt: new Date().toISOString() } }));
    this.logger.log(`Cloud backup key escrow stored with Frameleaf Cloud by ${auth.user.id}`);
    return this.getStatus();
  }

  /** Remove the key copy from Frameleaf Cloud. A copy that is already gone counts as removed. */
  async removeEscrow(auth: AuthDto): Promise<CloudBackupStatusResponseDto> {
    this.requireEditableConfig();
    await this.requireClaim();
    try {
      await this.cloudBackup.deleteEscrow(await this.managedApi());
    } catch (error) {
      if (!(error instanceof FrameleafCloudError && error.status === 404)) {
        throw new ConflictException(this.refusalOf(error).message);
      }
    }
    await this.setEscrowConfig(false);
    await this.updateMetadata(({ escrow: _escrow, ...current }) => current);
    this.logger.log(`Cloud backup key escrow removed from Frameleaf Cloud by ${auth.user.id}`);
    return this.getStatus();
  }

  private async setEscrowConfig(escrow: boolean) {
    const { oldConfig, newConfig } = await this.databaseRepository.withLock(
      DatabaseLock.SystemConfigUpdate,
      async () => {
        const result = await withEffectiveConfigWrite(this.configRepos(), async (repos) => {
          const current = await readConfig(repos);
          const next = structuredClone(current);
          next.frameleafCloud.cloudBackup.escrow = escrow;
          const saved = await updateConfig(repos, next);
          return { oldConfig: current, newConfig: saved };
        });
        // FL-146 (FL-66): listed in the settings history as a Frameleaf Cloud change, under the same lock
        await recordConfigHistory(this.historyRecorder(), result.oldConfig, result.newConfig, undefined, {
          kind: 'settings',
          source: 'frameleaf-cloud',
        });
        return result;
      },
    );
    await this.eventRepository.emit('ConfigUpdate', { oldConfig, newConfig });
  }

  /** A backup operation or restore that is unfinished, of either kind. */
  private async activeBucketOperation() {
    return (await this.operations.getActiveOfKind(KIND)) ?? (await this.operations.getActiveOfKind(RESTORE_KIND));
  }

  /** The bucket key for a request, or a refusal that says to load it (own-memory) or restore it. */
  private async requireKeyForRequest(metadata: FrameleafCloudBackup): Promise<Buffer> {
    const key = await this.loadKeyOrAsk(metadata);
    if (key) {
      return key;
    }
    throw new ConflictException(
      metadata.keyMode === 'own-memory'
        ? 'Load the backup key first. This server does not keep it.'
        : 'The backup key file is missing from this server. Restore it from the key file or recovery kit.',
    );
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
    type?: NotificationType;
    /** The server job the notice is about, so devices can offer Retry or Pause for it. */
    job?: PushJobRef;
  }) {
    const { job, ...adminNotice } = notice;
    this.eventRepository
      .emit('AdminNotify', { type: NotificationType.BackupFailed, ...adminNotice })
      .catch((error) => this.logger.warn(`Could not notify administrators: ${errorMessage(error)}`));
    // FL-228: every such notice means cloud backup needs the owner; their devices hear it too
    this.eventRepository
      .emit('PushNotify', {
        type: PushEventType.BackupNeedsAttention,
        admins: true,
        title: notice.title,
        body: notice.description,
        data: { reason: notice.dedupeKey, ...pushJobData(job) },
        dedupeKey: `cloud-backup-attention/${notice.dedupeKey}`,
      })
      .catch((error) => this.logger.warn(`Could not notify administrators' devices: ${errorMessage(error)}`));
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
        const done = () => {
          clearTimeout(timer);
          this.keyWaiters.delete(done);
          resolve();
        };
        this.keyWaiters.add(done);
        const timer = setTimeout(done, this.keyAskMs);
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
      throw new BadRequestException('Cannot update configuration while FRAMELEAF_CONFIG_FILE is in use');
    }
  }

  private async requireClaim(): Promise<FrameleafCloudBackup> {
    const metadata = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafCloudBackup);
    if (!metadata) {
      throw new BadRequestException('Cloud backup is not set up.');
    }
    return metadata;
  }

  /** A backup operation or (FL-164) a restore, for pause, resume and cancel. */
  private async requireRun(id: string): Promise<MediaOperation> {
    const operation =
      (await this.operations.getOfKind(id, KIND)) ?? (await this.operations.getOfKind(id, RESTORE_KIND));
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
    const task = taskOf(operation);
    const result = parseRunResult(operation.result);
    const checked = (operation.result as { checked?: unknown } | null)?.checked;
    return {
      operationId: operation.id,
      task,
      state: runState(operation.status as MediaOperationStatus, !!operation.pauseRequestedAt),
      phase: result.phase,
      progress: Number(operation.progress ?? 0),
      uploaded: task === 'backup' ? result.uploaded : 0,
      skipped: task === 'backup' ? result.skipped : 0,
      bytesUploaded: task === 'backup' ? result.bytesUploaded : 0,
      checked: task === 'verify' && typeof checked === 'number' ? checked : 0,
    };
  }

  private mapActiveRestore(operation: MediaOperation) {
    const snapshot = operation.snapshot as Partial<CloudBackupRestoreSnapshot>;
    const result = { ...emptyRestoreResult(), ...(operation.result as Partial<CloudBackupRestoreResult> | null) };
    return {
      operationId: operation.id,
      state: runState(operation.status as MediaOperationStatus, !!operation.pauseRequestedAt),
      scope: snapshot.scope ?? 'files',
      progress: Number(operation.progress ?? 0),
      files: result.files,
      filesTotal: result.filesTotal,
      bytes: result.bytes,
      bytesTotal: result.bytesTotal,
    };
  }

  private mapLastRestore(restore: FrameleafCloudBackupRestore) {
    return {
      ...restore,
      destination: restore.destination ?? null,
      databaseFile: restore.databaseFile ?? null,
      recreated: restore.recreated ?? 0,
      detailsRestored: restore.detailsRestored ?? 0,
      error: restore.error ?? null,
    };
  }

  private gatewayDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    };
  }

  private historyRecorder() {
    return {
      systemMetadataRepository: this.systemMetadataRepository,
      cryptoRepository: this.cryptoRepository,
      logger: this.logger,
    };
  }

  private configRepos() {
    return {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
  }

  private readSettings() {
    return getConfig(this.configRepos(), { withCache: false });
  }
}

/** FL-164: a message with the media folder as a path prefix written `<media>`, never a longer name. */
const maskMediaPath = (message: string) => {
  const media = StorageCore.getMediaLocation().replace(/\/+$/, '');
  if (!media) {
    return message;
  }
  const escaped = media.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
  return message.replaceAll(new RegExp(String.raw`${escaped}(?=/|$|[\s'",:;)])`, 'g'), '<media>');
};

/** FL-164: what a checkpoint of a verification, a clean-up or a restore decided. */
type TaskCheckpoint = 'continue' | 'cancelled' | 'stopped';

/** FL-164: the claimed bucket opened for one operation. */
type OpenedBucket = CloudBackupBucket & {
  metadata: FrameleafCloudBackup;
  settings: SystemConfig['frameleafCloud']['cloudBackup'];
  readOnly: boolean;
};

/** FL-164: what a restore's Activity row counts: files, and progress by bytes. */
const restoreUnits = (result: CloudBackupRestoreResult) => ({
  processed: result.files,
  total: result.filesTotal,
  progress: result.bytesTotal > 0 ? (result.bytes / result.bytesTotal) * 100 : 0,
});

/** FL-164 (manifest v2): each album's items in a backup, in the manifest's order. */
const albumMembersOf = (manifest: CloudBackupManifest) => {
  const members = new Map<string, string[]>();
  for (const [assetId, asset] of Object.entries(manifest.assets)) {
    for (const { id } of asset.details?.albums ?? []) {
      const items = members.get(id) ?? [];
      items.push(assetId);
      members.set(id, items);
    }
  }
  return members;
};

/** An item's record as the manifest holds it (manifest v2), or null for a backup without one. */
const readRecord = (asset: CloudBackupManifest['assets'][string]): CloudBackupAssetRecord | null =>
  asset.type && asset.originalFileName && asset.fileCreatedAt && asset.fileModifiedAt && asset.localDateTime
    ? {
        type: asset.type,
        originalFileName: asset.originalFileName,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        localDateTime: asset.localDateTime,
        duration: asset.duration ?? null,
      }
    : null;

/** FL-164: a restore's Activity label. Never an item's name, which a Locked item must not show. */
const RESTORE_LABEL: Record<CloudBackupRestoreSnapshot['scope'], string> = {
  files: 'Restore from cloud backup',
  asset: 'Restore an item from cloud backup',
  album: 'Restore an album from cloud backup',
  database: 'Restore the database from cloud backup',
  library: 'Restore the whole library from cloud backup',
};

const READ_ONLY_REASONS: Record<string, string> = {
  purge_hold: ' while its deletion is on hold',
  entitlement: ' because the Frameleaf Cloud plan has lapsed',
  unlinked: ' because it was unlinked',
  suspended: ' because it is suspended',
  purging: ' because its backups are being deleted',
  plan_full: ' because the Frameleaf plan is full: new items wait until the plan is upgraded',
};

/** FL-164: why managed storage is read-only, as a phrase, when Frameleaf Cloud said. */
const readOnlyReason = (metadata: FrameleafCloudBackup) =>
  READ_ONLY_REASONS[metadata.managed?.readOnlyReason ?? ''] ?? '';

/** FL-164: the refusal a check-in's suspicion stands for, worded as Frameleaf Cloud's own answer is. */
const cloneSuspectedError = () =>
  new FrameleafCloudError(
    MlAdmissionRefusal.CloudUnavailable,
    409,
    'clone suspected',
    errorEnvelopeSchema.parse({ code: 'clone_suspected' }),
  );

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
