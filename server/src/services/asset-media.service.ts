import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import type { Transaction } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { RunOrigin } from 'src/queue/types.js';
import type { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import type { DB } from 'src/schema/index.js';
import type { UploadFile, UploadRequest } from 'src/types.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { Asset, AuthSharedLink, type LockableProperty, lockableProperties } from 'src/database.js';
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
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireUploadAccess, requireUploadsNotPaused } from 'src/utils/access.js';
import { asUploadRequest, getAssetFiles } from 'src/utils/asset.util.js';
import { hexOrBufferToBase64 } from 'src/utils/bytes.js';
import { isAssetChecksumConstraint } from 'src/utils/database.js';
import { hasPublishedDevelopRendition } from 'src/utils/develop-envelope.js';
import { isPhoneSession, phoneName } from 'src/utils/file-steps.js';
import { moveFileWithin, storedCopyChecks } from 'src/utils/file-trash.js';
import {
  FileDownloadResponse,
  getFileNameWithoutExtension,
  getFilenameExtension,
  lockedViewerOf,
} from 'src/utils/file.js';
import { hasFontSignature } from 'src/utils/font-file.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { isLockedPath, makeWorkDir, withPlainCopy } from 'src/utils/locked-read.js';
import { getLockedOwnerId, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { isLockedRow } from 'src/utils/locked.js';
import { LIBRARY_CARE_FOLDER } from 'src/utils/media-health-roots.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { isOfficePreviewFile, withOfficePreview } from 'src/utils/office-preview.js';
import {
  OriginalAsset,
  OriginalLocationPolicy,
  OriginalPurpose,
  getOriginalLocationPolicies,
} from 'src/utils/partner-location.js';
import { getPreferences, isTrashReuploadOpen, uploadSkipSince } from 'src/utils/preferences.js';
import { fromChecksum } from 'src/utils/request.js';
import { MAX_XMP_BYTES, validateXmp } from 'src/utils/xmp-sidecar.js';

/** How long a finished document PDF may take to download before the response is ended. */
const DOCUMENT_REVIEW_HOLD = 5 * 60 * 1000;

export interface AssetMediaRedirectResponse {
  targetSize: AssetMediaSize | 'original';
}

/** Internal callers decide privacy and record their receipt in the asset's publication transaction. */
export type AssetUploadPublication = (
  create: (tx: Transaction<DB>, locked: boolean) => Promise<Asset>,
) => Promise<Asset>;

/** FL-813: the 409 an upload gets when its owner deleted the item and asked for it not to be uploaded again. */
export const DELETED_BY_OWNER = 'deleted_by_owner';

type PreparedUploadOriginal = {
  stored: Awaited<ReturnType<PhysicalFileRepository['linkUploadedOriginal']>>;
};

@Injectable()
export class AssetMediaService extends BaseService {
  async getUploadAssetIdByChecksum(auth: AuthDto, checksum?: string): Promise<AssetMediaResponseDto | undefined> {
    requireUploadAccess(auth);
    // A link visitor may upload, but may not probe the owner's private library before sending a file.
    if (auth.sharedLink || !checksum) {
      return;
    }

    // Upstream Immich clients send SHA-1: match the stored SHA-256 it was recorded for, as bulkUploadCheck does
    const submitted = fromChecksum(checksum);
    const [alias] = await this.forkSchemaRepository.getChecksumTranslations(auth.user.id, [submitted]);
    const digest = alias?.checksum ?? submitted;
    const duplicateOptions = this.getDuplicateCheckOptions(auth);
    const assetId = duplicateOptions
      ? await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, digest, duplicateOptions)
      : await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, digest);
    if (!assetId) {
      // A hidden match: the upload would only come back as this same hidden duplicate, so spare the bytes
      return (await this.withheldDuplicates(auth, [digest])).size > 0
        ? { id: '00000000-0000-0000-0000-000000000000', status: AssetMediaStatus.DUPLICATE }
        : undefined;
    }
    // Its original is gone, or (FL-556) the account lets uploads bring photos back from the Trash:
    // let the file come, the upload restores the photo.
    const checksums = [digest];
    if (
      (await this.lostOriginalMatches(auth, checksums)).length > 0 ||
      (await this.trashedMatches(auth, checksums)).length > 0
    ) {
      return;
    }

    return { id: assetId, status: AssetMediaStatus.DUPLICATE };
  }

  /**
   * Media health: the owner's assets with these bytes that a re-upload puts right. Their original file is
   * gone, or (FL-1472) it is damaged and its finding asks for a re-upload (`damaged`). Those are not
   * duplicates of a re-upload; the upload restores them. Empty when any match still has a good file
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
    const files = await this.originalFiles(matches);
    if (matches.length === 0 || files.includes('good')) {
      return [];
    }
    return matches
      .map((match, index) => ({ ...match, damaged: files[index] === 'damaged' }))
      .filter((match) => !match.deletedAt && !match.libraryId && !match.isExternal);
  }

  /**
   * What each match's original file is: `gone`, `damaged` (FL-1472: there, but its open finding asks for a
   * re-upload) or `good`.
   */
  private async originalFiles(matches: { id: string; originalPath: string }[]) {
    const exists = await Promise.all(
      matches.map(({ originalPath }) => this.storageRepository.checkFileExists(originalPath)),
    );
    const there = matches.filter((_, index) => exists[index]).map(({ id }) => id);
    const wanted = there.length > 0 ? await this.assetRepository.getReuploadWanted(there) : new Set<string>();
    return matches.map(({ id }, index) => (exists[index] ? (wanted.has(id) ? 'damaged' : 'good') : 'gone'));
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
   * FL-813: of these bytes, the ones this account permanently deleted since it asked for deleted items not
   * to be uploaded again, and has not allowed again. Empty while that is off (the default), and for a
   * shared link. Bytes the library still holds, in the Trash included, are never among them, so the FL-556
   * bring-back window and the duplicate answers come first. Another account's deletions never count.
   */
  private async deletedByOwner(auth: AuthDto, checksums: Buffer[]): Promise<Buffer[]> {
    if (auth.sharedLink || checksums.length === 0) {
      return [];
    }
    const since = uploadSkipSince(getPreferences(await this.userRepository.getMetadata(auth.user.id)));
    return since ? this.assetRepository.getUploadSkipped(auth.user.id, checksums, since) : [];
  }

  /**
   * FL-813: an upload of an item on the account's skip list is refused with 409 `deleted_by_owner`, which
   * an app treats as "leave this one out", like FL-296's `icloud_claimed`. Nothing is ever deleted on the
   * device that sent it.
   */
  async refuseDeletedByOwner(auth: AuthDto, checksums: (Buffer | null | undefined)[]): Promise<void> {
    const known = checksums.filter((checksum): checksum is Buffer => !!checksum);
    if ((await this.deletedByOwner(auth, known)).length > 0) {
      throw new ConflictException({ message: DELETED_BY_OWNER, code: DELETED_BY_OWNER });
    }
  }

  /**
   * FL-813: removing the row of an upload that failed half-way is recorded like any removal. It was not the
   * owner's deletion, so those bytes are allowed again at once.
   */
  private async allowFailedUpload(auth: AuthDto, file: UploadFile): Promise<void> {
    if (auth.sharedLink) {
      return;
    }
    const since = uploadSkipSince(getPreferences(await this.userRepository.getMetadata(auth.user.id)));
    if (since) {
      await this.assetRepository.allowUploadSkips(auth.user.id, [file.checksum], since, { includeLocked: true });
    }
  }

  /** FL-813: `refuseDeletedByOwner` for a file that is already here (multipart): a refused file is removed. */
  async refuseDeletedUpload(auth: AuthDto, file: UploadFile, sidecarFile?: UploadFile): Promise<void> {
    try {
      await this.refuseDeletedByOwner(auth, [file.checksum, file.legacyChecksum]);
    } catch (error) {
      await this.jobRepository.queue({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, sidecarFile?.originalPath] },
      });
      throw error;
    }
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
        (await this.restoreOriginalFrom(auth, asset, dto, file, checksums));
      return { id: restored, visible: true, fileUsed };
    }
    const lost = await this.lostOriginalMatches(auth, checksums, { includeHidden: true });
    if (lost.length === 0) {
      return this.restoreOverRepair(auth, file, checksums);
    }
    const isVisible = async (assetId: string) => {
      const options = this.getDuplicateCheckOptions(auth);
      const visible = options ? await this.assetRepository.getByChecksums(auth.user.id, checksums, options) : lost;
      return visible.some(({ id }) => id === assetId);
    };
    // a lost original goes back at once; a damaged one is replaced by Library care, which keeps it beside the copy
    for (const asset of lost) {
      if (!asset.damaged && (await this.restoreOriginalFrom(auth, asset, dto, file, checksums))) {
        return { id: asset.id, visible: await isVisible(asset.id), fileUsed: true };
      }
    }
    const damaged = lost.find(({ damaged }) => damaged);
    if (damaged) {
      await this.queuePutBack(auth, damaged.id, file);
      return { id: damaged.id, visible: await isVisible(damaged.id), fileUsed: true };
    }
  }

  /**
   * FL-1472: the true original of a photo Library care repaired, which no longer has these bytes as its checksum.
   * Library care puts it back in the repair's place. A photo this session may not see answers as hidden.
   */
  private async restoreOverRepair(auth: AuthDto, file: UploadFile, checksums: Buffer[]) {
    if (auth.sharedLink) {
      return;
    }
    if (!file.legacyChecksum && (await this.assetRepository.hasSha1OnlyRepairs(auth.user.id))) {
      // a SHA-1 photo repaired with no SHA-256 of its original on record matches only by SHA-1: hash for it, which
      // is only ever done for an owner who has such a repair
      checksums = [...checksums, (await this.cryptoRepository.hashFileDigests(file.originalPath)).sha1];
    }
    // a Locked photo is repaired too, as a lost one is; its id is only answered when this session may see it
    const id = await this.assetRepository.getRepairedByOriginal(auth.user.id, checksums, {
      lockedOwnerId: auth.user.id,
    });
    if (!id) {
      return;
    }
    await this.queuePutBack(auth, id, file);
    // this very photo, as this session may see it: another repaired photo with the same original never answers for it
    const visible =
      (await this.assetRepository.getRepairedByOriginal(
        auth.user.id,
        checksums,
        this.getDuplicateCheckOptions(auth) ?? {},
      )) === id;
    return { id, visible, fileUsed: true };
  }

  /**
   * FL-1472: Library care's job owns the upload from here, and removes it once it is done with it. The upload moves
   * into the owner's hidden Library care folder first, which neither an upload's clean-up nor the search for
   * untracked files ever touches, so it is there when the job runs.
   */
  private async queuePutBack(auth: AuthDto, id: string, file: UploadFile) {
    const pending = path.join(
      path.dirname(StorageCore.getNestedPath(StorageFolder.Upload, auth.user.id, id)),
      LIBRARY_CARE_FOLDER,
      `${id}-pending-${this.cryptoRepository.randomUUID()}${path.extname(file.originalPath).toLowerCase()}`,
    );
    this.storageRepository.mkdirSync(path.dirname(pending));
    await this.storageRepository.rename(file.originalPath, pending);
    const device = await this.uploadingDevice(auth);
    await this.jobRepository.queue({
      name: JobName.MediaHealthPutBackUpload,
      data: { id, path: pending, ...(device && { device }) },
    });
    this.logger.log(`Upload for asset ${id} queued to take its damaged or repaired file's place`);
  }

  /** FL-1472: the owner's repaired photo whose true original has these bytes, if any (the repair is still in place). */
  async repairedPhotoFor(ownerId: string, checksums: Buffer[]): Promise<{ id: string } | undefined> {
    // the owner's own Locked photos too: only the owner's work asks, never a session that may not see them
    const id = await this.assetRepository.getRepairedByOriginal(ownerId, checksums, { lockedOwnerId: ownerId });
    return id ? { id } : undefined;
  }

  /**
   * FL-1472: whether this session may see the photo an upload put its bytes back under. An upload whose put-back is
   * still queued has no checksum match to prove it by yet. A shared link never sees one, as it never probes.
   */
  async canSeeUploadResult(auth: AuthDto, assetId: string): Promise<boolean> {
    if (auth.sharedLink) {
      return false;
    }
    // without options a session still never sees Locked media: the repository's default leaves it out
    return this.assetRepository.isVisibleToUploader(auth.user.id, assetId, this.getDuplicateCheckOptions(auth) ?? {});
  }

  /**
   * FL-1472: whether a copy of these bytes would put one of the owner's photos right: its original is lost, damaged
   * and its finding asks for a re-upload, or repaired. Hidden photos count, as `restoreLostOriginal` repairs them too.
   */
  async needsOriginal(auth: AuthDto, { checksum, legacyChecksum }: { checksum: Buffer; legacyChecksum?: Buffer }) {
    const checksums = [checksum, ...(legacyChecksum ? [legacyChecksum] : [])];
    return (
      (await this.lostOriginalMatches(auth, checksums, { includeHidden: true })).length > 0 ||
      (!auth.sharedLink &&
        !!(await this.assetRepository.getRepairedByOriginal(auth.user.id, checksums, { lockedOwnerId: auth.user.id })))
    );
  }

  /**
   * FL-1472: an importer's verified copy of a photo the library already has goes back under it when its original is
   * lost or damaged (`restoreLostOriginal`). The copy is removed when no photo took it.
   */
  async restoreFromCopy(auth: AuthDto, dto: AssetMediaCreateDto, file: UploadFile) {
    const restored = await this.restoreLostOriginal(auth, dto, file);
    if (!restored?.fileUsed) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [file.originalPath] } });
    }
    return restored;
  }

  /** What the history calls the device that uploaded: its session's model, else its system. */
  private async uploadingDevice(auth: AuthDto): Promise<string | undefined> {
    if (!auth.session) {
      return;
    }
    const sessionId = auth.session.id;
    const session = (await this.sessionRepository.getByUserId(auth.user.id)).find(({ id }) => id === sessionId);
    // only a phone or tablet is the phone that was asked
    return (session && isPhoneSession(session) && phoneName(session)) || undefined;
  }

  /** FL-1459: where an upload came from, for its run: its session's phone or computer, else the app or shared link. */
  private async uploadOrigin(auth: AuthDto): Promise<{ origin: RunOrigin; label: string | null }> {
    if (auth.sharedLink) {
      return { origin: 'link', label: null };
    }
    if (auth.session) {
      const sessionId = auth.session.id;
      const session = (await this.sessionRepository.getByUserId(auth.user.id)).find(({ id }) => id === sessionId);
      return {
        origin: session && isPhoneSession(session) ? 'phone' : 'computer',
        label: (session && phoneName(session)) || null,
      };
    }
    if (auth.oauthApp) {
      return { origin: 'client', label: auth.oauthApp.clientName };
    }
    const key = auth.apiKey ? await this.apiKeyRepository.getById(auth.user.id, auth.apiKey.id) : undefined;
    return { origin: 'client', label: key?.name ?? null };
  }

  private async restoreOriginalFrom(
    auth: AuthDto,
    asset: { id: string; originalPath: string },
    dto: AssetMediaCreateDto,
    file: UploadFile,
    checksums: Buffer[],
  ) {
    const sha1 = file.legacyChecksum ?? (await this.cryptoRepository.hashFileDigests(file.originalPath)).sha1;
    const device = await this.uploadingDevice(auth);
    const restored = await this.physicalFileRepository.restoreLostOriginal({
      assetId: asset.id,
      expectedOriginalPath: asset.originalPath,
      originalPath: file.originalPath,
      sha1,
      sha256: checksums[0],
      sizeInBytes: file.size,
      reason: 'restored_by_upload',
      // FL-1337: the upload is the true original, so the history gets no undo
      finding: {
        evidence: { fixState: 'found-again' },
        steps: [
          ...(device ? [{ step: 'asked-phones' as const, outcome: 'ok' as const, facts: { device } }] : []),
          { step: 'put-back', outcome: 'ok' },
        ],
      },
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
        // Boards preserves native fonts and downloadable originals. Scope must precede the file in multipart.
        if (
          body.libraryScope === LibraryScope.Design &&
          (mimeTypes.isFont(filename) || (!auth?.sharedLink && body.publication === undefined))
        ) {
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
      [UploadFieldName.ASSET_DATA]: mimeTypes.uploadExtension(body.filename || file.originalName),
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
  async replaceSidecar(auth: AuthDto, id: string, data: Buffer, useFileValues: boolean): Promise<void> {
    if (auth.sharedLink) throw new ForbiddenException('Only the owner can replace a sidecar');
    const check = (asset: Awaited<ReturnType<AssetRepository['getById']>>) => {
      if (!asset || asset.ownerId !== auth.user.id || asset.deletedAt || isLockedRow(asset)) {
        throw new ForbiddenException('Only the owner of an unlocked asset can replace its sidecar');
      }
      if (asset.type !== AssetType.Image || asset.isOffline) {
        throw new BadRequestException('An XMP sidecar requires an available photo');
      }
      return asset;
    };
    check(await this.assetRepository.getById(id));
    validateXmp(data);
    const directory = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, id);
    const next = path.join(directory, `${id}-${randomUUID()}.xmp`);
    const backup = `${next}.bak`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(next, data, { flag: 'wx', mode: 0o600 });
    try {
      const tags = useFileValues ? await this.metadataRepository.readTags(next) : {};
      const properties: LockableProperty[] = [];
      if ('Description' in tags || 'ImageDescription' in tags) properties.push('description');
      if ('DateTimeOriginal' in tags || 'CreateDate' in tags) properties.push('dateTimeOriginal', 'timeZone');
      if ('GPSLatitude' in tags && 'GPSLongitude' in tags)
        properties.push('latitude', 'longitude', 'city', 'state', 'country');
      if ('Rating' in tags) properties.push('rating');
      if (['TagsList', 'HierarchicalSubject', 'Subject', 'Keywords'].some((key) => key in tags))
        properties.push('tags');
      const creditFields: Record<string, string[]> = {
        title: ['Title', 'ObjectName', 'XPTitle'],
        artist: ['Creator', 'Artist', 'ByLine'],
        copyright: ['Rights', 'Copyright', 'CopyrightNotice'],
      };
      for (const property of lockableProperties) {
        if (creditFields[property]?.some((key) => key in tags)) properties.push(property);
      }

      await this.databaseRepository.withAssetSidecarLock(id, async (tx) => {
        const assets = new AssetRepository(tx);
        const asset = check(await assets.getById(id, { files: true }));
        const { sidecarFile } = getAssetFiles(asset.files ?? []);
        if (sidecarFile) await copyFile(sidecarFile.path, backup);
        await assets.upsertFile({ assetId: id, path: next, type: AssetFileType.Sidecar }, tx);
        if (properties.length > 0) await assets.unlockProperties(id, properties, tx);
        await this.jobRepository.queueInTransaction(tx, {
          name: JobName.AssetExtractMetadata,
          data: { id, replacementSidecar: next },
        });
      });
    } catch (error) {
      // Once published, a retry must never remove bytes the asset references.
      const current = await this.assetRepository.getById(id, { files: true });
      if (current && getAssetFiles(current.files ?? []).sidecarFile?.path !== next) {
        await Promise.all([rm(next, { force: true }), rm(backup, { force: true })]);
      }
      throw error;
    }
  }

  async prepareUploadAsset(auth: AuthDto, dto: AssetMediaCreateDto, file: UploadFile) {
    await this.requireAccess({
      auth,
      permission: Permission.AssetUpload,
      // do not need an id here, but the interface requires it
      ids: [auth.user.id],
    });

    requireUploadsNotPaused(auth);
    this.requireQuota(auth, file.size);
    if (
      mimeTypes.isBoardOriginal(file.originalPath) &&
      (dto.libraryScope !== LibraryScope.Design || auth.sharedLink || dto.livePhotoVideoId)
    ) {
      throw new BadRequestException(`Unsupported file type ${dto.filename || file.originalName}`);
    }
    if (mimeTypes.isFont(file.originalPath)) {
      // FL-1359: fonts live in Boards only, and the file must be the font type its name says.
      const head = await this.storageRepository.readFile(file.originalPath, { buffer: Buffer.alloc(8), length: 8 });
      if (dto.libraryScope !== LibraryScope.Design || !hasFontSignature(head, file.originalPath)) {
        throw new BadRequestException(`Unsupported file type ${dto.filename || file.originalName}`);
      }
    }

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

  private uploadOriginalChecks(assetId: string, file: UploadFile) {
    const checks = storedCopyChecks(
      this.storageRepository,
      this.cryptoRepository,
      { checksum: file.checksum, sizeInBytes: file.size },
      (path) => this.logger.warn(`Upload ${assetId} keeps its own file: the stored copy at ${path} holds other bytes`),
    );
    return {
      ...checks,
      // A sealed Locked file cannot stand in for a plaintext upload, including one sealed meanwhile.
      verify: async (path: string) => ((await isLockedPath(path)) ? null : checks.verify(path)),
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
      preparedOriginal?: PreparedUploadOriginal;
      quotaCharged?: boolean;
      ingestion?: { resourceId: string; token: string; ownerId: string };
      checkIngestion?: () => Promise<void>;
      /** FL-1478: an importer names itself; otherwise the upload's own session, app or link does. */
      origin?: { origin: RunOrigin; label: string | null };
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
    if (!options.preparedFile && !options.preparedOriginal) {
      await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
    }
    if (!options.quotaCharged && !options.preparedOriginal) {
      await this.assetRepository.upsertExif({
        exif: { assetId: asset.id, fileSizeInByte: file.size },
        lockedPropertiesBehavior: 'override',
      });
    }

    // universal storage: one file per content, server-wide. Content another library already holds is
    // linked to that file and the upload released; new content becomes its own primary file. FL-412: only
    // a stored file proven to hold the same bytes replaces the upload's own copy.
    const expected = { checksum: file.checksum, sizeInBytes: file.size };
    const stored = options.preparedOriginal
      ? options.preparedOriginal.stored
      : await this.physicalFileRepository.linkUploadedOriginal(asset.id, expected, {
          ...this.uploadOriginalChecks(asset.id, file),
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
    // FL-1459: the upload joins its device's run; a live photo's hidden motion part comes in without counting
    await this.jobRepository.queueUpload(
      { name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } },
      {
        ownerId: asset.ownerId,
        ...(options.origin ?? (await this.uploadOrigin(auth))),
        count: asset.visibility === AssetVisibility.Hidden ? 0 : 1,
      },
    );

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
    publication?: AssetUploadPublication,
    origin?: { origin: RunOrigin; label: string | null },
  ): Promise<AssetMediaResponseDto> {
    let asset: Asset | undefined;
    try {
      if (publication && (sidecarFile || dto.livePhotoVideoId)) {
        throw new BadRequestException('Guarded publication requires an independent original without a sidecar');
      }
      if (sidecarFile) {
        if (sidecarFile.size > MAX_XMP_BYTES) throw new BadRequestException('An XMP sidecar is limited to 1 MiB');
        validateXmp(await readFile(sidecarFile.originalPath));
      }
      const prepared = await this.prepareUploadAsset(auth, dto, file);
      if (publication) {
        const id = this.cryptoRepository.randomUUID();
        const expected = { checksum: file.checksum, sizeInBytes: file.size };
        const checks = this.uploadOriginalChecks(id, file);
        await this.storageRepository.utimes(file.originalPath, new Date(), new Date(dto.fileModifiedAt));
        const proof = await this.physicalFileRepository.proveStoredCopy(id, expected, checks.verify);
        let original: PreparedUploadOriginal | undefined;
        // The caller takes its final privacy decision after long file work, together with creation
        // and its receipt. Do not repair a newly appeared existing asset outside that boundary;
        // the checksum constraint below makes it a match without adopting any uploaded bytes.
        asset = await publication(async (tx, locked) => {
          const created = await this.assetRepository.create(
            { ...prepared.asset, id },
            prepared.lock ?? (locked ? { reason: AssetLockReason.Marked, lockedBy: auth.user.id } : undefined),
            tx,
          );
          await this.assetRepository.upsertExif(
            { exif: { assetId: created.id, fileSizeInByte: file.size }, lockedPropertiesBehavior: 'override' },
            tx,
          );
          // Adopt the proof without another hash. If it is stale, keep the verified upload; moving
          // an unused file across filesystems would put long I/O inside the publication transaction.
          original = {
            stored: await this.physicalFileRepository.linkUploadedOriginal(created.id, expected, checks, {
              transaction: tx,
              proof,
            }),
          };
          return created;
        });
        if (!original || asset.id !== id) throw new InternalServerErrorException('Upload was not published');
        await this.finishUploadAsset(auth, dto, file, asset, undefined, { preparedOriginal: original, origin });
        return { id: asset.id, status: AssetMediaStatus.CREATED };
      }
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
      await this.finishUploadAsset(auth, dto, file, asset, sidecarFile, { origin });

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
        // FL-813: the owner did not delete this one; the next try must not be refused as if they had
        await this.allowFailedUpload(auth, file).catch((allowError: unknown) =>
          this.logger.warn(`A failed upload could not be kept off the skip list: ${String(allowError)}`),
        );
      }

      this.logger.error(`Error uploading file ${error}`, error?.stack);
      throw error;
    }
  }

  private activeDocumentReviews = 0;

  private async reviewDocument(
    auth: AuthDto,
    id: string,
    ownerId: string,
    originalPath: string,
    originalFileName: string,
    signal?: AbortSignal,
  ): Promise<FileDownloadResponse> {
    if (!originalPath || !isOfficePreviewFile(originalFileName)) {
      throw new NotFoundException('Document preview is unavailable');
    }
    if (
      getOriginalLocationPolicies({ auth, assets: [{ id, ownerId }], purpose: 'download' })({ id, ownerId }) !==
      OriginalLocationPolicy.Serve
    ) {
      throw new ForbiddenException('Downloads are turned off while metadata is hidden');
    }
    if (this.activeDocumentReviews >= 2) {
      throw new ServiceUnavailableException('Document previews are busy. Try again shortly.');
    }

    // A slot is held until the PDF is released after delivery. Delivery ends after DOCUMENT_REVIEW_HOLD,
    // so a stalled download cannot keep a slot, or its PDF in temporary storage, indefinitely.
    this.activeDocumentReviews++;
    let directory: string | undefined;
    let released = false;
    const release = async () => {
      if (released) {
        return;
      }
      released = true;
      this.activeDocumentReviews--;
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    };
    try {
      directory = await makeWorkDir('document-review', await isLockedPath(originalPath));
      const output = path.join(directory, 'review.pdf');
      const rendered = await withPlainCopy(
        originalPath,
        (source) =>
          withOfficePreview(
            source,
            originalFileName,
            async (pdf) => {
              await copyFile(pdf, output);
              return true;
            },
            { allPages: true, signal },
          ),
        { viewerId: lockedViewerOf(auth) },
      );
      if (!rendered) {
        throw new NotFoundException('Document preview is unavailable');
      }
      signal?.throwIfAborted();
      await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: [id] });
      const current = await this.assetRepository.getForOriginal(id, false);
      if (current.ownerId !== ownerId || current.originalPath !== originalPath) {
        throw new ConflictException('This document changed during preview');
      }
      return new FileDownloadResponse({
        path: output,
        release,
        deliveryTimeout: DOCUMENT_REVIEW_HOLD,
        contentType: 'application/pdf',
        fileName: `${getFileNameWithoutExtension(originalFileName)}.pdf`,
        cacheControl: CacheControl.PrivateWithoutCache,
      });
    } catch (error) {
      await release();
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

    const { format } = dto;
    if (format === 'document-pdf') {
      return this.reviewDocument(auth, id, ownerId, originalPath!, originalFileName, signal);
    }

    // Downloaded as shown (owner, 2026-10-16): the owner's viewer shows their current develop version.
    const developedPath = dto.edited && !format ? await this.getShownDevelopMaster(auth, id, ownerId) : undefined;
    const filePath = developedPath ?? editedPath ?? originalPath!;
    if (format) {
      const source = await this.assetRepository.getById(id);
      if (!source || source.type !== AssetType.Image || source.originalPath !== filePath)
        throw new BadRequestException('Still exports require an unedited photo; export a saved edit from its version');
      const policy = getOriginalLocationPolicies({ auth, assets: [source], purpose: 'download' });
      if (policy(source) !== OriginalLocationPolicy.Serve)
        throw new ForbiddenException('Downloads are turned off while metadata is hidden');
      if (format !== 'sdr-jpeg' && process.env.FRAMELEAF_HDR_IMAGES !== 'experimental')
        throw new NotFoundException('HDR export is unavailable');
      if (format === 'hdr-heic' && !(await this.mediaRepository.getHdrCodecCapabilities())?.heicPqEncoder)
        throw new BadRequestException({
          code: 'hdr_heic_export_unavailable',
          message: 'HDR HEIC export is unavailable',
        });
      const checksum = Buffer.from(source.checksum);
      // FL-721 (spec §8): a sealed source's full-size export is written inside the locked tmpfs folder
      const folder = await makeWorkDir('photo-export', await isLockedPath(filePath));
      const heic = format === 'hdr-heic';
      const output = path.join(folder, heic ? 'still_hdr.heic' : 'still.jpg');
      const release = () =>
        void rm(folder, { recursive: true, force: true }).catch(() => {
          this.logger.warn('Unable to remove a temporary still export');
        });
      try {
        // FL-721: a sealed original is exported from a plain copy, for a viewer allowed its key
        await withPlainCopy(
          filePath,
          (input) => this.mediaRepository.exportPhotoStill(input, output, format, checksum, signal),
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
          fileName: `${getFileNameWithoutExtension(originalFileName)}_still_${format}.${heic ? 'heic' : 'jpg'}`,
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

    const boardOriginal = !developedPath && !editedPath && mimeTypes.isBoardOriginal(originalFileName);
    return this.withOriginalLocationPolicy(auth, { id, ownerId }, 'download', {
      path: filePath,
      fileName: boardOriginal
        ? originalFileName
        : getFileNameWithoutExtension(originalFileName) + getFilenameExtension(filePath),
      contentType: boardOriginal
        ? (mimeTypes.boardAudioType(originalFileName) ?? 'application/octet-stream')
        : mimeTypes.lookup(filePath),
      ...(boardOriginal && { attachment: true }),
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
    const { ownerId, originalPath, originalFileName, path, imageEncoding, isEdited, thumbhash } =
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
      // ponytail: thumbnails only. Previews change with the owner's playback choice while the thumbhash stays (FL-115).
      cacheControl:
        size === AssetFileType.Thumbnail && thumbhash && dto.c === hexOrBufferToBase64(thumbhash)
          ? CacheControl.PrivateImmutable
          : CacheControl.PrivateWithCache,
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
    const managed = results.filter(({ deletedAt, libraryId, isExternal }) => !deletedAt && !libraryId && !isExternal);
    // FL-1472: a damaged original whose finding asks for a re-upload has no good file either
    const files = await this.originalFiles(managed);
    const good = new Map(managed.map(({ id }, index) => [id, files[index] === 'good'] as const));
    const present = results.map(({ id, deletedAt, status, libraryId, isExternal }) => {
      if (libraryId || isExternal) {
        return true;
      }
      if (deletedAt) {
        return !(trashOpen && status === AssetStatus.Trashed);
      }
      return good.get(id) ?? true;
    });
    for (const [index, { id, deletedAt, checksum }] of results.entries()) {
      if (present[index]) {
        checksumMap[checksum.toString('hex')] = { id, isTrashed: !!deletedAt };
      }
    }

    const withheld = await this.withheldDuplicates(
      auth,
      lookups.filter((checksum) => results.every((match) => !match.checksum.equals(checksum))),
    );
    // FL-813: what the account deleted and asked not to have uploaded again would be refused
    const deleted = new Set((await this.deletedByOwner(auth, lookups)).map((checksum) => checksum.toString('hex')));

    for (const { sha1, checksum } of translations) {
      const match = checksumMap[checksum.toString('hex')];
      if (match) {
        checksumMap[sha1.toString('hex')] = match;
      }
      if (deleted.has(checksum.toString('hex'))) {
        deleted.add(sha1.toString('hex'));
      }
      if (withheld.has(checksum.toString('hex'))) {
        withheld.add(sha1.toString('hex'));
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
        if (withheld.has(checksums[index].toString('hex'))) {
          // no id and no Trash flag: the match stays unnamed, as the upload itself would answer
          return { id, action: AssetUploadAction.REJECT, reason: AssetRejectReason.DUPLICATE };
        }
        if (deleted.has(checksums[index].toString('hex'))) {
          // a new field, not a new reason: apps decode `reason` strictly
          return { id, action: AssetUploadAction.REJECT, deletedByOwner: true };
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

  /**
   * Of these bytes (ones the named lookup found nothing for), those an upload would answer as a hidden
   * duplicate: the owner's copy is Locked media this session has not unlocked, or hidden by NSFW privacy
   * mode, and its file is good or it is in the Trash. Telling the client before it sends the file names
   * nothing the upload's own answer does not; it only spares the transfer. A lost or damaged original is
   * left out: the upload repairs it. Never for a shared link, which must send the file first.
   */
  private async withheldDuplicates(auth: AuthDto, checksums: Buffer[]): Promise<Set<string>> {
    if (auth.sharedLink || checksums.length === 0 || (getLockedOwnerId(auth) && !auth.hideNsfwAssets)) {
      return new Set();
    }
    const matches = (
      await this.assetRepository.getByChecksums(auth.user.id, checksums, { lockedOwnerId: auth.user.id })
    ).filter(({ libraryId, isExternal }) => !libraryId && !isExternal);
    const files = await this.originalFiles(matches);
    return new Set(
      matches
        .filter(({ deletedAt }, index) => deletedAt || files[index] === 'good')
        .map(({ checksum }) => checksum.toString('hex')),
    );
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
