import { dirname, join, resolve } from 'node:path';
import type { VideoInterfaces } from 'src/types.js';
import { StorageAsset } from 'src/database.js';
import {
  AssetFileType,
  AssetPathType,
  ImageFormat,
  PathType,
  PersonPathType,
  RawExtractedFormat,
  StorageFolder,
} from 'src/enum.js';
import {
  ASSET_MOVE_PATH_TYPES,
  AssetMovePathType,
  AssetRepository,
  getStagedMovePath,
} from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MoveRepository } from 'src/repositories/move.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getAssetFile } from 'src/utils/asset.util.js';
import { getConfig } from 'src/utils/config.js';

export interface MoveRequest {
  entityId: string;
  /** a person is owned, so the owner is needed to save the new path */
  ownerId?: string;
  pathType: PathType;
  oldPath: string | null;
  newPath: string;
  assetInfo?: {
    sizeInBytes: number;
    checksum: Buffer;
  };
}

export type ThumbnailPathEntity = { id: string; ownerId: string };

export type PersonThumbnailPathEntity = { personGroupId: string; ownerId: string };

export type HlsSessionFolder = { ownerId: string; sessionId: string };

export type HlsVariantFolder = { ownerId: string; sessionId: string; variantIndex: number };

export type ImagePathOptions = { fileType: AssetFileType; format: ImageFormat | RawExtractedFormat; isEdited: boolean };

let instance: StorageCore | null;

let mediaLocation: string | undefined;

export class StorageCore {
  /** FL-179: recorded moves already reported as mismatched, so a nightly retry does not warn again. */
  private reportedMismatches = new Set<string>();

  private constructor(
    private assetRepository: AssetRepository,
    private configRepository: ConfigRepository,
    private cryptoRepository: CryptoRepository,
    private moveRepository: MoveRepository,
    private personRepository: PersonRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(StorageCore.name);
  }

  static create(
    assetRepository: AssetRepository,
    configRepository: ConfigRepository,
    cryptoRepository: CryptoRepository,
    moveRepository: MoveRepository,
    personRepository: PersonRepository,
    storageRepository: StorageRepository,
    systemMetadataRepository: SystemMetadataRepository,
    logger: LoggingRepository,
  ) {
    if (!instance) {
      instance = new StorageCore(
        assetRepository,
        configRepository,
        cryptoRepository,
        moveRepository,
        personRepository,
        storageRepository,
        systemMetadataRepository,
        logger,
      );
    }

    return instance;
  }

  static reset() {
    instance = null;
  }

  static getMediaLocation(): string {
    if (mediaLocation === undefined) {
      throw new Error('Media location is not set.');
    }

    return mediaLocation;
  }

  static setMediaLocation(location: string) {
    mediaLocation = location;
  }

  static getFolderLocation(folder: StorageFolder, userId: string) {
    return join(StorageCore.getBaseFolder(folder), userId);
  }

  static getLibraryFolder(user: { storageLabel: string | null; id: string }) {
    return join(StorageCore.getBaseFolder(StorageFolder.Library), user.storageLabel || user.id);
  }

  static getBaseFolder(folder: StorageFolder) {
    return join(StorageCore.getMediaLocation(), folder);
  }

  static getPersonThumbnailPath(person: PersonThumbnailPathEntity) {
    return StorageCore.getNestedPath(StorageFolder.Thumbnails, person.ownerId, `${person.personGroupId}.jpeg`);
  }

  static getImagePath(asset: ThumbnailPathEntity, { fileType, format, isEdited }: ImagePathOptions) {
    return StorageCore.getNestedPath(
      StorageFolder.Thumbnails,
      asset.ownerId,
      `${asset.id}_${fileType}${isEdited ? '_edited' : ''}.${format}`,
    );
  }

