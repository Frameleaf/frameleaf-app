import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioCutoutCreateDto,
  StudioCutoutDto,
  StudioCutoutMatte,
  StudioCutoutStatus,
  StudioCutoutSubject,
  StudioCutoutSubjectsDto,
} from 'src/dtos/studio-cutout.dto.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  CutoutUnavailableError,
  CutoutWorkerError,
  MachineLearningRepository,
} from 'src/repositories/machine-learning.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioTranscriptionRepository } from 'src/repositories/studio-transcription.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { StudioProjectImportService, studioImportIncomingFolder } from 'src/services/studio-project-import.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { getConfig } from 'src/utils/config.js';
import { isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { homeMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import {
  CutoutFace,
  CutoutPlan,
  atlasCell,
  cutoutDeadlineMs,
  cutoutPlan,
  faceFraction,
  matchFirstFrameFace,
  workerPoints,
} from 'src/utils/studio-cutout.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { TranscriptionClip, transcriptionClipOf } from 'src/utils/studio-transcription.js';

/** A finished or failed cut-out is answered for this long, then forgotten (its matte stays with the project). */
const KEEP_MS = 60 * 60 * 1000;
/** Cut-outs one person may have waiting or running at once. */
const MAX_PENDING_PER_OWNER = 2;

type Job = {
  id: string;
  ownerId: string;
  projectId: string;
  clipId: string;
  subject: StudioCutoutSubject;
  status: StudioCutoutStatus;
  progress: number;
  error: string | null;
  matte: StudioCutoutMatte | null;
  settledAt: number | null;
};

type Face = CutoutFace & { id: string; person?: { id: string; name: string; isHidden: boolean } | null };
type FaceSeed = { faceId: string; box: [number, number, number, number] };
type FaceDetector = {
  selection: Awaited<ReturnType<typeof selectMlDestination>>;
  options: { modelName: string; minScore: number };
};

/** A cut-out that outlived its deadline: the worker stalled or the clip was too long for it. */
class CutoutDeadlineError extends Error {}

/**
 * FL-639: Cut out the subject in a video.
 *
 * Owner only. For one video clip of the head revision: the people face recognition found in its video
 * (the named, visible ones), or "Main subject". A cut-out reads the part of the source the clip plays a
 * few frames a second on this server, sends those frames only to this server's machine learning or a
 * computer on the home network (Where work runs, never Frameleaf Cloud), where SAM2.1 video follows the
 * chosen person from their face box (or the main subject) through the shot. The mattes come back as one
 * PNG kept with the project through the ordinary project-import admission (owner, quota, checksum), so
 * the editor names it on the clip and the export worker receives it like any other project file. The
 * original video never changes, and the frames are deleted when the job settles.
 *
 * Jobs are short and run one at a time in this server process; their state is held for an hour.
 */
@Injectable()
export class StudioCutoutService {
  private readonly jobs = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  /** Creations still between their admission check and their job being recorded, per owner. */
  private readonly creating = new Map<string, number>();

  constructor(
    private logger: LoggingRepository,
    private studio: StudioProjectService,
    private resources: StudioResourceService,
    private projects: StudioProjectRepository,
    private persons: PersonRepository,
    private media: MediaRepository,
    private clips: StudioTranscriptionRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
    private imports: StudioProjectImportService,
    private configRepository: ConfigRepository,
    private systemMetadata: SystemMetadataRepository,
  ) {
    this.logger.setContext(StudioCutoutService.name);
  }

  /** The named people recognised in the clip's video, largest first, or the main subject. */
  async subjects(auth: AuthDto, projectId: string, clipId: string): Promise<StudioCutoutSubjectsDto> {
    const resolved = await this.source(auth, projectId, clipId);
    const people = resolved.assetId ? await this.people(auth, resolved.assetId) : [];
    return {
      subjects: people.length > 0 ? people.map(({ subject }) => subject) : [mainSubject()],
    };
  }

  async create(auth: AuthDto, projectId: string, dto: StudioCutoutCreateDto): Promise<StudioCutoutDto> {
    this.sweep();
    const pending = this.jobs
      .values()
      .filter((job) => job.ownerId === auth.user.id && (job.status === 'queued' || job.status === 'running'))
      .toArray();
    // Reserved before the first await, so concurrent requests cannot all pass the check.
    const owner = auth.user.id;
    if (pending.length + (this.creating.get(owner) ?? 0) >= MAX_PENDING_PER_OWNER) {
      throw new BadRequestException('Wait for the cut-outs already running to finish');
    }
    this.creating.set(owner, (this.creating.get(owner) ?? 0) + 1);
    try {
      return await this.admit(auth, projectId, dto);
    } finally {
      const left = (this.creating.get(owner) ?? 1) - 1;
      if (left > 0) {
        this.creating.set(owner, left);
      } else {
        this.creating.delete(owner);
      }
    }
  }

  private async admit(auth: AuthDto, projectId: string, dto: StudioCutoutCreateDto): Promise<StudioCutoutDto> {
    const resolved = await this.source(auth, projectId, dto.clipId);
    let subject = mainSubject();
    let seed: FaceSeed | null = null;
    if (dto.personId) {
      const person = resolved.assetId
        ? (await this.people(auth, resolved.assetId)).find((item) => item.subject.personId === dto.personId)
        : undefined;
      if (!person) {
        throw new BadRequestException('That person is not recognised in this clip');
      }
      subject = person.subject;
      seed = { faceId: person.faceId, box: person.box };
    }
    const selection = await this.destination();
    const info = await this.media.probe(resolved.path, { countFrames: false });
    const stream = info.videoStreams[0];
    if (!stream) {
      throw new BadRequestException('The clip has no picture to cut out');
    }
    const quarterTurn = Math.abs(stream.rotation ?? 0) % 180 === 90;
    const plan = cutoutPlan(resolved.clip, {
      width: quarterTurn ? stream.height : stream.width,
      height: quarterTurn ? stream.width : stream.height,
    });
    const job: Job = {
      id: randomUUID(),
      ownerId: auth.user.id,
      projectId,
      clipId: dto.clipId,
      subject,
      status: 'queued',
      progress: 0,
      error: null,
      matte: null,
      settledAt: null,
    };
    this.jobs.set(job.id, job);
    const points = workerPoints(plan, dto.points ?? []);
    const run = () => this.run(auth, job, { path: resolved.path, plan, seed, points, selection });
    this.queue = this.queue
      .then(run)
      .catch((error) => this.logger.warn(`Studio cut-out ${job.id} did not run: ${error}`));
    return toDto(job);
  }

  get(auth: AuthDto, projectId: string, id: string): StudioCutoutDto {
    const job = this.jobs.get(id);
    if (auth.sharedLink || !job || job.ownerId !== auth.user.id || job.projectId !== projectId) {
      throw new NotFoundException('Cut-out not found');
    }
    return toDto(job);
  }

  private async run(
    auth: AuthDto,
    job: Job,
    input: {
      path: string;
      plan: CutoutPlan;
      seed: FaceSeed | null;
      points: Array<{ frame: number; x: number; y: number; label: 0 | 1 }>;
      selection: Awaited<ReturnType<typeof selectMlDestination>>;
    },
  ): Promise<void> {
    job.status = 'running';
    let folder: string | undefined;
    const controller = new AbortController();
    // A deadline of its own: a stalled worker must not hold the queue for every later cut-out.
    const deadline = setTimeout(
      () => controller.abort(new CutoutDeadlineError('Following the subject took too long')),
      cutoutDeadlineMs(input.plan.frames),
    );
    try {
      const frameFolder = await mkdtemp(path.join(tmpdir(), 'frameleaf-cutout-'));
      folder = frameFolder;
      const { plan } = input;
      await this.clips.extractFrames(
        input.path,
        frameFolder,
        { startSeconds: plan.startSeconds.toFixed(6), durationSeconds: plan.durationSeconds.toFixed(6) },
        { fps: plan.fps, frames: plan.frames, width: plan.frameWidth, height: plan.frameHeight },
        controller.signal,
      );
      const framePaths = (await readdir(frameFolder))
        .filter((name) => /^\d{5}\.jpg$/.test(name))
        .sort()
        .map((name) => path.join(frameFolder, name));
      if (framePaths.length === 0) {
        throw new BadRequestException('No pictures could be read from the clip');
      }
      const frames = framePaths.length;
      const columns = Math.min(frames, plan.columns);
      const layout: CutoutPlan = { ...plan, frames, columns, rows: Math.ceil(frames / columns) };
      // The library's face box is from the video's cover picture, not this clip's first frame: find the
      // person again there, so SAM2 starts from them and not from whoever stands where they stood.
      const seedBox = input.seed ? await this.firstFrameSeed(input.seed, framePaths[0], controller.signal) : null;
      job.progress = 5;
      const mattes: Buffer[] = Array.from({ length: frames });
      await this.machineLearning.subjectMatte(
        input.selection,
        framePaths,
        {
          seedKind: seedBox ? 'face' : 'subject',
          seedBox,
          points: input.points.filter((point) => point.frame < frames),
          matteWidth: layout.matteWidth,
          matteHeight: layout.matteHeight,
        },
        controller.signal,
        (index, png) => {
          mattes[index] = png;
        },
        (done, total) => {
          job.progress = 5 + Math.round((90 * done) / Math.max(1, total));
        },
      );
      const atlas = await composeAtlas(layout, mattes);
      const importId = randomUUID();
      const incoming = studioImportIncomingFolder(job.ownerId);
      await mkdir(incoming, { recursive: true });
      const file = path.join(incoming, `${importId}.png`);
      await writeFile(file, atlas, { flag: 'wx' });
      const { size } = await stat(file);
      await this.imports.upload(auth, job.projectId, importId, {
        path: file,
        size,
        mimetype: 'image/png',
        originalname: `frameleaf-subject-matte-${importId}.png`,
      } as Express.Multer.File);
      job.matte = {
        importId,
        startSeconds: layout.startSeconds,
        durationSeconds: layout.durationSeconds,
        fps: layout.fps,
        frames,
        columns: layout.columns,
        frameWidth: layout.matteWidth,
        frameHeight: layout.matteHeight,
      };
      job.progress = 100;
      job.status = 'completed';
    } catch (error) {
      job.status = 'failed';
      job.error = readableFailure(
        controller.signal.reason instanceof CutoutDeadlineError ? controller.signal.reason : error,
      );
      if (!(error instanceof BadRequestException || error instanceof CutoutWorkerError)) {
        this.logger.warn(`Studio cut-out ${job.id} failed: ${error}`);
      }
    } finally {
      clearTimeout(deadline);
      job.settledAt = Date.now();
      if (folder) {
        await rm(folder, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /**
   * The chosen person's face on the clip's first extracted frame, as fractions of it: of the faces found
   * there, the one closest to their library face (by face recognition), or failing an embedding the one
   * nearest their library box. Without face detection on this network the library box is used as is.
   */
  private async firstFrameSeed(seed: FaceSeed, framePath: string, signal: AbortSignal) {
    const detector = await this.faceDetector();
    if (!detector) {
      return seed.box;
    }
    signal.throwIfAborted();
    const reference = await this.persons.getFaceForFacialRecognitionJob(seed.faceId);
    const detected = await this.machineLearning.detectFaces(detector.selection, framePath, detector.options);
    const box = matchFirstFrameFace(
      detected,
      seed.box,
      (reference as { faceSearch?: { embedding?: string } | null } | undefined)?.faceSearch?.embedding ?? null,
    );
    if (!box) {
      throw new BadRequestException(
        "The person isn't in the clip's first frame. Trim the clip to start where they appear, or choose Main subject.",
      );
    }
    return box;
  }

  /** Face detection on this server or a computer at home, or null when it is off or cannot be reached. */
  private async faceDetector(): Promise<FaceDetector | null> {
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
        { workload: MlWorkload.Face, destinationId, jobId: null, jobName: 'studio-cutout', homeOnly: true },
      );
      const { modelName, minScore } = machineLearning.facialRecognition;
      return { selection, options: { modelName, minScore } };
    } catch (error) {
      this.logger.debug(`Studio cut-out seeds from the library face: ${(error as Error)?.message ?? error}`);
      return null;
    }
  }

  /** This server's machine learning or a computer on the home network, in the person's priority order. */
  private async destination() {
    try {
      const destinationId = await homeMlDestinationId(this.mlDestinations, MlWorkload.StudioAi);
      const destination = await this.mlDestinations.getById(destinationId);
      if (destination?.kind === MlDestinationKind.FrameleafCloud) {
        throw new BadRequestException('Cut-outs run on this server or a computer at home, not on Frameleaf Cloud');
      }
      return await selectMlDestination(
        { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
        { workload: MlWorkload.StudioAi, destinationId, jobId: null, jobName: 'studio-cutout', homeOnly: true },
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new ServiceUnavailableException(
        'Turn on machine learning on this server or a computer at home to cut out a subject',
      );
    }
  }

  /** Named, visible people with a face in the asset, each with their largest face as fractions of the picture. */
  private async people(auth: AuthDto, assetId: string) {
    const faces = (await this.persons.getFaces(assetId, { viewingUserId: auth.user.id })) as unknown as Face[];
    const best = new Map<
      string,
      { subject: StudioCutoutSubject; faceId: string; box: [number, number, number, number]; area: number }
    >();
    for (const face of faces) {
      const person = face.person;
      const box = faceFraction(face);
      if (!person?.name || person.isHidden || !box) {
        continue;
      }
      const area = (box[2] - box[0]) * (box[3] - box[1]);
      if ((best.get(person.id)?.area ?? -1) < area) {
        best.set(person.id, {
          subject: { kind: 'person', personId: person.id, name: person.name },
          faceId: face.id,
          box,
          area,
        });
      }
    }
    return best
      .values()
      .toArray()
      .sort((a, b) => b.area - a.area);
  }

  /** The video clip on the head revision and the file its source is read from, for the owner. */
  private async source(auth: AuthDto, projectId: string, clipId: string) {
    if (auth.sharedLink) {
      throw new NotFoundException('Studio project not found');
    }
    await this.studio.requireOwnedProject(auth, projectId, 'Only the project owner can cut out its clips');
    const authorized = await this.studio.authorizeRevision(auth, { projectId, destination: StudioDestination.Local });
    if (authorized.project.archivedAt) {
      throw new BadRequestException('Bring the project back from the archive first');
    }
    let clip: TranscriptionClip;
    try {
      clip = transcriptionClipOf(authorized.envelope.graph, clipId);
    } catch (error) {
      throw new BadRequestException(
        `${(error as Error).message}. New clips are saved a moment after they are placed; try again shortly.`,
      );
    }
    if (clip.type !== 'video') {
      throw new BadRequestException('Only a video clip can be cut out');
    }
    // Fresh access to the clip's source (FL-90: locked or hidden media is refused here).
    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId,
      ownerId: auth.user.id,
      revision: authorized.revision.revision,
      graph: authorized.envelope.graph,
      imports: await this.projects.listImportDeclarations(projectId),
      generated: await this.projects.listGeneratedResources(projectId),
      destination: StudioDestination.Local,
      backgroundRunner: false,
    });
    const entry = resolution.manifest.entries.find((item) => item.key === clip.sourceKey);
    if (!entry?.path || entry.grant !== 'render') {
      throw new BadRequestException("The clip's video is not available to cut out");
    }
    return {
      clip,
      path: entry.path,
      assetId: entry.assetId ?? (clip.sourceKey.startsWith('library-asset:') ? entry.id : null),
    };
  }

  private sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.settledAt !== null && now - job.settledAt > KEEP_MS) {
        this.jobs.delete(id);
      }
    }
  }
}

const mainSubject = (): StudioCutoutSubject => ({ kind: 'subject', personId: null, name: null });

const toDto = (job: Job): StudioCutoutDto => ({
  id: job.id,
  projectId: job.projectId,
  clipId: job.clipId,
  subject: job.subject,
  status: job.status,
  progress: job.progress,
  error: job.error,
  matte: job.matte,
});

const readableFailure = (error: unknown) => {
  if (error instanceof BadRequestException || error instanceof CutoutWorkerError) {
    return (error as Error).message;
  }
  if (error instanceof CutoutDeadlineError) {
    return 'Following the subject took too long. Try a shorter clip, or a computer at home with a GPU.';
  }
  if (error instanceof CutoutUnavailableError) {
    return 'The machine learning that cuts out subjects is not set up on this server or computer';
  }
  return 'The subject could not be followed through the clip; try again';
};

/** The mattes side by side, row after row, as one grayscale PNG. A missing frame stays empty (transparent). */
export const composeAtlas = async (
  plan: Pick<CutoutPlan, 'columns' | 'rows' | 'matteWidth' | 'matteHeight'>,
  mattes: ReadonlyArray<Buffer | undefined>,
): Promise<Buffer> => {
  const tiles = await Promise.all(
    mattes.map(async (png, index) =>
      png
        ? {
            input: await sharp(png, { failOn: 'error', limitInputPixels: 1024 * 1024 })
              .resize(plan.matteWidth, plan.matteHeight, { fit: 'fill' })
              .toColourspace('b-w')
              .png()
              .toBuffer(),
            ...atlasCell(plan, index),
          }
        : null,
    ),
  );
  const composed = await sharp({
    create: {
      width: plan.columns * plan.matteWidth,
      height: plan.rows * plan.matteHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(tiles.filter((tile) => tile !== null))
    .png()
    .toBuffer();
  return sharp(composed).extractChannel(0).toColourspace('b-w').png({ compressionLevel: 9 }).toBuffer();
};
