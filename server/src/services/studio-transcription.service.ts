import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioTranscriptionCreateDto,
  StudioTranscriptionDto,
  StudioTranscriptionQueuedDto,
  StudioTranscriptionResultSchema,
} from 'src/dtos/studio-transcription.dto.js';
import {
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
  StorageFolder,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  TranscriptionUnavailableError,
} from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioTranscriptionRepository } from 'src/repositories/studio-transcription.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { toApproximateNumber } from 'src/utils/rational-time.js';
import { StudioDestination, isStudioUuid } from 'src/utils/studio-resources.js';
import {
  TranscriptionClip,
  mapTranscript,
  transcriptionClipOf,
  transcriptionWindow,
  whisperLanguageOf,
} from 'src/utils/studio-transcription.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
/** Extraction is quick next to Whisper; it gets the first few percent of the bar. */
const EXTRACTED_PROGRESS = 5;

type TranscriptionSnapshot = {
  kind: 'studio-transcription';
  projectId: string;
  revision: number;
  digest: string;
  clipId: string;
  sourceKey: string;
  /** As asked: `auto` or a BCP 47 tag. */
  language: string;
  /** As Whisper names it; null detects. */
  whisperLanguage: string | null;
  destinationId: string;
};
type Job = { operation: MediaOperation; claimToken: string };

/**
 * Studio captions (protocol section 15.1, owner decision 2026-10-09): Whisper speech to text for one
 * clip, run as a durable job that Activity follows.
 *
 * Submit checks the owner, the clip on the head revision, the language and the named ML destination,
 * and queues the job. A worker on this server claims it, reads the clip's source window from the
 * original with ffmpeg into a private WAV, sends that only to the named destination, maps the worker's
 * segments and words onto the sequence and records them as the job's result. The WAV is deleted once
 * the job settles. The graph is never edited: the client applies the cues with `captions.set`.
 */
