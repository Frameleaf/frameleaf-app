import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { parse } from 'node:path';
import sanitize from 'sanitize-filename';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  DownloadArchiveDto,
  DownloadArchiveInfo,
  DownloadInfoDto,
  DownloadResponseDto,
} from 'src/dtos/download.dto.js';
import { Permission } from 'src/enum.js';
import { LocationFreeLease } from 'src/repositories/metadata.repository.js';
import { ImmichPacedZipStream, ImmichReadStream } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { OriginalLocationPolicy, getOriginalLocationPolicies } from 'src/utils/partner-location.js';
import { getPreferences } from 'src/utils/preferences.js';

/**
 * FL-54 review R1: files whose location is removed are rewritten one by one while the archive streams; one
 * request may not ask for more of them than a single `getDownloadInfo` chunk would ever hold.
 */
export const MAX_LOCATION_FREE_ARCHIVE_ENTRIES = 10_000;
/** name of the note added to an archive when files had to be left out (FL-54) */
export const LOCATION_OMITTED_NOTE_NAME = 'Files left out.txt';

const omittedNote = (names: string[]) =>
  [
    `${names.length} file(s) were left out of this download because their location could not be removed:`,
    '',
    ...names,
    '',
  ].join('\n');

const nextArchiveName = (paths: Record<string, number>, originalFileName: string) => {
  let filename = sanitize(originalFileName) || 'unnamed';
  const count = paths[filename] || 0;
  paths[filename] = count + 1;
  if (count !== 0) {
    const parsedFilename = parse(filename);
    filename = `${parsedFilename.name}+${count}${parsedFilename.ext}`;
  }
  return filename;
};

