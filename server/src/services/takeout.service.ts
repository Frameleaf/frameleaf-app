import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Transaction } from 'kysely';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  TakeoutArchiveCreateDto,
  TakeoutControlDto,
  TakeoutCreateDto,
  TakeoutItemQueryDto,
  TakeoutItemsResponseDto,
  TakeoutOptionsDto,
  TakeoutPairDecisionDto,
  TakeoutPairQueryDto,
  TakeoutPairsResponseDto,
  TakeoutResolveDto,
  TakeoutResponseDto,
  TakeoutRootsResponseDto,
  TakeoutSourceResponseDto,
  TakeoutVerifyChunkDto,
} from 'src/dtos/takeout.dto.js';
import { MediaOperationDestination, MediaOperationKind, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  TAKEOUT_STAGING_RESERVE_BYTES,
  TakeoutStagingError,
  TakeoutStagingRepository,
} from 'src/repositories/takeout-staging.repository.js';
import {
  TakeoutConflict,
  TakeoutImport,
  TakeoutNotFound,
  TakeoutOperation,
  TakeoutRepository,
  TakeoutSource,
  takeoutOperationFor,
} from 'src/repositories/takeout.repository.js';
import { DB } from 'src/schema/index.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { checkAccess } from 'src/utils/access.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import {
  TAKEOUT_BUSY_STATES,
  TAKEOUT_DEFAULT_OPTIONS,
  TAKEOUT_REVIEWABLE_STATES,
  TakeoutAction,
  TakeoutMetadata,
  isTakeoutAlbumSelected,
  isTakeoutLockedFolder,
  isTakeoutYearFolder,
  parseTakeoutOptions,
  takeoutState,
} from 'src/utils/takeout.js';

/** An import holds at most this many sources. */
export const TAKEOUT_MAX_SOURCES = 500;
/**
 * Claims one import job may use before a lapsed lease counts as a failure. Imports are long and
 * survive restarts; every claim resumes from what was recorded. A shutdown, a pause or the item
 * retry hands the claim back with its attempt returned, so only a lost claim counts, and a lost
 * claim may be resumed twice before it is a failure (owner decision, September 22, 2026; FL-43).
 */
export const TAKEOUT_MAX_ATTEMPTS = 3;

const asIso = (value: Date) => value.toISOString();

const sourceDto = (source: TakeoutSource): TakeoutSourceResponseDto => ({
  id: source.id,
  name: source.name,
  kind: source.kind,
  size: source.size,
  received: source.received,
  scanned: source.scanned,
  rejected: source.rejected,
});

/**
 * Google Photos imports, the request side (FL-65, `IMP-001`).
 *
 * source → stage → scan → review → import → reconcile. Staging happens here, one resumable
 * archive chunk at a time; scanning and importing are durable `takeout_import` media operations
 * that `TakeoutWorkerService` runs, so they continue after the browser closes and are paused,
 * cancelled and retried like any other job, from this wizard or from Activity.
 *
 * The rules this side keeps:
 *
 * - **Owner only.** Every import is read through its owner; another account's import is "not found".
 * - **Server paths are the server's.** A server directory can only be chosen by an administrator,
 *   and only inside a root the operator configured; the browser names a root by its index and a
 *   folder relative to it, and the server resolves and checks it. No path is ever sent back.
 * - **Staging is bounded.** An archive is refused when the account's storage quota or the staging
 *   volume could not hold it.
 * - **Locked stays locked.** Items going into Locked are not listed, and cannot be decided about,
 *   in a session that has not unlocked Locked; only their number is given.
 * - **One job at a time.** Scanning or importing starts only when no job is working on the import.
 */
@Injectable()
export class TakeoutService {
  constructor(
    private logger: LoggingRepository,
    private repository: TakeoutRepository,
    private staging: TakeoutStagingRepository,
    private mediaOperations: MediaOperationService,
    private access: AccessRepository,
    private config: ConfigRepository,
  ) {
    this.logger.setContext(TakeoutService.name);
  }

