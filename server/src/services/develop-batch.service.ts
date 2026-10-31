import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import {
  DevelopBatchConfirmDto,
  DevelopBatchCreateDto,
  DevelopBatchImportDto,
  DevelopBatchMatchDto,
  DevelopBatchResponseDto,
} from 'src/dtos/develop-batch.dto.js';
import { AssetType, AssetVisibility, FrameleafWorker, JobName, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DevelopBatchRepository } from 'src/repositories/develop-batch.repository.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetDevelopService, developImportStagingFolder } from 'src/services/asset-develop.service.js';
import { checkAccess, requireAccess } from 'src/utils/access.js';
import { batchExportName, matchBatchReturns } from 'src/utils/develop-batch.js';
import { lockedViewerOf } from 'src/utils/file.js';
import {
  LockedKeyUnavailableError,
  assertLockedReadable,
  isLockedPath,
  lockedKeyHttpException,
  openLockedRead,
} from 'src/utils/locked-read.js';

export const batchStagingFolder = (ownerId: string, batchId: string) =>
  path.join(developImportStagingFolder(ownerId), 'batches', batchId);
@Injectable()
export class DevelopBatchService {
  constructor(
    private repository: DevelopBatchRepository,
    private develop: AssetDevelopService,
    private revisions: AssetDevelopRepository,
    private assets: AssetRepository,
    private access: AccessRepository,
    private crypto: CryptoRepository,
    private storage: StorageRepository,
    private downloads: DownloadRepository,
    private jobs: JobRepository,
  ) {}
  async create(auth: AuthDto, dto: DevelopBatchCreateDto) {
    const ids = [...new Set(dto.assetIds)];
    await requireAccess(this.access, { auth, permission: Permission.AssetEditCreate, ids });
    const assets = await this.assets.getByIds(ids);
    if (
      assets.length !== ids.length ||
      assets.some(
        (asset) =>
          asset.ownerId !== auth.user.id ||
          asset.type !== AssetType.Image ||
          asset.deletedAt ||
          asset.isOffline ||
          asset.visibility === AssetVisibility.Hidden,
      )
    )
      throw new BadRequestException('Choose available still photos that you own');
    const items = assets.map((asset) => {
      const id = randomUUID();
      return {
        id,
        assetId: asset.id,
        fileName: asset.originalFileName,
        exportName: batchExportName(asset.originalFileName, id),
      };
    });
    const id = await this.repository.create(auth.user.id, dto.includeSidecars, items);
    return this.get(auth, id);
  }
  async prepare(auth: AuthDto, id: string, itemId: string) {
    await this.repository.requireOpen(auth.user.id, id);
    const batch = await this.repository.get(auth.user.id, id, itemId),
      item = batch.items[0];
    if (!item?.assetId) throw new NotFoundException('Editing batch item not found');
    await this.requireAsset(auth, item.assetId);
    try {
      const exported = await this.develop.createExport(auth, item.assetId, item.id);
      const sidecars = await this.downloads.getSidecars([item.assetId]);
      const hasSidecar = sidecars.length > 0 && (await this.storage.checkFileExists(sidecars[0].path));
      await this.repository.prepared(auth.user.id, id, itemId, exported, hasSidecar);
    } catch (error) {
      await this.repository.preparationFailed(
        id,
        itemId,
        error instanceof ConflictException ? 'source_changed' : 'export_failed',
      );
      throw error;
    }
    return this.getItem(auth, id, itemId);
  }
  async list(auth: AuthDto, cursor?: string) {
    return this.repository.list(auth.user.id, cursor);
  }
  async get(auth: AuthDto, id: string): Promise<DevelopBatchResponseDto & { includeSidecars: boolean }> {
    const batch = await this.repository.get(auth.user.id, id);
    const ids = batch.items.flatMap((item) => (item.assetId ? [item.assetId] : []));
    const [allowed, assets] = await Promise.all([
      checkAccess(this.access, { auth, permission: Permission.AssetEditCreate, ids }),
      this.assets.getByIds(ids),
    ]);
    const eligible = new Set(
      assets
        .filter(
          (asset) =>
            asset.ownerId === auth.user.id &&
            asset.type === AssetType.Image &&
            !asset.deletedAt &&
            !asset.isOffline &&
            asset.visibility !== AssetVisibility.Hidden,
        )
        .map((asset) => asset.id),
    );
    const items = batch.items.map((item) =>
      item.assetId && allowed.has(item.assetId) && eligible.has(item.assetId)
        ? item
        : {
            ...item,
            available: false,
            preparationStatus: 'unavailable' as const,
            assetId: null,
            exportId: null,
            fileName: null,
            exportName: null,
            sourceChecksum: null,
            hasSidecar: false,
            error: null,
            errorCode: 'source_unavailable',
            returns: [],
          },
    );
    return { ...batch, items };
  }
  private async getItem(auth: AuthDto, id: string, itemId: string) {
    const batch = await this.repository.get(auth.user.id, id, itemId);
    const item = batch.items[0];
    if (!item?.assetId) throw new NotFoundException('Editing batch item not found');
    await this.requireAsset(auth, item.assetId);
    return item;
  }
  async manifest(auth: AuthDto, id: string) {
    const batch = await this.get(auth, id);
    return this.batchManifest(batch);
  }
  async download(auth: AuthDto, id: string) {
    const batch = await this.get(auth, id);
    await this.repository.requireOpen(auth.user.id, id);
    if (batch.items.some((item) => item.available && item.preparationStatus === 'pending'))
      throw new ConflictException('Prepare the available originals before downloading this batch');
    const manifest = this.batchManifest(batch);
    if (manifest.items.length === 0) throw new ConflictException('This batch has no available prepared originals');
    // FL-721: a sealed original needs the downloader's key; refused (423) before the archive starts
    for (const item of batch.items) {
      if (!item.available || item.preparationStatus !== 'prepared') continue;
      const asset = await this.requireAsset(auth, item.assetId!);
      await this.assertPlainReadable(asset.originalPath, auth);
    }
    const zip = this.storage.createZipStream();
    const streams: Readable[] = [];
    zip.addFile(Buffer.from(JSON.stringify(manifest, null, 2)), 'frameleaf-roundtrip.json');
    for (const item of batch.items) {
      if (!item.available || item.preparationStatus !== 'prepared') continue;
      const original = Readable.from(this.openEntry(auth, id, item, false));
      streams.push(original);
      original.on('error', (error) => zip.stream.destroy(error));
      zip.addFile(original, item.exportName!);
      if (batch.includeSidecars && item.hasSidecar) {
        const sidecar = Readable.from(this.openEntry(auth, id, item, true));
        streams.push(sidecar);
        sidecar.on('error', (error) => zip.stream.destroy(error));
        zip.addFile(sidecar, `${item.exportName}.xmp`);
      }
    }
    zip.stream.once('close', () => {
      for (const stream of streams) stream.destroy();
    });
    void zip.finalize().catch((error) => zip.stream.destroy(error));
    return zip.stream;
  }
  private batchManifest(batch: DevelopBatchResponseDto & { includeSidecars: boolean }) {
    return {
      version: 1 as const,
      batchId: batch.id,
      items: batch.items
        .filter((item) => item.available && item.preparationStatus === 'prepared')
        .map((item) => ({
          id: item.id,
          assetId: item.assetId,
          exportId: item.exportId,
          fileName: item.fileName,
          exportName: item.exportName,
          sourceChecksum: item.sourceChecksum,
          hasSidecar: batch.includeSidecars && item.hasSidecar,
        })),
      skipped: batch.items
        .filter((item) => !item.available || item.preparationStatus !== 'prepared')
        .map((item) => ({
          itemId: item.id,
          reason: item.errorCode ?? (item.available ? 'export_not_prepared' : 'source_unavailable'),
        })),
    };
  }
  private async *openEntry(
    auth: AuthDto,
    id: string,
    item: DevelopBatchResponseDto['items'][number],
    sidecar: boolean,
  ): AsyncGenerator<Buffer> {
    await this.repository.requireOpen(auth.user.id, id);
    auth = await this.liveAuth(auth, Permission.AssetDownload);
    const asset = await this.requireAsset(auth, item.assetId!);
    await requireAccess(this.access, { auth, permission: Permission.AssetDownload, ids: [asset.id] });
    if ((await this.plainChecksum(asset.originalPath, auth)).toString('hex') !== item.sourceChecksum)
      throw new ConflictException('An original changed after export preparation');
    let source = asset.originalPath;
    if (sidecar) {
      const associated = await this.downloads.getSidecars([asset.id]);
      if (!associated[0]) throw new ConflictException('The associated sidecar is no longer available');
      source = associated[0].path;
    }
    const stream = await this.openPlain(source, auth);
    let nextCheck = Date.now() + 500;
    try {
      for await (const bytes of stream) {
        if (Date.now() >= nextCheck) {
          await this.repository.requireOpen(auth.user.id, id);
          auth = await this.liveAuth(auth, Permission.AssetDownload);
          await this.requireAsset(auth, asset.id);
          await requireAccess(this.access, { auth, permission: Permission.AssetDownload, ids: [asset.id] });
          nextCheck = Date.now() + 500;
        }
        yield Buffer.from(bytes);
      }
    } finally {
      stream.destroy();
    }
  }
  /**
   * FL-721 (spec §8.1): the bytes of a file that may be a sealed Locked file, decrypted for the person
   * downloading it (their own key, or one they were granted). A plain file is read as it is.
   */
  private async openPlain(file: string, auth: AuthDto): Promise<Readable> {
    if (!(await isLockedPath(file))) {
      return this.storage.createPlainReadStream(file);
    }
    const viewerId = lockedViewerOf(auth);
    if (viewerId === undefined) {
      throw new LockedKeyUnavailableError([]);
    }
    return (await openLockedRead(file, viewerId)).stream as Readable;
  }

