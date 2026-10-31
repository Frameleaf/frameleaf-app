import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioReframeResponseDto } from 'src/dtos/studio-reframe.dto.js';
import { MlWorkload, TranscodeTarget } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, MlSelection } from 'src/repositories/machine-learning.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioAuthorizedEntry } from 'src/services/studio-resource.service.js';
import { getConfig } from 'src/utils/config.js';
import { ThumbnailConfig } from 'src/utils/media.js';
import { isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { homeMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import {
  REFRAME_SAMPLE_POINTS,
  ReframePath,
  ReframeShot,
  canvasFraction,
  reframeCanvas,
  reframeShots,
  shotSourceSeconds,
  smoothSubjectPath,
  subjectCentre,
} from 'src/utils/studio-reframe.js';
import { StudioDestination, isStudioUuid } from 'src/utils/studio-resources.js';

/** Frames one framing request may send to face detection; later video shots use the library's faces. */
const MAX_SAMPLED_FRAMES = 48;
/** Time one framing request may spend sampling video frames before it answers with what it has. */
const SAMPLE_BUDGET_MS = 20_000;
/** Sampled frames remembered across requests (asset, checksum-free: originals do not change under an id). */
const CACHE_SIZE = 4000;

type FaceDetector = { selection: MlSelection; options: { modelName: string; minScore: number } };

/**
 * FL-563: the automatic framing of a project's shots for a vertical or square export.
 *
 * For each shot of the head revision: where the subject is, from the face boxes the library already
 * has for the source (its preview frame), and for a video from a few frames sampled through the part
 * of the clip the shot uses, each run through the same face detection on this server or a computer
 * on the home network (never Frameleaf Cloud). The samples become a smoothed path; a shot with no face
 * found is centred. Nothing is stored and the project is not changed: the export dialog shows the
 * framing and sends it back with the export, which seals it (`sealStudioReframe`).
 */
@Injectable()
export class StudioReframeService {
  private readonly frames = new Map<string, number | null>();

  constructor(
    private logger: LoggingRepository,
    private studio: StudioProjectService,
    private persons: PersonRepository,
    private assetJobs: AssetJobRepository,
    private media: MediaRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
    private configRepository: ConfigRepository,
    private systemMetadata: SystemMetadataRepository,
  ) {
    this.logger.setContext(StudioReframeService.name);
  }

  async framing(auth: AuthDto, projectId: string): Promise<StudioReframeResponseDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can export it');
    const authorized = await this.studio.authorizeRevision(auth, { projectId, destination: StudioDestination.Local });
    const graph = authorized.envelope.graph;
    const canvas = reframeCanvas(graph);
    if (!canvas) {
      throw new BadRequestException('The project has no frame size yet');
    }
    const readable = new Set(
      authorized.manifest.entries.filter((entry) => isLibraryAsset(entry)).map((entry) => entry.assetId ?? entry.id),
    );
    const shots = reframeShots(graph);
    const detector = shots.some((shot) => shot.type === 'video') ? await this.detector() : null;
    const budget = { frames: MAX_SAMPLED_FRAMES, until: Date.now() + SAMPLE_BUDGET_MS };

    const result: StudioReframeResponseDto['shots'] = [];
    for (const shot of shots) {
      const assetId = shot.mediaId && readable.has(shot.mediaId) ? shot.mediaId : null;
      const subject = assetId ? await this.subjectPath(auth, shot, assetId, detector, budget) : null;
      const path: ReframePath = subject
        ? subject.map((point) => ({ t: point.t, x: canvasFraction(shot.item, canvas, point.x) }))
        : [{ t: 0.5, x: canvasFraction(shot.item, canvas, 0.5) }];
      result.push({
        clipId: shot.id,
        type: shot.type,
        assetId,
        from: shot.from,
        durationInFrames: Math.max(1, shot.durationInFrames),
        subject: subject ? 'face' : 'none',
        path,
      });
    }
    return { revision: authorized.revision.revision, width: canvas.width, height: canvas.height, shots: result };
  }

  /** The subject across the source picture (0..1) through the shot, or null when no face is found. */
  private async subjectPath(
    auth: AuthDto,
    shot: ReframeShot,
    assetId: string,
    detector: FaceDetector | null,
    budget: { frames: number; until: number },
  ): Promise<ReframePath | null> {
    const faces = await this.persons.getFaces(assetId, { viewingUserId: auth.user.id });
    const prior = subjectCentre(faces);
    if (shot.type !== 'video' || !detector) {
      return smoothSubjectPath([], prior);
    }
    const samples: Array<{ t: number; x: number | null }> = [];
    for (const t of REFRAME_SAMPLE_POINTS) {
      const seconds = shotSourceSeconds(shot, t);
      if (seconds === null) {
        break;
      }
      const key = `${assetId}:${Math.round(seconds * 1000)}`;
      if (!this.frames.has(key)) {
        if (budget.frames <= 0 || Date.now() > budget.until) {
          break;
        }
        budget.frames--;
        this.remember(key, await this.sampleFrame(assetId, seconds, detector));
      }
      samples.push({ t, x: this.frames.get(key) ?? null });
    }
    return smoothSubjectPath(samples, prior);
  }

  private remember(key: string, value: number | null) {
    if (this.frames.size >= CACHE_SIZE) {
      const oldest = this.frames.keys().next().value;
      if (oldest !== undefined) {
        this.frames.delete(oldest);
      }
    }
    this.frames.set(key, value);
  }

  /** Face detection on this network, or null when it is turned off or cannot be reached. */
  private async detector(): Promise<FaceDetector | null> {
    try {
      const { machineLearning } = await getConfig(
        { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
        { withCache: true },
      );
      if (!isFacialRecognitionEnabled(machineLearning)) {
        return null;
      }
      const destinationId = await homeMlDestinationId(this.mlDestinations, MlWorkload.Face);
      const selection = await selectMlDestination(
        { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
        { workload: MlWorkload.Face, destinationId, jobId: null, jobName: 'studio-reframe', homeOnly: true },
      );
      const { modelName, minScore } = machineLearning.facialRecognition;
      return { selection, options: { modelName, minScore } };
    } catch (error) {
      this.logger.debug(`Studio framing uses the library's faces only: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  /** The subject centre in one frame of a video, or null when no face is found or it cannot be read. */
  private async sampleFrame(assetId: string, seconds: number, detector: FaceDetector): Promise<number | null> {
    const video = await this.assetJobs.getForVideoDuplicateFrameJob(assetId);
    if (!video) {
      return null;
    }
    const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-reframe-'));
    try {
      const config = await getConfig(
        { configRepo: this.configRepository, metadataRepo: this.systemMetadata, logger: this.logger },
        { withCache: true },
      );
      const framePath = path.join(folder, 'frame.jpeg');
      const command = ThumbnailConfig.create(
        { ...config.ffmpeg, targetResolution: config.image.preview.size.toString() },
        Math.max(0, seconds),
      ).getCommand(TranscodeTarget.Video, video.videoStream, undefined, video.format);
      await this.media.transcode(video.originalPath, framePath, command);
      const { imageWidth, imageHeight, faces } = await this.machineLearning.detectFaces(
        detector.selection,
        framePath,
        detector.options,
      );
      return subjectCentre(
        faces.map(({ boundingBox }) => ({
          boundingBoxX1: boundingBox.x1,
          boundingBoxY1: boundingBox.y1,
          boundingBoxX2: boundingBox.x2,
          boundingBoxY2: boundingBox.y2,
          imageWidth,
          imageHeight,
        })),
      );
    } catch (error) {
      this.logger.debug(
        `No subject read from ${assetId} at ${seconds.toFixed(2)}s: ${(error as Error)?.message ?? error}`,
      );
      return null;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
}

/** Library media this session may read (owned or shared), named by asset id. */
const isLibraryAsset = (entry: StudioAuthorizedEntry) =>
  (entry.sourceAccess === 'owner' || entry.sourceAccess === 'shared') && isStudioUuid(entry.assetId ?? entry.id);
