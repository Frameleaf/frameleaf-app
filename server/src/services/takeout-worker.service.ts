import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { UpdateAssetDto } from 'src/dtos/asset.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetVisibility, ImmichWorker, MediaOperationKind, MediaOperationStatus, StorageFolder } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationRepository,
  type MediaOperationWriteState,
} from 'src/repositories/media-operation.repository.js';
import {
  StagedDigest,
  TAKEOUT_SIDECAR_MAX_BYTES,
  TAKEOUT_STAGING_RESERVE_BYTES,
  TakeoutStagingError,
  TakeoutStagingRepository,
} from 'src/repositories/takeout-staging.repository.js';
import {
  TakeoutFile,
  TakeoutImport,
  TakeoutItem,
  TakeoutRepository,
  TakeoutSource,
} from 'src/repositories/takeout.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { LivePhotoService } from 'src/services/live-photo.service.js';
import { MEDIA_OPERATION_AUTO_RETRY_DELAY_MS, mediaOperationProgress } from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { TakeoutZipError } from 'src/utils/takeout-zip.js';
import {
  TakeoutAction,
  TakeoutAssetPatch,
  TakeoutEntryRejected,
  TakeoutOptions,
  TakeoutPhase,
  createTakeoutSidecarIndex,
  isTakeoutAlbumSelected,
  parseTakeoutOptions,
  parseTakeoutSidecar,
  takeoutCreatedPatch,
  takeoutEntryPath,
  takeoutLivePhotoKey,
  takeoutMatchedPatch,
  takeoutScannedItem,
  takeoutStableId,
} from 'src/utils/takeout.js';

/** How often the worker looks for queued import jobs. */
export const TAKEOUT_TICK_MS = 5000;
/** The claim lease. Extended by every progress write and by a heartbeat while a large file copies. */
export const TAKEOUT_LEASE_MS = 2 * 60_000;
export const TAKEOUT_HEARTBEAT_MS = 30_000;
/** Progress is written at least this often, and at every step boundary. */
export const TAKEOUT_PROGRESS_INTERVAL_MS = 2000;
/** Items read per query while importing. */
export const TAKEOUT_BATCH = 50;
/** A folder with more photo × video combinations under one name than this is not offered as Live Photos. */
const MAX_PAIR_COMBINATIONS = 100;
/** The owner is re-read this often while importing, so a changed quota applies to what follows. */
const AUTH_REFRESH_ITEMS = 200;

/** A job-level failure with a stable code; the job stops and its automatic retry resumes it. */
class TakeoutJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** One item cannot be imported; it is reported and the run carries on. */
class TakeoutItemError extends Error {}

/** The run must stop here: the claim was lost, or the owner paused or cancelled. Already settled. */
class TakeoutStop extends Error {}

/**
 * The owner asked to pause or cancel while the run was inside a long step (copying a large file),
 * noticed by the heartbeat. The step is abandoned — its partial copy is removed — and the request is
 * settled as it would be at a progress write.
 */
