import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { MemoryExport } from 'src/database.js';
import { MemoryHighlightOptionsDto, MemoryHighlightSettings, mapMemoryHighlight } from 'src/dtos/memory.dto.js';
import {
  MediaOperationDestination,
  MemoryExportFormat,
  MemoryExportStatus,
  MemoryHighlightAudio,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { type ImmichReadStream, StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioExportRepository, StudioExportVersion } from 'src/repositories/studio-export.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import {
  MEMORY_HIGHLIGHT_DEFAULT_LENGTH,
  MemoryHighlightAsset,
  buildMemoryHighlightGraph,
} from 'src/utils/memory-highlight.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';
import { STUDIO_ENGINE, STUDIO_ENVELOPE_SCHEMA_VERSION } from 'src/utils/studio-project.js';

/** The Studio export settings a highlight renders with: the prototype ExportDialog's defaults. */
const HIGHLIGHT_FORMAT = 'mp4-hevc-main10';
const HIGHLIGHT_COLOR = 'preserve';

const ACTIVE = new Set<string>([MemoryExportStatus.Pending, MemoryExportStatus.Running, MemoryExportStatus.Cancelling]);

type HighlightMemory = { id: string; title: string; assets: readonly MemoryHighlightAsset[] };

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A highlight video rendered directly from a memory (FL-194, `REC-105`).
 *
 * There is no renderer here. A highlight is a `highlight` run of the memory's private export
 * (FL-62) whose work is an ordinary Studio export of a Studio project made for it: the memory's
 * items, in the memory's order, cut to the chosen length (`buildMemoryHighlightGraph`). The export
 * goes through FL-90's resolver, FL-42's admission, the qualified render workers with their
 * durable, checkpointed jobs (FL-95, FL-104) and FL-106's publication, exactly as an export from
 * Studio does. The run row mirrors the export version's state for the memory UI.
 *
 * Private by construction:
 *
 * - nothing is created, contacted or rendered until the owner asks, and it renders at home only;
 * - the result is kept with its project, out of the library, until the owner saves it there;
 * - deleting the memory (by the owner or the 30-day cleanup of unsaved memories) deletes the
 *   project, which cancels a render in flight and removes the result's file; a copy the owner
 *   saved to their library is theirs and stays.
 */
@Injectable()
export class MemoryHighlightService {
  constructor(
    private logger: LoggingRepository,
    private memoryRepository: MemoryRepository,
    private studioProjects: StudioProjectService,
    private studioExports: StudioExportService,
    private projectRepository: StudioProjectRepository,
    private exportRepository: StudioExportRepository,
    private operations: MediaOperationRepository,
    private assetRepository: AssetRepository,
    private accessRepository: AccessRepository,
    private storageRepository: StorageRepository,
  ) {
    this.logger.setContext(MemoryHighlightService.name);
  }

  /**
   * Start a highlight render. The run row comes first so a project it creates can always be found
   * and removed again; any refusal on the way (no qualified worker for this resolution, a source
   * this session may not render) removes both and reaches the owner with the export's own reason.
   */
  async create(auth: AuthDto, memory: HighlightMemory, options: MemoryHighlightOptionsDto = {}): Promise<MemoryExport> {
    const settings: MemoryHighlightSettings = {
      lengthSeconds: options.lengthSeconds ?? MEMORY_HIGHLIGHT_DEFAULT_LENGTH,
      resolution: options.resolution ?? '2160p',
      audio: options.audio ?? MemoryHighlightAudio.Original,
      destination: options.destination ?? MediaOperationDestination.Local,
      progress: 0,
      savedAssetId: null,
    };
    const graph = buildMemoryHighlightGraph({
      title: memory.title,
      assets: memory.assets,
      lengthSeconds: settings.lengthSeconds,
      resolution: settings.resolution,
      audio: settings.audio,
    });

    const run = (await this.memoryRepository.createExport({
      ownerId: auth.user.id,
      memoryId: memory.id,
      format: MemoryExportFormat.Highlight,
      status: MemoryExportStatus.Pending,
      title: memory.title,
      assetIds: memory.assets.map(({ id }) => id),
      assetCount: memory.assets.length,
      settings,
    })) as MemoryExport;

    let projectId: string | undefined;
    try {
      const key = `memory-highlight:${run.id}`;
      const project = await this.studioProjects.create(auth, {
        name: memory.title,
        clientId: key,
        requestKey: key,
        envelope: {
          schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
          engine: STUDIO_ENGINE,
          engineRevision: STUDIO_ENGINE_REVISION,
          graph,
        },
      });
      projectId = project.id;
      await this.memoryRepository.updateExport(run.id, { studioProjectId: project.id });
      // Off the Studio shelf: it belongs to the memory, and archiving also drops the editor lease.
      await this.studioProjects.update(auth, project.id, { archived: true });

      const { version } = await this.studioExports.create(
        auth,
        project.id,
        {
          destination: settings.destination,
          format: HIGHLIGHT_FORMAT,
          color: HIGHLIGHT_COLOR,
          resolution: settings.resolution,
          requestKey: key,
        },
        { retainInProject: true },
      );

      const started = await this.memoryRepository.updateExport(run.id, {
        status: MemoryExportStatus.Running,
        startedAt: new Date(),
        studioExportVersionId: version.id,
      });
      this.logger.log(`Memory highlight ${run.id} rendering as Studio export ${version.id}`);
      return (started ?? run) as MemoryExport;
    } catch (error) {
      if (projectId) {
        await this.deleteProject(projectId);
      }
      await this.memoryRepository.deleteExport(run.id, auth.user.id);
      throw error;
    }
  }

