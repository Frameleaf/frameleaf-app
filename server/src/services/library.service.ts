import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { createHash } from 'node:crypto';
import path from 'node:path';
import picomatch from 'picomatch';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { LibraryRemovalCounts } from 'src/repositories/library.repository.js';
import type { JobOf } from 'src/types.js';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  CreateLibraryDto,
  LibraryFolderBrowseDto,
  LibraryFolderBrowseResponseDto,
  LibraryFolderEstimateDto,
  LibraryFolderEstimateResponseDto,
  LibraryRemovalDto,
  LibraryRemovalReviewDto,
  LibraryResponseDto,
  LibrarySearchDto,
  LibraryStatsResponseDto,
  ManagedUploadsStatsResponseDto,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryResponseDto,
  mapLibrary,
} from 'src/dtos/library.dto.js';
import {
  AdminAuditAction,
  CronJob,
  DatabaseLock,
  FrameleafWorker,
  JobName,
  JobStatus,
  QueueName,
  UserStatus,
} from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import {
  DEFAULT_LIBRARY_EXCLUSION_PATTERNS,
  type ImportPathNeighbour,
  checkImportPathOnDisk,
  checkImportPaths,
  invalidExclusionPatterns,
  isBrowsableFolder,
  isSameOrInside,
  normalizeImportPath,
  resolvesIntoMediaStorage,
} from 'src/utils/library-paths.js';
import { libraryAssetFromFile, libraryPathsFingerprint } from 'src/utils/library-scan.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { batched, findOrFail, handlePromiseError } from 'src/utils/misc.js';
import { tryPromise } from 'src/utils/promise.js';

/**
 * One entry for the administrator audit trail about a library (FL-76), listed in its owner's
 * account history. `auth` is absent when a library changes without an administrator's request.
 */
/** FL-365: how many folders one browse lists at most. */
const BROWSE_FOLDER_LIMIT = 500;
/** FL-539: a folder estimate stops after this many files or this long, and says it is incomplete. */
const FOLDER_ESTIMATE_LIMIT = 50_000;
const FOLDER_ESTIMATE_MS = 8000;

const libraryEvent = (
  auth: AuthDto | undefined,
  library: { id: string; name: string; ownerId: string },
  action: AdminAuditAction,
) => ({
  userId: library.ownerId,
  actorId: auth?.user.id ?? null,
  libraryId: library.id,
  action,
  subject: library.name,
  detail: null,
});

@Injectable()
export class LibraryService extends BaseService {
  private watchLibraries = false;
  private lock = false;
  private watchers = new Map<string, () => Promise<void>>();
  private watchRequests = new Map<string, symbol>();

  @OnEvent({ name: 'ConfigInit', workers: [FrameleafWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      library: { watch, scan },
    },
  }: ArgOf<'ConfigInit'>) {
    // This ensures that library watching only occurs in one microservice
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.Library);

    this.watchLibraries = this.lock && watch.enabled;

