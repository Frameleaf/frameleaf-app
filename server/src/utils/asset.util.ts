import { BadRequestException } from '@nestjs/common';
import type { AssetRepository } from 'src/repositories/asset.repository.js';
import { AssetFile } from 'src/database.js';
import { BulkIdErrorReason, BulkIdResponseDto } from 'src/dtos/asset-ids.response.dto.js';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { FrameleafFile, IBulkAsset, UploadFile, UploadRequest } from 'src/types.js';
import { checkAccess } from 'src/utils/access.js';

export const getAssetFile = (files: AssetFile[], type: AssetFileType, { isEdited }: { isEdited: boolean }) => {
  return files.find((file) => file.type === type && file.isEdited === isEdited);
};

type AssetFileSlot =
  | 'fullsizeFile'
  | 'previewFile'
  | 'thumbnailFile'
  | 'sidecarFile'
  | 'editedFullsizeFile'
  | 'editedPreviewFile'
  | 'editedThumbnailFile'
  | 'encodedVideoFile';

export const getAssetFiles = (files: AssetFile[]) => {
  const selected: Record<AssetFileSlot, AssetFile | undefined> = {
    fullsizeFile: undefined,
    previewFile: undefined,
    thumbnailFile: undefined,
    sidecarFile: undefined,
    editedFullsizeFile: undefined,
    editedPreviewFile: undefined,
    editedThumbnailFile: undefined,
    encodedVideoFile: undefined,
  };
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const isEdited = file.isEdited;
    if (typeof isEdited !== 'boolean') {
      continue;
    }
    switch (file.type) {
      case AssetFileType.FullSize: {
        if (isEdited) {
          selected.editedFullsizeFile ??= file;
        } else {
          selected.fullsizeFile ??= file;
        }
        break;
      }
      case AssetFileType.Preview: {
        if (isEdited) {
          selected.editedPreviewFile ??= file;
        } else {
          selected.previewFile ??= file;
        }
        break;
      }
      case AssetFileType.Thumbnail: {
        if (isEdited) {
          selected.editedThumbnailFile ??= file;
        } else {
          selected.thumbnailFile ??= file;
        }
        break;
      }
      case AssetFileType.Sidecar: {
        if (!isEdited) {
          selected.sidecarFile ??= file;
        }
        break;
      }
      case AssetFileType.EncodedVideo: {
        if (!isEdited) {
          selected.encodedVideoFile ??= file;
        }
        break;
      }
      case AssetFileType.HdrFullSize:
      case AssetFileType.HdrPreview: {
        break;
      }
    }
    if (
      selected.fullsizeFile &&
      selected.previewFile &&
      selected.thumbnailFile &&
      selected.sidecarFile &&
      selected.editedFullsizeFile &&
      selected.editedPreviewFile &&
      selected.editedThumbnailFile &&
      selected.encodedVideoFile
    ) {
      break;
    }
  }
  return selected;
};

export const addAssets = async (
  auth: AuthDto,
  repositories: { access: AccessRepository; bulk: IBulkAsset },
  dto: { parentId: string; assetIds: string[]; permission: Permission },
) => {
  const { access, bulk } = repositories;
  const existingAssetIds = await bulk.getAssetIds(dto.parentId, dto.assetIds);
  const notPresentAssetIds = dto.assetIds.filter((id) => !existingAssetIds.has(id));
  const allowedAssetIds = await checkAccess(access, {
    auth,
    permission: dto.permission,
    ids: notPresentAssetIds,
  });

  const results: BulkIdResponseDto[] = [];
  const newAssetIds: string[] = [];
  for (const assetId of dto.assetIds) {
    const hasAsset = existingAssetIds.has(assetId);
    if (hasAsset) {
      results.push({ id: assetId, success: false, error: BulkIdErrorReason.DUPLICATE });
      continue;
    }

    const hasAccess = allowedAssetIds.has(assetId);
    if (!hasAccess) {
      results.push({ id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION });
      continue;
    }

    existingAssetIds.add(assetId);
    newAssetIds.push(assetId);
    results.push({ id: assetId, success: true });
  }

  if (newAssetIds.length > 0) {
    await bulk.addAssetIds(dto.parentId, newAssetIds);
  }

  return results;
};

