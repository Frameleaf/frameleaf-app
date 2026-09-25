import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { parse } from 'node:path';
import { finished } from 'node:stream';
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
import { ImmichReadStream } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { OriginalLocationPolicy, getOriginalLocationPolicies } from 'src/utils/partner-location.js';
import { getPreferences } from 'src/utils/preferences.js';

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
      ownerIds: new Set(assets.map(({ ownerId }) => ownerId)),
      purpose: 'download',
      repository: this.partnerRepository,
    });
    if (assets.some(({ ownerId }) => policyFor(ownerId) === OriginalLocationPolicy.Refuse)) {
      throw new ForbiddenException('Downloads are turned off while metadata is hidden');
    }

    const zip = this.storageRepository.createZipStream();
    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const paths: Record<string, number> = {};
    const leases: LocationFreeLease[] = [];

    for (const assetId of dto.assetIds) {
      const asset = assetMap.get(assetId);
      if (!asset) {
        continue;
      }

      const { ownerId, originalPath, editedPath, originalFileName } = asset;

      let realpath = dto.edited && editedPath ? editedPath : originalPath;

      try {
        realpath = await this.storageRepository.realpath(realpath);
      } catch {
        this.logger.warn('Unable to resolve realpath', { originalPath });
      }

      if (policyFor(ownerId) === OriginalLocationPolicy.RemoveLocation) {
        try {
          const lease = await this.metadataRepository.acquireLocationFreeOriginal(realpath);
          leases.push(lease);
          realpath = lease.path;
        } catch (error) {
          // fail closed: leave the file out rather than ship its location
          this.logger.warn(`Leaving asset ${assetId} out of the archive, its location could not be removed: ${error}`);
          continue;
        }
      }

      let filename = sanitize(originalFileName) || 'unnamed';
      const count = paths[filename] || 0;
      paths[filename] = count + 1;
      if (count !== 0) {
        const parsedFilename = parse(filename);
        filename = `${parsedFilename.name}+${count}${parsedFilename.ext}`;
      }

      zip.addFile(realpath, filename);
    }

    if (leases.length > 0) {
      // the zip reads each copy lazily, so keep them until the archive has been sent or abandoned
      finished(zip.stream, () => {
        for (const lease of leases) {
          lease.release();
        }
      });
    }

    void zip.finalize();

    return {
      stream: zip.stream,
      disposition: dto.archiveName && `attachment; filename*=UTF-8''${encodeURIComponent(dto.archiveName)}.zip`,
    };
  }

  private nsfwOptions(auth: AuthDto) {
    return auth.hideNsfwAssets ? getHiddenContentQueryOptions(auth) : undefined;
  }
}
