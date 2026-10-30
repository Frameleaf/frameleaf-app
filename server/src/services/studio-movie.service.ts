import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioMovieCreateDto,
  StudioMovieDto,
  StudioMovieQueuedDto,
  StudioMovieResult,
  StudioMovieResultSchema,
  StudioMovieSongDto,
} from 'src/dtos/studio-movie.dto.js';
import {
  AssetType,
  FrameleafWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlProcessingSource,
  MlWorkload,
  Permission,
  StorageFolder,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, MusicUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioMovieRepository } from 'src/repositories/studio-movie.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioCatalogService } from 'src/services/studio-catalog.service.js';
import {
  StudioProjectImportService,
  studioImportIncomingFolder,
  studioImportStagePath,
} from 'src/services/studio-project-import.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { requireAccess } from 'src/utils/access.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { STUDIO_ENGINE_REVISION } from 'src/utils/studio-commands.generated.js';
import {
  STUDIO_MOVIE_BEAT_SAMPLE_RATE,
  STUDIO_MOVIE_FADE_SECONDS,
  STUDIO_MOVIE_MOOD_STYLES,
  StudioMovieAsset,
  StudioMovieBeats,
  StudioMovieGraphShot,
  StudioMovieMood,
  StudioMovieShot,
  buildStudioMovieGraph,
  findStudioMovieBeats,
  planStudioMovieCuts,
  rankStudioMovieMoments,
  studioMovieBars,
  studioMovieLength,
  studioMovieSeed,
} from 'src/utils/studio-movie.js';
import { STUDIO_ENGINE, STUDIO_ENVELOPE_SCHEMA_VERSION } from 'src/utils/studio-project.js';
import { isStudioUuid } from 'src/utils/studio-resources.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
/** A song is kept with the project up to this long; longer soundtracks are cut. */
const MAX_SONG_SECONDS = 600;
/** Progress through the job: moments, music, cuts, title. */
const PROGRESS = { moments: 0, music: 5, cuts: 80, title: 95 } as const;

type MusicChoice =
  | { kind: 'generated'; mood: StudioMovieMood }
  | { kind: 'song'; assetId: string; name: string; seconds: number; video: boolean };

/** Music an earlier version made, reused when the next version asks for the same music. */
type KeptMusic = { key: string; importId: string; seconds: number; beats: StudioMovieBeats; name: string };

type MovieSnapshot = {
  kind: 'studio-movie';
  assetIds: string[];
  sourceName: string;
  title: string;
  lengthSeconds: number;
  music: MusicChoice;
  version: number;
  /** The project the earlier version is saved in; null for a first version. */
  projectId: string | null;
  kept: KeptMusic | null;
  seed: number;
};
type Job = { operation: MediaOperation; claimToken: string };

/** The step a job is on, from its progress (see `PROGRESS`). */
export const studioMovieStep = (status: MediaOperationStatus, progress: number): StudioMovieDto['step'] => {
  if (status === MediaOperationStatus.Completed) {
    return 'done';
  }
  if (progress >= PROGRESS.title) {
    return 'title';
  }
  if (progress >= PROGRESS.cuts) {
    return 'cuts';
  }
  return progress >= PROGRESS.music ? 'music' : 'moments';
};

const musicKey = (music: MusicChoice, lengthSeconds: number) =>
  music.kind === 'generated' ? `generated:${music.mood}:${lengthSeconds}` : `song:${music.assetId}`;

/**
 * Make a movie (FL-561, approved mock 2026-10-26).
 *
 * Submit checks the source (an album, a memory or a selection the person can read), the song (one of
 * their own audio files or videos) and an earlier version to replace, and queues a durable job that
 * Activity follows. A worker on this server claims it and:
 *
 * 1. ranks the source's moments from what the server already knows (Best Photos scores and best video
 *    frames, favourites, ratings, faces, smart search embeddings);
 * 2. makes the music: new music from MusicGen small on the first place in the processing order ("Where
 *    work runs") that can make it, or the song's sound; keeps it with the project as an audio import,
 *    and finds its beat on the decoded audio;
 * 3. cuts the best moments on the bars, in the order they were taken;
 * 4. adds the title and saves an ordinary Studio project. "Try another version" saves the new cut as
 *    the next revision of the same project, so the earlier cut stays in its history.
 *
 * Nothing reaches the library: the movie is a Studio project until the person exports it.
 */
