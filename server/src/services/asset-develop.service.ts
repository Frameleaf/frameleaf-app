import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import path from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  ASSET_DEVELOP_RECIPE_VERSION,
  AssetDevelopFileKind,
  AssetDevelopPreviewDto,
  AssetDevelopResponseDto,
  AssetDevelopRevertDto,
  AssetDevelopRevisionResponseDto,
  AssetDevelopRevisionStatus,
  AssetDevelopSaveDto,
  type AssetDevelopRecipe,
} from 'src/dtos/asset-develop.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import {
  AssetType,
  CacheControl,
  Colorspace,
  ImageFormat,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository, type AssetDevelopRevision } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { JobOf, RawImageInfo } from 'src/types.js';
import { requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  DEVELOP_RENDERER_VERSION,
  applyDevelopTone,
  effectiveDevelop,
  normalizeDevelopRecipe,
  planDevelopDetail,
  planDevelopGeometry,
} from 'src/utils/develop-recipe.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/** The edited master keeps the source resolution and is encoded well above the playback previews. */
const MASTER_MIN_QUALITY = 92;

type DevelopSource = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

class DevelopRenderCancelled extends Error {
  constructor() {
    super('Develop render cancelled');
  }
}

/**
 * Still-image quick edits (FL-113): recipes are saved as revisions against an asset and
 * rendered from the original into a new edited master and preview. The original file is only
 * ever read. Access uses the existing asset edit permissions, which resolve to the owner (or
 * an elevated session), the same boundary the legacy crop/rotate edits enforce.
 */