@Injectable()
export class DownloadService extends BaseService {
  async getDownloadInfo(auth: AuthDto, dto: DownloadInfoDto): Promise<DownloadResponseDto> {
    let assets;
    const nsfwOptions = this.nsfwOptions(auth);

    if (dto.assetIds) {
      const assetIds = dto.assetIds;
      await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: assetIds });
      assets = nsfwOptions
        ? this.downloadRepository.downloadAssetIds(assetIds, nsfwOptions)
        : this.downloadRepository.downloadAssetIds(assetIds);
    } else if (dto.albumId) {
      const albumId = dto.albumId;
      await this.requireAccess({ auth, permission: Permission.AlbumDownload, ids: [albumId] });
      // The archive holds what the album shows this viewer: their own Locked members only when elevated.
      const albumOptions = { ...nsfwOptions, ...getLockedVisibilityOptions(auth) };
      assets =
        Object.keys(albumOptions).length > 0
          ? this.downloadRepository.downloadAlbumId(albumId, albumOptions)
          : this.downloadRepository.downloadAlbumId(albumId);
    } else if (dto.userId) {
      const userId = dto.userId;
      await this.requireAccess({ auth, permission: Permission.TimelineDownload, ids: [userId] });
      // the caller's own library: their Locked media only once they have unlocked it (FL-34)
      const userOptions = { ...nsfwOptions, ...getLockedVisibilityOptions(auth) };
      assets =
        Object.keys(userOptions).length > 0
          ? this.downloadRepository.downloadUserId(userId, userOptions)
          : this.downloadRepository.downloadUserId(userId);
    } else {
      throw new BadRequestException('assetIds, albumId, or userId is required');
    }

    const targetSize = dto.archiveSize || HumanReadableSize.GiB * 4;
    const metadata = await this.userRepository.getMetadata(auth.user.id);
    const preferences = getPreferences(metadata);
    const motionIds = new Set<string>();
    const archives: DownloadArchiveInfo[] = [];
    let archive: DownloadArchiveInfo = { size: 0, assetIds: [] };

    const addToArchive = ({ id, size }: { id: string; size: number | null }) => {
      archive.assetIds.push(id);
      archive.size += Number(size || 0);

      if (archive.size > targetSize) {
        archives.push(archive);
        archive = { size: 0, assetIds: [] };
      }
    };

    for await (const asset of assets) {
      // motion part of live photos
      if (asset.livePhotoVideoId) {
        motionIds.add(asset.livePhotoVideoId);
      }

      addToArchive(asset);
    }

    if (motionIds.size > 0) {
      const motionAssets = nsfwOptions
        ? this.downloadRepository.downloadMotionAssetIds([...motionIds], nsfwOptions)
        : this.downloadRepository.downloadMotionAssetIds([...motionIds]);
      for await (const motionAsset of motionAssets) {
        if (StorageCore.isAndroidMotionPath(motionAsset.originalPath) && !preferences.download.includeEmbeddedVideos) {
          continue;
        }

        addToArchive(motionAsset);
      }
    }

    if (archive.assetIds.length > 0) {
      archives.push(archive);
    }

    let totalSize = 0;
    for (const archive of archives) {
      totalSize += archive.size;
    }

    return { totalSize, archives };
  }

  async downloadArchive(auth: AuthDto, dto: DownloadArchiveDto): Promise<ImmichReadStream> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: dto.assetIds });

    const assets = await this.assetRepository.getForOriginals(dto.assetIds, dto.edited ?? false);
    // FL-54: the archive holds each file's bytes, embedded location included, so apply the same policy
    // as a single original download before anything is streamed
    const policyFor = await getOriginalLocationPolicies({
      auth,
      assets,
      purpose: 'download',
      repository: this.partnerRepository,
    });
    if (assets.some((asset) => policyFor(asset) === OriginalLocationPolicy.Refuse)) {
      throw new ForbiddenException('Downloads are turned off while metadata is hidden');
    }

    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const disposition = dto.archiveName && `attachment; filename*=UTF-8''${encodeURIComponent(dto.archiveName)}.zip`;

    const removals = assets.filter((asset) => policyFor(asset) === OriginalLocationPolicy.RemoveLocation);
    if (removals.length > 0) {
      if (removals.length > MAX_LOCATION_FREE_ARCHIVE_ENTRIES) {
        throw new BadRequestException(
          `An archive can hold at most ${MAX_LOCATION_FREE_ARCHIVE_ENTRIES} files whose location must be removed`,
        );
      }

      const zip = this.storageRepository.createPacedZipStream();
      void this.fillLocationFreeArchive(zip, dto, assetMap, policyFor);
      return { stream: zip.stream, disposition };
    }

    const zip = this.storageRepository.createZipStream();
    const paths: Record<string, number> = {};

    for (const assetId of dto.assetIds) {
      const asset = assetMap.get(assetId);
      if (!asset) {
        continue;
      }

      zip.addFile(await this.resolveArchivePath(asset, dto), nextArchiveName(paths, asset.originalFileName));
    }

    void zip.finalize();

    return { stream: zip.stream, disposition };
  }

  private async resolveArchivePath(
    { originalPath, editedPath }: { originalPath: string; editedPath?: string | null },
    dto: DownloadArchiveDto,
  ) {
    let realpath = dto.edited && editedPath ? editedPath : originalPath;

    try {
      realpath = await this.storageRepository.realpath(realpath);
    } catch {
      this.logger.warn('Unable to resolve realpath', { originalPath });
    }

    return realpath;
  }

  /**
   * FL-54: fills an archive holding files whose location must be removed, one entry at a time and only as
   * fast as the client reads it. Each copy is made when the archive reaches it and let go as soon as it has
   * been written, so an archive holds at most one copy, and a client that goes away (the controller then
   * destroys the stream) stops the work. A file whose location cannot be removed is left out (fail closed)
   * and listed in a note at the end of the archive.
   */
  private async fillLocationFreeArchive(
    zip: ImmichPacedZipStream,
    dto: DownloadArchiveDto,
    assetMap: Map<
      string,
      { id: string; ownerId: string; originalPath: string; editedPath?: string | null; originalFileName: string }
    >,
    policyFor: (asset: { id: string; ownerId: string }) => OriginalLocationPolicy,
  ) {
    const paths: Record<string, number> = {};
    const omitted: string[] = [];

    try {
      for (const assetId of dto.assetIds) {
        const asset = assetMap.get(assetId);
        if (!asset) {
          continue;
        }
        if (zip.isClosed()) {
          return;
        }

        const realpath = await this.resolveArchivePath(asset, dto);
        if (policyFor(asset) !== OriginalLocationPolicy.RemoveLocation) {
          zip.addFile(realpath, nextArchiveName(paths, asset.originalFileName));
          continue;
        }

        // prepare the next copy only once the reader has taken everything before it
        await zip.whenIdle();
        if (zip.isClosed()) {
          return;
        }

        let lease: LocationFreeLease;
        try {
          lease = await this.metadataRepository.acquireLocationFreeOriginal(realpath);
        } catch (error) {
          this.logger.warn(`Leaving asset ${assetId} out of the archive, its location could not be removed: ${error}`);
          omitted.push(sanitize(asset.originalFileName) || 'unnamed');
          continue;
        }

        try {
          if (zip.isClosed()) {
            return;
          }
          zip.addFile(lease.path, nextArchiveName(paths, asset.originalFileName));
          // resolves once the copy has been written into the archive, or the archive is gone
          await zip.whenIdle();
        } finally {
          lease.release();
        }
      }

      if (omitted.length > 0) {
        this.logger.warn(`Left ${omitted.length} file(s) out of an archive: their location could not be removed`);
        zip.addBuffer(Buffer.from(omittedNote(omitted)), LOCATION_OMITTED_NOTE_NAME);
      }

      if (!zip.isClosed()) {
        await zip.finalize();
      }
    } catch (error) {
      this.logger.error(`Unable to build archive: ${error}`);
      zip.stream.destroy(error as Error);
    }
  }

  private nsfwOptions(auth: AuthDto) {
    return auth.hideNsfwAssets ? getHiddenContentQueryOptions(auth) : undefined;
  }
}