@Injectable()
export class StudioMovieService {
  private readonly workerId = `studio-movie-${randomUUID()}`;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private logger: LoggingRepository,
    private access: AccessRepository,
    private operations: MediaOperationRepository,
    private movies: StudioMovieRepository,
    private studio: StudioProjectService,
    private imports: StudioProjectImportService,
    private catalog: StudioCatalogService,
    private users: UserRepository,
    private storage: StorageRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
  ) {
    this.logger.setContext(StudioMovieService.name);
  }

  async create(auth: AuthDto, dto: StudioMovieCreateDto): Promise<StudioMovieQueuedDto> {
    if (auth.sharedLink) {
      throw new NotFoundException('Not found');
    }
    const assetIds = await this.sourceIds(auth, dto);
    const usable = await this.movies.getMovieAssets(assetIds, auth.user.id);
    if (usable.length === 0) {
      throw new BadRequestException('There are no photos or videos here to make a movie from');
    }

    let music: MusicChoice;
    if (dto.music === 'song') {
      const song = await this.movies.getSong(auth.user.id, dto.songAssetId!);
      if (!song || song.durationSeconds <= 0) {
        throw new BadRequestException('That song is not in your library');
      }
      music = {
        kind: 'song',
        assetId: song.id,
        name: song.name,
        seconds: song.durationSeconds,
        video: song.type === AssetType.Video,
      };
    } else {
      music = { kind: 'generated', mood: dto.mood! };
    }

    let version = 1;
    let projectId: string | null = null;
    let kept: KeptMusic | null = null;
    if (dto.previousId) {
      const previous = await this.operations.getForOwner(dto.previousId, auth.user.id);
      const result =
        previous?.kind === MediaOperationKind.StudioMovie && previous.status === MediaOperationStatus.Completed
          ? StudioMovieResultSchema.safeParse(previous.result)
          : undefined;
      if (!result?.success) {
        throw new BadRequestException('That movie is not ready, so another version cannot be made from it');
      }
      await this.studio.requireOwnedProject(
        auth,
        result.data.projectId,
        'Only the movie’s owner can make another version',
      );
      const snapshot = this.snapshot(previous!);
      version = result.data.version + 1;
      projectId = result.data.projectId;
      if (musicKey(snapshot.music, snapshot.lengthSeconds) === musicKey(music, dto.lengthSeconds)) {
        kept = {
          key: musicKey(music, dto.lengthSeconds),
          importId: result.data.musicImportId,
          seconds: result.data.musicSeconds,
          beats: { bpm: result.data.bpm, beats: result.data.beats, downbeat: result.data.downbeat },
          name: result.data.musicName,
        };
      }
    }

    const sourceName = (dto.sourceName ?? '').trim() || 'Your photos';
    const snapshot: MovieSnapshot = {
      kind: 'studio-movie',
      assetIds: usable.map(({ id }) => id),
      sourceName,
      title: (dto.title ?? '').trim(),
      lengthSeconds: dto.lengthSeconds,
      music,
      version,
      projectId,
      kept,
      seed: studioMovieSeed(`${assetIds.join(',')}:${version}:${randomUUID()}`),
    };
    const operation = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioMovie,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: (dto.title ?? '').trim() || sourceName,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId,
      revisionId: null,
      snapshot,
      settings: { lengthSeconds: dto.lengthSeconds, music: dto.music, mood: dto.mood ?? null },
      estimate: null,
      totalUnits: 100,
      maxAttempts: 2,
    });
    return { id: operation.id, status: operation.status };
  }

  /** The job and, once it completed, the movie. Owner only; anyone else is told it does not exist. */
  async get(auth: AuthDto, id: string): Promise<StudioMovieDto> {
    const operation = auth.sharedLink ? undefined : await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.kind !== MediaOperationKind.StudioMovie) {
      throw new NotFoundException('Movie not found');
    }
    const parsed =
      operation.status === MediaOperationStatus.Completed
        ? StudioMovieResultSchema.safeParse(operation.result)
        : undefined;
    return {
      id: operation.id,
      status: operation.status,
      step: studioMovieStep(operation.status, operation.progress),
      progress: operation.progress,
      error: operation.error ?? null,
      result: parsed?.success ? parsed.data : null,
    };
  }

  /** The person's songs: audio files, then videos long enough to lend their soundtrack. */
  async getSongs(auth: AuthDto, query?: string): Promise<StudioMovieSongDto[]> {
    if (auth.sharedLink) {
      throw new NotFoundException('Not found');
    }
    const songs = await this.movies.listSongs(auth.user.id, { query: query?.trim() || undefined, limit: 50 });
    return songs.map((song) => ({
      id: song.id,
      kind: song.type === AssetType.Video ? 'video' : 'audio',
      name: song.name,
      durationSeconds: song.durationSeconds,
    }));
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
      .catch((error) => this.logger.warn(`Make a movie worker failed: ${error}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioMovie],
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
      'studio-movie',
      operation.id,
      claimToken,
    );
    const controller = new AbortController();
    this.abort = controller;
    if (this.stopping) {
      controller.abort(new Error('Worker stopping'));
    }
    let stage = MediaOperationStatus.Preparing;
    let progress: number = PROGRESS.moments;
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
          processedUnits: Math.floor(progress),
          totalUnits: 100,
          progress,
        }))
      ) {
        controller.abort(new Error('Claim lost or cancelled'));
      }
    };
    const step = async (status: MediaOperationStatus, value: number) => {
      stage = status;
      progress = value;
      await monitor();
      controller.signal.throwIfAborted();
    };
    const heartbeat = setInterval(() => {
      writing ??= monitor()
        .catch(() => controller.abort(new Error('Claim heartbeat failed')))
        .finally(() => {
          writing = undefined;
        });
    }, TICK_MS);
    const clientId = `studio-movie:${operation.id}`;
    let projectId: string | null = null;
    let leased = false;
    let auth: AuthDto | undefined;
    try {
      await step(MediaOperationStatus.Preparing, PROGRESS.moments);
      const snapshot = this.snapshot(operation);
      auth = await this.owner(operation.ownerId);

      // 1. The best moments.
      const assets = await this.movies.getMovieAssets(snapshot.assetIds, operation.ownerId);
      if (assets.length === 0) {
        throw new BadRequestException('The photos and videos of this movie are no longer available');
      }
      const ranked = rankStudioMovieMoments(assets, snapshot.seed);

      // The project first: the music is kept with it.
      const name = snapshot.title || snapshot.sourceName;
      if (snapshot.projectId) {
        projectId = snapshot.projectId;
        await this.studio.acquireLease(auth, projectId, { clientId }).catch((error: unknown) => {
          throw error instanceof ConflictException
            ? new BadRequestException('Close this movie in Studio, then try another version')
            : error;
        });
      } else {
        const project = await this.studio.create(auth, { name, clientId, requestKey: clientId });
        projectId = project.id;
        // A retried attempt finds its project again; take its lease back.
        await this.studio.acquireLease(auth, projectId, { clientId });
      }
      leased = true;

      // 2. The music and its beat.
      await step(MediaOperationStatus.Rendering, PROGRESS.music);
      this.storage.mkdirSync(folder);
      const music = await this.music(operation, auth, projectId, snapshot, folder, controller.signal, (value) => {
        progress = value;
      });

      // 3. The cuts.
      await step(MediaOperationStatus.Rendering, PROGRESS.cuts);
      const { length, fadeOutSeconds } =
        snapshot.music.kind === 'generated'
          ? { length: snapshot.lengthSeconds, fadeOutSeconds: STUDIO_MOVIE_FADE_SECONDS }
          : studioMovieLength(snapshot.lengthSeconds, music.seconds);
      const bars = studioMovieBars(music.beats, length);
      const mood = snapshot.music.kind === 'generated' ? snapshot.music.mood : null;
      const shots = await this.placeShots(auth, ranked, assets, { bars, length, mood, bpm: music.beats.bpm });
      if (shots.length === 0) {
        throw new BadRequestException('None of these photos or videos can be placed in a movie');
      }

      // 4. The title, and the project. Still rendering: validation begins only once the project is saved.
      await step(MediaOperationStatus.Rendering, PROGRESS.title);
      const graph = buildStudioMovieGraph({
        name,
        title: snapshot.title || snapshot.sourceName,
        shots,
        music: { importId: music.importId, fileName: music.fileName, durationSeconds: music.seconds },
        length,
        fadeOutSeconds,
        transition: mood ? STUDIO_MOVIE_MOOD_STYLES[mood].transition : 'Cross dissolve',
        bars,
        seed: `${operation.id}:${snapshot.version}`,
        now: Date.now(),
      });
      const head = await this.studio.get(auth, projectId, clientId);
      const saved = await this.studio.save(auth, projectId, {
        envelope: {
          schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
          engine: STUDIO_ENGINE,
          engineRevision: STUDIO_ENGINE_REVISION,
          graph,
        },
        expectedRevision: head.revision,
        requestKey: clientId,
        clientId,
      });
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();

      const result: StudioMovieResult = StudioMovieResultSchema.parse({
        projectId,
        revision: saved.revision,
        version: snapshot.version,
        title: snapshot.title || snapshot.sourceName,
        sourceName: snapshot.sourceName,
        lengthSeconds: length,
        bpm: music.beats.bpm,
        bars: [...bars],
        beats: music.beats.beats.filter((beat) => beat <= length),
        downbeat: music.beats.downbeat,
        shots: shots.map((shot) => ({ assetId: shot.moment.asset.id, start: shot.start, end: shot.end })),
        music: snapshot.music.kind,
        mood,
        musicName: snapshot.music.kind === 'song' ? snapshot.music.name : '',
        musicImportId: music.importId,
        musicSeconds: music.seconds,
      });
      if (!(await this.operations.beginValidation(operation.id, claimToken))) {
        throw new Error('Claim lost');
      }
      const outcome = await this.operations.publishValidated(operation.id, claimToken, async (tx) => {
        await tx
          .updateTable('media_operation')
          .set({ result, projectId, processedUnits: 100 })
          .where('id', '=', operation.id)
          .execute();
        return true;
      });
      if (outcome !== 'completed') {
        throw new Error('Claim lost before the movie was recorded');
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
            errorCode: refused ? 'studio_movie_refused' : 'studio_movie_failed',
            error: refused ? (error as Error).message : 'The movie could not be made',
          },
          { retry: !refused },
        );
        if (!refused) {
          this.logger.warn(`Make a movie ${operation.id} failed: ${error}`);
        }
      }
    } finally {
      clearInterval(heartbeat);
      await writing;
      if (this.abort === controller) {
        this.abort = undefined;
      }
      if (leased && auth && projectId) {
        await this.studio.releaseLease(auth, projectId, { clientId }).catch(() => {});
      }
      await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The music of the movie, kept with the project as an audio import, and its beat. Music an earlier
   * version made is reused when the person asked for the same music again.
   */
  private async music(
    operation: MediaOperation,
    auth: AuthDto,
    projectId: string,
    snapshot: MovieSnapshot,
    folder: string,
    signal: AbortSignal,
    onProgress: (progress: number) => void,
  ): Promise<{ importId: string; fileName: string; seconds: number; beats: StudioMovieBeats }> {
    const fileName =
      snapshot.music.kind === 'song'
        ? `${snapshot.music.name}.m4a`
        : `${snapshot.title || snapshot.sourceName} music.m4a`;
    if (snapshot.kept && snapshot.kept.key === musicKey(snapshot.music, snapshot.lengthSeconds)) {
      return { importId: snapshot.kept.importId, fileName, seconds: snapshot.kept.seconds, beats: snapshot.kept.beats };
    }

    let source: string;
    let seconds: number;
    if (snapshot.music.kind === 'generated') {
      const style = STUDIO_MOVIE_MOOD_STYLES[snapshot.music.mood];
      source = join(folder, 'music.wav');
      const made = await this.generate(
        operation.id,
        { prompt: style.prompt, durationSeconds: snapshot.lengthSeconds, seed: snapshot.seed },
        source,
        signal,
        (done, total) => onProgress(PROGRESS.music + ((PROGRESS.cuts - PROGRESS.music - 5) * done) / total),
      );
      seconds = made.seconds;
    } else {
      const song = await this.movies.getSong(operation.ownerId, snapshot.music.assetId);
      if (!song) {
        throw new BadRequestException('That song is no longer in your library');
      }
      source = song.originalPath;
      const found = await this.movies.probeAudioSeconds(source, signal);
      if (!found) {
        throw new BadRequestException(
          snapshot.music.video ? 'That video has no sound to use as music' : 'That song cannot be read',
        );
      }
      seconds = Math.min(found, MAX_SONG_SECONDS);
    }

    // Kept with the project as an audio import, like music someone adds in Studio.
    const incoming = studioImportStagePath(operation.ownerId);
    this.storage.mkdirSync(studioImportIncomingFolder(operation.ownerId));
    await this.movies.encodeMusic(source, incoming, seconds, signal);
    const { size } = await this.storage.stat(incoming);
    const importId = randomUUID();
    await this.imports.upload(auth, projectId, importId, {
      path: incoming,
      size,
      mimetype: 'audio/mp4',
      originalname: fileName,
    } as Express.Multer.File);
    onProgress(PROGRESS.cuts - 4);

    // The beat, found on the decoded audio of the part the movie can use.
    const decoded = await this.movies.decodeForBeats(source, Math.min(seconds, snapshot.lengthSeconds + 10), signal);
    const fallback = snapshot.music.kind === 'generated' ? STUDIO_MOVIE_MOOD_STYLES[snapshot.music.mood].bpm : 90;
    const beats = findStudioMovieBeats(decoded, STUDIO_MOVIE_BEAT_SAMPLE_RATE, fallback);
    return { importId, fileName, seconds: Math.round(seconds * 1000) / 1000, beats };
  }

  /**
   * New music on the first place in the processing order that can make it ("Where work runs": this
   * server, then the person's computers, then Frameleaf Cloud). A place that cannot make music (an
   * older worker, no model) is passed over for the next. Frameleaf Cloud has no music workload yet
   * (FL-181), so it is never sent the prompt.
   */
  private async generate(
    jobId: string,
    options: { prompt: string; durationSeconds: number; seed: number },
    wavPath: string,
    signal: AbortSignal,
    onProgress: (done: number, total: number) => void,
  ): Promise<{ seconds: number }> {
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
      let selection;
      try {
        selection = await selectMlDestination(
          { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
          {
            workload: MlWorkload.StudioAi,
            destinationId: candidate.destinationId,
            jobId,
            jobName: 'studio-movie',
            desktopPool: 'skip',
          },
        );
      } catch (error) {
        this.logger.warn(`Make a movie ${jobId}: ${candidate.destinationId} cannot take music now: ${error}`);
        continue;
      }
      try {
        return await this.machineLearning.generateMusic(selection, options, wavPath, signal, onProgress);
      } catch (error) {
        if (error instanceof MusicUnavailableError) {
          this.logger.warn(`Make a movie ${jobId}: ${candidate.destinationId} cannot make music: ${error.message}`);
          continue;
        }
        throw error;
      }
    }
    throw new BadRequestException(
      cloudOnly
        ? 'Music for movies is made on this server or a computer at home, and none is available now. Choose a song from your library instead.'
        : 'No computer that can make music is available now. Choose a song from your library instead.',
    );
  }

  /**
   * The shots, cut on the bars, with what placing each needs. A moment whose original cannot be read
   * is dropped and the cut is made again without it.
   */
  private async placeShots(
    auth: AuthDto,
    ranked: ReturnType<typeof rankStudioMovieMoments>,
    assets: StudioMovieAsset[],
    plan: { bars: number[]; length: number; mood: StudioMovieMood | null; bpm: number },
  ): Promise<StudioMovieGraphShot[]> {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const unusable = new Set<string>();
    const facts = new Map<string, StudioMovieGraphShot['media'] | null>();
    for (let attempt = 0; attempt < 4; attempt++) {
      const moments = ranked.filter((moment) => !unusable.has(moment.asset.id));
      const shots: StudioMovieShot[] = planStudioMovieCuts({ moments, ...plan });
      const placed: StudioMovieGraphShot[] = [];
      for (const shot of shots) {
        const id = shot.moment.asset.id;
        if (!facts.has(id)) {
          facts.set(id, await this.mediaOf(auth, byId.get(id)!));
        }
        const media = facts.get(id);
        if (!media || (shot.moment.kind === 'video' && media.durationSeconds < shot.end - shot.start)) {
          unusable.add(id);
          continue;
        }
        placed.push({ ...shot, media });
      }
      if (placed.length === shots.length) {
        return placed;
      }
    }
    return [];
  }

  private async mediaOf(auth: AuthDto, asset: StudioMovieAsset): Promise<StudioMovieGraphShot['media'] | null> {
    try {
      const facts = await this.catalog.getMediaFacts(auth, asset.id);
      if (!facts.width || !facts.height) {
        return null;
      }
      if (asset.type === 'VIDEO' && (!facts.fps || !facts.durationSeconds)) {
        return null;
      }
      return {
        fileName: asset.fileName,
        width: facts.width,
        height: facts.height,
        fps: facts.fps,
        durationSeconds: facts.durationSeconds ?? 0,
        frameCount: facts.frameCount ?? null,
        hasAudio: facts.hasAudio === true,
      };
    } catch (error) {
      this.logger.warn(`Make a movie: ${asset.id} cannot be placed: ${error}`);
      return null;
    }
  }

  /** The source's photos and videos, checked against what the person may read. */
  private async sourceIds(auth: AuthDto, dto: StudioMovieCreateDto): Promise<string[]> {
    if (dto.albumId) {
      await requireAccess(this.access, { auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
      return this.movies.getAlbumAssetIds(dto.albumId);
    }
    if (dto.memoryId) {
      await requireAccess(this.access, { auth, permission: Permission.MemoryRead, ids: [dto.memoryId] });
      return this.movies.getMemoryAssetIds(dto.memoryId);
    }
    const ids = [...new Set(dto.assetIds)];
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids });
    return ids;
  }

  private snapshot(operation: MediaOperation): MovieSnapshot {
    const snapshot = operation.snapshot as Partial<MovieSnapshot> | null;
    if (
      operation.kind !== MediaOperationKind.StudioMovie ||
      snapshot?.kind !== 'studio-movie' ||
      !Array.isArray(snapshot.assetIds) ||
      typeof snapshot.sourceName !== 'string' ||
      typeof snapshot.title !== 'string' ||
      typeof snapshot.lengthSeconds !== 'number' ||
      !snapshot.music ||
      !Number.isSafeInteger(snapshot.version) ||
      !Number.isSafeInteger(snapshot.seed)
    ) {
      throw new BadRequestException('Invalid movie snapshot');
    }
    return snapshot as MovieSnapshot;
  }

  private async owner(ownerId: string): Promise<AuthDto> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      throw new BadRequestException('The movie’s owner is unavailable');
    }
    // The owner's submitted background job, like a Studio export, not a viewer grant.
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.workerId, hasElevatedPermission: false },
    };
  }
}