@Injectable()
export class AssetDevelopService {
  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private assetRepository: AssetRepository,
    private assetJobRepository: AssetJobRepository,
    private assetDevelopRepository: AssetDevelopRepository,
    private configRepository: ConfigRepository,
    private jobRepository: JobRepository,
    private mediaRepository: MediaRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(AssetDevelopService.name);
  }

  async get(auth: AuthDto, assetId: string): Promise<AssetDevelopResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    return this.toResponse(assetId);
  }

  async save(auth: AuthDto, assetId: string, dto: AssetDevelopSaveDto): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const asset = await this.requireEditableStill(assetId);
    const recipe = normalizeDevelopRecipe(dto.recipe);
    const revision = await this.assetDevelopRepository.create({
      assetId,
      ownerId: asset.ownerId,
      recipe,
      recipeVersion: ASSET_DEVELOP_RECIPE_VERSION,
      label: dto.label ?? null,
      status: AssetDevelopRevisionStatus.Saved,
    });
    if (dto.render) {
      return this.queueRender(revision);
    }
    return this.toRevisionDto(revision);
  }

  async render(auth: AuthDto, assetId: string, revisionId: string): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    await this.requireEditableStill(assetId);
    const revision = await this.requireRevision(assetId, revisionId);
    if (
      revision.status === AssetDevelopRevisionStatus.Queued ||
      revision.status === AssetDevelopRevisionStatus.Rendering
    ) {
      return this.toRevisionDto(revision);
    }
    return this.queueRender(revision);
  }

  async cancel(auth: AuthDto, assetId: string, revisionId: string): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const revision = await this.requireRevision(assetId, revisionId);
    if (revision.status === AssetDevelopRevisionStatus.Queued) {
      // Not started: the row is finished here and the flag makes the worker skip the job when
      // it eventually dequeues it, so no render ever starts for a cancelled version.
      const updated = await this.assetDevelopRepository.update(revision.id, {
        status: AssetDevelopRevisionStatus.Cancelled,
        cancelRequested: true,
        progress: 0,
      });
      return this.toRevisionDto(updated ?? revision);
    }
    if (revision.status === AssetDevelopRevisionStatus.Rendering) {
      await this.assetDevelopRepository.requestCancel(revision.id);
      return this.toRevisionDto({ ...revision, cancelRequested: true });
    }
    return this.toRevisionDto(revision);
  }

  /**
   * Revert moves the asset back to an earlier rendered version, or to the original when no
   * revision is named. History is kept: nothing is deleted and no file is touched.
   */
  async revert(auth: AuthDto, assetId: string, dto: AssetDevelopRevertDto): Promise<AssetDevelopResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    if (dto.revisionId) {
      const revision = await this.requireRevision(assetId, dto.revisionId);
      if (revision.status !== AssetDevelopRevisionStatus.Rendered) {
        throw new BadRequestException('Only a rendered version can be made current');
      }
    }
    await this.assetDevelopRepository.setCurrent(assetId, dto.revisionId ?? null);
    return this.toResponse(assetId);
  }

  /**
   * Renders a bounded preview of a recipe straight from the original and returns the bytes.
   * Nothing is stored; the client uses it for the stage and the histogram while editing.
   */
  async preview(
    auth: AuthDto,
    assetId: string,
    dto: AssetDevelopPreviewDto,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source || source.type !== AssetType.Image) {
      throw new BadRequestException('Only images have develop previews');
    }
    const { image } = await this.getConfig();
    const recipe = normalizeDevelopRecipe(dto.recipe);
    // Decode at roughly preview scale so an interactive request never touches the full frame.
    const decoded = await this.decodeSource(source, image, dto.size * 2);
    const rendered = await this.renderRecipe(decoded, recipe, 0);
    const format = image.preview.format;
    const buffer = await this.mediaRepository.encodeDevelopOutput(rendered.data, rendered.info, {
      detail: rendered.detail,
      colorspace: decoded.colorspace,
      format,
      quality: image.preview.quality,
      size: dto.size,
    });
    return { buffer: buffer!, contentType: format === ImageFormat.Webp ? 'image/webp' : 'image/jpeg' };
  }

  async getFile(
    auth: AuthDto,
    assetId: string,
    revisionId: string,
    kind: AssetDevelopFileKind,
  ): Promise<ImmichFileResponse> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const revision = await this.requireRevision(assetId, revisionId);
    const filePath = kind === AssetDevelopFileKind.Master ? revision.masterPath : revision.previewPath;
    if (!filePath || revision.status !== AssetDevelopRevisionStatus.Rendered) {
      throw new NotFoundException('This version has not been rendered yet');
    }
    return new ImmichFileResponse({
      path: filePath,
      contentType: mimeTypes.lookup(filePath),
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  @OnJob({ name: JobName.AssetDevelopRender, queue: QueueName.Editor })
  async handleRender({ id }: JobOf<JobName.AssetDevelopRender>): Promise<JobStatus> {
    const revision = await this.assetDevelopRepository.get(id);
    if (!revision) {
      this.logger.warn(`Develop render skipped: revision ${id} no longer exists`);
      return JobStatus.Skipped;
    }
    if (revision.cancelRequested) {
      await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Cancelled, progress: 0 });
      return JobStatus.Skipped;
    }
    if (revision.status === AssetDevelopRevisionStatus.Rendered) {
      // A stale duplicate of an already finished job must never replace valid files.
      return JobStatus.Skipped;
    }

    const source = await this.assetJobRepository.getForGenerateThumbnailJob(revision.assetId);
    if (!source || source.type !== AssetType.Image) {
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'The original image is no longer available',
      });
      return JobStatus.Failed;
    }

    const { image } = await this.getConfig();
    const outputs = this.getOutputPaths(source, revision, image);
    const tmp = { master: `${outputs.master}.tmp`, preview: `${outputs.preview}.tmp` };
    try {
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Rendering,
        progress: 5,
        error: null,
        rendererVersion: DEVELOP_RENDERER_VERSION,
      });
      const recipe = normalizeDevelopRecipe(revision.recipe);

      const decoded = await this.decodeSource(source, image);
      await this.progress(id, 25);

      const rendered = await this.renderRecipe(decoded, recipe, revision.revision);
      await this.progress(id, 60);

      this.storageRepository.mkdirSync(path.dirname(outputs.master));
      const masterFormat = image.fullsize.format;
      await this.mediaRepository.encodeDevelopOutput(
        rendered.data,
        rendered.info,
        {
          detail: rendered.detail,
          colorspace: decoded.colorspace,
          format: masterFormat,
          quality: Math.max(image.fullsize.quality, MASTER_MIN_QUALITY),
          progressive: image.fullsize.progressive,
        },
        tmp.master,
      );
      await this.progress(id, 85);

      await this.mediaRepository.encodeDevelopOutput(
        rendered.data,
        rendered.info,
        {
          detail: rendered.detail,
          colorspace: decoded.colorspace,
          format: image.preview.format,
          quality: image.preview.quality,
          size: image.preview.size,
        },
        tmp.preview,
      );
      await this.progress(id, 95);

      // Atomic publish: both files exist before either path is recorded.
      await this.storageRepository.rename(tmp.master, outputs.master);
      await this.storageRepository.rename(tmp.preview, outputs.preview);
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Rendered,
        progress: 100,
        error: null,
        masterPath: outputs.master,
        previewPath: outputs.preview,
        width: rendered.info.width,
        height: rendered.info.height,
        renderedAt: new Date(),
      });
      // Saving a version makes it the working version; Revert walks back through history.
      await this.assetDevelopRepository.setCurrent(revision.assetId, id);
      return JobStatus.Success;
    } catch (error) {
      await this.discard([tmp.master, tmp.preview]);
      if (error instanceof DevelopRenderCancelled) {
        await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Cancelled, progress: 0 });
        return JobStatus.Skipped;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Develop render failed for revision ${id}: ${message}`);
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: message.slice(0, 500),
      });
      return JobStatus.Failed;
    }
  }

  /** Rows and rendered files go with the asset; the original was never ours to delete. */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId }: ArgOf<'AssetDelete'>) {
    const files = await this.assetDevelopRepository.getFilePaths(assetId);
    await this.assetDevelopRepository.deleteByAsset(assetId);
    if (files.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
    }
  }

  private async queueRender(revision: AssetDevelopRevision): Promise<AssetDevelopRevisionResponseDto> {
    const queued = await this.assetDevelopRepository.update(revision.id, {
      status: AssetDevelopRevisionStatus.Queued,
      progress: 0,
      error: null,
      cancelRequested: false,
    });
    await this.jobRepository.queue({ name: JobName.AssetDevelopRender, data: { id: revision.id } });
    return this.toRevisionDto(queued ?? revision);
  }

  private async requireEditableStill(assetId: string) {
    const asset = await this.assetRepository.getById(assetId, { exifInfo: true });
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (asset.type !== AssetType.Image) {
      throw new BadRequestException('Develop recipes apply to images; videos use the video editor');
    }
    if (asset.isOffline) {
      throw new BadRequestException('The original file is offline and cannot be rendered');
    }
    if (asset.livePhotoVideoId) {
      throw new BadRequestException('Editing live photos is not supported');
    }
    if (asset.exifInfo?.projectionType === 'EQUIRECTANGULAR') {
      throw new BadRequestException('Editing panorama media is not supported');
    }
    const name = asset.originalFileName.toLowerCase();
    if (name.endsWith('.gif') || name.endsWith('.svg')) {
      throw new BadRequestException('Editing GIF and SVG images is not supported');
    }
    return asset;
  }

  private async requireRevision(assetId: string, revisionId: string): Promise<AssetDevelopRevision> {
    const revision = await this.assetDevelopRepository.get(revisionId);
    if (!revision || revision.assetId !== assetId) {
      throw new NotFoundException('Develop version not found');
    }
    return revision;
  }

  /**
   * Rendered files sit beside the asset's other derived images, named by revision so two
   * versions never share a path and a re-render of one version can never overwrite another.
   */
  private getOutputPaths(
    source: Pick<DevelopSource, 'id' | 'ownerId'>,
    revision: Pick<AssetDevelopRevision, 'id'>,
    image: SystemConfig['image'],
  ) {
    const base = StorageCore.getNestedFolder(StorageFolder.Thumbnails, source.ownerId, source.id);
    return {
      master: path.join(base, `${source.id}_develop_${revision.id}_master.${image.fullsize.format}`),
      preview: path.join(base, `${source.id}_develop_${revision.id}_preview.${image.preview.format}`),
    };
  }

  private async decodeSource(source: DevelopSource, image: SystemConfig['image'], size?: number) {
    const isRaw = mimeTypes.isRaw(source.originalFileName);
    const extracted = isRaw && image.extractEmbedded ? await this.mediaRepository.extract(source.originalPath) : null;
    const colorspace = this.isSRGB(source.exifInfo) ? Colorspace.Srgb : image.colorspace;
    const input = extracted ? extracted.buffer : source.originalPath;
    // An embedded preview carries no EXIF orientation of its own, so it takes the asset's;
    // the original file is auto-oriented from its own EXIF and must not be rotated twice.
    const orientation = extracted && source.exifInfo.orientation ? Number(source.exifInfo.orientation) : undefined;
    const { data, info } = await this.mediaRepository.decodeImage(input, {
      colorspace,
      processInvalidImages: false,
      orientation,
      size,
    });
    return { data, info: info as RawImageInfo, colorspace };
  }

  private async renderRecipe(decoded: { data: Buffer; info: RawImageInfo }, recipe: AssetDevelopRecipe, seed: number) {
    const geometry = planDevelopGeometry(recipe, decoded.info.width, decoded.info.height);
    const shaped = await this.mediaRepository.renderDevelopGeometry(decoded.data, decoded.info, geometry);
    const { params, look } = effectiveDevelop(recipe);
    applyDevelopTone(shaped.data, shaped.info, params, look, seed + 1);
    const detail = planDevelopDetail(params, { width: shaped.info.width, height: shaped.info.height });
    return { data: shaped.data, info: shaped.info, detail };
  }

  private async progress(id: string, progress: number) {
    if (await this.assetDevelopRepository.isCancelRequested(id)) {
      throw new DevelopRenderCancelled();
    }
    await this.assetDevelopRepository.update(id, { progress });
  }

  private async discard(paths: string[]) {
    for (const file of paths) {
      await this.storageRepository.unlink(file).catch(() => undefined);
    }
  }

  private isSRGB(exifInfo: {
    colorspace?: string | null;
    profileDescription?: string | null;
    bitsPerSample?: number | null;
  }) {
    const { colorspace, profileDescription, bitsPerSample } = exifInfo;
    if (colorspace || profileDescription) {
      return [colorspace, profileDescription].some((s) => s?.toLowerCase().includes('srgb'));
    }
    if (bitsPerSample) {
      return bitsPerSample === 8;
    }
    return true;
  }

  private getConfig() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );
  }

  private async toResponse(assetId: string): Promise<AssetDevelopResponseDto> {
    const revisions = await this.assetDevelopRepository.listByAsset(assetId);
    return {
      assetId,
      currentRevisionId: revisions.find((revision) => revision.isCurrent)?.id ?? null,
      revisions: revisions.map((revision) => this.toRevisionDto(revision)),
    };
  }

  private toRevisionDto(revision: AssetDevelopRevision): AssetDevelopRevisionResponseDto {
    return {
      id: revision.id,
      assetId: revision.assetId,
      revision: revision.revision,
      label: revision.label,
      status: revision.status,
      progress: revision.progress,
      error: revision.error,
      recipe: normalizeDevelopRecipe(revision.recipe),
      rendererVersion: revision.rendererVersion,
      width: revision.width,
      height: revision.height,
      isCurrent: revision.isCurrent,
      hasMaster: revision.status === AssetDevelopRevisionStatus.Rendered && !!revision.masterPath,
      hasPreview: revision.status === AssetDevelopRevisionStatus.Rendered && !!revision.previewPath,
      createdAt: asDateTimeString(revision.createdAt),
      updatedAt: asDateTimeString(revision.updatedAt),
      renderedAt: revision.renderedAt ? asDateTimeString(revision.renderedAt) : null,
    };
  }
}
