import { BadRequestException, ConflictException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  AssetType,
  MediaOperationKind,
  MediaOperationStatus,
  MlProcessingSource,
  MlWorkload,
  Permission,
} from 'src/enum.js';
import { MusicUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioMovieService, studioMovieStep } from 'src/services/studio-movie.service.js';
import { requireAccess } from 'src/utils/access.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { StudioMovieAsset } from 'src/utils/studio-movie.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
}));
vi.mock('src/utils/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/access.js')>()),
  requireAccess: vi.fn(),
}));

const operationId = '0195e2a0-0000-7000-8000-000000000012';
const previousId = '0195e2a0-0000-7000-8000-000000000016';
const claimToken = '0195e2a0-0000-7000-8000-000000000013';
const projectId = '0195e2a0-0000-7000-8000-000000000010';
const albumId = '0195e2a0-0000-4000-8000-000000000020';
const songId = '0195e2a0-0000-4000-8000-000000000021';
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000014' } };
const local = '0195e2a0-0000-4000-8000-000000000031';
const lan = '0195e2a0-0000-4000-8000-000000000032';
const cloud = '0195e2a0-0000-4000-8000-000000000033';

const assetIds = Array.from(
  { length: 12 },
  (_, index) => `0195e2a0-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
);
const assets: StudioMovieAsset[] = assetIds.map((id, index) => ({
  id,
  type: index % 4 === 3 ? 'VIDEO' : 'IMAGE',
  fileName: `item-${index}.jpg`,
  takenAt: `2026-07-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`,
  isFavorite: index === 2,
  rating: null,
  durationSeconds: index % 4 === 3 ? 30 : null,
  bestScore: 0.5,
  bestFrameSeconds: null,
  faceCount: 0,
  embedding: null,
}));

/** Two seconds of clicks at 120 bpm repeated, decoded for the beat finder. */
const clicks = (seconds: number) => {
  const rate = 11_025;
  const samples = new Float32Array(Math.floor(seconds * rate));
  for (let time = 0; time < seconds; time += 0.5) {
    const start = Math.floor(time * rate);
    for (let index = 0; index < 300 && start + index < samples.length; index++) {
      samples[start + index] = Math.exp(-index / 60) * Math.sin(index / 3);
    }
  }
  return samples;
};

const snapshotOf = (overrides: Record<string, unknown> = {}) => ({
  kind: 'studio-movie',
  assetIds,
  sourceName: 'Lake weekend',
  title: '',
  lengthSeconds: 30,
  music: { kind: 'generated', mood: 'calm' },
  version: 1,
  projectId: null,
  kept: null,
  seed: 42,
  ...overrides,
});

const setup = (snapshot: Record<string, unknown> = snapshotOf()) => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    projectId: null,
    claimToken,
    kind: MediaOperationKind.StudioMovie,
    status: MediaOperationStatus.Preparing,
    claimExpiresAt: new Date(Date.now() + 120_000),
    progress: 0,
    error: null,
    result: null,
    snapshot,
  } as unknown as MediaOperation;
  const query = { set: vi.fn(), where: vi.fn(), execute: vi.fn().mockResolvedValue([]) };
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const tx = { updateTable: vi.fn().mockReturnValue(query) };
  // Like the repository: validation begins only from preparing or rendering (FL-682 found it refused from validating).
  let reported: MediaOperationStatus | undefined;
  const operations = {
    claimNext: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((value) => Promise.resolve({ ...value, id: operationId, status: 'queued' })),
    getForWorker: vi.fn().mockResolvedValue(operation),
    getForOwner: vi.fn().mockResolvedValue(operation),
    heartbeat: vi.fn().mockResolvedValue(true),
    reportProgress: vi.fn().mockImplementation((_id, _claim, { status }: { status: MediaOperationStatus }) => {
      reported = status;
      return Promise.resolve(true);
    }),
    beginValidation: vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(reported === MediaOperationStatus.Preparing || reported === MediaOperationStatus.Rendering),
      ),
    fail: vi.fn().mockResolvedValue('failed'),
    acknowledgeCancel: vi.fn().mockResolvedValue(true),
    publishValidated: vi
      .fn()
      .mockImplementation((_id, _claim, publish: Parameters<MediaOperationRepository['publishValidated']>[2]) =>
        publish(tx as never).then((accepted) => (accepted ? 'completed' : 'rejected')),
      ),
  };
  const movies = {
    getAlbumAssetIds: vi.fn().mockResolvedValue(assetIds),
    getMemoryAssetIds: vi.fn().mockResolvedValue(assetIds),
    getMovieAssets: vi.fn().mockResolvedValue(assets),
    getSong: vi.fn().mockResolvedValue({
      id: songId,
      type: AssetType.Audio,
      name: 'Home Again',
      durationSeconds: 214,
      originalPath: '/library/home-again.mp3',
    }),
    listSongs: vi.fn().mockResolvedValue([]),
    probeAudioSeconds: vi.fn().mockResolvedValue(214),
    encodeMusic: vi.fn().mockResolvedValue(undefined),
    decodeForBeats: vi.fn().mockImplementation((_path, seconds) => Promise.resolve(clicks(seconds))),
  };
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    create: vi.fn().mockResolvedValue({ id: projectId }),
    acquireLease: vi.fn().mockResolvedValue({}),
    releaseLease: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue({ id: projectId, revision: 0 }),
    save: vi.fn().mockResolvedValue({ revision: 1 }),
  };
  const imports = { upload: vi.fn().mockResolvedValue({ id: 'import' }) };
  const catalog = {
    getMediaFacts: vi.fn().mockImplementation((_auth, id: string) => {
      const asset = assets.find((item) => item.id === id)!;
      return Promise.resolve(
        asset.type === 'VIDEO'
          ? { width: 1920, height: 1080, fps: 30, durationSeconds: 30, frameCount: 900, hasAudio: true }
          : { width: 4000, height: 3000, fps: 0, durationSeconds: 0, frameCount: null, hasAudio: false },
      );
    }),
  };
  const users = { get: vi.fn().mockResolvedValue(owner.user) };
  const storage = {
    mkdirSync: vi.fn(),
    unlinkDir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1234 }),
  };
  const machineLearning = {
    generateMusic: vi.fn().mockImplementation((_selection, options, _path, _signal, onProgress) => {
      onProgress(50, 100);
      return Promise.resolve({ seconds: options.durationSeconds });
    }),
  };
  const mlDestinations = {
    resolveRoute: vi.fn().mockResolvedValue([
      { source: MlProcessingSource.Local, destinationId: local, desktopPool: false, available: true },
      { source: MlProcessingSource.Desktops, destinationId: lan, desktopPool: false, available: true },
      { source: MlProcessingSource.Cloud, destinationId: cloud, desktopPool: false, available: true },
    ]),
  };
  vi.mocked(selectMlDestination).mockImplementation((_deps, request) =>
    Promise.resolve({
      destinationId: request.destinationId,
      workload: MlWorkload.StudioAi,
      endpoint: { url: 'http://ml' },
    } as never),
  );
  vi.mocked(requireAccess).mockResolvedValue(undefined as never);
  const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const sut = new StudioMovieService(
    logger as never,
    {} as never,
    operations as never,
    movies as never,
    studio as never,
    imports as never,
    catalog as never,
    users as never,
    storage as never,
    machineLearning as never,
    mlDestinations as never,
  );
  return { sut, operation, operations, movies, studio, imports, catalog, machineLearning, mlDestinations, query };
};

const run = async (context: ReturnType<typeof setup>) => {
  await context.sut.run({ operation: context.operation, claimToken });
};

describe(StudioMovieService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('queues a movie of an album the person can read', async () => {
      const { sut, operations, movies } = setup();
      await expect(
        sut.create(owner, { albumId, lengthSeconds: 60, music: 'generated', mood: 'warm', sourceName: 'Lake weekend' }),
      ).resolves.toEqual({ id: operationId, status: 'queued' });
      expect(requireAccess).toHaveBeenCalledWith({}, { auth: owner, permission: Permission.AlbumRead, ids: [albumId] });
      expect(movies.getAlbumAssetIds).toHaveBeenCalledWith(albumId);
      const created = operations.create.mock.calls[0][0];
      expect(created).toMatchObject({
        kind: MediaOperationKind.StudioMovie,
        ownerId: owner.user.id,
        label: 'Lake weekend',
        projectId: null,
        snapshot: {
          kind: 'studio-movie',
          assetIds,
          lengthSeconds: 60,
          music: { kind: 'generated', mood: 'warm' },
          version: 1,
          projectId: null,
          kept: null,
        },
      });
    });

    it('checks every selected item and refuses a source with nothing to use', async () => {
      const { sut, movies } = setup();
      movies.getMovieAssets.mockResolvedValue([]);
      await expect(
        sut.create(owner, { assetIds: assetIds.slice(0, 2), lengthSeconds: 30, music: 'generated', mood: 'calm' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(requireAccess).toHaveBeenCalledWith(
        {},
        { auth: owner, permission: Permission.AssetRead, ids: assetIds.slice(0, 2) },
      );
    });

    it('takes a song only from the person’s own library', async () => {
      const { sut, movies, operations } = setup();
      movies.getSong.mockResolvedValue(undefined);
      await expect(
        sut.create(owner, { albumId, lengthSeconds: 60, music: 'song', songAssetId: songId }),
      ).rejects.toThrow('That song is not in your library');
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('makes another version in the same project and keeps the same music', async () => {
      const context = setup();
      const previous = {
        ...context.operation,
        id: previousId,
        status: MediaOperationStatus.Completed,
        snapshot: snapshotOf({ lengthSeconds: 60, music: { kind: 'generated', mood: 'warm' } }),
        result: {
          projectId,
          revision: 1,
          version: 1,
          title: 'Lake weekend',
          sourceName: 'Lake weekend',
          lengthSeconds: 60,
          bpm: 92,
          bars: [0, 2.6],
          beats: [0, 0.65, 1.3],
          downbeat: 1,
          shots: [],
          music: 'generated',
          mood: 'warm',
          musicName: '',
          musicImportId: '0195e2a0-0000-4000-8000-0000000000aa',
          musicSeconds: 60,
        },
      };
      context.operations.getForOwner.mockResolvedValue(previous);
      await context.sut.create(owner, { albumId, lengthSeconds: 60, music: 'generated', mood: 'warm', previousId });
      const { snapshot, projectId: created } = context.operations.create.mock.calls[0][0];
      expect(created).toBe(projectId);
      expect(snapshot).toMatchObject({
        version: 2,
        projectId,
        kept: { importId: '0195e2a0-0000-4000-8000-0000000000aa', seconds: 60, beats: { bpm: 92, downbeat: 1 } },
      });

      // another mood makes new music
      context.operations.create.mockClear();
      await context.sut.create(owner, { albumId, lengthSeconds: 60, music: 'generated', mood: 'upbeat', previousId });
      expect(context.operations.create.mock.calls[0][0].snapshot.kept).toBeNull();
    });
  });

  describe('run', () => {
    it('makes music on this server first, keeps it with the project and saves the cut', async () => {
      const context = setup();
      await run(context);

      expect(context.mlDestinations.resolveRoute).toHaveBeenCalledWith(MlWorkload.StudioAi);
      expect(context.machineLearning.generateMusic).toHaveBeenCalledOnce();
      expect(vi.mocked(selectMlDestination).mock.calls[0][1]).toMatchObject({
        destinationId: local,
        jobName: 'studio-movie',
      });
      expect(context.machineLearning.generateMusic.mock.calls[0][1]).toMatchObject({ durationSeconds: 30, seed: 42 });
      expect(context.machineLearning.generateMusic.mock.calls[0][1].prompt).toMatch(/piano/);

      expect(context.studio.create).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: owner.user.id }) }),
        {
          name: 'Lake weekend',
          clientId: `studio-movie:${operationId}`,
          requestKey: `studio-movie:${operationId}`,
        },
      );
      const upload = context.imports.upload.mock.calls[0];
      expect(upload[1]).toBe(projectId);
      expect(upload[3]).toMatchObject({ mimetype: 'audio/mp4', originalname: 'Lake weekend music.m4a', size: 1234 });
      expect(upload[3].path).toMatch(/\/studio-imports\/incoming\/[\da-f-]{36}\.upload$/);

      const saved = context.studio.save.mock.calls[0][2];
      expect(saved).toMatchObject({ expectedRevision: 0, clientId: `studio-movie:${operationId}` });
      const graph = saved.envelope.graph;
      const shots = graph.timeline.items.filter((item: { trackId: string }) => item.trackId === 'v2');
      expect(shots.length).toBeGreaterThan(3);
      // after the first, every shot starts on a bar of the 120 bpm music: one grid of two-second bars
      expect(shots[0].from).toBe(0);
      const phase = shots[1].from % 60;
      for (const shot of shots.slice(1)) {
        // within two frames: the tempo found is a hair off the clicks' 120 bpm
        const offset = (((shot.from - phase) % 60) + 60) % 60;
        expect(Math.min(offset, 60 - offset)).toBeLessThanOrEqual(2);
      }
      const music = graph.timeline.items.find((item: { trackId: string }) => item.trackId === 'a2');
      expect(music).toMatchObject({ mediaId: upload[2], audioFadeOut: 2, durationInFrames: 900 });

      expect(context.query.set).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          result: expect.objectContaining({
            projectId,
            version: 1,
            revision: 1,
            lengthSeconds: 30,
            music: 'generated',
            mood: 'calm',
          }),
        }),
      );
      expect(context.studio.releaseLease).toHaveBeenCalledWith(expect.anything(), projectId, {
        clientId: `studio-movie:${operationId}`,
      });
      expect(context.operations.fail).not.toHaveBeenCalled();
    });

    it('passes over a computer that cannot make music and never sends the prompt to Frameleaf Cloud', async () => {
      const context = setup();
      context.machineLearning.generateMusic
        .mockRejectedValueOnce(new MusicUnavailableError('The worker cannot make music (404)'))
        .mockRejectedValueOnce(new MusicUnavailableError('The worker cannot make music (503)'));
      await run(context);
      expect(vi.mocked(selectMlDestination).mock.calls.map((call) => call[1].destinationId)).toEqual([local, lan]);
      expect(context.operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ error: expect.stringMatching(/Choose a song from your library/) }),
        { retry: false },
      );
    });

    it('uses a home computer when this server is not available', async () => {
      const context = setup();
      context.mlDestinations.resolveRoute.mockResolvedValue([
        { source: MlProcessingSource.Local, destinationId: local, desktopPool: false, available: false },
        { source: MlProcessingSource.Desktops, destinationId: lan, desktopPool: false, available: true },
      ]);
      await run(context);
      expect(vi.mocked(selectMlDestination).mock.calls.map((call) => call[1].destinationId)).toEqual([lan]);
      expect(context.operations.fail).not.toHaveBeenCalled();
    });

    it('ends the movie with a song shorter than the chosen length', async () => {
      const context = setup(
        snapshotOf({
          lengthSeconds: 60,
          music: { kind: 'song', assetId: songId, name: 'Home Again', seconds: 42, video: false },
        }),
      );
      context.movies.probeAudioSeconds.mockResolvedValue(42);
      await run(context);
      expect(context.machineLearning.generateMusic).not.toHaveBeenCalled();
      expect(context.movies.encodeMusic).toHaveBeenCalledWith(
        '/library/home-again.mp3',
        expect.any(String),
        42,
        expect.anything(),
      );
      const graph = context.studio.save.mock.calls[0][2].envelope.graph;
      const music = graph.timeline.items.find((item: { trackId: string }) => item.trackId === 'a2');
      expect(music.durationInFrames).toBe(42 * 30);
      expect(music.audioFadeOut).toBeUndefined();
      const lastShot = graph.timeline.items.findLast((item: { trackId: string }) => item.trackId === 'v2');
      expect(lastShot.from + lastShot.durationInFrames).toBe(42 * 30);
    });

    it('fades a longer song out over the last two seconds', async () => {
      const context = setup(
        snapshotOf({ music: { kind: 'song', assetId: songId, name: 'Home Again', seconds: 214, video: false } }),
      );
      await run(context);
      const graph = context.studio.save.mock.calls[0][2].envelope.graph;
      const music = graph.timeline.items.find((item: { trackId: string }) => item.trackId === 'a2');
      expect(music).toMatchObject({ durationInFrames: 900, audioFadeOut: 2, sourceDuration: 214 * 30 });
    });

    it('refuses a video with no sound as the song', async () => {
      const context = setup(
        snapshotOf({ music: { kind: 'song', assetId: songId, name: 'Beach', seconds: 40, video: true } }),
      );
      context.movies.probeAudioSeconds.mockResolvedValue(null);
      await run(context);
      expect(context.operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ error: 'That video has no sound to use as music' }),
        { retry: false },
      );
    });

    it('saves another version as the next revision, so the earlier cut stays in the history', async () => {
      const kept = {
        key: 'generated:calm:30',
        importId: '0195e2a0-0000-4000-8000-0000000000aa',
        seconds: 30,
        beats: { bpm: 120, beats: Array.from({ length: 61 }, (_, index) => index / 2), downbeat: 0 },
        name: '',
      };
      const context = setup(snapshotOf({ version: 2, projectId, kept }));
      context.studio.get.mockResolvedValue({ id: projectId, revision: 3 });
      context.studio.save.mockResolvedValue({ revision: 4 });
      await run(context);
      expect(context.studio.create).not.toHaveBeenCalled();
      expect(context.studio.acquireLease).toHaveBeenCalledWith(expect.anything(), projectId, {
        clientId: `studio-movie:${operationId}`,
      });
      // the same music is reused, not made again
      expect(context.machineLearning.generateMusic).not.toHaveBeenCalled();
      expect(context.imports.upload).not.toHaveBeenCalled();
      expect(context.studio.save.mock.calls[0][2].expectedRevision).toBe(3);
      expect(context.query.set).toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ version: 2, revision: 4 }) }),
      );
    });

    it('asks to close the movie in Studio when the editor holds it', async () => {
      const context = setup(snapshotOf({ version: 2, projectId }));
      context.studio.acquireLease.mockRejectedValue(new ConflictException('lease-held'));
      await run(context);
      expect(context.studio.save).not.toHaveBeenCalled();
      expect(context.operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ error: 'Close this movie in Studio, then try another version' }),
        { retry: false },
      );
    });

    it('stops when the job is cancelled from Activity', async () => {
      const context = setup();
      context.operations.getForWorker.mockResolvedValue({
        ...context.operation,
        status: MediaOperationStatus.Cancelling,
      });
      await run(context);
      expect(context.operations.acknowledgeCancel).toHaveBeenCalled();
      expect(context.studio.save).not.toHaveBeenCalled();
    });
  });

  it('reports its step from its progress', () => {
    expect(studioMovieStep(MediaOperationStatus.Preparing, 0)).toBe('moments');
    expect(studioMovieStep(MediaOperationStatus.Rendering, 40)).toBe('music');
    expect(studioMovieStep(MediaOperationStatus.Rendering, 85)).toBe('cuts');
    expect(studioMovieStep(MediaOperationStatus.Validating, 96)).toBe('title');
    expect(studioMovieStep(MediaOperationStatus.Completed, 100)).toBe('done');
  });
});