export const removeAssets = async (
  auth: AuthDto,
  repositories: { access: AccessRepository; bulk: IBulkAsset },
  dto: { parentId: string; assetIds: string[]; canAlwaysRemove: Permission },
) => {
  const { access, bulk } = repositories;

  // check if the user can always remove from the parent album, memory, etc.
  const canAlwaysRemove = await checkAccess(access, { auth, permission: dto.canAlwaysRemove, ids: [dto.parentId] });
  const existingAssetIds = await bulk.getAssetIds(dto.parentId, dto.assetIds);
  const allowedAssetIds =
    canAlwaysRemove.has(dto.parentId) && !auth.hideNsfwAssets
      ? existingAssetIds
      : await checkAccess(access, {
          auth,
          permission: auth.hideNsfwAssets ? Permission.AssetRead : Permission.AssetShare,
          ids: existingAssetIds,
        });

  const results: BulkIdResponseDto[] = [];
  const removedIds: string[] = [];
  for (const assetId of dto.assetIds) {
    const hasAsset = existingAssetIds.has(assetId);
    if (!hasAsset) {
      results.push({ id: assetId, success: false, error: BulkIdErrorReason.NOT_FOUND });
      continue;
    }

    const hasAccess = allowedAssetIds.has(assetId);
    if (!hasAccess) {
      results.push({ id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION });
      continue;
    }

    existingAssetIds.delete(assetId);
    removedIds.push(assetId);
    results.push({ id: assetId, success: true });
  }

  if (removedIds.length > 0) {
    await bulk.removeAssetIds(dto.parentId, removedIds);
  }

  return results;
};

export const getLivePhotoMotion = async (
  assetRepository: AssetRepository,
  userId: string,
  livePhotoVideoId: string,
) => {
  const motionAsset = await assetRepository.getById(livePhotoVideoId);
  if (!motionAsset) {
    throw new BadRequestException('Live photo video not found');
  }
  if (motionAsset.type !== AssetType.Video) {
    throw new BadRequestException('Live photo video must be a video');
  }
  if (motionAsset.ownerId !== userId) {
    throw new BadRequestException('Live photo video does not belong to the user');
  }
  return motionAsset;
};

export type LivePhotoLinkRepositories = {
  asset: Pick<AssetRepository, 'update'>;
  album: Pick<AlbumRepository, 'removeAssetsFromAll'>;
};

/**
 * Link a still image to its motion video as a live photo: point the photo at the
 * video, hide the video from the timeline and remove it from any albums.
 * Callers supply transaction-bound repositories and announce the link after commit.
 */
export const linkLivePhotoAssets = async (
  { asset: assetRepository, album: albumRepository }: LivePhotoLinkRepositories,
  { photoAssetId, motionAssetId }: { photoAssetId: string; motionAssetId: string },
): Promise<void> => {
  await assetRepository.update({ id: photoAssetId, livePhotoVideoId: motionAssetId });
  await assetRepository.update({ id: motionAssetId, visibility: AssetVisibility.Hidden });
  await albumRepository.removeAssetsFromAll([motionAssetId]);
};

export function mapToUploadFile(file: FrameleafFile): UploadFile {
  return {
    uuid: file.uuid,
    checksum: file.checksum,
    legacyChecksum: file.legacyChecksum,
    originalPath: file.path,
    originalName: Buffer.from(file.originalname, 'latin1').toString('utf8'),
    size: file.size,
  };
}

export const asUploadRequest = (request: AuthRequest, file: Express.Multer.File): UploadRequest => {
  return {
    auth: request.user || null,
    body: request.body,
    fieldName: file.fieldname as UploadFieldName,
    file: mapToUploadFile(file as FrameleafFile),
  };
};

const isFlipped = (orientation?: string | null) => {
  const value = Number(orientation);
  return value && [5, 6, 7, 8, -90, 90].includes(value);
};

export const getDimensions = ({
  exifImageHeight: height,
  exifImageWidth: width,
  orientation,
}: {
  exifImageHeight: number | null;
  exifImageWidth: number | null;
  orientation: string | null;
}) => {
  if (!width || !height) {
    return { width: 0, height: 0 };
  }

  if (isFlipped(orientation)) {
    return { width: height, height: width };
  }

  return { width, height };
};

export const isPanorama = (asset: { projectionType: string | null; originalFileName: string }) => {
  return asset.projectionType === 'EQUIRECTANGULAR' || asset.originalFileName.toLowerCase().endsWith('.insp');
};
