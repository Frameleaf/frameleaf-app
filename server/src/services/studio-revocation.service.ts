import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { MediaOperationKind } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';

/** The Studio jobs a source leaving the library stops. */
const SOURCE_BOUND_KINDS = [MediaOperationKind.StudioExport, MediaOperationKind.StudioPreview] as const;

/**
 * Resource revocation for Studio (FL-90, `STU-203`): "revocation stops streams and jobs and
 * invalidates preview and cache entries".
 *
 * Every grant is already re-verified against live access on each read (`verifyReadGrant`), so a
 * revoked source is never *delivered*. This service makes the stop immediate instead of lazy:
 *
 * - **A source is trashed or deleted.** Every project whose current revision names it has its
 *   cached resolutions dropped, its live preview frames evicted with their files, and its
 *   unfinished exports and previews cancelled, for every account.
 * - **A source is moved into the Locked space.** Interactive reads refuse Locked media, so live
 *   previews stop and resolutions are dropped. Exports keep running: a background renderer reads
 *   the Locked sources a job its owner submitted names (owner decision, September 22, 2026).
 * - **A member leaves, or is taken out of, a shared space.** That member's previews and jobs on
 *   the space's projects stop; the owner's and other members' work is untouched.
 *
 * Project sharing never grants original access, so nothing here re-grants anything.
 */
@Injectable()
export class StudioRevocationService {
  constructor(
    private logger: LoggingRepository,
    private projectRepository: StudioProjectRepository,
    private projects: StudioProjectService,
    private previews: StudioPreviewService,
    private operations: MediaOperationRepository,
  ) {
    this.logger.setContext(StudioRevocationService.name);
  }

  @OnEvent({ name: 'AssetTrash' })
  async onAssetTrash({ assetId }: ArgOf<'AssetTrash'>): Promise<void> {
    await this.sourcesRemoved([assetId]);
  }

  @OnEvent({ name: 'AssetTrashAll' })
  async onAssetTrashAll({ assetIds }: ArgOf<'AssetTrashAll'>): Promise<void> {
    await this.sourcesRemoved(assetIds);
  }

  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId }: ArgOf<'AssetDelete'>): Promise<void> {
    await this.sourcesRemoved([assetId]);
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  async onAssetDeleteAll({ assetIds }: ArgOf<'AssetDeleteAll'>): Promise<void> {
    await this.sourcesRemoved(assetIds);
  }

  @OnEvent({ name: 'AssetLocked' })
  async onAssetLocked({ assetIds }: ArgOf<'AssetLocked'>): Promise<void> {
    const projectIds = await this.projectRepository.getIdsReferencingAssets(assetIds);
    if (projectIds.length === 0) {
      return;
    }
    this.projects.forgetResolutions(projectIds);
    const frames = await this.previews.revokeForProjects(projectIds);
    this.logger.log(`Locked sources stopped ${frames} preview frame(s) in ${projectIds.length} Studio project(s)`);
  }

  @OnEvent({ name: 'AlbumUserRemove' })
  async onAlbumUserRemove({ albumId, userId }: ArgOf<'AlbumUserRemove'>): Promise<void> {
    // Owner decision (FL-146, 2026-09-25): the departing member's own projects are kept, as their
    // private projects. Space sharing ends, so every other member's frames and resolutions go.
    const detached = await this.projectRepository.detachOwnerFromSpace(albumId, userId);
    if (detached.length > 0) {
      this.projects.forgetResolutions(detached);
      const frames = await this.previews.revokeForProjects(detached);
      this.logger.log(
        `A member left space ${albumId}: kept ${detached.length} of their Studio project(s) as private; stopped ${frames} shared preview frame(s)`,
      );
    }

    const projectIds = await this.projectRepository.getIdsInSpace(albumId);
    if (projectIds.length === 0) {
      return;
    }
    this.projects.forgetResolutions(projectIds);
    const frames = await this.previews.revokeForProjects(projectIds, userId);
    const jobs = await this.cancelJobs(projectIds, userId);
    if (frames > 0 || jobs > 0) {
      this.logger.log(`A member left space ${albumId}: stopped ${frames} preview frame(s) and ${jobs} Studio job(s)`);
    }
  }

  private async sourcesRemoved(assetIds: readonly string[]): Promise<void> {
    const projectIds = await this.projectRepository.getIdsReferencingAssets(assetIds);
    if (projectIds.length === 0) {
      return;
    }
    this.projects.forgetResolutions(projectIds);
    const frames = await this.previews.revokeForProjects(projectIds);
    const jobs = await this.cancelJobs(projectIds);
    this.logger.log(
      `Removed sources stopped ${frames} preview frame(s) and ${jobs} Studio job(s) in ${projectIds.length} project(s)`,
    );
  }

  /** Cancel unfinished exports and previews; a claimed one waits for its worker to acknowledge. */
  private async cancelJobs(projectIds: readonly string[], ownerId?: string): Promise<number> {
    const unfinished = await this.operations.listUnfinishedForProjects(projectIds, SOURCE_BOUND_KINDS, ownerId);
    let cancelled = 0;
    for (const operation of unfinished) {
      try {
        if (await this.operations.requestCancel(operation.id, operation.ownerId)) {
          cancelled++;
        }
      } catch (error) {
        // The grant check on the worker's next read still stops it; recovery settles the row.
        this.logger.warn(`Could not cancel Studio job ${operation.id}: ${error}`);
      }
    }
    return cancelled;
  }
}
