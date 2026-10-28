import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { parse } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  DownloadArchiveDto,
  DownloadArchiveInfo,
  DownloadInfoDto,
  DownloadResponseDto,
} from 'src/dtos/download.dto.js';
import { AssetVisibility, Permission } from 'src/enum.js';
import { ReadStreamResponse } from 'src/repositories/storage.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { AssetDetails, assetDetailsXmp } from 'src/utils/asset-details-xmp.js';
import { DecimalSize } from 'src/utils/bytes.js';
import { hasPublishedDevelopRendition } from 'src/utils/develop-envelope.js';
import { nextArchiveName } from 'src/utils/file.js';
import { getHiddenContentQueryOptions, getOthersRulesQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { OriginalLocationPolicy, getOriginalLocationPolicies } from 'src/utils/partner-location.js';
import { getPreferences } from 'src/utils/preferences.js';

/** Whether the archive holds the edited file rather than the original. */
const usesEditedFile = (asset: { editedPath?: string | null }, dto: DownloadArchiveDto) =>
  !!dto.edited && !!asset.editedPath;

const archiveFileName = (asset: { originalFileName: string; editedPath?: string | null }, dto: DownloadArchiveDto) =>
  usesEditedFile(asset, dto) && asset.editedPath
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
      // The archive holds what the album shows this viewer: their own Locked members only when elevated,
      // and never another member's item that matches its owner's Locked rules (FL-446).
      const albumOptions = { ...nsfwOptions, ...getLockedVisibilityOptions(auth), ...getOthersRulesQueryOptions(auth) };
      assets = this.downloadRepository.downloadAlbumId(albumId, albumOptions);
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
    if (request.includeLibraryMetadata && (auth.sharedLink || auth.apiKey || auth.system)) {
      throw new ForbiddenException('Private library export requires a signed-in account');
    }
    if (
      (request.includeLibraryMetadata && request.edited) ||
      (!request.includeLibraryMetadata && (request.includeSources || request.bookmarkIds?.length))
    ) {
      throw new BadRequestException('Portable library exports require a manifest and original files');
    }
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: request.assetIds });

    const dto = await this.withDownloadPreferences(auth, request);
    const assets =
      dto.assetIds.length === 0 ? [] : await this.assetRepository.getForOriginals(dto.assetIds, dto.edited ?? false);
    // FL-54: the archive holds each file's bytes, embedded location included, so apply the same policy
    // as a single original download before anything is streamed
    const policyFor = getOriginalLocationPolicies({ auth, assets, purpose: 'download' });
    if (assets.some((asset) => policyFor(asset) === OriginalLocationPolicy.Refuse)) {
      throw new ForbiddenException('Downloads are turned off while metadata is hidden');
    }

    const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
    const disposition = dto.archiveName && `attachment; filename*=UTF-8''${encodeURIComponent(dto.archiveName)}.zip`;

    const sidecars = dto.includeSidecar ? await this.getSidecarPaths(assets.map(({ id }) => id)) : new Map();
    const details = dto.includeSidecar
      ? await this.getGeneratedDetails(
          auth,
          assets.filter(({ id }) => !sidecars.has(id)).map(({ id }) => id),
        )
      : new Map<string, AssetDetails>();
    const developed = dto.edited ? await this.getShownDevelopMasters(auth, assets) : new Map<string, string>();
    const paths = new Map<string, number>();
    const manifestNames = new Map<string, string>();
    if (dto.includeLibraryMetadata) {
      nextArchiveName(paths, 'frameleaf-library.json');
      for (const id of dto.assetIds) {
        const asset = assetMap.get(id);
        if (asset) manifestNames.set(id, nextArchiveName(paths, archiveFileName(asset, dto)));
      }
    }
    const manifest = dto.includeLibraryMetadata
      ? await this.downloadRepository.getLibraryManifest(
          auth,
          [...manifestNames].map(([id, file]) => ({ id, file })),
          dto.bookmarkIds ?? [],
          dto.includeSources ?? false,
        )
      : undefined;
    const zip = this.storageRepository.createZipStream();

    for (const assetId of dto.assetIds) {
      const found = assetMap.get(assetId);
      if (!found) {
        continue;
      }

      // As shown: the owner's current develop version takes the place of any other edited file.
      const asset = { ...found, editedPath: developed.get(assetId) ?? found.editedPath };
      const name = manifestNames.get(assetId) ?? nextArchiveName(paths, archiveFileName(asset, dto));
      zip.addFile(await this.resolveArchivePath(asset, dto), name);

      // ACCOUNT-P5: "IMG_1.HEIC.xmp" beside "IMG_1.HEIC", so a RAW and a JPEG of one shot never share one
      const sidecar = sidecars.get(assetId);
      const generated = details.get(assetId);
      if (sidecar) {
        zip.addFile(sidecar, nextArchiveName(paths, `${name}.xmp`));
      } else if (generated) {
        // FL-423: a photo without a sidecar gets one made from what this person's asset response shows
        const xmp = assetDetailsXmp(generated, { orientation: !usesEditedFile(asset, dto) });
        zip.addFile(Buffer.from(xmp, 'utf8'), nextArchiveName(paths, `${name}.xmp`));
      }
    }

    if (manifest) zip.addFile(Buffer.from(JSON.stringify(manifest), 'utf8'), 'frameleaf-library.json');
    void zip.finalize();

    return { stream: zip.stream, disposition };
  }

  /**
   * ACCOUNT-P5: whether an archive puts a details file beside each photo follows the account's
   * `download.includeSidecar` preference when the request leaves it out. A shared-link visitor's
   * download never follows the link owner's: it holds no details files unless the request asks.
   * Which version of each item it holds is the request's `edited` (as shown), never a preference.
   */
  private async withDownloadPreferences(auth: AuthDto, dto: DownloadArchiveDto): Promise<DownloadArchiveDto> {
    if (auth.sharedLink || dto.includeSidecar !== undefined) {
      return dto;
    }
    const { download } = getPreferences((await this.userRepository.getMetadata(auth.user.id)) ?? []);
    return { ...dto, includeSidecar: download.includeSidecar };
  }

  /**
   * The rendered master of the current develop version of each asset the requester owns: what their
   * viewer shows, so what an archive of them as shown holds. Nobody else sees an owner's working version.
   */
  private async getShownDevelopMasters(
    auth: AuthDto,
    assets: { id: string; ownerId: string }[],
  ): Promise<Map<string, string>> {
    const masters = new Map<string, string>();
    const owned = auth.sharedLink ? [] : assets.filter(({ ownerId }) => ownerId === auth.user.id).map(({ id }) => id);
    if (owned.length === 0) {
      return masters;
    }
    for (const current of await this.assetRepository.getCurrentDevelops(owned)) {
      if (current.ownerId === auth.user.id && current.masterPath && hasPublishedDevelopRendition(current)) {
        masters.set(current.assetId, current.masterPath);
      }
    }
    return masters;
  }

  /**
   * FL-423: what a details file says about each photo that has no sidecar, read exactly as this person's
   * asset response shows it (their own names for the people in it, a shared link's response without
   * people). A link that hides metadata gets none; its downloads are refused before this anyway. The
   * motion part of a Live Photo gets none either: the photo beside it carries the details.
   */
  private async getGeneratedDetails(auth: AuthDto, assetIds: string[]): Promise<Map<string, AssetDetails>> {
    const details = new Map<string, AssetDetails>();
    if (assetIds.length === 0 || (auth.sharedLink && !auth.sharedLink.showExif)) {
      return details;
    }
    for (const asset of await this.assetRepository.getByIdsWithAllRelationsButStacks(assetIds, auth.user.id)) {
      const response = mapAsset(asset, { auth });
      if (response.visibility === AssetVisibility.Hidden) {
        continue;
      }
      details.set(asset.id, {
        exifInfo: response.exifInfo,
        tags: response.tags,
        people: auth.sharedLink ? [] : response.people,
        localDateTime: response.localDateTime,
      });
    }
    return details;
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
    let realpath = usesEditedFile({ editedPath }, dto) && editedPath ? editedPath : originalPath;

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
