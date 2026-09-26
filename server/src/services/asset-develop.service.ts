import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf, RawImageInfo } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import {
  ASSET_DEVELOP_RECIPE_VERSION,
  AssetDevelopFileKind,
  AssetDevelopPreviewDto,
  type AssetDevelopRecipe,
  AssetDevelopResponseDto,
  AssetDevelopRevertDto,
  AssetDevelopRevisionKind,
  AssetDevelopRevisionResponseDto,
  AssetDevelopRevisionStatus,
  AssetDevelopSaveDto,
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
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository, type AssetDevelopRevision } from 'src/repositories/asset-develop.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { type DevelopExport, PhotoToolsRepository } from 'src/repositories/photo-tools.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  DEVELOP_RENDERER_VERSION,
  applyDevelopMasks,
  applyDevelopTone,
  defaultDevelopRecipe,
  effectiveDevelop,
  maskMappingFor,
  normalizeDevelopRecipe,
  planDevelopDetail,
  planDevelopGeometry,
} from 'src/utils/develop-recipe.js';
import { EditOperationRun, EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit } from 'src/utils/edit-operation.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { MEDIA_OPERATION_AUTO_RETRIES, MEDIA_OPERATION_AUTO_RETRY_DELAY_MS } from 'src/utils/media-operation.js';
import { mimeTypes } from 'src/utils/mime-types.js';

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
      return this.queueRender(revision, asset.originalFileName);
    }
    return this.toRevisionDto(revision);
  }

  async render(auth: AuthDto, assetId: string, revisionId: string): Promise<AssetDevelopRevisionResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetEditCreate, ids: [assetId] });
    const asset = await this.requireEditableStill(assetId);
    const revision = await this.requireRevision(assetId, revisionId);
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
      DEVELOP_RENDERER_VERSION,
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
    const tmp = { master: `${outputs.master}.tmp`, preview: `${outputs.preview}.tmp` };
    try {
      const sourceChecksum = await this.currentSourceChecksum(revision.assetId);
      if (external) {
        await this.renderExternal(revision, sourceChecksum, outputs.preview, tmp.preview, image);
      } else {
        await this.renderRecipeRevision(revision, source, sourceChecksum, outputs, tmp, image);
      }
      // FL-43: the version becomes the working one only under its job's claim. A run that lost its
      // claim, or was cancelled at the last moment, leaves the previous working version current.
      if (run && !(await run.validate())) {
        return JobStatus.Skipped;
      }
      // Rendering a version makes it the working version; Revert walks back through history.
      await this.assetDevelopRepository.setCurrent(revision.assetId, id);
      return JobStatus.Success;
    } catch (error) {
      await this.discard(external ? [tmp.preview] : [tmp.master, tmp.preview]);
      if (error instanceof DevelopRenderCancelled) {
        await this.assetDevelopRepository.update(id, { status: AssetDevelopRevisionStatus.Cancelled, progress: 0 });
        await run?.cancelled();
        return JobStatus.Skipped;
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      const permanent = error instanceof DevelopSourceChanged;
      if (run) {
        return this.failTracked(run, revision, message, permanent);
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
  ): Promise<JobStatus> {
    const id = revision.id;
    const outcome = await run.fail(message, permanent ? 'source_changed' : 'edit_render_failed', {
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
    const lost = claimable.filter(({ id }) => !tracked.has(id));
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
    await this.queueFileDelete(await this.assetDevelopRepository.releaseRemovedAssetRevisions(assetId));
  }

  /** FL-179: revisions of removed assets that were left while fork writes were refused. */
  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup() {
    try {
      await this.queueFileDelete(await this.assetDevelopRepository.releaseRemovedAssetRevisions());
    } catch (error: any) {
      this.logger.warn(`Develop revision cleanup deferred: ${error}`);
    }
  }

  private async queueFileDelete(files: string[]) {
    if (files.length > 0) {
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files } });
    }
  }

  private async queueRender(revision: AssetDevelopRevision, label: string): Promise<AssetDevelopRevisionResponseDto> {
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
    applyDevelopMasks(shaped.data, shaped.info, recipe.masks, maskMappingFor(geometry));
    const detail = planDevelopDetail(params, { width: shaped.info.width, height: shaped.info.height });
    return { data: shaped.data, info: shaped.info, detail };
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
    outputs: { master: string; preview: string },
    tmp: { master: string; preview: string },
    image: SystemConfig['image'],
  ) {
    const recipe = normalizeDevelopRecipe(revision.recipe);
    const decoded = await this.decodeSource(source, image);
    await this.progress(revision.id, 25);

    const rendered = await this.renderRecipe(decoded, recipe, revision.revision);
    await this.progress(revision.id, 60);

    this.storageRepository.mkdirSync(path.dirname(outputs.master));
    await this.mediaRepository.encodeDevelopOutput(
      rendered.data,
      rendered.info,
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
    await this.progress(revision.id, 95);
    const renditionChecksum = await this.cryptoRepository.hashFile(tmp.master, 'sha256');

    // Atomic publish: both files exist before either path is recorded.
    await this.storageRepository.rename(tmp.master, outputs.master);
    await this.storageRepository.rename(tmp.preview, outputs.preview);
    await this.assetDevelopRepository.update(revision.id, {
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
    });
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
    await this.assetDevelopRepository.update(revision.id, {
      status: AssetDevelopRevisionStatus.Rendered,
      progress: 100,
      error: null,
      previewPath,
      width: full.width,
      height: full.height,
      renderedAt: new Date(),
    });
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
    // FL-43: the stage reaches the version's Activity job too, and a cancel asked for there stops
    // the render at this stage exactly as one asked for from the editor does.
    const run = this.runs.get(id);
    if (run && !(await run.progress(progress)) && (await run.cancelRequested())) {
      throw new DevelopRenderCancelled();
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
      recipe: normalizeDevelopRecipe(revision.recipe),
      kind: revision.kind ?? AssetDevelopRevisionKind.Recipe,
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
      hasMaster: revision.status === AssetDevelopRevisionStatus.Rendered && !!revision.masterPath,
      hasPreview: revision.status === AssetDevelopRevisionStatus.Rendered && !!revision.previewPath,
      createdAt: asDateTimeString(revision.createdAt),
      updatedAt: asDateTimeString(revision.updatedAt),
      renderedAt: revision.renderedAt ? asDateTimeString(revision.renderedAt) : null,
    };
  }
}
