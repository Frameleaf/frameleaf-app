import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { VideoInfo } from 'src/types.js';
import {
  StudioFontCatalogDto,
  StudioMediaFactsDto,
  StudioResourceInventoryDto,
} from 'src/dtos/studio-inventory.dto.js';
import { AssetType, CacheControl, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { parseDurationSeconds } from 'src/services/asset-restoration.service.js';
import { requireAccess } from 'src/utils/access.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { type Rational, rational } from 'src/utils/rational-time.js';
import {
  STUDIO_FONT_MEDIA_TYPES,
  findStudioBundledFont,
  studioBundledFontFamilies,
  studioBundledFontPath,
} from 'src/utils/studio-fonts.js';
import { buildStudioAuthorizedInventory } from 'src/utils/studio-inventory.js';

/** An integer frame rate, or an NTSC n/1001 one, read back from a stored float (graph protocol 3.2). */
export const exactFrameRateOf = (fps: number | null | undefined): Rational | null => {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    return null;
  }
  if (Number.isSafeInteger(fps)) {
    return rational(fps, 1);
  }
  for (const num of [24_000, 30_000, 48_000, 60_000, 120_000]) {
    const ntsc = num / 1001;
    if (Math.abs(fps - ntsc) < 1e-9 || Math.round(ntsc * 1000) / 1000 === fps) {
      return rational(num, 1001);
    }
  }
  return null;
};

/**
 * What a native Studio client needs to know before it places library media (FL-348): the media
 * facts behind the graph protocol's media record (section 3.5), read from the original the same way
 * for every client, and the inventory of resources the deployment may use.
 */
@Injectable()
export class StudioCatalogService {
  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private assetRepository: AssetRepository,
    private mediaRepository: MediaRepository,
    private storageRepository: StorageRepository,
  ) {
    this.logger.setContext(StudioCatalogService.name);
  }

  getResourceInventory(): StudioResourceInventoryDto {
    return buildStudioAuthorizedInventory();
  }

  /** The bundled title fonts (graph protocol 14.3.5): every family and file, with licence and hash. */
  getFontCatalog(): StudioFontCatalogDto {
    return {
      families: studioBundledFontFamilies().map((family) => ({
        family: family.family,
        package: family.package,
        version: family.version,
        license: family.license,
        copyright: family.copyright,
        reservedFontName: family.reservedFontName,
        files: family.files.map((file) => ({
          sha256: file.sha256,
          file: file.file,
          weight: file.weight,
          style: file.style,
          subset: file.subset,
          format: file.format,
          size: file.size,
          decodedFrom: file.decodedFrom,
          path: `/studio/fonts/${file.sha256}`,
        })),
      })),
    };
  }

  /**
   * One bundled font file by its content hash. Only a hash the catalogue lists resolves, and the
   * path is built from the catalogue entry, so a request cannot name a file.
   */
  async getFontFile(sha256: string): Promise<ImmichFileResponse> {
    const found = findStudioBundledFont(sha256);
    if (!found) {
      throw new NotFoundException('Font not found');
    }
    const path = studioBundledFontPath(found.family, found.file);
    if (!(await this.storageRepository.checkFileExists(path))) {
      this.logger.error(`Bundled Studio font ${found.file.file} of ${found.family.package} is missing`);
      throw new NotFoundException('Font not found');
    }
    return new ImmichFileResponse({
      path,
      contentType: STUDIO_FONT_MEDIA_TYPES[found.file.format],
      // The URL is the content hash, so the answer for it never changes.
      cacheControl: CacheControl.PrivateImmutable,
      fileName: found.file.file,
    });
  }

  async getMediaFacts(auth: AuthDto, id: string): Promise<StudioMediaFactsDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetRead, ids: [id] });
    const asset = await this.assetRepository.getById(id, { exifInfo: true });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    const exif = asset.exifInfo;
    const mimeType = mimeTypes.lookup(asset.originalFileName || asset.originalPath);
    const storedWidth = exif?.exifImageWidth ?? asset.width ?? null;
    const storedHeight = exif?.exifImageHeight ?? asset.height ?? null;

    if (asset.type !== AssetType.Video) {
      return {
        assetId: asset.id,
        type: asset.type,
        mimeType,
        width: storedWidth,
        height: storedHeight,
        durationSeconds: 0,
        frameRate: null,
        fps: 0,
        frameCount: null,
        hasAudio: false,
        audioCodec: null,
        videoCodec: null,
        source: 'stored',
      };
    }

    let probe: VideoInfo | null = null;
    try {
      probe = await this.mediaRepository.probe(asset.originalPath);
    } catch (error) {
      this.logger.warn(`Could not probe ${asset.id} for Studio media facts: ${error}`);
    }
    const video = probe?.videoStreams[0];
    if (!probe || !video) {
      const frameRate = exactFrameRateOf(exif?.fps);
      return {
        assetId: asset.id,
        type: asset.type,
        mimeType,
        width: storedWidth,
        height: storedHeight,
        durationSeconds: parseDurationSeconds(asset.duration),
        frameRate,
        fps: frameRate ? frameRate.num / frameRate.den : (exif?.fps ?? 0),
        frameCount: null,
        hasAudio: null,
        audioCodec: null,
        videoCodec: null,
        source: 'stored',
      };
    }

    const exact = video.frameRateRational && video.frameRateRational.num > 0 ? video.frameRateRational : null;
    const frameRate = exact ? rational(exact.num, exact.den) : exactFrameRateOf(video.frameRate);
    // a quarter turn swaps the displayed width and height
    const turned = Math.abs(video.rotation ?? 0) % 180 === 90;
    const audio = probe.audioStreams[0];
    return {
      assetId: asset.id,
      type: asset.type,
      mimeType,
      width: (turned ? video.height : video.width) || storedWidth,
      height: (turned ? video.width : video.height) || storedHeight,
      durationSeconds: parseDurationSeconds(probe.format.duration) ?? parseDurationSeconds(asset.duration),
      frameRate,
      fps: frameRate ? frameRate.num / frameRate.den : (video.frameRate ?? 0),
      frameCount: video.frameCount > 0 ? video.frameCount : null,
      hasAudio: probe.audioStreams.length > 0,
      audioCodec: audio?.codecName ?? null,
      videoCodec: video.codecName,
      source: 'probe',
    };
  }
}
