import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioVoiceAnalysisDto,
  StudioVoiceCleanupCreateDto,
  StudioVoiceCleanupDto,
  StudioVoiceCleanupQueuedDto,
  StudioVoiceCleanupResultSchema,
} from 'src/dtos/studio-voice-cleanup.dto.js';
import {
  FrameleafWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlProcessingSource,
  MlWorkload,
  StorageFolder,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  MlSelection,
  VoiceCleanupUnavailableError,
} from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioMovieRepository } from 'src/repositories/studio-movie.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioTranscriptionRepository } from 'src/repositories/studio-transcription.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectImportService, studioImportIncomingFolder } from 'src/services/studio-project-import.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { toApproximateNumber } from 'src/utils/rational-time.js';
import { StudioDestination, isStudioUuid } from 'src/utils/studio-resources.js';
import {
  VoiceCleanupClip,
  VoiceCleanupNoise,
  VoiceCleanupStrength,
  voiceAnalysisWindow,
  voiceCleanupClipOf,
  voiceCleanupWindow,
  voiceNoisesOf,
  voiceSeconds,
} from 'src/utils/studio-voice-cleanup.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
/** Reading the clip's sound gets the first few percent of the bar; keeping the result the last few. */
const EXTRACTED_PROGRESS = 5;
const CLEANED_PROGRESS = 92;
/** The analysis is a quick look; a worker that takes longer than this is not answering. */
const ANALYSIS_TIMEOUT_MS = 60_000;

/** A clip's label as a file name: no path separators, reserved characters or control characters. */
const fileSafe = (label: string) =>
  [...label]
    .map((character) =>
      (character.codePointAt(0) ?? 0) < 32 || String.raw`\/:*?"<>|`.includes(character) ? ' ' : character,
    )
    .join('')
    .trim();

/**
 * Studio AI jobs on one clip share the `studio_transcription` kind, told apart by `snapshot.kind`: a
 * response enum the native apps decode strictly never gains a value (FL-637).
 */
export const VOICE_CLEANUP_SNAPSHOT_KIND = 'studio-voice-cleanup';

type VoiceSnapshot = {
  kind: typeof VOICE_CLEANUP_SNAPSHOT_KIND;
  projectId: string;
  revision: number;
  digest: string;
  clipId: string;
  mediaId: string;
  strength: VoiceCleanupStrength;
  noises: VoiceCleanupNoise[];
  humHz: 50 | 60 | null;
};
type Job = { operation: MediaOperation; claimToken: string };

/**
 * Studio "Clean up voice" (FL-637, approved mock 2026-10-29).
 *
 * The analysis reads up to a minute of the clip's sound and asks the speech model what is in it. A
 * clean-up is a durable job Activity follows: a worker on this server reads the clip's source window
 * (with a second of handle each side) from the original with ffmpeg into a private 48 kHz WAV, sends it
 * to the first place in the processing order that can clean it ("Where work runs": this server, then
 * the person's computers; never Frameleaf Cloud in v1), and keeps the cleaned sound with the project as
 * an audio import. The graph is never edited here: the editor plays the clip from the import and keeps
 * the original, so the person can go back to it. The WAVs are deleted once the job settles.
 */