  async list(auth: AuthDto): Promise<TakeoutResponseDto[]> {
    this.requireSession(auth);
    const imports = await this.repository.list(auth.user.id);
    const latest = await this.repository.latestOperations(
      auth.user.id,
      imports.map(({ id }) => id),
    );
    return Promise.all(
      imports.map((row) =>
        this.present(
          auth,
          row,
          takeoutOperationFor(
            row.phase,
            latest.filter(({ importId }) => importId === row.id).map(({ operation }) => operation),
          ),
          false,
        ),
      ),
    );
  }

  async get(auth: AuthDto, id: string): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const row = await this.findOwned(auth, id);
    return this.present(auth, row, await this.currentOperation(auth, row), true);
  }

  /** The directories an administrator may import from. Administrators only (see the controller). */
  roots(): TakeoutRootsResponseDto {
    return {
      roots: this.config.getEnv().storage.importRoots.map((root, index) => ({ id: String(index), path: root })),
    };
  }

  async create(auth: AuthDto, dto: TakeoutCreateDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const wantsDirectory = dto.rootId !== undefined || dto.directory !== undefined;
    let directory: string | undefined;
    if (wantsDirectory) {
      // A server folder is an administrator's choice made in a signed-in session; an API key, even an
      // administrator's, may upload archives but never point the server at its own filesystem.
      if (!auth.user.isAdmin || auth.apiKey) {
        throw new ForbiddenException('Only an administrator can import from a server folder');
      }
      const roots = this.config.getEnv().storage.importRoots;
      const root = dto.rootId !== undefined && /^\d+$/.test(dto.rootId) ? roots[Number(dto.rootId)] : undefined;
      if (!root) {
        throw new BadRequestException('Choose one of the permitted import locations');
      }
      directory = await this.mapErrors(() => this.staging.resolveDirectory(root, dto.directory ?? ''));
    }

    const row = await this.repository.create(
      auth.user.id,
      dto.name,
      { ...TAKEOUT_DEFAULT_OPTIONS },
      directory ? { name: path.basename(directory) || directory, path: directory } : undefined,
    );
    await this.staging.prepare(auth.user.id, row.id);

    this.logger.log(`Google Photos import ${row.id} created${directory ? ' from a server folder' : ''}`);
    return this.get(auth, row.id);
  }

  /**
   * Stage another archive. Selecting the same file again (same name and size) answers with the
   * archive already staged, so a browser that lost the answer resumes rather than duplicating it.
   */
  async addArchive(auth: AuthDto, id: string, dto: TakeoutArchiveCreateDto): Promise<TakeoutSourceResponseDto> {
    this.requireSession(auth);
    const name = path.basename(dto.name);
    const source = await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        await this.reopenSources(tx, row, operation, 'Archives can only be added before the scan starts');
        const sources = await this.repository.sourcesIn(tx, id);
        const existing = sources.find((item) => item.kind === 'zip' && item.name === name && item.size === dto.size);
        if (existing) {
          return existing;
        }
        if (sources.length >= TAKEOUT_MAX_SOURCES) {
          throw new TakeoutConflict(`An import can hold up to ${TAKEOUT_MAX_SOURCES} archives`);
        }

        const outstanding = sources.reduce((total, item) => total + (item.size - item.received), 0) + dto.size;
        const quota = auth.user.quotaSizeInBytes;
        if (quota !== null && quota !== undefined) {
          // Every unfinished import of the account counts, not only this one.
          const staged = (await this.repository.stagedArchiveBytes(tx, auth.user.id)) + dto.size;
          if (auth.user.quotaUsageInBytes + staged > quota) {
            throw new TakeoutConflict('These archives are larger than the storage left on your account');
          }
        }
        const directory = await this.staging.prepare(auth.user.id, id);
        if ((await this.staging.freeBytes(directory)) < outstanding + TAKEOUT_STAGING_RESERVE_BYTES) {
          throw new TakeoutConflict('The server does not have enough free space to stage this archive');
        }

        const added = await this.repository.addSource(tx, {
          importId: id,
          name,
          kind: 'zip',
          path: '',
          size: dto.size,
        });
        const archivePath = path.join(directory, `${added.id}.zip`);
        await this.repository.setSourcePath(tx, added.id, archivePath);
        return { ...added, path: archivePath };
      }),
    );
    return sourceDto(source);
  }

  /** Remove an archive chosen by mistake, before the scan starts. Its staged bytes are deleted. */
  async removeArchive(auth: AuthDto, id: string, archiveId: string): Promise<void> {
    this.requireSession(auth);
    const removed = await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        await this.reopenSources(tx, row, operation, 'Archives can only be removed before the scan starts');
        const source = (await this.repository.sourcesIn(tx, id)).find((item) => item.id === archiveId);
        if (!source) {
          throw new TakeoutNotFound('Archive not found');
        }
        const staged = await this.repository.sourceFilePaths(tx, archiveId);
        await this.repository.removeSource(tx, archiveId);
        return { source, staged };
      }),
    );
    // Whatever an earlier scan extracted from the archive goes with it.
    for (const stagedPath of removed.staged) {
      await this.staging.remove(stagedPath);
    }
    if (removed.source.kind === 'zip' && removed.source.path) {
      await this.staging.remove(removed.source.path);
    }
  }

  async uploadChunk(
    auth: AuthDto,
    id: string,
    archiveId: string,
    offset: number,
    bytes: Buffer,
  ): Promise<TakeoutSourceResponseDto> {
    this.requireSession(auth);
    const source = await this.mapErrors(() =>
      this.repository.writeChunk(auth.user.id, id, archiveId, (staged) =>
        this.staging.writeChunk(staged, offset, bytes),
      ),
    );
    return sourceDto(source);
  }

  async verifyChunk(auth: AuthDto, id: string, archiveId: string, dto: TakeoutVerifyChunkDto): Promise<void> {
    this.requireSession(auth);
    await this.findOwned(auth, id);
    const source = (await this.repository.sources(id)).find((item) => item.id === archiveId && item.kind === 'zip');
    if (!source) {
      throw new NotFoundException('Archive not found');
    }
    await this.mapErrors(() => this.staging.verifyChunk(source, dto.offset, dto.size, dto.sha256));
  }

  /**
   * Start scanning, or scan again after a scan failed or was cancelled. Every archive must be fully
   * staged. The scan runs on the server; closing the browser does not stop it.
   */
  async scan(auth: AuthDto, id: string): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        const state = takeoutState(row.phase, operation);
        const retrying = row.phase === 'scanning' && (state === 'failed' || state === 'cancelled');
        if (row.phase !== 'sources' && !retrying) {
          throw new TakeoutConflict('This import has already been scanned');
        }
        const sources = await this.repository.sourcesIn(tx, id);
        if (sources.length === 0) {
          throw new TakeoutConflict('Add your Takeout archives before scanning');
        }
        if (sources.some((source) => source.kind === 'zip' && source.received !== source.size)) {
          throw new TakeoutConflict('Finish uploading every archive before scanning');
        }
        await this.repository.setPhase(tx, id, 'scanning');
        await this.startOperation(tx, auth, row, 'scan', retrying ? operation : undefined);
      }),
    );
    return this.get(auth, id);
  }

  /**
   * Import the reviewed items with the owner's choices, or import again after a run failed, was
   * cancelled or finished with items left over. Items already imported are never imported twice.
   */
  async startImport(auth: AuthDto, id: string, dto: TakeoutOptionsDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const options = parseTakeoutOptions(dto);
    await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        const state = takeoutState(row.phase, operation);
        if (row.phase === 'sources' || row.phase === 'scanning' || !TAKEOUT_REVIEWABLE_STATES.includes(state)) {
          throw new TakeoutConflict('This import is not ready to import yet');
        }
        await this.repository.setOptions(tx, id, options);
        if (options.sidecarReview) {
          const review = await this.repository.countReview(tx, id);
          if (review.total > 0 && review.total === review.locked && !getLockedOwnerId(auth)) {
            throw new TakeoutConflict('Unlock Locked to resolve the flagged items before importing.');
          }
          if (review.total > 0) {
            throw new TakeoutConflict('Review complete. Resolve the flagged items before importing.');
          }
        } else {
          await this.repository.releaseReview(tx, id);
        }
        const stopped = state === 'failed' || state === 'cancelled';
        const previous = row.phase === 'importing' && stopped ? operation : undefined;
        await this.repository.setPhase(tx, id, 'importing');
        await this.startOperation(tx, auth, row, 'import', previous);
      }),
    );
    return this.get(auth, id);
  }

  /** Pause, resume or cancel the job working on the import, through the durable job itself. */
  async control(auth: AuthDto, id: string, dto: TakeoutControlDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const row = await this.findOwned(auth, id);
    const operation = await this.currentOperation(auth, row);
    if (!operation || !TAKEOUT_BUSY_STATES.includes(takeoutState(row.phase, operation))) {
      throw new BadRequestException('Nothing is running for this import');
    }
    switch (dto.action) {
      case 'pause': {
        await this.mediaOperations.pause(auth, operation.id);
        break;
      }
      case 'resume': {
        await this.mediaOperations.resume(auth, operation.id);
        break;
      }
      case 'cancel': {
        await this.mediaOperations.cancel(auth, operation.id);
        break;
      }
    }
    return this.get(auth, id);
  }

  /**
   * Delete an import that no job is working on. Its staged copies are removed; everything it
   * brought into the library stays there.
   */
  async remove(auth: AuthDto, id: string): Promise<void> {
    this.requireSession(auth);
    await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        if (TAKEOUT_BUSY_STATES.includes(takeoutState(row.phase, operation))) {
          throw new TakeoutConflict('Cancel the running job before deleting this import');
        }
        await this.repository.delete(tx, id);
      }),
    );
    await this.staging.removeImport(auth.user.id, id);
    this.logger.log(`Google Photos import ${id} deleted`);
  }

  async items(auth: AuthDto, id: string, query: TakeoutItemQueryDto): Promise<TakeoutItemsResponseDto> {
    this.requireSession(auth);
    await this.findOwned(auth, id);
    const includeLocked = !!getLockedOwnerId(auth);
    const [page, counts] = await Promise.all([
      this.repository.items(id, {
        state: query.state,
        offset: query.offset ?? 0,
        limit: query.limit ?? 100,
        includeLocked,
      }),
      includeLocked ? undefined : this.repository.counts(id),
    ]);
    const assetIds = page.items.flatMap((item) => (item.assetId ? [item.assetId] : []));
    const readable =
      assetIds.length > 0
        ? await checkAccess(this.access, { auth, permission: Permission.AssetRead, ids: assetIds })
        : new Set<string>();

    return {
      total: page.total,
      hiddenLocked: counts?.hiddenLocked ?? 0,
      items: page.items.map((item) => ({
        id: item.id,
        path: item.relativePath,
        folder: item.folder,
        source: item.sourceName,
        kind: item.kind,
        size: item.size,
        state: item.state,
        assetId: item.assetId && readable.has(item.assetId) ? item.assetId : null,
        metadata: item.metadata,
        candidates: item.candidates,
        sidecarId: item.sidecarId,
        albums: item.albums,
        warnings: item.warnings,
        locked: item.locked,
        error: item.error,
      })),
    };
  }

  /**
   * Decide about one item: which sidecar's metadata to use, none, or leave it out. Only while no job
   * is working on the import, and never for an item that has already been imported.
   */
  async resolve(auth: AuthDto, id: string, itemId: string, dto: TakeoutResolveDto): Promise<TakeoutResponseDto> {
    this.requireSession(auth);
    const includeLocked = !!getLockedOwnerId(auth);
    await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        this.requireReviewable(row, operation);
        const item = await this.repository.lockItem(tx, id, itemId);
        if (!item || (item.withheld && !includeLocked)) {
          throw new TakeoutNotFound('Item not found');
        }
        if (['imported', 'matched', 'importing'].includes(item.state)) {
          throw new TakeoutConflict('This item is already in your library');
        }

        let sidecarId = item.sidecarId;
        let metadata: TakeoutMetadata = item.metadata;
        if (dto.sidecarId !== undefined) {
          if (dto.sidecarId === null) {
            sidecarId = null;
            metadata = { title: item.name };
          } else {
            const chosen = item.candidates.find((candidate) => candidate.id === dto.sidecarId);
            if (!chosen) {
              throw new TakeoutConflict('That sidecar does not belong to this item');
            }
            sidecarId = chosen.id;
            metadata = chosen.metadata;
          }
        }

        const decided = dto.sidecarId !== undefined || item.candidates.length <= 1 || !!item.sidecarId;
        const state = dto.skip ? 'skipped' : decided ? 'ready' : 'review';
        await this.repository.updateDecision(tx, itemId, { state, sidecarId, metadata });
      }),
    );
    return this.get(auth, id);
  }

  async pairs(auth: AuthDto, id: string, query: TakeoutPairQueryDto): Promise<TakeoutPairsResponseDto> {
    this.requireSession(auth);
    await this.findOwned(auth, id);
    const { pairs, total } = await this.repository.pairs(id, {
      state: query.state,
      offset: query.offset ?? 0,
      limit: query.limit ?? 100,
      includeLocked: !!getLockedOwnerId(auth),
    });
    return {
      total,
      pairs: pairs.map(({ photoItemId, videoItemId, photoPath, videoPath, state, error }) => ({
        photoItemId,
        videoItemId,
        photoPath,
        videoPath,
        state,
        error,
      })),
    };
  }

  async decidePair(auth: AuthDto, id: string, dto: TakeoutPairDecisionDto): Promise<TakeoutPairsResponseDto> {
    this.requireSession(auth);
    const includeLocked = !!getLockedOwnerId(auth);
    await this.mapErrors(() =>
      this.repository.withImport(auth.user.id, id, async (tx, row, operation) => {
        this.requireReviewable(row, operation);
        if (!includeLocked) {
          const [photo, video] = await Promise.all([
            this.repository.lockItem(tx, id, dto.photoItemId),
            this.repository.lockItem(tx, id, dto.videoItemId),
          ]);
          if (!photo || !video || photo.withheld || video.withheld) {
            throw new TakeoutNotFound('Pair not found');
          }
        }
        await this.repository.decidePair(tx, id, dto.photoItemId, dto.videoItemId, dto.approve);
      }),
    );
    return this.pairs(auth, id, { offset: 0, limit: 100 });
  }

  /** Staged copies belong to the account; its deletion removes them. Never a selected server folder. */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    await this.staging.removeOwner(id);
  }

  /**
   * Queue the job for a step in the same transaction that moves the import to it, so a worker can
   * never claim the job and read the phase it is leaving.
   */
  private async startOperation(
    tx: Transaction<DB>,
    auth: AuthDto,
    row: TakeoutImport,
    action: TakeoutAction,
    previous: TakeoutOperation | undefined,
  ) {
    const created = await this.repository.insertOperation(tx, {
      ownerId: auth.user.id,
      kind: MediaOperationKind.TakeoutImport,
      // Imports run on this server's own workers; there is no remote to choose.
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: row.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: previous?.id ?? null,
      projectId: null,
      revisionId: null,
      snapshot: { importId: row.id, action },
      settings: {},
      estimate: null,
      result: null,
      totalUnits: null,
      maxAttempts: TAKEOUT_MAX_ATTEMPTS,
    });
    this.logger.log(`Google Photos import ${row.id}: ${action} queued as media operation ${created.id}`);
    return created;
  }

  /**
   * Sources change only before scanning, or after a scan that failed or was cancelled, which puts
   * the import back to staging; the next scan reads only what it has not read yet.
   */
  private async reopenSources(
    tx: Transaction<DB>,
    row: TakeoutImport,
    operation: TakeoutOperation | undefined,
    message: string,
  ) {
    if (row.phase === 'sources') {
      return;
    }
    const state = takeoutState(row.phase, operation);
    if (row.phase === 'scanning' && (state === 'failed' || state === 'cancelled')) {
      await this.repository.setPhase(tx, row.id, 'sources');
      return;
    }
    throw new TakeoutConflict(message);
  }

  private async currentOperation(auth: AuthDto, row: TakeoutImport): Promise<TakeoutOperation | undefined> {
    const latest = await this.repository.latestOperations(auth.user.id, [row.id]);
    return takeoutOperationFor(
      row.phase,
      latest.map(({ operation }) => operation),
    );
  }

  private requireReviewable(row: TakeoutImport, operation: TakeoutOperation | undefined) {
    const state = takeoutState(row.phase, operation);
    if (row.phase === 'sources' || row.phase === 'scanning' || !TAKEOUT_REVIEWABLE_STATES.includes(state)) {
      throw new TakeoutConflict('Wait for the running job to finish, or stop it, before changing review decisions');
    }
  }

  private async present(
    auth: AuthDto,
    row: TakeoutImport,
    operation: TakeoutOperation | undefined,
    detail: boolean,
  ): Promise<TakeoutResponseDto> {
    const state = takeoutState(row.phase, operation);
    const options = parseTakeoutOptions(row.options);
    const busy = TAKEOUT_BUSY_STATES.includes(state);
    const [sources, counts, albums, summary] = await Promise.all([
      this.repository.sources(row.id),
      this.repository.counts(row.id),
      detail ? this.repository.albums(row.id, !!getLockedOwnerId(auth)) : Promise.resolve([]),
      detail && !busy && row.phase !== 'sources' && row.phase !== 'scanning'
        ? this.repository.matchSummary(auth.user.id, row.id)
        : Promise.resolve({ newAssets: 0, matchedOriginals: 0 }),
    ]);
    const action = operation?.snapshot.action;

    return {
      id: row.id,
      name: row.name,
      state,
      phase: row.phase,
      action: action === 'scan' || action === 'import' ? action : null,
      operationId: operation?.id ?? null,
      processed: operation?.processedUnits ?? 0,
      total: operation?.totalUnits ?? null,
      error: operation?.error ?? null,
      errorCode: operation?.errorCode ?? null,
      createdAt: asIso(row.createdAt),
      updatedAt: asIso(row.updatedAt),
      counts: {
        ...counts,
        hiddenLocked: getLockedOwnerId(auth) ? 0 : counts.hiddenLocked,
        newAssets: summary.newAssets,
        matchedOriginals: summary.matchedOriginals + counts.matched,
      },
      sources: sources.map((source) => sourceDto(source)),
      options,
      albums: albums
        .filter(({ folder }) => !isTakeoutLockedFolder(folder))
        .map(({ folder, count }) => ({
          folder,
          name: path.posix.basename(folder),
          count,
          selected: isTakeoutAlbumSelected(folder, options),
          year: isTakeoutYearFolder(folder),
        })),
    };
  }

  private requireSession(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Imports are not available on a shared link');
    }
  }

  private async findOwned(auth: AuthDto, id: string): Promise<TakeoutImport> {
    const row = await this.repository.get(auth.user.id, id);
    if (!row) {
      throw new NotFoundException('Import not found');
    }
    return row;
  }

  /** Repository and staging refusals as the HTTP answers they are. */
  private async mapErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof TakeoutNotFound) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof TakeoutConflict || error instanceof TakeoutStagingError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
