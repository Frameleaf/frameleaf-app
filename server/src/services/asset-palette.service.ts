import { Injectable, NotFoundException } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetPaletteDto } from 'src/dtos/asset-palette.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetEditsCreateDto } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetType,
  Colorspace,
  FrameleafWorker,
  JobName,
  JobStatus,
  Permission,
  QueueName,
} from 'src/enum.js';
import { deferJobAdoption, deferJobFailure } from 'src/queue/context.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetPaletteRepository } from 'src/repositories/asset-palette.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { isLockedKeyUnavailable, withPlainCopy } from 'src/utils/locked-read.js';
import { mimeTypes } from 'src/utils/mime-types.js';

type Source = NonNullable<Awaited<ReturnType<AssetPaletteRepository['source']>>>;
const representative = (source: Source) =>
  source.type === AssetType.Video || source.originalFileName.toLowerCase().endsWith('.gif')
    ? ('frame' as const)
    : ('image' as const);

@Injectable()
export class AssetPaletteService {
  constructor(
    private palettes: AssetPaletteRepository,
    private media: MediaRepository,
    private jobs: JobRepository,
    private access: AccessRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap() {
    await this.jobs.queue({ name: JobName.AssetPaletteQueueAll, data: {} });
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup', workers: [FrameleafWorker.Microservices] })
  async onNightlyCleanup() {
    await this.onBootstrap();
  }

  @OnEvent({ name: 'JobSuccess', workers: [FrameleafWorker.Microservices] })
  async onJobSuccess({ job, response }: ArgOf<'JobSuccess'>) {
    if (response !== JobStatus.Success) return;
    switch (job.name) {
      case JobName.AssetGenerateThumbnails:
      case JobName.AssetEditThumbnailGeneration:
      case JobName.AssetVideoEditGeneration: {
        await this.enqueue(job.data.id);
        break;
      }
      case JobName.AssetDevelopRender: {
        const assetId = await this.palettes.currentDevelopAssetId(job.data.id);
        if (assetId) await this.enqueue(assetId);
        break;
      }
      default: {
        return;
      }
    }
  }

  @OnEvent({ name: 'AssetDevelopCurrentChanged', workers: [FrameleafWorker.Microservices] })
  async onDevelopCurrentChanged({ assetId }: ArgOf<'AssetDevelopCurrentChanged'>) {
    await this.enqueue(assetId);
  }

  @OnEvent({ name: 'AssetMetadataExtracted', workers: [FrameleafWorker.Microservices] })
  async onMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    const source = await this.palettes.source(assetId);
    if (source?.files.some((file) => file.type === AssetFileType.Preview)) await this.enqueue(assetId);
  }

  @OnEvent({ name: 'AssetRestoreAll', workers: [FrameleafWorker.Microservices] })
  async onRestore({ assetIds }: ArgOf<'AssetRestoreAll'>) {
    for (const id of assetIds) await this.enqueue(id);
  }

  async get(auth: AuthDto, id: string): Promise<AssetPaletteDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [id] });
    const state = await this.palettes.get(id, auth.sharedLink ? null : auth.user.id);
    if (!state) throw new NotFoundException('Palette unavailable');
    if (state.status === 'pending') await this.enqueue(id);
    return state;
  }

  async retry(auth: AuthDto, id: string): Promise<void> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [id] });
    await this.enqueue(id, true);
  }

  private async enqueue(id: string, force = false) {
    const source = await this.palettes.source(id);
    if (!source) return;
    const previous = await this.palettes.get(id);
    if (!force && previous?.status === 'ready' && previous.sourceRevision === source.sourceRevision) return;
    await this.palettes.publish(id, source.sourceRevision, this.state(source, 'pending'));
    await this.jobs.queue({ name: JobName.AssetPaletteExtract, data: { id, sourceRevision: source.sourceRevision } });
  }

  @OnJob({ name: JobName.AssetPaletteQueueAll, queue: QueueName.ThumbnailGeneration })
  async handleBackfill({ afterId, force }: JobOf<JobName.AssetPaletteQueueAll>): Promise<JobStatus> {
    const page = await this.palettes.page(afterId);
    for (const { id } of page) await this.enqueue(id, force);
    if (page.length === 100)
      await this.jobs.queue({ name: JobName.AssetPaletteQueueAll, data: { afterId: page.at(-1)!.id, force } });
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetPaletteExtract, queue: QueueName.ThumbnailGeneration })
  async handleExtract({ id, sourceRevision }: JobOf<JobName.AssetPaletteExtract>): Promise<JobStatus> {
    await this.jobs.guardAssetSource(id, { derivatives: true });
    const source = await this.palettes.source(id);
    if (!source || source.sourceRevision !== sourceRevision) return JobStatus.Skipped;
    const state = this.state(source, 'unavailable');
    const input = this.input(source);
    try {
      if (input) {
        // FL-721: an encrypted Locked file is read through a plain copy; without the key the job waits
        const palette = await withPlainCopy(input.path, (path) => this.media.extractAssetPalette(path, input.options));
        Object.assign(state, palette, { status: 'ready' });
      }
      if (
        deferJobAdoption(async (tx) => {
          if (!(await this.palettes.publish(id, sourceRevision, state, tx)))
            throw new Error('Palette source changed before publication');
        })
      )
        return JobStatus.Success;
      return (await this.palettes.publish(id, sourceRevision, state)) ? JobStatus.Success : JobStatus.Skipped;
    } catch (error) {
      executionSignal()?.throwIfAborted();
      if (isLockedKeyUnavailable(error)) {
        // waiting for the owner's key is not a failure: the job is deferred and runs again
        throw error;
      }
      const failed = this.state(source, 'failed');
      if (
        !deferJobFailure(async (tx) => {
          await this.palettes.publish(id, sourceRevision, failed, tx);
        })
      ) {
        await this.palettes.publish(id, sourceRevision, failed);
      }
      throw error;
    }
  }

  private state(source: Source, status: AssetPaletteDto['status']): AssetPaletteDto {
    return {
      version: 1,
      sourceRevision: source.sourceRevision,
      status,
      swatches: [],
      hasTransparency: false,
      representative: representative(source),
    };
  }

  private input(source: Source) {
    const options = { colorspace: Colorspace.Srgb, processInvalidImages: false };
    if (source.develop)
      return source.develop.status === AssetDevelopRevisionStatus.Rendered && source.develop.masterPath
        ? { path: source.develop.masterPath, options }
        : undefined;
    const video = source.type === AssetType.Video;
    const hdr = source.exif?.imageEncoding?.dynamicRange === 'hdr';
    const raw = mimeTypes.isRaw(source.originalFileName) && !source.originalFileName.toLowerCase().endsWith('.psd');
    const complexEdits = source.edits.some(({ action }) => !['crop', 'rotate', 'mirror'].includes(action));
    if (video || hdr || raw || complexEdits) {
      const file = source.files.find(
        (file) => file.type === AssetFileType.Preview && file.isEdited === source.isEdited,
      );
      return file ? { path: file.path, options } : undefined;
    }
    return {
      path: source.originalPath,
      options: {
        ...options,
        edits: source.edits.length > 0 ? AssetEditsCreateDto.schema.parse({ edits: source.edits }).edits : [],
        orientation: source.exif?.orientation ? Number(source.exif.orientation) : undefined,
      },
    };
  }
}
