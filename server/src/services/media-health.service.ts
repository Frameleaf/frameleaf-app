import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { constants } from 'node:fs';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
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
  MediaHealthRootResponse,
  MediaHealthRootsResponseDto,
  MediaHealthRunResponseDto,
  MediaHealthScanResponseDto,
  MediaHealthSummaryQueryDto,
  MediaHealthSummaryResponseDto,
  NEEDS_ATTENTION_MEDIA_HEALTH_STATUSES,
} from 'src/dtos/media-health.dto.js';
import {
  AssetVisibility,
  ChecksumAlgorithm,
  DatabaseLock,
  ImmichWorker,
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
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaHealthAsset,
  MediaHealthCandidate,
  MediaHealthFinding,
  MediaHealthRepository,
  MediaHealthRun,
} from 'src/repositories/media-health.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { BulkMediaHealthEntry, BulkOperationItem, bulkErrorMessage } from 'src/utils/bulk-operation.js';
import { getConfig } from 'src/utils/config.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import {
  MediaHealthOperationSnapshot,
  MediaHealthRunState,
  mediaHealthActivityAction,
  mediaHealthOperationLabel,
  parseMediaHealthSnapshot,
} from 'src/utils/media-health-operation.js';
import {
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

const MEDIA_HEALTH_PAGE_SIZE = 100;
const MANAGED_LOOKUP_MAX_ENTRIES = 10_000;
const MANAGED_LOOKUP_MAX_BYTES = 10 * 1024 ** 3;
/**
 * Library Care's own folder for published recovery copies (FL-69). Hidden, so the untracked-file
 * crawler never adopts a copy that is not committed yet.
 */
const RECOVERY_FOLDER = '.library-care';
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

type CandidateValidation = {
  status: MediaHealthStatus;
  score: number | null;
  evidence: Record<string, unknown>;
  resolution: Record<string, unknown>;
};

type ManagedSearchProgress = NonNullable<JobOf<JobName.MediaHealthLocateMissing>['managedSearch']>;

/** One step of a search for originals (FL-69): what it covered, and where to carry on from. */
export type MediaHealthLocateStep = {
  checkedAssets: number;
  foundAssets: number;
  continuation?: ManagedSearchProgress;
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
    private forkSchemaRepository: ForkSchemaRepository,
    private jobRepository: JobRepository,
    private libraryRepository: LibraryRepository,
    private mediaHealthRepository: MediaHealthRepository,
    _mediaRepository: MediaRepository,
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
        forkSchemaRepo: this.forkSchemaRepository,
      },
      { withCache },
    );
    return config.libraryCare;
  }

  /**
   * "Schedule incremental health scans" (Library care → Media health & integrity). One server holds
   * the schedule, as the integrity checks do; each tick starts every account's durable scan.
   */
  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({ newConfig: { libraryCare } }: ArgOf<'ConfigInit'>) {
    this.scheduleLock = await this.databaseRepository.tryLock(DatabaseLock.LibraryCareSchedule);
    if (!this.scheduleLock) {
      return;
    }
    this.cronRepository.create({
      name: LIBRARY_CARE_HEALTH_SCAN_CRON,
      expression: libraryCare.healthScanCronExpression,
      onTick: () => handlePromiseError(this.startScheduledScans(), this.logger),
      start: libraryCare.healthScan,
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
      start: libraryCare.healthScan,
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
        if (snapshot.mode !== 'scan') {
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

  async startMissingScan(auth: AuthDto): Promise<MediaHealthScanResponseDto> {
    const { missingRunId, operationId } = await this.startDurableScan(auth);
    return { runId: missingRunId, operationId };
  }

  async startCorruptScan(auth: AuthDto): Promise<MediaHealthScanResponseDto> {
    const { corruptRunId, operationId } = await this.startDurableScan(auth);
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
  async locateMissing(auth: AuthDto, dto: MediaHealthLocateDto): Promise<MediaHealthScanResponseDto> {
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
      const result = await this.validateAssetIntegrity(asset);

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
      return this.publishAndCommit(auth, finding, asset, candidate, MediaHealthCategory.Missing);
    }

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
      provenance: { relinkedBy: auth.user.id, rootId: this.candidateRootId(candidate) },
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
    if (asset.isExternal) {
      return unverified(id, 'External originals are relinked within their own library');
    }

    const candidates = await this.mediaHealthRepository.getCandidatesByHealthIds([finding.id]);
    const candidate = candidates.find(({ id: candidateId }) => candidateId === entry.candidateId);
    if (!candidate || candidate.status !== MediaHealthStatus.Found) {
      return changed(id, 'The reviewed copy is no longer a verified match');
    }
    return this.publishAndCommit(auth, finding, asset, candidate, MediaHealthCategory.Corrupt);
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
   */
  private async publishAndCommit(
    auth: AuthDto,
    finding: MediaHealthFinding,
    asset: MediaHealthAsset,
    candidate: MediaHealthCandidate,
    category: MediaHealthCategory,
  ): Promise<BulkOperationItem> {
    const id = asset.id;
    const roots = await this.searchRoots();
    const root = rootForPath(roots, candidate.candidatePath);
    if (!root || root.kind === 'library' || (root.kind === 'recovery' && !auth.user.isAdmin)) {
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
    const destination = path.join(
      path.dirname(StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, asset.id)),
      RECOVERY_FOLDER,
      name,
    );
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
        recoveredBy: auth.user.id,
        rootId: root.id,
        rootKind: root.kind,
        rootLabel: root.label,
        recoveredAt: new Date().toISOString(),
      },
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
      await this.retainDamagedOriginal(finding.id);
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
   */
  private async retainDamagedOriginal(findingId: string): Promise<void> {
    const [finding] = await this.mediaHealthRepository.getByIds([findingId]);
    const evidence = (finding?.evidence ?? {}) as Record<string, unknown>;
    const retained = typeof evidence.retainedPath === 'string' ? evidence.retainedPath : undefined;
    if (!finding || !retained || retained.split(path.sep).includes(RECOVERY_FOLDER)) {
      return;
    }

    if (await this.mediaHealthRepository.isOriginalPathInUse(retained)) {
      return;
    }

    // Next to the recovered copy, which already lives in the Library Care folder.
    const recovered = path.dirname(finding.originalPath);
    const folder = path.basename(recovered) === RECOVERY_FOLDER ? recovered : path.join(recovered, RECOVERY_FOLDER);
    const extension = path.extname(retained).toLowerCase();
    const suffix = /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : '';
    const destination = path.join(folder, `${finding.assetId}-${finding.id}.damaged${suffix}`);
    try {
      await retainFile(retained, destination);
    } catch (error) {
      // Still recorded on the finding, and still not overwritten or lost: only its place is unchanged.
      this.logger.warn(`Could not move retained damaged file ${retained}: ${getErrorMessage(error)}`);
      return;
    }
    await this.mediaHealthRepository.setRetainedPath(finding.id, destination);
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
  private startDurableScan(auth: AuthDto): Promise<DurableScan> {
    return this.mediaHealthRepository.withLibraryCareLock(auth.user.id, () => this.admitDurableScan(auth.user.id));
  }

  private async admitDurableScan(
    ownerId: string,
    options: { changedSince?: string; scheduled?: boolean } = {},
  ): Promise<DurableScan> {
    const active = await this.activeJob(ownerId);
    if (active) {
      const snapshot = parseMediaHealthSnapshot(active.snapshot);
      if (snapshot.mode === 'scan') {
        return { missingRunId: snapshot.missingRunId, corruptRunId: snapshot.corruptRunId, operationId: active.id };
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
    };
    try {
      const operation = await this.createHealthOperation(ownerId, snapshot, null);
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

  private createHealthOperation(ownerId: string, snapshot: MediaHealthOperationSnapshot, total: number | null) {
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
      result: null,
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
    let run = job.runId;
    if (!run) {
      const created = await this.mediaHealthRepository.createRun(MediaHealthCategory.Missing, job.userId);
      run = created.id;
    }
    try {
      const { checkedAssets, foundAssets, continuation } = await this.locateFindings({
        runId: run,
        findingIds: job.ids ?? [],
        ownerId: job.userId,
        rootIds: null,
        managedSearch: job.managedSearch,
      });

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
      if (continuation) {
        await this.jobRepository.queue({
          name: JobName.MediaHealthLocateMissing,
          data: { ...job, runId: run, managedSearch: continuation },
        });
      }
      return JobStatus.Success;
    } catch (error) {
      await this.mediaHealthRepository.finishRun(run, { status: 'failed', error: getErrorMessage(error) });
      throw error;
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
    runId: string;
    findingIds: string[];
    ownerId?: string;
    rootIds: string[] | null;
    managedSearch?: ManagedSearchProgress;
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
    const managedPaths = searchManaged ? (roots.find(({ id }) => id === MANAGED_ROOT_ID)?.paths ?? []) : [];
    // FL-69: recovery locations an administrator chose are walked after library storage. Read only.
    const startRoots = [...managedPaths, ...recoveryPaths];
    const { candidates: managedCandidates, continuation } =
      startRoots.length > 0 || input.managedSearch
        ? await this.locateManagedCandidates(managedAssets, input.managedSearch, startRoots)
        : { candidates: new Map<string, CandidateValidation[]>(), continuation: undefined };
    const truncated = !!continuation;
    let checkedAssets = 0;
    let foundAssets = 0;

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

      const found = asset.isExternal
        ? (externalCandidates.get(asset.id) ?? [])
        : (managedCandidates.get(asset.id) ?? []);
      const candidates = await Promise.all(
        found.map((candidate) => this.describeCandidate(candidate, asset, roots, truncated)),
      );
      if (candidates.some(({ status }) => status === MediaHealthStatus.Found)) {
        foundAssets++;
      }

      await this.mediaHealthRepository.replaceCandidates(
        finding.id,
        candidates.map((candidate) => ({
          healthId: finding.id,
          candidatePath: candidate.evidence.path as string,
          status: candidate.status,
          visualMatchScore: candidate.score,
          evidence: candidate.evidence,
          resolution: candidate.resolution,
          checkedAt: new Date(),
        })),
      );

      const validCandidates = candidates.filter(({ status }) => status === MediaHealthStatus.Found);
      // A new candidate list has new ids: a choice made from the old list no longer applies.
      const { chosenCandidateId: _stale, ...resolution } = (finding.resolution ?? {}) as Record<string, unknown>;
      const evidence = {
        ...(finding.evidence as Record<string, unknown>),
        candidateCount: candidates.length,
        validatedCandidateCount: validCandidates.length,
        searchTruncated: !asset.isExternal && truncated,
        ...(input.rootIds && { searchedRootIds: input.rootIds }),
      };

      if (isDamaged) {
        // The damage itself is unchanged: keep its status and the time it was confirmed, which is
        // what the trash gate measures recency by.
        await this.mediaHealthRepository.upsertFinding({
          ...finding,
          expectedUpdateId: asset.updateId,
          evidence,
          resolution,
        });
        continue;
      }

      const findingStatus =
        validCandidates.length > 0
          ? MediaHealthStatus.Found
          : candidates.length > 0
            ? MediaHealthStatus.Candidate
            : MediaHealthStatus.Missing;

      await this.mediaHealthRepository.upsertFinding({
        runId: input.runId,
        assetId: asset.id,
        expectedUpdateId: asset.updateId,
        category: MediaHealthCategory.Missing,
        status: findingStatus,
        severity:
          findingStatus === MediaHealthStatus.Missing ? MediaHealthSeverity.Critical : MediaHealthSeverity.Warning,
        originalPath: asset.originalPath,
        originalFileName: asset.originalFileName,
        evidence,
        resolution: {
          ...resolution,
          autoRelinkable: validCandidates.length === 1,
        },
        checkedAt: new Date(),
      });
    }

    return { checkedAssets, foundAssets, continuation };
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
    let checkedAssets = 0;
    let foundAssets = 0;
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
        checkedAssets++;
        const result = await this.validateAssetIntegrity(asset);
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

      await this.mediaHealthRepository.finishRun(run, {
        status: 'completed',
        totalAssets: checkedAssets,
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

    try {
      const { checksumScan } = await this.careSettings();
      for await (const asset of this.mediaHealthRepository.streamAssets({
        assetIds: job.assetIds,
        ownerId: job.userId,
      })) {
        checkedAssets++;
        const found = await this.scanAsset(asset, missingRunId, corruptRunId, { checksumScan });
        if (found === 'missing') {
          missingFoundAssets++;
        } else if (found === 'corrupt') {
          corruptFoundAssets++;
        }
      }

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
            checkedAssets,
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
  ): Promise<'missing' | 'corrupt' | 'healthy'> {
    const sourceExists = await this.storageRepository.checkFileExists(asset.originalPath, constants.R_OK);
    if (!sourceExists) {
      await this.mediaHealthRepository.upsertFinding({
        runId: missingRunId,
        assetId: asset.id,
        expectedUpdateId: asset.updateId,
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Missing,
        severity: MediaHealthSeverity.Critical,
        originalPath: asset.originalPath,
        originalFileName: asset.originalFileName,
        evidence: { reason: 'source_file_missing_or_unreadable' },
        resolution: { autoRelinkable: !!asset.isExternal && !!asset.libraryId },
        checkedAt: new Date(),
      });
      return 'missing';
    }

    if (!corruptRunId) {
      await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);
      return 'healthy';
    }
    // "Verify original checksums" off: the scan still reads and decodes every original, but no longer
    // proves it is the recorded file. Repairs and the trash always verify, whatever this says.
    const result = await this.validateReadableAssetIntegrity(asset, { verifyChecksum: checksumScan });
    if (!result) {
      await this.mediaHealthRepository.markResolvedForAssets(
        [MediaHealthCategory.Missing, MediaHealthCategory.Corrupt],
        [asset],
      );
      return 'healthy';
    }
    if (result.status === MediaHealthStatus.Missing) {
      await this.mediaHealthRepository.upsertFinding({
        runId: missingRunId,
        assetId: asset.id,
        expectedUpdateId: asset.updateId,
        category: MediaHealthCategory.Missing,
        status: MediaHealthStatus.Missing,
        severity: MediaHealthSeverity.Critical,
        originalPath: asset.originalPath,
        originalFileName: asset.originalFileName,
        evidence: result.evidence,
        resolution: result.resolution,
        checkedAt: new Date(),
      });
      return 'missing';
    }
    await this.mediaHealthRepository.markResolvedForAssets([MediaHealthCategory.Missing], [asset]);

    await this.mediaHealthRepository.upsertFinding({
      runId: corruptRunId,
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
    return 'corrupt';
  }

  private async validateAssetIntegrity(asset: MediaHealthAsset): Promise<CandidateValidation | null> {
    return this.validateReadableAssetIntegrity(asset);
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

        let digests: Awaited<ReturnType<CryptoRepository['hashFileDigests']>>;
        try {
          digests = await this.cryptoRepository.hashFileDigests(candidatePath);
        } catch (error) {
          this.logger.warn(`Skipping unreadable recovered file ${candidatePath}: ${getErrorMessage(error)}`);
          continue;
        }
        const checksumAssets = await this.assetRepository.getByChecksums(userId, [digests.sha1, digests.sha256]);
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

        let stat: Awaited<ReturnType<StorageRepository['stat']>>;
        try {
          stat = await this.storageRepository.stat(candidatePath);
        } catch (error) {
          this.logger.warn(`Skipping missing recovered file ${candidatePath}: ${getErrorMessage(error)}`);
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
            fileCreatedAt: stat.mtime,
            fileModifiedAt: stat.mtime,
            localDateTime: stat.mtime,
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

  private async validateReadableAssetIntegrity(
    asset: MediaHealthAsset,
    { verifyChecksum = true }: { verifyChecksum?: boolean } = {},
  ): Promise<CandidateValidation | null> {
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
    return {
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
    };
  }

  /**
   * FL-69: an original whose own checksum is a path checksum (an external library's) records nothing
   * a copy could be proven against. While it is present and reads back intact, keep the digests of the
   * bytes just read, so a search can find it by content once it has moved. Each healthy read replaces
   * the last, so a file edited in place is never matched against copies of its earlier bytes.
   */
  private async recordContentDigests(
    asset: MediaHealthAsset,
    digests: { sha1?: Buffer; sha256?: Buffer; sizeInBytes?: number },
  ): Promise<void> {
    if (expectedDigest(asset) || !digests.sha1 || !digests.sha256 || digests.sizeInBytes === undefined) {
      return;
    }
    try {
      await this.forkSchemaRepository.recordAssetChecksums({
        assetId: asset.id,
        sha1: digests.sha1,
        sha256: digests.sha256,
        sizeInBytes: digests.sizeInBytes,
        path: asset.originalPath,
        source: 'external-scan',
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

  private async queueRelinkJobs(assetId: string): Promise<void> {
    await this.jobRepository.queueAll([
      { name: JobName.SidecarCheck, data: { id: assetId, source: 'upload' } },
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