  /**
   * The run as its render stands now. Pending work follows its export version: progress from the
   * render job, `ready` once published, `failed` or `cancelled` as the version ended. A run that
   * ended without a result lets its project go, which removes whatever the render left.
   */
  async refresh(run: MemoryExport): Promise<MemoryExport> {
    if (run.format !== MemoryExportFormat.Highlight || !ACTIVE.has(run.status)) {
      return run;
    }

    const settings = mapMemoryHighlight(run.settings);
    const version = run.studioExportVersionId
      ? await this.exportRepository.getById(run.studioExportVersionId)
      : undefined;

    if (!version) {
      // Still being set up by `create`, or its version is gone with its project.
      if (run.status === MemoryExportStatus.Pending && !run.studioProjectId) {
        return run;
      }
      return this.finish(run, MemoryExportStatus.Failed, 'The render of this highlight is gone');
    }

    switch (version.state) {
      case StudioExportVersionState.Rendering:
      case StudioExportVersionState.Staged: {
        const operation = version.renderOperationId
          ? await this.operations.getForOwner(version.renderOperationId, run.ownerId)
          : undefined;
        const progress =
          version.state === StudioExportVersionState.Staged ? 99 : Math.min(99, Math.round(operation?.progress ?? 0));
        const status = run.cancelRequestedAt ? MemoryExportStatus.Cancelling : MemoryExportStatus.Running;
        if (status === run.status && progress === settings.progress) {
          return run;
        }
        return this.update(run, { status, settings: { ...settings, progress } });
      }
      case StudioExportVersionState.Published: {
        return this.update(run, {
          status: MemoryExportStatus.Ready,
          path: version.outputPath,
          sizeInBytes: version.outputSizeInBytes === null ? null : Number(version.outputSizeInBytes),
          finishedAt: new Date(),
          error: null,
          settings: {
            ...settings,
            progress: 100,
            savedAssetId: version.scope === StudioExportScope.Library ? version.resultAssetId : null,
          },
        });
      }
      case StudioExportVersionState.Cancelled: {
        return this.finish(
          run,
          MemoryExportStatus.Cancelled,
          run.cancelRequestedAt ? null : (version.error ?? 'The render was cancelled'),
        );
      }
      default: {
        return this.finish(run, MemoryExportStatus.Failed, version.error ?? 'The render failed');
      }
    }
  }

  /** Stop a render. A finished run answers with its final state. */
  async cancel(auth: AuthDto, run: MemoryExport): Promise<MemoryExport> {
    if (!ACTIVE.has(run.status)) {
      return run;
    }
    const requested = (await this.memoryRepository.requestExportCancel(run.id, auth.user.id)) ?? run;
    const version = run.studioExportVersionId
      ? await this.exportRepository.getById(run.studioExportVersionId)
      : undefined;
    if (version) {
      await this.studioExports.cancelVersion(version, 'cancelled', 'Cancelled by the owner');
    }
    return this.refresh({
      ...(requested as MemoryExport),
      cancelRequestedAt: requested.cancelRequestedAt ?? new Date(),
    });
  }

  /** Delete a run: its render stops, and its project and the private result go with it. */
  async remove(auth: AuthDto, run: MemoryExport): Promise<void> {
    await this.release(run);
    await this.memoryRepository.deleteExport(run.id, auth.user.id);
  }

