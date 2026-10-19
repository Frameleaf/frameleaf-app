import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { extname } from 'node:path';
import type {
  PhysicalFileTrashEntry,
  PhysicalFileTrashInput,
  PhysicalFileTrashResult,
} from 'src/repositories/physical-file-trash.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset } from 'src/database.js';
import { OnEvent } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  FileTrashItemResponseDto,
  FileTrashListQueryDto,
  FileTrashResponseDto,
  FileTrashRestoreResponseDto,
} from 'src/dtos/physical-file-trash.dto.js';
import {
  AssetLockReason,
  AssetVisibility,
  ChecksumAlgorithm,
  FrameleafWorker,
  JobName,
  StorageFolder,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { moveFileWithin, storedCopyChecks } from 'src/utils/file-trash.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * Library Care file trash (universal storage, spec §3.5). Originals reach it through the
 * reference-counted delete (`deleteUnreferencedPath` with `trash`) and leave only through an
 * administrator: restored into their last owner's library, or deleted permanently.
 */
@Injectable()
export class PhysicalFileTrashService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    return this.recoverMoves();
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async recoverMoves() {
    try {
      const deferred = await this.physicalFileTrashRepository.recoverMoves((from, to) => this.move(from, to));
      if (deferred) this.logger.warn(`${deferred} interrupted file trash moves need review; all copies retained`);
    } catch (error) {
      this.logger.warn(`File trash recovery deferred: ${error}`);
    }
  }

  /**
   * Moves one unreferenced original into the file trash, for callers that release originals themselves
   * (the universal storage migration). Nothing changes while anything references the path.
   */
  trashOriginal(input: PhysicalFileTrashInput): Promise<PhysicalFileTrashResult> {
    return this.physicalFileTrashRepository.trash(input, (from, to) => this.move(from, to));
  }

  async list(auth: AuthDto, { page, size }: FileTrashListQueryDto): Promise<FileTrashResponseDto> {
    const { items, total, totalBytes } = await this.physicalFileTrashRepository.list({
      skip: (page - 1) * size,
      take: size,
      lockedOwnerId: getLockedOwnerId(auth),
    });
    const ownerIds = [...new Set(items.map(({ lastOwnerId }) => lastOwnerId).filter((id): id is string => !!id))];
    const names = new Map<string, string>();
    for (const ownerId of ownerIds) {
      const owner = await this.userRepository.get(ownerId, { withDeleted: false });
      if (owner) {
        names.set(ownerId, owner.name);
      }
    }
    return { items: items.map((entry) => this.toResponse(entry, names)), total, totalBytes: Number(totalBytes) };
  }

  private requireVisible(
    auth: AuthDto,
    entry: PhysicalFileTrashEntry | undefined,
  ): asserts entry is PhysicalFileTrashEntry {
    if (!entry || (entry.wasLocked !== false && getLockedOwnerId(auth) !== entry.lastOwnerId)) {
      throw new NotFoundException('File not found in the file trash');
    }
  }

  /**
   * Re-imports a trashed original as a new asset in its last owner's library; metadata is read from the
   * file again. Refused when that account is unknown or gone, and when its library already holds the
   * same content (the file then goes back to the trash).
   */
  async restore(auth: AuthDto, id: string): Promise<FileTrashRestoreResponseDto> {
    const entry = await this.physicalFileTrashRepository.getById(id);
    this.requireVisible(auth, entry);
    if (!entry.lastOwnerId) {
      throw new BadRequestException('The library this file was last in is not known');
    }
    const owner = await this.userRepository.get(entry.lastOwnerId, { withDeleted: false });
    if (!owner) {
      throw new BadRequestException('The account this file was last in no longer exists');
    }

    const extension = extname(entry.originalFileName) || extname(entry.path);
    const assetId = this.cryptoRepository.randomUUID();
    const target = StorageCore.getNestedPath(StorageFolder.Upload, owner.id, `${assetId}${extension}`);
    const expected = { checksum: entry.checksum, sizeInBytes: entry.sizeInBytes };
    const checks = storedCopyChecks(this.storageRepository, this.cryptoRepository, expected, (path) =>
      this.logger.warn(`Restored ${assetId} keeps its own file: the stored copy at ${path} holds other bytes`),
    );
    const proof = await this.physicalFileRepository.proveStoredCopy(assetId, expected, checks.verify);
    let stat!: Awaited<ReturnType<typeof this.storageRepository.stat>>;
    let asset: Asset | undefined;
    let linked = false;
    try {
      const restored = await this.physicalFileTrashRepository.untrash(
        id,
        target,
        async (from, to) => {
          await this.move(from, to);
          try {
            stat = await this.storageRepository.stat(to);
          } catch (error) {
            try {
              await this.move(to, from);
            } catch (compensationError) {
              this.logger.error('File-trash inspection failed', error);
              this.logger.error('File-trash move-back failed', compensationError);
              throw new AggregateError(
                [error, compensationError],
                `File-trash inspection failed and the file could not be moved back from ${to} to ${from}`,
                { cause: compensationError },
              );
            }
            throw error;
          }
        },
        async (trx, current) => {
          this.requireVisible(auth, current);
          asset = await this.assetRepository.create(
            {
              id: assetId,
              ownerId: owner.id,
              libraryId: null,
              checksum: entry.checksum,
              checksumAlgorithm:
                entry.checksum.length === 32 ? ChecksumAlgorithm.sha256File : ChecksumAlgorithm.sha1File,
              originalPath: target,
              fileCreatedAt: stat.mtime,
              fileModifiedAt: stat.mtime,
              localDateTime: stat.mtime,
              type: mimeTypes.assetType(target),
              isFavorite: false,
              duration: null,
              visibility: AssetVisibility.Timeline,
              livePhotoVideoId: null,
              originalFileName: entry.originalFileName,
            },
            current.wasLocked === false ? undefined : { reason: AssetLockReason.Marked, lockedBy: owner.id },
            trx,
          );
          await this.assetRepository.upsertExif(
            {
              exif: { assetId: asset.id, fileSizeInByte: entry.sizeInBytes },
              lockedPropertiesBehavior: 'override',
            },
            trx,
          );
          const stored = await this.physicalFileRepository.linkUploadedOriginal(asset.id, expected, checks, {
            transaction: trx,
            proof,
          });
          linked = stored?.linked === true;
        },
      );
      if (!restored || !asset) {
        throw new NotFoundException('File not found in the file trash');
      }
    } catch (error) {
      if (isAssetChecksumConstraint(error)) {
        throw new ConflictException('That library already holds this file');
      }
      throw error;
    }
    if (linked) {
      // A concurrent upload owns the retained copy; this unreferenced extra can be removed.
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [target] } });
    }

    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });
    await this.eventRepository.emit('AssetCreate', {
      asset,
      file: {
        uuid: asset.id,
        checksum: entry.checksum,
        originalPath: target,
        originalName: entry.originalFileName,
        size: entry.sizeInBytes,
      },
    });
    this.logger.log(`Restored ${entry.originalFileName} from the file trash as asset ${asset.id}`);
    return { assetId: asset.id };
  }

  /** Deletes a trashed original from disk for good. The only way an original leaves disk. */
  async purge(auth: AuthDto, id: string): Promise<void> {
    this.requireVisible(auth, await this.physicalFileTrashRepository.getById(id));
    const entry = await this.physicalFileTrashRepository.purge(id, (path, current) => {
      this.requireVisible(auth, current);
      return this.storageRepository.unlink(path);
    });
    if (!entry) {
      throw new NotFoundException('File not found in the file trash');
    }
    this.logger.log(`Permanently deleted ${entry.originalFileName} (${entry.sizeInBytes} bytes) from the file trash`);
  }

  private move(from: string, to: string) {
    return moveFileWithin(this.storageRepository, from, to);
  }

  private toResponse(entry: PhysicalFileTrashEntry, names: Map<string, string>): FileTrashItemResponseDto {
    return {
      id: entry.id,
      originalFileName: entry.originalFileName,
      sizeInBytes: Number(entry.sizeInBytes),
      checksum: Buffer.from(entry.checksum).toString('hex'),
      lastOwnerId: entry.lastOwnerId,
      lastOwnerName: entry.lastOwnerId ? (names.get(entry.lastOwnerId) ?? null) : null,
      lastAssetId: entry.lastAssetId,
      trashedAt: new Date(entry.trashedAt).toISOString(),
    };
  }
}