  /** The SHA-256 of the plaintext: what the export recorded, also when the original is sealed since. */
  private async plainChecksum(file: string, auth: AuthDto): Promise<Buffer> {
    if (!(await isLockedPath(file))) {
      return this.crypto.hashFile(file, 'sha256');
    }
    const hash = createHash('sha256');
    const stream = await this.openPlain(file, auth);
    try {
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        hash.update(chunk);
      }
    } finally {
      stream.destroy();
    }
    return hash.digest();
  }

  private async assertPlainReadable(file: string, auth: AuthDto): Promise<void> {
    if (!(await isLockedPath(file))) {
      return;
    }
    const viewerId = lockedViewerOf(auth);
    try {
      if (viewerId === undefined) {
        throw new LockedKeyUnavailableError([]);
      }
      await assertLockedReadable(file, viewerId);
    } catch (error) {
      throw error instanceof LockedKeyUnavailableError ? lockedKeyHttpException() : error;
    }
  }

  private async liveAuth(auth: AuthDto, permission: Permission): Promise<AuthDto> {
    const elevated = await this.repository.liveGrant(
      auth.user.id,
      auth.session?.id ?? null,
      auth.apiKey?.id ?? null,
      permission,
    );
    if (elevated === null) throw new ForbiddenException('The credential grant is no longer available');
    return auth.session ? { ...auth, session: { ...auth.session, hasElevatedPermission: elevated } } : auth;
  }
  async match(auth: AuthDto, id: string, dto: DevelopBatchMatchDto) {
    const batch = await this.get(auth, id);
    return matchBatchReturns(
      batch.items.filter(
        (item): item is typeof item & { exportId: string; fileName: string; exportName: string } =>
          item.available &&
          item.preparationStatus === 'prepared' &&
          !!item.exportId &&
          !!item.fileName &&
          !!item.exportName,
      ),
      dto.files,
    );
  }
  async confirm(auth: AuthDto, id: string, dto: DevelopBatchConfirmDto) {
    auth = await this.liveAuth(auth, Permission.AssetEditCreate);
    const matches = await this.match(auth, id, dto);
    if (matches.some((row) => row.status !== 'matched'))
      throw new BadRequestException('Choose one batch photo for each returned file before confirming');
    await this.repository.confirm(
      auth.user.id,
      id,
      auth.session?.id ?? null,
      auth.apiKey?.id ?? null,
      dto.files.map((file) => ({ itemId: file.itemId, checksum: file.checksum })),
    );
    return this.get(auth, id);
  }
  async import(
    auth: AuthDto,
    id: string,
    itemId: string,
    dto: DevelopBatchImportDto,
    file: Express.Multer.File | undefined,
  ) {
    try {
      const batch = await this.repository.get(auth.user.id, id, itemId);
      if (batch.status === 'cancelled') throw new ConflictException('This batch was cancelled');
      const item = batch.items[0];
      if (item?.assetId) await this.requireAsset(auth, item.assetId);
      const returned = item?.returns.find(
        (r) => r.confirmationId === dto.confirmationId && r.checksum === dto.renditionChecksum,
      );
      if (!item?.assetId || !item.exportId || !returned)
        throw new NotFoundException('Confirmed returned file not found');
      if (file && (await this.crypto.hashFile(file.path, 'sha256')).toString('hex') !== returned.checksum)
        throw new BadRequestException({
          message: 'The file did not arrive intact; try again',
          code: 'transfer_checksum',
        });
      if (returned.revisionId) {
        const revision = await this.revisions.get(returned.revisionId);
        if (!revision) throw new ConflictException('The imported version is no longer available');

        if ([AssetDevelopRevisionStatus.Failed, AssetDevelopRevisionStatus.Saved].includes(revision.status)) {
          if (!revision.masterPath)
            throw new ConflictException('This version no longer has a usable master; review a corrected file');
          await this.develop.render(auth, item.assetId, revision.id);
        }
        return this.getItem(auth, id, itemId);
      }
      await this.develop.importRendition(
        auth,
        item.assetId,
        { exportId: item.exportId, renditionChecksum: returned.checksum },
        file,
        {
          batchId: id,
          itemId,
          confirmationId: dto.confirmationId,
          checksum: returned.checksum,
          bytes: file?.size ?? 0,
        },
      );
      return this.getItem(auth, id, itemId);
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code =
        response && typeof response === 'object' && 'code' in response && typeof response.code === 'string'
          ? response.code
          : error instanceof ConflictException
            ? 'source_changed'
            : error instanceof ForbiddenException || error instanceof NotFoundException
              ? 'source_unavailable'
              : 'import_rejected';
      await this.repository.fail(auth.user.id, id, itemId, dto.confirmationId, code);
      throw error;
    } finally {
      if (file?.path) await rm(file.path, { force: true });
    }
  }
  async cancel(auth: AuthDto, id: string) {
    await this.repository.get(auth.user.id, id);
    const { revisionIds } = await this.repository.cancel(auth.user.id, id);
    await this.repository.cleanupPendingMasters((target) => rm(target, { force: true }), id);
    for (const revisionId of revisionIds) {
      const revision = await this.revisions.get(revisionId);
      if (!revision || revision.status === AssetDevelopRevisionStatus.Rendered) continue;
      const master = await this.revisions.releaseBatchMaster(revisionId);
      if (master) await rm(master, { force: true });
    }
    // A live upload that reaches the service after cancellation is refused and its finally removes it too.
    await rm(batchStagingFolder(auth.user.id, id), { recursive: true, force: true });
    return this.get(auth, id);
  }
  private async requireAsset(auth: AuthDto, id: string) {
    await requireAccess(this.access, { auth, permission: Permission.AssetEditCreate, ids: [id] });
    const asset = await this.assets.getById(id, { exifInfo: true });
    if (!asset || asset.ownerId !== auth.user.id) throw new NotFoundException('Photo not found');
    if (
      asset.deletedAt ||
      asset.isOffline ||
      asset.visibility === AssetVisibility.Hidden ||
      asset.type !== AssetType.Image
    )
      throw new BadRequestException('Choose an available still photo');
    return asset;
  }
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async recover() {
    // Revision insertion and return association commit together. Recover only saved (pre-queue) rows;
    // queued/running previews already belong to the existing durable render recovery.
    const recovered = await this.revisions.recoverBatchImports();
    if (recovered.length > 0)
      await this.jobs.queueAll(recovered.map(({ id }) => ({ name: JobName.AssetDevelopRender, data: { id } })));
    await this.cleanupStaging();
  }
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async cleanupStaging() {
    await this.repository.cleanupPendingMasters((target) => rm(target, { force: true }));
    for (const { id } of await this.repository.listOwners()) {
      const root = path.join(developImportStagingFolder(id), 'batches');
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !/[\da-f-]{36}/.test(entry.name)) continue;
        const folder = path.join(root, entry.name);
        for (const file of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
          if (!file.isFile() || !file.name.endsWith('.partial')) continue;
          const target = path.join(folder, file.name);
          if ((await stat(target)).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await rm(target, { force: true });
        }
      }
    }
  }
}