@Injectable()
export class StudioTranscriptionService {
  private readonly workerId = `studio-transcription-${randomUUID()}`;
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
    private storage: StorageRepository,
    private audio: StudioTranscriptionRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
  ) {
    this.logger.setContext(StudioTranscriptionService.name);
  }

  async create(
    auth: AuthDto,
    projectId: string,
    dto: StudioTranscriptionCreateDto,
  ): Promise<StudioTranscriptionQueuedDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    const whisperLanguage = whisperLanguageOf(dto.language);
    const selection = await this.admit(dto.destinationId, null);
    const resolved = await this.source(auth, { projectId, clipId: dto.clipId, destination: selection.kind });
    const window = transcriptionWindow(resolved.clip);
    const snapshot: TranscriptionSnapshot = {
      kind: 'studio-transcription',
      projectId,
      revision: resolved.revision,
      digest: resolved.digest,
      clipId: dto.clipId,
      sourceKey: resolved.clip.sourceKey,
      language: dto.language,
      whisperLanguage,
      destinationId: selection.destinationId,
    };
    const operation = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioTranscription,
      destination:
        selection.kind === MlDestinationKind.Lan ? MediaOperationDestination.Lan : MediaOperationDestination.Local,
      destinationDetail: selection.destinationId,
      label: 'Captions',
      assetId: resolved.assetId,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: resolved.revisionId,
      snapshot,
      settings: { language: dto.language },
      estimate: null,
      totalUnits: Math.ceil(toApproximateNumber(window.duration) * 1000),
      maxAttempts: 2,
    });
    return { id: operation.id, status: operation.status };
  }

  /** The job and, once it completed, its cues. Owner only; anyone else is told it does not exist. */
  async get(auth: AuthDto, projectId: string, id: string): Promise<StudioTranscriptionDto> {
    const operation = auth.sharedLink ? undefined : await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.kind !== MediaOperationKind.StudioTranscription || operation.projectId !== projectId) {
      throw new NotFoundException('Transcription not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can read its transcriptions');
    const snapshot = this.snapshot(operation);
    const parsed =
      operation.status === MediaOperationStatus.Completed
        ? StudioTranscriptionResultSchema.safeParse(operation.result)
        : undefined;
    return {
      id: operation.id,
      projectId,
      clipId: snapshot.clipId,
      revision: snapshot.revision,
      language: snapshot.language,
      destinationId: snapshot.destinationId,
      status: operation.status,
      progress: operation.progress,
      error: operation.error ?? null,
      result: parsed?.success ? parsed.data : null,
    };
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
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
      .catch((error) => this.logger.warn(`Studio transcription worker failed: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioTranscription],
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
    const folder = join(
      StorageCore.getFolderLocation(StorageFolder.Exports, operation.ownerId),
      'studio-transcription',
      operation.id,
      claimToken,
    );
    const wavPath = join(folder, 'audio.wav');
    const controller = new AbortController();
    this.abort = controller;
    if (this.stopping) {
      controller.abort(new Error('Worker stopping'));
    }
    let stage = MediaOperationStatus.Preparing;
    let processed = 0;
    let total = operation.totalUnits === null ? 0 : Number(operation.totalUnits);
    let progress = 0;
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
          progress,
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
      const selection = await this.admit(snapshot.destinationId, operation.id);
      const resolved = await this.source(auth, {
        projectId: snapshot.projectId,
        clipId: snapshot.clipId,
        revision: snapshot.revision,
        destination: selection.kind,
        backgroundRunner: true,
      });
      if (resolved.digest !== snapshot.digest || resolved.clip.sourceKey !== snapshot.sourceKey) {
        throw new BadRequestException('The project revision or its clip changed');
      }
      const info = await this.media.probe(resolved.path);
      if (info.audioStreams.length === 0) {
        throw new BadRequestException('The clip has no sound to transcribe');
      }
      const window = transcriptionWindow(resolved.clip);
      total = Math.ceil(toApproximateNumber(window.duration) * 1000);
      this.storage.mkdirSync(folder);
      await this.audio.extractAudio(resolved.path, wavPath, window, controller.signal);
      controller.signal.throwIfAborted();

      stage = MediaOperationStatus.Rendering;
      progress = EXTRACTED_PROGRESS;
      await monitor();
      controller.signal.throwIfAborted();
      const transcript = await this.machineLearning.transcribe(
        selection,
        wavPath,
        { language: snapshot.whisperLanguage },
        controller.signal,
        (segment) => {
          processed = Math.min(total, Math.round(segment.end * 1000));
          progress = EXTRACTED_PROGRESS + (total ? Math.min(1, processed / total) : 0) * (95 - EXTRACTED_PROGRESS);
        },
      );
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();

      const { cues, words } = mapTranscript(resolved.clip, transcript.segments);
      const result = StudioTranscriptionResultSchema.parse({
        language: transcript.info.language,
        languageProbability: snapshot.whisperLanguage ? 1 : transcript.info.languageProbability,
        model: transcript.info.model,
        cues,
        words,
      });
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
        throw new Error('Claim lost before the transcript was recorded');
      }
    } catch (error) {
      const held = await this.operations.getForWorker(operation.id);
      if (held?.claimToken === claimToken && held.status === MediaOperationStatus.Cancelling) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      } else {
        const unavailable = error instanceof TranscriptionUnavailableError;
        await this.operations.fail(
          operation.id,
          claimToken,
          {
            errorCode: unavailable ? 'studio_transcription_unavailable' : 'studio_transcription_failed',
            error:
              error instanceof BadRequestException || unavailable
                ? (error as Error).message
                : 'Transcription failed; no captions were made',
          },
          // A refusal (clip, source, destination) or a worker without Whisper fails the same way again.
          { retry: !(error instanceof BadRequestException || unavailable) },
        );
        if (!(error instanceof BadRequestException)) {
          this.logger.warn(`Studio transcription ${operation.id} failed: ${error}`);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await writing;
      if (this.abort === controller) {
        this.abort = undefined;
      }
      // Nothing of the media is kept once the job settles (protocol 15.1).
      await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Admit Studio AI against exactly the named destination. Only this server's own ML container or a
   * home-network worker runs Whisper; Frameleaf Cloud transcription is not offered here.
   */
  private async admit(destinationId: string, jobId: string | null): Promise<MlSelection> {
    const destination = await this.mlDestinations.getById(destinationId);
    if (destination?.kind === MlDestinationKind.FrameleafCloud) {
      throw new BadRequestException('Captions run on this server or a home-network worker, not on Frameleaf Cloud');
    }
    return selectMlDestination(
      { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
      {
        workload: MlWorkload.StudioAi,
        destinationId,
        jobId,
        jobName: 'studio-transcription',
        studioFeature: 'captions',
      },
    );
  }

  /** The clip on a stored revision (the head when none is named) and the file its source is read from. */
  private async source(
    auth: AuthDto,
    input: {
      projectId: string;
      clipId: string;
      revision?: number;
      destination: MlDestinationKind;
      backgroundRunner?: boolean;
    },
  ) {
    await this.studio.requireOwnedProject(auth, input.projectId, 'Only the project owner can transcribe its clips');
    const authorized = await this.studio.authorizeRevision(auth, {
      projectId: input.projectId,
      revision: input.revision,
      destination: StudioDestination.Local,
    });
    if (authorized.project.archivedAt) {
      throw new BadRequestException('Bring the project back from the archive first');
    }
    const clip: TranscriptionClip = transcriptionClipOf(authorized.envelope.graph, input.clipId);
    // Fresh access to the clip's source for where its audio goes; a manifest cached at submit is not reused.
    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId: input.projectId,
      ownerId: auth.user.id,
      revision: authorized.revision.revision,
      graph: authorized.envelope.graph,
      imports: await this.projects.listImportDeclarations(input.projectId),
      generated: await this.projects.listGeneratedResources(input.projectId),
      destination: input.destination === MlDestinationKind.Lan ? StudioDestination.Lan : StudioDestination.Local,
      backgroundRunner: input.backgroundRunner ?? false,
    });
    const entry = resolution.manifest.entries.find((item) => item.key === clip.sourceKey);
    if (!entry?.path || entry.grant !== 'render') {
      throw new BadRequestException("The clip's source is not available to transcribe");
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

  private snapshot(operation: MediaOperation): TranscriptionSnapshot {
    const snapshot = operation.snapshot as Partial<TranscriptionSnapshot> | null;
    if (
      operation.kind !== MediaOperationKind.StudioTranscription ||
      snapshot?.kind !== 'studio-transcription' ||
      snapshot.projectId !== operation.projectId ||
      !isStudioUuid(snapshot.projectId) ||
      !Number.isSafeInteger(snapshot.revision) ||
      typeof snapshot.digest !== 'string' ||
      typeof snapshot.clipId !== 'string' ||
      typeof snapshot.sourceKey !== 'string' ||
      typeof snapshot.language !== 'string' ||
      typeof snapshot.destinationId !== 'string'
    ) {
      throw new BadRequestException('Invalid transcription snapshot');
    }
    return snapshot as TranscriptionSnapshot;
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
