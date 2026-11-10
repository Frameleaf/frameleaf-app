import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  FileProblemDto,
  FileProblemFolderDto,
  FileProblemListQueryDto,
  FileProblemLookInDto,
  FileProblemPageDto,
  FileProblemRowDto,
} from 'src/dtos/file-problem.dto.js';
import type {
  LostOriginalsCheckedDto,
  LostOriginalsQueryDto,
  LostOriginalsResponseDto,
} from 'src/dtos/lost-originals.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { LostOriginalRestore } from 'src/services/cloud-backup-lost-original.js';
import type { JobOf } from 'src/types.js';
import type { FileStep, FindingStep, FixState, NewFileStep } from 'src/utils/file-steps.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  CORRUPT_DELETE_STATUSES,
  CORRUPT_MEDIA_DELETE_CONFIRM_TEXT,
  CORRUPT_MEDIA_DELETE_RECENT_MS,
  MediaHealthActivityResponse,
  MediaHealthBulkActionDto,
  MediaHealthBulkResponseDto,
  MediaHealthCandidateResponse,
  MediaHealthChooseCandidatesDto,
  MediaHealthDeleteCorruptDto,
  MediaHealthItemResponse,
  MediaHealthListQueryDto,
  MediaHealthListResponseDto,
  MediaHealthLocateDto,
  MediaHealthOperationDto,
  MediaHealthRecoverDto,
  MediaHealthRepairDto,
  MediaHealthRepairPreviewDto,
  MediaHealthRepairPreviewResponseDto,
  MediaHealthRepairResponseDto,
  MediaHealthRootResponse,
  MediaHealthRootsResponseDto,
  MediaHealthRunResponseDto,
  MediaHealthScanDto,
  MediaHealthScanResponseDto,
  MediaHealthSummaryQueryDto,
  MediaHealthSummaryResponseDto,
  NEEDS_ATTENTION_MEDIA_HEALTH_STATUSES,
} from 'src/dtos/media-health.dto.js';
import {
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobStatus,
  MediaHealthCategory,
  MediaHealthSeverity,
  MediaHealthStatus,
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationItemStatus,
  MediaOperationKind,
  MediaOperationStatus,
  QueueName,
  StorageFolder,
  SystemMetadataKey,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SharpOperationError } from 'src/queue/sharp-pool.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  FileProblemRecord,
  MediaHealthAsset,
  MediaHealthCandidate,
  MediaHealthFinding,
  MediaHealthRepository,
  MediaHealthRun,
  ReplaceRepairedOriginal,
  UndoFileFix,
  UndoFileFixResult,
  UpsertMediaHealthFinding,
} from 'src/repositories/media-health.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { BulkMediaHealthEntry, BulkOperationItem, bulkErrorMessage } from 'src/utils/bulk-operation.js';
import { getConfig } from 'src/utils/config.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  BUSY_RETRY_DELAYS_MS,
  FIX_RUNNING_WAIT_MS,
  FIX_WAIT_MS,
  MAX_BACKUP_WAITS,
  MAX_DRIVE_WAITS,
  checkedStep,
  folderFacts,
  repairResult,
} from 'src/utils/file-fix.js';
import {
  FileCause,
  classifyFileProblem,
  isJpegFileName,
  nextFixAction,
  readFileShape,
} from 'src/utils/file-problem.js';
import { isActivePhone, phoneName } from 'src/utils/file-steps.js';
import { fileIdentity } from 'src/utils/file-trash.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { JPEG_REPAIR_EXTENSIONS, type JpegRepairResult } from 'src/utils/jpeg-repair.js';
import { isLockedPath } from 'src/utils/locked-read.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import {
  MediaHealthLocateSnapshot,
  MediaHealthOperationSnapshot,
  MediaHealthRunState,
  MediaHealthScanResult,
  mediaHealthActivityAction,
  mediaHealthOperationLabel,
  parseMediaHealthSnapshot,
} from 'src/utils/media-health-operation.js';
import {
  FileDigests,
  LIBRARY_CARE_FOLDER,
  MANAGED_ROOT_ID,
  MediaHealthRoot,
  isPathWithin,
  libraryRootId,
  publishVerifiedCopy,
  recoveryRootId,
  resolveInsideRoot,
  retainFile,
  rootForPath,
  rootKindOf,
} from 'src/utils/media-health-roots.js';
import { getErrorMessage } from 'src/utils/media-health.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { handlePromiseError } from 'src/utils/misc.js';
import { isFileRootReachable, pathState } from 'src/utils/storage-reach.js';

const MEDIA_HEALTH_PAGE_SIZE = 100;
const MANAGED_LOOKUP_MAX_ENTRIES = 10_000;
const MANAGED_LOOKUP_MAX_BYTES = 10 * 1024 ** 3;
/**
 * Library Care's own folder for published recovery copies (FL-69). Hidden, so the untracked-file
 * crawler never adopts a copy that is not committed yet.
 */
const RECOVERY_FOLDER = LIBRARY_CARE_FOLDER;
/** A repair as the reviewer sees it: whether every detail the original carried is in the result. */
type RepairOutcome = Omit<JpegRepairResult, 'metadataLost'> & { metadataKept: boolean };
/** The cron that starts every account's scheduled incremental health scan (Library care settings). */
export const LIBRARY_CARE_HEALTH_SCAN_CRON = 'libraryCareHealthScan';

type DurableScan = { missingRunId: string; corruptRunId: string; operationId: string };

/**
 * How often a scheduled scan is a full one (FL-69). An incremental scan only rechecks assets whose
 * record changed, so an original removed or damaged on disk later, with no change to its record,
 * would never be found; at least this often every asset's file is checked again.
 */
export const LIBRARY_CARE_FULL_SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Run states that mean "a job is still working on this". */
const OPEN_RUN_STATES: ReadonlySet<string> = new Set(['running', 'paused', 'retrying']);
/** A trash job is created just after its findings are queued; leave them this long before releasing them. */
const TRASH_QUEUE_GRACE_MS = 10 * 60_000;
/**
 * An untracked file written this recently may be an upload still streaming into its final path (a
 * classic multipart upload goes straight to `upload/<user>/xx/yy/<uuid>.<ext>`). The next scan sees
 * it once it has settled, as a tracked row or as a leftover of an aborted upload.
 */
const UNTRACKED_FILE_SETTLE_MS = 5 * 60_000;

type CandidateValidation = {
  status: MediaHealthStatus;
  score: number | null;
  evidence: Record<string, unknown>;
  resolution: Record<string, unknown>;
  /** FL-1337: the decoder's own words, for telling the cause. Never stored. */
  message?: string;
};

type FixJob = JobOf<JobName.MediaHealthFixAsset>;
/**
 * How a fix leaves the finding a relink or recovery writes (FL-1337): its state, and the history the
 * write adds. `kept` is the step for the previous file once it is in its kept place; it carries what
 * Undo needs.
 */
type FixWrite = {
  evidence: Record<string, unknown>;
  steps: FindingStep[];
  kept?: (retainedPath: string, after: { originalPath: string; checksum: string }) => FindingStep;
};
/** What a history step says about the backup it asked: Cloud Backup, kept since its oldest backup began. */
const backupFacts = ({ since }: LostOriginalRestore) => ({ backup: 'cloud', ...(since && { since }) });

const isOpenFinding = (finding: Pick<MediaHealthFinding, 'resolvedAt' | 'dismissedAt'>) =>
  !finding.resolvedAt && !finding.dismissedAt;

/** Damaged and missing files (FL-1337 ruling 1): the fix states of Fixed for you, and of Needs you. */
const FIXED_FILE_STATES: ReadonlySet<string> = new Set<FixState>(['repaired', 'part-saved', 'found-again', 'restored']);
const NEEDS_FILE_STATES: ReadonlySet<string> = new Set<FixState>([
  'missing',
  'waiting-phone',
  'cant-repair',
  'couldnt-check',
]);
/** Review Focus 3: the photo is not as the fix left it, so Undo changes nothing. */
const UNDO_CHANGED = "This photo changed since Frameleaf fixed it, so it can't be undone.";
/** Task 11b: a photo that is Locked now keeps the file it has; Undo moves nothing. */
const UNDO_LOCKED = "This photo is locked, so this fix can't be undone.";
/** Task 11b: the damaged file a repair kept, for its owner to download. */
const NO_KEPT_FILE = "Frameleaf didn't keep a damaged file for this photo.";
const KEPT_FILE_LOCKED = "This photo is locked, so the damaged file Frameleaf kept can't be downloaded.";
const NOTHING_TO_UNDO = 'There is nothing to undo for this photo.';
const OWNER_ONLY = "Only the photo's owner can do that.";
/** F2: the Upload drive, which holds Library care's folder, is not there. */
const COPIES_DRIVE_AWAY = "Frameleaf can't reach the drive that keeps its copies right now. Try again later.";
/** Review Focus 5: a photo's open problem is the one the list and Undo go by. */
const OTHER_PROBLEM_OPEN = "This photo has another problem open, so this fix can't be undone yet.";
/** Facts kept for the server's own bookkeeping, never sent: which session reported, and the app's device id. */
const UNSHOWN_FACTS: ReadonlySet<string> = new Set(['session', 'deviceId']);
const shownFacts = (facts: Record<string, unknown> | null | undefined) =>
  Object.fromEntries(Object.entries(facts ?? {}).filter(([key]) => !UNSHOWN_FACTS.has(key)));
/** One fix as Undo reads it from the step that recorded it (FL-1337, design §5). */
type FixToUndo = {
  kind: 'repair' | 'relink' | 'restore';
  stepId: string;
  /** The file the photo used before the fix. */
  previousPath: string;
  /** The photo's file right after the fix, and its checksum (hex) when recorded. */
  originalPath: string;
  checksum?: string;
  /** A restore: where the changed file that was at the photo's path was moved aside. */
  retainedPath?: string;
};
const UNDO_KINDS: ReadonlySet<string> = new Set(['repair', 'relink', 'restore']);

/** A validation that could not reach a verdict (busy, timed out, out of resources): no change this time. */
type BusyValidation = { busy: true; candidate: CandidateValidation };

const BUSY_REASONS: ReadonlySet<string> = new Set([
  'validation_busy',
  'io_failed',
  'decoder_unavailable',
  'decoder_resource_limit',
  'file_changed',
]);

type ManagedSearchProgress = NonNullable<JobOf<JobName.MediaHealthLocateMissing>['managedSearch']>;

/** One step of a search for originals (FL-69): what it covered, and where to carry on from. */
export type MediaHealthLocateStep = {
  checkedAssets: number;
  foundAssets: number;
  continuation?: ManagedSearchProgress;
  /** FL-1337: the findings this step checked, so a Look in a folder speaks only for what it searched. */
  checkedIds?: string[];
};

/** One page of an owner's durable scan (FL-69). */
export type MediaHealthScanPage = {
  checked: number;
  missing: number;
  corrupt: number;
  lastId: string | null;
};

/**
 * The status a dismissed finding goes back to (FL-69, UT-2): the one the dismissal recorded, when it
 * still needs a decision. A finding dismissed while queued for the trash is confirmed damage again.
 */
const reopenedStatus = (value: unknown): MediaHealthStatus | undefined => {
  if (value === MediaHealthStatus.TrashQueued || value === MediaHealthStatus.DeleteQueued) {
    return MediaHealthStatus.CorruptConfirmed;
  }
  return NEEDS_ATTENTION_MEDIA_HEALTH_STATUSES.includes(value as MediaHealthStatus)
    ? (value as MediaHealthStatus)
    : undefined;
};

/** The digest an original's own checksum records, when it is a file checksum. */
const expectedDigest = (asset: Pick<MediaHealthAsset, 'checksum' | 'checksumAlgorithm'>) =>
  asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
    ? { sha1: asset.checksum }
    : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
      ? { sha256: asset.checksum }
      : undefined;

const hex = (digest: Buffer | null | undefined) => (digest ? Buffer.from(digest).toString('hex') : null);

/**
 * The checksums recorded for an original (FL-69), which any copy must match exactly: the asset's
 * own file checksum, and the fork's recorded digests of the file where there are any. A path
 * checksum (external libraries before FL-69) says nothing about the file and is left out.
 */
export const expectedChecksums = (
  asset: Pick<MediaHealthAsset, 'checksum' | 'checksumAlgorithm'>,
  sidecar?: { sha1: Buffer | null; sha256: Buffer | null },
): Array<{ algorithm: 'sha1' | 'sha256'; value: string }> => {
  const byAlgorithm = new Map<'sha1' | 'sha256', string>();
  if (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File && hex(asset.checksum)) {
    byAlgorithm.set('sha1', hex(asset.checksum)!);
  }
  if (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File && hex(asset.checksum)) {
    byAlgorithm.set('sha256', hex(asset.checksum)!);
  }
  for (const algorithm of ['sha1', 'sha256'] as const) {
    const value = hex(sidecar?.[algorithm]);
    if (value && !byAlgorithm.has(algorithm)) {
      byAlgorithm.set(algorithm, value);
    }
  }
  return (['sha1', 'sha256'] as const)
    .filter((algorithm) => byAlgorithm.has(algorithm))
    .map((algorithm) => ({ algorithm, value: byAlgorithm.get(algorithm)! }));
};

const outcome = (
  id: string,
  status: MediaOperationItemStatus,
  reasonKey?: string,
  message?: string,
): BulkOperationItem => ({
  id,
  status,
  ...(reasonKey && { reasonKey }),
  ...(message && { message }),
});

