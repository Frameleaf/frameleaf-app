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
import { ReadStreamResponse } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { DecimalSize } from 'src/utils/bytes.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { OriginalLocationPolicy, getOriginalLocationPolicies } from 'src/utils/partner-location.js';
import { getPreferences } from 'src/utils/preferences.js';

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

const archiveFileName = (asset: { originalFileName: string; editedPath?: string | null }, dto: DownloadArchiveDto) =>
  dto.edited && asset.editedPath
    ? `${parse(asset.originalFileName).name}${parse(asset.editedPath).ext}`
    : asset.originalFileName;

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

    const targetSize = dto.archiveSize || DecimalSize.GB * 4;
    const metadata = await this.userRepository.getMetadata(auth.user.id);
    const preferences = getPreferences(metadata);
    const motionIds = new Set<string>();
    const archives: DownloadArchiveInfo[] = [];
    let archive: DownloadArchiveInfo | undefined;

    const addToArchive = ({ id, size }: { id: string; size: number | null }) => {
      if (!archive || archive.size > targetSize) {
        archive = { size: 0, assetIds: [] };
        archives.push(archive);
      }
      archive.assetIds.push(id);
      archive.size += Number(size || 0);
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

    let totalSize = 0;
    for (const archive of archives) {
      totalSize += archive.size;
    }

    return { totalSize, archives };
  }

  async downloadArchive(auth: AuthDto, request: DownloadArchiveDto): Promise<ReadStreamResponse> {
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: request.assetIds });

    const dto = await this.withDownloadPreferences(auth, request);
    const assets = await this.assetRepository.getForOriginals(dto.assetIds, dto.edited ?? false);
    // FL-54: the archive holds each file's bytes, embedded location included, so apply the same policy
    // as a single original download before anything is streamed
    const policyFor = getOriginalLocationPolicies({ auth, assets, purpose: 'download' });
    if (assets.some((asset) => policyFor(asset) === OriginalLocationPolicy.Refuse)) {
      throw new ForbiddenException('Downloads are turned off while metadata is hidden');
    }

    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const disposition = dto.archiveName && `attachment; filename*=UTF-8''${encodeURIComponent(dto.archiveName)}.zip`;

    const sidecars = dto.includeSidecar ? await this.getSidecarPaths(assets.map(({ id }) => id)) : new Map();
    const zip = this.storageRepository.createZipStream();
    const paths: Record<string, number> = {};

    for (const assetId of dto.assetIds) {
      const asset = assetMap.get(assetId);
      if (!asset) {
        continue;
      }

      const name = nextArchiveName(paths, archiveFileName(asset, dto));
      zip.addFile(await this.resolveArchivePath(asset, dto), name);

      // ACCOUNT-P5: "IMG_1.HEIC.xmp" beside "IMG_1.HEIC", so a RAW and a JPEG of one shot never share one
      const sidecar = sidecars.get(assetId);
      if (sidecar) {
        zip.addFile(sidecar, nextArchiveName(paths, `${name}.xmp`));
      }
    }

    void zip.finalize();

    return { stream: zip.stream, disposition };
  }

  /**
   * ACCOUNT-P5: what an archive holds when the request leaves it out follows the account's Downloads
   * preferences (`download.edited`, `download.includeSidecar`). A shared-link visitor's download never
   * follows the link owner's: it holds the originals without details files unless the request asks.
   */
  private async withDownloadPreferences(auth: AuthDto, dto: DownloadArchiveDto): Promise<DownloadArchiveDto> {
    if (auth.sharedLink || (dto.edited !== undefined && dto.includeSidecar !== undefined)) {
      return dto;
    }
    const { download } = getPreferences((await this.userRepository.getMetadata(auth.user.id)) ?? []);
    return {
      ...dto,
      edited: dto.edited ?? download.edited,
      includeSidecar: dto.includeSidecar ?? download.includeSidecar,
    };
  }

  /** The details file on disk for each asset that has one; a missing file is left out, not an error. */
  private async getSidecarPaths(assetIds: string[]): Promise<Map<string, string>> {
    const sidecars = new Map<string, string>();
    if (assetIds.length === 0) {
      return sidecars;
    }
    for (const { assetId, path } of await this.downloadRepository.getSidecars(assetIds)) {
      if (!sidecars.has(assetId) && (await this.storageRepository.checkFileExists(path))) {
        sidecars.set(assetId, path);
      }
    }
    return sidecars;
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

  private nsfwOptions(auth: AuthDto) {
    return auth.hideNsfwAssets ? getHiddenContentQueryOptions(auth) : undefined;
  }
}