  /** The result, as a download, re-checked like any Studio export result. */
  async download(auth: AuthDto, run: MemoryExport): Promise<ImmichReadStream> {
    const version = await this.requireResult(auth, run);
    let path: string;
    let contentType = version.outputContentType ?? 'video/mp4';
    if (version.scope === StudioExportScope.Library) {
      // Saved to the library: the asset is served while it is the owner's and not in the trash.
      const assetId = version.resultAssetId;
      const allowed = assetId
        ? await this.accessRepository.asset.checkOwnerAccess(auth.user.id, new Set([assetId]), !!getLockedOwnerId(auth))
        : new Set<string>();
      const [asset] = assetId && allowed.has(assetId) ? await this.assetRepository.getByIds([assetId]) : [];
      if (!asset || asset.deletedAt) {
        throw new NotFoundException('Highlight not found');
      }
      path = asset.originalPath;
    } else {
      const file = await this.studioExports.download(auth, version.id);
      path = file.path;
      contentType = file.contentType;
    }

    const stream = await this.storageRepository.createReadStream(path, contentType);
    const extension = contentType === 'video/webm' ? 'webm' : contentType === 'video/quicktime' ? 'mov' : 'mp4';
    return {
      ...stream,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(run.title || 'highlight')}.${extension}`,
    };
  }

  /** Save the result to the owner's library, on their request only. */
  async saveToLibrary(auth: AuthDto, run: MemoryExport): Promise<MemoryExport> {
    const version = await this.requireResult(auth, run);
    const saved = await this.studioExports.saveToLibrary(auth, version.id);
    const settings = mapMemoryHighlight(run.settings);
    return this.update(run, { settings: { ...settings, savedAssetId: saved.resultAssetId } });
  }

  /** Before a memory is deleted: every highlight of it stops and its project and result go. */
  async removeForMemory(ownerId: string, memoryId: string): Promise<void> {
    const runs = await this.memoryRepository.searchExports(ownerId, { memoryId });
    for (const run of runs) {
      if (run.format === MemoryExportFormat.Highlight) {
        await this.release(run as MemoryExport);
      }
    }
  }

  /**
   * Before the 30-day cleanup deletes unsaved memories, which takes their runs by cascade: their
   * highlight projects are deleted first, or they would outlive the memory.
   */
  async removeForExpiredMemories(): Promise<void> {
    for (const run of await this.memoryRepository.getHighlightsOfExpiredMemories()) {
      await this.release(run as MemoryExport);
    }
  }

  private async requireResult(auth: AuthDto, run: MemoryExport): Promise<StudioExportVersion> {
    const current = await this.refresh(run);
    const version = current.studioExportVersionId
      ? await this.exportRepository.getForOwner(current.studioExportVersionId, auth.user.id)
      : undefined;
    if (current.status !== MemoryExportStatus.Ready || version?.state !== StudioExportVersionState.Published) {
      throw new BadRequestException('Highlight is not ready');
    }
    return version;
  }

  /** Stop the render, delete the project and remove a result that was not saved to the library. */
  private async release(run: Pick<MemoryExport, 'studioProjectId' | 'studioExportVersionId'>) {
    const version = run.studioExportVersionId
      ? await this.exportRepository.getById(run.studioExportVersionId)
      : undefined;
    if (version) {
      await this.studioExports.cancelVersion(version, 'project-unavailable', 'The memory was deleted');
      if (version.scope === StudioExportScope.Project && version.outputPath && !version.outputRemovedAt) {
        // Studio's retention sweep records it as removed once the project is gone.
        await this.storageRepository.unlink(version.outputPath).catch(() => {});
      }
    }
    if (run.studioProjectId) {
      await this.deleteProject(run.studioProjectId);
    }
  }

  private async deleteProject(projectId: string) {
    try {
      this.studioProjects.forgetResolutions([projectId]);
      await this.projectRepository.delete(projectId);
    } catch (error) {
      this.logger.warn(`Unable to delete the highlight project ${projectId}: ${errorMessage(error)}`);
    }
  }

  private async finish(run: MemoryExport, status: MemoryExportStatus, error: string | null) {
    const finished = await this.update(run, { status, error, finishedAt: new Date() });
    if (run.studioProjectId) {
      await this.deleteProject(run.studioProjectId);
    }
    return finished;
  }

  private async update(run: MemoryExport, patch: Partial<MemoryExport>): Promise<MemoryExport> {
    const updated = await this.memoryRepository.updateExport(run.id, patch as never);
    return (updated ?? { ...run, ...patch }) as MemoryExport;
  }
}
