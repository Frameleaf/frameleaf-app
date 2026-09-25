import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import sanitize from 'sanitize-filename';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UploadFile, UploadRequest } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset, AuthSharedLink } from 'src/database.js';
import {
  AssetBulkUploadCheckResponseDto,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetRejectReason,
  AssetUploadAction,
} from 'src/dtos/asset-media-response.dto.js';
import {
  AssetBulkUploadCheckDto,
  AssetMediaCreateDto,
  AssetMediaOptionsDto,
  AssetMediaSize,
  UploadFieldName,
} from 'src/dtos/asset-media.dto.js';
import { AssetDownloadOriginalDto } from 'src/dtos/asset.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { BaseService } from 'src/services/base.service.js';
import { requireUploadAccess } from 'src/utils/access.js';
import { asUploadRequest, onBeforeLink } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { ImmichFileResponse, getFileNameWithoutExtension, getFilenameExtension } from 'src/utils/file.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  OriginalAsset,
  OriginalLocationPolicy,
  OriginalPurpose,
  getOriginalLocationPolicies,
} from 'src/utils/partner-location.js';
import { fromChecksum } from 'src/utils/request.js';

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    if (!checksum) {
      return;
    }

    const duplicateOptions = this.getDuplicateCheckOptions(auth);
    const assetId = duplicateOptions
      ? await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum), duplicateOptions)
      : await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        if (mimeTypes.isAsset(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.SIDECAR_DATA: {
        if (mimeTypes.isSidecar(filename)) {
          return true;
        }
        break;
      }

      case UploadFieldName.PROFILE_DATA: {
        if (mimeTypes.isProfile(filename)) {
          return true;
        }
        break;
      }
    }

    this.logger.error(`Unsupported file type ${filename}`);
    throw new BadRequestException(`Unsupported file type ${filename}`);
  }

  getUploadFilename({ auth, fieldName, file, body }: UploadRequest): string {
    requireUploadAccess(auth);

    const extension = getFilenameExtension(body.filename || file.originalName);
    const lookup = {
      [UploadFieldName.ASSET_DATA]: extension,
      [UploadFieldName.SIDECAR_DATA]: '.xmp',
      [UploadFieldName.PROFILE_DATA]: extension,
    };

    return sanitize(`${file.uuid}${lookup[fieldName]}`);
  }

  getUploadFolder({ auth, fieldName, file }: UploadRequest): string {
    auth = requireUploadAccess(auth);

    let folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, file.uuid);
    if (fieldName === UploadFieldName.PROFILE_DATA) {
      folder = StorageCore.getFolderLocation(StorageFolder.Profile, auth.user.id);
    }

    this.storageRepository.mkdirSync(folder);

    return folder;
  }

  async onUploadError(request: AuthRequest, file: Express.Multer.File) {
    const uploadFilename = this.getUploadFilename(asUploadRequest(request, file));
    const uploadFolder = this.getUploadFolder(asUploadRequest(request, file));
    const uploadPath = `${uploadFolder}/${uploadFilename}`;

    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [uploadPath] } });
  }

  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      await this.requireAccess({
        auth,
        permission: Permission.AssetUpload,
        // do not need an id here, but the interface requires it
        ids: [auth.user.id],
      });

      this.requireQuota(auth, file.size);

      if (dto.livePhotoVideoId) {
        await onBeforeLink(
          { asset: this.assetRepository, event: this.eventRepository },
          { userId: auth.user.id, livePhotoVideoId: dto.livePhotoVideoId },
        );
      }

      const physicalDeduplication = await this.getPhysicalDeduplicationCandidate(auth.user.id, file);
      asset = await this.assetRepository.create(
        {
          ownerId: auth.user.id,
          libraryId: null,

          checksum: file.checksum,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          originalPath: file.originalPath,

          fileCreatedAt: dto.fileCreatedAt,
          fileModifiedAt: dto.fileModifiedAt,
          localDateTime: dto.fileCreatedAt,

          type: mimeTypes.assetType(file.originalPath),
          isFavorite: dto.isFavorite,
          duration: dto.duration || null,
          // `locked` is a lock record, never a stored visibility (FL-34): an upload into the Locked view
          // is stored on the timeline and locked in the same transaction, so nothing lists it unlocked
          visibility:
            dto.visibility && dto.visibility !== AssetVisibility.Locked ? dto.visibility : AssetVisibility.Timeline,
          livePhotoVideoId: dto.livePhotoVideoId,
          originalFileName: dto.filename || file.originalName,
        },
        dto.visibility === AssetVisibility.Locked
          ? { reason: AssetLockReason.Marked, lockedBy: auth.user.id }
          : undefined,
      );

      if (dto.metadata?.length) {
        await this.assetRepository.upsertMetadata(asset.id, dto.metadata);
      }

      if (sidecarFile) {
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarFile.originalPath,
          type: AssetFileType.Sidecar,
        });
        await this.storageRepository.utimes(sidecarFile.originalPath, new Date(), new Date(dto.fileModifiedAt));
      }
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });

      if (physicalDeduplication) {
        await this.physicalFileRepository.linkAssetToOriginalPhysicalFile(asset.id, physicalDeduplication);
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.originalPath] } });
        asset.originalPath = physicalDeduplication.path;
        asset.physicalOriginalFileId = physicalDeduplication.id;
      } else {
        const masterPhysicalFile = await this.ensureMasterPhysicalOriginal(auth.user.id, asset.id);
        if (masterPhysicalFile) {
          asset.physicalOriginalFileId = masterPhysicalFile.id;
        }
      }

      if (file.legacyChecksum) {
        await this.forkSchemaRepository.recordAssetChecksums({
          assetId: asset.id,
          sha1: file.legacyChecksum,
          sha256: file.checksum,
          sizeInBytes: file.size,
          path: asset.originalPath,
          source: 'upload',
        });
      }

      await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

      if (auth.sharedLink) {
        await this.addToSharedLink(auth.sharedLink, asset.id);
      }

      await this.eventRepository.emit('AssetCreate', { asset, file });

      return { id: asset.id, status: AssetMediaStatus.CREATED };
    } catch (error: any) {
      // clean up files
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });

      // handle duplicates with a success response
      if (isAssetChecksumConstraint(error)) {
        const duplicateOptions = this.getDuplicateCheckOptions(auth);
        const duplicateId = duplicateOptions
          ? await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum, duplicateOptions)
          : await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, file.checksum);
        if (!duplicateId) {
          // the existing asset is hidden from this session: NSFW privacy mode, or Locked media the session
          // has not unlocked (a shared-link session never has)
          if (auth.hideNsfwAssets || (await this.isWithheldLockedDuplicate(auth, file.checksum))) {
            this.logger.debug('Duplicate asset upload rejected while the existing asset is hidden');
            // Return a nil UUID rather than an empty string so clients that
            // strictly type the asset id (e.g. immich-go's AssetResponse.ID)
            // don't crash. The real duplicate id is still withheld, preserving
            // the NSFW privacy guarantee.
            return { status: AssetMediaStatus.DUPLICATE, id: '00000000-0000-0000-0000-000000000000' };
          }

          this.logger.error(`Error locating duplicate for checksum constraint`);
          throw new InternalServerErrorException();
        }

        if (auth.sharedLink) {
          await this.addToSharedLink(auth.sharedLink, duplicateId);
        }

        this.logger.debug(`Duplicate asset upload rejected: existing asset ${duplicateId}`);
        return { status: AssetMediaStatus.DUPLICATE, id: duplicateId };
      }

      // clean up the asset row if one was created
      if (asset) {
        await this.assetRepository.remove({ id: asset.id });
      }

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  async downloadOriginal(auth: AuthDto, id: string, dto: AssetDownloadOriginalDto): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const { ownerId, originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(
      id,
      dto.edited ?? false,
    );

    const path = editedPath ?? originalPath!;

    return this.withOriginalLocationPolicy(auth, { id, ownerId }, 'download', {
      path,
      fileName: getFileNameWithoutExtension(originalFileName) + getFilenameExtension(path),
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  /**
   * FL-54: a file served as-is carries its embedded EXIF/XMP/QuickTime location. For a partner who may not
   * see the owner's locations (and for playback through a link that hides metadata) serve a verified
   * location-free copy instead; when none can be made, refuse rather than send the original bytes. A
   * link that hides metadata never downloads (AL-27). Every other case is the untouched original.
   */
  private async withOriginalLocationPolicy(
    auth: AuthDto,
    asset: OriginalAsset,
    purpose: OriginalPurpose,
    response: ImmichFileResponse,
  ): Promise<ImmichFileResponse> {
    const policyFor = await getOriginalLocationPolicies({
      auth,
      assets: [asset],
      purpose,
      repository: this.partnerRepository,
    });

    switch (policyFor(asset)) {
      case OriginalLocationPolicy.Serve: {
        return new ImmichFileResponse(response);
      }

      case OriginalLocationPolicy.Refuse: {
        throw new ForbiddenException('Downloads are turned off while metadata is hidden');
      }

      case OriginalLocationPolicy.RemoveLocation: {
        const lease = await this.metadataRepository.acquireLocationFreeOriginal(response.path).catch(() => {
          throw new ForbiddenException('The location of this file could not be removed');
        });
        return new ImmichFileResponse({ ...response, path: lease.path, release: lease.release });
      }
    }
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
  ): Promise<ImmichFileResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    if (dto.size === AssetMediaSize.Original) {
      throw new BadRequestException('May not request original file');
    }

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { ownerId, originalPath, originalFileName, path } = await this.assetRepository.getForThumbnail(
      id,
      size,
      dto.edited ?? false,
    );

    if (size === AssetFileType.FullSize && mimeTypes.isWebSupportedImage(originalPath) && !dto.edited) {
      // use original file for web supported images
      return { targetSize: 'original' };
    }

    if (dto.size === AssetMediaSize.FULLSIZE && !path) {
      // downgrade to preview if fullsize is not available.
      // e.g. disabled or not yet (re)generated
      return { targetSize: AssetMediaSize.PREVIEW };
    }

    if (!path) {
      throw new NotFoundException('Asset media not found');
    }

    const fileNameBase =
      auth.sharedLink && !auth.sharedLink.showExif ? id : getFileNameWithoutExtension(originalFileName);
    const fileName = `${fileNameBase}_${size}${getFilenameExtension(path)}`;
    const response = new ImmichFileResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
    });

    // FL-54: a fullsize preview extracted from a RAW before generation-time stripping still carries the
    // camera's GPS. Rather than a one-time regeneration job, those files are cleaned lazily: a viewer who
    // may not see the owner's location gets a verified location-free copy (a clean file is served as is).
    // Thumbnails and previews are re-encoded without metadata, so only fullsize needs the check.
    if (size === AssetFileType.FullSize) {
      return this.withOriginalLocationPolicy(auth, { id, ownerId }, 'playback', response);
    }

    return response;
  }

  async downloadVideoEditVersion(auth: AuthDto, id: string, versionId: string): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });
    const version = await this.assetEditRepository.getVideoVersion(id, versionId);
    if (!version || version.ownerId !== auth.user.id || version.status !== 'ready' || !version.masterPath)
      throw new NotFoundException('Video version is unavailable');
    return new ImmichFileResponse({
      path: version.masterPath,
      fileName: `${id}-${version.id}.mp4`,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async playbackVideo(auth: AuthDto, id: string, edited = true): Promise<ImmichFileResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    const asset = await this.assetRepository.getForVideo(id);

    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }

    // The unedited source is the owner's working copy in the quick editor (FL-113). Anyone else,
    // including a shared link or a partner, is always given what the owner published.
    const unedited = !edited && auth.user?.id === asset.ownerId && !auth.sharedLink;
    const filepath = (unedited ? null : asset.editedVideoPath) || asset.encodedVideoPath || asset.originalPath;

    return this.withOriginalLocationPolicy(auth, { id, ownerId: asset.ownerId }, 'playback', {
      path: filepath,
      contentType: mimeTypes.lookup(filepath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    // Clients hash with SHA-1 while this fork persists SHA-256, so resolve the
    // sent digests through the SHA-1 recorded at upload. Translating to the
    // stored digest (rather than matching separately) keeps the duplicate
    // lookup on the single filtered query, hidden-content rules included.
    const translations = await this.forkSchemaRepository.getChecksumTranslations(auth.user.id, checksums);
    const lookups = [...checksums, ...translations.map(({ checksum }) => checksum)];
    const duplicateOptions = this.getDuplicateCheckOptions(auth);
    const results = duplicateOptions
      ? await this.assetRepository.getByChecksums(auth.user.id, lookups, duplicateOptions)
      : await this.assetRepository.getByChecksums(auth.user.id, lookups);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    for (const { id, deletedAt, checksum } of results) {
      checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
    }

    for (const { sha1, checksum } of translations) {
      const match = checksumMap[checksum.toString('hex')];
      if (match) {
        checksumMap[sha1.toString('hex')] = match;
      }
    }

    return {
      results: dto.assets.map(({ id, checksum }) => {
        const duplicate = checksumMap[fromChecksum(checksum).toString('hex')];
        if (duplicate) {
          return {
            id,
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: duplicate.id,
            isTrashed: duplicate.isTrashed,
          };
        }

        return {
          id,
          action: AssetUploadAction.ACCEPT,
        };
      }),
    };
  }

  private async addToSharedLink(sharedLink: AuthSharedLink, assetId: string) {
    if (!sharedLink.albumId) {
      await this.sharedLinkRepository.addAssets(sharedLink.id, [assetId]);
      return;
    }

    const album = await this.albumRepository.getById(sharedLink.albumId, { withAssets: false });
    if (!album) {
      return;
    }

    await this.albumRepository.addAssetIds(album.id, [assetId]);
    const userIds = album.albumUsers.map(({ user }) => user.id);
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds,
      recipientIds: userIds,
    });
  }

  /**
   * A duplicate lookup names only what this session may see: the caller's hidden-content settings
   * apply, and a Locked match is named only for the owner's elevated session (FL-34). Left out, the
   * repository withholds Locked matches.
   */
  /**
   * Whether the owner's copy of this checksum is Locked media the session may not name. Checked
   * server side only, after the named lookup came back empty; its id never leaves this method.
   */
  private async isWithheldLockedDuplicate(auth: AuthDto, checksum: Buffer) {
    if (getLockedOwnerId(auth)) {
      return false;
    }

    const lockedId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, checksum, {
      lockedOwnerId: auth.user.id,
    });
    return !!lockedId;
  }

  private getDuplicateCheckOptions(auth: AuthDto) {
    const options = {
      ...(auth.hideNsfwAssets && getHiddenContentQueryOptions(auth)),
      ...getLockedVisibilityOptions(auth),
    };
    return Object.keys(options).length > 0 ? options : undefined;
  }

  private async getPhysicalDeduplicationCandidate(ownerId: string, file: UploadFile) {
    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    if (
      !physicalDeduplication.enabled ||
      !physicalDeduplication.masterUserId ||
      ownerId === physicalDeduplication.masterUserId
    ) {
      return;
    }

    const masterAsset = await this.physicalFileRepository.getMasterOriginalCandidate(
      physicalDeduplication.masterUserId,
      file.checksum,
      file.size,
    );
    if (!masterAsset) {
      return;
    }

    return this.physicalFileRepository.ensureOriginalPhysicalFile(masterAsset.id);
  }

  private async ensureMasterPhysicalOriginal(ownerId: string, assetId: string) {
    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    if (!physicalDeduplication.enabled || ownerId !== physicalDeduplication.masterUserId) {
      return;
    }

    return this.physicalFileRepository.ensureOriginalPhysicalFile(assetId);
  }

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}
