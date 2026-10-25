import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { VideoInfo, VideoStreamInfo } from 'src/types.js';
import {
  StudioFontCatalogDto,
  StudioMediaFactsDto,
  StudioResourceInventoryDto,
} from 'src/dtos/studio-inventory.dto.js';
import { AssetType, CacheControl, ColorTransfer, Permission } from 'src/enum.js';
import { isMediaProcessShutdownUnconfirmed } from 'src/queue/process-lifetime.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { parseDurationSeconds } from 'src/services/asset-restoration.service.js';
import { SourceOriginalService } from 'src/services/source-original.service.js';
import { requireAccess } from 'src/utils/access.js';
import { withExecutionCleanup } from 'src/utils/execution-signal.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { parseSourcePixelLayout } from 'src/utils/media-decode.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { rational } from 'src/utils/rational-time.js';
import { parseSourceOriginalPath } from 'src/utils/source-original.js';
import {
  STUDIO_FONT_MEDIA_TYPES,
  findStudioBundledFont,
  studioBundledFontFamilies,
  studioBundledFontPath,
} from 'src/utils/studio-fonts.js';
import { buildStudioAuthorizedInventory } from 'src/utils/studio-inventory.js';
import { cadenceFromDecimal } from 'src/utils/studio-timing.js';

/** An integer frame rate, or an NTSC n/1001 one, read back from a stored float (graph protocol 3.2). */
export const exactFrameRateOf = cadenceFromDecimal;

type StudioMediaColor = Pick<
  StudioMediaFactsDto,
  'colorTransfer' | 'colorTransferCode' | 'colorPrimariesCode' | 'colorMatrixCode' | 'bitDepth' | 'dolbyVisionProfile'
>;

/** A still, an asset with no picture stream, and a video nothing is known about. */
const UNKNOWN_MEDIA_COLOR: StudioMediaColor = {
  colorTransfer: 'sdr',
  colorTransferCode: null,
  colorPrimariesCode: null,
  colorMatrixCode: null,
  bitDepth: null,
  dolbyVisionProfile: null,
};

/**
 * The media record's `colorTransfer` (graph protocol 3.5) of a picture stream. Any Dolby Vision
 * profile is `hdr` whatever transfer its base layer states, as the web host marks it; otherwise
 * H.273 transfer 16 is `pq` and 18 is `hlg`; everything else, unspecified included, is `sdr`. Every
 * stream `StudioResourceService.hdrLibraryAssets` counts as HDR is one of the first three.
 */
export const studioMediaColorOf = (
  stream:
    | (Pick<VideoStreamInfo, 'colorTransfer' | 'colorPrimaries' | 'colorMatrix'> & {
        pixelFormat: string | null;
        dvProfile: number | null;
      })
    | null
    | undefined,
): StudioMediaColor => {
  if (!stream) {
    return UNKNOWN_MEDIA_COLOR;
  }
  const dolbyVisionProfile = stream.dvProfile ?? null;
  let colorTransfer: StudioMediaColor['colorTransfer'] = 'sdr';
  if (dolbyVisionProfile !== null) {
    colorTransfer = 'hdr';
  } else if (stream.colorTransfer === ColorTransfer.Smpte2084) {
    colorTransfer = 'pq';
  } else if (stream.colorTransfer === ColorTransfer.AribStdB67) {
    colorTransfer = 'hlg';
  }
  return {
    colorTransfer,
    colorTransferCode: stream.colorTransfer ?? null,
    colorPrimariesCode: stream.colorPrimaries ?? null,
    colorMatrixCode: stream.colorMatrix ?? null,
    bitDepth: parseSourcePixelLayout(stream.pixelFormat)?.bitDepth ?? null,
    dolbyVisionProfile,
  };
};

/**
 * What a native Studio client needs to know before it places library media (FL-348): the media
 * facts behind the graph protocol's media record (section 3.5), read from the original the same way
 * for every client, and the inventory of resources the deployment may use.
 */