/** The finding changed since it was reviewed: a business answer, so it is not retried automatically. */
const changed = (id: string, message: string) =>
  outcome(id, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_media_health_changed', message);

/** The copy could not be proven to be the original. Also final. */
const unverified = (id: string, message: string) =>
  outcome(id, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_media_health_unverified', message);

/** Something went wrong that may not happen again (a busy disk, a timeout): retried once. */
const transient = (id: string, message: string) =>
  outcome(id, MediaOperationItemStatus.Failed, 'frameleaf_bulk_reason_failed', message);

@Injectable()
export class MediaHealthService {
  constructor(
    private logger: LoggingRepository,
    private assetRepository: AssetRepository,
    private cryptoRepository: CryptoRepository,
    private eventRepository: EventRepository,
    private forkSchemaRepository: AssetChecksumRepository,
    private jobRepository: JobRepository,
    private libraryRepository: LibraryRepository,
    private mediaHealthRepository: MediaHealthRepository,
    private mediaRepository: MediaRepository,
    private physicalFileRepository: PhysicalFileRepository,
    private storageRepository: StorageRepository,
    private userRepository: UserRepository,
    private integrityService: MediaIntegrityService,
    private configRepository: ConfigRepository,
    private mediaOperationRepository: MediaOperationRepository,
    private mediaOperationService: MediaOperationService,
    private cronRepository: CronRepository,
    private databaseRepository: DatabaseRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private cloudBackupService: CloudBackupService,
    private sessionRepository: SessionRepository,
  ) {
    this.logger.setContext(MediaHealthService.name);
  }

  private scheduleLock = false;

  /** The Library care settings (FL-69, settings-catalog.mjs:905-977) as saved now. */
  async careSettings({ withCache = true }: { withCache?: boolean } = {}) {
    const config = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache },
    );
    return config.libraryCare;
  }

  /**
   * "Schedule incremental health scans" (Library care → Media health & integrity). One server holds
   * the schedule, as the integrity checks do; each tick starts every account's durable scan.
   */
  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit({ newConfig: { libraryCare } }: ArgOf<'ConfigInit'>) {
    this.scheduleLock = await this.databaseRepository.tryLock(DatabaseLock.LibraryCareSchedule);
    if (!this.scheduleLock) {
      return;
    }
    this.cronRepository.create({
      name: LIBRARY_CARE_HEALTH_SCAN_CRON,
      expression: libraryCare.healthScanCronExpression,
      onTick: () => handlePromiseError(this.startScheduledScans(), this.logger),
      // FL-363: the overnight schedule's "Check files" step starts the health scans
      start: false,
    });
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { libraryCare } }: ArgOf<'ConfigUpdate'>) {
    if (!this.scheduleLock) {
      return;
    }
    this.cronRepository.update({
      name: LIBRARY_CARE_HEALTH_SCAN_CRON,
      expression: libraryCare.healthScanCronExpression,
      // FL-363: the overnight schedule's "Check files" step starts the health scans
      start: false,
    });
  }

  /**
   * Start every account's scheduled health scan (FL-69). Incremental: an account whose last scan
   * completed is scanned for what changed since that scan began; one never scanned, or whose last
   * full scan is older than `LIBRARY_CARE_FULL_SCAN_INTERVAL_MS`, is scanned in full, so files
   * removed or damaged without any change to their records are found too. Each is the same durable, checkpointed job as "Scan again", so an interrupted scan carries
   * on from its checkpoint, and an account with a scan already open keeps it instead of getting a
   * second one (a scan somebody paused stays paused). Returns how many accounts have a scan.
   */
  async startScheduledScans(): Promise<number> {
    const { healthScan } = await this.careSettings({ withCache: false });
    if (!healthScan) {
      return 0;
    }
    let scheduled = 0;
    for (const user of await this.userRepository.getList()) {
      try {
        const changedSince = await this.incrementalScanStart(user.id);
        await this.mediaHealthRepository.withLibraryCareLock(user.id, () =>
          this.admitDurableScan(user.id, { changedSince, scheduled: true }),
        );
        scheduled++;
      } catch (error) {
        this.logger.warn(`Scheduled Library Care scan for ${user.id} was not started: ${getErrorMessage(error)}`);
      }
    }
    return scheduled;
  }

  /**
   * Where the account's next scheduled scan starts from: the start of its last completed scan, or
   * undefined for a full scan (never scanned, or no full scan completed within the interval).
   */
  private async incrementalScanStart(ownerId: string): Promise<string | undefined> {
    const { lastScanAt, lastFullScanAt } = await this.lastCompletedScans(ownerId);
    if (!lastScanAt || !lastFullScanAt) {
      return undefined;
    }
    return Date.now() - new Date(lastFullScanAt).getTime() >= LIBRARY_CARE_FULL_SCAN_INTERVAL_MS
      ? undefined
      : lastScanAt;
  }

  /** When the account's last completed scan, and its last completed full scan, were started. */
  private async lastCompletedScans(ownerId: string): Promise<{ lastScanAt?: string; lastFullScanAt?: string }> {
    const { items } = await this.mediaOperationRepository.list({
      ownerId,
      kind: MediaOperationKind.MediaHealth,
      statuses: [MediaOperationStatus.Completed],
      includeDismissed: true,
      take: 20,
      skip: 0,
    });
    let lastScanAt: string | undefined;
    for (const operation of items) {
      try {
        const snapshot = parseMediaHealthSnapshot(operation.snapshot);
        // a scan of chosen photos (FL-737) says nothing about the rest of the library
        if (snapshot.mode !== 'scan' || snapshot.assetIds) {
          continue;
        }
        const startedAt = asDateTimeString(operation.createdAt as unknown as Date);
        lastScanAt ??= startedAt;
        if (!snapshot.changedSince) {
          return { lastScanAt, lastFullScanAt: startedAt };
        }
      } catch {
        // an unreadable snapshot is not a scan this can count from
      }
    }
    // No full scan among the recent ones: the next one is full.
    return { lastScanAt };
  }

  async list(auth: AuthDto, dto: MediaHealthListQueryDto): Promise<MediaHealthListResponseDto> {
    const size = dto.size ?? MEDIA_HEALTH_PAGE_SIZE;
    const privacy = this.privacyFor(auth);
    const { ownerId } = this.scopeFor(auth, dto);
    const listOptions = {
      category: dto.category,
      ownerId,
      privacy,
      status: dto.status,
      ...(dto.needsAttention && { statuses: NEEDS_ATTENTION_MEDIA_HEALTH_STATUSES }),
    };
    const [findings, total, run] = await Promise.all([
      this.mediaHealthRepository.list({
        ...listOptions,
        size,
        offset: ((dto.page ?? 1) - 1) * size,
      }),
      this.mediaHealthRepository.count(listOptions),
      this.mediaHealthRepository.getLatestRun(dto.category, ownerId ?? auth.user.id),
    ]);
    const [assets, candidates, sidecars] = await Promise.all([
      this.mediaHealthRepository.getAssets(
        findings.map(({ assetId }) => assetId),
        ownerId,
        privacy,
      ),
      this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id)),
      this.mediaHealthRepository.getAssetChecksums(findings.map(({ assetId }) => assetId)),
    ]);

    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const sidecarByAsset = new Map(sidecars.map((sidecar) => [sidecar.assetId, sidecar]));
    const candidatesByHealthId = this.groupCandidates(candidates);
    const rootsByOwner = await this.ownerRoots(assets.map(({ ownerId }) => ownerId));
    const searchRoots = await this.searchRoots();
    const buckets = new Map<string, MediaHealthListResponseDto['buckets'][number]>();

    for (const finding of findings) {
      const asset = assetById.get(finding.assetId);
      if (!asset) {
        continue;
      }

      // A path is shown within the finding owner's own storage (or their external library); a path in
      // somebody else's folder is described, never printed.
      const candidateRoots = rootsByOwner.get(asset.ownerId) ?? [];
      const isOwnedPath = asset.isExternal || this.isPathWithinRoots(finding.originalPath, candidateRoots);
      const originalPath = isOwnedPath ? finding.originalPath : 'Managed file in another user directory';
      const timeBucket = asset.localDateTime.toISOString().slice(0, 10);
      const bucket = buckets.get(timeBucket) ?? { timeBucket, count: 0, items: [] };
      const chosenCandidateId = (finding.resolution as Record<string, unknown> | null)?.chosenCandidateId;
      const evidence = this.findingEvidenceFor(finding.evidence, asset.isExternal ? null : candidateRoots, auth);
      bucket.items.push({
        id: finding.id,
        assetId: finding.assetId,
        category: finding.category,
        status: finding.status,
        severity: finding.severity,
        originalPath,
        originalFileName: finding.originalFileName,
        evidence,
        resolution: finding.resolution,
        checkedAt: asDateTimeString(finding.checkedAt),
        dismissedAt: finding.dismissedAt ? asDateTimeString(finding.dismissedAt) : null,
        resolvedAt: finding.resolvedAt ? asDateTimeString(finding.resolvedAt) : null,
        asset: mapAsset(isOwnedPath ? asset : { ...asset, originalPath }, { auth }),
        candidates: (candidatesByHealthId.get(finding.id) ?? []).map((candidate) =>
          this.mapCandidateForRoots(
            candidate,
            asset.isExternal ? null : candidateRoots,
            searchRoots,
            chosenCandidateId === candidate.id,
            auth,
          ),
        ),
        expectedChecksums: expectedChecksums(asset, sidecarByAsset.get(asset.id)),
        provenance: this.provenanceFor(evidence, finding, searchRoots),
      });
      bucket.count = bucket.items.length;
      buckets.set(timeBucket, bucket);
    }

    return { buckets: buckets.values().toArray(), total, run: run ? this.mapRun(run) : null };
  }

  /**
   * Library Care's queues and the state of the latest scan or search (FL-69).
   *
   * Counts use the list's own scope and privacy, so a number never reveals an item the list would
   * hide: another account's Locked media is never counted, and the reader's own only in their
   * unlocked session. The scan and recent jobs are always the reader's own; jobs are never shared.
   */
  async summary(auth: AuthDto, dto: MediaHealthSummaryQueryDto): Promise<MediaHealthSummaryResponseDto> {
    const privacy = this.privacyFor(auth);
    const { ownerId } = this.scopeFor(auth, dto);
    const runOwner = ownerId ?? auth.user.id;
    await this.releaseStaleTrashQueue();
    const [byStatus, duplicates, importReview, enrichmentPending, missingRun, corruptRun, jobs, bulk, care] =
      await Promise.all([
        this.mediaHealthRepository.countByStatus({ ownerId, privacy }),
        this.mediaHealthRepository.countDuplicateGroups({ ownerId, privacy }),
        // Import review is per account; across every account there is no single queue to open.
        ownerId ? this.mediaHealthRepository.countImportReview(ownerId) : Promise.resolve(null),
        this.mediaHealthRepository.countPendingMetadata({ ownerId, privacy }),
        this.mediaHealthRepository.getLatestRun(MediaHealthCategory.Missing, runOwner),
        this.mediaHealthRepository.getLatestRun(MediaHealthCategory.Corrupt, runOwner),
        this.mediaOperationRepository.list({
          ownerId: auth.user.id,
          kind: MediaOperationKind.MediaHealth,
          includeDismissed: true,
          take: 10,
          skip: 0,
        }),
        this.mediaOperationRepository.list({
          ownerId: auth.user.id,
          kind: MediaOperationKind.Bulk,
          includeDismissed: true,
          take: 30,
          skip: 0,
        }),
        this.careSettings(),
      ]);

    const countOf = (category: MediaHealthCategory, statuses: MediaHealthStatus[]) =>
      byStatus
        .filter((row) => row.category === category && statuses.includes(row.status))
        .reduce((sum, row) => sum + row.count, 0);

    const latest = jobs.items[0];
    const runs =
      runOwner === auth.user.id
        ? await this.settleStaleRuns(latest, [missingRun, corruptRun])
        : [missingRun, corruptRun];
    const recent = [...jobs.items, ...bulk.items]
      .map((operation) => this.mapActivity(operation))
      .filter((item): item is MediaHealthActivityResponse => item !== null)
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 8);

    return {
      queues: {
        missing: countOf(MediaHealthCategory.Missing, [
          MediaHealthStatus.Missing,
          MediaHealthStatus.Candidate,
          MediaHealthStatus.Found,
        ]),
        missingVerified: countOf(MediaHealthCategory.Missing, [MediaHealthStatus.Found]),
        damagedConfirmed: countOf(MediaHealthCategory.Corrupt, [
          MediaHealthStatus.CorruptConfirmed,
          MediaHealthStatus.TrashQueued,
        ]),
        damagedSuspected: countOf(MediaHealthCategory.Corrupt, [MediaHealthStatus.CorruptSuspect]),
        unsupportedRaw: countOf(MediaHealthCategory.Corrupt, [MediaHealthStatus.UnsupportedRaw]),
        duplicates,
        importReview,
        enrichmentPending,
      },
      care: {
        healthScan: care.healthScan,
        checksumScan: care.checksumScan,
        integrityAudit: care.integrityAudit,
        rawRecovery: care.rawRecovery,
        duplicateReview: care.duplicateReview,
      },
      operation: latest ? this.mapOperationState(latest) : null,
      runs: {
        missing: runs[0] ? this.mapRun(runs[0]) : null,
        corrupt: runs[1] ? this.mapRun(runs[1]) : null,
      },
      recent,
      recoveryAvailable: auth.user.isAdmin && this.recoveryRoots().length > 0,
    };
  }

  /**
   * The locations a reader may search (FL-69). Everyone may search library storage and their own
   * external libraries. Recovery locations and other accounts' libraries are an administrator's:
   * they are server mounts, and their folder names are operator detail.
   */
  async getRoots(auth: AuthDto): Promise<MediaHealthRootsResponseDto> {
    const user = await this.userRepository.get(auth.user.id, {});
    const managedPaths = user
      ? [StorageCore.getFolderLocation(StorageFolder.Upload, user.id), StorageCore.getLibraryFolder(user)]
      : [];
    const roots: MediaHealthRootResponse[] = [
      { id: MANAGED_ROOT_ID, kind: 'managed', label: 'Library storage', paths: [...new Set(managedPaths)] },
    ];

    const libraries = await this.libraryRepository.getAll();
    for (const library of libraries) {
      if (library.ownerId === auth.user.id || auth.user.isAdmin) {
        roots.push({ id: libraryRootId(library.id), kind: 'library', label: library.name, paths: library.importPaths });
      }
    }

    if (auth.user.isAdmin) {
      for (const root of this.recoveryRoots()) {
        roots.push({ id: root.id, kind: 'recovery', label: root.label, paths: root.paths });
      }
    }

    return { roots };
  }

  /**
   * Record which verified copy a missing original should be relinked to (FL-69), when a search
   * found it in more than one place. Only exact checksum matches can be chosen; the choice is
   * checked again, with the file read again, when the relink runs.
   */
  async chooseCandidates(auth: AuthDto, dto: MediaHealthChooseCandidatesDto): Promise<MediaHealthBulkResponseDto> {
    const findings = await this.findingsFor(
      auth,
      dto.choices.map(({ findingId }) => findingId),
    );
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const candidates = this.groupCandidates(
      await this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id)),
    );

    const results: MediaHealthBulkResponseDto['results'] = [];
    for (const choice of dto.choices) {
      const finding = findingById.get(choice.findingId);
      const candidate = (candidates.get(choice.findingId) ?? []).find(({ id }) => id === choice.candidateId);
      if (!finding || finding.category !== MediaHealthCategory.Missing) {
        results.push({ id: choice.findingId, success: false, error: 'Finding is not available' });
        continue;
      }
      if (!candidate || candidate.status !== MediaHealthStatus.Found) {
        results.push({ id: choice.findingId, success: false, error: 'Only a verified exact copy can be chosen' });
        continue;
      }
      if (!auth.user.isAdmin && this.candidateRootKind(candidate) === 'recovery') {
        results.push({ id: choice.findingId, success: false, error: 'Location not available' });
        continue;
      }
      const saved = await this.mediaHealthRepository.setChosenCandidate(finding.id, candidate.id);
      results.push(
        saved
          ? { id: finding.id, success: true, status: finding.status }
          : { id: finding.id, success: false, error: 'Candidate changed; search again' },
      );
    }

    return { results };
  }

  /** An interactive read's privacy: hidden-content settings, and Locked media only when elevated (FL-34). */
  private privacyFor(auth: AuthDto) {
    return { ...getHiddenContentQueryOptions(auth), ...getLockedVisibilityOptions(auth) };
  }

  /**
   * Whose findings a Library Care request covers (FL-69). Undefined means every account, which only
   * an administrator may ask for; so may reviewing one other account. Privacy is applied on top.
   */
  private scopeFor(auth: AuthDto, dto: { ownerId?: string; allAccounts?: boolean }): { ownerId?: string } {
    const other = dto.allAccounts === true || (!!dto.ownerId && dto.ownerId !== auth.user.id);
    if (other && !auth.user.isAdmin) {
      throw new ForbiddenException('Only an administrator can review another account');
    }
    if (dto.allAccounts) {
      return { ownerId: undefined };
    }
    return { ownerId: dto.ownerId ?? auth.user.id };
  }

  /**
   * A run left open by a job that ended without its worker (FL-69): cancelled while still queued or
   * paused, or failed by the lease sweep. With no Library Care job running for the account, an open
   * run is settled to how its job ended, so the scan bar never shows a scan running for ever.
   */
  private async settleStaleRuns(
    latest: MediaOperation | undefined,
    runs: Array<MediaHealthRun | undefined>,
  ): Promise<Array<MediaHealthRun | undefined>> {
    if (latest && ACTIVE_MEDIA_OPERATION_STATUSES.includes(latest.status as MediaOperationStatus)) {
      return runs;
    }
    const cancelled = latest?.status === MediaOperationStatus.Cancelled;
    return Promise.all(
      runs.map(async (run) => {
        if (!run || !OPEN_RUN_STATES.has(run.status)) {
          return run;
        }
        const settled = await this.mediaHealthRepository.finishRun(run.id, {
          status: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? null : (latest?.error ?? 'The job stopped before it finished'),
        });
        return settled ?? run;
      }),
    );
  }

  /** Release findings a trash job no longer holds (FL-69); see `releaseTrashQueued`. */
  private async releaseStaleTrashQueue() {
    const held = await this.mediaHealthRepository.getActiveTrashFindingIds();
    await this.mediaHealthRepository.releaseTrashQueued({
      keep: held,
      olderThan: new Date(Date.now() - TRASH_QUEUE_GRACE_MS),
    });
  }

  /**
   * The findings a request may act on: the reader's own, or — for an administrator — any account's.
   * Always with the reader's privacy, so another account's Locked media is never reachable here.
   */
  private findingsFor(auth: AuthDto, ids: string[]): Promise<MediaHealthFinding[]> {
    const ownerId = auth.user.isAdmin ? undefined : auth.user.id;
    return this.mediaHealthRepository.getByIds(ids, ownerId, this.privacyFor(auth));
  }

  /** Each owner's own storage folders, for deciding which paths may be printed. */
  private async ownerRoots(ownerIds: string[]): Promise<Map<string, string[]>> {
    const roots = new Map<string, string[]>();
    for (const ownerId of new Set(ownerIds)) {
      const user = await this.userRepository.get(ownerId, {});
      roots.set(ownerId, [
        StorageCore.getFolderLocation(StorageFolder.Upload, ownerId),
        StorageCore.getLibraryFolder({ id: ownerId, storageLabel: user?.storageLabel ?? null }),
      ]);
    }
    return roots;
  }

  /** The operator's recovery locations, as search roots. */
  private recoveryRoots(): MediaHealthRoot[] {
    return (this.configRepository.getEnv().storage.recoveryRoots ?? []).map((root) => ({
      id: recoveryRootId(root.path),
      kind: 'recovery' as const,
      label: root.label,
      paths: [root.path],
    }));
  }

  /**
   * Every location a candidate can come from, for attributing a path to its root: library storage of
   * every account, every external library and every recovery location. Used by background work and
   * for labelling; what a reader may search is `getRoots`.
   */
  private async searchRoots(): Promise<MediaHealthRoot[]> {
    const [users, libraries] = await Promise.all([this.userRepository.getList(), this.libraryRepository.getAll()]);
    return [
      {
        id: MANAGED_ROOT_ID,
        kind: 'managed',
        label: 'Library storage',
        paths: [
          ...new Set(
            users.flatMap((user) => [
              StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
              StorageCore.getLibraryFolder(user),
            ]),
          ),
        ],
      },
      ...libraries.map((library) => ({
        id: libraryRootId(library.id),
        kind: 'library' as const,
        label: library.name,
        paths: library.importPaths,
      })),
      ...this.recoveryRoots(),
    ];
  }

  private mapOperationState(operation: MediaOperation): MediaHealthOperationDto {
    const snapshot = operation.snapshot as Record<string, unknown> | null;
    const iso = (value: unknown) => (value ? asDateTimeString(value as Date) : null);
    return {
      id: operation.id,
      mode: snapshot?.mode === 'locate' ? 'locate' : 'scan',
      status: operation.status as MediaOperationStatus,
      progress: operation.progress,
      processedUnits: Number(operation.processedUnits ?? 0),
      totalUnits:
        operation.totalUnits === null || operation.totalUnits === undefined ? null : Number(operation.totalUnits),
      pauseRequestedAt: iso(operation.pauseRequestedAt),
      cancelRequestedAt: iso(operation.cancelRequestedAt),
      autoRetries: operation.autoRetries ?? 0,
      error: operation.error,
      createdAt: asDateTimeString(operation.createdAt as unknown as Date),
      updatedAt: asDateTimeString(operation.updatedAt as unknown as Date),
      finishedAt: iso(operation.finishedAt),
    };
  }

  private mapActivity(operation: MediaOperation): MediaHealthActivityResponse | null {
    const action = mediaHealthActivityAction(operation.kind as MediaOperationKind, operation.snapshot);
    if (!action) {
      return null;
    }
    return {
      id: operation.id,
      action: action as MediaHealthActivityResponse['action'],
      status: operation.status as MediaOperationStatus,
      items: Number(operation.totalUnits ?? 0),
      createdAt: asDateTimeString(operation.createdAt as unknown as Date),
      finishedAt: operation.finishedAt ? asDateTimeString(operation.finishedAt as unknown as Date) : null,
    };
  }

  /**
   * `resumeFrom`: where a stopped full scan got to (library setup's Retry). The new scan carries on from its cursor
   * and counts instead of reading every original again.
   */
  async startMissingScan(
    auth: AuthDto,
    dto?: MediaHealthScanDto,
    resumeFrom?: MediaHealthScanResult,
  ): Promise<MediaHealthScanResponseDto> {
    const { missingRunId, operationId } = await this.startDurableScan(auth, dto, resumeFrom);
    return { runId: missingRunId, operationId };
  }

  async startCorruptScan(auth: AuthDto, dto?: MediaHealthScanDto): Promise<MediaHealthScanResponseDto> {
    const { corruptRunId, operationId } = await this.startDurableScan(auth, dto);
    return { runId: corruptRunId, operationId };
  }

  /**
   * Search chosen locations for exact copies of these originals (FL-69), as a durable job.
   *
   * The search runs in bounded steps and records where the directory walk has got to after every
   * one, so it can be paused, survives a restart and is retried once by itself. Recovery locations
   * are an administrator's; so are other accounts' findings. Nothing is changed but the candidate
   * list: relinking or recovering is a separate, reviewed step.
   */
  async locateMissing(
    auth: AuthDto,
    dto: MediaHealthLocateDto,
    lookIn?: MediaHealthLocateSnapshot['lookIn'],
  ): Promise<MediaHealthScanResponseDto> {
    const findings = await this.findingsFor(auth, dto.ids);
    const eligible = findings.filter(
      (finding) =>
        finding.category === MediaHealthCategory.Missing ||
        (finding.category === MediaHealthCategory.Corrupt && finding.status === MediaHealthStatus.CorruptConfirmed),
    );
    if (eligible.length === 0) {
      throw new BadRequestException('Choose missing originals or confirmed damage to search for');
    }
    // Library care → "Suggest recoverable RAW sources": off, RAW originals are not searched for.
    const { rawRecovery } = await this.careSettings();
    const searchable = rawRecovery
      ? eligible
      : eligible.filter((finding) => !mimeTypes.isRaw(finding.originalFileName));
    if (searchable.length === 0) {
      throw new BadRequestException('Searching for RAW sources is turned off in Library care settings');
    }

    const rootIds = dto.rootIds ? [...new Set(dto.rootIds)] : null;
    if (rootIds) {
      const allowed = new Set((await this.getRoots(auth)).roots.map(({ id }) => id));
      if (rootIds.some((id) => !allowed.has(id))) {
        throw new ForbiddenException('One of the chosen locations is not available to you');
      }
    }

    const owners = await this.mediaHealthRepository.getAssets(
      searchable.map(({ assetId }) => assetId),
      auth.user.isAdmin ? undefined : auth.user.id,
      this.privacyFor(auth),
    );
    const anyOwner = owners.some(({ ownerId }) => ownerId !== auth.user.id);

    // A search of damaged media is recorded on the damaged-media runs, a search of missing on missing.
    const category = searchable.every(({ category }) => category === MediaHealthCategory.Corrupt)
      ? MediaHealthCategory.Corrupt
      : MediaHealthCategory.Missing;
    return this.mediaHealthRepository.withLibraryCareLock(auth.user.id, async () => {
      await this.requireNoActiveJob(auth.user.id);
      const run = await this.mediaHealthRepository.createRun(category, auth.user.id);
      const snapshot: MediaHealthOperationSnapshot = {
        mode: 'locate',
        userId: auth.user.id,
        runId: run.id,
        findingIds: searchable.map(({ id }) => id),
        rootIds,
        anyOwner,
        ...(lookIn && { lookIn }),
      };
      try {
        const operation = await this.createHealthOperation(auth.user.id, snapshot, searchable.length);
        return { runId: run.id, operationId: operation.id };
      } catch (error) {
        await this.mediaHealthRepository.finishRun(run.id, { status: 'failed', error: getErrorMessage(error) });
        throw error;
      }
    });
  }

  async dismiss(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<void> {
    const findings = await this.findingsFor(auth, dto.ids);
    // The owner filter is already in `findingsFor`; an administrator's dismissal is not repeated per owner.
    await this.mediaHealthRepository.markDismissed(
      findings.map(({ id }) => id),
      auth.user.isAdmin ? undefined : auth.user.id,
    );
  }

  /**
   * Undo (FL-69, UT-2; UtilitiesManager.jsx:295-320): put findings back in review.
   *
   * A dismissal is undone to the status the finding had, which the dismissal recorded. Damage moved
   * to the trash is reopened as confirmed damage only once its item is back out of the trash (the
   * page restores it first) and no trash job still holds it. Nothing else is reopened: a relink or a
   * recovery changed the original, and undoing that is a new, reviewed repair, not a status change.
   */
  async reopen(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<MediaHealthBulkResponseDto> {
    const findings = await this.findingsFor(auth, dto.ids);
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const [held, assets] = await Promise.all([
      this.mediaHealthRepository.getActiveTrashFindingIds(),
      this.mediaHealthRepository.getAssets(
        findings.map(({ assetId }) => assetId),
        auth.user.isAdmin ? undefined : auth.user.id,
        this.privacyFor(auth),
      ),
    ]);
    const heldIds = new Set(held);
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));

    const results: MediaHealthBulkResponseDto['results'] = [];
    for (const id of new Set(dto.ids)) {
      const finding = findingById.get(id);
      if (!finding) {
        results.push({ id, success: false, error: 'Finding is not available' });
        continue;
      }

      let to: MediaHealthStatus | undefined;
      let error = 'Only a dismissed finding, or damage restored from the trash, can be reopened';
      if (finding.status === MediaHealthStatus.Dismissed) {
        to = reopenedStatus((finding.resolution as Record<string, unknown> | null)?.dismissedFrom);
        error = 'This finding was dismissed before it could be undone; scan again to review it';
      } else if (
        finding.category === MediaHealthCategory.Corrupt &&
        (finding.status === MediaHealthStatus.Trashed || finding.status === MediaHealthStatus.TrashQueued)
      ) {
        const asset = assetById.get(finding.assetId);
        if (asset && !asset.deletedAt && !heldIds.has(finding.id)) {
          to = MediaHealthStatus.CorruptConfirmed;
        }
        error = 'Restore the item from the trash first';
      }

      if (!to) {
        results.push({ id, success: false, status: finding.status, error });
        continue;
      }
      const reopened = await this.mediaHealthRepository.reopenFinding(finding.id, finding.status, to);
      results.push(
        reopened
          ? { id, success: true, status: to }
          : { id, success: false, status: finding.status, error: 'The finding changed; refresh and try again' },
      );
    }
    return { results };
  }

  /**
   * Relink missing originals to their verified exact copy (FL-69), as a durable bulk job.
   *
   * Each finding must have one verified copy, or the one the reviewer chose among several. A copy in
   * library storage or the asset's own external library is linked where it is; a copy in a recovery
   * location is first published into library storage, never linked in place. The job re-reads and
   * re-verifies every file at the moment of change, retries a transient failure once, and appears in
   * Activity. Findings refused here are reported and not queued.
   */
  async relinkMissing(auth: AuthDto, dto: MediaHealthBulkActionDto): Promise<MediaHealthBulkResponseDto> {
    const findings = await this.findingsFor(auth, dto.ids);
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const candidates = this.groupCandidates(
      await this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id)),
    );

    const results: MediaHealthBulkResponseDto['results'] = [];
    const entries: BulkMediaHealthEntry[] = [];
    for (const id of new Set(dto.ids)) {
      const finding = findingById.get(id);
      if (!finding || finding.category !== MediaHealthCategory.Missing) {
        results.push({ id, success: false, error: 'Finding is not available' });
        continue;
      }
      const candidate = this.relinkCandidate(finding, candidates.get(finding.id) ?? [], auth);
      if (!candidate) {
        results.push({
          id,
          success: false,
          status: finding.status,
          error: 'Finding does not have exactly one validated candidate',
        });
        continue;
      }
      entries.push({ assetId: finding.assetId, findingId: finding.id, candidateId: candidate.id });
      results.push({ id, success: true, status: finding.status });
    }

    const operationId = await this.submitBulk(auth, MediaOperationBulkAction.RelinkMissingMedia, entries);
    return { results, operationId };
  }

  /**
   * Replace confirmed damage with a verified copy (FL-69), as a durable bulk job.
   *
   * Only `corrupt_confirmed` findings qualify: unsupported RAW and suspected damage are kept apart
   * and never replaced. The copy must match the original's recorded checksum exactly and decode;
   * it is published into library storage next to nothing it could overwrite, and the damaged file is
   * kept where it is, recorded on the finding. The reviewer confirms all of that explicitly.
   */
  async recoverDamaged(auth: AuthDto, dto: MediaHealthRecoverDto): Promise<MediaHealthBulkResponseDto> {
    if (!dto.confirmed) {
      throw new BadRequestException('Confirm the verified replacement and retention of the previous source');
    }

    const findings = await this.findingsFor(
      auth,
      dto.choices.map(({ findingId }) => findingId),
    );
    const findingById = new Map(findings.map((finding) => [finding.id, finding]));
    const candidates = this.groupCandidates(
      await this.mediaHealthRepository.getCandidatesByHealthIds(findings.map(({ id }) => id)),
    );

    const results: MediaHealthBulkResponseDto['results'] = [];
    const entries: BulkMediaHealthEntry[] = [];
    const seen = new Set<string>();
    for (const choice of dto.choices) {
      if (seen.has(choice.findingId)) {
        continue;
      }
      seen.add(choice.findingId);
      const finding = findingById.get(choice.findingId);
      if (
        !finding ||
        finding.category !== MediaHealthCategory.Corrupt ||
        finding.status !== MediaHealthStatus.CorruptConfirmed
      ) {
        results.push({ id: choice.findingId, success: false, error: 'Only confirmed damage can be replaced' });
        continue;
      }
      const candidate = (candidates.get(finding.id) ?? []).find(({ id }) => id === choice.candidateId);
      const evidence = (candidate?.evidence ?? {}) as Record<string, unknown>;
      if (!candidate || candidate.status !== MediaHealthStatus.Found || evidence.decodeValid !== true) {
        results.push({
          id: finding.id,
          success: false,
          status: finding.status,
          error: 'Replacement requires an exact checksum and successful decode validation',
        });
        continue;
      }
      const kind = this.candidateRootKind(candidate);
      if (kind === 'library' || (kind === 'recovery' && !auth.user.isAdmin)) {
        results.push({ id: finding.id, success: false, status: finding.status, error: 'Location not available' });
        continue;
      }
      // The reviewer's choice is recorded on the finding: with several exact copies, the recovery
      // commits only the one that was reviewed.
      if (!(await this.mediaHealthRepository.setChosenCandidate(finding.id, candidate.id))) {
        results.push({ id: finding.id, success: false, status: finding.status, error: 'Candidate changed' });
        continue;
      }
      entries.push({ assetId: finding.assetId, findingId: finding.id, candidateId: candidate.id });
      results.push({ id: finding.id, success: true, status: finding.status });
    }

    const operationId = await this.submitBulk(auth, MediaOperationBulkAction.RecoverDamagedMedia, entries);
    return { results, operationId };
  }

  /**
   * Repair a damaged JPEG and show the result, changing nothing. The repair is deterministic, so the
   * reviewer approves it by its checksum and `repair` makes exactly that file the original.
   */
  async previewRepair(auth: AuthDto, dto: MediaHealthRepairPreviewDto): Promise<MediaHealthRepairPreviewResponseDto> {
    const findingId = dto.findingId ?? (await this.damageFindingFor(auth, dto.assetId!));
    const { finding, asset } = await this.repairTarget(auth, findingId);
    return this.withRepair(asset, async ({ output, preview, method, width, height, metadataKept }) => {
      const digests = await this.cryptoRepository.hashFileDigests(output);
      const bytes = await this.storageRepository.readFile(preview);
      return {
        findingId: finding.id,
        method,
        width,
        height,
        sizeInBytes: digests.sizeInBytes,
        checksum: digests.sha1.toString('hex'),
        preview: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        metadataKept,
      };
    });
  }

  /**
   * Replace a damaged JPEG with the repair its reviewer saw. The repair runs again from the damaged
   * file and must give the same checksum; it is published into the hidden Library Care folder, the
   * asset points at it, and the damaged file is kept there too (as a recovery keeps it).
   */
  async repair(auth: AuthDto, dto: MediaHealthRepairDto): Promise<MediaHealthRepairResponseDto> {
    const { finding, asset } = await this.repairTarget(auth, dto.findingId);
    const { method, after } = await this.withRepair(asset, async (repaired) => {
      const { output, method } = repaired;
      const digests = await this.cryptoRepository.hashFileDigests(output);
      if (digests.sha1.toString('hex') !== dto.checksum) {
        throw new ConflictException('The repair changed since it was reviewed; preview it again');
      }
      let published: { committed: boolean; destination: string };
      try {
        // FL-1337: the reviewed repair records the same history and state as the automatic one
        published = await this.publishRepair(
          asset,
          finding,
          { output, digests },
          {
            provenance: { recoveredBy: auth.user.id, repairMethod: method, recoveredAt: new Date().toISOString() },
            ...this.repairRecord(repaired, auth.user.name),
          },
        );
      } catch (error) {
        if (isAssetChecksumConstraint(error)) {
          throw new ConflictException('This library already has a photo identical to the repaired one');
        }
        throw error;
      }
      if (!published.committed) {
        // left unreferenced in the hidden folder; the same repair reuses it
        throw new ConflictException('The photo changed while it was being repaired');
      }
      return { method, after: { originalPath: published.destination, checksum: digests.sha256.toString('hex') } };
    });
    await this.retainDamagedOriginal(finding.id, this.keptDamaged(after));
    await this.queueRelinkJobs(asset.id);
    return { findingId: finding.id, assetId: asset.id, method };
  }

  /**
   * How a repair leaves its finding and the history it adds (FL-1337), the same for the reviewed repair
   * (with who did it) and the automatic one: `repaired` with how much was saved, and `fixState` `repaired`
   * or `part-saved`. A person's `autoRepairDeclined` is left as it is.
   */
  private repairRecord(
    { method, percentSaved, metadataKept }: Pick<RepairOutcome, 'method' | 'percentSaved' | 'metadataKept'>,
    by?: string,
  ): { fixState: 'repaired' | 'part-saved'; evidence: Record<string, unknown>; steps: FindingStep[] } {
    const result = repairResult({ method, percentSaved });
    const fixState = result.partSaved ? 'part-saved' : 'repaired';
    return {
      fixState,
      evidence: { fixState, partSaved: result.partSaved },
      steps: [
        {
          step: 'repaired',
          outcome: 'ok',
          facts: {
            method,
            ...(result.percentSaved !== undefined && { percentSaved: result.percentSaved }),
            metadataLost: !metadataKept,
            ...(by && { by }),
          },
        },
      ],
    };
  }

  /** The step for a repair's damaged file once it is in its kept place, with what Undo needs (FL-1337). */
  private keptDamaged(after: { originalPath: string; checksum: string }) {
    return (retainedPath: string): FindingStep => ({
      step: 'kept-damaged',
      outcome: 'info',
      undo: { kind: 'repair', previousPath: retainedPath, ...after },
    });
  }

  /**
   * Make a repaired JPEG the asset's original (FL-1273), for the reviewed repair and (FL-1337) the
   * automatic one alike. It is published into the hidden Library Care folder under a name fixed by the
   * asset, the finding and the repair's checksum, so the same repair reuses its own copy, and never over
   * anything; the damaged file is kept as `retainedPath`. `committed` is false when the asset or finding
   * changed meanwhile, and the copy is left unreferenced. A checksum-constraint error is the caller's.
   */
  private async publishRepair(
    asset: MediaHealthAsset,
    finding: Pick<MediaHealthFinding, 'id'>,
    { output, digests }: { output: string; digests: FileDigests },
    record: Pick<ReplaceRepairedOriginal, 'provenance' | 'evidence' | 'steps'>,
  ): Promise<{ committed: boolean; destination: string }> {
    const destination = this.libraryCarePath(
      asset,
      `${asset.id}-${finding.id}-${digests.sha1.toString('hex').slice(0, 8)}.jpg`,
    );
    if (!(await this.canReach(destination))) {
      // F2: never into the empty mount point of the Upload drive, which would hide the repair once it is back
      throw new ServiceUnavailableException(COPIES_DRIVE_AWAY);
    }
    await publishVerifiedCopy({
      source: output,
      destination,
      expected: digests,
      hash: (filePath) => this.cryptoRepository.hashFileDigests(filePath),
    });
    const stat = await this.storageRepository.stat(destination);
    const committed = await this.mediaHealthRepository.replaceRepairedOriginal({
      assetId: asset.id,
      ownerId: asset.ownerId,
      healthId: finding.id,
      expectedUpdateId: asset.updateId,
      expectedChecksumAlgorithm: asset.checksumAlgorithm,
      expectedOriginalPath: asset.originalPath,
      expectedChecksum: asset.checksum,
      originalPath: destination,
      originalFileName: asset.originalFileName,
      ...digests,
      fileModifiedAt: stat.mtime,
      ...record,
      verifyCandidate: () => this.cryptoRepository.hashFileDigests(destination).catch((): undefined => {}),
    });
    return { committed, destination };
  }

  /**
   * The photo viewer's way in: check the photo now and record what is wrong with it, so a photo that
   * only failed when its thumbnail was made can be repaired without waiting for a scan.
   */
  private async damageFindingFor(auth: AuthDto, assetId: string): Promise<string> {
    const [asset] = await this.mediaHealthRepository.getAssets([assetId]);
    if (!asset || asset.deletedAt) {
      throw new BadRequestException('The photo is gone or in the trash');
    }
    this.requireRepairable(auth, asset);
    if (await this.isEncryptedOriginal(asset)) {
      throw new BadRequestException('The original is encrypted in Locked');
    }
    const result = await this.validateAssetIntegrity(asset, { keepBusy: true });
    if (result && 'busy' in result) {
      throw new BadRequestException("Frameleaf couldn't check this photo just now. Try again in a few minutes.");
    }
    if (result?.status === MediaHealthStatus.Missing) {
      throw new BadRequestException('The original file is missing');
    }
    if (result?.status !== MediaHealthStatus.CorruptConfirmed && result?.status !== MediaHealthStatus.CorruptSuspect) {
      throw new BadRequestException('This photo isn’t damaged, so there is nothing to repair');
    }
    const cause = await this.causeOf(asset, this.decoderMessage(result), await this.matchesStoredChecksum(asset));
    const finding = await this.ensureFinding(asset, MediaHealthCategory.Corrupt, checkedStep(cause), result);
    if (!finding) {
      throw new ConflictException('The photo changed while it was being checked; try again');
    }
    return finding.id;
  }

  /**
   * Record what is wrong with the asset now as its finding of this category, with the step that found
   * it (FL-1337): the auth-free core of the photo viewer's way in, and how the fix job records a problem
   * nothing recorded yet. The step starts a history only when no open finding of this category exists,
   * so asking again adds nothing twice. Undefined when the asset changed meanwhile.
   */
  private async ensureFinding(
    asset: MediaHealthAsset,
    category: MediaHealthCategory,
    first: FindingStep | undefined,
    verdict: Pick<CandidateValidation, 'status' | 'evidence' | 'resolution'>,
  ): Promise<MediaHealthFinding | undefined> {
    const known = (await this.mediaHealthRepository.getFindingsForAsset(asset.id)).some(
      (finding) => finding.category === category && isOpenFinding(finding),
    );
    return this.mediaHealthRepository.upsertFinding({
      runId: null,
      assetId: asset.id,
      expectedUpdateId: asset.updateId,
      category,
      status: verdict.status,
      severity:
        verdict.status === MediaHealthStatus.CorruptConfirmed || verdict.status === MediaHealthStatus.Missing
          ? MediaHealthSeverity.Critical
          : verdict.status === MediaHealthStatus.UnsupportedRaw
            ? MediaHealthSeverity.Info
            : MediaHealthSeverity.Warning,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      evidence: verdict.evidence,
      resolution: verdict.resolution,
      checkedAt: new Date(),
      dismissedAt: null,
      resolvedAt: null,
      steps: known || !first ? [] : [first],
    });
  }

  /** Who may repair which photo; the same rules for a finding and for the photo viewer. */
  private requireRepairable(auth: AuthDto, asset: MediaHealthAsset) {
    // Only the owner: a repair is approved by looking at it, and Library Care never shows anyone
    // another account's pictures. Even a lossless repair may have picked a different picture joined
    // to the file, so an administrator cannot approve one unseen.
    if (asset.ownerId !== auth.user.id) {
      throw new ForbiddenException('Only the photo’s owner can repair it');
    }
    if (!JPEG_REPAIR_EXTENSIONS.has(path.extname(asset.originalFileName).toLowerCase())) {
      throw new BadRequestException('Only JPEG photos can be repaired');
    }
    if (asset.isExternal) {
      throw new BadRequestException('Photos in an external library are repaired in their own folder');
    }
  }

  /** The damaged JPEG a repair may touch, held to the rules a recovery is held to. */
  private async repairTarget(auth: AuthDto, findingId: string) {
    const [finding] = await this.findingsFor(auth, [findingId]);
    if (
      !finding ||
      finding.category !== MediaHealthCategory.Corrupt ||
      (finding.status !== MediaHealthStatus.CorruptConfirmed && finding.status !== MediaHealthStatus.CorruptSuspect)
    ) {
      throw new BadRequestException('Only damaged media can be repaired');
    }
    const [asset] = await this.mediaHealthRepository.getAssets([finding.assetId]);
    if (!asset || asset.deletedAt) {
      throw new BadRequestException('The photo is gone or in the trash');
    }
    this.requireRepairable(auth, asset);
    if (await this.isEncryptedOriginal(asset)) {
      throw new BadRequestException('The original is encrypted in Locked');
    }
    return { finding, asset };
  }

  /**
   * Run the repair in the image worker into a temporary folder, removed afterwards. A repair that lost
   * the photo's details gets them back from the original where ExifTool can read them, so the date,
   * camera and place survive the metadata extraction that follows a replacement.
   */
  private async withRepair<T>(
    asset: MediaHealthAsset,
    use: (result: RepairOutcome & { output: string; preview: string }) => Promise<T>,
  ): Promise<T> {
    const folder = await this.storageRepository.mkdtemp('frameleaf-repair-');
    try {
      const output = path.join(folder, 'repaired.jpg');
      const preview = path.join(folder, 'preview.jpg');
      const metadataSource = path.join(folder, 'header.jpg');
      let result: JpegRepairResult;
      try {
        result = await this.mediaRepository.repairJpeg(asset.originalPath, output, preview, metadataSource);
      } catch (error) {
        this.logger.warn(`JPEG repair of ${asset.id} failed: ${getErrorMessage(error)}`);
        if (!(error instanceof SharpOperationError)) {
          // the image worker crashed, stalled or ran out of room: not a verdict on the photo (FL-1337)
          throw new ServiceUnavailableException(
            "Frameleaf couldn't repair this photo just now. Try again in a few minutes.",
          );
        }
        throw new BadRequestException('This photo could not be repaired');
      }
      // the file already decodes as it is: replacing it would only accept a changed file as the original
      const [repaired, original] = await Promise.all([
        this.cryptoRepository.hashFileDigests(output),
        this.cryptoRepository.hashFileDigests(asset.originalPath),
      ]);
      if (repaired.sha1.equals(original.sha1)) {
        throw new BadRequestException('This photo isn’t damaged, so there is nothing to repair');
      }
      const { metadataLost, ...outcome } = result;
      let metadataKept = true;
      if (metadataLost.length > 0) {
        const source = (await this.storageRepository.checkFileExists(metadataSource))
          ? metadataSource
          : asset.originalPath;
        for (const group of metadataLost) {
          metadataKept = (await this.mediaRepository.copyTagGroup(group, source, output)) && metadataKept;
        }
      }
      return await use({ ...outcome, metadataKept, output, preview });
    } finally {
      await this.storageRepository.unlinkDir(folder, { recursive: true, force: true });
    }
  }

  /**
   * FL-1337: check one damaged or missing file and fix what can be fixed without a person (design §3),
   * writing each step of its history as it goes. A failed preview, a file check, an import and a
   * person's Try again ask for it; one runs per photo at a time (`fix-<id>`).
   *
   * Safe to repeat: every write checks that the asset and its finding are still what was read, and a
   * file that is busy, on an unplugged drive or waiting on Cloud Backup puts the fix back with a delay
   * instead of guessing. Nothing is deleted: a repaired, relinked or restored photo keeps its previous
   * file, and the step that changed it records what Undo needs.
   *
   * A feed leaves a problem a fix already settled as it is (see `isSettledFeed`). The search by contents
   * is the owner's shared one (`MediaHealthLocateMissing` with `pending`), never one walk per photo: it
   * feeds the fix again, with `searched`, once its walk is complete.
   */
  @OnJob({ name: JobName.MediaHealthFixAsset, queue: QueueName.MediaHealth })
  async handleFixAsset(job: FixJob): Promise<JobStatus> {
    const [asset] = await this.mediaHealthRepository.getAssets([job.id]);
    if (!asset || asset.deletedAt) {
      return JobStatus.Skipped;
    }
    if (await this.jobRepository.isOtherFixRunning(asset.id)) {
      // one fix per photo at a time: a Try again (or a fix carrying on) waits for the one running to settle
      return this.putFixBack(job, { delay: FIX_RUNNING_WAIT_MS });
    }
    if (!(await this.canReach(asset.originalPath))) {
      // Review Focus 1: on an unplugged drive every file looks lost. Wait for it, recording nothing.
      return this.waitForDrive(job, asset);
    }
    const open = (await this.mediaHealthRepository.getFindingsForAsset(asset.id)).filter((finding) =>
      isOpenFinding(finding),
    );
    const exists = await this.storageRepository.checkFileExists(asset.originalPath, constants.R_OK);
    const category = exists ? MediaHealthCategory.Corrupt : MediaHealthCategory.Missing;
    if (
      this.isSettledFeed(
        job,
        open.find((finding) => finding.category === category),
      )
    ) {
      return JobStatus.Skipped;
    }
    // from here the fix has begun: a Keep or a Try again after this settles it when it carries on
    const started: FixJob = { ...job, startedAt: job.startedAt ?? new Date().toISOString() };
    const settings = await this.careSettings();
    return exists ? this.fixDamaged(started, asset, open, settings) : this.fixMissing(started, asset, open, settings);
  }

  /**
   * A feed the fix leaves alone (FL-1337): a check, preview or import asking about a problem a fix already
   * settled (apart from "couldn't check", which may be tried again), or the shared search's feed for a
   * finding already decided. A person's Try again always runs. A fix carrying on (after it began, a busy
   * retry or a later stage) is left alone once the owner chose Keep as it is, or someone chose Try again,
   * after it began: the later choice wins, and Try again starts a fix of its own. A fix that only waited
   * for a drive has done nothing yet, so it is still the feed that asked (F1): a problem settled meanwhile,
   * or a person's Keep, is left as it is.
   */
  private isSettledFeed(job: FixJob, finding?: MediaHealthFinding): boolean {
    const evidence = (finding?.evidence ?? {}) as Record<string, unknown>;
    if (job.startedAt || job.stage || (job.attempt ?? 0) > 0) {
      // a fix from before these times were kept began before every choice it can see
      const began = job.startedAt ? Date.parse(job.startedAt) : -Infinity;
      return [evidence.keptAt, evidence.retriedAt].some((at) => typeof at === 'string' && Date.parse(at) > began);
    }
    if (job.searched) {
      return !evidence.searchPending;
    }
    return job.from !== 'person' && typeof evidence.fixState === 'string' && evidence.fixState !== 'couldnt-check';
  }

  /** The file is there: find out what is wrong with it, then find its original, repair it or say so. */
  private async fixDamaged(
    job: FixJob,
    asset: MediaHealthAsset,
    open: MediaHealthFinding[],
    settings: Awaited<ReturnType<MediaHealthService['careSettings']>>,
  ): Promise<JobStatus> {
    if (await this.isEncryptedOriginal(asset)) {
      // FL-721: a sealed original is ciphertext; nothing here can call it damaged or repair it
      return JobStatus.Skipped;
    }
    // Whoever asked, the file itself is looked at now (F1): a preview's or a check's words are no verdict. A
    // preview can fail for reasons that are not the photo's, and a drive that was away is back.
    const result = await this.validateReadableAssetIntegrity(asset, { verifyChecksum: false });
    const verdict = result ? ('busy' in result ? result.candidate : result) : undefined;
    // gone between the two looks: as busy, the next try sees it missing
    const busy = !!result && ('busy' in result || result.status === MediaHealthStatus.Missing);
    // the decoder opened it: whatever is wrong is not in the picture
    const decoded = !busy && !verdict;
    // the words of whatever asked only say more about a file that will not open now
    const message = verdict ? (job.message ?? this.decoderMessage(verdict)) : '';
    const matches = busy ? null : await this.matchesStoredChecksum(asset);
    if (decoded) {
      await this.remakeLostPreviews(job, asset);
    }
    if (decoded && matches !== false) {
      // it opens, and it is the file Frameleaf stored: nothing is wrong with it now
      return this.settleHealthy(open);
    }

    const attempt = job.attempt ?? 0;
    let finding = open.find(({ category }) => category === MediaHealthCategory.Corrupt);
    const declined = (finding?.evidence as Record<string, unknown> | undefined)?.autoRepairDeclined === true;
    const next = (current: FileCause) =>
      nextFixAction({
        cause: current,
        attempt,
        autoRepair: settings.autoRepair,
        declined,
        repairableType: isJpegFileName(asset.originalFileName),
        writable: !asset.isExternal,
      });
    let cause: FileCause = busy ? 'busy' : decoded ? 'changed' : await this.causeOf(asset, message, matches, verdict);
    let action = next(cause);
    if (action === 'retry-later') {
      // busy is never a verdict: no finding and no step until it has had its three tries
      return this.retryBusy(job, attempt);
    }
    if (cause === 'busy' && !finding) {
      // three tries and it never opened or failed: busy never becomes damage, so nothing is recorded
      return JobStatus.Skipped;
    }

    // What was wrong starts the history once. A file check already wrote it for its own finding; a
    // preview's failure is news even then, but not again when this fix carries on. A changed file that
    // still opens has nothing to say here: it did open.
    const opening: FindingStep | undefined =
      cause === 'not-supported'
        ? {
            step: 'unsupported',
            outcome: 'info',
            facts: { extension: path.extname(asset.originalFileName).toLowerCase() },
          }
        : decoded
          ? undefined
          : { step: 'wont-open', outcome: 'failed', facts: { cause } };
    let lead: FindingStep[] = [];
    if (finding) {
      if (opening && (cause === 'not-supported' || (job.from === 'preview' && !job.stage && !job.searched))) {
        lead = [opening];
      }
    } else {
      finding = await this.ensureFinding(
        asset,
        MediaHealthCategory.Corrupt,
        opening,
        this.damageVerdict(cause, verdict, decoded),
      );
      if (!finding) {
        // the photo changed while it was checked: look again a little later, as for a busy file
        return attempt < BUSY_RETRY_DELAYS_MS.length ? this.retryBusy(job, attempt) : JobStatus.Skipped;
      }
    }

    if (action === 'find-original') {
      if (finding.status !== MediaHealthStatus.CorruptConfirmed) {
        // it is proven changed: the search for a verified replacement only looks for confirmed damage
        finding =
          (await this.mediaHealthRepository.upsertFinding({
            ...finding,
            expectedUpdateId: asset.updateId,
            status: MediaHealthStatus.CorruptConfirmed,
            severity: MediaHealthSeverity.Critical,
          })) ?? finding;
      }
      if ((await this.findOriginal(job, asset, finding, lead)) === 'done') {
        return JobStatus.Success;
      }
      lead = [];
      if (decoded) {
        // no stored original anywhere, and the picture opens: nothing to repair, so the person decides
        await this.settle(finding, 'cant-repair', [checkedStep('changed')]);
        return JobStatus.Success;
      }
      // no stored original anywhere: the file is all there is, so treat it for what is wrong with it
      cause = await this.causeOf(asset, message, null, verdict);
      action = next(cause);
    }

    // From here every try again goes straight to the treatment: what came before is recorded.
    const tryAgain = async () => {
      await this.mediaHealthRepository.appendSteps(this.stepsOf(finding, lead));
      return this.retryBusy(job, attempt, { stage: 'treat' });
    };
    switch (action) {
      case 'retry-later': {
        return tryAgain();
      }
      case 'leave-as-is': {
        await this.settle(finding, 'left-as-is', lead);
        return JobStatus.Success;
      }
      case 'repair': {
        const repaired = await this.repairAutomatically(finding, asset, lead);
        if (repaired === 'drive-away' && (job.waits ?? 0) < MAX_DRIVE_WAITS) {
          // F2: wait for the Upload drive like an unplugged one; what came before is recorded once
          await this.mediaHealthRepository.appendSteps(this.stepsOf(finding, lead));
          return this.waitForDrive(job, asset, { stage: 'treat' });
        }
        if (repaired === 'drive-away') {
          // a day without the drive: the person can try again once it is back
          await this.settle(finding, 'couldnt-check', [...lead, checkedStep('busy')]);
          return JobStatus.Success;
        }
        if (repaired === 'busy' && attempt < BUSY_RETRY_DELAYS_MS.length) {
          // the image worker crashed or the photo changed under the repair (Review Focus 2): try again
          return tryAgain();
        }
        if (repaired === 'busy') {
          await this.settle(finding, 'couldnt-check', [...lead, checkedStep('busy')]);
        } else if (repaired === 'not-repaired') {
          await this.settle(finding, 'cant-repair', [...lead, checkedStep(cause)]);
        }
        return JobStatus.Success;
      }
      default: {
        // Needs you: repair is off or declined, the file type has no repair, or it stayed busy
        await this.settle(finding, cause === 'busy' ? 'couldnt-check' : 'cant-repair', [...lead, checkedStep(cause)]);
        return JobStatus.Success;
      }
    }
  }

  /** The file is not on the drive: look for it by its contents, then in Cloud Backup, then ask phones. */
  private async fixMissing(
    job: FixJob,
    asset: MediaHealthAsset,
    open: MediaHealthFinding[],
    settings: Awaited<ReturnType<MediaHealthService['careSettings']>>,
  ): Promise<JobStatus> {
    let finding = open.find(({ category }) => category === MediaHealthCategory.Missing);
    if (!finding) {
      const roots = await this.ownerFolders(asset);
      finding = await this.ensureFinding(
        asset,
        MediaHealthCategory.Missing,
        { step: 'not-on-drive', outcome: 'failed', facts: folderFacts(roots, asset.originalPath) },
        {
          status: MediaHealthStatus.Missing,
          evidence: { reason: 'source_file_missing_or_unreadable' },
          resolution: { autoRelinkable: !!asset.isExternal && !!asset.libraryId },
        },
      );
      if (!finding) {
        return JobStatus.Skipped;
      }
    }
    if ((await this.findOriginal(job, asset, finding, [])) === 'done') {
      return JobStatus.Success;
    }
    // F4: phones are asked only for a photo they are shown (a checksum of its contents, not external, not Locked)
    if (!settings.askPhones || !(await this.mediaHealthRepository.isShownToPhones(asset.ownerId, asset.id))) {
      await this.settle(finding, 'missing', []);
      return JobStatus.Success;
    }
    const phones = await this.phonesToAsk(asset.ownerId);
    await (phones.length > 0
      ? this.settle(finding, 'waiting-phone', [
          { step: 'asked-phones', outcome: 'waiting', facts: { phones: phones.length } },
        ])
      : this.settle(finding, 'missing', [{ step: 'asked-phones', outcome: 'not-found' }]));
    return JobStatus.Success;
  }

  /**
   * Look for the stored original by its checksum and put back its one verified copy; otherwise ask
   * Cloud Backup for it (design §3 Missing 1-2, Damaged 2). The search is the owner's shared one: until
   * it has run, this only asks for it. `done` when the fix is settled, waiting for the search or put back
   * on its queue; `none` when nothing had it, with the search and the backups recorded.
   */
  private async findOriginal(
    job: FixJob,
    asset: MediaHealthAsset,
    finding: MediaHealthFinding,
    lead: FindingStep[],
  ): Promise<'done' | 'none'> {
    if (job.stage === 'treat') {
      // the search and the backups were recorded before this fix tried again
      return 'none';
    }
    if (job.stage !== 'backups') {
      if (!job.searched) {
        await this.askForSearch(job, asset, finding, lead);
        return 'done';
      }
      const search = await this.copiesFound(finding);
      const places = { places: [asset.isExternal ? 'library' : 'managed'] };
      if (search.copies > 0) {
        const found: FindingStep = {
          step: 'searched-copy',
          outcome: 'ok',
          facts: {
            ...places,
            copies: search.copies,
            ...(search.verified.length === 1 &&
              folderFacts(await this.ownerFolders(asset), search.verified[0].candidatePath)),
          },
        };
        const put = await this.putBackCopy(asset, finding, search.verified, [...lead, found]);
        if (put === 'wait' && (job.waits ?? 0) < MAX_DRIVE_WAITS) {
          // F2: the drive it goes to is not there; the search is done, so the next try only puts it back
          await this.waitForDrive(job, asset);
          return 'done';
        }
        if (put !== true) {
          // copies, but not one Frameleaf may pick by itself (or a day without the drive): the person chooses
          await this.settle(finding, finding.category === MediaHealthCategory.Missing ? 'missing' : 'cant-repair', [
            ...lead,
            found,
          ]);
        }
        return 'done';
      }
      await this.mediaHealthRepository.settleFinding({
        healthId: finding.id,
        evidence: { searchPending: false },
        steps: [...lead, { step: 'searched-copy', outcome: 'not-found', facts: places }],
      });
    }

    const restore = await this.restoreLostOriginal(asset.id);
    switch (restore.outcome) {
      case 'restored': {
        await this.settleRestored(asset, finding, restore);
        return 'done';
      }
      case 'busy': {
        const waits = job.backupWaits ?? 0;
        if (waits < MAX_BACKUP_WAITS) {
          // a backup or restore is running: ask again later, without searching again
          await this.putFixBack(job, { stage: 'backups', backupWaits: waits + 1, delay: FIX_WAIT_MS });
          return 'done';
        }
        // a day of waiting: carry on without Cloud Backup, naming no backup
        this.logger.log(`Library care stopped waiting for Cloud Backup to put back ${asset.id}`);
        return 'none';
      }
      case 'not-in-backup': {
        await this.mediaHealthRepository.appendSteps(
          this.stepsOf(finding, [{ step: 'checked-backups', outcome: 'not-found', facts: backupFacts(restore) }]),
        );
        return 'none';
      }
      default: {
        // no Cloud Backup is set up, or this photo is never restored from it: there is no backup to name
        return 'none';
      }
    }
  }

  /**
   * Ask for the owner's shared search by contents (FL-1337): mark the finding as waiting for it and queue
   * the owner's one pending search, which collapses a burst of fixes into one walk of storage and feeds
   * each of them again when it is complete. Nothing is recorded about the search until then. A finding a
   * search already claimed is left to it (the search asked for here claims it again if that one stopped);
   * a person's Try again always asks afresh.
   */
  private async askForSearch(job: FixJob, asset: MediaHealthAsset, finding: MediaHealthFinding, lead: FindingStep[]) {
    const pending = (finding.evidence as Record<string, unknown> | null)?.searchPending;
    const claimed = typeof pending === 'object' && pending !== null && job.from !== 'person';
    if (!claimed || lead.length > 0) {
      await this.mediaHealthRepository.settleFinding({
        healthId: finding.id,
        evidence: claimed ? {} : { searchPending: true },
        steps: lead,
      });
    }
    // F8: never as a job of the run this fix is in, which keeps one search per owner and drops the next
    await this.jobRepository.queueOutsideRun([
      { name: JobName.MediaHealthLocateMissing, data: { userId: asset.ownerId, pending: true } },
    ]);
  }

  /**
   * What the owner's shared search found for this finding (its walk is complete): how many usable exact
   * copies, and the ones Frameleaf may relink by itself.
   */
  private async copiesFound(
    finding: MediaHealthFinding,
  ): Promise<{ copies: number; usable: MediaHealthCandidate[]; verified: MediaHealthCandidate[] }> {
    // An exact copy; a replacement for damage must decode too. An inexact match is never used.
    const copies = (await this.mediaHealthRepository.getCandidatesByHealthIds([finding.id])).filter(
      ({ status, evidence }) =>
        status === MediaHealthStatus.Found &&
        (finding.category === MediaHealthCategory.Missing ||
          (evidence as Record<string, unknown> | null)?.decodeValid === true),
    );
    // Only one Frameleaf may relink by itself: never from a recovery location
    const verified = copies.filter(
      (candidate) =>
        (candidate.resolution as Record<string, unknown> | null)?.autoRelinkable === true &&
        this.candidateRootKind(candidate) !== 'recovery',
    );
    return { copies: copies.length, usable: copies, verified };
  }

  /**
   * Put the one verified copy back as the asset's original, with the steps that say so. `wait` when the drive it
   * would be written to is not there (F2): nothing was written, and the fix waits for it.
   */
  private async putBackCopy(
    asset: MediaHealthAsset,
    finding: MediaHealthFinding,
    verified: MediaHealthCandidate[],
    steps: FindingStep[],
  ): Promise<boolean | 'wait'> {
    if (verified.length !== 1) {
      return false;
    }
    const [candidate] = verified;
    // read again now: the search takes a while, and previews or metadata may have changed the asset
    const [current] = await this.mediaHealthRepository.getAssets([asset.id]);
    if (!current || current.deletedAt) {
      return false;
    }
    if (current.isLocked) {
      // FL-721: a Locked photo's original is sealed; a plain copy found elsewhere is never made its
      // original with no one looking. The person chooses.
      return false;
    }
    const evidence = { fixState: 'found-again' satisfies FixState };
    if (finding.category === MediaHealthCategory.Missing) {
      if (current.isExternal && !current.libraryId) {
        return false;
      }
      const source = await this.sourceFolderOf(candidate);
      if (source) {
        // F3: the library never comes to depend on the folders an import read from
        const copied = await this.copyBackFromSource(current, finding, candidate, source, steps);
        return copied === 'wait' ? 'wait' : copied === 'copied';
      }
      const item = await this.relinkInPlace(current.ownerId, finding, current, candidate, {
        evidence,
        steps: [
          ...steps,
          { step: 'put-back', outcome: 'ok', undo: { kind: 'relink', previousPath: current.originalPath } },
        ],
      });
      return item.status === MediaOperationItemStatus.Ok;
    }
    if (current.isExternal) {
      return false;
    }
    if (!(await this.canReach(this.libraryCarePath(current, '')))) {
      // F2: the copy and the changed file it replaces go into Library care's folder on the Upload drive
      return 'wait';
    }
    // a changed file is replaced by a published copy of its original and kept beside it, like a repair
    const item = await this.publishAndCommit(
      { id: current.ownerId, isAdmin: false },
      finding,
      current,
      candidate,
      MediaHealthCategory.Corrupt,
      {
        evidence,
        steps,
        kept: (retainedPath, after) => ({
          step: 'put-back',
          outcome: 'ok',
          undo: { kind: 'relink', previousPath: retainedPath, ...after },
        }),
      },
    );
    return item.status === MediaOperationItemStatus.Ok;
  }

  /**
   * F3: the folder an Immich import read its photos from that holds this copy, when the copy is there and not in
   * library storage (an import in place reads from inside library storage, and its copies are relinked as any).
   */
  private async sourceFolderOf(candidate: MediaHealthCandidate): Promise<string | undefined> {
    if (this.candidateRootKind(candidate)) {
      return;
    }
    return (await this.sourceRoots()).find((folder) => isPathWithin(folder, candidate.candidatePath));
  }

  /**
   * F3: a lost original found in a folder an Immich import read from is copied to the photo's own place in library
   * storage, verified and never over anything, as Cloud Backup puts one back. The file it was copied from is left
   * exactly as it is, so deleting the old app's data later never loses the photo. Its Undo moves the copy aside into
   * Library care, as a restore's does. The automatic put-back and a reviewer's relink (Task 11b, with `by`) both
   * come here. `wait` when the photo's drive is not there; `refused` for a photo whose own place is not in library
   * storage; `unverified` when the copy is gone or no longer the photo; `failed` when it could not be written (a
   * file at the photo's place is never replaced); `settled` when the problem was dismissed meanwhile.
   */
  private async copyBackFromSource(
    asset: MediaHealthAsset,
    finding: MediaHealthFinding,
    candidate: MediaHealthCandidate,
    folder: string,
    steps: FindingStep[],
    by?: string,
  ): Promise<'copied' | 'wait' | 'refused' | 'unverified' | 'failed' | 'settled'> {
    if (
      asset.isExternal ||
      [StorageFolder.Upload, StorageFolder.Library].every(
        (base) => !isPathWithin(StorageCore.getBaseFolder(base), asset.originalPath),
      )
    ) {
      // only a photo whose own place is in library storage gets a copy there
      return 'refused';
    }
    const source = await resolveInsideRoot(folder, candidate.candidatePath);
    const digests = source && (await this.validateManagedCandidate(asset, source));
    if (!source || !digests) {
      return 'unverified';
    }
    if (!(await this.canReach(asset.originalPath))) {
      return 'wait';
    }
    try {
      await publishVerifiedCopy({
        source,
        destination: asset.originalPath,
        expected: digests,
        hash: (filePath) => this.cryptoRepository.hashFileDigests(filePath),
      });
    } catch (error) {
      this.logger.warn(`Library care could not copy ${asset.id} back from ${source}: ${getErrorMessage(error)}`);
      return 'failed';
    }
    const settled = await this.mediaHealthRepository.settleFinding({
      healthId: finding.id,
      evidence: { fixState: 'found-again' satisfies FixState, searchPending: false },
      status: MediaHealthStatus.Relinked,
      steps: [
        ...steps,
        {
          step: 'put-back',
          outcome: 'ok',
          // copied, not linked: the library keeps a file of its own
          facts: { copied: true, ...(by && { by }) },
          undo: {
            kind: 'restore',
            previousPath: asset.originalPath,
            originalPath: asset.originalPath,
            checksum: asset.checksum.toString('hex'),
          },
        },
      ],
    });
    // the photo's own bytes are at its own path again either way: its details and previews are read again
    await this.queueRelinkJobs(asset.id);
    return settled ? 'copied' : 'settled';
  }

  /**
   * Repair a damaged JPEG without a person (design §3 step 3): FL-1273's repair, published into the
   * hidden Library Care folder, the asset relinked to it and the damaged file kept beside it. Its
   * refusals are FL-1273's (external libraries, encrypted Locked originals, anything but a JPEG) without
   * the owner check or the reviewed checksum: the repair is deterministic, it runs on the owner's
   * behalf, and Undo puts the damaged file back. `busy` when the image worker gave up or the photo
   * changed while it was repaired; `drive-away` when the Upload drive it is published to is not there.
   */
  private async repairAutomatically(
    finding: MediaHealthFinding,
    asset: MediaHealthAsset,
    steps: FindingStep[] = [],
  ): Promise<'repaired' | 'part-saved' | 'not-repaired' | 'busy' | 'drive-away'> {
    if (asset.isExternal || !isJpegFileName(asset.originalFileName) || (await this.isEncryptedOriginal(asset))) {
      return 'not-repaired';
    }
    if (!(await this.canReach(this.libraryCarePath(asset, '')))) {
      // F2: the repair goes into Library care's folder on the Upload drive, which is not there
      return 'drive-away';
    }
    let repaired: { destination: string; checksum: string; fixState: 'repaired' | 'part-saved' } | undefined;
    try {
      repaired = await this.withRepair(asset, async (outcome) => {
        const digests = await this.cryptoRepository.hashFileDigests(outcome.output);
        const record = this.repairRecord(outcome);
        const { committed, destination } = await this.publishRepair(
          asset,
          finding,
          { output: outcome.output, digests },
          {
            provenance: {
              recoveredBy: asset.ownerId,
              automatic: true,
              repairMethod: outcome.method,
              recoveredAt: new Date().toISOString(),
            },
            evidence: record.evidence,
            steps: [...steps, ...record.steps],
          },
        );
        // not committed: left unreferenced in the hidden folder, where the same repair reuses it
        return committed
          ? { destination, checksum: digests.sha256.toString('hex'), fixState: record.fixState }
          : undefined;
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        return 'busy';
      }
      if (error instanceof BadRequestException || isAssetChecksumConstraint(error)) {
        this.logger.log(`Library care could not repair ${asset.id} by itself: ${getErrorMessage(error)}`);
        return 'not-repaired';
      }
      throw error;
    }
    if (!repaired) {
      return 'busy';
    }
    await this.retainDamagedOriginal(
      finding.id,
      this.keptDamaged({ originalPath: repaired.destination, checksum: repaired.checksum }),
    );
    await this.queueRelinkJobs(asset.id);
    return repaired.fixState;
  }

  /**
   * The original came back from Cloud Backup: record it, with what Undo needs. `retainedPath` is where a
   * changed file that was at its path was moved aside, for Undo to put back.
   */
  private async settleRestored(
    asset: MediaHealthAsset,
    finding: MediaHealthFinding,
    restore: LostOriginalRestore,
  ): Promise<void> {
    const [after = asset] = await this.mediaHealthRepository.getAssets([asset.id]);
    await this.mediaHealthRepository.settleFinding({
      healthId: finding.id,
      evidence: { fixState: 'restored' satisfies FixState },
      status:
        finding.category === MediaHealthCategory.Missing ? MediaHealthStatus.Relinked : MediaHealthStatus.Resolved,
      steps: [
        { step: 'checked-backups', outcome: 'ok', facts: backupFacts(restore) },
        {
          step: 'restored',
          outcome: 'ok',
          facts: { backup: 'cloud' },
          undo: {
            kind: 'restore',
            previousPath: asset.originalPath,
            originalPath: after.originalPath,
            checksum: after.checksum.toString('hex'),
            ...(restore.retainedPath && { retainedPath: restore.retainedPath }),
          },
        },
      ],
    });
    await this.queueRelinkJobs(asset.id);
  }

  /**
   * The file opens (F1): a photo whose preview failed, or that has none, gets its previews made again, since its
   * thumbnail job ended when it was handed over. They fail as a job of their own if they still can't be made, and
   * never come back here.
   */
  private async remakeLostPreviews(job: FixJob, asset: MediaHealthAsset): Promise<void> {
    if (job.from === 'preview' || !asset.previewPath || !asset.thumbnailPath) {
      // outside the run, which already holds the thumbnail job that handed this photo over (Task 11b)
      await this.jobRepository.queueOutsideRun([
        { name: JobName.AssetGenerateThumbnails, data: { id: asset.id, source: 'upload', afterCare: true } },
      ]);
    }
  }

  /** It opens and is the stored file: each open finding is settled, saying so, with no fix state left on it. */
  private async settleHealthy(open: MediaHealthFinding[]): Promise<JobStatus> {
    for (const finding of open) {
      await this.mediaHealthRepository.settleFinding({
        healthId: finding.id,
        evidence: { fixState: null },
        status: MediaHealthStatus.Resolved,
        steps: [{ step: 'checked', outcome: 'ok' }],
      });
    }
    return open.length > 0 ? JobStatus.Success : JobStatus.Skipped;
  }

  /** How the fix leaves an open finding, with its last steps, in one write. */
  private async settle(finding: MediaHealthFinding, fixState: FixState, steps: FindingStep[]): Promise<void> {
    // settled, it no longer waits for the shared search
    const waiting = !!(finding.evidence as Record<string, unknown> | null)?.searchPending;
    const evidence = { fixState, ...(waiting && { searchPending: false }) };
    if (!(await this.mediaHealthRepository.settleFinding({ healthId: finding.id, evidence, steps }))) {
      this.logger.log(`Library care left ${finding.id} as it is: it was resolved or dismissed meanwhile`);
    }
  }

  /**
   * Try a busy file again after its next wait (5, 30, then 120 minutes). The decoder's words that asked
   * are dropped, so the next try looks at the file itself rather than at the same words again.
   */
  private retryBusy(job: FixJob, attempt: number, changes: Partial<FixJob> = {}): Promise<JobStatus> {
    return this.putFixBack(job, {
      attempt: attempt + 1,
      delay: BUSY_RETRY_DELAYS_MS[attempt],
      message: undefined,
      ...changes,
    });
  }

  /**
   * A drive the fix needs is not there (Review Focus 1, F2): put the fix back for half an hour, recording nothing,
   * for at most a day of waits. Then it stops until the next file check or a person's Try again. The words that
   * asked are dropped: when the drive is back, the fix looks at the file itself.
   */
  private async waitForDrive(job: FixJob, asset: MediaHealthAsset, changes: Partial<FixJob> = {}) {
    const waits = job.waits ?? 0;
    if (waits >= MAX_DRIVE_WAITS) {
      this.logger.log(`Library care stopped waiting for a drive that ${asset.id} needs`);
      return JobStatus.Skipped;
    }
    return this.putFixBack(job, { waits: waits + 1, delay: FIX_WAIT_MS, message: undefined, ...changes });
  }

  /**
   * A file in the owner's Library care folder, the hidden folder on the Upload drive where repairs, put-back
   * copies and the files they replace are kept.
   */
  private libraryCarePath(asset: Pick<MediaHealthAsset, 'id' | 'ownerId'>, name: string): string {
    return path.join(
      path.dirname(StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, asset.id)),
      RECOVERY_FOLDER,
      name,
    );
  }

  /** Whether the drive a path is on can be reached: Frameleaf's own folders, or an external library's. */
  private async canReach(filePath: string): Promise<boolean> {
    const libraries = await this.libraryRepository.getAll().catch(() => []);
    return isFileRootReachable(this.storageRepository, filePath, libraries);
  }

  /** Put this fix back on its queue under its next key, after `delay` when given (FL-1337 ruling R1). */
  private async putFixBack(job: FixJob, changes: Partial<FixJob>): Promise<JobStatus> {
    await this.jobRepository.queue({
      name: JobName.MediaHealthFixAsset,
      data: { ...job, delay: undefined, ...changes, requeue: (job.requeue ?? 0) + 1 },
    });
    return JobStatus.Success;
  }

  /**
   * What is wrong with the file, in plain words (design §2a): from the decoder's words and the bytes. A file the
   * check calls unsupported (a format it does not decode, such as a PSD, some RAWs or an audio file) is not
   * supported rather than unreadable when nothing else is wrong with it (F5). Never a JPEG: one without a start
   * marker that won't decode is damaged.
   */
  private async causeOf(
    asset: MediaHealthAsset,
    message: string,
    matchesStoredChecksum: boolean | null,
    verdict?: Pick<CandidateValidation, 'status'>,
  ): Promise<FileCause> {
    try {
      const cause = classifyFileProblem({
        message,
        shape: await readFileShape(asset.originalPath),
        matchesStoredChecksum,
      });
      return cause === 'unreadable' &&
        verdict?.status === MediaHealthStatus.UnsupportedRaw &&
        !isJpegFileName(asset.originalFileName)
        ? 'not-supported'
        : cause;
    } catch (error) {
      // an I/O error is busy: never a verdict on the file
      this.logger.debug(`Could not read ${asset.id} to tell what is wrong with it: ${getErrorMessage(error)}`);
      return 'busy';
    }
  }

  /** The decoder's own words, or the check's reason when it gave none. */
  private decoderMessage(verdict: CandidateValidation): string {
    return verdict.message ?? (typeof verdict.evidence.reason === 'string' ? verdict.evidence.reason : '');
  }

  /** Whether the original is still the file Frameleaf stored; null without a file checksum or a read. */
  private async matchesStoredChecksum(asset: MediaHealthAsset): Promise<boolean | null> {
    if (
      asset.checksumAlgorithm !== ChecksumAlgorithm.sha1File &&
      asset.checksumAlgorithm !== ChecksumAlgorithm.sha256File
    ) {
      return null;
    }
    try {
      return (await this.cryptoRepository.hashFileMatching(asset.originalPath, asset.checksum)).equals(asset.checksum);
    } catch {
      return null;
    }
  }

  /**
   * The finding a fix records for damage nothing recorded yet: the check's verdict, or one from the cause.
   * A changed file that still opens is recorded as the checksum mismatch it is, never as a failed decode.
   */
  private damageVerdict(cause: FileCause, verdict: CandidateValidation | undefined, decoded: boolean) {
    if (decoded) {
      return {
        status: MediaHealthStatus.CorruptConfirmed,
        evidence: { reason: 'expected_mismatch', validationStatus: 'corrupt', cause },
        resolution: { reuploadRecommended: true },
      };
    }
    if (verdict && verdict.status !== MediaHealthStatus.Missing) {
      return { ...verdict, evidence: { ...verdict.evidence, cause } };
    }
    return {
      status:
        cause === 'not-supported'
          ? MediaHealthStatus.UnsupportedRaw
          : cause === 'busy'
            ? MediaHealthStatus.CorruptSuspect
            : MediaHealthStatus.CorruptConfirmed,
      evidence: { reason: 'decode_failed', cause },
      resolution: { reuploadRecommended: cause !== 'not-supported' && cause !== 'busy' },
    };
  }

  /** The owner's own folders (and the asset's external library), the only paths its history may name. */
  private async ownerFolders(asset: MediaHealthAsset): Promise<string[]> {
    const own = (await this.ownerRoots([asset.ownerId])).get(asset.ownerId) ?? [];
    const library = asset.libraryId ? await this.libraryRepository.get(asset.libraryId) : undefined;
    return [...own, ...(library?.importPaths ?? [])];
  }

  /**
   * FL-1337: put a lost or changed original back from Cloud Backup, verified against the photo's own
   * checksum and never replacing anything. `busy` while a backup or restore runs.
   */
  private restoreLostOriginal(assetId: string): Promise<LostOriginalRestore> {
    return this.cloudBackupService.restoreLostOriginal(assetId);
  }

  /**
   * FL-1337: the owner's phones and tablets that may still hold a lost photo: sessions of an iOS, iPadOS
   * or Android device used in the last 90 days. A phone is its session; its name is the model the app sends.
   */
  private async phonesToAsk(ownerId: string): Promise<Array<{ deviceId: string; name: string }>> {
    return this.phonesOf(await this.sessionRepository.getByUserId(ownerId));
  }

  private phonesOf(sessions: Array<{ id: string; deviceOS: string; deviceType: string; updatedAt: Date }>) {
    return sessions
      .filter((session) => isActivePhone(session))
      .map((session) => ({ deviceId: session.id, name: phoneName(session) }));
  }

  /** FL-1337: the caller's own lost originals, for their phones to look for (empty while phones are not asked). */
  async listLostOriginals(auth: AuthDto, { take, skip }: LostOriginalsQueryDto): Promise<LostOriginalsResponseDto> {
    if (!(await this.careSettings()).askPhones) {
      return { items: [], hasNextPage: false };
    }
    const rows = await this.mediaHealthRepository.listLostOriginals(auth.user.id, take, skip);
    return {
      items: rows.slice(0, take).map((row) => ({
        assetId: row.assetId,
        checksum: row.checksum.toString('base64'),
        originalFileName: row.originalFileName,
        fileCreatedAt: asDateTimeString(row.fileCreatedAt),
        fileSize: row.fileSize ?? null,
      })),
      hasNextPage: rows.length > take,
    };
  }

  /**
   * FL-1337: a phone says which lost originals it does not have. Each one is written once into the
   * history of the caller's own open finding; anything else (unknown, resolved, dismissed, in the Trash,
   * another account's) is ignored without a word. Once every phone has said so, the problem settles as
   * missing, in the write of the last report.
   */
  async recordPhoneChecked(auth: AuthDto, { deviceId, notHere }: LostOriginalsCheckedDto): Promise<void> {
    const sessionId = auth.session?.id;
    if (!sessionId || !(await this.careSettings()).askPhones) {
      return;
    }
    // SHA-1 (20 bytes) or SHA-256 (32 bytes, every upload since FL-1108), as the list gave them (FL-1347)
    const checksums = [...new Set(notHere)]
      .map((checksum) => Buffer.from(checksum, 'base64'))
      .filter((checksum) => checksum.length === 20 || checksum.length === 32);
    const findings = await this.mediaHealthRepository.findLostOriginals(auth.user.id, checksums);
    if (findings.length === 0) {
      return;
    }
    const phones = this.phonesOf(await this.sessionRepository.getByUserId(auth.user.id));
    const reporter = phones.find(({ deviceId: id }) => id === sessionId);
    if (!reporter) {
      // only a phone or tablet answers for the phones
      return;
    }
    await this.mediaHealthRepository.recordPhoneReport({
      findings,
      sessionId,
      device: reporter.name,
      deviceId,
      phones: phones.map((phone) => phone.deviceId),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Damaged and missing files (FL-1337, design §5 and §7)               */
  /* ------------------------------------------------------------------ */

  /**
   * One page of a tab of Damaged and missing files. A member sees their own problems; an administrator
   * every account's, another account's without its picture and with only Try again to press. Hidden content
   * and Locked photos follow the reader's privacy, so another account's Locked photo is never listed, and
   * the reader's own only in their unlocked session. Partners and shared links see none.
   */
  async listFileProblems(auth: AuthDto, { tab, take, skip }: FileProblemListQueryDto): Promise<FileProblemPageDto> {
    const scope = { tab, ownerId: this.fileProblemOwner(auth), privacy: this.privacyFor(auth) };
    const [rows, total] = await Promise.all([
      this.mediaHealthRepository.listFileProblems({ ...scope, take, skip }),
      this.mediaHealthRepository.countFileProblems(scope),
    ]);
    return { items: rows.map((row) => this.fileProblemRow(auth, row)), total };
  }

  /** One problem and its history, oldest first, open or closed (Review Focus 5), as the list shows it. */
  async getFileProblem(auth: AuthDto, id: string): Promise<FileProblemDto> {
    const record = await this.fileProblemFor(auth, id);
    const steps = await this.mediaHealthRepository.listSteps(record.id);
    return {
      ...this.fileProblemRow(auth, record),
      steps: steps.map(({ at, step, outcome, facts }) => ({
        at: asDateTimeString(at),
        step,
        outcome,
        facts: shownFacts(facts),
      })),
    };
  }

  /**
   * The folders Look in a folder may search, by name: library storage and the caller's own external
   * libraries; for an administrator also every external library and the recovery folders and drives added
   * in Frameleaf Manager. Only folders the server can already see.
   */
  async getFileProblemFolders(auth: AuthDto): Promise<FileProblemFolderDto[]> {
    const { roots } = await this.getRoots(auth);
    return roots.map(({ id, label }) => ({ id, name: label }));
  }

  /**
   * Undo a fix, one photo at a time, the owner only (design §5). The fix is the newest step carrying what
   * Undo needs; nothing is undone when the photo changed since (Review Focus 3), and nothing is deleted:
   * - a repair: the photo is the kept damaged file again, and automatic repair never redoes it;
   * - a relink: the photo goes back to the file it used, missing there or the changed file kept aside;
   * - a restore: the restored file moves aside into Library care, and a changed file it replaced comes back.
   * The problem goes back to Needs you, with who undid it.
   */
  async undoFileProblemFix(auth: AuthDto, id: string): Promise<FileProblemDto> {
    const record = await this.ownFileProblem(auth, id);
    const fixState = this.fixStateOf(record);
    if (record.dismissedAt || !record.resolvedAt || !fixState || !FIXED_FILE_STATES.has(fixState)) {
      throw new BadRequestException(NOTHING_TO_UNDO);
    }
    const fix = this.fixToUndo(record, await this.mediaHealthRepository.listSteps(record.id));
    if (!fix) {
      throw new BadRequestException(NOTHING_TO_UNDO);
    }
    const others = await this.mediaHealthRepository.getFindingsForAsset(record.assetId);
    if (others.some((other) => other.id !== record.id && isOpenFinding(other))) {
      throw new ConflictException(OTHER_PROBLEM_OPEN);
    }
    const [asset] = await this.mediaHealthRepository.getAssets([record.assetId]);
    if (asset?.isLocked) {
      // Task 11b: a Locked photo's file is never changed by an Undo, whoever unlocked it; nothing is moved
      throw new ConflictException(UNDO_LOCKED);
    }
    if (await this.keptFileSealed(fix.previousPath, fix.retainedPath)) {
      // FL-1364: a kept file still sealed for Locked is never made the photo's file or put back as ciphertext
      throw new ConflictException(UNDO_LOCKED);
    }
    // a repair that stopped before it recorded what Undo needs: its repaired file says what it left, where the fix
    // left it or, once Folder layout moved it, where the photo is now
    const expectedChecksum = fix.checksum
      ? Buffer.from(fix.checksum, 'hex')
      : asset &&
        ((await this.cryptoRepository.hashFileMatching(fix.originalPath, asset.checksum).catch((): undefined => {})) ??
          (await this.cryptoRepository
            .hashFileMatching(asset.originalPath, asset.checksum)
            .catch((): undefined => {})));
    // F9: the photo's checksum, the Trash and its edits say whether it changed since the fix, not its path. The only
    // thing that moves a stored original is Frameleaf's own Folder layout, which runs right after every fix and
    // never changes the file; the repository holds the photo to the path read here.
    if (
      !asset ||
      asset.deletedAt ||
      asset.ownerId !== auth.user.id ||
      !expectedChecksum ||
      !asset.checksum.equals(expectedChecksum)
    ) {
      throw new ConflictException(UNDO_CHANGED);
    }
    const base = {
      healthId: record.id,
      assetId: asset.id,
      ownerId: asset.ownerId,
      stepId: fix.stepId,
      expectedOriginalPath: asset.originalPath,
      expectedChecksum,
      status:
        record.category === MediaHealthCategory.Missing
          ? MediaHealthStatus.Missing
          : MediaHealthStatus.CorruptConfirmed,
      steps: [{ step: 'undone', outcome: 'info', facts: { by: auth.user.name } }] satisfies FindingStep[],
    };
    const result =
      fix.kind === 'restore'
        ? await this.undoRestore(record, asset, fix, base)
        : await this.undoRelink(record, fix, base);
    if (result === 'open') {
      throw new ConflictException(OTHER_PROBLEM_OPEN);
    }
    if (result === 'locked') {
      // put in Locked after the check above, before the undo held the photo: nothing was moved or relinked
      throw new ConflictException(UNDO_LOCKED);
    }
    if (result === 'changed') {
      throw new ConflictException(UNDO_CHANGED);
    }
    // the photo's file changed: its details and previews are read again, as after a relink
    await this.queueRelinkJobs(asset.id);
    return this.getFileProblem(auth, id);
  }

  /** A repair or a relink is undone by pointing the photo back at the file it used; no file moves. */
  private async undoRelink(
    record: FileProblemRecord,
    fix: FixToUndo,
    base: Omit<UndoFileFix, 'evidence'>,
  ): Promise<UndoFileFixResult> {
    let relinkTo: NonNullable<UndoFileFix['relinkTo']> = { path: fix.previousPath, takeChecksum: false };
    let evidence: Record<string, unknown>;
    if (fix.kind === 'repair') {
      // the photo is the damaged file again: its checksum is that file's own, as when it was stored
      const digests = await this.cryptoRepository.hashFileDigests(fix.previousPath).catch((): undefined => {});
      if (!digests) {
        throw new ConflictException("The damaged file Frameleaf kept isn't there any more, so this can't be undone.");
      }
      relinkTo = { path: fix.previousPath, digests, takeChecksum: true };
      evidence = { fixState: 'cant-repair' satisfies FixState, partSaved: false, autoRepairDeclined: true };
    } else if (record.category === MediaHealthCategory.Missing) {
      // missing again where it was; the photo keeps its own checksum, which its copy matched
      evidence = { fixState: 'missing' satisfies FixState, partSaved: false };
    } else {
      // the changed file kept aside is the photo's file again, and still not the one Frameleaf stored
      if (!(await this.storageRepository.checkFileExists(fix.previousPath))) {
        throw new ConflictException("The changed file Frameleaf kept isn't there any more, so this can't be undone.");
      }
      evidence = { fixState: 'cant-repair' satisfies FixState, partSaved: false };
    }
    try {
      return await this.mediaHealthRepository.undoFix({ ...base, relinkTo, evidence });
    } catch (error) {
      if (isAssetChecksumConstraint(error)) {
        throw new ConflictException("Another photo in this library is the same file, so this can't be undone.");
      }
      throw error;
    }
  }

  /**
   * A restore put the original back at its own path: Undo moves it aside into the owner's Library care
   * folder and puts back the changed file it replaced, if there was one. The files move only once the
   * photo is proven unchanged, under the repository's lock, and go back where they were if the undo is not
   * recorded. Never while the drive that keeps the copies is not there.
   */
  private async undoRestore(
    record: FileProblemRecord,
    asset: MediaHealthAsset,
    fix: FixToUndo,
    base: Omit<UndoFileFix, 'evidence'>,
  ): Promise<UndoFileFixResult> {
    const extension = path.extname(asset.originalPath).toLowerCase();
    const aside = this.libraryCarePath(
      asset,
      `${asset.id}-${record.id}.restored${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`,
    );
    if (!(await this.canReach(aside))) {
      throw new ConflictException(COPIES_DRIVE_AWAY);
    }
    // the file at its path must still be the one the restore put there
    const present = await this.cryptoRepository
      .hashFileMatching(asset.originalPath, asset.checksum)
      .catch((): undefined => {});
    if (!present?.equals(asset.checksum)) {
      throw new ConflictException(UNDO_CHANGED);
    }
    const { retainedPath } = fix;
    const moved: Array<[string, string]> = [];
    const move = async (from: string, to: string) => {
      await retainFile(from, to);
      moved.push([from, to]);
    };
    try {
      return await this.mediaHealthRepository.undoFix({
        ...base,
        moveFiles: async () => {
          await move(asset.originalPath, aside);
          if (retainedPath) {
            await move(retainedPath, asset.originalPath);
          }
        },
        evidence: { fixState: (retainedPath ? 'cant-repair' : 'missing') satisfies FixState, partSaved: false },
      });
    } catch (error) {
      for (const [from, to] of moved.toReversed()) {
        await retainFile(to, from).catch((error_: unknown) =>
          this.logger.warn(`Library care kept ${to} after an Undo that was not recorded: ${getErrorMessage(error_)}`),
        );
      }
      this.logger.warn(`Library care could not undo the restore of ${asset.id}: ${getErrorMessage(error)}`);
      throw new ServiceUnavailableException(
        "Frameleaf couldn't undo this just now, so nothing was changed. Try again later.",
      );
    }
  }

  /**
   * The damaged file a repair kept, for its owner to download (Task 11b): only while the newest fix Undo would undo
   * is a repair, and its kept file is there in the photo's own Library care folder, not a link out of it. Never for
   * a photo that is Locked now, even in its owner's unlocked session. The file is only read.
   */
  async getFileProblemKeptFile(auth: AuthDto, id: string): Promise<FileDownloadResponse> {
    const record = await this.ownFileProblem(auth, id);
    const [asset] = await this.mediaHealthRepository.getAssets([record.assetId]);
    if (!asset) {
      throw new NotFoundException(NO_KEPT_FILE);
    }
    if (asset.isLocked) {
      throw new ConflictException(KEPT_FILE_LOCKED);
    }
    const fix = this.fixToUndo(record, await this.mediaHealthRepository.listSteps(record.id));
    const folder = path.dirname(this.libraryCarePath(asset, 'kept'));
    const kept =
      fix?.kind === 'repair' && path.dirname(path.normalize(fix.previousPath)) === folder
        ? await resolveInsideRoot(folder, fix.previousPath)
        : undefined;
    if (!kept) {
      throw new NotFoundException(NO_KEPT_FILE);
    }
    if (await this.keptFileSealed(kept)) {
      // FL-1364: still sealed for Locked; never handed out as ciphertext
      throw new ConflictException(KEPT_FILE_LOCKED);
    }
    // named so it is never taken for the repaired photo; the route keeps it out of every cache (private, no-store)
    const extension = path.extname(record.originalFileName);
    return new FileDownloadResponse({
      path: kept,
      fileName: `${path.basename(record.originalFileName, extension)} (damaged)${extension || path.extname(kept)}`,
      contentType: mimeTypes.lookup(kept),
      cacheControl: CacheControl.None,
    });
  }

  /** Keep a problem as it is (the owner only, from Needs you): it moves to Left as they are, and stays there. */
  async keepFileProblem(auth: AuthDto, id: string): Promise<FileProblemDto> {
    const record = await this.ownFileProblem(auth, id);
    if (!this.needsYou(record)) {
      throw new BadRequestException('Only a photo that still needs you can be kept as it is.');
    }
    // open, so a later check keeps the person's choice; it no longer waits for the shared search
    const waiting = !!(record.evidence as Record<string, unknown> | null)?.searchPending;
    // `keptAt`: a fix that put itself back before this choice leaves it as it is when it carries on
    const kept = await this.mediaHealthRepository.settleFinding({
      healthId: record.id,
      evidence: {
        fixState: 'left-as-is' satisfies FixState,
        keptAt: new Date().toISOString(),
        ...(waiting && { searchPending: false }),
      },
      steps: [{ step: 'kept-as-is', outcome: 'info' }],
    });
    if (!kept) {
      throw new ConflictException('This photo changed meanwhile. Look at it again.');
    }
    return this.getFileProblem(auth, id);
  }

  /**
   * Try again: the fix starts from the beginning, for the owner or an administrator. A repair someone undid
   * stays declined, so it is never redone by itself; its owner repairs it with Repair….
   *
   * It supersedes every fix of the photo before it: `retriedAt` leaves one that carries on as it is, the
   * waiting ones are cancelled, a queued feed is replaced by this one, and it waits for one that is running.
   */
  async tryFileProblemAgain(auth: AuthDto, id: string): Promise<FileProblemDto> {
    const record = await this.fileProblemFor(auth, id);
    if (record.dismissedAt || record.assetDeletedAt) {
      throw new BadRequestException('This photo was dismissed or is in the Trash, so there is nothing to try again.');
    }
    // 1. The choice is recorded first, and only on a problem still open: one dismissed or settled meanwhile is
    //    refused with nothing queued or cancelled. From here a fix that carries on (and any put-back a running
    //    one makes later) gives way to this one.
    // 2. Then this fix is queued, and only after that are the waiting fixes cancelled, so they are never
    //    cancelled with nothing in their place. Its own key is not among the ones cancelled.
    // A problem already resolved has no open finding for a fix to carry on from: nothing to record.
    if (!record.resolvedAt) {
      const recorded = await this.mediaHealthRepository.settleFinding({
        healthId: record.id,
        evidence: { retriedAt: new Date().toISOString() },
      });
      if (!recorded) {
        throw new ConflictException('This photo changed meanwhile. Look at it again.');
      }
    }
    await this.jobRepository.queue({
      name: JobName.MediaHealthFixAsset,
      data: { id: record.assetId, from: 'person', attempt: 0, retry: randomUUID() },
    });
    await this.jobRepository.cancelWaitingFixes(record.assetId);
    return this.getFileProblem(auth, id);
  }

  /**
   * Look in a folder (the owner only): a one-off search by contents of one folder the owner may search, as a
   * search Activity shows. It answers at once; when the search is done, `finishLookIn` records what it found
   * and puts back the one exact copy, as a fix does.
   */
  async lookInFolderForFileProblem(
    auth: AuthDto,
    id: string,
    { folderId }: FileProblemLookInDto,
  ): Promise<FileProblemDto> {
    const record = await this.ownFileProblem(auth, id);
    if (!this.needsYou(record)) {
      throw new BadRequestException('Frameleaf only looks for a photo that still needs you.');
    }
    if (record.category !== MediaHealthCategory.Missing && record.status !== MediaHealthStatus.CorruptConfirmed) {
      // a file that arrived damaged: every exact copy has the same damage
      throw new BadRequestException(
        'Frameleaf can only look for an exact copy of a missing photo, or of one that changed.',
      );
    }
    const folder = (await this.getFileProblemFolders(auth)).find((candidate) => candidate.id === folderId);
    if (!folder) {
      throw new ForbiddenException("That folder isn't one you can search.");
    }
    // only a folder the search walks for this photo: library storage and recovery folders for a stored
    // photo, its own library for an external one; any other would say it looked where it did not
    const [asset] = await this.mediaHealthRepository.getAssets([record.assetId]);
    if (asset?.isExternal && record.category !== MediaHealthCategory.Missing) {
      // an external library's photo is looked for only when it is missing: a changed one is its library's to fix
      throw new BadRequestException("Frameleaf can only look for an external library's photo when it is missing.");
    }
    const searchable = asset?.isExternal
      ? !!asset.libraryId && folder.id === libraryRootId(asset.libraryId)
      : folder.id === MANAGED_ROOT_ID || rootKindOf(folder.id) === 'recovery';
    if (!asset || !searchable) {
      throw new BadRequestException("Frameleaf can't look for this photo in that folder.");
    }
    await this.locateMissing(auth, { ids: [record.id], rootIds: [folder.id] }, { folder: folder.name });
    return this.getFileProblem(auth, id);
  }

  /**
   * A Look in a folder search is complete. Each problem it checked and that is still open gets
   * `searched-copy` with the folder's name and the copies found there, and the one exact copy there that
   * Frameleaf may use by itself is put back (`put-back`, with its Undo), as a fix does: never for a Locked
   * photo or from a recovery folder. A problem the search did not check gets nothing.
   */
  async finishLookIn(snapshot: MediaHealthLocateSnapshot, checkedIds: string[]): Promise<void> {
    const checked = new Set(checkedIds);
    const ids = snapshot.findingIds.filter((id) => checked.has(id));
    if (!snapshot.lookIn || ids.length === 0) {
      return;
    }
    const folders = new Set(snapshot.rootIds);
    const inFolder = (candidate: MediaHealthCandidate) => folders.has(this.candidateRootId(candidate) ?? '');
    const facts = { folder: snapshot.lookIn.folder };
    for (const finding of await this.mediaHealthRepository.getByIds(ids, snapshot.userId)) {
      if (!isOpenFinding(finding)) {
        continue;
      }
      const [asset] = await this.mediaHealthRepository.getAssets([finding.assetId]);
      if (!asset || asset.deletedAt) {
        continue;
      }
      const search = await this.copiesFound(finding);
      const copies = search.usable.filter((candidate) => inFolder(candidate));
      if (copies.length === 0) {
        await this.mediaHealthRepository.appendSteps(
          this.stepsOf(finding, [{ step: 'searched-copy', outcome: 'not-found', facts }]),
        );
        continue;
      }
      const found: FindingStep = { step: 'searched-copy', outcome: 'ok', facts: { ...facts, copies: copies.length } };
      const put = await this.putBackCopy(
        asset,
        finding,
        search.verified.filter((candidate) => inFolder(candidate)),
        [found],
      );
      if (put !== true) {
        // not put back (or its drive is not there now): the copies are recorded, and the person chooses
        await this.mediaHealthRepository.appendSteps(this.stepsOf(finding, [found]));
      }
    }
  }

  /** Remove goes through the Trash as usual (design §7): each open problem of a trashed photo says so. */
  @OnEvent({ name: 'AssetTrashAll' })
  async onAssetTrashAll({ assetIds, userId }: ArgOf<'AssetTrashAll'>): Promise<void> {
    try {
      const user = await this.userRepository.get(userId, {});
      await this.mediaHealthRepository.recordRemoved(assetIds, user?.name ? { by: user.name } : {});
    } catch (error) {
      this.logger.warn(
        `Library care could not record that ${assetIds.length} photos were removed: ${getErrorMessage(error)}`,
      );
    }
  }

  /** Whose problems a reader sees: their own, or every account's for an administrator. */
  private fileProblemOwner(auth: AuthDto): string | undefined {
    return auth.user.isAdmin ? undefined : auth.user.id;
  }

  private async fileProblemFor(auth: AuthDto, id: string): Promise<FileProblemRecord> {
    const record = await this.mediaHealthRepository.getFileProblem(
      id,
      this.fileProblemOwner(auth),
      this.privacyFor(auth),
    );
    if (!record) {
      throw new NotFoundException('Frameleaf has no record of this problem.');
    }
    return record;
  }

  /** A problem only its owner may act on: Undo, Keep as it is and Look in a folder. */
  private async ownFileProblem(auth: AuthDto, id: string): Promise<FileProblemRecord> {
    const record = await this.fileProblemFor(auth, id);
    if (record.ownerId !== auth.user.id) {
      throw new ForbiddenException(OWNER_ONLY);
    }
    return record;
  }

  private fixStateOf(record: Pick<MediaHealthFinding, 'evidence'>): string | null {
    const fixState = (record.evidence as Record<string, unknown> | null)?.fixState;
    return typeof fixState === 'string' ? fixState : null;
  }

  /** In Needs you: open, its photo in the library, and no fix settled it another way. */
  private needsYou(record: FileProblemRecord): boolean {
    const fixState = this.fixStateOf(record);
    return (
      !record.resolvedAt &&
      !record.dismissedAt &&
      !record.assetDeletedAt &&
      (fixState === null || NEEDS_FILE_STATES.has(fixState))
    );
  }

  /** A row as the reader may see it: another account's carries no picture and nothing to do but Try again. */
  private fileProblemRow(auth: AuthDto, record: FileProblemRecord): FileProblemRowDto {
    const own = record.ownerId === auth.user.id;
    return {
      id: record.id,
      assetId: record.assetId,
      ownerId: record.ownerId,
      ownerName: record.ownerName,
      originalFileName: record.originalFileName,
      category: record.category,
      fixState: this.fixStateOf(record),
      partSaved: (record.evidence as Record<string, unknown> | null)?.partSaved === true,
      line: record.line && {
        step: record.line.step,
        outcome: record.line.outcome,
        facts: shownFacts(record.line.facts),
      },
      updatedAt: asDateTimeString(record.updatedAt),
      pictureAllowed: own,
      canAct: own,
    };
  }

  /**
   * The fix Undo would undo: the newest step carrying what Undo needs, unless an Undo came after it. A repair
   * that stopped before it recorded its kept damaged file falls back on the file the problem still names.
   */
  private fixToUndo(record: FileProblemRecord, steps: FileStep[]): FixToUndo | undefined {
    const last = steps.findLast(({ step, undo }) => !!undo || step === 'undone' || step === 'repaired');
    if (!last || last.step === 'undone') {
      return;
    }
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
    if (!last.undo) {
      const retainedPath = text((record.evidence as Record<string, unknown> | null)?.retainedPath);
      return retainedPath
        ? { kind: 'repair', stepId: last.id, previousPath: retainedPath, originalPath: record.originalPath }
        : undefined;
    }
    const kind = text(last.undo.kind);
    const previousPath = text(last.undo.previousPath);
    const originalPath = text(last.undo.originalPath);
    if (!kind || !UNDO_KINDS.has(kind) || !previousPath || !originalPath) {
      return;
    }
    return {
      kind: kind as FixToUndo['kind'],
      stepId: last.id,
      previousPath,
      originalPath,
      checksum: text(last.undo.checksum),
      retainedPath: text(last.undo.retainedPath),
    };
  }

  /**
   * Move confirmed damage to the trash (FL-69: now a durable bulk job).
   *
   * Destructive, so it keeps every gate it had: the typed confirmation, the PIN when the account has
   * one, evidence no older than a day, and a revalidation now, before anything is queued. The job
   * revalidates each item once more at the moment it moves it, and never touches unsupported RAW or
   * suspected damage. Trash is recoverable; nothing is deleted.
   */
  async deleteCorrupt(auth: AuthDto, dto: MediaHealthDeleteCorruptDto): Promise<MediaHealthBulkResponseDto> {
    if (dto.confirmText !== CORRUPT_MEDIA_DELETE_CONFIRM_TEXT) {
      throw new BadRequestException(`Type ${CORRUPT_MEDIA_DELETE_CONFIRM_TEXT} to move corrupt media to trash`);
    }

    const user = await this.userRepository.getForPinCode(auth.user.id);
    if (user?.pinCode && !auth.session?.hasElevatedPermission) {
      throw new ForbiddenException('Elevated PIN session is required to delete corrupt media');
    }

    const privacy = this.privacyFor(auth);
    const findings = await this.findingsFor(auth, dto.ids);
    const now = Date.now();
    // A finding still queued from a job that was cancelled before reaching it may be confirmed again.
    const accepted = findings.filter(
      (finding) =>
        finding.category === MediaHealthCategory.Corrupt &&
        (CORRUPT_DELETE_STATUSES.has(finding.status) || finding.status === MediaHealthStatus.TrashQueued) &&
        now - finding.checkedAt.getTime() <= CORRUPT_MEDIA_DELETE_RECENT_MS,
    );

    if (accepted.length === 0) {
      throw new BadRequestException('No recently confirmed corrupt media findings were selected');
    }

    const assets = await this.mediaHealthRepository.getAssets(
      accepted.map(({ assetId }) => assetId),
      auth.user.isAdmin ? undefined : auth.user.id,
      privacy,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const queued: MediaHealthFinding[] = [];
    const resultStatusById = new Map<string, MediaHealthStatus>();

    for (const finding of accepted) {
      const asset = assetsById.get(finding.assetId);
      if (!asset) {
        continue;
      }
      if (await this.isEncryptedOriginal(asset)) {
        resultStatusById.set(finding.id, await this.releaseEncrypted(finding, asset));
        continue;
      }
      const result = await this.validateAssetIntegrity(asset, { keepBusy: true });
      if (result && 'busy' in result) {
        // Not a verdict: the finding stays exactly as it is
        continue;
      }

      if (result?.status === MediaHealthStatus.CorruptConfirmed) {
        queued.push(finding);
        resultStatusById.set(finding.id, MediaHealthStatus.TrashQueued);
        continue;
      }

      const status = result?.status ?? MediaHealthStatus.Resolved;
      resultStatusById.set(finding.id, status);
      await this.mediaHealthRepository.upsertFinding({
        ...finding,
        expectedUpdateId: asset.updateId,
        status,
        severity: result ? MediaHealthSeverity.Warning : MediaHealthSeverity.Info,
        evidence: result?.evidence ?? { reason: 'trash_revalidation_passed' },
        resolution: result?.resolution ?? { trashSkipped: true },
        checkedAt: new Date(),
        resolvedAt: result ? null : new Date(),
      });
    }

    if (queued.length === 0) {
      throw new BadRequestException('Selected corrupt media no longer failed deletion revalidation');
    }

    await this.mediaHealthRepository.markStatus(
      queued.map(({ id }) => id),
      MediaHealthStatus.TrashQueued,
    );
    let operationId: string | null;
    try {
      operationId = await this.submitBulk(
        auth,
        MediaOperationBulkAction.TrashDamagedMedia,
        queued.map((finding) => ({ assetId: finding.assetId, findingId: finding.id })),
      );
    } catch (error) {
      // Nothing was queued: put the findings back as they were so they can be reviewed again.
      await this.mediaHealthRepository.markStatus(
        queued.map(({ id }) => id),
        MediaHealthStatus.CorruptConfirmed,
      );
      throw error;
    }

    return {
      results: findings.map((finding) => ({
        id: finding.id,
        success: resultStatusById.get(finding.id) === MediaHealthStatus.TrashQueued,
        status: resultStatusById.get(finding.id) ?? finding.status,
        error:
          resultStatusById.get(finding.id) === MediaHealthStatus.TrashQueued
            ? undefined
            : 'Finding is not recently confirmed corrupt or failed revalidation',
      })),
      operationId,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Durable bulk work (FL-69), called by BulkOperationService            */
  /* ------------------------------------------------------------------ */

  /**
   * Apply one reviewed finding from a Library Care bulk job, as the account that submitted it.
   *
   * `auth` is the worker's view of that account: elevated, because background work may reach its
   * owner's Locked media (owner decision, September 22, 2026). That is exactly why the checks here
   * never lean on elevation: an item that belongs to somebody else is only reachable by an
   * administrator, and never while it is Locked. Every file is read again now. A refusal that a retry
   * could not change is reported skipped; anything that might succeed later fails, and is retried
   * once by the runner.
   */
  async applyBulkEntry(
    auth: AuthDto,
    action: MediaOperationBulkAction,
    entry: BulkMediaHealthEntry,
  ): Promise<BulkOperationItem> {
    try {
      switch (action) {
        case MediaOperationBulkAction.RelinkMissingMedia: {
          return await this.relinkOne(auth, entry);
        }
        case MediaOperationBulkAction.RecoverDamagedMedia: {
          return await this.recoverOne(auth, entry);
        }
        case MediaOperationBulkAction.TrashDamagedMedia: {
          return await this.trashOne(auth, entry);
        }
        default: {
          return outcome(entry.assetId, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_validation');
        }
      }
    } catch (error) {
      this.logger.warn(`Library Care ${action} failed for ${entry.findingId}: ${bulkErrorMessage(error)}`);
      return transient(entry.assetId, bulkErrorMessage(error));
    }
  }

  private async relinkOne(auth: AuthDto, entry: BulkMediaHealthEntry): Promise<BulkOperationItem> {
    const target = await this.workerTarget(auth, entry, MediaHealthCategory.Missing);
    if ('outcome' in target) {
      return target.outcome;
    }
    const { finding, asset } = target;
    const id = entry.assetId;

    if (finding.status === MediaHealthStatus.Relinked && this.resolvedWith(finding, entry)) {
      // A batch applied again after a lost worker: this one is already done.
      return outcome(id, MediaOperationItemStatus.Ok);
    }
    if (finding.status !== MediaHealthStatus.Found) {
      return changed(id, 'The finding changed since it was reviewed');
    }

    const candidates = await this.mediaHealthRepository.getCandidatesByHealthIds([finding.id]);
    const candidate = candidates.find(({ id: candidateId }) => candidateId === entry.candidateId);
    if (!candidate || candidate.status !== MediaHealthStatus.Found) {
      return changed(id, 'The reviewed copy is no longer a verified match');
    }
    if (asset.isExternal && !asset.libraryId) {
      return changed(id, 'External asset no longer belongs to a library');
    }

    const kind = this.candidateRootKind(candidate);
    if (kind === 'recovery') {
      if (asset.isExternal) {
        return unverified(id, 'External originals are relinked within their own library');
      }
      return this.publishAndCommit(auth.user, finding, asset, candidate, MediaHealthCategory.Missing);
    }
    const source = await this.sourceFolderOf(candidate);
    if (source) {
      // F3, Task 11b: a reviewer's relink copies too; the library never comes to depend on an import's folders
      return this.copyBackReviewed(auth, finding, asset, candidates, candidate, source);
    }
    return this.relinkInPlace(auth.user.id, finding, asset, candidate);
  }

  /**
   * A reviewer's relink to a copy in a folder an Immich import read from (Task 11b): the copy goes into the photo's
   * own place in library storage, as the automatic put-back does, verified and never over anything, and the old
   * app's file is left as it is. Only the copy a relink could use: the one verified copy, or the one chosen.
   */
  private async copyBackReviewed(
    auth: AuthDto,
    finding: MediaHealthFinding,
    asset: MediaHealthAsset,
    candidates: MediaHealthCandidate[],
    candidate: MediaHealthCandidate,
    source: string,
  ): Promise<BulkOperationItem> {
    const id = asset.id;
    if (this.relinkCandidate(finding, candidates, auth)?.id !== candidate.id) {
      return changed(id, 'The reviewed copy is no longer the one to relink');
    }
    const result = await this.copyBackFromSource(asset, finding, candidate, source, [], auth.user.name);
    switch (result) {
      case 'copied': {
        return outcome(id, MediaOperationItemStatus.Ok);
      }
      case 'wait': {
        return transient(id, "The drive this photo is kept on can't be reached right now");
      }
      case 'refused': {
        return unverified(id, 'Only a photo kept in library storage can be copied back from these folders');
      }
      case 'unverified': {
        return unverified(id, 'Candidate no longer matches or could not be safely linked');
      }
      case 'failed': {
        return transient(id, "The copy couldn't be written to the photo's place");
      }
      case 'settled': {
        return changed(id, 'The finding changed during the relink');
      }
    }
  }

  /**
   * Link a missing original to its verified copy where the copy is (FL-69): library storage, or the
   * asset's own external library. The copy is hashed again now. FL-1337: a fix passes how it leaves the
   * finding and the steps it adds, written with the relink.
   */
  private async relinkInPlace(
    actorId: string,
    finding: MediaHealthFinding,
    asset: MediaHealthAsset,
    candidate: MediaHealthCandidate,
    fix?: FixWrite,
  ): Promise<BulkOperationItem> {
    const id = asset.id;
    const digests = await this.validateManagedCandidate(asset, candidate.candidatePath);
    if (!digests) {
      return unverified(id, 'Candidate no longer matches or could not be safely linked');
    }

    let stat: Awaited<ReturnType<StorageRepository['stat']>>;
    try {
      stat = await this.storageRepository.stat(candidate.candidatePath);
    } catch (error) {
      return transient(id, `Candidate is no longer readable: ${getErrorMessage(error)}`);
    }
    const input = {
      assetId: asset.id,
      candidateId: candidate.id,
      ownerId: asset.ownerId,
      healthId: finding.id,
      expectedUpdateId: asset.updateId,
      expectedChecksumAlgorithm: asset.checksumAlgorithm,
      expectedOriginalPath: asset.originalPath,
      originalPath: candidate.candidatePath,
      originalFileName: asset.originalFileName,
      expectedChecksum: asset.checksum,
      ...digests,
      fileModifiedAt: stat.mtime,
      provenance: { relinkedBy: actorId, ...(fix && { automatic: true }), rootId: this.candidateRootId(candidate) },
      ...(fix && { evidence: fix.evidence, steps: fix.steps }),
      verifyCandidate: () => this.cryptoRepository.hashFileDigests(candidate.candidatePath).catch((): undefined => {}),
    };
    const relinked = asset.isExternal
      ? await this.mediaHealthRepository.relinkExternalAsset({ ...input, expectedLibraryId: asset.libraryId! })
      : await this.mediaHealthRepository.relinkManagedAsset(input);
    if (!relinked) {
      if (await this.alreadySettledWith(finding.id, candidate.id)) {
        return outcome(id, MediaOperationItemStatus.Ok);
      }
      return changed(id, 'Asset or finding changed during relink');
    }
    await this.queueRelinkJobs(asset.id);
    return outcome(id, MediaOperationItemStatus.Ok);
  }

  private async recoverOne(auth: AuthDto, entry: BulkMediaHealthEntry): Promise<BulkOperationItem> {
    const target = await this.workerTarget(auth, entry, MediaHealthCategory.Corrupt);
    if ('outcome' in target) {
      return target.outcome;
    }
    const { finding, asset } = target;
    const id = entry.assetId;

    if (finding.status === MediaHealthStatus.Resolved && this.resolvedWith(finding, entry)) {
      // Finish what a lost worker may have left: the damaged file goes to its retained place.
      await this.retainDamagedOriginal(finding.id);
      return outcome(id, MediaOperationItemStatus.Ok);
    }
    if (finding.status !== MediaHealthStatus.CorruptConfirmed) {
      // Unsupported RAW and suspected damage are never replaced.
      return changed(id, 'Only confirmed damage can be replaced');
    }
    if (await this.isEncryptedOriginal(asset)) {
      // FL-721 (spec §8.3): an encrypted Locked original is never repaired from a plain copy
      return changed(id, 'The original is encrypted in Locked');
    }
    if (asset.isExternal) {
      return unverified(id, 'External originals are relinked within their own library');
    }

    const candidates = await this.mediaHealthRepository.getCandidatesByHealthIds([finding.id]);
    const candidate = candidates.find(({ id: candidateId }) => candidateId === entry.candidateId);
    if (!candidate || candidate.status !== MediaHealthStatus.Found) {
      return changed(id, 'The reviewed copy is no longer a verified match');
    }
    return this.publishAndCommit(auth.user, finding, asset, candidate, MediaHealthCategory.Corrupt);
  }

  private async trashOne(auth: AuthDto, entry: BulkMediaHealthEntry): Promise<BulkOperationItem> {
    const target = await this.workerTarget(auth, entry, MediaHealthCategory.Corrupt, { allowTrashed: true });
    if ('outcome' in target) {
      return target.outcome;
    }
    const { finding, asset } = target;
    const id = entry.assetId;

    if (finding.status === MediaHealthStatus.Trashed) {
      // A batch applied again after a lost worker: this one is already in the trash.
      return outcome(id, MediaOperationItemStatus.Ok);
    }
    if (asset.deletedAt) {
      return changed(id, 'Already in the trash');
    }
    if (finding.status !== MediaHealthStatus.TrashQueued) {
      // Only a finding that passed the typed confirmation and revalidation at submit is ever moved.
      return changed(id, 'The finding was not confirmed for the trash');
    }
    if (await this.isEncryptedOriginal(asset)) {
      await this.releaseEncrypted(finding, asset);
      return outcome(
        id,
        MediaOperationItemStatus.Skipped,
        'frameleaf_bulk_reason_media_health_not_damaged',
        'The original is encrypted in Locked, so it was kept',
      );
    }

    const result = await this.validateAssetIntegrity(asset);
    if (result?.status === MediaHealthStatus.CorruptConfirmed) {
      if (!(await this.mediaHealthRepository.trashCorruptIfUnchanged({ healthId: finding.id, asset }))) {
        return changed(id, 'Asset or finding changed before it was moved to the trash');
      }
      await this.eventRepository.emit('AssetTrashAll', { assetIds: [asset.id], userId: asset.ownerId });
      return outcome(id, MediaOperationItemStatus.Ok);
    }

    // Revalidation no longer confirms damage: the item is kept and the finding says why.
    await this.mediaHealthRepository.upsertFinding({
      ...finding,
      expectedUpdateId: asset.updateId,
      runId: finding.runId,
      status: result?.status ?? MediaHealthStatus.Resolved,
      severity: result ? MediaHealthSeverity.Warning : MediaHealthSeverity.Info,
      evidence: result?.evidence ?? { reason: 'revalidation_passed' },
      resolution: result?.resolution ?? { trashSkipped: true },
      checkedAt: new Date(),
      resolvedAt: result ? null : new Date(),
    });
    return outcome(
      id,
      MediaOperationItemStatus.Skipped,
      'frameleaf_bulk_reason_media_health_not_damaged',
      'Revalidation did not confirm damage, so it was kept',
    );
  }

  /**
   * Publish a verified copy into library storage and point the asset at it (FL-69).
   *
   * The candidate is resolved inside its search location again (a link or a moved folder cannot
   * lead outside it), hashed against the original's recorded checksum and decoded. The copy goes to
   * a hidden Library Care folder in the owner's upload storage under a name fixed by the asset and
   * the finding, so a repeated attempt finds its own earlier copy instead of writing another. The
   * old path is never written to: for damage, the damaged file stays exactly where it is.
   *
   * `actor` is who recovers it: the reviewer, or (FL-1337) the owner when a fix does it by itself, which
   * passes how it leaves the finding and the steps it adds.
   */
  private async publishAndCommit(
    actor: { id: string; isAdmin: boolean },
    finding: MediaHealthFinding,
    asset: MediaHealthAsset,
    candidate: MediaHealthCandidate,
    category: MediaHealthCategory,
    fix?: FixWrite,
  ): Promise<BulkOperationItem> {
    const id = asset.id;
    const roots = await this.searchRoots();
    const root = rootForPath(roots, candidate.candidatePath);
    if (!root || root.kind === 'library' || (root.kind === 'recovery' && !actor.isAdmin)) {
      return unverified(id, 'The location of this copy is no longer available');
    }

    const rootPath = root.paths.find((folder) => isPathWithin(folder, candidate.candidatePath));
    const source = rootPath ? await resolveInsideRoot(rootPath, candidate.candidatePath) : undefined;
    if (!source) {
      return unverified(id, 'The copy is gone or now resolves outside its location');
    }

    const digests = await this.validateManagedCandidate(asset, source);
    if (!digests) {
      return unverified(id, 'The copy does not match the original checksum');
    }

    const decoded = await this.integrityService.validate({
      path: source,
      originalFileName: asset.originalFileName,
      type: asset.type,
      expected: { sha1: digests.sha1, sha256: digests.sha256, sizeInBytes: digests.sizeInBytes },
      deep: true,
    });
    if (decoded.status === 'timeout' || decoded.status === 'transient') {
      return transient(id, `Validation did not finish: ${decoded.reason}`);
    }
    if (decoded.status !== 'healthy') {
      return unverified(id, `The copy did not validate: ${decoded.reason}`);
    }

    let stat: Awaited<ReturnType<StorageRepository['stat']>>;
    try {
      stat = await this.storageRepository.stat(source);
    } catch (error) {
      return transient(id, `The copy is no longer readable: ${getErrorMessage(error)}`);
    }

    const extension = path.extname(asset.originalFileName).toLowerCase();
    const name = `${asset.id}-${finding.id}${/^\.[a-z0-9]{1,12}$/.test(extension) ? extension : ''}`;
    const destination = this.libraryCarePath(asset, name);
    if (!(await this.canReach(destination))) {
      // F2: never into the empty mount point of the Upload drive, which would hide the copy once it is back
      return transient(id, COPIES_DRIVE_AWAY);
    }
    await publishVerifiedCopy({
      source,
      destination,
      expected: digests,
      hash: (filePath) => this.cryptoRepository.hashFileDigests(filePath),
    });

    const committed = await this.mediaHealthRepository.relinkManagedAsset({
      assetId: asset.id,
      candidateId: candidate.id,
      ownerId: asset.ownerId,
      healthId: finding.id,
      expectedUpdateId: asset.updateId,
      expectedChecksumAlgorithm: asset.checksumAlgorithm,
      expectedOriginalPath: asset.originalPath,
      originalPath: destination,
      originalFileName: asset.originalFileName,
      expectedChecksum: asset.checksum,
      ...digests,
      fileModifiedAt: stat.mtime,
      category,
      candidatePath: candidate.candidatePath,
      provenance: {
        recoveredBy: actor.id,
        ...(fix && { automatic: true }),
        rootId: root.id,
        rootKind: root.kind,
        rootLabel: root.label,
        recoveredAt: new Date().toISOString(),
      },
      ...(fix && { evidence: fix.evidence, steps: fix.steps }),
      verifyCandidate: () => this.cryptoRepository.hashFileDigests(destination).catch((): undefined => {}),
    });
    if (!committed) {
      // A replayed batch may find its own earlier commit: that is this entry done, not a change.
      if (await this.alreadySettledWith(finding.id, candidate.id)) {
        await this.retainDamagedOriginal(finding.id);
        return outcome(id, MediaOperationItemStatus.Ok);
      }
      // The published copy is left in the hidden folder, unreferenced: deleting it here could race a
      // concurrent attempt that did commit it. A retry of this finding reuses it.
      this.logger.warn(`Library Care recovery of ${finding.id} did not commit; ${destination} was kept`);
      return changed(id, 'Asset or finding changed during recovery');
    }

    if (category === MediaHealthCategory.Corrupt) {
      const after = { originalPath: destination, checksum: digests.sha256.toString('hex') };
      const kept = fix?.kept;
      await this.retainDamagedOriginal(finding.id, kept && ((retainedPath) => kept(retainedPath, after)));
    }
    await this.queueRelinkJobs(asset.id);
    return outcome(id, MediaOperationItemStatus.Ok);
  }

  /**
   * The finding and asset a bulk entry names, read now and without an interactive privacy filter
   * (background work sees everything), then held to the rules a person would be held to.
   */
  private async workerTarget(
    auth: AuthDto,
    entry: BulkMediaHealthEntry,
    category: MediaHealthCategory,
    options: { allowTrashed?: boolean } = {},
  ): Promise<{ finding: MediaHealthFinding; asset: MediaHealthAsset } | { outcome: BulkOperationItem }> {
    const id = entry.assetId;
    const [finding] = await this.mediaHealthRepository.getByIds([entry.findingId]);
    if (!finding || finding.assetId !== entry.assetId || finding.category !== category) {
      return { outcome: outcome(id, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_not_found') };
    }

    const [asset] = await this.mediaHealthRepository.getAssets([finding.assetId]);
    if (!asset || (asset.deletedAt && !options.allowTrashed)) {
      return { outcome: outcome(id, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_not_found') };
    }

    // Another account's original: an administrator's to repair, never while it is Locked.
    if (asset.ownerId !== auth.user.id && (!auth.user.isAdmin || asset.isLocked)) {
      return { outcome: outcome(id, MediaOperationItemStatus.Skipped, 'frameleaf_bulk_reason_no_permission') };
    }

    return { finding, asset };
  }

  /** True when a settled finding was settled by this very entry, so replaying it is a success. */
  private resolvedWith(finding: MediaHealthFinding, entry: BulkMediaHealthEntry) {
    const resolution = (finding.resolution ?? {}) as Record<string, unknown>;
    return !!entry.candidateId && resolution.candidateId === entry.candidateId;
  }

  /** Read the finding again after a refused commit: was it settled by this very candidate? */
  private async alreadySettledWith(findingId: string, candidateId: string) {
    const [current] = await this.mediaHealthRepository.getByIds([findingId]);
    return (
      !!current &&
      (current.status === MediaHealthStatus.Relinked || current.status === MediaHealthStatus.Resolved) &&
      this.resolvedWith(current, { assetId: current.assetId, findingId, candidateId })
    );
  }

  /**
   * Keep a replaced damaged original, out of the way (FL-69).
   *
   * After a recovery the damaged file is no longer any asset's original. Left where it was, the
   * untracked-file crawler would bring the damage back as a new item the next time the library is
   * scanned — and a record on the finding cannot prevent that for ever, because findings are replaced
   * and deleted with their asset. So the file moves into the hidden Library Care folder next to the
   * recovered copy, which the crawler never enters. It is moved, never copied over anything: the move
   * is a hard link to a new name followed by removing the old name, and an existing name is never
   * replaced. A file some other asset still uses as its original is left exactly where it is.
   * Safe to repeat: a file already retained, or already gone, is left alone.
   *
   * FL-1337: `kept` is the history step for the kept file, given where it ended up; it is written with
   * the new place, or on its own when the file stays where it was.
   */
  private async retainDamagedOriginal(findingId: string, kept?: (retainedPath: string) => FindingStep): Promise<void> {
    const [finding] = await this.mediaHealthRepository.getByIds([findingId]);
    const evidence = (finding?.evidence ?? {}) as Record<string, unknown>;
    const retained = typeof evidence.retainedPath === 'string' ? evidence.retainedPath : undefined;
    if (!finding || !retained) {
      return;
    }
    const keptWhere = async () => {
      if (kept) {
        await this.mediaHealthRepository.appendSteps(this.stepsOf(finding, [kept(retained)]));
      }
    };
    if (retained.split(path.sep).includes(RECOVERY_FOLDER)) {
      return keptWhere();
    }

    if (await this.mediaHealthRepository.isOriginalPathInUse(retained)) {
      return keptWhere();
    }

    // Next to the recovered copy, which already lives in the Library Care folder.
    const recovered = path.dirname(finding.originalPath);
    const folder = path.basename(recovered) === RECOVERY_FOLDER ? recovered : path.join(recovered, RECOVERY_FOLDER);
    const extension = path.extname(retained).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
    const destination = path.join(folder, `${finding.assetId}-${finding.id}.damaged${suffix}`);
    const libraries = await this.libraryRepository.getAll().catch(() => []);
    if (!(await isFileRootReachable(this.storageRepository, destination, libraries))) {
      // Review Focus 1: never moved into the empty mount point of a drive that is not there, which would hide
      // it once the drive is back. It stays where it is, still recorded and never overwritten.
      this.logger.log(`Library care left the damaged file of ${finding.assetId} where it is until its drive is back`);
      return keptWhere();
    }
    try {
      await retainFile(retained, destination);
    } catch (error) {
      // Still recorded on the finding, and still not overwritten or lost: only its place is unchanged.
      this.logger.warn(`Could not move retained damaged file ${retained}: ${getErrorMessage(error)}`);
      return keptWhere();
    }
    if (kept) {
      await this.mediaHealthRepository.setRetainedPath(finding.id, destination, [kept(destination)]);
    } else {
      await this.mediaHealthRepository.setRetainedPath(finding.id, destination);
    }
  }

  /** Steps as the history of this finding (FL-1337). */
  private stepsOf(finding: Pick<MediaHealthFinding, 'id' | 'assetId'>, steps: FindingStep[]): NewFileStep[] {
    return steps.map((step) => ({ ...step, healthId: finding.id, assetId: step.assetId ?? finding.assetId }));
  }

  /**
   * The candidate a relink uses: the only verified copy, or the one the reviewer chose among several.
   * A search that is still incomplete verifies nothing (`autoRelinkable` stays false until it ends).
   */
  private relinkCandidate(finding: MediaHealthFinding, candidates: MediaHealthCandidate[], auth: AuthDto) {
    if (finding.status !== MediaHealthStatus.Found) {
      return;
    }
    const verified = candidates.filter(
      (candidate) =>
        candidate.status === MediaHealthStatus.Found &&
        (candidate.resolution as Record<string, unknown> | null)?.autoRelinkable === true &&
        (auth.user.isAdmin || this.candidateRootKind(candidate) !== 'recovery'),
    );
    const chosenId = (finding.resolution as Record<string, unknown> | null)?.chosenCandidateId;
    const chosen = verified.find(({ id }) => id === chosenId);
    return chosen ?? (verified.length === 1 ? verified[0] : undefined);
  }

  private candidateRootId(candidate: MediaHealthCandidate): string | null {
    const rootId = (candidate.evidence as Record<string, unknown> | null)?.rootId;
    return typeof rootId === 'string' ? rootId : null;
  }

  /** Where a candidate was found. Candidates recorded before FL-69 were library storage or a library. */
  private candidateRootKind(candidate: MediaHealthCandidate) {
    const rootId = this.candidateRootId(candidate);
    return rootId ? rootKindOf(rootId) : undefined;
  }

  /** Queue a Library Care bulk job for the accepted entries, or nothing when there are none. */
  private async submitBulk(
    auth: AuthDto,
    action: MediaOperationBulkAction,
    entries: BulkMediaHealthEntry[],
  ): Promise<string | null> {
    if (entries.length === 0) {
      return null;
    }
    const operation = await this.mediaOperationService.createBulk(
      auth,
      {
        action,
        assetIds: entries.map(({ assetId }) => assetId),
        payload: { mediaHealth: entries },
        scope: { source: 'library-care' },
      },
      { libraryCare: true },
    );
    return operation.id;
  }

  /* ------------------------------------------------------------------ */
  /* Durable scans and searches (FL-69), run by MediaHealthOperationService */
  /* ------------------------------------------------------------------ */

  /** A scan already under way answers with itself; a search under way has to finish first. */
  private async startDurableScan(
    auth: AuthDto,
    { assetIds }: Partial<MediaHealthScanDto> = {},
    resumeFrom?: MediaHealthScanResult,
  ): Promise<DurableScan> {
    // FL-737: chosen photos are scanned only where this person may see them, as their findings are listed.
    const scoped = assetIds
      ? (
          await this.mediaHealthRepository.getAssets(
            [...new Set(assetIds)],
            auth.user.isAdmin ? undefined : auth.user.id,
            this.privacyFor(auth),
          )
        ).map(({ id }) => id)
      : undefined;
    if (scoped?.length === 0) {
      throw new BadRequestException('None of these photos can be scanned');
    }
    return this.mediaHealthRepository.withLibraryCareLock(auth.user.id, () =>
      this.admitDurableScan(auth.user.id, { assetIds: scoped, resumeFrom: scoped ? undefined : resumeFrom }),
    );
  }

  private async admitDurableScan(
    ownerId: string,
    options: {
      changedSince?: string;
      scheduled?: boolean;
      assetIds?: string[];
      resumeFrom?: MediaHealthScanResult;
    } = {},
  ): Promise<DurableScan> {
    const active = await this.activeJob(ownerId);
    if (active) {
      const snapshot = parseMediaHealthSnapshot(active.snapshot);
      // FL-737: the scan under way answers only for photos it covers: a full scan covers any, a scan of
      // chosen photos only those, and an incremental one only changed photos, so none chosen here and
      // not a whole-library scan someone asked for (a scheduled one may share it: the next night catches up).
      const covered =
        snapshot.mode === 'scan' &&
        (options.assetIds
          ? snapshot.assetIds
            ? options.assetIds.every((id) => snapshot.assetIds!.includes(id))
            : !snapshot.changedSince
          : !snapshot.assetIds && (!snapshot.changedSince || !!options.scheduled));
      if (snapshot.mode === 'scan' && covered) {
        return { missingRunId: snapshot.missingRunId, corruptRunId: snapshot.corruptRunId, operationId: active.id };
      }
      if (snapshot.mode === 'scan') {
        throw new ConflictException('A scan of other photos is running. Wait for it or cancel it first.');
      }
      throw new ConflictException('A search for originals is running. Wait for it or cancel it first.');
    }

    const [missingRun, corruptRun] = await Promise.all([
      this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, ownerId),
      this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, ownerId),
    ]);
    const snapshot: MediaHealthOperationSnapshot = {
      mode: 'scan',
      userId: ownerId,
      missingRunId: missingRun.id,
      corruptRunId: corruptRun.id,
      ...(options.changedSince && { changedSince: options.changedSince }),
      ...(options.scheduled && { scheduled: true }),
      ...(options.assetIds && { assetIds: options.assetIds }),
    };
    try {
      // Total is counted again at the first claim: the library may have grown since the stopped scan.
      const resume = options.resumeFrom?.cursor ? { ...options.resumeFrom, total: null, restored: false } : null;
      const operation = await this.createHealthOperation(ownerId, snapshot, null, resume);
      return { missingRunId: missingRun.id, corruptRunId: corruptRun.id, operationId: operation.id };
    } catch (error) {
      const failure = { status: 'failed' as const, error: getErrorMessage(error) };
      await Promise.allSettled([
        this.mediaHealthRepository.finishRun(missingRun.id, failure),
        this.mediaHealthRepository.finishRun(corruptRun.id, failure),
      ]);
      throw error;
    }
  }

  private async activeJob(ownerId: string): Promise<MediaOperation | undefined> {
    const { items } = await this.mediaOperationRepository.list({
      ownerId,
      kind: MediaOperationKind.MediaHealth,
      statuses: ACTIVE_MEDIA_OPERATION_STATUSES,
      includeDismissed: true,
      take: 1,
      skip: 0,
    });
    return items[0];
  }

  private async requireNoActiveJob(ownerId: string) {
    if (await this.activeJob(ownerId)) {
      throw new HttpException(
        'A Library Care scan or search is already running. Wait for it or cancel it first.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private createHealthOperation(
    ownerId: string,
    snapshot: MediaHealthOperationSnapshot,
    total: number | null,
    result: MediaHealthScanResult | null = null,
  ) {
    return this.mediaOperationRepository.create({
      ownerId,
      kind: MediaOperationKind.MediaHealth,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: mediaHealthOperationLabel(snapshot),
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: {},
      estimate: null,
      result: result as unknown as Record<string, unknown> | null,
      totalUnits: total === null ? null : String(total),
    });
  }

  /** Assets an owner's durable scan covers: all of them, or those changed since `changedSince`. */
  countScanAssets(userId: string, changedSince?: string): Promise<number> {
    return changedSince
      ? this.mediaHealthRepository.countScanAssets(userId, new Date(changedSince))
      : this.mediaHealthRepository.countScanAssets(userId);
  }

  /**
   * One page of an owner's durable scan: the next assets in id order after `afterId`, each checked
   * exactly as the classic scan checks it. Safe to repeat: every write is an upsert keyed on the
   * asset and guarded by its update id.
   */
  async scanPage(
    snapshot: Extract<MediaHealthOperationSnapshot, { mode: 'scan' }>,
    afterId: string | null,
    limit: number,
  ): Promise<MediaHealthScanPage> {
    const assets = await this.mediaHealthRepository.getAssetPage({
      ownerId: snapshot.userId,
      afterId,
      limit,
      ...(snapshot.changedSince && { changedSince: new Date(snapshot.changedSince) }),
      ...(snapshot.assetIds && { assetIds: snapshot.assetIds }),
    });
    const { checksumScan } = await this.careSettings();
    const page: MediaHealthScanPage = { checked: 0, missing: 0, corrupt: 0, lastId: afterId };
    for (const asset of assets) {
      const found = await this.scanAsset(asset, snapshot.missingRunId, snapshot.corruptRunId, { checksumScan });
      page.checked++;
      page.lastId = asset.id;
      if (found === 'missing') {
        page.missing++;
      } else if (found === 'corrupt') {
        page.corrupt++;
      }
    }
    return page;
  }

  /** The scan's last step: bring back supported media in library storage that no asset tracks. */
  async restoreUntracked(userId: string): Promise<void> {
    await this.restoreUntrackedFiles(userId);
  }

  /** Record a durable scan's or search's state on its health runs, where the classic views read it. */
  async setRunState(
    snapshot: MediaHealthOperationSnapshot,
    state: MediaHealthRunState,
    counts: { checked: number; missing?: number; corrupt?: number; found?: number },
    error?: string | null,
  ): Promise<void> {
    const finished = ['completed', 'failed', 'cancelled'].includes(state);
    const base = {
      status: state,
      totalAssets: counts.checked,
      checkedAssets: counts.checked,
      error: error ?? null,
      ...(!finished && { finishedAt: null }),
    };
    const updates =
      snapshot.mode === 'scan'
        ? [
            this.mediaHealthRepository.finishRun(snapshot.missingRunId, { ...base, foundAssets: counts.missing ?? 0 }),
            this.mediaHealthRepository.finishRun(snapshot.corruptRunId, { ...base, foundAssets: counts.corrupt ?? 0 }),
          ]
        : [this.mediaHealthRepository.finishRun(snapshot.runId, { ...base, foundAssets: counts.found ?? 0 })];
    const settled = await Promise.allSettled(updates);
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.logger.warn(`Failed to record Library Care run state: ${getErrorMessage(result.reason)}`);
      }
    }
  }

  /**
   * One bounded step of a durable search for originals. Returns a continuation while the directory
   * walk is incomplete; then the job carries on from it on the same or a later claim.
   */
  async locateStep(
    snapshot: Extract<MediaHealthOperationSnapshot, { mode: 'locate' }>,
    managedSearch: ManagedSearchProgress | null,
  ): Promise<MediaHealthLocateStep> {
    // Another account's findings and recovery locations are an administrator's, checked again now.
    const needsAdmin = snapshot.anyOwner || (snapshot.rootIds ?? []).some((id) => rootKindOf(id) === 'recovery');
    if (needsAdmin) {
      const user = await this.userRepository.get(snapshot.userId, {});
      if (!user?.isAdmin) {
        throw new ForbiddenException('This search is only available to an administrator');
      }
    }
    return this.locateFindings({
      runId: snapshot.runId,
      findingIds: snapshot.findingIds,
      ownerId: snapshot.anyOwner ? undefined : snapshot.userId,
      rootIds: snapshot.rootIds,
      managedSearch: managedSearch ?? undefined,
      // FL-1337: Look in a folder adds what it finds there to what other searches found elsewhere
      keepOtherCandidates: !!snapshot.lookIn,
    });
  }

  @OnJob({ name: JobName.MediaHealthScanMissing, queue: QueueName.MediaHealth })
  async handleMissingScan(job: JobOf<JobName.MediaHealthScanMissing>): Promise<JobStatus> {
    return this.handleMediaHealthScan(job);
  }

  /**
   * The classic queued search (kept for jobs queued before FL-69): library storage and every
   * external library, continued in a new queue job while the directory walk is incomplete. Library
   * Care now runs the same search as a durable job (`locateStep`).
   */
  @OnJob({ name: JobName.MediaHealthLocateMissing, queue: QueueName.MediaHealth })
  async handleLocateMissing(job: JobOf<JobName.MediaHealthLocateMissing>): Promise<JobStatus> {
    // FL-1337: the fixes waiting on their owner's shared search. They are claimed when the walk starts,
    // so a search asked for while this one walks covers only what opened since; the walk carries on with
    // the same findings. A claim names the search: the job that started it, which a retry of that step
    // reruns, so a retried step claims its own findings again and a failed search's are claimed by the
    // next. It is background work for single photos, so it records no run of its own and never stands in
    // for the owner's last check.
    const pending = !!job.pending && !!job.userId;
    const searchId = pending ? (job.searchId ?? queueExecution.getStore()?.claim.id ?? randomUUID()) : undefined;
    const ids = job.ids ?? (pending ? await this.mediaHealthRepository.claimSearchPending(job.userId!, searchId!) : []);
    if (pending && ids.length === 0) {
      return JobStatus.Skipped;
    }
    let run = job.runId;
    if (!run && !pending) {
      const created = await this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, job.userId);
      run = created.id;
    }
    try {
      const { checkedAssets, foundAssets, continuation } = await this.locateFindings({
        runId: run ?? null,
        findingIds: ids,
        ownerId: job.userId,
        rootIds: null,
        managedSearch: job.managedSearch,
      });

      if (run) {
        await this.mediaHealthRepository.finishRun(run, {
          status: continuation ? 'running' : 'completed',
          ...(continuation && { finishedAt: null }),
          totalAssets: checkedAssets,
          checkedAssets,
          foundAssets,
          error: continuation
            ? 'Managed media lookup incomplete: continuing in another batch; automatic relinking is disabled'
            : null,
        });
      }
      if (continuation) {
        await this.jobRepository.queue({
          name: JobName.MediaHealthLocateMissing,
          data: { ...job, ...(pending && { ids, searchId }), runId: run, managedSearch: continuation },
        });
      } else if (pending) {
        await this.feedSearchedFixes(ids, job.userId!);
      }
      return JobStatus.Success;
    } catch (error) {
      if (run) {
        await this.mediaHealthRepository.finishRun(run, { status: 'failed', error: getErrorMessage(error) });
      }
      throw error;
    }
  }

  /** The shared search is complete: each fix still waiting for it decides from what it found (FL-1337). */
  private async feedSearchedFixes(ids: string[], ownerId: string): Promise<void> {
    const waiting = (await this.mediaHealthRepository.getByIds(ids, ownerId)).filter(
      (finding) => isOpenFinding(finding) && !!(finding.evidence as Record<string, unknown> | null)?.searchPending,
    );
    if (waiting.length > 0) {
      // F8: outside any run, so a later search's feed for the same photo is never dropped as already done
      await this.jobRepository.queueOutsideRun(
        waiting.map(({ assetId }) => ({
          name: JobName.MediaHealthFixAsset as const,
          data: { id: assetId, from: 'check' as const, searched: true },
        })),
      );
    }
  }

  /**
   * One bounded step of a search for the originals behind these findings.
   *
   * Missing originals are looked for by exact checksum in the chosen locations: library storage
   * (every account's, as before; another account's paths are described, never shown), the asset's
   * own external library, and — FL-69 — any recovery location an administrator chose. Confirmed
   * damage is looked for the same way, for a verified replacement. Every candidate records the
   * location it was found in, and once the walk is complete each exact match is decoded too, so the
   * review can show checksum and decode evidence separately. While the walk is incomplete nothing is
   * verified: candidates stay `candidate` and nothing can be relinked automatically.
   *
   * Safe to repeat: each finding's candidate list is replaced, never appended to.
   */
  private async locateFindings(input: {
    /** The run its missing findings are recorded against; null for the fixes' shared search (FL-1337). */
    runId: string | null;
    findingIds: string[];
    ownerId?: string;
    rootIds: string[] | null;
    managedSearch?: ManagedSearchProgress;
    /**
     * FL-1337: keep the candidates earlier searches found outside the locations this one walks, instead of
     * replacing the whole list (Look in a folder searches one folder).
     */
    keepOtherCandidates?: boolean;
  }): Promise<MediaHealthLocateStep> {
    const findings = await this.mediaHealthRepository.getByIds(input.findingIds, input.ownerId);
    const assets = await this.mediaHealthRepository.getAssets(
      findings.map(({ assetId }) => assetId),
      input.ownerId,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const roots = await this.searchRoots();
    const selected = input.rootIds ? new Set(input.rootIds) : null;
    const searchManaged = !selected || selected.has(MANAGED_ROOT_ID);
    const recoveryPaths = roots
      .filter((root) => root.kind === 'recovery' && !!selected?.has(root.id))
      .flatMap((root) => root.paths);
    const isSearchedLibrary = (asset: MediaHealthAsset) =>
      !!asset.libraryId && (!selected || selected.has(libraryRootId(asset.libraryId)));

    const managedAssets = assets.filter(({ isExternal }) => !isExternal);
    // FL-1337: the folders an Immich import read from are searched too, for as long as they are mounted
    const managedPaths = searchManaged
      ? [...(roots.find(({ id }) => id === MANAGED_ROOT_ID)?.paths ?? []), ...(await this.mountedSourceRoots())]
      : [];
    // FL-69: recovery locations an administrator chose are walked after library storage. Read only.
    const startRoots = [...managedPaths, ...recoveryPaths];
    const { candidates: managedCandidates, continuation } =
      startRoots.length > 0 || input.managedSearch
        ? await this.locateManagedCandidates(managedAssets, input.managedSearch, startRoots)
        : { candidates: new Map<string, CandidateValidation[]>(), continuation: undefined };
    const truncated = !!continuation;
    let checkedAssets = 0;
    let foundAssets = 0;
    const checkedIds: string[] = [];
    // what this search walks: earlier candidates anywhere else are kept when asked to
    const walked = [
      ...managedPaths,
      ...recoveryPaths,
      ...roots.filter((root) => root.kind === 'library' && !!selected?.has(root.id)).flatMap((root) => root.paths),
    ];

    const externalCandidates = continuation
      ? new Map<string, CandidateValidation[]>()
      : await this.locateExternalCandidates(assets.filter((asset) => asset.isExternal && isSearchedLibrary(asset)));

    for (const finding of findings) {
      const asset = assetsById.get(finding.assetId);
      if (!asset) {
        continue;
      }
      const isMissing = finding.category === MediaHealthCategory.Missing;
      const isDamaged =
        finding.category === MediaHealthCategory.Corrupt && finding.status === MediaHealthStatus.CorruptConfirmed;
      if (
        (!isMissing && !isDamaged) ||
        (asset.isExternal && (continuation || !isMissing || !isSearchedLibrary(asset)))
      ) {
        continue;
      }
      checkedAssets++;
      checkedIds.push(finding.id);

      const found = asset.isExternal
        ? (externalCandidates.get(asset.id) ?? [])
        : (managedCandidates.get(asset.id) ?? []);
      const candidates = await Promise.all(
        found.map((candidate) => this.describeCandidate(candidate, asset, roots, truncated)),
      );
      if (candidates.some(({ status }) => status === MediaHealthStatus.Found)) {
        foundAssets++;
      }

      const fresh = candidates.map((candidate) => ({
        healthId: finding.id,
        candidatePath: candidate.evidence.path as string,
        status: candidate.status,
        visualMatchScore: candidate.score,
        evidence: candidate.evidence,
        resolution: candidate.resolution,
        checkedAt: new Date(),
      }));
      const freshPaths = new Set(fresh.map(({ candidatePath }) => candidatePath));
      const kept = input.keepOtherCandidates
        ? (await this.mediaHealthRepository.getCandidatesByHealthIds([finding.id]))
            .filter(
              ({ candidatePath }) =>
                !freshPaths.has(candidatePath) && walked.every((folder) => !isPathWithin(folder, candidatePath)),
            )
            .map(({ healthId, candidatePath, status, visualMatchScore, evidence, resolution, checkedAt }) => ({
              healthId,
              candidatePath,
              status,
              visualMatchScore,
              evidence,
              resolution,
              checkedAt,
            }))
        : [];
      await this.mediaHealthRepository.replaceCandidates(finding.id, [...kept, ...fresh]);

      const validCandidates = [...kept, ...fresh].filter(({ status }) => status === MediaHealthStatus.Found);
      // F7: only what this search found is written, onto the finding as it is now (the walk took a while): a
      // Keep, a dismissal, a put-back or a fix's state written meanwhile stays, and a closed finding is left as
      // it is. A new candidate list has new ids, so a choice made from the old list no longer applies.
      const result = {
        healthId: finding.id,
        assetId: asset.id,
        expectedUpdateId: asset.updateId,
        originalPath: asset.originalPath,
        evidence: {
          candidateCount: kept.length + fresh.length,
          validatedCandidateCount: validCandidates.length,
          searchTruncated: !asset.isExternal && truncated,
          ...(input.rootIds && { searchedRootIds: input.rootIds }),
        },
      };

      if (isDamaged) {
        // The damage itself is unchanged: keep its status and the time it was confirmed, which is
        // what the trash gate measures recency by.
        await this.mediaHealthRepository.recordSearchResult({ ...result, resolution: {} });
        continue;
      }

      const findingStatus =
        validCandidates.length > 0
          ? MediaHealthStatus.Found
          : kept.length + fresh.length > 0
            ? MediaHealthStatus.Candidate
            : MediaHealthStatus.Missing;

      await this.mediaHealthRepository.recordSearchResult({
        ...result,
        resolution: { autoRelinkable: validCandidates.length === 1 },
        found: {
          status: findingStatus,
          severity:
            findingStatus === MediaHealthStatus.Missing ? MediaHealthSeverity.Critical : MediaHealthSeverity.Warning,
          runId: input.runId,
        },
      });
    }

    return { checkedAssets, foundAssets, continuation, checkedIds };
  }

  /**
   * Add where a candidate was found and, once the search is complete, whether an exact match also
   * decodes. A checksum match is what proves identity; decoding is recorded separately because a
   * replacement for damage must do both, and unsupported formats are not failures.
   */
  private async describeCandidate(
    candidate: CandidateValidation,
    asset: MediaHealthAsset,
    roots: MediaHealthRoot[],
    truncated: boolean,
  ): Promise<CandidateValidation> {
    const candidatePath = candidate.evidence.path as string;
    const root = rootForPath(roots, candidatePath);
    const evidence: Record<string, unknown> = {
      ...candidate.evidence,
      ...(root && { rootId: root.id, rootKind: root.kind }),
    };

    if (!truncated && candidate.status === MediaHealthStatus.Found) {
      const decoded = await this.integrityService.validate({
        path: candidatePath,
        originalFileName: asset.originalFileName,
        type: asset.type,
        deep: true,
      });
      evidence.decodeValid = decoded.status === 'healthy' ? true : decoded.status === 'corrupt' ? false : null;
      evidence.decodeStatus = decoded.status;
      if (decoded.status === 'healthy') {
        evidence.sizeInBytes = decoded.sizeInBytes;
      }
    }

    return { ...candidate, evidence };
  }

  @OnJob({ name: JobName.MediaHealthScanCorrupt, queue: QueueName.MediaHealth })
  async handleCorruptScan(job: JobOf<JobName.MediaHealthScanCorrupt>): Promise<JobStatus> {
    let run = job.runId;
    if (!run) {
      const created = await this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, job.userId);
      run = created.id;
    }
    let totalAssets = 0;
    let checkedAssets = 0;
    let foundAssets = 0;
    let encryptedAssets = 0;
    // Buffer healthy-asset resolutions and flush in batches. On large rescans
    // (millions of assets, mostly healthy) doing one UPDATE per asset inside
    // the streaming loop dominates the DB cost; batching collapses that.
    const RESOLVE_BATCH = 500;
    const resolveBuffer: MediaHealthAsset[] = [];
    const flushResolved = async () => {
      if (resolveBuffer.length === 0) {
        return;
      }
      await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Corrupt], resolveBuffer);
      resolveBuffer.length = 0;
    };

    try {
      for await (const asset of this.mediaHealthRepository.streamAssets({
        assetIds: job.assetIds,
        ownerId: job.userId,
      })) {
        totalAssets++;
        if (await this.isEncryptedOriginal(asset)) {
          // FL-721 (spec §8.3): encrypted, not checked; never a finding and never resolved by this run
          encryptedAssets++;
          continue;
        }
        checkedAssets++;
        const checked = await this.validateReadableAssetIntegrity(asset);
        if (checked && 'busy' in checked) {
          // Not a verdict: leave this asset's findings as they are
          continue;
        }
        const result = checked;
        if (!result) {
          resolveBuffer.push(asset);
          if (resolveBuffer.length >= RESOLVE_BATCH) {
            await flushResolved();
          }
          continue;
        }

        if (result.status === MediaHealthStatus.Missing) {
          continue;
        }
        foundAssets++;
        await this.mediaHealthRepository.upsertFinding({
          runId: run,
          assetId: asset.id,
          expectedUpdateId: asset.updateId,
          category: MediaHealthCategory.Corrupt,
          status: result.status,
          severity:
            result.status === MediaHealthStatus.CorruptConfirmed
              ? MediaHealthSeverity.Critical
              : result.status === MediaHealthStatus.UnsupportedRaw
                ? MediaHealthSeverity.Info
                : MediaHealthSeverity.Warning,
          originalPath: asset.originalPath,
          originalFileName: asset.originalFileName,
          evidence: result.evidence,
          resolution: result.resolution,
          checkedAt: new Date(),
        });
      }

      await flushResolved();
      this.logEncrypted(encryptedAssets);

      await this.mediaHealthRepository.finishRun(run, {
        status: 'completed',
        totalAssets,
        checkedAssets,
        foundAssets,
      });
      return JobStatus.Success;
    } catch (error) {
      await flushResolved();
      await this.mediaHealthRepository.finishRun(run, { status: 'failed', error: getErrorMessage(error) });
      throw error;
    }
  }

  @OnJob({ name: JobName.MediaHealthDeleteCorrupt, queue: QueueName.MediaHealth })
  async handleDeleteCorrupt(job: JobOf<JobName.MediaHealthDeleteCorrupt>): Promise<JobStatus> {
    const findings = await this.mediaHealthRepository.getByIds(job.ids, job.userId);
    const assets = await this.mediaHealthRepository.getAssets(
      findings.map(({ assetId }) => assetId),
      job.userId,
    );
    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const assetIdsToTrash: string[] = [];

    for (const finding of findings) {
      const asset = assetsById.get(finding.assetId);
      if (!asset || finding.status !== MediaHealthStatus.TrashQueued) {
        continue;
      }
      if (await this.isEncryptedOriginal(asset)) {
        // FL-721 (spec §8.3): never trashed, however it was queued
        await this.releaseEncrypted(finding, asset);
        continue;
      }

      const result = await this.validateAssetIntegrity(asset);
      if (result?.status === MediaHealthStatus.CorruptConfirmed) {
        if (await this.mediaHealthRepository.trashCorruptIfUnchanged({ healthId: finding.id, asset })) {
          assetIdsToTrash.push(finding.assetId);
        }
      } else {
        await this.mediaHealthRepository.upsertFinding({
          ...finding,
          expectedUpdateId: asset.updateId,
          runId: finding.runId,
          status: result?.status ?? MediaHealthStatus.Resolved,
          severity: result ? MediaHealthSeverity.Warning : MediaHealthSeverity.Info,
          evidence: result?.evidence ?? { reason: 'revalidation_passed' },
          resolution: result?.resolution ?? { trashSkipped: true },
          checkedAt: new Date(),
          resolvedAt: result ? null : new Date(),
        });
      }
    }

    if (assetIdsToTrash.length > 0) {
      await this.eventRepository.emit('AssetTrashAll', {
        assetIds: assetIdsToTrash,
        userId: job.userId,
      });
    }

    return JobStatus.Success;
  }

  private mapRun(run: MediaHealthRun): MediaHealthRunResponseDto {
    return {
      id: run.id,
      category: run.category,
      status: run.status,
      startedAt: asDateTimeString(run.startedAt),
      finishedAt: run.finishedAt ? asDateTimeString(run.finishedAt) : null,
      totalAssets: run.totalAssets,
      checkedAssets: run.checkedAssets,
      foundAssets: run.foundAssets,
      error: run.error,
    };
  }

  /**
   * The classic queued scan: an administrator's whole-library run from the job queues, or a job
   * queued before FL-69. Library Care runs the same per-asset checks as a durable job (`scanPage`).
   */
  private async handleMediaHealthScan(job: JobOf<JobName.MediaHealthScanMissing>): Promise<JobStatus> {
    const hasMissingRun = job.missingRunId || job.runId;
    const isLegacyMissingOnly = !job.missingRunId && !!job.runId && !job.corruptRunId;
    const includeCorrupt = !isLegacyMissingOnly;
    const [createdMissingRun, createdCorruptRun] = await Promise.all([
      hasMissingRun ? null : this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, job.userId),
      includeCorrupt && !job.corruptRunId
        ? this.mediaHealthRepository.createRun(MediaHealthCategory.Corrupt, job.userId)
        : null,
    ]);
    const missingRunId = job.missingRunId ?? job.runId ?? createdMissingRun!.id;
    const corruptRunId = includeCorrupt ? (job.corruptRunId ?? createdCorruptRun!.id) : null;
    let checkedAssets = 0;
    let missingFoundAssets = 0;
    let corruptFoundAssets = 0;
    let encryptedAssets = 0;

    try {
      const { checksumScan } = await this.careSettings();
      for await (const asset of this.mediaHealthRepository.streamAssets({
        assetIds: job.assetIds,
        ownerId: job.userId,
      })) {
        checkedAssets++;
        const found = await this.scanAsset(asset, missingRunId, corruptRunId, { checksumScan });
        switch (found) {
          case 'missing': {
            missingFoundAssets++;
            break;
          }
          case 'corrupt': {
            corruptFoundAssets++;
            break;
          }
          case 'encrypted': {
            encryptedAssets++;
            break;
          }
          case 'healthy':
          case 'busy': {
            break;
          }
        }
      }
      this.logEncrypted(encryptedAssets);

      if (job.userId) {
        await this.restoreUntrackedFiles(job.userId);
      }

      const finishCalls = [
        this.mediaHealthRepository.finishRun(missingRunId, {
          status: 'completed',
          totalAssets: checkedAssets,
          checkedAssets,
          foundAssets: missingFoundAssets,
        }),
      ];
      if (corruptRunId) {
        finishCalls.push(
          this.mediaHealthRepository.finishRun(corruptRunId, {
            status: 'completed',
            totalAssets: checkedAssets,
            // FL-721: an encrypted Locked original is "encrypted, not checked" for damage
            checkedAssets: checkedAssets - encryptedAssets,
            foundAssets: corruptFoundAssets,
          }),
        );
      }
      await Promise.all(finishCalls);
      return JobStatus.Success;
    } catch (error) {
      const update = { status: 'failed' as const, error: getErrorMessage(error) };
      const failCalls = [this.mediaHealthRepository.finishRun(missingRunId, update)];
      if (corruptRunId) {
        failCalls.push(this.mediaHealthRepository.finishRun(corruptRunId, update));
      }
      const settled = await Promise.allSettled(failCalls);
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.logger.warn(`Failed to mark media health run as failed: ${getErrorMessage(result.reason)}`);
        }
      }
      throw error;
    }
  }

  /**
   * Check one asset: is its original there, and — when damage is part of the run — does it read
   * back intact? Records a missing or damaged finding, or resolves the asset's open ones, and says
   * which it was. Unsupported RAW and suspected damage are recorded as themselves, never as
   * confirmed damage. Safe to repeat.
   */
  private async scanAsset(
    asset: MediaHealthAsset,
    missingRunId: string,
    corruptRunId: string | null,
    { checksumScan = true }: { checksumScan?: boolean } = {},
  ): Promise<'missing' | 'corrupt' | 'healthy' | 'encrypted' | 'busy'> {
    const sourceExists = await this.storageRepository.checkFileExists(asset.originalPath, constants.R_OK);
    if (!sourceExists) {
      if (!(await this.isDriveReachable(asset))) {
        return 'busy';
      }
      await this.recordFileProblem(asset, {
        runId: missingRunId,
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Missing,
        severity: MediaHealthSeverity.Critical,
        evidence: { reason: 'source_file_missing_or_unreadable' },
        resolution: { autoRelinkable: !!asset.isExternal && !!asset.libraryId },
      });
      return 'missing';
    }

    if (!corruptRunId) {
      await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);
      return 'healthy';
    }
    if (await this.isEncryptedOriginal(asset)) {
      // FL-721 (spec §8.3): it is there, so not missing; encrypted, so not checked for damage
      await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);
      return 'encrypted';
    }
    // "Verify original checksums" off: the scan still reads and decodes every original, but no longer
    // proves it is the recorded file. Repairs and the trash always verify, whatever this says.
    const result = await this.validateReadableAssetIntegrity(asset, { verifyChecksum: checksumScan });
    if (result && 'busy' in result) {
      // Not a verdict: leave every finding for this asset exactly as it is until the next run
      return 'busy';
    }
    if (!result) {
      await this.mediaHealthRepository.markResolvedForAssets(
        [MediaHealthCategory.Missing, MediaHealthCategory.Corrupt],
        [asset],
      );
      return 'healthy';
    }
    if (result.status === MediaHealthStatus.Missing) {
      if (!(await this.isDriveReachable(asset))) {
        return 'busy';
      }
      await this.recordFileProblem(asset, {
        runId: missingRunId,
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Missing,
        severity: MediaHealthSeverity.Critical,
        evidence: result.evidence,
        resolution: result.resolution,
      });
      return 'missing';
    }
    await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);

    await this.recordFileProblem(
      asset,
      {
        runId: corruptRunId,
        category: MediaHealthCategory.Corrupt,
        status: result.status,
        severity:
          result.status === MediaHealthStatus.CorruptConfirmed
            ? MediaHealthSeverity.Critical
            : result.status === MediaHealthStatus.UnsupportedRaw
              ? MediaHealthSeverity.Info
              : MediaHealthSeverity.Warning,
        evidence: result.evidence,
        resolution: result.resolution,
      },
      // the decoder's own words only (F1): a reason such as a checksum mismatch is not something it said
      result.message,
    );
    return 'corrupt';
  }

  /** The folders an Immich import read its photos from. */
  private async sourceRoots(): Promise<string[]> {
    const stored = await this.systemMetadataRepository.get(SystemMetadataKey.FileFixSourceRoots);
    return (Array.isArray(stored) ? stored : []).filter((folder): folder is string => typeof folder === 'string');
  }

  /** The folders an Immich import read its photos from, while each is there to be read (an unplugged one is left out). */
  private async mountedSourceRoots(): Promise<string[]> {
    const mounted: string[] = [];
    for (const folder of await this.sourceRoots()) {
      if ((await pathState(this.storageRepository, folder)) === 'present') {
        mounted.push(folder);
      }
    }
    return mounted;
  }

  /** Whether the drive the original lives on can be reached; on an unplugged one every file looks lost. */
  private isDriveReachable(asset: Pick<MediaHealthAsset, 'originalPath'>): Promise<boolean> {
    return this.canReach(asset.originalPath);
  }

  /**
   * Record what a file check found and, when it is a new problem, hand it to the fix (FL-1337). A new problem
   * is one of a category that was not open (F6): none yet, or one that comes back after it was resolved or
   * dismissed. It gets the step that found it, written with the finding, and a first finding also the first
   * line of its history from what the photo row knows. A change of status within an open problem (missing to
   * found, suspected to confirmed damage) is the same problem: refreshed, with no step, nothing queued and
   * how the fix left it kept. Every problem a check records is handed over, including a file it can't decode
   * (F5), which the fix leaves as it is, and a suspected one, which the fix looks at again.
   */
  private async recordFileProblem(
    asset: MediaHealthAsset,
    problem: Pick<UpsertMediaHealthFinding, 'runId' | 'category' | 'status' | 'severity' | 'evidence' | 'resolution'>,
    message?: string,
  ): Promise<void> {
    const existing = ((await this.mediaHealthRepository.getFindingsForAsset(asset.id)) ?? []).find(
      ({ category }) => category === problem.category,
    );
    const isNew = !existing || !isOpenFinding(existing);
    // An open problem nobody has handled yet (an import wrote it, or it predates the fix) is handed over once;
    // handling gives it a fix state, or a search waiting for its next try, and it is not handed over again.
    const evidence = (existing?.evidence ?? {}) as Record<string, unknown>;
    const unhandled = !isNew && evidence.fixState === undefined && evidence.searchPending === undefined;
    const hands = isNew || unhandled;
    const steps: FindingStep[] = [];
    if (!existing) {
      // only what the row knows: it carries no upload device or import origin, and nothing records a move
      steps.push({ step: 'added', outcome: 'info', at: asset.createdAt });
    }
    // What the check found starts the story, but not "won't open" for a file that is only not the one
    // Frameleaf stored (it may open), nor for one it can't decode: the fix says what it found about those.
    const says =
      problem.category === MediaHealthCategory.Missing
        ? 'not-on-drive'
        : problem.status !== MediaHealthStatus.UnsupportedRaw && problem.evidence?.reason !== 'expected_mismatch'
          ? 'wont-open'
          : undefined;
    if (isNew && says) {
      steps.push({
        step: says,
        outcome: 'failed',
        facts: folderFacts(await this.ownerFolders(asset), asset.originalPath),
      });
    }
    const finding = await this.mediaHealthRepository.upsertFinding({
      ...problem,
      assetId: asset.id,
      expectedUpdateId: asset.updateId,
      originalPath: asset.originalPath,
      originalFileName: asset.originalFileName,
      checkedAt: new Date(),
      steps,
    });
    if (finding && hands) {
      await this.jobRepository.queue({
        name: JobName.MediaHealthFixAsset,
        data: { id: asset.id, from: 'check', ...(message && { message }) },
      });
    }
  }

  private async validateAssetIntegrity(asset: MediaHealthAsset): Promise<CandidateValidation | null>;
  private async validateAssetIntegrity(
    asset: MediaHealthAsset,
    options: { keepBusy: true },
  ): Promise<CandidateValidation | BusyValidation | null>;
  private async validateAssetIntegrity(
    asset: MediaHealthAsset,
    options?: { keepBusy?: boolean },
  ): Promise<CandidateValidation | BusyValidation | null> {
    const result = await this.validateReadableAssetIntegrity(asset);
    // The trash paths keep treating "could not check" as a suspect, as before. A caller that must
    // leave things as they are on a busy check asks for the busy outcome itself.
    return result && 'busy' in result && !options?.keepBusy ? result.candidate : result;
  }

  /**
   * FL-721 (spec §8.3): the original is a sealed Locked file (it starts with `FLLK`). Its bytes are
   * ciphertext, so no decode or checksum here can speak for it: it is never marked damaged, moved to
   * the trash or repaired. Its GCM tags prove it intact when it is opened.
   */
  private isEncryptedOriginal(asset: Pick<MediaHealthAsset, 'originalPath'>): Promise<boolean> {
    return isLockedPath(asset.originalPath);
  }

  /**
   * FL-1364: a file Library care kept of the photo is sealed with it while it is Locked and encrypted, and
   * opened again when it leaves (the Locked file registry lists it). One that is still sealed (it was on a
   * drive that was away while the photo left Locked) is ciphertext: never downloaded or put back by Undo.
   */
  private async keptFileSealed(...paths: Array<string | undefined>): Promise<boolean> {
    for (const kept of paths) {
      if (kept && (await isLockedPath(kept))) {
        return true;
      }
    }
    return false;
  }

  /** A damage finding on an encrypted original leaves the trash queue: kept, and why. */
  private async releaseEncrypted(finding: MediaHealthFinding, asset: MediaHealthAsset): Promise<MediaHealthStatus> {
    await this.mediaHealthRepository.upsertFinding({
      ...finding,
      expectedUpdateId: asset.updateId,
      runId: finding.runId,
      status: MediaHealthStatus.Resolved,
      severity: MediaHealthSeverity.Info,
      evidence: { reason: 'locked_encrypted' },
      resolution: { trashSkipped: true },
      checkedAt: new Date(),
      resolvedAt: new Date(),
    });
    return MediaHealthStatus.Resolved;
  }

  private logEncrypted(count: number) {
    if (count > 0) {
      this.logger.log(`${count} encrypted Locked original(s) were not checked for damage`);
    }
  }

  private async restoreUntrackedFiles(userId: string): Promise<void> {
    const user = await this.userRepository.get(userId, {});
    if (!user) {
      return;
    }

    let importedBytes = 0;
    const pathsToCrawl = [
      StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
      StorageCore.getLibraryFolder(user),
    ];
    for await (const batch of this.storageRepository.walk({
      pathsToCrawl,
      exclusionPatterns: [],
      includeHidden: false,
      take: 500,
    })) {
      const mediaPaths = batch.filter((candidatePath) => mimeTypes.isAsset(candidatePath));
      const tracked = await this.mediaHealthRepository.getTrackedPaths(mediaPaths);
      for (const candidatePath of mediaPaths) {
        if (tracked.has(candidatePath)) {
          continue;
        }
        if (await isLockedPath(candidatePath)) {
          // FL-721: a sealed Locked file is never brought back as a new photo of its ciphertext
          continue;
        }

        const settled = await this.settledUntrackedFile(candidatePath);
        if (!settled) {
          continue;
        }
        let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
        try {
          digests = await this.cryptoRepository.hashFileDigests(candidatePath);
        } catch (error) {
          this.logger.warn(`Skipping unreadable recovered file ${candidatePath}: ${getErrorMessage(error)}`);
          continue;
        }
        // the digests speak for the file only if it is still the same file, unchanged, that was read
        const after = await fileIdentity(this.storageRepository, candidatePath);
        if (!after || after.key !== settled.key || digests.sizeInBytes !== settled.size) {
          this.logger.debug(`Skipping recovered file ${candidatePath}: it changed while it was read`);
          continue;
        }
        const checksumAssets = await this.assetRepository.getByChecksums(userId, [digests.sha1, digests.sha256]);
        // The owner's own photo whose original went missing (an interrupted storage move, typically):
        // this file is that original, so it goes back under the photo instead of being skipped.
        if (await this.restoreLostOriginalFrom(candidatePath, checksumAssets, digests)) {
          continue;
        }
        const duplicate =
          checksumAssets.length > 0 ||
          (await this.forkSchemaRepository.hasAssetChecksum(userId, digests.sha1, digests.sha256));
        if (duplicate) {
          continue;
        }
        if (
          user.quotaSizeInBytes !== null &&
          user.quotaUsageInBytes + importedBytes + digests.sizeInBytes > user.quotaSizeInBytes
        ) {
          this.logger.warn(`Skipping recovered file because user ${userId} has exceeded their quota`);
          continue;
        }

        let asset: Awaited<ReturnType<AssetRepository['create']>> | undefined;
        try {
          asset = await this.assetRepository.create({
            ownerId: userId,
            libraryId: null,
            checksum: digests.sha256,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            originalPath: path.normalize(candidatePath),
            fileCreatedAt: settled.mtime,
            fileModifiedAt: settled.mtime,
            localDateTime: settled.mtime,
            type: mimeTypes.assetType(candidatePath),
            isFavorite: false,
            duration: null,
            visibility: AssetVisibility.Timeline,
            livePhotoVideoId: null,
            originalFileName: path.basename(candidatePath),
          });
          await this.assetRepository.upsertExif({
            exif: { assetId: asset.id, fileSizeInByte: digests.sizeInBytes },
            lockedPropertiesBehavior: 'override',
          });
          await this.physicalFileRepository.ensureOriginalPhysicalFile(asset.id);
          await this.forkSchemaRepository.recordAssetChecksums({
            assetId: asset.id,
            ...digests,
            path: candidatePath,
            source: 'recovery',
          });
          await this.jobRepository.queue({
            name: JobName.AssetExtractMetadata,
            data: { id: asset.id, source: 'upload' },
          });
          await this.eventRepository.emit('AssetCreate', {
            asset,
            file: {
              uuid: asset.id,
              checksum: digests.sha256,
              legacyChecksum: digests.sha1,
              originalPath: candidatePath,
              originalName: path.basename(candidatePath),
              size: digests.sizeInBytes,
            },
          });
          importedBytes += digests.sizeInBytes;
        } catch (error) {
          if (asset) {
            await this.assetRepository.remove({ id: asset.id });
          }
          if (!isAssetChecksumConstraint(error)) {
            throw error;
          }
        }
      }
    }
  }

  /**
   * The untracked file as it is before it is read: a regular file that nothing has written to for a
   * while, with what identifies it (so the read can be checked against it afterwards) and its
   * modification time. Null for anything else: a file still being written, a non-file, or one that is
   * gone already.
   */
  private async settledUntrackedFile(
    candidatePath: string,
  ): Promise<{ key: string; size: number; mtime: Date } | null> {
    let stat: Awaited<ReturnType<StorageRepository['stat']>>;
    try {
      stat = await this.storageRepository.stat(candidatePath);
    } catch (error) {
      this.logger.warn(`Skipping missing recovered file ${candidatePath}: ${getErrorMessage(error)}`);
      return null;
    }
    if (!stat.isFile()) {
      return null;
    }
    if (Date.now() - stat.mtimeMs < UNTRACKED_FILE_SETTLE_MS) {
      this.logger.debug(`Skipping recovered file ${candidatePath}: it was written moments ago and may still be`);
      return null;
    }
    const identity = await fileIdentity(this.storageRepository, candidatePath);
    return identity ? { ...identity, mtime: stat.mtime } : null;
  }

  private async restoreLostOriginalFrom(
    candidatePath: string,
    matches: Awaited<ReturnType<AssetRepository['getByChecksums']>>,
    digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>,
  ): Promise<boolean> {
    const present = await Promise.all(
      matches.map(({ originalPath }) => this.storageRepository.checkFileExists(originalPath)),
    );
    if (matches.length === 0 || present.some(Boolean)) {
      return false;
    }
    for (const asset of matches) {
      if (asset.deletedAt || asset.libraryId || asset.isExternal) {
        continue;
      }
      const restored = await this.physicalFileRepository.restoreLostOriginal({
        assetId: asset.id,
        expectedOriginalPath: asset.originalPath,
        originalPath: candidatePath,
        ...digests,
        reason: 'restored_from_untracked_file',
      });
      if (restored) {
        await this.queueRelinkJobs(asset.id);
        return true;
      }
    }
    return false;
  }

  private async validateReadableAssetIntegrity(
    asset: MediaHealthAsset,
    { verifyChecksum = true }: { verifyChecksum?: boolean } = {},
  ): Promise<CandidateValidation | BusyValidation | null> {
    const result = await this.integrityService.validate({
      path: asset.originalPath,
      originalFileName: asset.originalFileName,
      type: asset.type,
      expected: verifyChecksum ? expectedDigest(asset) : undefined,
      deep: true,
    });
    if (result.status === 'healthy') {
      await this.recordContentDigests(asset, result);
      return null;
    }
    if (result.status === 'encrypted') {
      // FL-721: sealed since the caller looked; never damage (the callers skip it before this)
      return null;
    }
    const candidate: CandidateValidation = {
      status:
        result.status === 'missing' || result.status === 'unreadable'
          ? MediaHealthStatus.Missing
          : result.status === 'corrupt'
            ? MediaHealthStatus.CorruptConfirmed
            : result.status === 'unsupported'
              ? MediaHealthStatus.UnsupportedRaw
              : MediaHealthStatus.CorruptSuspect,
      score: null,
      evidence: { reason: result.reason, validationStatus: result.status },
      resolution: { reuploadRecommended: result.status === 'corrupt' },
      ...('message' in result && result.message && { message: result.message }),
    };
    // Busy, timed out, out of resources or still being written: not a verdict on the file. The scan skips
    // the asset this run. Other transient reasons (an unknown decoder error, a damaged RAW) stay suspects.
    const busy = result.status === 'timeout' || (result.status === 'transient' && BUSY_REASONS.has(result.reason));
    return busy ? { busy: true, candidate } : candidate;
  }

  /**
   * FL-69: an original whose own checksum is a path checksum (an external library's) records nothing
   * a copy could be proven against. While it is present and reads back intact, keep the digests of the
   * bytes just read, so a search can find it by content once it has moved. Only Library Care's copy
   * verification reads them (see `recordExternalScanChecksums`). A failed write never changes the scan.
   */
  private async recordContentDigests(
    asset: MediaHealthAsset,
    digests: { sha1?: Buffer; sha256?: Buffer; sizeInBytes?: number },
  ): Promise<void> {
    if (
      asset.checksumAlgorithm !== ChecksumAlgorithm.sha1Path ||
      !digests.sha1 ||
      !digests.sha256 ||
      digests.sizeInBytes === undefined
    ) {
      return;
    }
    try {
      await this.forkSchemaRepository.recordExternalScanChecksums({
        assetId: asset.id,
        sha1: digests.sha1,
        sha256: digests.sha256,
        sizeInBytes: digests.sizeInBytes,
        path: asset.originalPath,
      });
    } catch (error) {
      this.logger.warn(`Could not record the checksums of ${asset.originalPath}: ${getErrorMessage(error)}`);
    }
  }

  private async locateExternalCandidates(assets: MediaHealthAsset[]): Promise<Map<string, CandidateValidation[]>> {
    const result = new Map<string, CandidateValidation[]>();
    if (assets.length === 0) {
      return result;
    }

    const stored = await this.mediaHealthRepository.getAssetChecksums(assets.map(({ id }) => id));
    const storedByAsset = new Map(stored.map((checksum) => [checksum.assetId, checksum]));
    const targetByAsset = new Map<string, { asset: MediaHealthAsset; sha1: Buffer[]; sha256: Buffer[] }>();
    const sha1Targets = new Map<string, string[]>();
    const sha256Targets = new Map<string, string[]>();

    const addTarget = (index: Map<string, string[]>, digest: Buffer | undefined, assetId: string) => {
      if (!digest) {
        return;
      }
      const key = digest.toString('hex');
      index.set(key, [...(index.get(key) ?? []), assetId]);
    };

    for (const asset of assets) {
      if (!asset.libraryId) {
        continue;
      }
      const sidecar = storedByAsset.get(asset.id);
      const target = {
        asset,
        sha1: (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? []
            : [sidecar?.sha1]
        ).filter((digest): digest is Buffer => !!digest),
        sha256: (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? []
            : [sidecar?.sha256]
        ).filter((digest): digest is Buffer => !!digest),
      };
      targetByAsset.set(asset.id, target);
      for (const digest of target.sha1) {
        addTarget(sha1Targets, digest, asset.id);
      }
      for (const digest of target.sha256) {
        addTarget(sha256Targets, digest, asset.id);
      }
    }

    const assetsByLibrary = Map.groupBy(
      targetByAsset.values().map(({ asset }) => asset),
      ({ libraryId }) => libraryId!,
    );
    for (const [libraryId, libraryAssets] of assetsByLibrary) {
      const library = await this.libraryRepository.get(libraryId);
      if (!library) {
        continue;
      }
      const sizes = new Set(
        libraryAssets
          .map(({ id }) => storedByAsset.get(id)?.sizeInBytes)
          .filter((size): size is number => size !== undefined),
      );
      const hasUnknownSize = libraryAssets.some((asset) => {
        const sidecar = storedByAsset.get(asset.id);
        if (!sidecar) {
          return true;
        }
        return asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? !asset.checksum.equals(sidecar.sha1)
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? !asset.checksum.equals(sidecar.sha256)
            : true;
      });
      const originalPaths = new Set(libraryAssets.map(({ originalPath }) => originalPath));
      for await (const batch of this.storageRepository.walk({
        pathsToCrawl: library.importPaths,
        exclusionPatterns: library.exclusionPatterns,
        includeHidden: false,
        take: 500,
      })) {
        for (const candidatePath of batch) {
          if (originalPaths.has(candidatePath)) {
            continue;
          }
          let size: number;
          try {
            ({ size } = await this.storageRepository.stat(candidatePath));
          } catch (error) {
            this.logger.debug(`Could not stat external media candidate ${candidatePath}: ${getErrorMessage(error)}`);
            continue;
          }
          if (!hasUnknownSize && !sizes.has(size)) {
            continue;
          }
          let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
          try {
            digests = await this.cryptoRepository.hashFileDigests(candidatePath);
          } catch (error) {
            this.logger.debug(`Could not hash external media candidate ${candidatePath}: ${getErrorMessage(error)}`);
            continue;
          }
          const matched = [
            ...(sha1Targets.get(digests.sha1.toString('hex')) ?? []).map((assetId) => ({
              assetId,
              algorithm: 'sha1' as const,
            })),
            ...(sha256Targets.get(digests.sha256.toString('hex')) ?? []).map((assetId) => ({
              assetId,
              algorithm: 'sha256' as const,
            })),
          ];
          for (const { assetId, algorithm } of matched) {
            const target = targetByAsset.get(assetId);
            if (
              !target ||
              target.asset.libraryId !== libraryId ||
              (target.sha1.length > 0 && target.sha1.every((digest) => !digest.equals(digests.sha1))) ||
              (target.sha256.length > 0 && target.sha256.every((digest) => !digest.equals(digests.sha256)))
            ) {
              continue;
            }
            const candidates = result.get(assetId) ?? [];
            const previous = candidates.find((candidate) => candidate.evidence.path === candidatePath);
            if (previous) {
              previous.evidence.algorithms = [
                ...new Set([...((previous.evidence.algorithms as string[] | undefined) ?? []), algorithm]),
              ];
              continue;
            }
            const existing = await this.assetRepository.getByLibraryIdAndOriginalPath(libraryId, candidatePath);
            const importedAssetId = existing && existing.id !== assetId ? existing.id : undefined;
            candidates.push({
              status: importedAssetId ? MediaHealthStatus.Candidate : MediaHealthStatus.Found,
              score: 1,
              evidence: {
                path: candidatePath,
                reason: importedAssetId ? 'candidate_already_imported' : 'checksum_match',
                algorithms: [algorithm],
                // The file's own digests, as measured, for the review (FL-69).
                sha1: digests.sha1.toString('hex'),
                sha256: digests.sha256.toString('hex'),
                ...(importedAssetId && { assetId: importedAssetId }),
              },
              resolution: { autoRelinkable: !importedAssetId },
            });
            result.set(assetId, candidates);
          }
        }
      }
    }

    return result;
  }

  private async locateManagedCandidates(
    assets: MediaHealthAsset[],
    progress?: JobOf<JobName.MediaHealthLocateMissing>['managedSearch'],
    /** FL-69: where a new walk starts. Every account's library storage when not given. */
    startRoots?: string[],
  ) {
    const result = new Map<string, CandidateValidation[]>();
    if (assets.length === 0) {
      return { candidates: result, continuation: undefined };
    }

    const stored = await this.mediaHealthRepository.getAssetChecksums(assets.map(({ id }) => id));
    const storedByAsset = new Map(stored.map((checksum) => [checksum.assetId, checksum]));
    const knownSizes = new Set(stored.map(({ sizeInBytes }) => sizeInBytes));
    const hasUnknownSize = assets.some((asset) => {
      const sidecar = storedByAsset.get(asset.id);
      if (!sidecar) {
        return true;
      }
      return asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
        ? !asset.checksum.equals(sidecar.sha1)
        : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? !asset.checksum.equals(sidecar.sha256)
          : true;
    });
    const targetByAsset = new Map<string, { asset: MediaHealthAsset; sha1: Buffer[]; sha256: Buffer[] }>();
    const sha1Targets = new Map<string, string[]>();
    const sha256Targets = new Map<string, string[]>();

    const addTarget = (index: Map<string, string[]>, digest: Buffer | undefined, assetId: string) => {
      if (!digest) {
        return;
      }
      const key = digest.toString('hex');
      const ids = index.get(key) ?? [];
      if (!ids.includes(assetId)) {
        index.set(key, [...ids, assetId]);
      }
    };

    for (const asset of assets) {
      const sidecar = storedByAsset.get(asset.id);
      const target = {
        asset,
        sha1: (asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? []
            : [sidecar?.sha1]
        ).filter((digest): digest is Buffer => !!digest),
        sha256: (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? [asset.checksum]
          : asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
            ? []
            : [sidecar?.sha256]
        ).filter((digest): digest is Buffer => !!digest),
      };
      targetByAsset.set(asset.id, target);
      for (const digest of target.sha1) {
        addTarget(sha1Targets, digest, asset.id);
      }
      for (const digest of target.sha256) {
        addTarget(sha256Targets, digest, asset.id);
      }
    }

    if (!progress) {
      const roots =
        startRoots ??
        (await this.userRepository.getList()).flatMap((user) => [
          StorageCore.getFolderLocation(StorageFolder.Upload, user.id),
          StorageCore.getLibraryFolder(user),
        ]);
      progress = { cursor: [...new Set(roots)].toReversed().map((path) => ({ path })), matches: {} };
    }
    const matches = new Map(
      Object.entries(progress.matches).map(([assetId, byPath]) => [
        assetId,
        new Map(Object.entries(byPath).map(([path, algorithms]) => [path, new Set(algorithms)])),
      ]),
    );
    const originalPaths = new Set(assets.map(({ originalPath }) => originalPath));
    let hashedBytes = 0;

    for await (const candidatePath of this.storageRepository.walkWithCursor(
      progress.cursor,
      MANAGED_LOOKUP_MAX_ENTRIES,
    )) {
      if (originalPaths.has(candidatePath)) {
        continue;
      }
      try {
        const { size } = await this.storageRepository.stat(candidatePath);
        if (!hasUnknownSize && !knownSizes.has(size)) {
          continue;
        }
        hashedBytes += size;
      } catch (error) {
        this.logger.debug(`Could not stat missing media candidate ${candidatePath}: ${getErrorMessage(error)}`);
        continue;
      }
      let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
      try {
        digests = await this.cryptoRepository.hashFileDigests(candidatePath);
      } catch (error) {
        this.logger.debug(`Could not hash missing media candidate ${candidatePath}: ${getErrorMessage(error)}`);
        if (hashedBytes >= MANAGED_LOOKUP_MAX_BYTES) {
          break;
        }
        continue;
      }
      const matched = [
        ...(sha1Targets.get(digests.sha1.toString('hex')) ?? []).map((assetId) => ({
          assetId,
          algorithm: 'sha1' as const,
        })),
        ...(sha256Targets.get(digests.sha256.toString('hex')) ?? []).map((assetId) => ({
          assetId,
          algorithm: 'sha256' as const,
        })),
      ];
      for (const { assetId, algorithm } of matched) {
        const target = targetByAsset.get(assetId);
        if (
          !target ||
          (target.sha1.length > 0 && target.sha1.every((digest) => !digest.equals(digests.sha1))) ||
          (target.sha256.length > 0 && target.sha256.every((digest) => !digest.equals(digests.sha256)))
        ) {
          continue;
        }
        const byPath = matches.get(assetId) ?? new Map<string, Set<'sha1' | 'sha256'>>();
        const algorithms = byPath.get(candidatePath) ?? new Set<'sha1' | 'sha256'>();
        algorithms.add(algorithm);
        byPath.set(candidatePath, algorithms);
        matches.set(assetId, byPath);
      }
      // Finish a single file even if it exceeds the byte target, so large videos cannot stall the cursor.
      if (hashedBytes >= MANAGED_LOOKUP_MAX_BYTES) {
        break;
      }
    }

    const truncated = progress.cursor.length > 0;
    for (const [assetId, target] of targetByAsset) {
      const byPath = matches.get(assetId) ?? new Map<string, Set<'sha1' | 'sha256'>>();
      const sha1Paths = new Set([...byPath].filter(([, algorithms]) => algorithms.has('sha1')).map(([path]) => path));
      const sha256Paths = new Set(
        [...byPath].filter(([, algorithms]) => algorithms.has('sha256')).map(([path]) => path),
      );
      const conflict =
        target.sha1.length > 0 &&
        target.sha256.length > 0 &&
        sha1Paths.size > 0 &&
        sha256Paths.size > 0 &&
        [...sha1Paths].every((candidatePath) => !sha256Paths.has(candidatePath));

      result.set(
        assetId,
        [...byPath].map(([candidatePath, algorithms]) => ({
          status: conflict || truncated ? MediaHealthStatus.Candidate : MediaHealthStatus.Found,
          score: algorithms.size === 2 ? 1 : 0.99,
          evidence: {
            path: candidatePath,
            reason: conflict ? 'checksum_evidence_conflict' : 'checksum_match',
            algorithms: [...algorithms],
            searchTruncated: truncated,
            // A match is the recorded digest itself; kept for the review (FL-69).
            ...(algorithms.has('sha1') && target.sha1[0] && { sha1: target.sha1[0].toString('hex') }),
            ...(algorithms.has('sha256') && target.sha256[0] && { sha256: target.sha256[0].toString('hex') }),
          },
          resolution: { autoRelinkable: !conflict && !truncated },
        })),
      );
    }

    return {
      candidates: result,
      continuation: truncated
        ? {
            cursor: progress.cursor,
            matches: Object.fromEntries(
              [...matches].map(([assetId, byPath]) => [
                assetId,
                Object.fromEntries([...byPath].map(([path, algorithms]) => [path, [...algorithms]])),
              ]),
            ),
          }
        : undefined,
    };
  }

  private async validateManagedCandidate(asset: MediaHealthAsset, candidatePath: string) {
    if (await isLockedPath(candidatePath)) {
      // FL-721: a sealed file holds ciphertext; it is never proven against a plaintext checksum
      return;
    }
    let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
    try {
      digests = await this.cryptoRepository.hashFileDigests(candidatePath);
    } catch (error) {
      this.logger.debug(`Could not revalidate missing media candidate ${candidatePath}: ${error}`);
      return;
    }
    const sidecars = await this.mediaHealthRepository.getAssetChecksums([asset.id]);
    const sidecar = sidecars[0];
    const matches =
      asset.checksumAlgorithm === ChecksumAlgorithm.sha1File
        ? digests.sha1.equals(asset.checksum)
        : asset.checksumAlgorithm === ChecksumAlgorithm.sha256File
          ? digests.sha256.equals(asset.checksum)
          : !!sidecar && digests.sha1.equals(sidecar.sha1) && digests.sha256.equals(sidecar.sha256);
    return matches ? digests : undefined;
  }

  /**
   * The photo's file changed (a repair, a put-back, a restore, a relink or an Undo): its details and previews are
   * read again from the file it uses now.
   * - Its details as work of the asking job's run, as before: the metadata read that follows keeps an import's rules
   *   for its own photos (no motion photos, no bursts, the imported capture time).
   * - Its previews outside any run (Task 11b): a run the fix is a job of (an import, an administrator's Generate
   *   thumbnails) already holds this photo's finished thumbnail job, made from the old file, and would drop the
   *   request as done.
   * - FL-845: first, what failed on the file it had, or was set aside after failing three times, is cleared. It says
   *   nothing about the file it uses now, and a set-aside step would leave the fixed photo without its details or
   *   previews for good.
   */
  private async queueRelinkJobs(assetId: string): Promise<void> {
    await this.mediaHealthRepository.clearProcessingFailures(assetId);
    await this.jobRepository.queueAll([{ name: JobName.SidecarCheck, data: { id: assetId, source: 'upload' } }]);
    await this.jobRepository.queueOutsideRun([
      { name: JobName.AssetGenerateThumbnails, data: { id: assetId, source: 'upload' } },
    ]);
  }

  private groupCandidates(candidates: MediaHealthCandidate[]): Map<string, MediaHealthCandidate[]> {
    const grouped = new Map<string, MediaHealthCandidate[]>();
    for (const candidate of candidates) {
      grouped.set(candidate.healthId, [...(grouped.get(candidate.healthId) ?? []), candidate]);
    }
    return grouped;
  }

  /**
   * A candidate as its reader may see it. The path is printed when it is inside the finding owner's
   * own storage or external library, or — for an administrator — a recovery location; anywhere else
   * (another account's folder, a recovery location seen by a non-administrator) it is described
   * instead and removed from the evidence too. Checksum, decode and root evidence are always given.
   */
  private mapCandidateForRoots(
    candidate: MediaHealthCandidate,
    ownerRoots: string[] | null,
    searchRoots: MediaHealthRoot[],
    chosen: boolean,
    auth: AuthDto,
  ): MediaHealthCandidateResponse {
    const evidence = (candidate.evidence ?? {}) as Record<string, unknown>;
    const root = rootForPath(searchRoots, candidate.candidatePath);
    const rootId = typeof evidence.rootId === 'string' ? evidence.rootId : (root?.id ?? null);
    const rootKind = rootId ? (rootKindOf(rootId) ?? null) : null;
    const isOwned =
      rootKind === 'recovery'
        ? auth.user.isAdmin
        : !ownerRoots || this.isPathWithinRoots(candidate.candidatePath, ownerRoots);
    const { path: _candidatePath, ...redactedEvidence } = evidence;
    const algorithms = Array.isArray(evidence.algorithms) ? evidence.algorithms : [];

    return {
      id: candidate.id,
      healthId: candidate.healthId,
      candidatePath: isOwned
        ? candidate.candidatePath
        : rootKind === 'recovery'
          ? 'Exact checksum match in a recovery location'
          : 'Exact checksum match in another user directory',
      status: candidate.status,
      visualMatchScore: candidate.visualMatchScore,
      evidence: isOwned ? evidence : redactedEvidence,
      resolution: candidate.resolution,
      checkedAt: asDateTimeString(candidate.checkedAt),
      rootId,
      rootKind,
      checksumMatch: algorithms.length > 0 && evidence.reason !== 'checksum_evidence_conflict',
      decodeValid: typeof evidence.decodeValid === 'boolean' ? evidence.decodeValid : null,
      chosen,
      checksums: (['sha1', 'sha256'] as const)
        .filter((algorithm) => typeof evidence[algorithm] === 'string')
        .map((algorithm) => ({ algorithm, value: evidence[algorithm] as string })),
    };
  }

  /**
   * Who relinked or recovered this original, from which location and when (FL-69), read from the
   * finding's evidence as its reader may see it: for anyone but an administrator the provenance was
   * already left out there, so this is null.
   */
  private provenanceFor(
    evidence: Record<string, unknown>,
    finding: MediaHealthFinding,
    searchRoots: MediaHealthRoot[],
  ): MediaHealthItemResponse['provenance'] {
    const source = evidence.provenance;
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return null;
    }
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
    const record = source as Record<string, unknown>;
    const recoveredBy = text(record.recoveredBy);
    const relinkedBy = text(record.relinkedBy);
    if (!recoveredBy && !relinkedBy) {
      return null;
    }
    const rootId = text(record.rootId);
    return {
      action: recoveredBy ? 'recovered' : 'relinked',
      userId: recoveredBy ?? relinkedBy,
      rootId,
      rootKind: rootId ? (rootKindOf(rootId) ?? null) : null,
      rootLabel: text(record.rootLabel) ?? searchRoots.find(({ id }) => id === rootId)?.label ?? null,
      at: text(record.recoveredAt) ?? (finding.resolvedAt ? asDateTimeString(finding.resolvedAt) : null),
      previousPath: text(evidence.previousPath),
      sourcePath: text(evidence.candidatePath),
    };
  }

  /**
   * A finding's evidence as its reader may see it (FL-69). An administrator sees all of it. Anyone
   * else sees paths only inside the finding owner's own storage (or external library): a copy taken
   * from a recovery location or another account's folder is described, and who recovered it from
   * which operator location is left out.
   */
  private findingEvidenceFor(evidence: unknown, ownerRoots: string[] | null, auth: AuthDto) {
    const source = { ...((evidence ?? {}) as Record<string, unknown>) };
    if (auth.user.isAdmin) {
      return source;
    }
    delete source.provenance;
    for (const key of ['candidatePath', 'previousPath', 'retainedPath']) {
      const value = source[key];
      if (typeof value === 'string' && ownerRoots && !this.isPathWithinRoots(value, ownerRoots)) {
        delete source[key];
      }
    }
    return source;
  }

  private isPathWithinRoots(candidatePath: string, roots: string[]) {
    return roots.some((root) => {
      const relative = path.relative(root, candidatePath);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
  }
}