    if (this.lock) {
      this.cronRepository.create({
        name: CronJob.LibraryScan,
        expression: scan.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.LibraryScanQueueAll }), this.logger),
        // FL-363: added folders are checked by the overnight schedule (`OvernightService`), so this
        // timer no longer starts; `scan.enabled` decides whether the overnight step runs.
        start: false,
      });
    }

    if (this.watchLibraries) {
      await this.watchAll();
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig: { library } }: ArgOf<'ConfigUpdate'>) {
    if (!this.lock) {
      return;
    }

    this.cronRepository.update({
      name: CronJob.LibraryScan,
      expression: library.scan.cronExpression,
      start: false,
    });

    if (library.watch.enabled !== this.watchLibraries) {
      // Watch configuration changed, update accordingly
      this.watchLibraries = library.watch.enabled;
      await (this.watchLibraries ? this.watchAll() : this.unwatchAll());
    }
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const request = Symbol();
    this.watchRequests.set(id, request);
    const library = await this.findOrFail(id);
    if (!this.watchLibraries || this.watchRequests.get(id) !== request) {
      return false;
    }

    await this.stopWatcher(id);
    if (!this.watchLibraries || this.watchRequests.get(id) !== request || library.importPaths.length === 0) {
      return false;
    }

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    const ready = Promise.withResolvers<void>();
    let active = true;

    const handler = async (event: string, path: string) => {
      if (!active || !this.watchLibraries) {
        return;
      }
      if (matcher(path)) {
        this.logger.debug(`File ${event} event received for ${path} in library ${library.id}`);
        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: { libraryId: library.id, paths: [path] },
        });
      } else {
        this.logger.verbose(`Ignoring file ${event} event for ${path} in library ${library.id}`);
      }
    };

    const deletionHandler = async (path: string) => {
      if (!active || !this.watchLibraries) {
        return;
      }
      this.logger.debug(`File unlink event received for ${path} in library ${library.id}`);
      await this.jobRepository.queue({
        name: JobName.LibraryRemoveAsset,
        data: { libraryId: library.id, paths: [path] },
      });
    };

    const stop = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 5000,
          pollInterval: 1000,
        },
      },
      {
        onReady: () => ready.resolve(),
        onAdd: (path) => {
          return handlePromiseError(handler('add', path), this.logger);
        },
        onChange: (path) => {
          return handlePromiseError(handler('change', path), this.logger);
        },
        onUnlink: (path) => {
          return handlePromiseError(deletionHandler(path), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
          ready.reject(error);
        },
      },
    );

    let closing: Promise<void> | undefined;
    const close = () => {
      active = false;
      ready.resolve();
      closing ??= tryPromise(stop).catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
      return closing;
    };
    this.watchers.set(id, close);
    try {
      await ready.promise;
      return active && this.watchRequests.get(id) === request;
    } catch (error) {
      try {
        await close();
        if (this.watchers.get(id) === close) {
          this.watchers.delete(id);
        }
      } catch (closeError) {
        this.logger.error(`Unable to close library watcher ${id}: ${closeError}`);
      }
      throw error;
    }
  }

  private async stopWatcher(id: string) {
    const close = this.watchers.get(id);
    if (close) {
      await close();
      if (this.watchers.get(id) === close) {
        this.watchers.delete(id);
      }
    }
  }

  async unwatch(id: string) {
    this.watchRequests.delete(id);
    await this.stopWatcher(id);
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.watchLibraries = false;
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.lock) {
      return false;
    }

    const ids = new Set([...this.watchers.keys(), ...this.watchRequests.keys()]);
    const results = await Promise.allSettled([...ids].map((id) => this.unwatch(id)));
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason;
      }
    }
  }

  async watchAll() {
    if (!this.lock) {
      return false;
    }

    const libraries = await this.libraryRepository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getStatistics(id: string): Promise<LibraryStatsResponseDto> {
    const statistics = await this.libraryRepository.getStatistics(id);
    if (!statistics) {
      throw new BadRequestException(`Library ${id} not found`);
    }
    return statistics;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(dto: LibrarySearchDto = {}): Promise<LibraryResponseDto[]> {
    const libraries = await this.libraryRepository.getAll(dto.withDeleted ?? false);
    return libraries.map((library) => mapLibrary(library));
  }

  @OnJob({ name: JobName.LibraryDeleteCheck, queue: QueueName.Library })
  async handleQueueCleanup(): Promise<JobStatus> {
    this.logger.log('Checking for any libraries pending deletion...');
    const pendingDeletions = await this.libraryRepository.getAllDeleted();
    if (pendingDeletions.length > 0) {
      const libraryString = pendingDeletions.length === 1 ? 'library' : 'libraries';
      this.logger.log(`Found ${pendingDeletions.length} ${libraryString} pending deletion, cleaning up...`);

      await this.jobRepository.queueAll(
        pendingDeletions.map((libraryToDelete) => ({ name: JobName.LibraryDelete, data: { id: libraryToDelete.id } })),
      );
    }

    return JobStatus.Success;
  }

  async create(dto: CreateLibraryDto, auth?: AuthDto): Promise<LibraryResponseDto> {
    // FL-78: a library belongs to a live account, for good; its folders are checked before it exists
    const owner = await this.userRepository.get(dto.ownerId, { withDeleted: true });
    if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) {
      throw new BadRequestException('Choose an active account to own the library');
    }

    await this.requireValidImportPaths(dto.importPaths ?? []);
    const importPaths = (dto.importPaths ?? []).map((importPath) => normalizeImportPath(importPath));

    const exclusionPatterns = dto.exclusionPatterns ?? [...DEFAULT_LIBRARY_EXCLUSION_PATTERNS];
    this.requireValidExclusionPatterns(exclusionPatterns);

    const library = await this.libraryRepository.create({
      ownerId: dto.ownerId,
      readOnly: dto.readOnly ?? false,
      name: dto.name ?? 'New External Library',
      importPaths,
      exclusionPatterns,
    });
    await this.recordAdminEvents([libraryEvent(auth, library, AdminAuditAction.LibraryCreated)]);
    if (importPaths.length > 0) {
      await this.notifyWatchers(library.id);
    }
    return mapLibrary(library);
  }

  /**
   * FL-365: the folders this server can see under `path`, for an administrator choosing a folder of
   * photos to add. Only names are read; hidden, system and NAS folders are left out.
   */
  async browseFolders({ path: requested }: LibraryFolderBrowseDto): Promise<LibraryFolderBrowseResponseDto> {
    const raw = requested?.trim() || '/';
    const folder = normalizeImportPath(raw);
    if (!path.isAbsolute(raw) || raw.split('/').includes('..')) {
      throw new BadRequestException('Choose a whole path, starting with a slash, with no .. in it');
    }
    const parent = folder === '/' ? null : path.posix.dirname(folder);
    let readable = true;
    let folders: { name: string; path: string }[] = [];
    try {
      const entries = await this.storageRepository.readdirWithTypes(folder);
      folders = entries
        .filter((entry) => entry.isDirectory() && isBrowsableFolder(entry.name))
        .map((entry) => ({ name: entry.name, path: path.posix.join(folder, entry.name) }))
        .toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      readable = false;
    }
    return {
      path: folder,
      parent,
      folders: folders.slice(0, BROWSE_FOLDER_LIMIT),
      truncated: folders.length > BROWSE_FOLDER_LIMIT,
      readable,
      defaultExclusionPatterns: [...DEFAULT_LIBRARY_EXCLUSION_PATTERNS],
    };
  }

  /**
   * FL-539: about how many photos and videos a folder holds, and how much they take, for "About N
   * photos and videos, X GB" on Add a folder. It walks the folder as a scan would (same skips), and
   * stops after a while on a very large or slow folder, saying the count is incomplete.
   */
  async estimateFolder({
    path: requested,
    exclusionPatterns,
  }: LibraryFolderEstimateDto): Promise<LibraryFolderEstimateResponseDto> {
    const raw = requested.trim();
    if (!path.isAbsolute(raw) || raw.split('/').includes('..')) {
      throw new BadRequestException('Choose a whole path, starting with a slash, with no .. in it');
    }
    const folder = normalizeImportPath(raw);
    const deadline = Date.now() + FOLDER_ESTIMATE_MS;
    let count = 0;
    let bytes = 0;
    let complete = true;
    try {
      const batches = this.storageRepository.walkLibrary({
        pathsToCrawl: [folder],
        includeHidden: false,
        exclusionPatterns,
        take: 500,
      });
      for await (const batch of batches) {
        for (const file of batch) {
          count++;
          bytes += await this.storageRepository
            .stat(file)
            .then((stats) => stats.size)
            .catch(() => 0);
        }
        if (count >= FOLDER_ESTIMATE_LIMIT || Date.now() > deadline) {
          complete = false;
          break;
        }
      }
    } catch {
      return { readable: false, count: 0, bytes: 0, complete: true };
    }
    return { readable: true, count, bytes, complete };
  }

  /** Every account's managed uploads, for the Libraries list (FL-78). */
  getManagedUploads(): Promise<ManagedUploadsStatsResponseDto[]> {
    return this.libraryRepository.getManagedUploadStatistics();
  }

  @OnJob({ name: JobName.LibrarySyncFiles, queue: QueueName.Library })
  async handleSyncFiles(job: JobOf<JobName.LibrarySyncFiles>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    // We need to check if the library still exists as it could have been deleted after the scan was queued
    if (!library) {
      this.logger.debug(`Library ${job.libraryId} not found, skipping file import`);
      return JobStatus.Failed;
    }
    if (library.deletedAt) {
      this.logger.debug(`Library ${job.libraryId} is deleted, won't import assets into it`);
      return JobStatus.Failed;
    }
    // FL-78: never import into an account on its way out
    const owner = await this.userRepository.get(library.ownerId, { withDeleted: true });
    if (!owner || owner.deletedAt || owner.status !== UserStatus.Active) {
      this.logger.debug(`Library ${job.libraryId} belongs to a deleted account, won't import assets into it`);
      return JobStatus.Skipped;
    }
    // FL-538: nothing new is added while an administrator has paused the owner's uploads
    if (owner.uploadsPaused) {
      this.logger.debug(`Library ${job.libraryId}: new uploads are paused for its owner, won't import assets`);
      return JobStatus.Skipped;
    }

    const assetImports: Insertable<AssetTable>[] = [];
    await Promise.all(
      job.paths.map(async (filePath) => {
        const assetPath = path.normalize(filePath);
        try {
          if (await resolvesIntoMediaStorage(this.storageRepository, assetPath)) {
            this.logger.warn(`Skipping ${assetPath} for library ${job.libraryId}: it links into the media storage`);
            return;
          }
          const stat = await this.storageRepository.stat(assetPath);
          assetImports.push(
            libraryAssetFromFile(
              { path: assetPath, mtime: stat.mtime },
              { ownerId: library.ownerId, libraryId: job.libraryId },
              (value) => this.cryptoRepository.hashSha1(value),
              mimeTypes.isVideo(assetPath),
            ),
          );
        } catch (error) {
          this.logger.error(`Error processing ${assetPath} for library ${job.libraryId}: ${error}`);
        }
      }),
    );

    const assetIds = await this.assetRepository.createAll(assetImports);

    const progressMessage =
      job.progressCounter && job.totalAssets
        ? `(${job.progressCounter} of ${job.totalAssets})`
        : `(${job.progressCounter} done so far)`;

    this.logger.log(`Imported ${assetIds.length} ${progressMessage} file(s) into library ${job.libraryId}`);

    await Promise.all(
      assetIds.map((assetId) =>
        this.eventRepository.emit('AssetCreate', { asset: { id: assetId, ownerId: library.ownerId } }),
      ),
    );

    await this.queuePostSyncJobs(assetIds);

    return JobStatus.Success;
  }

  /**
   * Check import folders without saving them (FL-78): their form, where they are, clashes with each
   * other and with other libraries, and whether this server can read them right now. `id` names the
   * library being edited, whose own folders are not a clash; for a library not created yet any id
   * that names no library will do.
   */
  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const importPaths = await checkImportPaths(this.storageRepository, dto.importPaths ?? [], {
      neighbours: await this.getNeighbours(id),
    });
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto, auth?: AuthDto): Promise<LibraryResponseDto> {
    const existing = await this.findOrFail(id);
    // The owner is fixed once a library exists: the update DTO has no owner, and none is ever read.
    if (dto.importPaths) {
      await this.requireValidImportPaths(dto.importPaths, id);
    }
    const update: UpdateLibraryDto = {
      name: dto.name,
      importPaths: dto.importPaths?.map((importPath) => normalizeImportPath(importPath)),
      exclusionPatterns: dto.exclusionPatterns,
    };

    if (update.exclusionPatterns) {
      this.requireValidExclusionPatterns(update.exclusionPatterns);
    }

    const library = await this.libraryRepository.update(id, update);
    await this.recordAdminEvents([libraryEvent(auth, library, AdminAuditAction.LibraryUpdated)]);

    const foldersChanged =
      libraryPathsFingerprint(existing) !==
      libraryPathsFingerprint(library as { importPaths: string[]; exclusionPatterns: string[] });
    if (foldersChanged) {
      // A running scan was asked about the old folders; it stops, and the watcher follows the new ones.
      await this.eventRepository.emit('LibraryScanStop', { libraryId: id, reason: 'paths_changed' });
      await this.notifyWatchers(id);
    }

    return mapLibrary(library);
  }

  /**
   * The first stage of removing a library (FL-78): what goes, what stays, and a token bound to the
   * library as it is now. Confirming with a stale token is refused, so a removal is never confirmed
   * against consequences nobody saw.
   */
  async getRemovalReview(id: string): Promise<LibraryRemovalReviewDto> {
    const library = await this.findOrFail(id);
    const counts = await this.libraryRepository.getRemovalCounts(id);
    return {
      libraryId: library.id,
      name: library.name,
      ownerId: library.ownerId,
      photos: counts.photos,
      videos: counts.videos,
      total: counts.photos + counts.videos,
      usage: counts.usage,
      offline: counts.offline,
      albums: counts.albums,
      sharedLinks: counts.sharedLinks,
      faces: counts.faces,
      scanActive: false,
      originalsKept: true,
      reviewToken: this.removalToken(library, counts),
    };
  }

  /**
   * The second stage: the typed name and the review token are checked against the library as it is
   * now — its permission was checked again by the endpoint — and only then is it removed.
   */
  async remove(auth: AuthDto, id: string, dto: LibraryRemovalDto): Promise<void> {
    const library = await this.findOrFail(id);
    if (dto.confirmName !== library.name) {
      throw new BadRequestException('Type the library name to confirm');
    }

    const counts = await this.libraryRepository.getRemovalCounts(id);
    if (dto.reviewToken !== this.removalToken(library, counts)) {
      throw new ConflictException('The library changed after it was reviewed. Review the removal again.');
    }

    await this.delete(id, auth, counts.photos + counts.videos);
  }

  private removalToken(
    library: { id: string; updatedAt: Date; importPaths: string[]; exclusionPatterns: string[] },
    counts: LibraryRemovalCounts,
  ) {
    return createHash('sha256')
      .update(
        JSON.stringify({
          id: library.id,
          updatedAt: new Date(library.updatedAt).toISOString(),
          folders: libraryPathsFingerprint(library),
          counts,
        }),
      )
      .digest('hex')
      .slice(0, 48);
  }

  private async getNeighbours(id: string | undefined): Promise<ImportPathNeighbour[]> {
    const libraries = await this.libraryRepository.getAll(false);
    return libraries
      .filter((library) => library.id !== id)
      .map(({ id, name, importPaths }) => ({ id, name, importPaths }));
  }

  private async requireValidImportPaths(importPaths: string[], id?: string) {
    const checks = await checkImportPaths(this.storageRepository, importPaths, {
      neighbours: await this.getNeighbours(id),
    });
    for (const check of checks) {
      if (!check.isValid) {
        throw new BadRequestException(`Invalid import path: ${check.message}`);
      }
    }
  }

  private requireValidExclusionPatterns(patterns: string[]) {
    const invalid = invalidExclusionPatterns(patterns);
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid exclusion pattern: ${invalid[0]}`);
    }
  }

  /** Tell the worker that watches folders to read this library again (FL-78). */
  private async notifyWatchers(id: string) {
    this.websocketRepository.serverSend('LibraryWatchUpdate', { id });
    await this.onWatchUpdate({ id });
  }

  @OnEvent({ name: 'LibraryWatchUpdate', server: true, workers: [FrameleafWorker.Microservices] })
  async onWatchUpdate({ id }: ArgOf<'LibraryWatchUpdate'>) {
    if (!this.watchLibraries) {
      return;
    }

    const library = await this.libraryRepository.get(id);
    if (!library) {
      await this.unwatch(id);
      return;
    }

    await this.watch(id);
  }

  /**
   * Remove a library: its scan stops, its watcher closes, and its items are removed in the
   * background. The files in its folders are never touched: they were only ever referenced.
   */
  async delete(id: string, auth?: AuthDto, itemCount?: number) {
    const library = await this.findOrFail(id);

    await this.libraryRepository.softDelete(id);
    await this.eventRepository.emit('LibraryScanStop', { libraryId: id, reason: 'library_removed' });
    await this.notifyWatchers(id);
    await this.jobRepository.queue({ name: JobName.LibraryDelete, data: { id } });

    const counts = itemCount === undefined ? await this.libraryRepository.getRemovalCounts(id) : undefined;
    const count = itemCount ?? counts!.photos + counts!.videos;
    await this.recordAdminEvents([
      { ...libraryEvent(auth, library, AdminAuditAction.LibraryDeleted), detail: String(count) },
    ]);
  }

  @OnJob({ name: JobName.LibraryDelete, queue: QueueName.Library })
  async handleDeleteLibrary(job: JobOf<JobName.LibraryDelete>): Promise<JobStatus> {
    const libraryId = job.id;

    await this.assetRepository.updateByLibraryId(libraryId, { deletedAt: new Date() });

    this.logger.debug(`Will delete all assets in library ${libraryId}`);
    let hasAssets = false;
    for await (const assets of batched(
      this.libraryRepository.streamAssetIds(libraryId),
      JOBS_LIBRARY_PAGINATION_SIZE,
    )) {
      this.logger.debug(`Queueing deletion of ${assets.length} asset(s) in library ${libraryId}`);
      await this.jobRepository.queueAll(
        assets.map((asset) => ({ name: JobName.AssetDelete, data: { id: asset.id, deleteOnDisk: false } })),
      );
      hasAssets = true;
    }

    if (!hasAssets) {
      this.logger.log(`Deleting library ${libraryId}`);
      await this.libraryRepository.delete(libraryId);
    }

    return JobStatus.Success;
  }

  async queuePostSyncJobs(assetIds: string[]) {
    this.logger.debug(`Queuing sidecar discovery for ${assetIds.length} asset(s)`);

    // We queue a sidecar discovery which, in turn, queues metadata extraction
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.SidecarCheck,
        data: { id: assetId, source: 'upload' },
      })),
    );
  }

  /**
   * Files the watcher saw disappear (FL-78). Each item goes offline — into the trash, back when its
   * file returns — exactly as a scan marks it; it is never removed outright, so its albums, faces,
   * descriptions and edits stay with it. And only when its folder is demonstrably still there: an
   * unmounted share makes every file "disappear" at once, and that is not a deletion.
   */
  @OnJob({ name: JobName.LibraryRemoveAsset, queue: QueueName.Library })
  async handleAssetRemoval(job: JobOf<JobName.LibraryRemoveAsset>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    if (!library) {
      return JobStatus.Skipped;
    }

    const roots = library.importPaths.map((importPath) => normalizeImportPath(importPath));
    const offline: string[] = [];
    const trashedOffline: string[] = [];

    for (const assetPath of job.paths) {
      const root = roots.find((candidate) => isSameOrInside(assetPath, candidate));
      if (!root || !(await checkImportPathOnDisk(this.storageRepository, root)).isValid) {
        this.logger.warn(`Ignoring removal of ${assetPath} in library ${library.id}: its import folder is unavailable`);
        continue;
      }

      if (await this.storageRepository.checkFileExists(assetPath)) {
        continue;
      }

      const asset = await this.assetRepository.getByLibraryIdAndOriginalPath(library.id, assetPath);
      if (!asset || asset.isOffline) {
        continue;
      }

      (asset.deletedAt ? trashedOffline : offline).push(asset.id);
    }

    if (offline.length > 0) {
      await this.assetRepository.updateAll(offline, { isOffline: true, deletedAt: new Date() });
    }
    if (trashedOffline.length > 0) {
      await this.assetRepository.updateAll(trashedOffline, { isOffline: true });
    }

    return JobStatus.Success;
  }

  private findOrFail(id: string) {
    return findOrFail(() => this.libraryRepository.get(id), 'Library');
  }
}
