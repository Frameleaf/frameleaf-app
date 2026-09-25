import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { join } from 'node:path';
import type { SystemConfig } from 'src/config.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  VideoMomentCoverDto,
  VideoMomentCreateDto,
  VideoMomentDto,
  VideoMomentSearchDto,
  VideoMomentSearchResponseDto,
  VideoMomentSimilarDto,
  VideoMomentUpdateDto,
  VideoMomentsResponseDto,
} from 'src/dtos/enrichment.dto.js';
import {
  CacheControl,
  EnrichmentItemState,
  EnrichmentStaleReason,
  ImmichWorker,
  JobName,
  MlWorkload,
  Permission,
  StorageFolder,
  VideoMomentIndexState,
  VideoMomentMatch,
  VideoMomentSource,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import {
  VideoMoment,
  VideoMomentFrame,
  VideoMomentRepository,
  VideoMomentSearchScope,
} from 'src/repositories/video-moment.repository.js';
import { IdentityPostValidator } from 'src/services/identity-post-validator.service.js';
import { ImageDescriptionPromptAssembler, KnownPerson } from 'src/services/prompt-assembler.service.js';
import { requireAccess } from 'src/utils/access.js';
import { getConfig } from 'src/utils/config.js';
import {
  VIDEO_MOMENT_EXTRACTOR_VERSION,
  coverFrameFor,
  enrichmentConfigHash,
  identityHash,
} from 'src/utils/enrichment-plan.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { isImageDescriptionEnabled, isSmartSearchEnabled } from 'src/utils/misc.js';
import { routedMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import { FrameCutOutcome, VideoFrameDeps, ensureVideoFrames } from 'src/utils/video-moment-frames.js';

/** What one stage of an enrichment plan did to one video. */
export type MomentStageOutcome = { state: EnrichmentItemState; reasonKey?: string; message?: string };

/**
 * Extends the caller's lease between frames. A plan passes its claim heartbeat so a long stage does
 * not lose the claim; `false` means the claim is gone and the stage must stop at once.
 */
type Heartbeat = () => Promise<boolean>;

type CaptionOptions = {
  destinationId?: string | null;
  imageDescription: SystemConfig['machineLearning']['imageDescription'];
  planConfigHash?: string;
  jobId?: string;
  heartbeat?: Heartbeat;
};

type IndexOptions = { destinationId?: string | null; modelName?: string; jobId?: string; heartbeat?: Heartbeat };

const CLAIM_LOST: MomentStageOutcome = {
  state: EnrichmentItemState.Failed,
  reasonKey: 'stage-error',
  message: 'The plan lost its claim; another worker carries on from here',
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const asIso = (value: unknown): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** One hit per second of each video, the first (best) one kept. */
const uniqueMoments = <T extends { assetId: string; timestampMs: number }>(hits: T[]): T[] => {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.assetId}:${Math.round(hit.timestampMs / 1000)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

/**
 * The timestamped moment index of videos (FL-59, `REC-101`).
 *
 * - **Reusable frames.** Six evenly spaced, ranked frames per video, cut once and reused by the
 *   description grid, the search index and captions. Never tied to duplicate detection.
 * - **The index.** A search embedding per frame, so a text search can land on a moment inside a
 *   video instead of on the whole video.
 * - **Captions.** Optional, one model request per frame, never in a default plan.
 * - **Manual moments.** The owner's own moments and typed transcripts. Nothing generated ever
 *   replaces them, and there is no automatic speech recognition.
 *
 * Every model request goes to an explicitly named destination (FL-110): the one a plan pinned, or
 * the routed one. There is no fallback to another destination.
 *
 * Reads follow the asset's own access: a Locked video's moments reach only its owner in an
 * unlocked session. The background stages may process Locked videos, as all backend work may.
 */
@Injectable()
export class VideoMomentIndexService {
  private readonly promptAssembler = new ImageDescriptionPromptAssembler();
  private readonly identityPostValidator = new IdentityPostValidator();

  constructor(
    private logger: LoggingRepository,
    private access: AccessRepository,
    private moments: VideoMomentRepository,
    private media: MediaRepository,
    private storage: StorageRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
    private people: PersonRepository,
    private configRepository: ConfigRepository,
    private systemMetadata: SystemMetadataRepository,
    private jobs: JobRepository,
  ) {
    this.logger.setContext(VideoMomentIndexService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Plan stages                                                         */
  /* ------------------------------------------------------------------ */

  /** The frames stage: cut the reusable frames when the video has none, or its original changed. */
  async runFramesStage(assetId: string): Promise<MomentStageOutcome> {
    return this.fromFrameOutcome(await ensureVideoFrames(this.frameDeps, assetId, await this.config()));
  }

  /**
   * The index stage: a search embedding for every current frame that has none from this model.
   * Frames already indexed are not sent again, so a retry never repeats finished work.
   */
  async runIndexStage(assetId: string, options: IndexOptions = {}): Promise<MomentStageOutcome> {
    const config = await this.config();
    if (!isSmartSearchEnabled(config.machineLearning)) {
      return { state: EnrichmentItemState.Skipped, reasonKey: 'disabled' };
    }

    const frames = await this.currentFrames(assetId, config);
    if ('state' in frames) {
      return frames;
    }

    const modelName = options.modelName ?? config.machineLearning.clip.modelName;
    const indexed = await this.moments.getIndexedFrameIds(assetId, modelName);
    const pending = frames.list.filter(({ id }) => !indexed.has(id));
    if (pending.length === 0) {
      return { state: EnrichmentItemState.Completed, reasonKey: 'current' };
    }

    try {
      const selection = await this.select(MlWorkload.Clip, options.destinationId, options.jobId ?? assetId);
      const embeddings: { frameId: string; embedding: string }[] = [];
      // One frame at a time: the frames are small, and a video must not monopolise the destination.
      for (const frame of pending) {
        if (options.heartbeat && !(await options.heartbeat())) {
          return CLAIM_LOST;
        }
        embeddings.push({
          frameId: frame.id,
          embedding: await this.machineLearning.encodeImage(selection, frame.path, {
            ...config.machineLearning.clip,
            modelName,
          }),
        });
      }
      const written = await this.moments.publishIndex(assetId, embeddings, {
        embeddingModel: modelName,
        embeddingDestinationId: selection.destinationId,
      });
      return written === 0
        ? { state: EnrichmentItemState.Failed, reasonKey: 'source-changed' }
        : { state: EnrichmentItemState.Completed };
    } catch (error) {
      return { state: EnrichmentItemState.Failed, reasonKey: 'model-error', message: errorMessage(error) };
    }
  }

  /**
   * The optional captions stage: a one-sentence generated caption per frame, with the video's
   * confirmed names. Only frames whose caption is missing, or was made with other names or another
   * prompt, are sent; manual moments are never touched.
   */
  async runCaptionStage(assetId: string, options: CaptionOptions): Promise<MomentStageOutcome> {
    const config = await this.config();
    if (!isImageDescriptionEnabled(config.machineLearning)) {
      return { state: EnrichmentItemState.Skipped, reasonKey: 'disabled' };
    }

    const frames = await this.currentFrames(assetId, config);
    if ('state' in frames) {
      return frames;
    }

    const captionConfig = {
      ...options.imageDescription,
      prompt: { ...options.imageDescription.prompt, style: 'terse' as const, sentenceCountTarget: 1 },
    };
    const captionHash = enrichmentConfigHash({ modelName: captionConfig.modelName, prompt: captionConfig.prompt });
    const knownPersons = await this.knownPersons(assetId, frames.ownerId);
    const names = identityHash(knownPersons.map(({ name }) => name));

    const existing = await this.moments.listMoments(assetId);
    const captionFor = new Map(
      existing
        .filter((moment) => moment.source === VideoMomentSource.Generated && moment.frameId)
        .map((moment) => [moment.frameId as string, moment]),
    );
    const pending = frames.list.filter((frame) => {
      const moment = captionFor.get(frame.id);
      const provenance = asRecord(moment?.provenance);
      return !moment?.caption || provenance.identityHash !== names || provenance.configHash !== captionHash;
    });
    if (pending.length === 0) {
      return { state: EnrichmentItemState.Completed, reasonKey: 'current' };
    }

    let selection: MlSelection;
    try {
      selection = await this.select(MlWorkload.Enrichment, options.destinationId, options.jobId ?? assetId);
    } catch (error) {
      return { state: EnrichmentItemState.Failed, reasonKey: 'model-error', message: errorMessage(error) };
    }

    const { prompt } = this.promptAssembler.build({ config: captionConfig.prompt, knownPersons, nsfw: null });
    const captions: { frameId: string; caption: string }[] = [];
    let failure: string | undefined;
    let claimLost = false;
    for (const frame of pending) {
      if (options.heartbeat && !(await options.heartbeat())) {
        claimLost = true;
        break;
      }
      try {
        const result = await this.machineLearning.describeImage(
          selection,
          frame.path,
          captionConfig,
          undefined,
          prompt,
        );
        let caption = result.description?.trim() ?? '';
        if (caption && knownPersons.length > 0) {
          caption = this.identityPostValidator.validate(caption, knownPersons).description.trim();
        }
        if (caption) {
          captions.push({ frameId: frame.id, caption });
        }
      } catch (error) {
        failure = errorMessage(error);
      }
    }

    // What was captioned is kept even when a frame failed; the retry only asks for the rest.
    const written =
      captions.length > 0
        ? await this.moments.publishCaptions(
            assetId,
            captions,
            {
              modelName: captionConfig.modelName,
              configHash: captionHash,
              identityHash: names,
              destinationId: selection.destinationId,
              ...(options.planConfigHash && { planConfigHash: options.planConfigHash }),
            },
            {
              captionModel: captionConfig.modelName,
              captionConfigHash: captionHash,
              captionIdentityHash: names,
              captionDestinationId: selection.destinationId,
            },
            // FL-57: a face correction or rename while captioning means these may name the wrong people
            async () =>
              identityHash((await this.knownPersons(assetId, frames.ownerId)).map(({ name }) => name)) === names,
          )
        : 0;

    if (claimLost) {
      return CLAIM_LOST;
    }
    if (written === 'identity-changed') {
      // nothing was published; the plan's retry captions the frames again with the current names
      return { state: EnrichmentItemState.Failed, reasonKey: 'identity-changed' };
    }
    if (captions.length > 0 && written === 0) {
      // The original was replaced while the frames were being captioned; a retry cuts them again.
      return { state: EnrichmentItemState.Failed, reasonKey: 'source-changed' };
    }
    return failure
      ? { state: EnrichmentItemState.Failed, reasonKey: 'model-error', message: failure }
      : { state: EnrichmentItemState.Completed };
  }

  /* ------------------------------------------------------------------ */
  /* Reads and the owner's own moments                                  */
  /* ------------------------------------------------------------------ */

  async getMoments(auth: AuthDto, assetId: string): Promise<VideoMomentsResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [assetId] });
    return this.present(assetId);
  }

  /**
   * Choose the cover frame. Kept as a time in the video, so it survives the frames being cut again
   * and lands on the nearest new frame. `null` returns to the best-ranked frame.
   */
  async setCover(auth: AuthDto, assetId: string, dto: VideoMomentCoverDto): Promise<VideoMomentsResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    const index = await this.moments.getIndex(assetId);
    if (!index || index.frameCount === 0) {
      throw new BadRequestException('This video has no frames to choose a cover from yet');
    }
    await this.moments.setCover(assetId, dto.timestampMs, auth.user.id);
    // The video's own thumbnail follows the chosen cover (or the automatic pick again when reset).
    await this.jobs.queue({ name: JobName.AssetGenerateThumbnails, data: { id: assetId } });
    return this.present(assetId);
  }

  async createMoment(auth: AuthDto, assetId: string, dto: VideoMomentCreateDto): Promise<VideoMomentDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    await this.requireWithinVideo(assetId, dto.timestampMs, dto.endMs ?? null);
    const moment = await this.moments.createManualMoment({
      assetId,
      timestampMs: dto.timestampMs,
      endMs: dto.endMs ?? null,
      caption: dto.caption?.trim() || null,
      transcript: dto.transcript ?? null,
      createdById: auth.user.id,
    });
    return this.mapMoment(moment, null);
  }

  async updateMoment(
    auth: AuthDto,
    assetId: string,
    momentId: string,
    dto: VideoMomentUpdateDto,
  ): Promise<VideoMomentDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    const existing = await this.moments.getMoment(momentId);
    if (!existing || existing.assetId !== assetId) {
      throw new NotFoundException('Moment not found');
    }
    if (existing.source !== VideoMomentSource.Manual) {
      throw new BadRequestException('Generated moments are refreshed, not edited; add your own moment instead');
    }
    const timestampMs = dto.timestampMs ?? existing.timestampMs;
    const endMs = dto.endMs === undefined ? existing.endMs : dto.endMs;
    await this.requireWithinVideo(assetId, timestampMs, endMs);

    const updated = await this.moments.updateManualMoment(momentId, {
      ...(dto.timestampMs !== undefined && { timestampMs }),
      ...(dto.endMs !== undefined && { endMs }),
      ...(dto.caption !== undefined && { caption: dto.caption?.trim() || null }),
      ...(dto.transcript !== undefined && { transcript: dto.transcript }),
    });
    if (!updated) {
      throw new NotFoundException('Moment not found');
    }
    return this.mapMoment(updated, null);
  }

  async deleteMoment(auth: AuthDto, assetId: string, momentId: string): Promise<void> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [assetId] });
    const existing = await this.moments.getMoment(momentId);
    if (!existing || existing.assetId !== assetId) {
      throw new NotFoundException('Moment not found');
    }
    if (existing.source !== VideoMomentSource.Manual) {
      throw new BadRequestException('Generated moments are refreshed, not deleted');
    }
    await this.moments.deleteManualMoment(momentId);
  }

  /** One reusable frame's image, under the same access as its video. */
  async getFrameFile(auth: AuthDto, frameId: string): Promise<ImmichFileResponse> {
    const frame = await this.moments.getFrame(frameId);
    // A frame that does not exist and one of a video the caller may not read answer the same, so
    // frame ids never confirm that somebody else's video exists.
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [frame?.assetId ?? frameId] });
    if (!frame) {
      throw new BadRequestException(`Not found or no ${Permission.AssetRead} access`);
    }
    return new ImmichFileResponse({
      path: frame.path,
      contentType: mimeTypes.lookup(frame.path),
      // Frame files are named per cut, so a cached copy can never be of an old frame.
      cacheControl: CacheControl.PrivateWithCache,
    });
  }

  /**
   * Find moments inside videos: by meaning against the frame index, and by words in captions and
   * typed transcripts. Only the caller's own library, and Locked videos only in an unlocked
   * session. The text is encoded on the routed search destination; if that destination refuses,
   * the word matches are still returned and nothing is sent anywhere else.
   */
  async search(auth: AuthDto, dto: VideoMomentSearchDto): Promise<VideoMomentSearchResponseDto> {
    const limit = dto.limit ?? 24;
    const scope = this.searchScope(auth, limit);
    const config = await this.config();

    const textHits = await this.moments.searchMomentText(dto.query, scope);
    const staleCaptions = await this.staleCaptionIds(textHits.map(({ momentId }) => momentId));
    const hits: VideoMomentSearchResponseDto['hits'] = textHits
      .filter(({ momentId }) => !staleCaptions.has(momentId))
      .map((hit) => {
        const inCaption = hit.caption?.toLowerCase().includes(dto.query.toLowerCase()) ?? false;
        return {
          assetId: hit.assetId,
          timestampMs: hit.timestampMs,
          frameId: null,
          momentId: hit.momentId,
          caption: hit.caption,
          match: inCaption ? VideoMomentMatch.Caption : VideoMomentMatch.Transcript,
          score: 1,
        };
      });

    if (isSmartSearchEnabled(config.machineLearning)) {
      try {
        const selection = await this.select(MlWorkload.Clip, null, null);
        const modelName = config.machineLearning.clip.modelName;
        const embedding = await this.machineLearning.encodeText(selection, dto.query, { modelName });
        const frameHits = await this.moments.searchFrames(embedding, modelName, scope);
        const staleFrameCaptions = await this.staleCaptionIds(frameHits.flatMap(({ momentId }) => momentId ?? []));
        for (const hit of frameHits) {
          hits.push({
            assetId: hit.assetId,
            timestampMs: hit.timestampMs,
            frameId: hit.frameId,
            momentId: null,
            // A caption made with names that have changed since is not shown; the frame still matched.
            caption: hit.momentId && staleFrameCaptions.has(hit.momentId) ? null : hit.caption,
            match: VideoMomentMatch.Visual,
            score: Math.max(0, 1 - hit.distance),
          });
        }
      } catch (error) {
        this.logger.warn(`Moment search could not use the search destination: ${errorMessage(error)}`);
      }
    }

    return { hits: uniqueMoments(hits).slice(0, limit) };
  }

  /**
   * Frame-to-moment search (FL-59): the moments nearest one frame's stored embedding, in other
   * videos and at other times in the same one. The frame is read under its video's own access; the
   * results are the caller's own library under exactly the rules of `search`, and never the frame
   * itself. Nothing is sent to a model: the embedding is already stored.
   */
  async searchSimilar(
    auth: AuthDto,
    frameId: string,
    dto: VideoMomentSimilarDto,
  ): Promise<VideoMomentSearchResponseDto> {
    const frame = await this.moments.getFrame(frameId);
    // An unknown frame and a frame of a video the caller may not read answer the same.
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [frame?.assetId ?? frameId] });
    if (!frame) {
      throw new BadRequestException(`Not found or no ${Permission.AssetRead} access`);
    }
    const query = await this.moments.getFrameEmbedding(frameId);
    if (!query) {
      throw new BadRequestException('This frame has no search embedding yet; index the video first');
    }

    const found = await this.moments.searchFrames(query.embedding, query.modelName, {
      ...this.searchScope(auth, dto.limit ?? 24),
      excludeFrameId: frameId,
    });
    const staleCaptions = await this.staleCaptionIds(found.flatMap(({ momentId }) => momentId ?? []));
    const hits = found.map((hit) => ({
      assetId: hit.assetId,
      timestampMs: hit.timestampMs,
      frameId: hit.frameId,
      momentId: hit.momentId,
      caption: hit.momentId && staleCaptions.has(hit.momentId) ? null : hit.caption,
      match: VideoMomentMatch.Visual,
      score: Math.max(0, 1 - hit.distance),
    }));
    return { hits: uniqueMoments(hits).slice(0, dto.limit ?? 24) };
  }

  /**
   * What a moment search may return: the caller's own library, Locked videos only in an unlocked
   * session, and nothing the session's hidden-content filter hides (suppressed people, pets and
   * tags, and sensitive media while locked), exactly as smart search and asset reads apply it.
   */
  private searchScope(auth: AuthDto, limit: number): VideoMomentSearchScope {
    return {
      ownerId: auth.user.id,
      lockedOwnerId: getLockedOwnerId(auth),
      privacy: getHiddenContentQueryOptions(auth),
      limit,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Invalidation                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * A replaced or changed original makes the generated results stale (FL-59): frames, embeddings
   * and generated moments are dropped, and their files removed. Manual moments, typed transcripts
   * and the cover choice stay. The next plan cuts the frames again.
   */
  @OnEvent({ name: 'AssetMetadataExtracted', workers: [ImmichWorker.Microservices] })
  async onAssetMetadataExtracted({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    const index = await this.moments.getIndex(assetId);
    if (!index) {
      return;
    }

    const fingerprint = (await this.moments.getFingerprints([assetId])).get(assetId);
    if (!fingerprint || fingerprint === index.sourceFingerprint) {
      return;
    }

    const paths = await this.moments.invalidateGenerated(assetId, fingerprint);
    await Promise.all(paths.map((path) => this.storage.unlink(path).catch(() => {})));
    this.logger.log(`Video ${assetId} changed; dropped ${paths.length} generated moment frames`);
  }

  /** The rows go with the asset; the frame files are named after it and removed here. */
  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ assetId, userId }: ArgOf<'AssetDelete'>) {
    const prefix = `${assetId}_moment_`;
    const folder = StorageCore.getNestedFolder(StorageFolder.Thumbnails, userId, prefix);
    const entries = await this.storage.readdir(folder).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(prefix))
        .map((name) => this.storage.unlink(join(folder, name)).catch(() => {})),
    );
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private get frameDeps(): VideoFrameDeps {
    return { media: this.media, storage: this.storage, moments: this.moments, logger: this.logger };
  }

  private config() {
    return getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
      { withCache: true },
    );
  }

  /** Admit a request against the named destination, or the routed one. Never another (FL-110). */
  private async select(workload: MlWorkload, destinationId: string | null | undefined, jobId: string | null) {
    const id = destinationId ?? (await routedMlDestinationId(this.mlDestinations, workload));
    return selectMlDestination(
      { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
      { workload, destinationId: id, jobId, jobName: 'video-moment-index' },
    );
  }

  private fromFrameOutcome(outcome: FrameCutOutcome): MomentStageOutcome {
    switch (outcome.status) {
      case 'cut': {
        return { state: EnrichmentItemState.Completed };
      }
      case 'current': {
        return { state: EnrichmentItemState.Completed, reasonKey: 'current' };
      }
      case 'skipped': {
        return { state: EnrichmentItemState.Skipped, reasonKey: outcome.reasonKey };
      }
      case 'source-changed': {
        // A retry cuts them again from the new original.
        return { state: EnrichmentItemState.Failed, reasonKey: 'source-changed' };
      }
      case 'failed': {
        return { state: EnrichmentItemState.Failed, reasonKey: 'no-frames', message: outcome.message };
      }
    }
  }

  /**
   * The video's current frames, cutting them first if they are missing or stale, so the index and
   * caption stages stand on their own when retried. A stage outcome when there are none.
   */
  private async currentFrames(
    assetId: string,
    config: SystemConfig,
  ): Promise<MomentStageOutcome | { list: VideoMomentFrame[]; ownerId: string }> {
    const outcome = await ensureVideoFrames(this.frameDeps, assetId, config);
    if (outcome.status !== 'cut' && outcome.status !== 'current') {
      return this.fromFrameOutcome(outcome);
    }
    const kinds = await this.moments.getAssetKinds([assetId]);
    const ownerId = kinds.get(assetId)?.ownerId;
    if (!ownerId) {
      return { state: EnrichmentItemState.Skipped, reasonKey: 'not-found' };
    }
    return { list: outcome.frames, ownerId };
  }

  /** Confirmed, visible names on the video, as the caption prompt is given them. */
  private async knownPersons(assetId: string, ownerId: string): Promise<KnownPerson[]> {
    try {
      const faces = await this.people.getFaces(assetId, { isVisible: true, viewingUserId: ownerId });
      const known: KnownPerson[] = [];
      for (const face of faces) {
        const name = face.person?.name?.trim();
        if (!face.personGroupId || !name || face.person?.isHidden) {
          continue;
        }
        const { imageWidth, imageHeight, boundingBoxX1, boundingBoxX2, boundingBoxY1, boundingBoxY2 } = face;
        known.push({
          name,
          faceConfidence: 1,
          boxCenter:
            imageWidth && imageHeight
              ? [(boundingBoxX1 + boundingBoxX2) / 2 / imageWidth, (boundingBoxY1 + boundingBoxY2) / 2 / imageHeight]
              : [0.5, 0.5],
        });
      }
      return known;
    } catch (error) {
      this.logger.warn(`Could not read faces of video ${assetId} for its captions: ${errorMessage(error)}`);
      return [];
    }
  }

  private async requireWithinVideo(assetId: string, timestampMs: number, endMs: number | null) {
    const source = await this.moments.getVideoSource(assetId);
    if (!source) {
      throw new BadRequestException('Moments belong to videos');
    }
    const duration = Number(source.format.duration ?? source.duration ?? 0);
    if (duration > 0 && timestampMs > duration) {
      throw new BadRequestException('The moment is after the end of the video');
    }
    if (endMs !== null && (endMs < timestampMs || (duration > 0 && endMs > duration))) {
      throw new BadRequestException('The moment must end after it starts and before the video ends');
    }
  }

  /** Generated captions made with confirmed names that have changed since. */
  private async staleCaptionIds(momentIds: string[]): Promise<Set<string>> {
    const stale = new Set<string>();
    const byAsset = new Map<string, VideoMoment[]>();
    for (const id of momentIds) {
      const moment = await this.moments.getMoment(id);
      if (moment?.source === VideoMomentSource.Generated) {
        byAsset.set(moment.assetId, [...(byAsset.get(moment.assetId) ?? []), moment]);
      }
    }
    for (const [assetId, list] of byAsset) {
      const kinds = await this.moments.getAssetKinds([assetId]);
      const ownerId = kinds.get(assetId)?.ownerId;
      const names = ownerId ? identityHash((await this.knownPersons(assetId, ownerId)).map(({ name }) => name)) : null;
      for (const moment of list) {
        const pinned = asRecord(moment.provenance).identityHash;
        if (names && typeof pinned === 'string' && pinned !== names) {
          stale.add(moment.id);
        }
      }
    }
    return stale;
  }

  private async present(assetId: string): Promise<VideoMomentsResponseDto> {
    const config = await this.config();
    const [index, frames, moments, fingerprints, kinds] = await Promise.all([
      this.moments.getIndex(assetId),
      this.moments.getFrames(assetId),
      this.moments.listMoments(assetId),
      this.moments.getFingerprints([assetId]),
      this.moments.getAssetKinds([assetId]),
    ]);
    const indexed = await this.moments.getIndexedFrameIds(assetId, config.machineLearning.clip.modelName);

    const fingerprint = fingerprints.get(assetId);
    const sourceStale =
      !!index &&
      !!fingerprint &&
      (index.sourceFingerprint !== fingerprint || index.extractorVersion !== VIDEO_MOMENT_EXTRACTOR_VERSION);
    const staleReason: EnrichmentStaleReason | null = sourceStale ? EnrichmentStaleReason.SourceChanged : null;

    const ownerId = kinds.get(assetId)?.ownerId;
    const names = ownerId ? identityHash((await this.knownPersons(assetId, ownerId)).map(({ name }) => name)) : null;
    const cover = coverFrameFor(frames, index?.coverTimestampMs ?? null);

    const momentStale = (moment: VideoMoment): EnrichmentStaleReason | null => {
      if (moment.source !== VideoMomentSource.Generated) {
        return null;
      }
      if (sourceStale) {
        return EnrichmentStaleReason.SourceChanged;
      }
      const pinned = asRecord(moment.provenance).identityHash;
      return moment.caption && names && typeof pinned === 'string' && pinned !== names
        ? EnrichmentStaleReason.IdentityChanged
        : null;
    };

    return {
      assetId,
      state: sourceStale
        ? VideoMomentIndexState.Stale
        : frames.length === 0
          ? VideoMomentIndexState.None
          : VideoMomentIndexState.Ready,
      staleReason,
      frames: frames.map((frame) => ({
        id: frame.id,
        frameIndex: frame.frameIndex,
        timestampMs: frame.timestampMs,
        width: frame.width,
        height: frame.height,
        score: frame.score,
        rank: frame.rank,
        isCover: cover?.id === frame.id,
        indexed: indexed.has(frame.id),
      })),
      moments: moments.map((moment) => this.mapMoment(moment, momentStale(moment))),
      coverTimestampMs: index?.coverTimestampMs ?? null,
      coverFrameId: cover?.id ?? null,
      extractorVersion: index?.extractorVersion ?? null,
      framesExtractedAt: asIso(index?.framesExtractedAt),
      embeddingModel: index?.embeddingModel ?? null,
      indexedAt: asIso(index?.indexedAt),
      captionModel: index?.captionModel ?? null,
      captionedAt: asIso(index?.captionedAt),
    };
  }

  private mapMoment(moment: VideoMoment, staleReason: EnrichmentStaleReason | null): VideoMomentDto {
    return {
      id: moment.id,
      source: moment.source,
      timestampMs: moment.timestampMs,
      endMs: moment.endMs,
      frameId: moment.frameId,
      caption: moment.caption,
      transcript: moment.transcript,
      staleReason,
      createdAt: asIso(moment.createdAt)!,
      updatedAt: asIso(moment.updatedAt)!,
    };
  }
}