@Injectable()
export class StudioVoiceCleanupService {
  private readonly workerId = `studio-voice-cleanup-${randomUUID()}`;
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
    private imports: StudioProjectImportService,
    private users: UserRepository,
    private media: MediaRepository,
    private storage: StorageRepository,
    private audio: StudioTranscriptionRepository,
    private movies: StudioMovieRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
  ) {
    this.logger.setContext(StudioVoiceCleanupService.name);
  }

  /** "Found in this clip": a quick look at the start of the clip's sound. Nothing is kept. */
  async analyze(auth: AuthDto, projectId: string, clipId: string): Promise<StudioVoiceAnalysisDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    const resolved = await this.source(auth, { projectId, clipId });
    const folder = join(
      StorageCore.getFolderLocation(StorageFolder.Exports, auth.user.id),
      'studio-voice-cleanup',
      `analysis-${randomUUID()}`,
    );
    const wavPath = join(folder, 'audio.wav');
    const signal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
    try {
      this.storage.mkdirSync(folder);
      await this.audio.extractAudio(resolved.path, wavPath, voiceAnalysisWindow(resolved.clip), signal, 48_000);
      const found = await this.onFirstWorker(null, (selection) =>
        this.machineLearning.analyzeVoice(selection, wavPath, signal),
      );
      return { clipId, noises: voiceNoisesOf(found.noises), humHz: found.humHz };
    } finally {
      await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  async create(
    auth: AuthDto,
    projectId: string,
    dto: StudioVoiceCleanupCreateDto,
  ): Promise<StudioVoiceCleanupQueuedDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    const noises = voiceNoisesOf(dto.noises);
    if (noises.length === 0) {
      throw new BadRequestException('Choose what to remove from the sound');
    }
    const resolved = await this.source(auth, { projectId, clipId: dto.clipId });
    const window = voiceCleanupWindow(resolved.clip);
    const snapshot: VoiceSnapshot = {
      kind: VOICE_CLEANUP_SNAPSHOT_KIND,
      projectId,
      revision: resolved.revision,
      digest: resolved.digest,
      clipId: dto.clipId,
      mediaId: resolved.clip.mediaId,
      strength: dto.strength,
      noises,
      humHz: dto.humHz ?? null,
    };
    const operation = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioTranscription,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Clean up voice',
      assetId: resolved.assetId,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: resolved.revisionId,
      snapshot,
      settings: { task: 'voice-cleanup', strength: dto.strength, noises },
      estimate: null,
      totalUnits: Math.ceil(toApproximateNumber(window.duration) * 1000),
      maxAttempts: 2,
    });
    return { id: operation.id, status: operation.status };
  }

  /** The job and, once it completed, the cleaned sound's import. Owner only. */
  async get(auth: AuthDto, projectId: string, id: string): Promise<StudioVoiceCleanupDto> {
    const operation = auth.sharedLink ? undefined : await this.operations.getForOwner(id, auth.user.id);
    if (
      !operation ||
      operation.kind !== MediaOperationKind.StudioTranscription ||
      (operation.snapshot as { kind?: unknown } | null)?.kind !== VOICE_CLEANUP_SNAPSHOT_KIND ||
      operation.projectId !== projectId
    ) {
      throw new NotFoundException('Voice clean-up not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can read its clean-ups');
    const snapshot = this.snapshot(operation);
    const parsed =
      operation.status === MediaOperationStatus.Completed
        ? StudioVoiceCleanupResultSchema.safeParse(operation.result)
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
      .catch((error) => this.logger.warn(`Studio voice clean-up worker failed: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioTranscription],
        snapshotKinds: [VOICE_CLEANUP_SNAPSHOT_KIND],
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
      'studio-voice-cleanup',
      operation.id,
      claimToken,
    );
    const wavPath = join(folder, 'audio.wav');
    const cleanedPath = join(folder, 'cleaned.wav');
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
    // The encoded file waits outside `folder`, in the import service's incoming folder.
    let incoming: string | undefined;
    let uploadStarted = false;
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
      const resolved = await this.source(auth, {
        projectId: snapshot.projectId,
        clipId: snapshot.clipId,
        revision: snapshot.revision,
        backgroundRunner: true,
      });
      if (resolved.digest !== snapshot.digest || resolved.clip.mediaId !== snapshot.mediaId) {
        throw new BadRequestException('The project revision or its clip changed');
      }
      const info = await this.media.probe(resolved.path, { countFrames: false, signal: controller.signal });
      if (info.audioStreams.length === 0) {
        throw new BadRequestException('The clip has no sound to clean up');
      }
      const window = voiceCleanupWindow(resolved.clip);
      total = Math.ceil(toApproximateNumber(window.duration) * 1000);
      this.storage.mkdirSync(folder);
      await this.audio.extractAudio(resolved.path, wavPath, window, controller.signal, 48_000);
      controller.signal.throwIfAborted();

      stage = MediaOperationStatus.Rendering;
      progress = EXTRACTED_PROGRESS;
      await monitor();
      controller.signal.throwIfAborted();
      const cleaned = await this.onFirstWorker(operation.id, (selection) =>
        this.machineLearning.cleanVoice(
          selection,
          wavPath,
          { strength: snapshot.strength, noises: snapshot.noises, humHz: snapshot.humHz },
          cleanedPath,
          controller.signal,
          (done, frames) => {
            processed = Math.round((done / frames) * total);
            progress = EXTRACTED_PROGRESS + (done / frames) * (CLEANED_PROGRESS - EXTRACTED_PROGRESS);
          },
        ),
      );
      controller.signal.throwIfAborted();

      // Kept with the project as an audio import, like music someone adds in Studio.
      const name = fileSafe(resolved.clip.label) || 'Clip';
      const fileName = `${name.slice(0, 120)} (cleaned voice).m4a`;
      incoming = join(studioImportIncomingFolder(operation.ownerId), `voice-${operation.id}-${randomUUID()}.m4a`);
      this.storage.mkdirSync(studioImportIncomingFolder(operation.ownerId));
      await this.movies.encodeMusic(cleanedPath, incoming, cleaned.seconds + 1, controller.signal);
      const { size } = await this.storage.stat(incoming);
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();
      if (!(await this.operations.beginValidation(operation.id, claimToken))) {
        throw new Error('Claim lost');
      }
      // From here the import service owns the file, and removes it if it refuses it.
      uploadStarted = true;
      const kept = await this.imports.upload(auth, snapshot.projectId, randomUUID(), {
        path: incoming,
        size,
        mimetype: 'audio/mp4',
        originalname: fileName,
      } as Express.Multer.File);
      const result = StudioVoiceCleanupResultSchema.parse({
        import: kept,
        strength: snapshot.strength,
        noises: snapshot.noises,
        humHz: snapshot.humHz,
        sourceStartSeconds: voiceSeconds(window.handleBefore),
        durationSeconds: cleaned.seconds,
      });
      const outcome = await this.operations.publishValidated(operation.id, claimToken, async (tx) => {
        await tx
          .updateTable('media_operation')
          .set({ result, processedUnits: total })
          .where('id', '=', operation.id)
          .execute();
        return true;
      });
      if (outcome !== 'completed') {
        throw new Error('Claim lost before the cleaned sound was recorded');
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
            errorCode: refused ? 'studio_voice_cleanup_unavailable' : 'studio_voice_cleanup_failed',
            error: refused ? (error as Error).message : 'The voice clean-up failed; the original sound is unchanged',
          },
          // A refusal (clip, source, no computer that can clean it) fails the same way again.
          { retry: !refused },
        );
        if (!refused) {
          this.logger.warn(`Studio voice clean-up ${operation.id} failed: ${error}`);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await writing;
      if (this.abort === controller) {
        this.abort = undefined;
      }
      await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
      if (incoming && !uploadStarted) {
        await this.storage.unlink(incoming).catch(() => {});
      }
    }
  }

  /**
   * Run on the first place in the processing order that can clean up voices ("Where work runs": this
   * server, then the person's computers). A place that cannot (an older worker, no model) is passed over
   * for the next. Frameleaf Cloud is not offered in v1 (owner decision 2026-10-29), so the sound is never
   * sent there.
   */
  private async onFirstWorker<T>(jobId: string | null, work: (selection: MlSelection) => Promise<T>): Promise<T> {
    const candidates = await this.mlDestinations.resolveRoute(MlWorkload.StudioAi);
    let cloudOnly = false;
    for (const candidate of candidates) {
      if (!candidate.available || candidate.desktopPool) {
        continue;
      }
      if (candidate.source === MlProcessingSource.Cloud) {
        cloudOnly = true;
        continue;
      }
      let selection: MlSelection;
      try {
        selection = await selectMlDestination(
          { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
          {
            workload: MlWorkload.StudioAi,
            destinationId: candidate.destinationId,
            jobId,
            jobName: 'studio-voice-cleanup',
            desktopPool: 'skip',
          },
        );
      } catch (error) {
        this.logger.warn(`Voice clean-up: ${candidate.destinationId} cannot take it now: ${error}`);
        continue;
      }
      try {
        return await work(selection);
      } catch (error) {
        if (error instanceof VoiceCleanupUnavailableError) {
          this.logger.warn(`Voice clean-up: ${candidate.destinationId} cannot clean up voices: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException(
      cloudOnly
        ? 'Voices are cleaned up on this server or a computer at home, and none is available now'
        : 'No computer that can clean up voices is available now',
    );
  }

  /** The clip on a stored revision (the head when none is named) and the file its sound is read from. */
  private async source(
    auth: AuthDto,
    input: { projectId: string; clipId: string; revision?: number; backgroundRunner?: boolean },
  ) {
    await this.studio.requireOwnedProject(auth, input.projectId, 'Only the project owner can clean up its clips');
    const authorized = await this.studio.authorizeRevision(auth, {
      projectId: input.projectId,
      revision: input.revision,
      destination: StudioDestination.Local,
    });
    if (authorized.project.archivedAt) {
      throw new BadRequestException('Bring the project back from the archive first');
    }
    const clip: VoiceCleanupClip = voiceCleanupClipOf(authorized.envelope.graph, input.clipId);
    // Fresh access to the clip's source; a Locked original is refused here as everywhere in Studio.
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
    const entry = resolution.manifest.entries.find((item) => clip.sourceKeys.includes(item.key));
    if (!entry?.path || entry.grant !== 'render') {
      throw new BadRequestException("The clip's sound is not available to clean up");
    }
    return {
      clip,
      path: entry.path,
      assetId: entry.assetId ?? (entry.key.startsWith('library-asset:') ? entry.id : null),
      revision: authorized.revision.revision,
      revisionId: authorized.revision.id,
      digest: authorized.revision.digest,
    };
  }

  private snapshot(operation: MediaOperation): VoiceSnapshot {
    const snapshot = operation.snapshot as Partial<VoiceSnapshot> | null;
    if (
      operation.kind !== MediaOperationKind.StudioTranscription ||
      snapshot?.kind !== VOICE_CLEANUP_SNAPSHOT_KIND ||
      snapshot.projectId !== operation.projectId ||
      !isStudioUuid(snapshot.projectId) ||
      !Number.isSafeInteger(snapshot.revision) ||
      typeof snapshot.digest !== 'string' ||
      typeof snapshot.clipId !== 'string' ||
      typeof snapshot.mediaId !== 'string' ||
      !['light', 'standard', 'strong'].includes(snapshot.strength as string) ||
      !Array.isArray(snapshot.noises) ||
      voiceNoisesOf(snapshot.noises).length !== snapshot.noises.length ||
      ![50, 60, null].includes(snapshot.humHz as number | null)
    ) {
      throw new BadRequestException('Invalid voice clean-up snapshot');
    }
    return snapshot as VoiceSnapshot;
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
