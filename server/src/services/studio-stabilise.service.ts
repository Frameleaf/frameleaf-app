import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioStabiliseCreateDto,
  StudioStabiliseDto,
  StudioStabiliseMotionSchema,
  StudioStabiliseQueuedDto,
} from 'src/dtos/studio-stabilise.dto.js';
import { FrameleafWorker, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioStabiliseRepository } from 'src/repositories/studio-stabilise.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination, isStudioUuid } from 'src/utils/studio-resources.js';
import {
  MotionEstimator,
  StabiliseClip,
  stabiliseClipOf,
  stabiliseFrameSize,
  stabiliseMotionOf,
  stabiliseRate,
  stabiliseWindow,
} from 'src/utils/studio-stabilise.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
/** The snapshot kind that tells this job apart from the other Studio clip jobs of its kind. */
export const STABILISE_SNAPSHOT_KIND = 'studio-stabilise';

type StabiliseSnapshot = {
  kind: typeof STABILISE_SNAPSHOT_KIND;
  projectId: string;
  revision: number;
  digest: string;
  clipId: string;
  sourceKey: string;
};
type Job = { operation: MediaOperation; claimToken: string };

/**
 * Stabilise (FL-638): the camera movement of one Studio clip, analysed once as a job Activity follows.
 *
 * Submit checks the owner and the clip on the head revision, and queues the job. A worker on this
 * server claims it, decodes the clip's source window with ffmpeg into small grey pictures it never
 * stores, measures how the picture moved from frame to frame on the CPU and records the camera path as
 * the job's result. Nothing leaves this server, and it never runs on Frameleaf Cloud. The graph is not
 * edited: the editor writes the path into the clip, and the engine smooths it for the chosen level in
 * preview and export.
 *
 * The job uses the `studio_transcription` kind (one Studio job on one clip), told apart by its
 * snapshot kind, because a new kind would change a response enum the native apps decode strictly.
 */