class TakeoutInterrupt extends Error {
  constructor(readonly request: 'pause' | 'cancel') {
    super(`The owner asked to ${request}`);
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);

type ImportResult = { itemRetryUsed?: boolean };

/** What one claimed run carries. */
type TakeoutRun = {
  operation: MediaOperation;
  claimToken: string;
  row: TakeoutImport;
  action: TakeoutAction;
  auth: AuthDto;
  controller: AbortController;
  processed: number;
  total: number | null;
  lastWrite: number;
  result: ImportResult;
  albums: Map<string, string>;
};

const isFile = (name: string) => {
  if (name.toLowerCase().endsWith('.json')) {
    return 'sidecar' as const;
  }
  if (!mimeTypes.isAsset(name)) {
    return;
  }
  return mimeTypes.isVideo(name) ? ('video' as const) : ('image' as const);
};

/**
 * The worker behind Google Photos imports (FL-65, `IMP-001`).
 *
 * An import step is a `media_operation` row of kind `takeout_import` whose snapshot names the
 * import and the action. This service claims those rows on the microservices worker and carries
 * the step out, writing progress back to the row as it goes, so Activity and the notifications panel
 * show it with a total that grows while a scan discovers what the archives hold.
 *
 * What makes it safe to stop anywhere and run again:
 *
 * - **Scan.** Each archive entry becomes a `takeout_file` row whose id is derived from the source
 *   and the entry name, written only after the staged copy is complete and verified; an entry that
 *   already has its row is skipped. A source is marked scanned when every entry is recorded. A
 *   second scan never overwrites a decision the owner made: it only updates an item still waiting
 *   without a chosen sidecar, when an archive added since brought it more candidates.
 * - **Import.** An item is only ever picked up while it is `ready` or `importing`. Before an asset is
 *   uploaded the item records that this run is creating it; an interrupted upload is found again by
 *   its checksum and finished as the import's own creation. Assets are never duplicated: the library
 *   refuses a second asset with the same checksum and the import reuses the one it finds. Metadata,
 *   the lock, album membership and Live Photo links are all safe to apply twice.
 * - **Locked.** An item from Google's Locked Folder is created locked in the same transaction as the
 *   asset (a lock record, never `visibility = locked`); a matched photo is locked before anything else
 *   is written to it. The worker acts for the owner as a system actor, so it reaches Locked media
 *   without a PIN-unlocked session (owner decision, September 22, 2026).
 * - **Originals.** Files are copied into the library and verified against the digest the scan
 *   recorded; nothing Google exported is modified, and nothing in the library is overwritten.
 *   Matched photos only gain metadata they are missing, and only when the owner asked.
 * - **Retry once.** A job that fails is retried once by `MediaOperationRepository.fail`; items that
 *   failed inside a finished pass get one more attempt, after a pause, before they are reported.
 * - **Pause and cancel** are honoured at every progress write; the work done so far stays done.
 */
@Injectable()
export class TakeoutWorkerService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private running?: AbortController;
  private stopping = false;
  private readonly workerId = `takeout-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private repository: TakeoutRepository,
    private staging: TakeoutStagingRepository,
    private users: UserRepository,
    private assetMedia: AssetMediaService,
    private assets: AssetService,
    private albums: AlbumService,
    private livePhoto: LivePhotoService,
    private config: ConfigRepository,
  ) {
    this.logger.setContext(TakeoutWorkerService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), TAKEOUT_TICK_MS);
    this.tick();
  }

  /** Stop taking work and hand the job in hand back to the queue at the point it reached. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    this.running?.abort(new Error('The server is restarting'));
    await this.active;
  }

  /** Never overlaps itself: a tick that finds work in hand does nothing. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Google Photos import worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain(): Promise<void> {
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: [MediaOperationKind.TakeoutImport],
        workerId: this.workerId,
        leaseMs: TAKEOUT_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.run(claim.operation, claim.claimToken);
    }
  }

  /** Carry out one claimed step, from wherever the import's rows say it has got to. */
  async run(operation: MediaOperation, claimToken: string): Promise<void> {
    const { id } = operation;
    const snapshot = (operation.snapshot ?? {}) as Record<string, unknown>;
    const importId = typeof snapshot.importId === 'string' ? snapshot.importId : undefined;
    const action = snapshot.action === 'scan' || snapshot.action === 'import' ? snapshot.action : undefined;
    if (!importId || !action) {
      await this.operations.fail(id, claimToken, {
        error: 'This job does not name an import step',
        errorCode: 'takeout_snapshot_invalid',
      });
      return;
    }

    const row = await this.repository.getById(importId);
    if (!row || row.ownerId !== operation.ownerId) {
      await this.operations.fail(id, claimToken, { error: 'This import was deleted', errorCode: 'takeout_missing' });
      return;
    }

    if (!(await this.repository.claimRun(importId, id))) {
      await this.operations.fail(id, claimToken, {
        error: 'Another job is already working on this import',
        errorCode: 'takeout_busy',
      });
      return;
    }

    // Read again now that the import is held: the claim waited for any change in progress, so this
    // is the phase that change committed.
    const current = await this.repository.getById(importId);
    if (!current) {
      await this.operations.fail(id, claimToken, { error: 'This import was deleted', errorCode: 'takeout_missing' });
      return;
    }

    const phase: TakeoutPhase = action === 'scan' ? 'scanning' : 'importing';
    if (current.phase !== phase) {
      // The step finished before this job was last stopped: its phase already moved on.
      await this.finish(id, claimToken);
      return;
    }

    const auth = await this.authFor(operation.ownerId);
    if (!auth) {
      await this.operations.fail(id, claimToken, {
        error: 'The account that started this import no longer exists',
        errorCode: 'takeout_owner_unavailable',
      });
      return;
    }

    const controller = new AbortController();
    this.running = controller;
    const run: TakeoutRun = {
      operation,
      claimToken,
      row: current,
      action,
      auth,
      controller,
      processed: 0,
      total: null,
      lastWrite: 0,
      result: (operation.result ?? {}) as ImportResult,
      albums: new Map(),
    };

    // Keeps the lease while a long step runs, and notices a pause or cancel asked for meanwhile.
    const heartbeat = setInterval(() => {
      void this.pulse(run).catch(() => {});
    }, TAKEOUT_HEARTBEAT_MS);

    try {
      const started = await this.operations.reportProgress(id, claimToken, {
        status: MediaOperationStatus.Rendering,
        processedUnits: 0,
        totalUnits: null,
        progress: 0,
      });
      if (!started) {
        await this.operations.acknowledgeCancel(id, claimToken, { released: false });
        return;
      }

      await (action === 'scan' ? this.scan(run) : this.importItems(run));
    } catch (error) {
      if (error instanceof TakeoutStop) {
        return;
      }
      const reason: unknown = controller.signal.reason;
      if (controller.signal.aborted && reason instanceof TakeoutInterrupt) {
        await this.settleInterrupt(run, reason);
        return;
      }
      if (this.stopping && controller.signal.aborted) {
        // Shutting down: hand the job back where it got to; the next worker resumes it.
        await this.operations.requeue(id, claimToken, { delayMs: 0, returnAttempt: true });
        return;
      }
      if (controller.signal.aborted && controller.signal.reason instanceof TakeoutStop) {
        return;
      }
      const code = error instanceof TakeoutJobError ? error.code : 'takeout_failed';
      this.logger.error(`Google Photos import ${importId} (${action}) failed: ${errorMessage(error)}`);
      await this.operations.fail(id, claimToken, { error: errorMessage(error), errorCode: code });
    } finally {
      clearInterval(heartbeat);
      if (this.running === controller) {
        this.running = undefined;
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scan                                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Stage every source, then match sidecars to media folder by folder. The total starts at the
   * files already staged and grows as each archive's directory is read and as folders are matched.
   */
  private async scan(run: TakeoutRun): Promise<void> {
    const { row } = run;
    const directory = await this.staging.prepare(row.ownerId, row.id);
    const sources = await this.repository.sources(row.id);
    const counts = await this.repository.counts(row.id);
    run.processed = counts.files;
    run.total = counts.files;
    await this.checkpoint(run, true);

    for (const source of sources) {
      if (source.scanned) {
        continue;
      }
      const rejected = await (source.kind === 'zip'
        ? this.scanArchive(run, source, directory)
        : this.scanDirectory(run, source, directory));
      await this.repository.markSourceScanned(source.id, rejected);
      if (source.kind === 'zip') {
        // Every entry is staged; the archive itself is no longer needed.
        await this.staging.remove(source.path);
      }
      await this.checkpoint(run, true);
    }

    const folders = await this.repository.folders(row.id);
    run.total = (run.total ?? 0) + folders.length;
    await this.checkpoint(run, true);
    for (const folder of folders) {
      await this.matchFolder(row.id, folder);
      run.processed++;
      await this.checkpoint(run);
    }

    // The sidecars' metadata now lives on the items; the staged JSON is not needed again.
    for (const sidecar of await this.repository.stagedSidecarPaths(row.id)) {
      await this.staging.remove(sidecar);
    }

    await this.checkpoint(run, true);
    await this.repository.advancePhase(row.id, 'scanning', 'review');
    await this.finish(run.operation.id, run.claimToken);
    this.logger.log(`Google Photos import ${row.id}: scan finished`);
  }

  private async scanArchive(run: TakeoutRun, source: TakeoutSource, directory: string): Promise<number> {
    const archive = await this.staging.openArchive(source.path).catch((error) => {
      throw new TakeoutJobError(
        'takeout_archive_missing',
        `${source.name} could not be opened: ${errorMessage(error)}`,
      );
    });
    try {
      const entries = await this.staging.readArchiveDirectory(archive.source).catch((error) => {
        throw error instanceof TakeoutZipError
          ? new TakeoutJobError('takeout_archive_invalid', `${source.name}: ${error.message}`)
          : error;
      });
      run.total = (run.total ?? 0) + entries.length;
      await this.checkpoint(run, true);

      let rejected = 0;
      for (const entry of entries) {
        this.throwIfStopped(run);
        const outcome = await this.stageEntry(run, source, directory, {
          entryName: entry.name,
          size: entry.uncompressedSize,
          modifiedAt: entry.modifiedAt,
          refused: !!entry.refused,
          stage: (destination) =>
            this.staging.stageArchiveEntry(source.path, archive.source, entry, destination, run.controller.signal),
        });
        if (outcome === 'rejected') {
          rejected++;
        }
        run.processed++;
        await this.checkpoint(run);
      }
      return rejected;
    } finally {
      await archive.close();
    }
  }

  private async scanDirectory(run: TakeoutRun, source: TakeoutSource, directory: string): Promise<number> {
    // The operator may have narrowed the permitted locations since the folder was chosen.
    const roots = this.config.getEnv().storage.importRoots;
    if (!(await this.staging.isInsideRoots(source.path, roots))) {
      throw new TakeoutJobError(
        'takeout_folder_not_permitted',
        'This server folder is no longer inside a permitted import location',
      );
    }
    let rejected = 0;
    for await (const file of this.staging.walk(source.path, run.controller.signal)) {
      this.throwIfStopped(run);
      run.total = (run.total ?? 0) + 1;
      const outcome = await this.stageEntry(run, source, directory, {
        entryName: file.entryName,
        size: file.size,
        modifiedAt: file.modifiedAt,
        refused: file.link,
        stage: (destination) => this.staging.stageFile(source.path, file, destination, run.controller.signal),
      });
      if (outcome === 'rejected') {
        rejected++;
      }
      run.processed++;
      await this.checkpoint(run);
    }
    return rejected;
  }

  /**
   * Stage one entry if it is a Google Photos photo, video or sidecar that has not been staged yet.
   * Entries outside Google Photos are ignored; unsafe names, links, encryption and damaged data are
   * counted as rejected and never staged.
   */
  private async stageEntry(
    run: TakeoutRun,
    source: TakeoutSource,
    directory: string,
    entry: {
      entryName: string;
      size: number;
      modifiedAt: Date;
      refused: boolean;
      stage: (destination: string) => Promise<StagedDigest>;
    },
  ): Promise<'staged' | 'ignored' | 'rejected'> {
    let boundary;
    try {
      boundary = takeoutEntryPath(entry.entryName);
    } catch (error) {
      if (error instanceof TakeoutEntryRejected) {
        return 'rejected';
      }
      throw error;
    }
    if (!boundary) {
      return 'ignored';
    }
    const kind = isFile(boundary.name);
    if (!kind || (kind === 'sidecar' && entry.size > TAKEOUT_SIDECAR_MAX_BYTES)) {
      return 'ignored';
    }
    if (entry.refused) {
      return 'rejected';
    }

    const id = takeoutStableId(`${source.id}:${entry.entryName}`);
    if (await this.repository.hasFile(id)) {
      return 'staged';
    }
    // Staging is bounded by the staging volume, not the account's quota: much of an export can be
    // photos the library already has, and each new asset is checked against the quota when it is
    // created.
    if ((await this.staging.freeBytes(directory)) < entry.size + TAKEOUT_STAGING_RESERVE_BYTES) {
      throw new TakeoutJobError(
        'takeout_no_space',
        'The server ran out of space for staging this import. Free some space, then retry.',
      );
    }

    const destination = path.join(directory, id);
    let digest: StagedDigest;
    try {
      digest = await entry.stage(destination);
    } catch (error) {
      if (error instanceof TakeoutStagingError) {
        this.logger.warn(`Google Photos import ${run.row.id}: refused ${boundary.relativePath}: ${error.message}`);
        return 'rejected';
      }
      throw error;
    }

    const metadata =
      kind === 'sidecar' ? (parseTakeoutSidecar(await this.staging.readSidecar(destination)) ?? null) : null;
    await this.repository.recordFile({
      id,
      importId: run.row.id,
      sourceId: source.id,
      entryName: entry.entryName,
      relativePath: boundary.relativePath,
      folder: boundary.folder,
      name: boundary.name,
      kind,
      path: destination,
      size: digest.size,
      checksum: digest.checksum,
      legacyChecksum: digest.legacyChecksum,
      modifiedAt: entry.modifiedAt,
      metadata,
    });
    return 'staged';
  }

  /**
   * Match one folder's media to its sidecars and record the items and Live Photo candidates. Split
   * archives are handled here: a folder's files are read together whichever archive they came from.
   */
  private async matchFolder(importId: string, folder: string): Promise<void> {
    const files = await this.repository.folderFiles(importId, folder);
    const sidecars = files.filter(
      (file): file is TakeoutFile & { metadata: NonNullable<TakeoutFile['metadata']> } =>
        file.kind === 'sidecar' && file.metadata !== null,
    );
    const invalid = new Set(files.filter((file) => file.kind === 'sidecar' && !file.metadata).map((file) => file.name));
    const byId = new Map(sidecars.map((file) => [file.id, file]));
    const match = createTakeoutSidecarIndex(sidecars.map(({ id, name, metadata }) => ({ id, name, metadata })));

    const photos = new Map<string, TakeoutFile[]>();
    const videos = new Map<string, TakeoutFile[]>();
    for (const file of files) {
      if (file.kind === 'sidecar') {
        continue;
      }
      const candidates = match(file.name).map((sidecar) => ({
        id: sidecar.id,
        path: byId.get(sidecar.id)!.relativePath,
        metadata: sidecar.metadata,
      }));
      const invalidSidecar = [...invalid].some((name) => name.toLowerCase().startsWith(file.name.toLowerCase() + '.'));
      const scanned = takeoutScannedItem({ name: file.name, folder, candidates, invalidSidecar });
      await this.repository.recordItem({
        id: file.id,
        importId,
        ...scanned,
        candidates,
        albums: folder ? [folder] : [],
      });

      const index = file.kind === 'image' ? photos : videos;
      const key = takeoutLivePhotoKey(file.name);
      index.set(key, [...(index.get(key) ?? []), file]);
    }

    for (const [key, stills] of photos) {
      const clips = videos.get(key) ?? [];
      if (clips.length === 0 || stills.length * clips.length > MAX_PAIR_COMBINATIONS) {
        continue;
      }
      for (const still of stills) {
        for (const clip of clips) {
          await this.repository.recordPair(importId, still.id, clip.id);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Import                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Import every item still to do, link the approved Live Photos, then give what failed its one
   * automatic retry before the step is reported finished.
   */
  private async importItems(run: TakeoutRun): Promise<void> {
    const { row } = run;
    const options = parseTakeoutOptions(row.options);
    run.total = (await this.repository.countPending(row.id)) + (await this.repository.countApprovedPairs(row.id));
    await this.checkpoint(run, true);

    const seen = new Set<string>();
    let sinceRefresh = 0;
    while (true) {
      this.throwIfStopped(run);
      const items = await this.repository.pendingItems(row.id, TAKEOUT_BATCH);
      if (items.length === 0) {
        break;
      }
      for (const item of items) {
        this.throwIfStopped(run);
        if (seen.has(item.id)) {
          // Never loop on an item that did not settle.
          await this.repository.itemDone(item.id, 'failed', 'The item could not be finished');
          continue;
        }
        seen.add(item.id);
        try {
          await this.importItem(run, item, options);
        } catch (error) {
          if (error instanceof TakeoutStop || run.controller.signal.aborted) {
            throw error;
          }
          if (!(error instanceof TakeoutItemError)) {
            this.logger.warn(`Google Photos import ${row.id}: ${item.relativePath} failed: ${errorMessage(error)}`);
          }
          await this.repository.itemDone(item.id, 'failed', errorMessage(error));
        }
        run.processed++;
        await this.checkpoint(run);
        if (++sinceRefresh >= AUTH_REFRESH_ITEMS) {
          sinceRefresh = 0;
          const refreshed = await this.authFor(row.ownerId);
          if (!refreshed) {
            throw new TakeoutJobError(
              'takeout_owner_unavailable',
              'The account that started this import no longer exists',
            );
          }
          run.auth = refreshed;
        }
      }
    }

    while (true) {
      this.throwIfStopped(run);
      const pairs = await this.repository.approvedPairs(row.id, TAKEOUT_BATCH);
      if (pairs.length === 0) {
        break;
      }
      for (const pair of pairs) {
        this.throwIfStopped(run);
        await this.repository.pairDone(pair.photoItemId, pair.videoItemId, await this.linkPair(run, pair));
        run.processed++;
        await this.checkpoint(run);
      }
    }

    // Every item that failed gets one more attempt, after a pause, before it is reported (owner
    // decision, September 22, 2026). The job goes back to the queue and the retry runs from the rows.
    if (!run.result.itemRetryUsed) {
      const retried = (await this.repository.retryFailed(row.id)) + (await this.repository.retryFailedPairs(row.id));
      if (retried > 0) {
        run.result = { ...run.result, itemRetryUsed: true };
        await this.checkpoint(run, true);
        const requeued = await this.operations.requeue(run.operation.id, run.claimToken, {
          delayMs: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS,
          returnAttempt: true,
        });
        if (requeued) {
          this.logger.log(`Google Photos import ${row.id}: retrying ${retried} failed items once`);
          return;
        }
        await this.operations.acknowledgeCancel(run.operation.id, run.claimToken, { released: false });
        return;
      }
    }

    await this.checkpoint(run, true);
    await this.repository.advancePhase(row.id, 'importing', 'completed');
    await this.finish(run.operation.id, run.claimToken);
    this.logger.log(`Google Photos import ${row.id}: import finished`);
  }

  /** Bring one item into the library, or match it to the photo already there, then its metadata. */
  private async importItem(run: TakeoutRun, item: TakeoutItem, options: TakeoutOptions): Promise<void> {
    const { auth, row } = run;
    let assetId = item.assetId;
    let resultKind = item.resultKind;

    if (!assetId) {
      const found = await this.findExisting(auth, item);
      if (found?.isTrashed) {
        throw new TakeoutItemError('This photo is already in your library, in the trash. Restore it, then retry.');
      }
      if (found) {
        // A run of this import that stopped between the upload and recording it left the asset at the
        // path it chose; anything else with this checksum was already in the library.
        const existing = item.createPath ? await this.repository.getAssetState(found.assetId) : undefined;
        assetId = found.assetId;
        resultKind = existing && existing.originalPath === item.createPath ? 'created' : 'matched';
        if (resultKind === 'matched') {
          await this.removeAbandonedCopy(item);
        }
      } else {
        await this.removeAbandonedCopy(item);
        const created = await this.createAsset(run, item, options);
        assetId = created.id;
        resultKind = created.created ? 'created' : 'matched';
      }
      await this.repository.itemAsset(item.id, assetId, resultKind);
    }

    const asset = await this.repository.getAssetState(assetId);
    if (!asset || asset.ownerId !== row.ownerId) {
      throw new TakeoutItemError('The library item this matched is no longer available');
    }
    if (asset.deletedAt) {
      throw new TakeoutItemError('This photo is in your library’s trash. Restore it, then retry.');
    }

    // Locked first, so nothing written below is ever visible unlocked.
    if (item.locked) {
      await this.assets.lock(auth, { ids: [asset.id] });
    }

    // A photo that is Locked in the library, or goes into Locked from Google's Locked Folder, is not
    // changed further and joins no album: Google keeps Locked Folder photos out of albums, and an
    // album shared with others must never gain one.
    const skipAlbums = item.locked || asset.locked;
    const patch: TakeoutAssetPatch =
      resultKind === 'created'
        ? takeoutCreatedPatch(item.metadata, options)
        : asset.locked
          ? {}
          : takeoutMatchedPatch(
              item.metadata,
              {
                description: asset.description,
                latitude: asset.latitude,
                longitude: asset.longitude,
                isFavorite: asset.isFavorite,
                archived: asset.visibility === AssetVisibility.Archive,
              },
              options,
            );
    const update = this.toUpdate(patch, asset.visibility);
    if (Object.keys(update).length > 0) {
      await this.assets.update(auth, asset.id, update);
    }

    for (const folder of skipAlbums ? [] : item.albums) {
      if (!isTakeoutAlbumSelected(folder, options)) {
        continue;
      }
      const albumId = await this.albumFor(run, folder);
      const [outcome] = await this.albums.addAssets(auth, albumId, { ids: [asset.id] });
      if (outcome && !outcome.success && outcome.error !== BulkIdErrorReason.DUPLICATE) {
        throw new TakeoutItemError(`Album membership for “${path.posix.basename(folder)}” could not be restored`);
      }
    }

    await this.repository.itemDone(item.id, resultKind === 'created' ? 'imported' : 'matched');
    // The original is in the library now; the staged copy only took up space.
    await this.staging.remove(item.path);
  }

  /**
   * The copy an earlier run made at `createPath` but never turned into its asset. It is removed only
   * when no asset has it as its original; a copy something refers to is never touched.
   */
  private async removeAbandonedCopy(item: TakeoutItem) {
    if (item.createPath && !(await this.repository.isOriginalPath(item.createPath))) {
      await this.staging.remove(item.createPath);
    }
  }

  /** The photo already in the owner's library with either of the item's digests, if any. */
  private async findExisting(auth: AuthDto, item: TakeoutItem) {
    const { results } = await this.assetMedia.bulkUploadCheck(auth, {
      assets: [
        { id: 'sha256', checksum: item.checksum.toString('hex') },
        { id: 'sha1', checksum: item.legacyChecksum.toString('hex') },
      ],
    });
    const match = results.find((result) => result.assetId);
    return match?.assetId ? { assetId: match.assetId, isTrashed: !!match.isTrashed } : undefined;
  }

  /**
   * Copy the staged file into the library and create its asset. A photo from Google's Locked Folder
   * is created locked, in the same transaction as the asset. The destination is recorded first, so a
   * run that stops after the upload recognises the asset as its own (see `importItem`). `created` is
   * false when the library already had the photo by the time of the upload.
   */
  private async createAsset(
    run: TakeoutRun,
    item: TakeoutItem,
    options: TakeoutOptions,
  ): Promise<{ id: string; created: boolean }> {
    const { auth, row } = run;
    const extension = path.extname(item.name).toLowerCase();
    const destination = StorageCore.getNestedPath(StorageFolder.Upload, row.ownerId, `${randomUUID()}${extension}`);
    await this.repository.itemCreating(item.id, destination);
    const digest = await this.staging
      .copyToLibrary(item.path, item.size, destination, run.controller.signal)
      .catch((error) => {
        throw error instanceof TakeoutStagingError ? new TakeoutItemError(error.message) : error;
      });
    if (!digest.checksum.equals(item.checksum)) {
      await this.staging.remove(destination);
      throw new TakeoutItemError('The staged file changed after it was scanned');
    }

    const takenAt = options.dates ? (item.metadata.takenAt ?? item.metadata.createdAt) : undefined;
    const title = item.metadata.title;
    // Google's title is the name the photo was uploaded with; the export may have shortened it.
    const filename = title && path.extname(title).toLowerCase() === extension ? title : item.name;
    const response = await this.assetMedia.uploadAsset(
      auth,
      {
        filename,
        fileCreatedAt: takenAt ? new Date(takenAt) : item.modifiedAt,
        fileModifiedAt: item.modifiedAt,
        isFavorite: options.favorites && item.metadata.favorite ? true : undefined,
        // `locked` in a request is a lock record written with the asset, never a stored visibility.
        visibility: item.locked ? AssetVisibility.Locked : undefined,
      },
      {
        uuid: randomUUID(),
        checksum: digest.checksum,
        legacyChecksum: digest.legacyChecksum,
        originalPath: destination,
        originalName: item.name,
        size: digest.size,
      },
    );
    if (response.status === AssetMediaStatus.DUPLICATE && /^0{8}-(?:0{4}-){3}0{12}$/.test(response.id)) {
      throw new TakeoutItemError('A matching photo exists but could not be read');
    }
    const created = response.status === AssetMediaStatus.CREATED;
    if (created) {
      // Counted now, so the account's quota applies to the rest of this run as it goes.
      run.auth.user.quotaUsageInBytes += digest.size;
    }
    return { id: response.id, created };
  }

  private toUpdate(patch: TakeoutAssetPatch, visibility: string): UpdateAssetDto {
    const update: UpdateAssetDto = {};
    if (patch.description !== undefined) {
      update.description = patch.description;
    }
    if (patch.dateTimeOriginal !== undefined) {
      update.dateTimeOriginal = patch.dateTimeOriginal;
    }
    if (patch.latitude !== undefined && patch.longitude !== undefined) {
      update.latitude = patch.latitude;
      update.longitude = patch.longitude;
    }
    if (patch.isFavorite) {
      update.isFavorite = true;
    }
    // Only from the timeline: a hidden Live Photo part stays hidden.
    if (patch.archive && visibility === AssetVisibility.Timeline) {
      update.visibility = AssetVisibility.Archive;
    }
    return update;
  }

  /** The album a folder becomes: the one an earlier import made, or a new one. */
  private async albumFor(run: TakeoutRun, folder: string): Promise<string> {
    const cached = run.albums.get(folder);
    if (cached) {
      return cached;
    }
    let albumId = await this.repository.getAlbumFor(run.row.ownerId, folder);
    if (!albumId) {
      const album = await this.albums.create(run.auth, { albumName: path.posix.basename(folder).slice(0, 255) });
      albumId = await this.repository.setAlbumFor(run.row.ownerId, folder, album.id);
      if (albumId !== album.id) {
        // Another run made this folder's album first; keep that one.
        await this.albums.delete(run.auth, album.id);
      }
    }
    run.albums.set(folder, albumId);
    return albumId;
  }

  /** Link an approved Live Photo pair; returns why it could not be linked, or null. */
  private async linkPair(
    run: TakeoutRun,
    pair: { photoAssetId: string | null; videoAssetId: string | null },
  ): Promise<string | null> {
    if (!pair.photoAssetId || !pair.videoAssetId) {
      return 'Both parts must be imported before they can be linked';
    }
    try {
      const photo = await this.repository.getAssetState(pair.photoAssetId);
      if (photo?.livePhotoVideoId === pair.videoAssetId) {
        return null;
      }
      const outcome = await this.livePhoto.relinkOne(run.auth, pair.photoAssetId, pair.videoAssetId);
      return outcome.success ? null : (outcome.error ?? 'The Live Photo could not be linked');
    } catch (error) {
      return errorMessage(error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Job plumbing                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * The heartbeat: extend the lease by writing the progress the run has, and learn whether the owner
   * asked to pause or cancel. Either stops the run where it is (see `settleInterrupt`).
   */
  private async pulse(run: TakeoutRun): Promise<void> {
    if (run.controller.signal.aborted) {
      return;
    }
    const total = run.total ?? 0;
    const written = await this.operations.setBulkResult(run.operation.id, run.claimToken, {
      result: run.result as Record<string, unknown>,
      processedUnits: run.processed,
      totalUnits: Math.max(total, run.processed),
      progress: mediaOperationProgress(run.processed, Math.max(total, run.processed)) ?? 0,
      leaseMs: TAKEOUT_LEASE_MS,
    });
    if (!written) {
      run.controller.abort(new TakeoutStop('The claim on this job was lost'));
    } else if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      run.controller.abort(new TakeoutInterrupt('cancel'));
    } else if (written.pauseRequestedAt) {
      run.controller.abort(new TakeoutInterrupt('pause'));
    }
  }

  /** Settle a pause or cancel the heartbeat interrupted a step for. */
  private async settleInterrupt(run: TakeoutRun, interrupt: TakeoutInterrupt): Promise<void> {
    const { id } = run.operation;
    if (interrupt.request === 'cancel') {
      await this.operations.acknowledgeCancel(id, run.claimToken, { released: false });
      this.logger.log(`Google Photos import job ${id} cancelled by its owner`);
      return;
    }
    if (await this.operations.settlePause(id, run.claimToken)) {
      this.logger.log(`Google Photos import job ${id} paused by its owner`);
      return;
    }
    // Resumed again before the pause landed: hand the job back so the next claim carries on.
    await this.operations.requeue(id, run.claimToken, { delayMs: 0, returnAttempt: true });
  }

  /**
   * Write progress, and learn in the same round trip whether to carry on. Throttled unless `force`.
   * Stops the run (`TakeoutStop`) when the claim is gone, or after settling a cancel or a pause.
   */
  private async checkpoint(run: TakeoutRun, force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - run.lastWrite < TAKEOUT_PROGRESS_INTERVAL_MS) {
      return;
    }
    run.lastWrite = now;
    const total = run.total ?? 0;
    const written = await this.operations.setBulkResult(run.operation.id, run.claimToken, {
      result: run.result as Record<string, unknown>,
      processedUnits: run.processed,
      totalUnits: Math.max(total, run.processed),
      progress: mediaOperationProgress(run.processed, Math.max(total, run.processed)) ?? 0,
      leaseMs: TAKEOUT_LEASE_MS,
    });
    await this.proceed(run, written);
  }

  private async proceed(run: TakeoutRun, written: MediaOperationWriteState | undefined): Promise<void> {
    const { id } = run.operation;
    if (!written) {
      this.logger.warn(`Google Photos import job ${id}: claim lost, stopping`);
      throw new TakeoutStop('claim lost');
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, run.claimToken, { released: false });
      this.logger.log(`Google Photos import job ${id} cancelled by its owner`);
      throw new TakeoutStop('cancelled');
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, run.claimToken))) {
      this.logger.log(`Google Photos import job ${id} paused by its owner`);
      throw new TakeoutStop('paused');
    }
  }

  private throwIfStopped(run: TakeoutRun) {
    if (run.controller.signal.aborted) {
      throw run.controller.signal.reason instanceof Error ? run.controller.signal.reason : new TakeoutStop('stopped');
    }
  }

  private async finish(id: string, claimToken: string) {
    if (
      (await this.operations.beginValidation(id, claimToken)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }))
    ) {
      return;
    }
    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
  }

  /**
   * The owner, acting through the system worker: elevated, so Locked media the owner has is reached
   * without a PIN-unlocked session (owner decision, September 22, 2026). Ownership, quota and album
   * access are still checked on every call, and this auth never leaves the worker.
   */
  async authFor(ownerId: string): Promise<AuthDto | null> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      return null;
    }
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }
}