  static getEncodedVideoPath(asset: ThumbnailPathEntity) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${asset.id}.mp4`);
  }

  static getHlsSessionFolder({ ownerId, sessionId }: HlsSessionFolder) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, ownerId, sessionId);
  }

  static getHlsVariantFolder({ ownerId, sessionId, variantIndex }: HlsVariantFolder) {
    return join(StorageCore.getHlsSessionFolder({ ownerId, sessionId }), variantIndex.toString());
  }

  static getAndroidMotionPath(asset: ThumbnailPathEntity, uuid: string) {
    return StorageCore.getNestedPath(StorageFolder.EncodedVideo, asset.ownerId, `${uuid}-MP.mp4`);
  }

  static isAndroidMotionPath(originalPath: string) {
    return originalPath.startsWith(StorageCore.getBaseFolder(StorageFolder.EncodedVideo));
  }

  static isImmichPath(path: string) {
    const resolvedPath = resolve(path);
    const resolvedAppMediaLocation = StorageCore.getMediaLocation();
    const normalizedPath = resolvedPath.endsWith('/') ? resolvedPath : resolvedPath + '/';
    const normalizedAppMediaLocation = resolvedAppMediaLocation.endsWith('/')
      ? resolvedAppMediaLocation
      : resolvedAppMediaLocation + '/';
    return normalizedPath.startsWith(normalizedAppMediaLocation);
  }

  async moveAssetImage(asset: StorageAsset, fileType: AssetFileType, format: ImageFormat) {
    const { id: entityId, files } = asset;
    const oldFile = getAssetFile(files, fileType, { isEdited: false });
    return this.moveFile({
      entityId,
      pathType: fileType,
      oldPath: oldFile?.path || null,
      newPath: StorageCore.getImagePath(asset, { fileType, format, isEdited: false }),
    });
  }

  async moveAssetVideo(asset: StorageAsset) {
    const encodedVideoFile = getAssetFile(asset.files, AssetFileType.EncodedVideo, { isEdited: false });
    return this.moveFile({
      entityId: asset.id,
      pathType: AssetPathType.EncodedVideo,
      oldPath: encodedVideoFile?.path || null,
      newPath: StorageCore.getEncodedVideoPath(asset),
    });
  }

  async movePersonFile(person: PersonThumbnailPathEntity & { thumbnailPath: string }, pathType: PersonPathType) {
    const { ownerId, personGroupId, thumbnailPath } = person;
    switch (pathType) {
      case PersonPathType.Face: {
        await this.moveFile({
          entityId: personGroupId,
          ownerId,
          pathType,
          oldPath: thumbnailPath,
          newPath: StorageCore.getPersonThumbnailPath(person),
        });
      }
    }
  }

  /** Whether the file is at `newPath` and recorded there when this returns. */
  async moveFile(request: MoveRequest): Promise<boolean> {
    const { entityId, ownerId, pathType, oldPath, newPath, assetInfo } = request;
    if (!oldPath) {
      return false;
    }
    if (oldPath === newPath) {
      return true;
    }

    this.ensureFolders(newPath);

    let move = await this.moveRepository.getByEntity(entityId, pathType);
    if (move) {
      this.logger.log(`Attempting to finish incomplete move: ${move.oldPath} => ${move.newPath}`);
      const isOldPathExists = await this.storageRepository.checkFileExists(move.oldPath);
      const isNewPathExists = await this.storageRepository.checkFileExists(move.newPath);
      const newPathCheck = isNewPathExists ? move.newPath : null;
      const actualPath = isOldPathExists ? move.oldPath : newPathCheck;
      if (!actualPath) {
        this.logger.warn('Unable to complete move. File does not exist at either location.');
        return false;
      }

      const isFileAtNewLocation = actualPath === move.newPath;
      this.logger.log(`Found file at ${isFileAtNewLocation ? 'new' : 'old'} location`);

      if (
        isFileAtNewLocation &&
        !(await this.verifyNewPathContentsMatchesExpected(move.oldPath, move.newPath, assetInfo))
      ) {
        this.logger.fatal(
          `Skipping move as file verification failed, old file is missing and new file is different to what was expected`,
        );
        return false;
      }

      // FL-179: a copy an interrupted attempt staged for the recorded new path is not needed any more
      if (move.newPath !== newPath) {
        await this.removeStaged(getStagedMovePath(move.newPath, move.id));
      }
      move = await this.moveRepository.update(move.id, { id: move.id, oldPath: actualPath, newPath });
    } else {
      move = await this.moveRepository.create({ entityId, pathType, oldPath, newPath });
    }

    if (pathType === AssetPathType.Original && !assetInfo) {
      this.logger.warn(`Unable to complete move. Missing asset info for ${entityId}`);
      return false;
    }

    const source = move.oldPath;

    if (!ASSET_MOVE_PATH_TYPES.has(pathType)) {
      if (source !== newPath && !(await this.moveAcrossFilesystems(source, newPath, move.id, assetInfo))) {
        return false;
      }
      await this.savePath(pathType, entityId, newPath, ownerId);
      await this.moveRepository.delete(move.id);
      return true;
    }

    // FL-179: an asset's file is moved and its new path saved as one unit, under the path locks and the
    // asset's row lock, so the move cannot race the asset's removal. Only a rename runs in that unit; a
    // move across filesystems is copied and verified first, beside the new path, and then renamed. The
    // move stays recorded until the new path is saved, so one interrupted in between is finished next time.
    const request = {
      moveId: move.id,
      assetId: entityId,
      pathType: pathType as AssetMovePathType,
      from: oldPath,
      source,
      to: newPath,
    };
    // what the filesystem side did, set from inside the move's transaction
    const state = { crossDevice: false, placed: false };
    let result = await this.assetRepository.moveFile(request, {
      rename: async () => {
        if (source === newPath) {
          return true;
        }
        const renamed = await this.rename(source, newPath);
        state.crossDevice = renamed === 'cross-device';
        return renamed === 'renamed';
      },
      undo: () => (source === newPath ? Promise.resolve() : this.undoRename(newPath, source)),
      finish: () => Promise.resolve(),
    });

    if (result === 'failed' && state.crossDevice) {
      const staged = await this.stageCopy(source, getStagedMovePath(newPath, move.id), assetInfo);
      if (!staged) {
        return false;
      }
      try {
        result = await this.assetRepository.moveFile(request, {
          rename: async () => {
            state.placed = (await this.rename(staged, newPath)) === 'renamed';
            return state.placed;
          },
          // the source is untouched until the new path is saved
          undo: async () => {
            state.placed = false;
            await this.undoRename(newPath, staged);
          },
          finish: () => this.removeSource(source),
        });
      } finally {
        if (!state.placed) {
          await this.removeStaged(staged);
        }
      }
    }

    if (result === 'removed') {
      this.logger.log(`Skipped moving ${oldPath}: asset ${entityId} was removed`);
    } else if (result === 'changed') {
      this.logger.log(`Skipped moving ${oldPath}: asset ${entityId} no longer uses it`);
    } else if (result === 'deferred') {
      this.logger.log(`Deferred moving ${oldPath}: records that cannot change now name it; the nightly job retries`);
    } else if (result === 'mismatched') {
      const message = `Deferred moving ${oldPath}: asset ${entityId} is mapped to another file; the move is kept until they agree`;
      // retried every night: reported once per recorded move
      if (this.reportedMismatches.has(move.id)) {
        this.logger.debug(message);
      } else {
        this.reportedMismatches.add(move.id);
        this.logger.warn(message);
      }
    }
    return result === 'moved';
  }

  /** Renames in place; a move to another filesystem is reported rather than attempted. */
  private async rename(from: string, to: string): Promise<'renamed' | 'cross-device' | 'failed'> {
    try {
      this.logger.debug(`Attempting to rename file: ${from} => ${to}`);
      await this.storageRepository.rename(from, to);
      return 'renamed';
    } catch (error: any) {
      if (error.code === 'EXDEV') {
        return 'cross-device';
      }
      this.logger.warn(
        `Unable to complete move. Error renaming file with code ${error.code} and message: ${error.message}`,
      );
      return 'failed';
    }
  }

  /** Puts a renamed file back where the rows still name it. Never throws. */
  private async undoRename(from: string, to: string) {
    try {
      await this.storageRepository.rename(from, to);
    } catch (error: any) {
      this.logger.warn(`Unable to move ${from} back to ${to}; the recorded move finishes it: ${error}`);
    }
  }

  /**
   * Copies a file to `staged`, beside its new path (so the final step is a rename on one filesystem),
   * and verifies the copy. Returns the staged path, or nothing when the copy failed or did not match,
   * having removed it.
   */
  private async stageCopy(
    source: string,
    staged: string,
    assetInfo?: { sizeInBytes: number; checksum: Buffer },
  ): Promise<string | undefined> {
    this.logger.debug(`Unable to rename file. Falling back to copy, verify and delete`);
    try {
      await this.storageRepository.copyFile(source, staged);
      if (!(await this.verifyNewPathContentsMatchesExpected(source, staged, assetInfo))) {
        this.logger.warn(`Skipping move due to file size mismatch`);
        await this.removeStaged(staged);
        return;
      }
      const { atime, mtime } = await this.storageRepository.stat(source);
      await this.storageRepository.utimes(staged, atime, mtime);
      return staged;
    } catch (error: any) {
      this.logger.warn(`Unable to copy ${source} for its move: ${error}`);
      await this.removeStaged(staged);
    }
  }

  private async removeStaged(staged: string) {
    try {
      await this.storageRepository.unlink(staged);
    } catch (error: any) {
      this.logger.warn(`Unable to remove the temporary copy ${staged}: ${error}`);
    }
  }

  private async removeSource(source: string) {
    try {
      await this.storageRepository.unlink(source);
    } catch (error: any) {
      this.logger.warn(`Unable to delete old file, it will now no longer be tracked by Immich: ${error.message}`);
    }
  }

  /** A move that is not an asset's (a person's thumbnail): rename, or copy, verify and delete. */
  private async moveAcrossFilesystems(
    source: string,
    to: string,
    moveId: string,
    assetInfo?: { sizeInBytes: number; checksum: Buffer },
  ): Promise<boolean> {
    const renamed = await this.rename(source, to);
    if (renamed !== 'cross-device') {
      return renamed === 'renamed';
    }
    const staged = await this.stageCopy(source, getStagedMovePath(to, moveId), assetInfo);
    if (!staged) {
      return false;
    }
    if ((await this.rename(staged, to)) !== 'renamed') {
      await this.removeStaged(staged);
      return false;
    }
    await this.removeSource(source);
    return true;
  }

  private async verifyNewPathContentsMatchesExpected(
    oldPath: string,
    newPath: string,
    assetInfo?: { sizeInBytes: number; checksum: Buffer },
  ) {
    const oldStat = await this.storageRepository.stat(oldPath);
    const newStat = await this.storageRepository.stat(newPath);
    const oldPathSize = assetInfo ? assetInfo.sizeInBytes : oldStat.size;
    const newPathSize = newStat.size;
    this.logger.debug(`File size check: ${newPathSize} === ${oldPathSize}`);
    if (newPathSize !== oldPathSize) {
      this.logger.warn(`Unable to complete move. File size mismatch: ${newPathSize} !== ${oldPathSize}`);
      return false;
    }
    const repos = {
      configRepo: this.configRepository,
      metadataRepo: this.systemMetadataRepository,
      logger: this.logger,
    };
    const config = await getConfig(repos, { withCache: true });
    if (assetInfo && config.storageTemplate.hashVerificationEnabled) {
      const { checksum } = assetInfo;
      // Match algorithm to the stored checksum length (SHA-1 = 20 bytes legacy,
      // SHA-256 = 32 bytes new). Re-uploads in either era should verify cleanly.
      const newChecksum = await this.cryptoRepository.hashFileMatching(newPath, checksum);
      if (!newChecksum.equals(checksum)) {
        this.logger.warn(
          `Unable to complete move. File checksum mismatch: ${newChecksum.toString('base64')} !== ${checksum.toString(
            'base64',
          )}`,
        );
        return false;
      }
      this.logger.debug(`File checksum check: ${newChecksum.toString('base64')} === ${checksum.toString('base64')}`);
    }
    return true;
  }

  ensureFolders(input: string) {
    this.storageRepository.mkdirSync(dirname(input));
  }

  removeEmptyDirs(folder: StorageFolder) {
    return this.storageRepository.removeEmptyDirs(StorageCore.getBaseFolder(folder));
  }

  async getVideoInterfaces(): Promise<VideoInterfaces> {
    const [dri, mali] = await Promise.all([this.getDevices(), this.hasMaliOpenCL()]);
    return { dri, mali };
  }

  /** Saves a moved file that is not an asset's; an asset's is saved by `AssetRepository.moveFile`. */
  private savePath(pathType: PathType, id: string, newPath: string, ownerId?: string) {
    switch (pathType) {
      case PersonPathType.Face: {
        if (!ownerId) {
          this.logger.warn('Unable to save person path without an owner');
          return;
        }

        return this.personRepository.update({ ownerId, personGroupId: id, thumbnailPath: newPath });
      }

      default: {
        this.logger.warn('Unexpected path type:', pathType);
        return;
      }
    }
  }

  static getNestedFolder(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(StorageCore.getFolderLocation(folder, ownerId), filename.slice(0, 2), filename.slice(2, 4));
  }

  static getNestedPath(folder: StorageFolder, ownerId: string, filename: string): string {
    return join(StorageCore.getNestedFolder(folder, ownerId, filename), filename);
  }

  private async getDevices() {
    try {
      return await this.storageRepository.readdir('/dev/dri');
    } catch {
      this.logger.debug('No devices found in /dev/dri.');
      return [];
    }
  }

  private async hasMaliOpenCL() {
    try {
      const [maliIcdStat, maliDeviceStat] = await Promise.all([
        this.storageRepository.stat('/etc/OpenCL/vendors/mali.icd'),
        this.storageRepository.stat('/dev/mali0'),
      ]);
      return maliIcdStat.isFile() && maliDeviceStat.isCharacterDevice();
    } catch {
      this.logger.debug('OpenCL not available for transcoding, so RKMPP acceleration will use CPU tonemapping');
      return false;
    }
  }
}