@Injectable()
export class StudioCatalogService {
  @Inject(SessionRepository)
  private sessionRepository!: SessionRepository;
  @Inject(IntegrityRepository)
  private integrityRepository!: IntegrityRepository;
  private probeStopUnconfirmed = false;
  private readonly sourceReaderOwnerId = randomUUID();
  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private assetRepository: AssetRepository,
    private mediaRepository: MediaRepository,
    private storageRepository: StorageRepository,
    private sourceOriginalService: SourceOriginalService,
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
  async getFontFile(sha256: string): Promise<FileDownloadResponse> {
    const found = findStudioBundledFont(sha256);
    if (!found) {
      throw new NotFoundException('Font not found');
    }
    const path = studioBundledFontPath(found.family, found.file);
    if (!(await this.storageRepository.checkFileExists(path))) {
      this.logger.error(`Bundled Studio font ${found.file.file} of ${found.family.package} is missing`);
      throw new NotFoundException('Font not found');
    }
    return new FileDownloadResponse({
      path,
      contentType: STUDIO_FONT_MEDIA_TYPES[found.file.format],
      // The controller sets the immutable Cache-Control: the URL is the content hash.
      cacheControl: CacheControl.None,
      fileName: found.file.file,
    });
  }

  async getMediaFacts(auth: AuthDto, id: string, signal?: AbortSignal): Promise<StudioMediaFactsDto> {
    signal?.throwIfAborted();
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
        ...UNKNOWN_MEDIA_COLOR,
        source: 'stored',
      };
    }

    if (this.probeStopUnconfirmed) throw new Error('media_process_shutdown_unconfirmed');

    // The colour metadata extraction stored, which is what decides a project's HDR sources too.
    const storedColor = await this.assetRepository.getVideoColor(asset.id);
    const reference = parseSourceOriginalPath(asset.originalPath);
    let probe: VideoInfo | null = null;
    let input: Awaited<ReturnType<SourceOriginalService['open']>> | undefined;
    let confirmed = true;
    const authorize = async () => {
      signal?.throwIfAborted();
      const live = auth.session ? await this.sessionRepository.getAuth(auth.user.id, auth.session.id) : auth;
      if (!live) throw new NotFoundException('Studio source is no longer authorized');
      await requireAccess(this.accessRepository, { auth: live, permission: Permission.AssetRead, ids: [id] });
      const current = await this.assetRepository.getById(id);
      if (
        !current ||
        current.ownerId !== asset.ownerId ||
        current.originalPath !== asset.originalPath ||
        !current.checksum.equals(asset.checksum)
      )
        throw new ConflictException('Studio source changed');
      signal?.throwIfAborted();
    };
    try {
      if (reference) {
        input = await this.sourceOriginalService.open(
          asset.id,
          { kind: 'http', readerId: randomUUID(), ownerId: this.sourceReaderOwnerId },
          authorize,
          signal,
        );
        await input.check();
      }
      try {
        probe = input
          ? await this.mediaRepository.probe(input.localPath, { countFrames: false, signal: input.signal })
          : signal
            ? await this.mediaRepository.probe(asset.originalPath, { countFrames: false, signal })
            : await this.mediaRepository.probe(asset.originalPath);
      } catch (error) {
        if (this.nativeStopUnconfirmed(error)) throw error;
        input?.signal.throwIfAborted();
        signal?.throwIfAborted();
        this.logger.warn(`Could not probe ${asset.id} for Studio media facts: ${error}`);
      }
      await input?.check();
    } catch (error) {
      confirmed = !this.nativeStopUnconfirmed(error);
      if (!confirmed) this.probeStopUnconfirmed = true;
      throw error;
    } finally {
      if (confirmed && input)
        await withExecutionCleanup(() => input!.release()).catch((error) => {
          if (this.nativeStopUnconfirmed(error)) this.probeStopUnconfirmed = true;
          throw error;
        });
    }
    if (reference) {
      await authorize();
      const epochs = await this.integrityRepository.sourceEpochs([id]);
      const current = epochs[0];
      if (
        epochs.length !== 1 ||
        current.assetId !== id ||
        current.ownerId !== asset.ownerId ||
        !current.reference ||
        current.reference.resourceId !== input?.resourceId ||
        current.reference.version !== input?.resourceVersion ||
        current.reference.sha256 !== input?.verifiedSha256
      )
        throw new ConflictException('Studio source changed');
    }
    signal?.throwIfAborted();
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
        ...studioMediaColorOf(storedColor),
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
      // an original whose metadata has not been extracted yet has no stored row: the probe just made answers
      ...studioMediaColorOf(reference ? video : (storedColor ?? video)),
      source: 'probe',
    };
  }
  private nativeStopUnconfirmed(error: unknown) {
    return (
      isMediaProcessShutdownUnconfirmed(error) ||
      (error instanceof Error &&
        [
          'source_original_shutdown_unconfirmed',
          'artifact_close_unconfirmed',
          'source_reader_stop_unconfirmed',
        ].includes(error.message))
    );
  }
}
