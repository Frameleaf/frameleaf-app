import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UploadFile } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { ImmichWorker, Permission, StorageFolder } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import {
  type AssetUploadResource,
  AssetUploadResourceRepository,
} from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { requireAccess, requireUploadAccess } from 'src/utils/access.js';
import {
  assembleAssetUploadParts,
  parseAssetUploadHeaders,
  writeAssetUploadPart,
} from 'src/utils/asset-upload-resource.js';
import { getFilenameExtension } from 'src/utils/file.js';

export type NativeAssetUploadResult = { id: string; status: AssetMediaStatus; sha256: string };

@Injectable()
export class AssetUploadResourceService {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;

  constructor(
    private uploads: AssetUploadResourceRepository,
    private media: AssetMediaService,
    private assets: AssetRepository,
    private access: AccessRepository,
    private storage: StorageRepository,
    private physical: PhysicalFileRepository,
    private logger: LoggingRepository,
    private rateLimits: RateLimitRepository,
  ) {}

  private folder(id: string) {
    return join(StorageCore.getBaseFolder(StorageFolder.Upload), '.resumable', id);
  }

  private async owner(auth: AuthDto) {
    requireUploadAccess(auth);
    if (auth.sharedLink) {
      throw new NotFoundException('Upload unavailable');
    }
    await requireAccess(this.access, { auth, permission: Permission.AssetUpload, ids: [auth.user.id] });
    return auth.user.id;
  }

  private file(resource: AssetUploadResource): UploadFile {
    if (!resource.finalPath || !resource.verifiedChecksum || !resource.legacyChecksum) {
      throw new ConflictException('Upload is not verified');
    }
    return {
      uuid: resource.id,
      originalPath: resource.finalPath,
      originalName: resource.metadata.filename!,
      size: resource.offset,
      checksum: resource.verifiedChecksum,
      legacyChecksum: resource.legacyChecksum,
    };
  }

  private metadata(resource: AssetUploadResource) {
    return {
      ...resource.metadata,
      fileCreatedAt: new Date(resource.metadata.fileCreatedAt),
      fileModifiedAt: new Date(resource.metadata.fileModifiedAt),
    };
  }

  async create(
    auth: AuthDto,
    headers: IncomingHttpHeaders,
    input: Readable,
    resume: (resource: AssetUploadResource) => void,
  ) {
    const ownerId = await this.owner(auth);
    const parsed = parseAssetUploadHeaders(headers);
    const id = randomUUID();
    this.media.canUploadFile({
      auth,
      fieldName: UploadFieldName.ASSET_DATA,
      file: {
        uuid: id,
        checksum: parsed.checksum,
        originalPath: parsed.metadata.filename!,
        originalName: parsed.metadata.filename!,
        size: parsed.size ?? 0,
      },
      body: { ...parsed.metadata },
    });
    // The committed resource exists before its URI is sent, including on an interrupted POST.
    const resource = await this.uploads.create(id, ownerId, parsed);
    resume(resource);
    return this.receive(auth, resource.id, input, 0, parsed.complete, parsed.size);
  }

  async head(auth: AuthDto, id: string) {
    return this.uploads.get(id, await this.owner(auth));
  }

