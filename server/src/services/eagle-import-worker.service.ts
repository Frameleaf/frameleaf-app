import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Selectable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { EagleImportRecent, EagleImportTable } from 'src/schema/tables/eagle-import.table.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { FrameleafWorker, LibraryScope, StorageFolder } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EagleImportRepository } from 'src/repositories/eagle-import.repository.js';
import { EagleLibraryRepository } from 'src/repositories/eagle-library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetSourceService } from 'src/services/asset-source.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { EagleImportService, eagleServerSupported } from 'src/services/eagle-import.service.js';
import { TagService } from 'src/services/tag.service.js';
import {
  EAGLE_DEFAULT_COLLECTION,
  type EagleServerItem,
  type EagleServerLibrary,
  type EagleTarget,
  eagleAddedDate,
  eagleColour,
  eagleFileName,
  eagleFolders,
  eagleSourceUrl,
  isComing,
  topFolderNames,
} from 'src/utils/eagle-library.js';

export const EAGLE_IMPORT_TICK_MS = 5000;
export const EAGLE_IMPORT_LEASE_MS = 2 * 60_000;
const TAG_BATCH = 100;
const RECENT = 3;
const NIL_UUID = /^0{8}-(?:0{4}-){3}0{12}$/;

type EagleImportRow = Selectable<EagleImportTable>;

/** An item that can't come over this time; the import carries on with the next. */
class EagleItemError extends Error {}

/** The run lost its lease or the server is restarting: stop without ending the import. */
class EagleRunReleased extends Error {}

interface EagleRun {
  row: EagleImportRow;
  auth: AuthDto;
  library: EagleServerLibrary;
  target: EagleTarget;
  albums: Record<string, string>;
  tagIds: Record<string, string>;
  rootAlbumId: string | null;
  failed: Set<string>;
  recent: EagleImportRecent[];
  collectionNames: Map<string, string>;
  stopRequested: boolean;
  signal: AbortSignal;
}

/**
 * FL-653: the server's Eagle import, for a library in a folder the server can open. It does what
 * the browser importer does (`web/src/lib/frameleaf/eagle/eagle-import-run.svelte.ts`), with the same
 * mapping (`src/utils/eagle-library.ts`), so it keeps going with the tab and the browser closed:
 *
 * - Collections first, parents before children, then the tags, then each item: its file is copied
 *   into the library and created through the ordinary upload path, so a file already in the library
 *   is found by its contents and not stored twice. It is then filed, tagged, rated, given its note,
 *   its web address as Source › Page, and the date it was last changed in Eagle as its Added date.
 * - Every collection, tag and item is recorded as it is done, so Stop (or a restart) keeps
 *   everything brought over and carrying on never brings anything over twice.
 * - The Eagle library is only read; its files are copied, never moved or changed.
 * - One worker holds an import at a time, under a lease it renews before every item.
 */
