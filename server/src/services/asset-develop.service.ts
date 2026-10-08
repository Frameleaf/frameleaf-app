import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setInterval } from 'node:timers/promises';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { HdrHistogram } from 'src/queue/image-hdr-histogram.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf, RawImageInfo } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  ASSET_DEVELOP_RECIPE_VERSION,
  AssetDevelopArtifactKind,
  AssetDevelopArtifactResponseDto,
  AssetDevelopArtifactUploadDto,
  AssetDevelopCleanupMethod,
  AssetDevelopFileKind,
  AssetDevelopFillGenerateDto,
  AssetDevelopPreviewDto,
  AssetDevelopResponseDto,
  AssetDevelopRevertDto,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionResponseDto,
  AssetDevelopRevisionStatus,
  AssetDevelopSaveDto,
  AssetDevelopSemanticMaskDto,
  type DarktableDevelopRecipe,
  type HdrAssetDevelopRecipe,
} from 'src/dtos/asset-develop.dto.js';
import { AssetDevelopImportDto, DevelopExportResponseDto } from 'src/dtos/photo-tools.dto.js';
import {
  AssetType,
  AssetVisibility,
  CacheControl,
  ChecksumAlgorithm,
  Colorspace,
  ImageFormat,
  ImmichWorker,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { attemptOutputPath, jobSignal, publishJobResult } from 'src/queue/context.js';
import { assertPublicationMotionSource, assertPublicationSource } from 'src/queue/transaction.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import {
  AssetDevelopRepository,
  type AssetDevelopRevision,
  type AssetDevelopRevisionUpdate,
} from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { InpaintUnavailableError, MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { type DevelopExport, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { isGranted, requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import {
  DARKTABLE_RENDERER_VERSION,
  encodeNativeDevelopOutput,
  renderDarktable,
} from 'src/utils/darktable-renderer.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  ARTIFACT_ID,
  type DevelopBitmap,
  applyDevelopCleanup,
  cleanupOperationBox,
  developCleanupArtifacts,
  developFillMask,
  developFillWindow,
  normalizeStrokes,
} from 'src/utils/develop-cleanup.js';
import {
  assertRenderableDevelopRecipe,
  developEnvelope,
  hasPublishedDevelopRendition,
  renderDevelopProjection,
  renderHdrDevelopProjection,
} from 'src/utils/develop-envelope.js';
import {
  DEVELOP_RENDERER_VERSION,
  applyDevelopMasks,
  applyDevelopTone,
  defaultDevelopRecipe,
  developMaskArtifacts,
  developRenderArtifacts,
  effectiveDevelop,
  maskMappingFor,
  planDevelopDetail,
  planDevelopGeometry,
} from 'src/utils/develop-recipe.js';
import { EditOperationRun, EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit } from 'src/utils/edit-operation.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { MEDIA_OPERATION_AUTO_RETRIES, MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { getKeyframeCommand } from 'src/utils/media.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';

/** The edited master keeps the source resolution and is encoded well above the playback previews. */
const MASTER_MIN_QUALITY = 92;

/** Largest developed file accepted back from another application (FL-64). */
export const DEVELOP_IMPORT_MAX_BYTES = 2 * 1024 ** 3;

/** Finished formats a developed file may come back in. RAW is what goes out, never what comes back. */
export const DEVELOP_IMPORT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.heic', '.heif']);

/**
 * A render claimed longer ago than this without a progress write is presumed lost (its worker
 * died or the queue dropped it) and may be claimed again. Progress is written between stages, so
 * a live render refreshes it well inside this window.
 */
export const DEVELOP_RENDER_LEASE_MS = 10 * 60 * 1000;

/**
 * FL-233: develop artifact bounds. A mask covers the whole original, so it is never larger than the
 * original (nor than `MASK_MAX_SIDE` when the original's size is unknown); a fill covers one Clean Up
 * area. A photo keeps at most `DEVELOP_ARTIFACT_PER_ASSET` artifacts (the repository holds that
 * limit, with the insert); one no saved version references is released after `UNREFERENCED_GRACE_MS`.
 */
export const DEVELOP_ARTIFACT_MAX_BYTES = 64 * 1024 ** 2;
export const DEVELOP_ARTIFACT_MASK_MAX_SIDE = 8192;
export const DEVELOP_ARTIFACT_FILL_MAX_SIDE = 4096;
export const DEVELOP_ARTIFACT_FILL_MAX_PIXELS = 16_000_000;
export const DEVELOP_ARTIFACT_UNREFERENCED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * FL-233: where a develop artifact of an asset is kept: beside its rendered versions, named by the
 * asset and the SHA-256 of the stored PNG (never a path a client chose).
 */
export const developArtifactPath = (asset: { id: string; ownerId: string }, artifactId: string) => {
  if (!ARTIFACT_ID.test(artifactId)) {
    throw new BadRequestException('Invalid develop artifact');
  }
  return path.join(
    StorageCore.getNestedFolder(StorageFolder.Thumbnails, asset.ownerId, asset.id),
    `${asset.id}_develop_artifact_${artifactId}.png`,
  );
};

const missingArtifact = () =>
  new BadRequestException({
    message: 'This recipe uses a develop artifact that was not uploaded for this photo',
    code: 'develop_artifact_missing',
  });

/** Where uploaded developed files wait while they are checked; never a library or upload folder. */
export const developImportStagingFolder = (ownerId: string) =>
  path.join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'develop-imports');

type ImportedFile = { path: string; originalname?: string; size: number };

type DevelopSource = NonNullable<Awaited<ReturnType<AssetJobRepository['getForGenerateThumbnailJob']>>>;

class DevelopRenderCancelled extends Error {
  constructor() {
    super('Develop render cancelled');
  }
}

/** The original or the imported file is no longer what the version was made from; retrying cannot help. */
class DevelopSourceChanged extends Error {}

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
    private cryptoRepository: CryptoRepository,
    private jobRepository: JobRepository,
    private mediaRepository: MediaRepository,
    private photoToolsRepository: PhotoToolsRepository,
    private storageRepository: StorageRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private mediaOperationRepository: MediaOperationRepository,
    private machineLearningRepository: MachineLearningRepository,
  ) {
    this.logger.setContext(AssetDevelopService.name);
    this.editOperations = new EditOperationTracker(mediaOperationRepository, jobRepository, logger);
  }

  /** FL-43: every render of a version is a job in Activity, run under its row's claim. */
  private editOperations: EditOperationTracker;
  /** The runs in progress by revision, so a stage's progress and a cancel reach the job's row. */
  private runs = new Map<string, EditOperationRun>();

  async get(auth: AuthDto, assetId: string): Promise<AssetDevelopResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    return this.toResponse(assetId);
  }

  async save(auth: AuthDto, assetId: string, dto: AssetDevelopSaveDto): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const asset = await this.requireEditableStill(assetId);
    const recipe = developEnvelope(dto.recipe);
    if (recipe.version === 2 && recipe.sensorCanvas)
      throw new BadRequestException('The mask drawing canvas is for previews only');
    if (dto.render && [3, 4, 5, 6].includes(recipe.version))
      await this.requireHdrRenderer(renderHdrDevelopProjection(recipe));
    if (dto.render && !dto.sourceRevisionId) {
      assertRenderableDevelopRecipe(recipe);
      await this.requireArtifacts(asset, recipe, auth);
    }
    const revision = await this.assetDevelopRepository.create({
      assetId,
      ownerId: asset.ownerId,
      recipe,
      recipeVersion: recipe.version,
      sourceRevisionId: dto.sourceRevisionId,
      replaceRecipe: dto.replaceRecipe,
      requireRenderable: dto.render,
      label: dto.label ?? null,
      status: AssetDevelopRevisionStatus.Saved,
    });
    if (dto.render) {
      if (dto.sourceRevisionId) await this.requireArtifacts(asset, revision.recipe, auth);
      return this.queueRender(revision, asset.originalFileName);
    }
    return this.toRevisionDto(revision);
  }

  async render(auth: AuthDto, assetId: string, revisionId: string): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const asset = await this.requireEditableStill(assetId);
    const revision = await this.requireRevision(assetId, revisionId);
    if (revision.kind === AssetDevelopRevisionKind.Recipe) {
      assertRenderableDevelopRecipe(revision.recipe);
      await this.requireArtifacts(asset, revision.recipe, auth);
    }
    if (
      revision.status === AssetDevelopRevisionStatus.Queued ||
      revision.status === AssetDevelopRevisionStatus.Rendering
    ) {
      return this.toRevisionDto(revision);
    }
    return this.queueRender(revision, asset.originalFileName);
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
      // FL-43: its job in Activity is cancelled with it.
      await this.editOperations.cancelRevision(revision.ownerId, revision.id);
      return this.toRevisionDto(updated ?? revision);
    }
    if (revision.status === AssetDevelopRevisionStatus.Rendering) {
      await this.assetDevelopRepository.requestCancel(revision.id);
      await this.editOperations.cancelRevision(revision.ownerId, revision.id);
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
    signal?: AbortSignal,
  ): Promise<{ buffer: Buffer; contentType: string; histogram?: HdrHistogram }> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source || source.type !== AssetType.Image) {
      throw new BadRequestException('Only images have develop previews');
    }
    const { image } = await this.getConfig();
    const recipe = assertRenderableDevelopRecipe(dto.recipe);
    // Preserve discriminated-union narrowing for the HDR renderer.
    // eslint-disable-next-line unicorn/prefer-includes-over-repeated-comparisons
    if (recipe.version === 3 || recipe.version === 4 || recipe.version === 5 || recipe.version === 6)
      return this.renderHdrPreview(source, recipe, dto, signal);
    if (dto.dynamicRange === 'hdr') throw new BadRequestException('HDR previews require recipe version 3, 4, 5 or 6');
    const motion =
      recipe.version === 1 && recipe.keyFrame
        ? await this.requireMotionClip(source, recipe.keyFrame.timeMs, auth, Permission.AssetEditGet)
        : undefined;
    const native = recipe.version === 2 ? await this.renderNativeRecipe(source, recipe, undefined, signal) : undefined;
    // Legacy recipes decode at preview scale; native previews share the full-resolution final pipeline.
    const keyframe = recipe.version === 1 ? recipe.keyFrame : undefined;
    const decoded =
      native ??
      (keyframe
        ? await this.decodeKeyframe(source, keyframe.timeMs, dto.size * 2, motion)
        : await this.decodeSource(source, image, dto.size * 2));
    const rendered = native ?? (await this.renderRecipe(decoded, renderDevelopProjection(dto.recipe), 0, source));
    const format = image.preview.format;
    const buffer = native
      ? await encodeNativeDevelopOutput(native.nativeBuffer, { format, quality: image.preview.quality, size: dto.size })
      : await this.mediaRepository.encodeDevelopOutput(rendered.data, rendered.info, {
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
    dynamicRange: 'auto' | 'sdr' | 'hdr' = 'sdr',
    format?: 'sdr-jpeg' | 'hdr-jpeg' | 'hdr-heic',
    signal?: AbortSignal,
  ): Promise<ImmichFileResponse> {
    signal?.throwIfAborted();
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    if (format) {
      if (auth.apiKey && !isGranted({ requested: [Permission.AssetDownload], current: auth.apiKey.permissions }))
        throw new ForbiddenException('This API key cannot download still exports');
      await requireAccess(this.accessRepository, { auth, permission: Permission.AssetDownload, ids: [assetId] });
      if (kind !== AssetDevelopFileKind.Master)
        throw new BadRequestException('Still exports require the full-resolution master');
      if (format === 'hdr-heic' && !(await this.mediaRepository.getHdrCodecCapabilities())?.heicPqEncoder)
        throw new BadRequestException({
          code: 'hdr_heic_export_unavailable',
          message: 'HDR HEIC export is unavailable',
        });
      dynamicRange = format === 'sdr-jpeg' ? 'sdr' : 'hdr';
    }
    const revision = await this.requireRevision(assetId, revisionId);
    const hdrEnabled = process.env.FRAMELEAF_HDR_IMAGES === 'experimental';
    const hdrPath = kind === AssetDevelopFileKind.Master ? revision.hdrMasterPath : revision.hdrPreviewPath;
    if (dynamicRange === 'hdr' && (!hdrEnabled || !hdrPath))
      throw new NotFoundException('HDR rendition is unavailable');
    const filePath =
      hdrEnabled && dynamicRange !== 'sdr' && hdrPath
        ? hdrPath
        : kind === AssetDevelopFileKind.Master
          ? revision.masterPath
          : revision.previewPath;
    if (!filePath || !hasPublishedDevelopRendition(revision)) {
      throw new NotFoundException('This version has not been rendered yet');
    }
    if (
      format === 'hdr-heic' ||
      (format === 'sdr-jpeg' &&
        revision.recipeVersion !== 3 &&
        revision.recipeVersion !== 4 &&
        revision.recipeVersion !== 5 &&
        revision.recipeVersion !== 6)
    ) {
      const heic = format === 'hdr-heic';
      if (!heic && revision.kind === AssetDevelopRevisionKind.External) {
        const encoding = await this.mediaRepository.inspectImageEncoding(filePath);
        if (encoding.dynamicRange !== 'sdr') throw new BadRequestException('This version has no verified SDR master');
      }
      // Export copies retain the saved rendition and renderer identity. Historical SDR converts
      // to sRGB JPEG; HDR HEIC reconstructs the published gain-map master in the same worker.
      const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-photo-export-'));
      const output = path.join(folder, heic ? 'still_hdr.heic' : 'still_sdr.jpg');
      const release = () =>
        void rm(folder, { recursive: true, force: true }).catch(() => {
          this.logger.warn('Unable to remove a temporary still export');
        });
      try {
        if (heic) {
          await this.mediaRepository.generateHdrRenditions(
            filePath,
            [{ path: output, format: 'heic' }],
            undefined,
            signal,
            revision.hdrRenditionChecksum ?? (await this.cryptoRepository.hashFile(filePath, 'sha256')),
          );
        } else {
          await this.mediaRepository.writeStrippedStill(filePath, output, 'jpeg', 'srgb', signal);
        }
        signal?.throwIfAborted();
        await requireAccess(this.accessRepository, { auth, permission: Permission.AssetDownload, ids: [assetId] });
        const current = await this.requireRevision(assetId, revisionId);
        const checksum = heic ? revision.hdrRenditionChecksum : revision.renditionChecksum;
        const currentChecksum = heic ? current.hdrRenditionChecksum : current.renditionChecksum;
        const sameChecksum = checksum ? currentChecksum?.equals(checksum) : currentChecksum === null;
        if (
          !hasPublishedDevelopRendition(current) ||
          (heic ? current.hdrMasterPath : current.masterPath) !== filePath ||
          current.updatedAt.getTime() !== revision.updatedAt.getTime() ||
          !sameChecksum
        )
          throw new ConflictException('This version changed during export; try again');
        return new ImmichFileResponse({
          path: output,
          contentType: heic ? 'image/heic' : 'image/jpeg',
          release,
          fileName: `${assetId}_${revisionId}_${heic ? 'still_hdr.heic' : 'still_sdr.jpg'}`,
          cacheControl: CacheControl.PrivateWithoutCache,
        });
      } catch (error) {
        // Await actual worker cancellation before removing its private output directory.
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
    }
    signal?.throwIfAborted();
    return new ImmichFileResponse({
      path: filePath,
      contentType: mimeTypes.lookup(filePath),
      ...(format && { fileName: `${assetId}_${revisionId}_still_${dynamicRange}.jpg` }),
      cacheControl: format ? CacheControl.PrivateWithoutCache : CacheControl.PrivateWithCache,
    });
  }

  /**
   * Renders one version. A recipe is rendered from the original into an edited master and a
   * preview; a file developed elsewhere already is the master, so only its preview is made. The
   * files are published atomically and only then does the version become current, so a failed
   * or cancelled render always leaves the previous working version in place. A failure gets
   * exactly one automatic retry (owner decision, September 22, 2026); after that it waits for a
   * person to retry it.
   */
  @OnJob({ name: JobName.AssetDevelopRender, queue: QueueName.Editor })
  async handleRender({ id, operationId }: JobOf<JobName.AssetDevelopRender>): Promise<JobStatus> {
    // FL-43: a render queued with its Activity job runs under that job's claim. One cancelled in
    // Activity before it started never starts, and the version reads cancelled.
    return this.editOperations.execute(
      operationId,
      async (run) => {
        if (run) {
          this.runs.set(id, run);
        }
        try {
          return await this.renderRevision(id, run);
        } finally {
          this.runs.delete(id);
        }
      },
      {
        onCancelled: async () => {
          await this.assetDevelopRepository.update(id, {
            status: AssetDevelopRevisionStatus.Cancelled,
            cancelRequested: true,
            progress: 0,
          });
        },
      },
    );
  }

  private async renderRevision(id: string, run?: EditOperationRun): Promise<JobStatus> {
    const existing = await this.assetDevelopRepository.get(id);
    if (!existing) {
      this.logger.warn(`Develop render skipped: revision ${id} no longer exists`);
      await run?.fail('This version no longer exists', 'revision_missing', { retry: false });
      return JobStatus.Skipped;
    }
    if (existing.cancelRequested) {
      if (existing.status !== AssetDevelopRevisionStatus.Cancelled) {
        await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Cancelled, progress: 0 });
      }
      await run?.cancelled();
      return JobStatus.Skipped;
    }
    if (!this.isClaimable(existing)) {
      // Finished, failed, or a live render already holds it: a stale or duplicate delivery must
      // never replace valid files or race the render in progress.
      await this.settleUnclaimable(existing, run);
      return JobStatus.Skipped;
    }

    const source = await this.assetJobRepository.getForGenerateThumbnailJob(existing.assetId);
    if (!source || source.type !== AssetType.Image) {
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Failed,
        error: 'The original image is no longer available',
      });
      await run?.fail('The original image is no longer available', 'source_missing', { retry: false });
      return JobStatus.Failed;
    }

    const revision = await this.assetDevelopRepository.beginAttempt(
      id,
      existing.kind === AssetDevelopRevisionKind.Recipe && existing.recipe.version === 2
        ? DARKTABLE_RENDERER_VERSION
        : existing.kind === AssetDevelopRevisionKind.Recipe && existing.recipe.version === 3
          ? 'frameleaf-develop-hdr/1'
          : existing.kind === AssetDevelopRevisionKind.Recipe && existing.recipe.version === 4
            ? 'frameleaf-develop-hdr/2'
            : existing.kind === AssetDevelopRevisionKind.Recipe && existing.recipe.version === 5
              ? 'frameleaf-develop-hdr/3'
              : existing.kind === AssetDevelopRevisionKind.Recipe && existing.recipe.version === 6
                ? 'frameleaf-develop-hdr/4'
                : DEVELOP_RENDERER_VERSION,
      DEVELOP_RENDER_LEASE_MS / 1000,
    );
    if (!revision) {
      // Another delivery took it between the check above and here; this job waits its turn.
      await run?.release(DEVELOP_RENDER_LEASE_MS);
      return JobStatus.Skipped;
    }

    const { image } = await this.getConfig();
    const outputs = this.getOutputPaths(source, revision, image);
    const external = revision.kind === AssetDevelopRevisionKind.External;
    const tmp = {
      master: `${outputs.master}.tmp`,
      preview: `${outputs.preview}.tmp`,
      hdrMaster: `${outputs.hdrMaster}.tmp`,
      hdrPreview: `${outputs.hdrPreview}.tmp`,
    };
    try {
      const parsed = external ? undefined : assertRenderableDevelopRecipe(revision.recipe);
      const motion =
        parsed?.version === 1 && parsed.keyFrame
          ? await this.requireMotionClip(source, parsed.keyFrame.timeMs)
          : undefined;
      const sourceChecksum = motion
        ? await this.cryptoRepository.hashFile(motion.originalPath, 'sha256')
        : await this.currentSourceChecksum(revision.assetId);
      const publication: AssetDevelopRevisionUpdate = external
        ? await this.renderExternal(revision, sourceChecksum, outputs.preview, tmp.preview, image)
        : await this.renderRecipeRevision(revision, source, sourceChecksum, outputs, tmp, image, motion);
      publication.sourceAssetId = motion?.id ?? source.id;
      // FL-43: the version becomes the working one only under its job's claim. A run that lost its
      // claim, or was cancelled at the last moment, leaves the previous working version current.
      if (run && !(await run.validate())) {
        if (!external) await this.discard([...Object.values(tmp), ...Object.values(outputs)]);
        return JobStatus.Skipped;
      }
      // Rendering a version makes it the working version; Revert walks back through history.
      await publishJobResult(async () => {
        if (motion) {
          // Direct calls revalidate too; workers additionally lock these identities during adoption.
          const current = await this.requireMotionClip(source, parsed!.version === 1 ? parsed!.keyFrame!.timeMs : 0);
          if (current.id !== motion.id || !current.checksum.equals(motion.checksum))
            throw new DevelopSourceChanged('The motion clip changed while rendering');
          await assertPublicationMotionSource(source.id, source.ownerId, source.checksum, motion.id, motion.checksum);
        } else {
          await assertPublicationSource(source.id, source.checksum);
        }
        if (await this.assetDevelopRepository.isCancelRequested(id)) throw new DevelopRenderCancelled();
        await this.assetDevelopRepository.update(revision.id, publication);
        await this.assetDevelopRepository.setCurrent(revision.assetId, id);
        if (!external) {
          const accepted = new Set([
            publication.masterPath,
            publication.previewPath,
            publication.hdrMasterPath,
            publication.hdrPreviewPath,
          ]);
          const replaced = [
            ...new Set([revision.masterPath, revision.previewPath, revision.hdrMasterPath, revision.hdrPreviewPath]),
          ].filter((path): path is string => !!path && !accepted.has(path));
          if (replaced.length > 0) await this.queueFileDelete(replaced);
        }
      });
      return JobStatus.Success;
    } catch (error) {
      await this.discard(
        external
          ? [tmp.preview]
          : [3, 4, 5, 6].includes(revision.recipeVersion)
            ? [...Object.values(tmp), ...Object.values(outputs)]
            : [tmp.master, tmp.preview, outputs.master, outputs.preview],
      );
      jobSignal()?.throwIfAborted();
      if (run?.done) return JobStatus.Skipped;
      if (error instanceof DevelopRenderCancelled) {
        await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Cancelled, progress: 0 });
        await run?.cancelled();
        return JobStatus.Skipped;
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const permanent = error instanceof DevelopSourceChanged || error instanceof BadRequestException;
      if (run) {
        return this.failTracked(run, revision, message, permanent, error instanceof DevelopSourceChanged);
      }
      if (!permanent && revision.attempts <= MEDIA_OPERATION_AUTO_RETRIES) {
        this.logger.warn(`Develop render of revision ${id} failed, retrying once: ${message}`);
        await this.assetDevelopRepository.update(id, {
          status: AssetDevelopRevisionStatus.Queued,
          progress: 0,
          error: message,
        });
        await this.jobRepository.queue({
          name: JobName.AssetDevelopRender,
          data: { id, delay: MEDIA_OPERATION_AUTO_RETRY_DELAY_MS },
        });
        return JobStatus.Failed;
      }
      this.logger.error(`Develop render failed for revision ${id}: ${message}`);
      await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Failed, error: message });
      if (external && permanent && revision.masterPath) {
        // A file that no longer answers the original (or is gone) can never become a version.
        await this.assetDevelopRepository.update(id, { masterPath: null });
        await this.discard([revision.masterPath]);
      }
      return JobStatus.Failed;
    }
  }

  /**
   * A render under an Activity job failed (FL-43). The job decides the one automatic retry every
   * job gets: while it has it, the version waits queued and the job is put back on the queue for
   * it; after that, or for a source that changed, the version and the job both read failed.
   */
  private async failTracked(
    run: EditOperationRun,
    revision: AssetDevelopRevision,
    message: string,
    permanent: boolean,
    sourceChanged: boolean,
  ): Promise<JobStatus> {
    const id = revision.id;
    const outcome = await run.fail(message, sourceChanged ? 'source_changed' : 'edit_render_failed', {
      retry: !permanent,
    });
    if (outcome === 'retrying') {
      this.logger.warn(`Develop render of revision ${id} failed, retrying once: ${message}`);
      await this.assetDevelopRepository.update(id, {
        status: AssetDevelopRevisionStatus.Queued,
        progress: 0,
        error: message,
      });
      return JobStatus.Failed;
    }
    this.logger.error(`Develop render failed for revision ${id}: ${message}`);
    await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Failed, error: message });
    if (revision.kind === AssetDevelopRevisionKind.External && permanent && revision.masterPath) {
      await this.assetDevelopRepository.update(id, { masterPath: null });
      await this.discard([revision.masterPath]);
    }
    return JobStatus.Failed;
  }

  /**
   * A tracked render found its version not waiting (FL-43): already rendered is nothing left to do;
   * held by a render still inside its lease waits for it; anything else is a version that is no
   * longer queued, which retrying the job would not change.
   */
  private async settleUnclaimable(revision: AssetDevelopRevision, run?: EditOperationRun) {
    if (!run) {
      return;
    }
    if (revision.status === AssetDevelopRevisionStatus.Rendered) {
      await run.complete(null);
    } else if (revision.status === AssetDevelopRevisionStatus.Rendering) {
      await run.release(DEVELOP_RENDER_LEASE_MS);
    } else {
      await run.fail('This version is no longer waiting to be rendered', 'revision_not_queued', { retry: false });
    }
  }

  /**
   * Puts renders the queue lost back on it: a restart or a flushed queue leaves rows queued, or
   * rendering with a lapsed lease, that no job will ever pick up. The render claim itself
   * refuses a live one, so requeueing is safe to repeat. A render with an Activity job (FL-43) is
   * left to that job's recovery, which dispatches it again with its row.
   */
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    const unfinished = await this.assetDevelopRepository.listUnfinished();
    const claimable = unfinished.filter((revision) => this.isClaimable(revision));
    const tracked = await this.mediaOperationRepository.getTrackedRevisionIds(claimable.map(({ id }) => id));
    const lost = [];
    for (const revision of claimable) {
      if (tracked.has(revision.id)) continue;
      if (revision.kind === AssetDevelopRevisionKind.Recipe) {
        try {
          assertRenderableDevelopRecipe(revision.recipe);
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
          await this.assetDevelopRepository.update(revision.id, {
            status: AssetDevelopRevisionStatus.Failed,
            error: error.message,
          });
          continue;
        }
      }
      lost.push(revision);
    }
    if (lost.length === 0) {
      return;
    }
    this.logger.log(`Requeueing ${lost.length} develop render(s) left unfinished`);
    await this.jobRepository.queueAll(lost.map(({ id }) => ({ name: JobName.AssetDevelopRender, data: { id } })));
  }

  /* External development round trip (FL-64) ---------------------------------------------------- */

  async listExports(auth: AuthDto, assetId: string): Promise<DevelopExportResponseDto[]> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditGet, ids: [assetId] });
    const exports = await this.photoToolsRepository.listExports(assetId);
    if (exports.length === 0) {
      return [];
    }
    const current = await this.currentSourceChecksum(assetId);
    return exports.map((item) => this.toExportDto(item, current));
  }

  /**
   * Records that the original is going out for development elsewhere, with the SHA-256 of its
   * bytes now. The client then downloads the original through the ordinary download route.
   */
  async createExport(auth: AuthDto, assetId: string): Promise<DevelopExportResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const asset = await this.requireEditableStill(assetId);
    const checksum = await this.currentSourceChecksum(assetId);
    const created = await this.photoToolsRepository.createExport({
      assetId,
      ownerId: asset.ownerId,
      sourceChecksum: checksum,
      fileName: asset.originalFileName,
    });
    return this.toExportDto(created, checksum);
  }

  /**
   * Brings a file developed in another application back as a new version of the photo. Nothing
   * is kept unless every check passes: the photo may be edited by this session (a Locked photo
   * only in an unlocked session), the file is a finished image that arrived intact, and it was
   * developed from the original this photo has now. The original is never touched; the new
   * version becomes the working version only once its preview has rendered.
   */
  async importRendition(
    auth: AuthDto,
    assetId: string,
    dto: AssetDevelopImportDto,
    file: ImportedFile | undefined,
  ): Promise<AssetDevelopRevisionResponseDto> {
    if (!file?.path) {
      throw new BadRequestException('Choose the developed file to bring back');
    }
    let kept: string | undefined;
    try {
      await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
      const asset = await this.requireEditableStill(assetId);

      const fileName = path.basename(file.originalname || 'developed').slice(0, 255);
      const extension = path.extname(fileName).toLowerCase();
      if (mimeTypes.isRaw(fileName)) {
        throw new BadRequestException('Bring back the developed file (JPEG, TIFF, PNG, WebP or HEIF), not a RAW');
      }
      if (!DEVELOP_IMPORT_EXTENSIONS.has(extension)) {
        throw new BadRequestException('Bring back a JPEG, TIFF, PNG, WebP or HEIF file');
      }
      if (file.size === 0) {
        throw new BadRequestException('The file is empty');
      }
      if (file.size > DEVELOP_IMPORT_MAX_BYTES) {
        throw new BadRequestException('The file is larger than a developed version may be');
      }

      const exported = dto.exportId ? await this.photoToolsRepository.getExport(dto.exportId) : undefined;
      if (dto.exportId && exported?.assetId !== assetId) {
        // Unknown and someone else's exports answer the same, so no export id leaks.
        throw new BadRequestException('That export was not made from this photo');
      }
      const claimed = dto.sourceChecksum ? Buffer.from(dto.sourceChecksum, 'hex') : undefined;
      if (exported && claimed && !exported.sourceChecksum.equals(claimed)) {
        throw new BadRequestException('The original checksum does not match the export');
      }
      const expected = exported?.sourceChecksum ?? claimed;
      if (!expected) {
        throw new BadRequestException('Say which export or original checksum the file was developed from');
      }
      const current = await this.currentSourceChecksum(assetId);
      if (!current.equals(expected)) {
        throw new ConflictException(
          'This file was developed from a different original than the photo has now; nothing was changed',
        );
      }

      // A file that only looks like an image by its name is refused before it is kept.
      const probe = await this.mediaRepository.getImageMetadata(file.path).catch(() => null);
      if (!probe || !(probe.width > 0 && probe.height > 0)) {
        throw new BadRequestException('The file is not a readable image');
      }

      const received = await this.cryptoRepository.hashFile(file.path, 'sha256');
      if (dto.renditionChecksum && received.toString('hex') !== dto.renditionChecksum) {
        throw new BadRequestException('The file did not arrive intact; nothing was changed, try again');
      }

      const master = path.join(
        StorageCore.getNestedFolder(StorageFolder.Thumbnails, asset.ownerId, asset.id),
        `${asset.id}_develop_import_${randomUUID()}${extension}`,
      );
      this.storageRepository.mkdirSync(path.dirname(master));
      await this.storageRepository.rename(file.path, master);
      kept = master;

      const revision = await this.assetDevelopRepository.create({
        assetId,
        ownerId: asset.ownerId,
        recipe: defaultDevelopRecipe(),
        recipeVersion: ASSET_DEVELOP_RECIPE_VERSION,
        label: dto.label ?? null,
        status: AssetDevelopRevisionStatus.Saved,
        kind: AssetDevelopRevisionKind.External,
        sourceChecksum: current,
        renditionChecksum: received,
        exportId: exported?.id ?? null,
        fileName,
        software: dto.software ?? null,
        masterPath: master,
      });
      kept = undefined;
      this.logger.log(`Developed file ${fileName} brought back as version ${revision.revision} of asset ${assetId}`);
      return await this.queueRender(revision, asset.originalFileName);
    } finally {
      // Whatever was not recorded is removed: the staged upload, or a kept copy with no row.
      await this.discard([file.path, ...(kept ? [kept] : [])]);
    }
  }

  /**
   * Rows and rendered files go with the asset; the original was never ours to delete. A permanent
   * deletion takes the rows and releases the files inside its removal (FL-169); this cleans up what
   * that removal had to leave. FL-179: like the removal, it leaves them while fork writes are refused
   * (a handoff or return reconciliation running), and the nightly sweep below releases them later.
   */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId }: ArgOf<'AssetDelete'>) {
    await this.assetDevelopRepository.releaseRemovedAssetRevisions((files) => this.queueFileDelete(files), assetId);
    // FL-233: the asset's develop artifacts go with it
    await this.assetDevelopRepository.releaseArtifacts((files) => this.queueFileDelete(files), { assetId });
  }

  /**
   * FL-233: `POST assets/:id/develop/artifacts`: keep a mask bitmap or a generated fill a client
   * computed for this photo, so recipes can reference it by its SHA-256 and every client and the
   * server render the same result. Stored normalized (orientation applied, metadata dropped, PNG);
   * uploading the same bitmap again returns the same id. The original is never touched.
   */
  async uploadArtifact(
    auth: AuthDto,
    assetId: string,
    dto: AssetDevelopArtifactUploadDto,
    file: ImportedFile | undefined,
  ): Promise<AssetDevelopArtifactResponseDto> {
    if (!file?.path) {
      throw new BadRequestException('Choose the bitmap to upload');
    }
    try {
      await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
      const asset = await this.requireEditableStill(assetId);
      if (file.size === 0 || file.size > DEVELOP_ARTIFACT_MAX_BYTES) {
        throw new BadRequestException('The bitmap is empty or larger than a develop artifact may be');
      }
      const probe = await this.mediaRepository.getImageMetadata(file.path).catch(() => null);
      if (!probe || !(probe.width > 0 && probe.height > 0) || !this.artifactSizeAllowed(asset, dto.kind, probe)) {
        throw new BadRequestException(
          dto.kind === AssetDevelopArtifactKind.Mask
            ? 'A mask must be a readable bitmap no larger than the original'
            : `A fill must be a readable bitmap of at most ${DEVELOP_ARTIFACT_FILL_MAX_SIDE} pixels a side`,
        );
      }
      const normalized = await this.mediaRepository.normalizeDevelopArtifact(file.path, dto.kind);
      const id = this.cryptoRepository.hashSha256(normalized.data).toString('hex');
      const [existing] = await this.assetDevelopRepository.getArtifacts(asset.id, [id]);
      if (existing && existing.kind !== dto.kind) {
        // the same bytes normalised as the other kind cannot happen (a mask has one channel, a fill four)
        throw new BadRequestException('This bitmap is already stored as a different kind of develop artifact');
      }
      const target = developArtifactPath(asset, id);
      if (existing) {
        // the same bitmap again: record it again, which restarts its grace period, and make sure its
        // file is still there (a release may have taken both since it was found)
        await this.recordArtifact(asset, id, dto.kind, target, normalized);
        return { id, kind: existing.kind as AssetDevelopArtifactKind, width: existing.width, height: existing.height };
      }
      this.storageRepository.mkdirSync(path.dirname(target));
      await this.writeArtifactFile(target, normalized.data);
      try {
        // FL-304: recording it checks the photo's limit and the owner's quota and charges the
        // owner's storage usage, all in one transaction
        await this.recordArtifact(asset, id, dto.kind, target, normalized);
      } catch (error) {
        // not recorded (the photo is full, the owner's storage is, or the server is being handed
        // over): the file goes again, unless the same bitmap was recorded meanwhile
        await this.queueFileDelete([target]);
        throw error;
      }
      return { id, kind: dto.kind, width: normalized.width, height: normalized.height };
    } finally {
      await this.discard([file.path]);
    }
  }

  /**
   * Generate a subject or sky proposal and persist it through owned artifact admission. By default (RAW
   * only) from the unrotated sensor canvas, for version 2 recipes; with `coordinates: 'original'` from
   * any still's oriented original, as a mask covering the whole original for version 1 recipes.
   */
  async proposeSemanticMask(
    auth: AuthDto,
    assetId: string,
    dto: AssetDevelopSemanticMaskDto,
    signal?: AbortSignal,
  ): Promise<AssetDevelopArtifactResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    if (dto.coordinates === 'original') {
      return this.proposeOriginalMask(auth, assetId, dto.target, signal);
    }
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source || !mimeTypes.isRaw(source.originalFileName))
      throw new BadRequestException('Native semantic masks require a RAW original');
    const developed = await renderDarktable(
      source.originalPath,
      { version: 2, renderer: 'darktable/5.6.1', exposureEV: 0, sensorCanvas: true },
      signal,
    );
    const canvas = await sharp(developed)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    signal?.throwIfAborted();
    const png = await this.machineLearningRepository.semanticMaskLocal(canvas, dto.target, signal);
    const metadata = await sharp(png, { failOn: 'warning', limitInputPixels: 2048 * 2048 }).metadata();
    const reference = await sharp(canvas).metadata();
    if (metadata.format !== 'png' || metadata.width !== reference.width || metadata.height !== reference.height)
      throw new BadRequestException('Local worker returned an invalid sensor mask');
    await sharp(png).stats();
    const directory = await mkdtemp(path.join(tmpdir(), 'frameleaf-semantic-mask-'));
    const file = path.join(directory, 'mask.png');
    try {
      await writeFile(file, png, { flag: 'wx' });
      signal?.throwIfAborted();
      return await this.uploadArtifact(
        auth,
        assetId,
        { kind: AssetDevelopArtifactKind.Mask },
        { path: file, size: png.length },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Version 1 subject and sky masks: the proposal is computed on the oriented original (a RAW through
   * LibRaw, which applies the orientation once), at most 1024 pixels a side, and stored as a mask
   * artifact that a recipe stretches over the whole original.
   */
  private async proposeOriginalMask(
    auth: AuthDto,
    assetId: string,
    target: 'subject' | 'sky',
    signal?: AbortSignal,
  ): Promise<AssetDevelopArtifactResponseDto> {
    await this.requireEditableStill(assetId);
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source || source.type !== AssetType.Image) throw new BadRequestException('Only stills have develop masks');
    const canvas = await sharp(await this.orientedOriginal(source, signal), {
      failOn: 'error',
      limitInputPixels: 200_000_000,
    })
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb')
      .jpeg({ quality: 92 })
      .toBuffer();
    signal?.throwIfAborted();
    const png = await this.machineLearningRepository.semanticMaskLocal(canvas, target, signal);
    const metadata = await sharp(png, { failOn: 'warning', limitInputPixels: 2048 * 2048 }).metadata();
    const reference = await sharp(canvas).metadata();
    if (metadata.format !== 'png' || metadata.width !== reference.width || metadata.height !== reference.height)
      throw new BadRequestException('Local worker returned an invalid mask');
    return this.admitGeneratedArtifact(auth, assetId, AssetDevelopArtifactKind.Mask, png, signal);
  }

  /**
   * Clean Up Remove (native API): generate the fill for an area on the server. The area and some context
   * around it go to the instance-local ML worker with a mask of the area; the filled pixels of the area's
   * bounding box come back and are stored as a fill artifact, which the recipe's Remove operation names
   * as its `fill`. Nothing leaves this server. The worker fills with LaMa (big-lama); while no local worker
   * can (ML off, remote-only, or the model is not available to it) this answers 503 `develop_inpaint_unavailable`.
   */
  async generateFill(
    auth: AuthDto,
    assetId: string,
    dto: AssetDevelopFillGenerateDto,
    signal?: AbortSignal,
  ): Promise<AssetDevelopArtifactResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    await this.requireEditableStill(assetId);
    const source = await this.assetJobRepository.getForGenerateThumbnailJob(assetId);
    if (!source || source.type !== AssetType.Image) throw new BadRequestException('Only stills have Clean Up');
    const input = await this.orientedOriginal(source, signal);
    const metadata = await sharp(input, { failOn: 'error', limitInputPixels: 200_000_000 }).metadata();
    const swapped = (metadata.orientation ?? 1) >= 5 && !Buffer.isBuffer(input);
    const original = {
      width: (swapped ? metadata.height : metadata.width) ?? 0,
      height: (swapped ? metadata.width : metadata.height) ?? 0,
    };
    const area = { region: dto.region, strokes: dto.strokes, feather: dto.feather };
    const box = cleanupOperationBox(
      {
        ...area,
        id: 'fill',
        method: AssetDevelopCleanupMethod.Remove,
        enabled: true,
        blockSize: 0.02,
        strokes: dto.strokes && normalizeStrokes(dto.strokes, false),
      },
      original,
    );
    if (!(original.width > 0 && original.height > 0) || box.right <= box.left || box.bottom <= box.top) {
      throw new BadRequestException('The area to remove is empty');
    }
    const fill = developFillWindow(box, original);
    const { window } = fill;
    const image = await sharp(input, { failOn: 'error', limitInputPixels: 200_000_000 })
      .rotate()
      .extract({
        left: window.left,
        top: window.top,
        width: window.right - window.left,
        height: window.bottom - window.top,
      })
      .resize(fill.width, fill.height, { fit: 'fill' })
      .toColourspace('srgb')
      .removeAlpha()
      .png()
      .toBuffer();
    const mask = await sharp(Buffer.from(developFillMask(area, original, fill)), {
      raw: { width: fill.width, height: fill.height, channels: 1 },
    })
      .toColourspace('b-w')
      .png()
      .toBuffer();
    signal?.throwIfAborted();
    let filled: Buffer;
    try {
      filled = await this.machineLearningRepository.inpaintLocal(image, mask, signal);
    } catch (error) {
      if (error instanceof InpaintUnavailableError) {
        throw new ServiceUnavailableException({
          message: 'No inpainting model is available on this server; Remove needs a fill made on the device',
          code: 'develop_inpaint_unavailable',
        });
      }
      throw error;
    }
    const result = await sharp(filled, { failOn: 'warning', limitInputPixels: 4096 * 4096 }).metadata();
    if (result.format !== 'png' || result.width !== fill.width || result.height !== fill.height)
      throw new BadRequestException('Local worker returned an invalid fill');
    const png = await sharp(filled).extract(fill.area).removeAlpha().ensureAlpha(1).png().toBuffer();
    return this.admitGeneratedArtifact(auth, assetId, AssetDevelopArtifactKind.Fill, png, signal);
  }

  /** The original to compute on: the file itself, or a RAW developed by LibRaw (orientation applied). */
  private async orientedOriginal(source: DevelopSource, signal?: AbortSignal): Promise<string | Buffer> {
    const isRaw = mimeTypes.isRaw(source.originalFileName) && !source.originalFileName.toLowerCase().endsWith('.psd');
    return isRaw ? renderRawWithLibRaw(source.originalPath, signal) : source.originalPath;
  }

  /** A bitmap the server generated goes through the same admission as an uploaded one. */
  private async admitGeneratedArtifact(
    auth: AuthDto,
    assetId: string,
    kind: AssetDevelopArtifactKind,
    png: Buffer,
    signal?: AbortSignal,
  ) {
    const directory = await mkdtemp(path.join(tmpdir(), 'frameleaf-develop-artifact-'));
    const file = path.join(directory, 'artifact.png');
    try {
      await writeFile(file, png, { flag: 'wx' });
      signal?.throwIfAborted();
      return await this.uploadArtifact(auth, assetId, { kind }, { path: file, size: png.length });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /** FL-233: write an artifact's file; the same bitmap written at the same time keeps the first. */
  private async writeArtifactFile(target: string, data: Buffer) {
    try {
      await this.storageRepository.createFile(target, data);
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  /**
   * FL-233: record a stored artifact (or restart its grace period). A deletion queued by an earlier
   * release may have run between finding the file and recording it; the recorded row now protects
   * the path, so the file is written again if it went.
   */
  private async recordArtifact(
    asset: { id: string; ownerId: string },
    id: string,
    kind: AssetDevelopArtifactKind,
    target: string,
    normalized: { data: Buffer; width: number; height: number },
  ) {
    await this.assetDevelopRepository.addArtifact({
      assetId: asset.id,
      id,
      ownerId: asset.ownerId,
      kind,
      path: target,
      bytes: normalized.data.length,
      width: normalized.width,
      height: normalized.height,
    });
    if (!(await this.storageRepository.checkFileExists(target))) {
      this.storageRepository.mkdirSync(path.dirname(target));
      await this.writeArtifactFile(target, normalized.data);
    }
  }

  /** FL-233: a mask no larger than the original (either way round), a fill within the fill bounds. */
  private artifactSizeAllowed(
    asset: { exifInfo?: { exifImageWidth?: number | null; exifImageHeight?: number | null } | null },
    kind: AssetDevelopArtifactKind,
    size: { width: number; height: number },
  ) {
    const long = Math.max(size.width, size.height);
    const short = Math.min(size.width, size.height);
    if (kind === AssetDevelopArtifactKind.Fill) {
      return long <= DEVELOP_ARTIFACT_FILL_MAX_SIDE && size.width * size.height <= DEVELOP_ARTIFACT_FILL_MAX_PIXELS;
    }
    const width = asset.exifInfo?.exifImageWidth ?? 0;
    const height = asset.exifInfo?.exifImageHeight ?? 0;
    if (width > 0 && height > 0) {
      return long <= Math.max(width, height) && short <= Math.min(width, height);
    }
    return long <= DEVELOP_ARTIFACT_MASK_MAX_SIDE;
  }

  /**
   * FL-233: refuse a recipe whose active masks or enabled Clean Up need an artifact this photo does
   * not have (or has as the other kind). Both recipe versions reference owner-bound artifacts. Call after `assertRenderableDevelopRecipe`.
   */
  private async requireArtifacts(asset: { id: string; ownerId: string }, recipe: unknown, auth?: AuthDto) {
    const parsed = assertRenderableDevelopRecipe(recipe);
    // Preserve discriminated-union narrowing for the HDR renderer.
    // eslint-disable-next-line unicorn/prefer-includes-over-repeated-comparisons
    if (parsed.version === 3 || parsed.version === 4 || parsed.version === 5 || parsed.version === 6)
      await this.requireHdrRenderer(parsed);
    const needed =
      parsed.version === 2
        ? {
            mask: (parsed.masks ?? []).filter((mask) => mask.enabled && mask.artifact).map((mask) => mask.artifact!),
            fill: [] as string[],
          }
        : developRenderArtifacts(parsed);
    if (parsed.version === 1 && parsed.keyFrame) {
      await this.requireMotionClip(asset, parsed.keyFrame.timeMs, auth);
    }
    const wanted = [...new Set([...needed.mask, ...needed.fill])];
    const stored = await this.assetDevelopRepository.getArtifacts(asset.id, wanted);
    const kinds = new Map(stored.map((artifact) => [artifact.id, artifact.kind]));
    if (
      needed.mask.some((id) => kinds.get(id) !== AssetDevelopArtifactKind.Mask) ||
      needed.fill.some((id) => kinds.get(id) !== AssetDevelopArtifactKind.Fill)
    ) {
      throw missingArtifact();
    }
  }

  /** FL-233: decode the artifacts a render needs; a missing one refuses the render. */
  private async loadArtifacts(
    asset: { id: string; ownerId: string },
    ids: string[],
    kind: AssetDevelopArtifactKind,
    verify = false,
  ): Promise<Map<string, DevelopBitmap>> {
    const bitmaps = new Map<string, DevelopBitmap>();
    const wanted = [...new Set(ids)];
    const stored = await this.assetDevelopRepository.getArtifacts(asset.id, wanted);
    if (stored.length !== wanted.length || stored.some((artifact) => artifact.kind !== kind)) {
      throw missingArtifact();
    }
    for (const artifact of stored) {
      if (
        verify &&
        (artifact.ownerId !== asset.ownerId ||
          (await this.cryptoRepository.hashFile(artifact.path, 'sha256')).toString('hex') !== artifact.id)
      ) {
        throw new BadRequestException({
          message: 'The develop artifact changed or is not owned by this photo',
          code: 'develop_artifact_changed',
        });
      }
      bitmaps.set(artifact.id, await this.mediaRepository.decodeDevelopArtifact(artifact.path, kind));
    }
    return bitmaps;
  }

  /** FL-179: revisions of removed assets that were left while fork writes were refused. */
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    try {
      await this.assetDevelopRepository.releaseRemovedAssetRevisions((files) => this.queueFileDelete(files));
    } catch (error: any) {
      this.logger.warn(`Develop revision cleanup deferred: ${error}`);
    }
    // FL-233: artifacts of removed photos, and those no saved version used for a week
    try {
      await this.assetDevelopRepository.releaseArtifacts((files) => this.queueFileDelete(files), {
        unreferencedBefore: new Date(Date.now() - DEVELOP_ARTIFACT_UNREFERENCED_GRACE_MS),
      });
    } catch (error: any) {
      this.logger.warn(`Develop artifact cleanup deferred: ${error}`);
    }
  }

  private async queueFileDelete(files: string[]) {
    await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
  }

  private async queueRender(revision: AssetDevelopRevision, label: string): Promise<AssetDevelopRevisionResponseDto> {
    if (revision.kind === AssetDevelopRevisionKind.Recipe) {
      assertRenderableDevelopRecipe(revision.recipe);
      await this.requireArtifacts({ id: revision.assetId, ownerId: revision.ownerId }, revision.recipe);
    }
    // A person asking for a render starts afresh: it gets its own automatic retry.
    const queued = await this.assetDevelopRepository.update(revision.id, {
      status: AssetDevelopRevisionStatus.Queued,
      progress: 0,
      error: null,
      cancelRequested: false,
      attempts: 0,
    });
    // FL-43: the render is a job in Activity, named by the photo, pointing at this version.
    await this.editOperations.queue({
      ownerId: revision.ownerId,
      edit: EditOperationEdit.PhotoVersion,
      assetId: revision.assetId,
      label,
      revisionId: revision.id,
      job: { name: JobName.AssetDevelopRender, data: { id: revision.id } },
    });
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
    if (asset.deletedAt) {
      throw new BadRequestException('Restore the photo from the trash before editing it');
    }
    if (asset.visibility === AssetVisibility.Hidden) {
      // The still half of a pair or another item the library keeps out of view: it is edited
      // through the item people see, never on its own.
      throw new BadRequestException('This item is not shown in the library and cannot be edited on its own');
    }
    if (asset.isOffline) {
      throw new BadRequestException('The original file is offline and cannot be rendered');
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
    revision: Pick<AssetDevelopRevision, 'id' | 'recipeVersion'>,
    image: SystemConfig['image'],
  ) {
    const base = StorageCore.getNestedFolder(StorageFolder.Thumbnails, source.ownerId, source.id);
    const hdr = [3, 4, 5, 6].includes(revision.recipeVersion);
    const renditionId = `${revision.id}_${randomUUID()}`;
    return {
      hdrMaster: attemptOutputPath(path.join(base, `${source.id}_develop_${renditionId}_master_hdr.jpg`)),
      hdrPreview: attemptOutputPath(path.join(base, `${source.id}_develop_${renditionId}_preview_hdr.jpg`)),
      master: attemptOutputPath(
        path.join(base, `${source.id}_develop_${renditionId}_master.${hdr ? 'jpeg' : image.fullsize.format}`),
      ),
      preview: attemptOutputPath(
        path.join(base, `${source.id}_develop_${renditionId}_preview.${hdr ? 'jpeg' : image.preview.format}`),
      ),
    };
  }

  private async decodeSource(
    source: DevelopSource,
    image: SystemConfig['image'],
    size?: number,
    keyframe?: { timeMs: number },
  ) {
    if (keyframe) {
      return this.decodeKeyframe(source, keyframe.timeMs, size);
    }
    const isRaw = mimeTypes.isRaw(source.originalFileName) && !source.originalFileName.toLowerCase().endsWith('.psd');
    if (!isRaw) {
      const encoding = await this.mediaRepository.inspectImageEncoding(source.originalPath);
      if (encoding.dynamicRange === 'hdr') {
        // The historical SDR renderer must never be reused for a new HDR-preserving result.
        throw new BadRequestException({
          code: 'develop_hdr_render_unavailable',
          message:
            'This source contains HDR. HDR-preserving Develop rendering is not available yet; the previous version and original remain unchanged.',
        });
      }
    }
    const colorspace = this.isSRGB(source.exifInfo) ? Colorspace.Srgb : image.colorspace;
    // Camera JPEGs are preview evidence, never develop source. LibRaw applies orientation once.
    const input = isRaw ? await renderRawWithLibRaw(source.originalPath, jobSignal()) : source.originalPath;
    const { data, info } = await this.mediaRepository.decodeImage(input, {
      colorspace,
      processInvalidImages: false,
      size,
    });
    return { data, info: info as RawImageInfo, colorspace };
  }

  /**
   * Live and Motion Photos: the motion clip a key frame is taken from. The clip must be this photo's own
   * (same owner) and the time inside it; anything else refuses the recipe before a render is queued.
   */
  private async requireMotionClip(
    asset: { id: string; ownerId: string },
    timeMs: number,
    auth?: AuthDto,
    permission = Permission.AssetEditCreate,
  ) {
    const still = await this.assetRepository.getById(asset.id);
    const clip = still?.livePhotoVideoId ? await this.assetRepository.getById(still.livePhotoVideoId) : undefined;
    if (auth && clip) await requireAccess(this.accessRepository, { auth, permission, ids: [clip.id] });
    const motion = still?.livePhotoVideoId
      ? await this.assetJobRepository.getForVideoConversion(still.livePhotoVideoId)
      : undefined;
    if (
      !clip ||
      clip.deletedAt ||
      clip.isOffline ||
      (!auth && clip.isLocked) ||
      !motion ||
      motion.id !== still?.livePhotoVideoId ||
      clip.id !== motion.id ||
      motion.ownerId !== asset.ownerId ||
      clip.ownerId !== asset.ownerId
    ) {
      throw new BadRequestException({
        message: 'Only a Live or Motion Photo has a motion clip to take a key frame from',
        code: 'develop_key_frame_unavailable',
      });
    }
    const duration = motion.format.duration;
    if (Number.isFinite(duration) && duration > 0 && timeMs >= duration * 1000) {
      throw new BadRequestException({
        message: 'The key frame is past the end of the motion clip',
        code: 'develop_key_frame_out_of_range',
      });
    }
    return motion;
  }

  /** The key frame as the develop source: one PNG frame of the motion clip, decoded like a still (sRGB). */
  private async decodeKeyframe(
    source: DevelopSource,
    timeMs: number,
    size?: number,
    clip?: NonNullable<Awaited<ReturnType<AssetJobRepository['getForVideoConversion']>>>,
  ) {
    const motion = clip ?? (await this.requireMotionClip(source, timeMs));
    const { ffmpeg } = await this.getConfig();
    const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-key-frame-'));
    try {
      const output = path.join(folder, 'frame.png');
      await this.mediaRepository.transcode(
        motion.originalPath,
        output,
        getKeyframeCommand(ffmpeg, motion.videoStream, timeMs),
      );
      const { data, info } = await this.mediaRepository.decodeImage(output, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size,
      });
      return { data, info: info as RawImageInfo, colorspace: Colorspace.Srgb };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async renderRecipe(
    decoded: { data: Buffer; info: RawImageInfo },
    recipe: ReturnType<typeof renderDevelopProjection>,
    seed: number,
    asset: { id: string; ownerId: string },
  ) {
    // FL-233: Clean Up works on the original, before every other step
    const cleanup = (recipe.cleanup ?? []).filter((op) => op.enabled);
    if (cleanup.length > 0) {
      const fills = await this.loadArtifacts(asset, developCleanupArtifacts(cleanup), AssetDevelopArtifactKind.Fill);
      applyDevelopCleanup(decoded.data, decoded.info as never, cleanup, fills);
    }
    const geometry = planDevelopGeometry(recipe, decoded.info.width, decoded.info.height);
    const shaped = await this.mediaRepository.renderDevelopGeometry(decoded.data, decoded.info, geometry);
    const { params, look } = effectiveDevelop(recipe);
    applyDevelopTone(shaped.data, shaped.info, params, look, seed + 1);
    const bitmaps = await this.loadArtifacts(asset, developMaskArtifacts(recipe.masks), AssetDevelopArtifactKind.Mask);
    applyDevelopMasks(shaped.data, shaped.info, recipe.masks, maskMappingFor(geometry), bitmaps);
    const detail = planDevelopDetail(params, { width: shaped.info.width, height: shaped.info.height });
    return { data: shaped.data, info: shaped.info, detail };
  }

  private async renderNativeRecipe(
    source: DevelopSource,
    recipe: DarktableDevelopRecipe,
    revisionId?: string,
    signal?: AbortSignal,
  ) {
    if (!mimeTypes.isRaw(source.originalFileName)) {
      throw new BadRequestException('Native develop recipes require a RAW original');
    }
    if (revisionId) {
      await this.progress(revisionId, 10);
    }
    return this.withRenderCancellation(revisionId, signal, async (abort) => {
      const artifacts = (recipe.masks ?? [])
        .filter((mask) => mask.enabled && mask.artifact)
        .map((mask) => mask.artifact!);
      const bitmaps = await this.loadArtifacts(source, artifacts, AssetDevelopArtifactKind.Mask);
      const buffer = await renderDarktable(source.originalPath, recipe, abort, bitmaps);
      const { width, height } = await this.mediaRepository.getImageMetadata(buffer);
      abort.throwIfAborted();
      return {
        data: buffer,
        nativeBuffer: buffer,
        info: { width, height, channels: 3 } as RawImageInfo,
        colorspace: Colorspace.Srgb,
        detail: { median: 0 as const },
      };
    });
  }

  private async withRenderCancellation<T>(
    revisionId: string | undefined,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController();
    const abort = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      ...(jobSignal() ? [jobSignal()!] : []),
    ]);
    const watching = (async () => {
      if (!revisionId) return;
      try {
        for await (const _ of setInterval(1000, undefined, { signal: controller.signal }))
          await this.progress(revisionId, 10);
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
      }
    })();
    try {
      abort.throwIfAborted();
      return await operation(abort);
    } catch (error) {
      if (abort.aborted) throw abort.reason;
      throw error;
    } finally {
      controller.abort();
      await watching;
    }
  }

  private async requireHdrRenderer(recipe: HdrAssetDevelopRecipe) {
    if (process.env.FRAMELEAF_HDR_IMAGES !== 'experimental')
      throw new BadRequestException({
        message: 'HDR-preserving editing is not enabled on this server',
        code: 'develop_hdr_render_unavailable',
      });
    const codec = await this.mediaRepository.getHdrCodecCapabilities();
    if (!codec || (codec.renderer ?? 'frameleaf-develop-hdr/1') !== recipe.renderer)
      throw new BadRequestException({
        message: 'This revision requires its original HDR renderer; create a new version to use the installed renderer',
        code: 'develop_renderer_unsupported',
      });
  }

  private async hdrRender(
    source: DevelopSource,
    recipe: HdrAssetDevelopRecipe,
    outputs: Parameters<MediaRepository['generateHdrRenditions']>[1],
    revisionId?: string,
    seed = 1,
    signal?: AbortSignal,
    checksum?: Buffer,
  ) {
    await this.requireHdrRenderer(recipe);
    if (mimeTypes.isRaw(source.originalFileName))
      throw new BadRequestException('HDR quick edits require a reconstructed still; RAW uses native development');
    const needed = developRenderArtifacts(recipe);
    const masks = await this.loadArtifacts(source, needed.mask, AssetDevelopArtifactKind.Mask, true);
    const fills = await this.loadArtifacts(source, needed.fill, AssetDevelopArtifactKind.Fill, true);
    const contentChecksum = checksum ?? (await this.currentSourceChecksum(source.id));
    const { version: _version, renderer: _renderer, hdr: _hdr, ...fields } = recipe;
    return this.withRenderCancellation(revisionId, signal, (abort) =>
      this.mediaRepository.generateHdrRenditions(
        source.originalPath,
        outputs,
        { recipe: { ...fields, version: 1 }, seed, masks: Object.fromEntries(masks), fills: Object.fromEntries(fills) },
        abort,
        contentChecksum,
      ),
    );
  }

  private async renderHdrPreview(
    source: DevelopSource,
    recipe: HdrAssetDevelopRecipe,
    dto: AssetDevelopPreviewDto,
    signal?: AbortSignal,
  ) {
    await this.requireHdrRenderer(recipe);
    const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-hdr-preview-'));
    const output = path.join(folder, 'preview.jpg');
    try {
      const result = await this.hdrRender(
        source,
        recipe,
        [
          {
            path: output,
            size: dto.size,
            histogram: true,
            dynamicRange: dto.dynamicRange === 'sdr' || !dto.dynamicRange ? 'sdr' : 'hdr',
          },
        ],
        undefined,
        1,
        signal,
      );
      signal?.throwIfAborted();
      return {
        buffer: await this.storageRepository.readFile(output),
        contentType: 'image/jpeg',
        histogram: result[0]?.histogram,
      };
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  private async renderHdrRecipeRevision(
    revision: AssetDevelopRevision,
    source: DevelopSource,
    sourceChecksum: Buffer,
    outputs: { master: string; preview: string; hdrMaster: string; hdrPreview: string },
    tmp: { master: string; preview: string; hdrMaster: string; hdrPreview: string },
    image: SystemConfig['image'],
  ) {
    const recipe = assertRenderableDevelopRecipe(revision.recipe);
    if (recipe.version !== 3 && recipe.version !== 4 && recipe.version !== 5 && recipe.version !== 6)
      throw new BadRequestException('HDR revisions require recipe version 3, 4, 5 or 6');
    this.storageRepository.mkdirSync(path.dirname(outputs.master));
    const result = await this.hdrRender(
      source,
      recipe,
      [
        { path: tmp.hdrMaster },
        { path: tmp.hdrPreview, size: image.preview.size },
        { path: tmp.master, dynamicRange: 'sdr' },
        { path: tmp.preview, size: image.preview.size, dynamicRange: 'sdr' },
      ],
      revision.id,
      revision.revision + 1,
      undefined,
      sourceChecksum,
    );
    await this.progress(revision.id, 95);
    const renditionChecksum = await this.cryptoRepository.hashFile(tmp.master, 'sha256');
    const hdrRenditionChecksum = await this.cryptoRepository.hashFile(tmp.hdrMaster, 'sha256');
    for (const key of ['master', 'preview', 'hdrMaster', 'hdrPreview'] as const)
      await this.storageRepository.rename(tmp[key], outputs[key]);
    return {
      status: AssetDevelopRevisionStatus.Rendered,
      progress: 100,
      error: null,
      masterPath: outputs.master,
      previewPath: outputs.preview,
      hdrMasterPath: outputs.hdrMaster,
      hdrPreviewPath: outputs.hdrPreview,
      hdrRenditionChecksum,
      width: result[0].width,
      height: result[0].height,
      renderedAt: new Date(),
      sourceChecksum,
      renditionChecksum,
    };
  }

  /** Queued, or rendering under a lease that has lapsed. */
  private isClaimable(revision: Pick<AssetDevelopRevision, 'status' | 'updatedAt'>) {
    if (revision.status === AssetDevelopRevisionStatus.Queued) {
      return true;
    }
    return (
      revision.status === AssetDevelopRevisionStatus.Rendering &&
      Date.now() - new Date(revision.updatedAt).getTime() > DEVELOP_RENDER_LEASE_MS
    );
  }

  /**
   * SHA-256 of the asset's original bytes now. New uploads already store it; older rows (SHA-1,
   * or the path-based checksum of external libraries) are hashed from the file.
   */
  private async currentSourceChecksum(assetId: string): Promise<Buffer> {
    const asset = await this.assetRepository.getById(assetId);
    if (!asset) {
      throw new NotFoundException('Asset not found');
    }
    if (asset.checksumAlgorithm === ChecksumAlgorithm.sha256File) {
      return asset.checksum;
    }
    return this.cryptoRepository.hashFile(asset.originalPath, 'sha256');
  }

  private async renderRecipeRevision(
    revision: AssetDevelopRevision,
    source: DevelopSource,
    sourceChecksum: Buffer,
    outputs: { master: string; preview: string; hdrMaster: string; hdrPreview: string },
    tmp: { master: string; preview: string; hdrMaster: string; hdrPreview: string },
    image: SystemConfig['image'],
    motion?: NonNullable<Awaited<ReturnType<AssetJobRepository['getForVideoConversion']>>>,
  ) {
    const recipe = assertRenderableDevelopRecipe(revision.recipe);
    // Preserve discriminated-union narrowing for the HDR renderer.
    // eslint-disable-next-line unicorn/prefer-includes-over-repeated-comparisons
    if (recipe.version === 3 || recipe.version === 4 || recipe.version === 5 || recipe.version === 6)
      return this.renderHdrRecipeRevision(revision, source, sourceChecksum, outputs, tmp, image);
    const native = recipe.version === 2 ? await this.renderNativeRecipe(source, recipe, revision.id) : undefined;
    const keyframe = recipe.version === 1 ? recipe.keyFrame : undefined;
    const decoded =
      native ??
      (keyframe
        ? await this.decodeKeyframe(source, keyframe.timeMs, undefined, motion)
        : await this.decodeSource(source, image));
    await this.progress(revision.id, 25);

    const rendered =
      native ?? (await this.renderRecipe(decoded, renderDevelopProjection(revision.recipe), revision.revision, source));
    await this.progress(revision.id, 60);

    this.storageRepository.mkdirSync(path.dirname(outputs.master));
    await this.encodeRecipeOutput(
      rendered,
      {
        detail: rendered.detail,
        colorspace: decoded.colorspace,
        format: image.fullsize.format,
        quality: Math.max(image.fullsize.quality, MASTER_MIN_QUALITY),
        progressive: image.fullsize.progressive,
      },
      tmp.master,
    );
    await this.progress(revision.id, 85);

    await this.encodeRecipeOutput(
      rendered,
      {
        detail: rendered.detail,
        colorspace: decoded.colorspace,
        format: image.preview.format,
        quality: image.preview.quality,
        size: image.preview.size,
      },
      tmp.preview,
    );
    await this.progress(revision.id, 95);
    const renditionChecksum = await this.cryptoRepository.hashFile(tmp.master, 'sha256');

    // Both outputs stay attempt-private until the accepted claim adopts their references.
    await this.storageRepository.rename(tmp.master, outputs.master);
    await this.storageRepository.rename(tmp.preview, outputs.preview);
    return {
      status: AssetDevelopRevisionStatus.Rendered,
      progress: 100,
      error: null,
      masterPath: outputs.master,
      previewPath: outputs.preview,
      width: rendered.info.width,
      height: rendered.info.height,
      renderedAt: new Date(),
      sourceChecksum,
      renditionChecksum,
    };
  }

  private async encodeRecipeOutput(
    rendered: { data: Buffer; info: RawImageInfo; detail: ReturnType<typeof planDevelopDetail>; nativeBuffer?: Buffer },
    options: Parameters<MediaRepository['encodeDevelopOutput']>[2],
    output: string,
  ) {
    if (rendered.nativeBuffer) return encodeNativeDevelopOutput(rendered.nativeBuffer, options, output);
    return this.mediaRepository.encodeDevelopOutput(rendered.data, rendered.info, options, output);
  }

  /**
   * A developed file brought back is already the master: check it is still the file and the
   * original it was accepted against, then make its preview.
   */
  private async renderExternal(
    revision: AssetDevelopRevision,
    sourceChecksum: Buffer,
    previewPath: string,
    tmpPreview: string,
    image: SystemConfig['image'],
  ) {
    if (!revision.masterPath || !revision.renditionChecksum) {
      throw new DevelopSourceChanged('The developed file of this version is missing');
    }
    if (revision.sourceChecksum && !revision.sourceChecksum.equals(sourceChecksum)) {
      throw new DevelopSourceChanged('The original changed after this file was brought back');
    }
    const onDisk = await this.cryptoRepository.hashFile(revision.masterPath, 'sha256').catch(() => null);
    if (!onDisk?.equals(revision.renditionChecksum)) {
      throw new DevelopSourceChanged('The developed file is missing or no longer matches what was brought back');
    }
    await this.progress(revision.id, 25);

    const { data, info } = await this.mediaRepository.decodeImage(revision.masterPath, {
      colorspace: image.colorspace,
      processInvalidImages: false,
      size: image.preview.size * 2,
    });
    await this.progress(revision.id, 60);
    const full = await this.mediaRepository.getOrientedSize(revision.masterPath);

    this.storageRepository.mkdirSync(path.dirname(previewPath));
    await this.mediaRepository.encodeDevelopOutput(
      data,
      info as RawImageInfo,
      {
        detail: { median: 0 },
        colorspace: image.colorspace,
        format: image.preview.format,
        quality: image.preview.quality,
        size: image.preview.size,
      },
      tmpPreview,
    );
    await this.progress(revision.id, 95);
    await this.storageRepository.rename(tmpPreview, previewPath);
    return {
      status: AssetDevelopRevisionStatus.Rendered,
      progress: 100,
      error: null,
      previewPath,
      width: full.width,
      height: full.height,
      renderedAt: new Date(),
    };
  }

  private toExportDto(item: DevelopExport, current: Buffer): DevelopExportResponseDto {
    return {
      id: item.id,
      assetId: item.assetId,
      fileName: item.fileName,
      sourceChecksum: item.sourceChecksum.toString('hex'),
      isCurrentOriginal: item.sourceChecksum.equals(current),
      createdAt: asDateTimeString(item.createdAt),
    };
  }

  private async progress(id: string, progress: number) {
    jobSignal()?.throwIfAborted();
    // FL-43: the stage reaches the version's Activity job too, and a cancel asked for there stops
    // the render at this stage exactly as one asked for from the editor does.
    const run = this.runs.get(id);
    if (run && !(await run.progress(progress))) {
      if (await run.cancelRequested()) throw new DevelopRenderCancelled();
      throw new Error('Develop render lost its operation claim');
    }
    if (await this.assetDevelopRepository.isCancelRequested(id)) {
      throw new DevelopRenderCancelled();
    }
    await this.assetDevelopRepository.update(id, { progress });
  }

  private async discard(paths: string[]) {
    for (const file of paths) {
      await this.storageRepository.unlink(file).catch(() => {});
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
      recipe: developEnvelope(revision.recipe),
      kind: revision.kind ?? AssetDevelopRevisionKind.Recipe,
      sourceAssetId: revision.sourceAssetId ?? null,
      sourceChecksum: revision.sourceChecksum ? revision.sourceChecksum.toString('hex') : null,
      renditionChecksum: revision.renditionChecksum ? revision.renditionChecksum.toString('hex') : null,
      exportId: revision.exportId ?? null,
      fileName: revision.fileName ?? null,
      software: revision.software ?? null,
      attempts: revision.attempts ?? 0,
      rendererVersion: revision.rendererVersion,
      width: revision.width,
      height: revision.height,
      isCurrent: revision.isCurrent,
      outputDynamicRange:
        hasPublishedDevelopRendition(revision) && revision.hdrMasterPath
          ? 'hdr'
          : revision.kind !== AssetDevelopRevisionKind.External &&
              revision.status === AssetDevelopRevisionStatus.Rendered
            ? 'sdr'
            : 'unknown',
      hdrRenderStatus: [3, 4, 5, 6].includes(revision.recipeVersion)
        ? hasPublishedDevelopRendition(revision) && revision.hdrMasterPath
          ? 'rendered'
          : process.env.FRAMELEAF_HDR_IMAGES === 'experimental'
            ? revision.status === AssetDevelopRevisionStatus.Failed
              ? 'failed'
              : 'pending'
            : 'disabled'
        : 'not-requested',
      hasHdrMaster:
        process.env.FRAMELEAF_HDR_IMAGES === 'experimental' &&
        hasPublishedDevelopRendition(revision) &&
        !!revision.hdrMasterPath,
      hasHdrPreview:
        process.env.FRAMELEAF_HDR_IMAGES === 'experimental' &&
        hasPublishedDevelopRendition(revision) &&
        !!revision.hdrPreviewPath,
      hasMaster: hasPublishedDevelopRendition(revision) && !!revision.masterPath,
      hasPreview: hasPublishedDevelopRendition(revision) && !!revision.previewPath,
      createdAt: asDateTimeString(revision.createdAt),
      updatedAt: asDateTimeString(revision.updatedAt),
      renderedAt: revision.renderedAt ? asDateTimeString(revision.renderedAt) : null,
    };
  }
}