  async append(auth: AuthDto, id: string, headers: IncomingHttpHeaders, input: Readable) {
    await this.owner(auth);
    if (
      headers['upload-draft-interop-version'] !== '9' ||
      headers['content-type'] !== 'application/partial-upload' ||
      (headers['content-encoding'] && headers['content-encoding'] !== 'identity') ||
      headers['asset-metadata']
    ) {
      throw new BadRequestException('Unsupported upload append headers');
    }
    const offset = headers['upload-offset'];
    const complete = headers['upload-complete'];
    const length = headers['upload-length'];
    if (
      typeof offset !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(offset) ||
      !Number.isSafeInteger(Number(offset)) ||
      (complete !== '?0' && complete !== '?1') ||
      (length !== undefined &&
        (typeof length !== 'string' || !/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length))))
    ) {
      throw new BadRequestException('Invalid upload offset, completion or length');
    }
    const current = await this.head(auth, id);
    if (
      headers['repr-digest'] !== undefined &&
      headers['repr-digest'] !== `sha-256=:${current.expectedChecksum.toString('base64')}:`
    ) {
      throw new BadRequestException('Upload digest cannot change');
    }
    return this.receive(
      auth,
      id,
      input,
      Number(offset),
      complete === '?1',
      length === undefined ? undefined : Number(length),
    );
  }

  private async withStreamAdmission<T>(
    auth: AuthDto,
    id: string,
    operation: (check: () => Promise<void>) => Promise<T>,
  ) {
    await this.owner(auth);
    await this.uploads.get(id, auth.user.id);
    const token = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.rateLimits.claimUploadStream(id, token);
    } catch {
      throw new ServiceUnavailableException('Upload admission unavailable');
    }
    if (!acquired) {
      throw new ConflictException('Upload has an active request');
    }
    const check = async () => {
      let current: boolean;
      try {
        current = await this.rateLimits.isUploadStreamCurrent(id, token);
      } catch {
        throw new ServiceUnavailableException('Upload admission unavailable');
      }
      if (!current) {
        throw new ConflictException('Upload admission expired');
      }
    };
    try {
      return await operation(check);
    } finally {
      await this.rateLimits
        .releaseUploadStream(id, token)
        .catch(() => this.logger.warn(`Upload ${id} admission release failed; expiry retains its bound`));
    }
  }

  private receive(auth: AuthDto, id: string, input: Readable, offset: number, complete: boolean, length?: number) {
    return this.withStreamAdmission(auth, id, (check) =>
      this.receiveAdmitted(auth, id, input, offset, complete, length, check),
    );
  }

  private async receiveAdmitted(
    auth: AuthDto,
    id: string,
    input: Readable,
    offset: number,
    complete: boolean,
    length: number | undefined,
    check: () => Promise<void>,
  ) {
    const timeout = setTimeout(() => input.destroy(new Error('Upload part timed out')), 10 * 60 * 1000);
    try {
      const initial = await this.uploads.get(id, auth.user.id);
      if (['finalizing', 'verified', 'published'].includes(initial.state) && complete && initial.offset === offset) {
        if (length !== undefined && length !== initial.expectedSize) {
          throw new BadRequestException('Upload length cannot change');
        }
        const empty = await writeAssetUploadPart(this.folder(id), input, 0);
        await rm(empty.path, { force: true });
        if (empty.interrupted) {
          return { resource: initial };
        }
        return this.resolveResult(auth, id, check);
      }

      const validate = (row: AssetUploadResource) => {
        if (row.offset !== offset) {
          throw new ConflictException({
            message: 'Upload offset does not match',
            expectedOffset: row.offset,
            providedOffset: offset,
            type: 'https://iana.org/assignments/http-problem-types#mismatching-upload-offset',
          });
        }
        if (row.state !== 'receiving') {
          throw new ConflictException('Upload is no longer accepting bytes');
        }
        if (
          length !== undefined &&
          (length < row.offset || length > row.maxSize || (row.expectedSize !== null && length !== row.expectedSize))
        ) {
          throw new BadRequestException('Upload length cannot change');
        }
      };
      validate(initial);
      const expectedSize = initial.expectedSize ?? length ?? null;
      const part = await writeAssetUploadPart(
        this.folder(id),
        input,
        Math.min(
          initial.maxAppendSize,
          initial.maxSize - offset,
          expectedSize === null ? initial.maxSize : expectedSize - offset,
        ),
      );
      // An attempt owns only this unique scratch file until the manifest transaction commits.
      await check();
      const resource = await this.uploads.locked(id, auth.user.id, async (tx, row) => {
        validate(row);
        if (row.expectedSize !== initial.expectedSize) {
          throw new ConflictException('Upload length changed during append');
        }
        if (part.size > 0) {
          await tx
            .insertInto('asset_upload_part')
            .values({ resourceId: id, path: part.path, offset, size: part.size })
            .execute();
        }
        const newOffset = offset + part.size;
        const finalizing =
          complete && !part.interrupted && newOffset > 0 && (expectedSize === null || newOffset === expectedSize);
        return tx
          .updateTable('asset_upload_resource')
          .set({
            offset: newOffset,
            expectedSize: expectedSize ?? (finalizing ? newOffset : null),
            state: finalizing ? 'finalizing' : 'receiving',
          })
          .where('id', '=', id)
          .where('expiresAt', '>', new Date())
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      // Do not unlink a potentially committed part on a lost commit response. Recovery sweeps scratch.
      if (part.size === 0) {
        await rm(part.path, { force: true });
      }
      if (part.interrupted) {
        return { resource };
      }
      if (complete && resource.state === 'receiving') {
        throw new BadRequestException('Completed upload length does not match');
      }
      if (resource.state === 'finalizing') {
        return this.resolveResult(auth, id, check);
      }
      return { resource };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async sweepFolder(id: string, check: () => Promise<void>) {
    const folder = this.folder(id);
    const files = await readdir(folder).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    for (const name of files) {
      await check();
      const path = join(folder, name);
      await this.physical.deleteUnreferencedPath(path, () => this.storage.unlink(path));
    }
    await rmdir(folder).catch((error: unknown) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        throw error;
      }
    });
  }

  private async finalize(auth: AuthDto, id: string, check: () => Promise<void>) {
    let row = await this.uploads.get(id, auth.user.id);
    if (row.state === 'finalizing') {
      const initial = row;
      const parts = await this.uploads.parts(undefined, id);
      let verified;
      try {
        verified = await assembleAssetUploadParts(
          this.folder(id),
          parts.map((part) => ({ path: part.path, size: part.size, offset: part.offset, interrupted: false })),
          initial.offset,
          initial.expectedChecksum,
          getFilenameExtension(initial.metadata.filename!),
        );
      } catch (error) {
        if (error instanceof BadRequestException) {
          await check();
          const rejected = await this.uploads.locked(id, auth.user.id, async (tx, current) => {
            if (current.state !== 'finalizing' || current.offset !== initial.offset) {
              return false;
            }
            await tx.updateTable('asset_upload_resource').set({ state: 'rejected' }).where('id', '=', id).execute();
            return true;
          });
          if (rejected) {
            await this.sweepFolder(id, check).catch((cleanupError: unknown) =>
              this.logger.warn(`Rejected upload ${id} cleanup remains pending: ${String(cleanupError)}`),
            );
          }
        }
        throw error;
      }
      await this.storage.utimes(verified.path, new Date(), new Date(initial.metadata.fileModifiedAt));
      await check();
      row = await this.uploads.locked(id, auth.user.id, async (tx, current) => {
        if (current.state !== 'finalizing') {
          return current;
        }
        if (current.offset !== initial.offset || !current.expectedChecksum.equals(initial.expectedChecksum)) {
          throw new ConflictException('Upload changed during verification');
        }
        return tx
          .updateTable('asset_upload_resource')
          .set({
            state: 'verified',
            finalPath: verified.path,
            verifiedChecksum: verified.sha256,
            legacyChecksum: verified.sha1,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      });
    }
    if (row.state === 'rejected') {
      throw new BadRequestException('Upload representation was rejected');
    }
    if (row.state === 'verified') {
      await check();
      const prepared = await this.media.prepareUploadAsset(auth, this.metadata(row), this.file(row));
      row = await this.uploads.locked(id, auth.user.id, (tx, current) =>
        current.state === 'published' ? Promise.resolve(current) : this.uploads.publish(tx, current, prepared),
      );
    }
    if (row.state === 'published' && !row.ingested) {
      await this.ingest(auth, row);
    }
    const current = await this.uploads.get(id, auth.user.id);
    if (current.state === 'published' && current.ingested) {
      // Acknowledged parts and duplicate candidates are no longer needed; live asset references stay.
      await check();
      await this.sweepFolder(id, check);
    }
    return current;
  }

  private async ingest(auth: AuthDto, row: AssetUploadResource) {
    if (row.resultStatus === AssetMediaStatus.DUPLICATE) {
      await this.uploads.completeDuplicate(row.id, auth.user.id);
      return;
    }
    const token = randomUUID();
    const claimed = await this.uploads.claimIngestion(row.id, auth.user.id, token);
    if (!claimed) {
      return;
    }
    const check = async () => {
      await this.uploads.checkIngestion(row.id, auth.user.id, token);
    };
    await check();
    const asset = await this.assets.getById(claimed.resultAssetId!);
    if (!asset) {
      throw new NotFoundException('Upload result unavailable');
    }
    await this.media.finishUploadAsset(auth, this.metadata(claimed), this.file(claimed), asset, undefined, undefined, {
      preparedFile: true,
      quotaCharged: true,
      ingestion: { resourceId: row.id, ownerId: auth.user.id, token },
      checkIngestion: check,
    });
    await this.uploads.completeIngestion(row.id, auth.user.id, token);
  }

  async result(
    auth: AuthDto,
    id: string,
  ): Promise<{ resource: AssetUploadResource; result?: NativeAssetUploadResult }> {
    return this.withStreamAdmission(auth, id, (check) => this.resolveResult(auth, id, check));
  }

  private async resolveResult(
    auth: AuthDto,
    id: string,
    check: () => Promise<void>,
  ): Promise<{ resource: AssetUploadResource; result?: NativeAssetUploadResult }> {
    const resource = await this.finalize(auth, id, check);
    if (resource.state !== 'published' || !resource.ingested) {
      return { resource };
    }
    const visible = await this.media.getUploadAssetIdByChecksum(auth, resource.verifiedChecksum!.toString('hex'));
    return {
      resource,
      result: {
        id: visible?.id === resource.resultAssetId ? visible.id : '00000000-0000-0000-0000-000000000000',
        status: resource.resultStatus as AssetMediaStatus,
        sha256: resource.verifiedChecksum!.toString('hex'),
      },
    };
  }

  async cancel(auth: AuthDto, id: string) {
    await this.owner(auth);
    await this.uploads.locked(id, auth.user.id, async (tx, row) => {
      if (row.state === 'published') {
        throw new ConflictException('A published asset cannot be cancelled through its upload resource');
      }
      await tx
        .updateTable('asset_upload_resource')
        .set({ state: 'cancelled', expiresAt: new Date() })
        .where('id', '=', id)
        .execute();
    });
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.timer ??= setInterval(() => this.tick(), 30_000);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.active;
  }

  tick() {
    if (this.active) {
      return;
    }
    this.active = this.recover()
      .catch((error) => this.logger.warn(`Upload recovery failed: ${String(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  private async recover() {
    for (const row of await this.uploads.recoverable()) {
      if (!row.ownerId) {
        continue;
      }
      const user = await this.uploads.owner(row.ownerId);
      if (!user) {
        continue;
      }
      try {
        if (row.state === 'published') {
          await this.ingest({ user }, row);
        } else {
          await this.withStreamAdmission({ user }, row.id, (check) => this.finalize({ user }, row.id, check));
        }
      } catch (error) {
        this.logger.warn(`Upload ${row.id} remains pending: ${String(error)}`);
      }
    }
    for (const row of await this.uploads.cleanupCandidates()) {
      // The repository rechecks current owner/result references before denying a terminal resource.
      await this.uploads.cleanup(row.id, () => this.sweepFolder(row.id, () => Promise.resolve()));
    }
  }
}