@Injectable()
export class EagleImportWorkerService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private running?: AbortController;
  private stopping = false;
  private readonly workerId = `eagle-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private repository: EagleImportRepository,
    private libraries: EagleLibraryRepository,
    private staging: TakeoutStagingRepository,
    private users: UserRepository,
    private config: ConfigRepository,
    private assetRepository: AssetRepository,
    private assetMedia: AssetMediaService,
    private assets: AssetService,
    private albums: AlbumService,
    private tags: TagService,
    private sources: AssetSourceService,
    private imports: EagleImportService,
  ) {
    this.logger.setContext(EagleImportWorkerService.name);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), EAGLE_IMPORT_TICK_MS);
    this.tick();
  }

  /** Stop taking work and let the import in hand go at the item it reached. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    this.running?.abort(new EagleRunReleased('The server is restarting'));
    await this.active;
  }

  /** Never overlaps itself: a tick that finds work in hand does nothing. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Eagle import worker failed: ${String(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain(): Promise<void> {
    while (!this.stopping) {
      const row = await this.repository.claim(this.workerId, EAGLE_IMPORT_LEASE_MS);
      if (!row) {
        return;
      }
      await this.run(row);
    }
  }

  /** Carries one claimed import on from wherever its records say it has got to. */
  async run(row: EagleImportRow): Promise<void> {
    if (row.status === 'stopping') {
      await this.repository.finish(row.id, this.workerId, 'stopped');
      return;
    }
    const controller = new AbortController();
    this.running = controller;
    try {
      const run = await this.prepare(row, controller.signal);
      await this.makeCollections(run);
      const done = new Set((await this.repository.outcomes(row.id)).map(({ itemId }) => itemId));
      const supported = eagleServerSupported();
      const remaining = run.library.items.filter((item) => isComing(item, supported) && !done.has(item.id));
      await this.makeTags(run, remaining);
      for (const item of remaining) {
        if (!(await this.stillCurrent(run))) {
          break;
        }
        await this.importItem(run, item);
      }
      await this.repository.save(row.id, this.workerId, {
        failed: [...run.failed],
        recent: run.recent,
      });
      await this.repository.finish(row.id, this.workerId, run.stopRequested ? 'stopped' : 'finished');
    } catch (error) {
      if (error instanceof EagleRunReleased || controller.signal.aborted) {
        await this.repository.release(row.id, this.workerId);
        return;
      }
      const message = error instanceof EagleItemError ? error.message : 'The import stopped because of an error';
      this.logger.warn(`Eagle import ${row.id} stopped: ${String(error)}`);
      await this.repository.finish(row.id, this.workerId, 'stopped', message);
    } finally {
      if (this.running === controller) {
        this.running = undefined;
      }
    }
  }

  /** Who the import acts for, and the library as it is now. The library must still be the same one. */
  private async prepare(row: EagleImportRow, signal: AbortSignal): Promise<EagleRun> {
    const auth = await this.authFor(row.ownerId);
    if (!auth) {
      throw new EagleItemError('The account that started this import is gone');
    }
    if (!(await this.staging.isInsideRoots(row.libraryPath, this.config.getEnv().storage.importRoots))) {
      throw new EagleItemError('This folder is no longer one the server may import from');
    }
    const library = await this.imports.read(row.libraryPath).catch(() => {
      throw new EagleItemError('The library can’t be read now. Check that the folder is still there.');
    });
    if (library.fingerprint !== row.fingerprint) {
      throw new EagleItemError('This library changed since it was checked. Check it again to carry on.');
    }
    const supported = eagleServerSupported();
    const total = library.items.filter((item) => isComing(item, supported)).length;
    await this.repository.save(row.id, this.workerId, { total });
    const target = this.targetOf(row);
    return {
      row,
      auth,
      library,
      target,
      albums: { ...row.albums },
      tagIds: { ...row.tagIds },
      rootAlbumId: target.mode === 'inside' && target.inside !== 'new' ? target.inside : row.rootAlbumId,
      failed: new Set(row.failed),
      recent: [...row.recent],
      collectionNames: new Map(),
      stopRequested: false,
      signal,
    };
  }

  private targetOf(row: EagleImportRow): EagleTarget {
    const target = row.target as { mode?: unknown; inside?: unknown };
    return target.mode === 'top'
      ? { mode: 'top' }
      : { mode: 'inside', inside: typeof target.inside === 'string' ? target.inside : 'new' };
  }

  /** Keeps the lease; false once Stop was pressed. Throws when another worker has the import now. */
  private async stillCurrent(run: EagleRun) {
    if (run.signal.aborted || this.stopping) {
      throw new EagleRunReleased('The server is restarting');
    }
    const status = await this.repository.renew(run.row.id, this.workerId, EAGLE_IMPORT_LEASE_MS);
    if (!status) {
      throw new EagleRunReleased('Another worker has this import');
    }
    if (status === 'stopping' || status === 'stopped') {
      run.stopRequested = true;
    }
    return !run.stopRequested;
  }

  private async makeCollections(run: EagleRun) {
    const { library, target, auth } = run;
    if (target.mode === 'inside') {
      if (target.inside === 'new' && !run.rootAlbumId) {
        const album = await this.albums.create(auth, {
          albumName: EAGLE_DEFAULT_COLLECTION,
          libraryScope: LibraryScope.Design,
        });
        run.rootAlbumId = album.id;
        await this.repository.save(run.row.id, this.workerId, { rootAlbumId: album.id });
      }
      run.collectionNames.set('', target.inside === 'new' ? EAGLE_DEFAULT_COLLECTION : '');
    }
    const topNames = topFolderNames(library.folders, target, run.row.existingTop);
    for (const folder of eagleFolders(library.folders)) {
      const name = folder.parent ? folder.name : (topNames.get(folder.id) ?? folder.name);
      run.collectionNames.set(folder.id, name);
      if (Object.hasOwn(run.albums, folder.id)) {
        continue;
      }
      if (!(await this.stillCurrent(run))) {
        return;
      }
      const parentId = folder.parent ? run.albums[folder.parent] : (run.rootAlbumId ?? undefined);
      const colour = eagleColour(folder.color);
      const album = await this.albums.create(auth, {
        albumName: name,
        libraryScope: LibraryScope.Design,
        ...(parentId && { parentId }),
        ...(colour && { color: colour }),
        ...(folder.description && { description: folder.description }),
      });
      run.albums[folder.id] = album.id;
      await this.repository.save(run.row.id, this.workerId, { albums: run.albums });
    }
  }

  private async makeTags(run: EagleRun, items: EagleServerItem[]) {
    const missing = [...new Set(items.flatMap(({ tags }) => tags))].filter((name) => !Object.hasOwn(run.tagIds, name));
    for (let index = 0; index < missing.length; index += TAG_BATCH) {
      if (!(await this.stillCurrent(run))) {
        return;
      }
      const batch = missing.slice(index, index + TAG_BATCH);
      const wanted = new Set(batch);
      for (const tag of await this.tags.upsert(run.auth, { tags: batch })) {
        if (wanted.has(tag.value)) {
          run.tagIds[tag.value] = tag.id;
        }
      }
      await this.repository.save(run.row.id, this.workerId, { tagIds: run.tagIds });
    }
  }

  /** One item: copied in, created, filed, tagged and described, then recorded. */
  private async importItem(run: EagleRun, item: EagleServerItem) {
    const { auth, row } = run;
    try {
      const { assetId, created } = await this.createAsset(run, item);
      const filed = item.folders.filter((id) => run.albums[id]);
      const albumIds = filed.map((id) => run.albums[id]);
      if (albumIds.length === 0 && run.target.mode === 'inside' && run.rootAlbumId) {
        albumIds.push(run.rootAlbumId);
      }
      if (albumIds.length > 0) {
        await this.albums.addAssetsToAlbums(auth, { albumIds, assetIds: [assetId] });
      }
      const tagIds = item.tags.map((name) => run.tagIds[name]).filter(Boolean);
      if (tagIds.length > 0) {
        await this.tags.bulkTagAssets(auth, { assetIds: [assetId], tagIds });
      }
      await this.describe(run, item, assetId, created);
      const pageUrl = eagleSourceUrl(item);
      if (pageUrl) {
        await this.sources.addImported(auth, assetId, { importedFrom: 'eagle', pageUrl });
      }
      await this.repository.addOutcome(row.id, item.id, assetId, !created);
      run.failed.delete(item.id);
      const names = filed.length > 0 ? filed : run.target.mode === 'inside' ? [''] : [];
      run.recent = [
        {
          id: item.id,
          name: eagleFileName(item),
          duplicate: !created,
          collections: names.map((id) => run.collectionNames.get(id) ?? '').filter(Boolean),
        },
        ...run.recent,
      ].slice(0, RECENT);
      await this.repository.save(row.id, this.workerId, { failed: [...run.failed], recent: run.recent });
    } catch (error) {
      if (error instanceof EagleRunReleased || run.signal.aborted) {
        throw error;
      }
      this.logger.warn(`Eagle import ${row.id}: item ${item.id} could not be brought over: ${String(error)}`);
      run.failed.add(item.id);
      await this.repository.save(row.id, this.workerId, { failed: [...run.failed] });
    }
  }

  /**
   * Copies the file into the library and creates its asset through the ordinary upload path, which
   * finds a file already in the library by its contents; then the copy is removed again.
   */
  private async createAsset(run: EagleRun, item: EagleServerItem): Promise<{ assetId: string; created: boolean }> {
    const { auth, row } = run;
    const source = this.libraries.itemFilePath(row.libraryPath, item.id, item.fileName!);
    const file = await this.libraries.statFile(source);
    if (!file) {
      throw new EagleItemError('The file is not in the library folder');
    }
    const extension = path.extname(item.fileName!).toLowerCase();
    const destination = StorageCore.getNestedPath(StorageFolder.Upload, row.ownerId, `${randomUUID()}${extension}`);
    const digest = await this.staging.copyToLibrary(source, file.size, destination, run.signal, () =>
      Promise.resolve(),
    );
    const name = eagleFileName(item);
    const response = await this.assetMedia.uploadAsset(
      auth,
      {
        filename: name,
        fileCreatedAt: file.modifiedAt,
        fileModifiedAt: file.modifiedAt,
        libraryScope: LibraryScope.Design,
      },
      {
        uuid: randomUUID(),
        checksum: digest.checksum,
        legacyChecksum: digest.legacyChecksum,
        originalPath: destination,
        originalName: name,
        size: digest.size,
      },
    );
    if (response.status === AssetMediaStatus.DUPLICATE && NIL_UUID.test(response.id)) {
      throw new EagleItemError('A matching file is in the library but can’t be reached');
    }
    const created = response.status === AssetMediaStatus.CREATED;
    if (created) {
      // Counted now, so the account's storage limit applies to the rest of this run.
      auth.user.quotaUsageInBytes += digest.size;
    }
    return { assetId: response.id, created };
  }

  /**
   * Rating, note and Added date, as the browser import sets them. An item that was already in the
   * library keeps a rating or note it has, and keeps its Added date unless this import brought it in.
   */
  private async describe(run: EagleRun, item: EagleServerItem, assetId: string, created: boolean) {
    const note = item.annotation.trim();
    const addedAt = eagleAddedDate(item);
    if (item.star <= 0 && !note && !addedAt) {
      return;
    }
    const current = created ? undefined : await this.assetRepository.getById(assetId, { exifInfo: true });
    const changes = {
      ...(item.star > 0 && !current?.exifInfo?.rating && { rating: item.star }),
      ...(note && !current?.exifInfo?.description?.trim() && { description: note }),
    };
    if (Object.keys(changes).length > 0) {
      await this.assets.update(run.auth, assetId, changes);
    }
    const addedOn = current ? new Date(current.createdAt).getTime() : Date.now();
    const broughtIn = created || addedOn >= new Date(run.row.createdAt).getTime();
    if (addedAt && broughtIn && addedOn > addedAt.getTime()) {
      // Best effort, as in the browser: the item still comes over with the date it arrived.
      await this.sources.setAddedDate(run.auth, assetId, { addedAt: addedAt.toISOString() }).catch((error: unknown) => {
        this.logger.debug(`Eagle import: Added date kept for ${assetId}: ${String(error)}`);
      });
    }
  }

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
        uploadsPaused: user.uploadsPaused,
      },
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }
}
