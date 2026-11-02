import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UploadFile, UploadRequest } from 'src/types.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
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
  AssetStatus,
  AssetType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  JobName,
  LibraryScope,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { SharpResourceLimitError } from 'src/queue/sharp-protocol.js';
import { BaseService } from 'src/services/base.service.js';
import { requireUploadAccess, requireUploadsNotPaused } from 'src/utils/access.js';
import { asUploadRequest } from 'src/utils/asset.util.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { hasPublishedDevelopRendition } from 'src/utils/develop-envelope.js';
import { moveFileWithin, storedCopyChecks } from 'src/utils/file-trash.js';
import {
  FileDownloadResponse,
  getFileNameWithoutExtension,
  getFilenameExtension,
  lockedViewerOf,
} from 'src/utils/file.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { isLockedPath, makeWorkDir, withPlainCopy } from 'src/utils/locked-read.js';
import { getLockedOwnerId, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  OriginalAsset,
  OriginalLocationPolicy,
  OriginalPurpose,
  getOriginalLocationPolicies,
} from 'src/utils/partner-location.js';
import { getPreferences, isTrashReuploadOpen } from 'src/utils/preferences.js';
import { fromChecksum } from 'src/utils/request.js';

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    requireUploadAccess(auth);
    // A link visitor may upload, but may not probe the owner's private library before sending a file.
    if (auth.sharedLink || !checksum) {
      return;
    }

    const duplicateOptions = this.getDuplicateCheckOptions(auth);
    const assetId = duplicateOptions
      ? await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum), duplicateOptions)
      : await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, fromChecksum(checksum));
    if (!assetId) {
      return;
    }
    // Its original is gone, or (FL-556) the account lets uploads bring photos back from the Trash:
    // let the file come, the upload restores the photo.
    const checksums = [fromChecksum(checksum)];
    if (
      (await this.lostOriginalMatches(auth, checksums)).length > 0 ||
      (await this.trashedMatches(auth, checksums)).length > 0
    ) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  /**
   * Media health: the owner's assets with these bytes whose original file is gone. Those are not
   * duplicates of a re-upload; the upload restores them. Empty when any match still has its file
   * (a real duplicate), or for trashed, hidden, external or shared-link matches.
   */
  private async lostOriginalMatches(auth: AuthDto, checksums: Buffer[], { includeHidden = false } = {}) {
    if (auth.sharedLink) {
      return [];
    }
    const options = includeHidden ? undefined : this.getDuplicateCheckOptions(auth);
    const matches = options
      ? await this.assetRepository.getByChecksums(auth.user.id, checksums, options)
      : await this.assetRepository.getByChecksums(auth.user.id, checksums);
    const present = await Promise.all(
      matches.map(({ originalPath }) => this.storageRepository.checkFileExists(originalPath)),
    );
    if (matches.length === 0 || present.some(Boolean)) {
      return [];
    }
    return matches.filter((match) => !match.deletedAt && !match.libraryId && !match.isExternal);
  }

  /**
   * FL-556: while the account lets uploads bring photos back from the Trash, its own photos in the Trash
   * with these bytes. Empty when the window is closed, or when a photo outside the Trash already has
   * them (a real duplicate). Photos awaiting removal and photos this session may not see stay put.
   */
  private async trashedMatches(auth: AuthDto, checksums: Buffer[]) {
    if (auth.sharedLink || !isTrashReuploadOpen(getPreferences(await this.userRepository.getMetadata(auth.user.id)))) {
      return [];
    }
    const options = this.getDuplicateCheckOptions(auth);
    const matches = options
      ? await this.assetRepository.getByChecksums(auth.user.id, checksums, options)
      : await this.assetRepository.getByChecksums(auth.user.id, checksums);
    if (matches.some(({ deletedAt }) => !deletedAt)) {
      return [];
    }
    return matches.filter(
      ({ status, libraryId, isExternal }) => status === AssetStatus.Trashed && !libraryId && !isExternal,
    );
  }

  /**
   * A re-upload puts a photo back, keeping its albums, faces and history:
   * - FL-556, while the account allows it: a photo in the Trash with these bytes leaves the Trash, and
   *   takes the upload as its file only if its own is gone;
   * - a lost original goes back under the asset it belonged to. Hidden photos (Locked, or hidden by this
   *   session's content settings) are repaired too, but their id is only returned when this session may
   *   see them.
   * `fileUsed` says whether the uploaded file became the photo's original.
   */
  async restoreLostOriginal(auth: AuthDto, dto: AssetMediaCreateDto, file: UploadFile) {
    const checksums = [file.checksum, ...(file.legacyChecksum ? [file.legacyChecksum] : [])];
    for (const asset of await this.trashedMatches(auth, checksums)) {
      let sequenced: string[] = [];
      const [restored] = await this.trashRepository.restoreAll([asset.id], auth, (ids) => {
        sequenced = ids;
      });
      if (!restored) {
        continue;
      }
      // As the Trash's own restore announces it (TrashService.afterChange).
      if (sequenced.length > 0) {
        await this.trashRepository.enqueueLocalEffects();
      } else {
        await this.eventRepository.emit('AssetRestoreAll', { assetIds: [restored], userId: auth.user.id });
      }
      this.logger.log(`Upload brought asset ${restored} back from the Trash`);
      const fileUsed =
        !(await this.storageRepository.checkFileExists(asset.originalPath)) &&
        (await this.restoreOriginalFrom(asset, dto, file, checksums));
      return { id: restored, visible: true, fileUsed };
    }
    const lost = await this.lostOriginalMatches(auth, checksums, { includeHidden: true });
    if (lost.length === 0) {
      return;
    }
    for (const asset of lost) {
      if (await this.restoreOriginalFrom(asset, dto, file, checksums)) {
        const options = this.getDuplicateCheckOptions(auth);
        const visible = options ? await this.assetRepository.getByChecksums(auth.user.id, checksums, options) : lost;
        return { id: asset.id, visible: visible.some(({ id }) => id === asset.id), fileUsed: true };
      }
    }
  }

  private async restoreOriginalFrom(
    asset: { id: string; originalPath: string },
    dto: AssetMediaCreateDto,
    file: UploadFile,
    checksums: Buffer[],
  ) {
    const sha1 = file.legacyChecksum ?? (await this.cryptoRepository.hashFileDigests(file.originalPath)).sha1;
    const restored = await this.physicalFileRepository.restoreLostOriginal({
      assetId: asset.id,
      expectedOriginalPath: asset.originalPath,
      originalPath: file.originalPath,
      sha1,
      sha256: checksums[0],
      sizeInBytes: file.size,
      reason: 'restored_by_upload',
    });
    if (restored) {
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
      await this.jobRepository.queueAll([
        { name: JobName.SidecarCheck, data: { id: asset.id, source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: asset.id, source: 'upload' } },
      ]);
      this.logger.log(`Upload restored the lost original of asset ${asset.id}`);
    }
    return restored;
  }

  canUploadFile({ auth, fieldName, file, body }: UploadRequest): true {
    requireUploadAccess(auth);

    const filename = body.filename || file.originalName;

    switch (fieldName) {
      case UploadFieldName.ASSET_DATA: {
        // FL-538: refused before any bytes are kept, on every path that uploads a photo or video
        requireUploadsNotPaused(requireUploadAccess(auth));
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

  /** Upload policy and asset values shared by multipart and verified resumable publication. */
  async prepareUploadAsset(auth: AuthDto, dto: AssetMediaCreateDto, file: UploadFile) {
    await this.requireAccess({
      auth,
      permission: Permission.AssetUpload,
      // do not need an id here, but the interface requires it
      ids: [auth.user.id],
    });

    requireUploadsNotPaused(auth);
    this.requireQuota(auth, file.size);

    return {
      asset: {
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
        libraryScope: dto.libraryScope ?? LibraryScope.Personal,
        duration: dto.duration || null,
        // `locked` is a lock record, never a stored visibility (FL-34): an upload into the Locked view
        // is stored on the timeline and locked in the same transaction, so nothing lists it unlocked
        visibility:
          dto.visibility && dto.visibility !== AssetVisibility.Locked ? dto.visibility : AssetVisibility.Timeline,
        livePhotoVideoId: dto.livePhotoVideoId,
        originalFileName: dto.filename || file.originalName,
      },
      lock:
        dto.visibility === AssetVisibility.Locked
          ? { reason: AssetLockReason.Marked, lockedBy: auth.user.id }
          : undefined,
    };
  }

  /** Post-publication ingestion is retried against the recorded asset, never another creation. */
  async finishUploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    asset: Asset,
    sidecarFile?: UploadFile,
    options: {
      preparedFile?: boolean;
      quotaCharged?: boolean;
      ingestion?: { resourceId: string; token: string; ownerId: string };
      checkIngestion?: () => Promise<void>;
    } = {},
  ) {
    if (options.quotaCharged && !options.ingestion) {
      // a resumable upload links to a shared file only under its durable ingestion claim
      throw new BadRequestException('Durable ingestion claim is required');
    }
    await options.checkIngestion?.();
    if (!options.quotaCharged && dto.metadata?.length) {
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
    if (!options.preparedFile) {
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
    }
    if (!options.quotaCharged) {
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });
    }

    // universal storage: one file per content, server-wide. Content another library already holds is
    // linked to that file and the upload released; new content becomes its own primary file. FL-412: only
    // a stored file proven to hold the same bytes replaces the upload's own copy.
    const expected = { checksum: file.checksum, sizeInBytes: file.size };
    const checks = storedCopyChecks(this.storageRepository, this.cryptoRepository, expected, (path) =>
      this.logger.warn(`Upload ${asset.id} keeps its own file: the stored copy at ${path} holds other bytes`),
    );
    const stored = await this.physicalFileRepository.linkUploadedOriginal(asset.id, expected, {
      ...checks,
      // FL-721 (spec §6.1): a sealed Locked file never stands in for an upload; the upload keeps its own
      // file (the repository already leaves encrypted files out; this holds for one sealed meanwhile)
      verify: async (path) => ((await isLockedPath(path)) ? null : checks.verify(path)),
      untrash: (from, to) => moveFileWithin(this.storageRepository, from, to),
      ...(options.quotaCharged && { ingestion: options.ingestion }),
    });
    if (stored?.linked) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.originalPath] } });
      asset.originalPath = stored.physicalFile.path;
    }
    if (stored) {
      asset.physicalOriginalFileId = stored.physicalFile.id;
    }

    if (!options.quotaCharged && file.legacyChecksum) {
      await this.forkSchemaRepository.recordAssetChecksums({
        assetId: asset.id,
        sha1: file.legacyChecksum,
        sha256: file.checksum,
        sizeInBytes: file.size,
        path: asset.originalPath,
        source: 'upload',
      });
    }

    await options.checkIngestion?.();
    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

    if (auth.sharedLink) {
      await this.addToSharedLink(auth.sharedLink, asset.id);
    }

    await options.checkIngestion?.();
    await this.eventRepository.emit('AssetCreate', { asset, file: options.quotaCharged ? undefined : file });
  }

  async uploadAsset(
    auth: AuthDto,
    dto: AssetMediaCreateDto,
    file: UploadFile,
    sidecarFile?: UploadFile,
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      const prepared = await this.prepareUploadAsset(auth, dto, file);
      const restored = await this.restoreLostOriginal(auth, dto, file);
      if (restored) {
        // The photo kept its own file (it only left the Trash): the upload is not needed.
        const unused = [...(restored.fileUsed ? [] : [file.originalPath]), sidecarFile?.originalPath].filter(Boolean);
        if (unused.length > 0) {
          await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: unused } });
        }
        // ponytail: reported as created (the file was taken), so every client keeps working unchanged.
        // A photo this session may not see answers exactly like a hidden duplicate: no id, no hint.
        return restored.visible
          ? { id: restored.id, status: AssetMediaStatus.CREATED }
          : { id: '00000000-0000-0000-0000-000000000000', status: AssetMediaStatus.DUPLICATE };
      }
      if (prepared.asset.livePhotoVideoId) {
        const published = await this.assetRepository.createLivePhotoUpload(prepared.asset, prepared.lock);
        asset = published.asset;
        if (published.lockedIds.length > 0) await this.afterAssetsLocked(published.lockedIds);
        if (published.hiddenId)
          await this.eventRepository.emit('AssetHide', { assetId: published.hiddenId, userId: auth.user.id });
      } else {
        asset = await this.assetRepository.create(prepared.asset, prepared.lock);
      }
      await this.finishUploadAsset(auth, dto, file, asset, sidecarFile);

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

  async downloadOriginal(
    auth: AuthDto,
    id: string,
    dto: AssetDownloadOriginalDto,
    signal?: AbortSignal,
  ): Promise<FileDownloadResponse> {
    signal?.throwIfAborted();
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const { ownerId, originalPath, originalFileName, editedPath } = await this.assetRepository.getForOriginal(
      id,
      dto.edited ?? false,
    );

    // Downloaded as shown (owner, 2026-10-16): the owner's viewer shows their current develop version.
    const developedPath = dto.edited && !dto.format ? await this.getShownDevelopMaster(auth, id, ownerId) : undefined;
    const filePath = developedPath ?? editedPath ?? originalPath!;
    if (dto.format) {
      const source = await this.assetRepository.getById(id);
      if (!source || source.type !== AssetType.Image || source.originalPath !== filePath)
        throw new BadRequestException('Still exports require an unedited photo; export a saved edit from its version');
      const policy = getOriginalLocationPolicies({ auth, assets: [source], purpose: 'download' });
      if (policy(source) !== OriginalLocationPolicy.Serve)
        throw new ForbiddenException('Downloads are turned off while metadata is hidden');
      if (dto.format !== 'sdr-jpeg' && process.env.FRAMELEAF_HDR_IMAGES !== 'experimental')
        throw new NotFoundException('HDR export is unavailable');
      if (dto.format === 'hdr-heic' && !(await this.mediaRepository.getHdrCodecCapabilities())?.heicPqEncoder)
        throw new BadRequestException({
          code: 'hdr_heic_export_unavailable',
          message: 'HDR HEIC export is unavailable',
        });
      const checksum = Buffer.from(source.checksum);
      // FL-721 (spec §8): a sealed source's full-size export is written inside the locked tmpfs folder
      const folder = await makeWorkDir('photo-export', await isLockedPath(filePath));
      const heic = dto.format === 'hdr-heic';
      const output = path.join(folder, heic ? 'still_hdr.heic' : 'still.jpg');
      const release = () =>
        void rm(folder, { recursive: true, force: true }).catch(() => {
          this.logger.warn('Unable to remove a temporary still export');
        });
      try {
        // FL-721: a sealed original is exported from a plain copy, for a viewer allowed its key
        await withPlainCopy(
          filePath,
          (input) => this.mediaRepository.exportPhotoStill(input, output, dto.format!, checksum, signal),
          { viewerId: lockedViewerOf(auth) },
        );
        signal?.throwIfAborted();
        await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });
        const current = await this.assetRepository.getById(id);
        if (
          !current ||
          current.deletedAt ||
          current.ownerId !== source.ownerId ||
          current.originalPath !== filePath ||
          !current.checksum.equals(checksum)
        )
          throw new ConflictException('This photo changed during export; try again');
        return new FileDownloadResponse({
          path: output,
          release,
          contentType: heic ? 'image/heic' : 'image/jpeg',
          fileName: `${getFileNameWithoutExtension(originalFileName)}_still_${dto.format}.${heic ? 'heic' : 'jpg'}`,
          cacheControl: CacheControl.PrivateWithoutCache,
        });
      } catch (error) {
        // Pool cancellation joins the child before its private files are removed.
        await rm(folder, { recursive: true, force: true });
        if (error instanceof Error && error.message.includes('IMAGE_SOURCE_CHANGED'))
          throw new ConflictException('This photo changed during export; try again');
        if (error instanceof SharpResourceLimitError)
          throw new BadRequestException({
            code: 'photo_export_resource_limit',
            message: 'This photo exceeds the export processing limit',
          });
        if (error instanceof Error && error.message.includes('HDR_RECONSTRUCTION_UNAVAILABLE'))
          throw new BadRequestException({
            code: 'hdr_reconstruction_unavailable',
            message: 'HDR reconstruction is unavailable for this photo; choose SDR JPEG',
          });
        throw error;
      }
    }

    return this.withOriginalLocationPolicy(auth, { id, ownerId }, 'download', {
      path: filePath,
      fileName: getFileNameWithoutExtension(originalFileName) + getFilenameExtension(filePath),
      contentType: mimeTypes.lookup(filePath),
      // The current version can change under the same URL; a cached copy could be the one before.
      cacheControl: developedPath ? CacheControl.PrivateWithoutCache : CacheControl.PrivateWithCache,
    });
  }

  /**
   * The rendered master of the owner's current develop version: the picture their viewer shows
   * (`viewThumbnail` serves it for an edited preview or full-size request), so a download of the asset
   * as it is shown is that file. Nobody else sees the working version; they are given the edited file
   * or the original as before.
   */
  private async getShownDevelopMaster(auth: AuthDto, id: string, ownerId: string): Promise<string | undefined> {
    if (auth.sharedLink || auth.user.id !== ownerId) {
      return;
    }
    const current = await this.assetRepository.getCurrentDevelop(id);
    if (!current || current.ownerId !== ownerId || !current.masterPath || !hasPublishedDevelopRendition(current)) {
      return;
    }
    return current.masterPath;
  }

  /**
   * FL-54: a file served as-is carries its embedded EXIF/XMP/QuickTime location. For playback through a
   * link that hides metadata serve a verified location-free copy instead; when none can be made, refuse
   * rather than send the original bytes. A link that hides metadata never downloads (AL-27). Every other
   * case is the untouched original (FL-326: partners always see locations).
   */
  private async withOriginalLocationPolicy(
    auth: AuthDto,
    asset: OriginalAsset,
    purpose: OriginalPurpose,
    response: FileDownloadResponse,
  ): Promise<FileDownloadResponse> {
    const policyFor = getOriginalLocationPolicies({ auth, assets: [asset], purpose });

    switch (policyFor(asset)) {
      case OriginalLocationPolicy.Serve: {
        // FL-721: an encrypted Locked file is decrypted for this viewer (`sendFile`)
        return new FileDownloadResponse({ ...response, viewerId: response.viewerId ?? lockedViewerOf(auth) });
      }

      case OriginalLocationPolicy.Refuse: {
        throw new ForbiddenException('Downloads are turned off while metadata is hidden');
      }

      case OriginalLocationPolicy.RemoveLocation: {
        const lease = await this.metadataRepository.acquireLocationFreeOriginal(response.path).catch(() => {
          throw new ForbiddenException('The location of this file could not be removed');
        });
        return new FileDownloadResponse({ ...response, path: lease.path, release: lease.release });
      }
    }
  }

  /**
   * FL-161: whether full-resolution files may go to a request that arrived this way: always, except
   * through the relay while an administrator has not allowed originals there.
   */
  async fullSizeAllowed(via: FrameleafVia | null): Promise<boolean> {
    if (via !== 'relay') {
      return true;
    }
    const { frameleafCloud } = await this.getConfig({ withCache: true });
    return frameleafCloud.remoteAccess.allowOriginalsOverRelay;
  }

  async viewThumbnail(
    auth: AuthDto,
    id: string,
    dto: AssetMediaOptionsDto,
    via: FrameleafVia | null = null,
  ): Promise<FileDownloadResponse | AssetMediaRedirectResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });

    if (dto.size === AssetMediaSize.Original) {
      throw new BadRequestException('May not request original file');
    }

    if (auth.sharedLink) {
      dto.edited = true;
    }

    const size = (dto.size ?? AssetMediaSize.THUMBNAIL) as unknown as AssetFileType;
    const { ownerId, originalPath, originalFileName, path, imageEncoding, isEdited } =
      await this.assetRepository.getForThumbnail(id, size, dto.edited ?? false);

    // Develop revisions keep their own files; legacy asset_file edits do not point at them.
    // Only the owner sees this working version. The face-source request remains on legacy pixels,
    // and getFaceSource refuses drawing while a develop revision is current.
    if (
      !auth.sharedLink &&
      auth.user.id === ownerId &&
      dto.edited === true &&
      !dto.faceSource &&
      (size === AssetFileType.Preview || size === AssetFileType.FullSize)
    ) {
      const current = await this.assetRepository.getCurrentDevelop(id);
      if (current && current.ownerId === ownerId) {
        if (!hasPublishedDevelopRendition(current)) {
          throw new NotFoundException('Current developed preview is unavailable');
        }
        const fullSizeAllowed = size !== AssetFileType.FullSize || (await this.fullSizeAllowed(via));
        const hdrPath =
          size === AssetFileType.FullSize && fullSizeAllowed ? current.hdrMasterPath : current.hdrPreviewPath;
        const hdrEnabled = process.env.FRAMELEAF_HDR_IMAGES === 'experimental';
        if (dto.dynamicRange === 'hdr' && (!hdrEnabled || !hdrPath))
          throw new NotFoundException('Current developed HDR rendition is unavailable');
        const developedPath =
          hdrEnabled && dto.dynamicRange && dto.dynamicRange !== 'sdr' && hdrPath
            ? hdrPath
            : size === AssetFileType.FullSize && fullSizeAllowed
              ? current.masterPath
              : current.previewPath;
        if (!developedPath) {
          throw new NotFoundException('Current developed preview is unavailable');
        }
        return new FileDownloadResponse({
          fileName: `${getFileNameWithoutExtension(originalFileName)}_develop_${size}${getFilenameExtension(developedPath)}`,
          path: developedPath,
          contentType: mimeTypes.lookup(developedPath),
          cacheControl: CacheControl.PrivateWithoutCache,
          viewerId: lockedViewerOf(auth),
        });
      }
    }

    const hdrEnabled = process.env.FRAMELEAF_HDR_IMAGES === 'experimental';
    const hdrSize = size === AssetFileType.Preview || size === AssetFileType.FullSize;
    if (dto.dynamicRange === 'hdr' && (!hdrSize || dto.faceSource)) {
      throw new BadRequestException('HDR is available for focused previews and full-size stills only');
    }
    if (dto.dynamicRange === 'hdr' && !hdrEnabled) throw new NotFoundException('HDR rendition is unavailable');
    if (hdrEnabled && hdrSize && !dto.faceSource && (dto.dynamicRange === 'auto' || dto.dynamicRange === 'hdr')) {
      if (size === AssetFileType.FullSize && !(await this.fullSizeAllowed(via))) {
        return { targetSize: AssetMediaSize.PREVIEW };
      }
      const type = size === AssetFileType.FullSize ? AssetFileType.HdrFullSize : AssetFileType.HdrPreview;
      const hdr = await this.assetRepository.getForThumbnail(id, type, dto.edited ?? false);
      if (hdr.path && hdr.renditionIdentity && /^[a-f0-9]{64}$/.test(hdr.renditionIdentity)) {
        // The worker re-encodes pixels without source EXIF/XMP and validates required HDR metadata.
        // These are sanitized derivatives, as are ordinary previews; original-file stripping is not needed.
        const base = auth.sharedLink && !auth.sharedLink.showExif ? id : getFileNameWithoutExtension(originalFileName);
        return new FileDownloadResponse({
          path: hdr.path,
          fileName: `${base}_${type}.jpg`,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithoutCache,
          viewerId: lockedViewerOf(auth),
        });
      }
      if (dto.dynamicRange === 'hdr') throw new NotFoundException('HDR rendition is unavailable for this still');
    }

    if (
      size === AssetFileType.FullSize &&
      mimeTypes.isWebSupportedImage(originalPath) &&
      // Missing edit evidence must not permit a redirect to unedited pixels.
      // eslint-disable-next-line unicorn/no-unnecessary-boolean-comparison
      (!dto.edited || (dto.dynamicRange && dto.dynamicRange !== 'hdr' && isEdited === false && !dto.faceSource)) &&
      // Never inspected (no HDR processing, or an import from before it) was always served as upstream.
      (imageEncoding ? imageEncoding.dynamicRange === 'sdr' : !hdrEnabled)
    ) {
      // FL-161: through the relay the original is refused unless an administrator allowed it, so the
      // viewer gets the preview instead of a redirect it cannot follow
      if (!(await this.fullSizeAllowed(via))) {
        return { targetSize: AssetMediaSize.PREVIEW };
      }
      if (dto.edited) {
        // Focused viewers ask for current pixels; an unedited SDR source is already full resolution.
        // Follow the original route's permissions and EXIF policy before redirecting.
        const downloads = await this.checkAccess({ auth, permission: Permission.AssetDownload, ids: [id] });
        if (!downloads.has(id) || (auth.sharedLink && !auth.sharedLink.showExif)) {
          return { targetSize: AssetMediaSize.PREVIEW };
        }
      }
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
    const response = new FileDownloadResponse({
      fileName,
      path,
      contentType: mimeTypes.lookup(path),
      cacheControl: CacheControl.PrivateWithCache,
      viewerId: lockedViewerOf(auth),
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

  async downloadVideoEditVersion(auth: AuthDto, id: string, versionId: string): Promise<FileDownloadResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });
    const version = await this.assetEditRepository.getVideoVersion(id, versionId);
    if (!version || version.ownerId !== auth.user.id || version.status !== 'ready' || !version.masterPath)
      throw new NotFoundException('Video version is unavailable');
    return new FileDownloadResponse({
      path: version.masterPath,
      fileName: `${id}-${version.id}.mp4`,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
      viewerId: lockedViewerOf(auth),
    });
  }

  async playbackVideo(auth: AuthDto, id: string, edited = true): Promise<FileDownloadResponse> {
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

  /**
   * FL-97: the Studio HDR intermediate, under exactly the access and location rules of playback
   * (`playbackVideo`), and never through a shared link. It carries no metadata, but the location
   * policy is applied as for any file served for playback. It exists only while no edit is
   * published over the original and the original is the one it was made from.
   */
  async playbackStudioHdrVideo(auth: AuthDto, id: string): Promise<FileDownloadResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    if (auth.sharedLink) {
      throw new NotFoundException('Asset not found');
    }
    const asset = await this.assetRepository.getForVideo(id);
    const path = asset ? (await this.assetRepository.getCurrentStudioHdrIntermediates([id])).get(id) : undefined;
    if (!asset || !path) {
      throw new NotFoundException('No Studio HDR intermediate for this asset yet');
    }
    return this.withOriginalLocationPolicy(auth, { id, ownerId: asset.ownerId }, 'playback', {
      path,
      contentType: 'video/mp4',
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  async bulkUploadCheck(auth: AuthDto, dto: AssetBulkUploadCheckDto): Promise<AssetBulkUploadCheckResponseDto> {
    const checksums: Buffer[] = dto.assets.map((asset) => fromChecksum(asset.checksum));
    // Frameleaf's apps send SHA-256, matched as stored. Upstream Immich clients
    // hash with SHA-1, so resolve those digests through the SHA-1 recorded at
    // upload or by the checksum check. Translating to the stored digest
    // (rather than matching separately) keeps the duplicate lookup on the
    // single filtered query, hidden-content rules included.
    const translations = await this.forkSchemaRepository.getChecksumTranslations(auth.user.id, checksums);
    const lookups = [...checksums, ...translations.map(({ checksum }) => checksum)];
    const duplicateOptions = this.getDuplicateCheckOptions(auth);
    const results = duplicateOptions
      ? await this.assetRepository.getByChecksums(auth.user.id, lookups, duplicateOptions)
      : await this.assetRepository.getByChecksums(auth.user.id, lookups);
    const checksumMap: Record<string, { id: string; isTrashed: boolean }> = {};

    // Media health: a match whose original is gone is accepted, so the upload can restore it. So is a
    // photo in the Trash while the account lets uploads bring them back (FL-556).
    const trashOpen = isTrashReuploadOpen(getPreferences(await this.userRepository.getMetadata(auth.user.id)));
    const present = await Promise.all(
      results.map(async ({ originalPath, deletedAt, status, libraryId, isExternal }) => {
        if (libraryId || isExternal) {
          return true;
        }
        if (deletedAt) {
          return !(trashOpen && status === AssetStatus.Trashed);
        }
        return this.storageRepository.checkFileExists(originalPath);
      }),
    );
    for (const [index, { id, deletedAt, checksum }] of results.entries()) {
      if (present[index]) {
        checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
      }
    }

    for (const { sha1, checksum } of translations) {
      const match = checksumMap[checksum.toString('hex')];
      if (match) {
        checksumMap[sha1.toString('hex')] = match;
      }
    }

    return {
      results: dto.assets.map(({ id }, index) => {
        const duplicate = checksumMap[checksums[index].toString('hex')];
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

  private requireQuota(auth: AuthDto, size: number) {
    if (auth.user.quotaSizeInBytes !== null && auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + size) {
      throw new BadRequestException('Quota has been exceeded!');
    }
  }
}