@Injectable()
export class StudioStabiliseService {
  private readonly workerId = `studio-stabilise-${randomUUID()}`;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectRepository,
    private studio: StudioProjectService,
    private resources: StudioResourceService,
    private users: UserRepository,
    private media: MediaRepository,
    private frames: StudioStabiliseRepository,
  ) {
    this.logger.setContext(StudioStabiliseService.name);
  }

  async create(auth: AuthDto, projectId: string, dto: StudioStabiliseCreateDto): Promise<StudioStabiliseQueuedDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    const resolved = await this.source(auth, { projectId, clipId: dto.clipId });
    const window = stabiliseWindow(resolved.clip);
    const snapshot: StabiliseSnapshot = {
      kind: STABILISE_SNAPSHOT_KIND,
      projectId,
      revision: resolved.revision,
      digest: resolved.digest,
      clipId: dto.clipId,
      sourceKey: resolved.clip.sourceKey,
    };
    const operation = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioTranscription,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Stabilise',
      assetId: resolved.assetId,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: resolved.revisionId,
      snapshot,
      settings: { task: 'stabilise' },
      estimate: null,
      totalUnits: Math.ceil(window.durationSeconds * 1000),
      maxAttempts: 2,
    });
    return { id: operation.id, status: operation.status };
  }

  /** The job and, once it completed, the camera path. Owner only; anyone else is told it does not exist. */
  async get(auth: AuthDto, projectId: string, id: string): Promise<StudioStabiliseDto> {
    const operation = auth.sharedLink ? undefined : await this.operations.getForOwner(id, auth.user.id);
    if (!operation || !isStabiliseJob(operation) || operation.projectId !== projectId) {
      throw new NotFoundException('Stabilise job not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can read its stabilise jobs');
    const snapshot = this.snapshot(operation);
    const parsed =
      operation.status === MediaOperationStatus.Completed
        ? StudioStabiliseMotionSchema.safeParse(operation.result)
        : undefined;
    return {
      id: operation.id,
      projectId,
      clipId: snapshot.clipId,
      revision: snapshot.revision,
      status: operation.status,
      progress: operation.progress,
      error: operation.error ?? null,
      result: parsed?.success ? parsed.data : null,
    };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort(new Error('Worker stopping'));
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Studio stabilise worker failed: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioTranscription],
        snapshotKinds: [STABILISE_SNAPSHOT_KIND],
        workerId: this.workerId,
        leaseMs: LEASE_MS,
      });
      if (!job) {
        return;
      }
      await this.run(job);
    }
  }

  async run({ operation, claimToken }: Job): Promise<void> {
    if (!isStudioUuid(operation.id) || !isStudioUuid(operation.ownerId) || !isStudioUuid(claimToken)) {
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    if (this.stopping) {
      controller.abort(new Error('Worker stopping'));
    }
    let stage = MediaOperationStatus.Preparing;
    let processed = 0;
    let total = operation.totalUnits === null ? 0 : Number(operation.totalUnits);
    let writing: Promise<void> | undefined;
    const monitor = async () => {
      const held = await this.operations.getForWorker(operation.id);
      if (
        !held ||
        held.claimToken !== claimToken ||
        !held.claimExpiresAt ||
        new Date(held.claimExpiresAt).getTime() <= Date.now() ||
        held.status === MediaOperationStatus.Cancelling
      ) {
        controller.abort(new Error('Claim lost or cancelled'));
        return;
      }
      if (
        !(await this.operations.heartbeat(operation.id, claimToken, LEASE_MS)) ||
        !(await this.operations.reportProgress(operation.id, claimToken, {
          status: stage,
          processedUnits: processed,
          totalUnits: total || null,
          progress: total ? Math.min(99, (processed / total) * 100) : 0,
        }))
      ) {
        controller.abort(new Error('Claim lost or cancelled'));
      }
    };
    const heartbeat = setInterval(() => {
      writing ??= monitor()
        .catch(() => controller.abort(new Error('Claim heartbeat failed')))
        .finally(() => {
          writing = undefined;
        });
    }, TICK_MS);
    try {
      await monitor();
      controller.signal.throwIfAborted();
      const snapshot = this.snapshot(operation);
      const auth = await this.owner(operation.ownerId);
      const resolved = await this.source(auth, {
        projectId: snapshot.projectId,
        clipId: snapshot.clipId,
        revision: snapshot.revision,
        backgroundRunner: true,
      });
      if (resolved.digest !== snapshot.digest || resolved.clip.sourceKey !== snapshot.sourceKey) {
        throw new BadRequestException('The project revision or its clip changed');
      }
      const info = await this.media.probe(resolved.path, { countFrames: false, signal: controller.signal });
      const video = info.videoStreams[0];
      if (!video || !(video.width > 0) || !(video.height > 0)) {
        throw new BadRequestException('The clip has no picture to stabilise');
      }
      const window = stabiliseWindow(resolved.clip);
      const rate = stabiliseRate(video.frameRate ?? undefined);
      // A turned phone video is stored sideways; analyse it the way it plays.
      const sideways = Math.abs(video.rotation ?? 0) % 180 === 90;
      const size = stabiliseFrameSize(sideways ? video.height : video.width, sideways ? video.width : video.height);
      total = Math.ceil(window.durationSeconds * 1000);

      stage = MediaOperationStatus.Rendering;
      const estimator = new MotionEstimator(size.width, size.height);
      await this.frames.readGreyFrames(resolved.path, { ...window, rate, ...size }, controller.signal, (frame) => {
        estimator.push(frame);
        processed = Math.min(total, Math.round(((estimator.moves.length + 1) / rate) * 1000));
      });
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();
      if (estimator.moves.length === 0) {
        throw new BadRequestException('The clip is too short to stabilise');
      }

      const result = StudioStabiliseMotionSchema.parse(
        stabiliseMotionOf(estimator.moves, { rate, start: window.startSeconds, ...size }),
      );
      if (!(await this.operations.beginValidation(operation.id, claimToken))) {
        throw new Error('Claim lost');
      }
      const outcome = await this.operations.publishValidated(operation.id, claimToken, async (tx) => {
        await tx
          .updateTable('media_operation')
          .set({ result, processedUnits: total })
          .where('id', '=', operation.id)
          .execute();
        return true;
      });
      if (outcome !== 'completed') {
        throw new Error('Claim lost before the camera movement was recorded');
      }
    } catch (error) {
      const held = await this.operations.getForWorker(operation.id);
      if (held?.claimToken === claimToken && held.status === MediaOperationStatus.Cancelling) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      } else {
        const refused = error instanceof BadRequestException;
        await this.operations.fail(
          operation.id,
          claimToken,
          {
            errorCode: 'studio_stabilise_failed',
            error: refused ? (error as Error).message : 'The camera movement could not be analysed',
          },
          // A refusal (clip, source) fails the same way again.
          { retry: !refused },
        );
        if (!refused) {
          this.logger.warn(`Studio stabilise ${operation.id} failed: ${error}`);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await writing;
      if (this.abort === controller) {
        this.abort = undefined;
      }
    }
  }

  /** The clip on a stored revision (the head when none is named) and the file its source is read from. */
  private async source(
    auth: AuthDto,
    input: { projectId: string; clipId: string; revision?: number; backgroundRunner?: boolean },
  ): Promise<{
    clip: StabiliseClip;
    path: string;
    assetId: string | null;
    revision: number;
    revisionId: string;
    digest: string;
  }> {
    await this.studio.requireOwnedProject(auth, input.projectId, 'Only the project owner can stabilise its clips');
    const authorized = await this.studio.authorizeRevision(auth, {
      projectId: input.projectId,
      revision: input.revision,
      destination: StudioDestination.Local,
    });
    if (authorized.project.archivedAt) {
      throw new BadRequestException('Bring the project back from the archive first');
    }
    const clip = stabiliseClipOf(authorized.envelope.graph, input.clipId);
    // Fresh access to the clip's source on this server; a manifest cached at submit is not reused.
    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId: input.projectId,
      ownerId: auth.user.id,
      revision: authorized.revision.revision,
      graph: authorized.envelope.graph,
      imports: await this.projects.listImportDeclarations(input.projectId),
      generated: await this.projects.listGeneratedResources(input.projectId),
      destination: StudioDestination.Local,
      backgroundRunner: input.backgroundRunner ?? false,
    });
    const entry = resolution.manifest.entries.find((item) => item.key === clip.sourceKey);
    if (!entry?.path || entry.grant !== 'render') {
      throw new BadRequestException("The clip's source is not available to stabilise");
    }
    return {
      clip,
      path: entry.path,
      assetId: entry.assetId ?? (clip.sourceKey.startsWith('library-asset:') ? entry.id : null),
      revision: authorized.revision.revision,
      revisionId: authorized.revision.id,
      digest: authorized.revision.digest,
    };
  }

  private snapshot(operation: MediaOperation): StabiliseSnapshot {
    const snapshot = operation.snapshot as Partial<StabiliseSnapshot> | null;
    if (
      !isStabiliseJob(operation) ||
      snapshot?.projectId !== operation.projectId ||
      !isStudioUuid(snapshot.projectId) ||
      !Number.isSafeInteger(snapshot.revision) ||
      typeof snapshot.digest !== 'string' ||
      typeof snapshot.clipId !== 'string' ||
      typeof snapshot.sourceKey !== 'string'
    ) {
      throw new BadRequestException('Invalid stabilise snapshot');
    }
    return snapshot as StabiliseSnapshot;
  }

  private async owner(ownerId: string): Promise<AuthDto> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      throw new BadRequestException('The project owner is unavailable');
    }
    // The owner's submitted background job, like an export (FL-195), not a viewer grant.
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.workerId, hasElevatedPermission: true },
    };
  }
}

const isStabiliseJob = (operation: MediaOperation) =>
  operation.kind === MediaOperationKind.StudioTranscription &&
  (operation.snapshot as { kind?: unknown } | null)?.kind === STABILISE_SNAPSHOT_KIND;
