import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlProcessingSource,
  MlWorkload,
} from 'src/enum.js';
import { VoiceCleanupUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioVoiceCleanupService, VOICE_CLEANUP_SNAPSHOT_KIND } from 'src/services/studio-voice-cleanup.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
}));

const projectId = '0195e2a0-0000-7000-8000-000000000020';
const assetId = '0195e2a0-0000-7000-8000-000000000021';
const operationId = '0195e2a0-0000-7000-8000-000000000022';
const claimToken = '0195e2a0-0000-7000-8000-000000000023';
const importId = '0195e2a0-0000-4000-8000-000000000025';
const local = '0195e2a0-0000-4000-8000-000000000026';
const desktop = '0195e2a0-0000-4000-8000-000000000027';
const cloud = '0195e2a0-0000-4000-8000-000000000028';
const sourceKey = `library-asset:${assetId}`;
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000024' } };
// A two-second window (frames 60 to 120 at 30 fps) of the clip's source.
const clip = {
  id: 'voice',
  type: 'audio',
  label: 'Beach walk',
  mediaId: assetId,
  from: 0,
  durationInFrames: 60,
  sourceStart: 60,
  sourceEnd: 120,
  sourceFps: 30,
};
const graph = { metadata: { fps: 30 }, timeline: { items: [clip] } };
const snapshot = {
  kind: VOICE_CLEANUP_SNAPSHOT_KIND,
  projectId,
  revision: 4,
  digest: 'revision-digest',
  clipId: 'voice',
  mediaId: assetId,
  strength: 'standard',
  noises: ['wind', 'background'],
  humHz: null,
};
const kept = {
  id: importId,
  kind: 'audio',
  contentType: 'audio/mp4',
  fileName: 'Beach walk (cleaned voice).m4a',
  sizeBytes: 1234,
  checksum: 'a'.repeat(64),
  externalReferences: null,
  createdAt: '2026-10-29T00:00:00.000Z',
};

const setup = (options: { graph?: unknown; route?: Array<Record<string, unknown>> } = {}) => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    projectId,
    claimToken,
    kind: MediaOperationKind.StudioTranscription,
    status: MediaOperationStatus.Preparing,
    claimExpiresAt: new Date(Date.now() + 120_000),
    totalUnits: 4000,
    progress: 0,
    error: null,
    result: null,
    snapshot,
  } as unknown as MediaOperation;
  const query = {
    set: vi.fn(),
    where: vi.fn(),
    execute: vi.fn().mockResolvedValue([]),
    executeTakeFirst: vi.fn().mockResolvedValue({ numUpdatedRows: 1n }),
  };
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const tx = { updateTable: vi.fn().mockReturnValue(query) };
  const operations = {
    claimNext: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((value) => Promise.resolve({ ...value, id: operationId, status: 'queued' })),
    getForWorker: vi.fn().mockResolvedValue(operation),
    listUnfinishedForProjects: vi.fn().mockResolvedValue([]),
    getForOwner: vi.fn().mockResolvedValue(operation),
    heartbeat: vi.fn().mockResolvedValue(true),
    reportProgress: vi.fn().mockResolvedValue(true),
    beginValidation: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('failed'),
    acknowledgeCancel: vi.fn().mockResolvedValue(true),
    publishValidated: vi
      .fn()
      .mockImplementation((_id, _claim, publish: Parameters<MediaOperationRepository['publishValidated']>[2]) =>
        publish(tx as never).then((accepted) => (accepted ? 'completed' : 'rejected')),
      ),
  };
  const projects = {
    listGeneratedResources: vi.fn().mockResolvedValue([]),
    listImportDeclarations: vi.fn().mockResolvedValue([]),
    getImport: vi.fn().mockResolvedValue(undefined),
  };
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    authorizeRevision: vi.fn().mockResolvedValue({
      project: { ownerId: owner.user.id, archivedAt: null },
      revision: { id: 'revision-id', revision: 4, digest: 'revision-digest' },
      envelope: { graph: options.graph ?? graph },
    }),
  };
  const manifest = {
    complete: true,
    entries: [
      { key: sourceKey, kind: StudioResourceKind.LibraryAsset, id: assetId, path: '/source.mov', grant: 'render' },
    ],
  };
  const resources = { resolveProjectResources: vi.fn().mockResolvedValue({ manifest }) };
  const imports = { upload: vi.fn().mockResolvedValue(kept) };
  const publications = {
    discover: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    cancel: vi.fn().mockResolvedValue({ status: 'cancelled' }),
    release: vi.fn().mockResolvedValue(undefined),
  };
  const users = { get: vi.fn().mockResolvedValue(owner.user) };
  const media = { probe: vi.fn().mockResolvedValue({ audioStreams: [{ index: 1 }], videoStreams: [] }) };
  const storage = {
    mkdirSync: vi.fn(),
    unlinkDir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 1234 }),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
  const audio = { extractAudio: vi.fn().mockResolvedValue(undefined) };
  const movies = { encodeMusic: vi.fn().mockResolvedValue(undefined) };
  const machineLearning = {
    analyzeVoice: vi.fn().mockResolvedValue({ noises: ['background', 'hum'], humHz: 60 }),
    cleanVoice: vi.fn().mockImplementation((_selection, _wav, _options, _out, _signal, onProgress) => {
      onProgress(50, 100);
      return Promise.resolve({ seconds: 4 });
    }),
  };
  const route = options.route ?? [
    { destinationId: local, source: MlProcessingSource.Local, available: true },
    { destinationId: desktop, source: MlProcessingSource.Desktops, available: true },
  ];
  const mlDestinations = { resolveRoute: vi.fn().mockResolvedValue(route) };
  const select = (_deps: unknown, input: { destinationId: string }) => {
    return Promise.resolve({
      destinationId: input.destinationId,
      kind: MlDestinationKind.Local,
      workload: MlWorkload.StudioAi,
      endpoint: { url: `http://${input.destinationId}:3003` },
      record: vi.fn(),
    } as never);
  };
  vi.mocked(selectMlDestination).mockImplementation(select as never);
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const sut = new StudioVoiceCleanupService(
    logger as never,
    operations as never,
    projects as never,
    studio as never,
    resources as never,
    imports as never,
    publications as never,
    users as never,
    media as never,
    storage as never,
    audio as never,
    movies as never,
    machineLearning as never,
    mlDestinations as never,
  );
  return {
    sut,
    operation,
    operations,
    projects,
    resources,
    imports,
    publications,
    storage,
    audio,
    movies,
    machineLearning,
    query,
  };
};

describe(StudioVoiceCleanupService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));
  beforeEach(() => {
    vi.mocked(selectMlDestination).mockReset();
  });

  describe('analyze', () => {
    it('reads up to a minute of the clip at 48 kHz and keeps nothing', async () => {
      const { sut, audio, machineLearning, storage } = setup();
      await expect(sut.analyze(owner, projectId, 'voice')).resolves.toEqual({
        clipId: 'voice',
        noises: ['hum', 'background'],
        humHz: 60,
      });
      expect(audio.extractAudio).toHaveBeenCalledWith(
        '/source.mov',
        expect.stringMatching(/studio-voice-cleanup\/analysis-.+\/audio\.wav$/),
        { startSeconds: '2.000000', durationSeconds: '2.000000' },
        expect.any(AbortSignal),
        48_000,
      );
      expect(machineLearning.analyzeVoice).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: local }),
        expect.any(String),
        expect.any(AbortSignal),
      );
      expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining('/analysis-'), expect.anything());
    });

    it('passes over a place that cannot clean up voices for the next in the processing order', async () => {
      const { sut, machineLearning } = setup();
      machineLearning.analyzeVoice
        .mockRejectedValueOnce(new VoiceCleanupUnavailableError('no route'))
        .mockResolvedValueOnce({ noises: ['wind'], humHz: null });
      await expect(sut.analyze(owner, projectId, 'voice')).resolves.toEqual({
        clipId: 'voice',
        noises: ['wind'],
        humHz: null,
      });
      expect(machineLearning.analyzeVoice).toHaveBeenLastCalledWith(
        expect.objectContaining({ destinationId: desktop }),
        expect.any(String),
        expect.any(AbortSignal),
      );
    });

    it('never sends the sound to Frameleaf Cloud', async () => {
      const { sut, machineLearning } = setup({
        route: [{ destinationId: cloud, source: MlProcessingSource.Cloud, available: true }],
      });
      await expect(sut.analyze(owner, projectId, 'voice')).rejects.toThrow(
        'Voices are cleaned up on this server or a computer at home, and none is available now',
      );
      expect(machineLearning.analyzeVoice).not.toHaveBeenCalled();
    });

    it('refuses a shared link and a clip without sound', async () => {
      const { sut } = setup({
        graph: { metadata: { fps: 30 }, timeline: { items: [{ ...clip, type: 'text' }] } },
      });
      await expect(sut.analyze({ ...owner, sharedLink: {} } as never, projectId, 'voice')).rejects.toThrow(
        NotFoundException,
      );
      await expect(sut.analyze(owner, projectId, 'voice')).rejects.toThrow('Only a clip with sound can be cleaned up');
    });
  });

  describe('create', () => {
    it('answers a request for a clean-up already queued or running with that job', async () => {
      const { sut, operation, operations } = setup();
      const running = '0195e2a0-0000-7000-8000-000000000040';
      operations.listUnfinishedForProjects.mockResolvedValue([{ id: running }]);
      operations.getForWorker.mockResolvedValue({ ...operation, id: running, status: MediaOperationStatus.Rendering });
      await expect(
        sut.create(owner, projectId, { clipId: 'voice', strength: 'standard', noises: ['background', 'wind'] }),
      ).resolves.toEqual({ id: running, status: MediaOperationStatus.Rendering });
      expect(operations.listUnfinishedForProjects).toHaveBeenCalledWith(
        [projectId],
        [MediaOperationKind.StudioTranscription],
        owner.user.id,
      );
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('queues a Studio AI clip job told apart by its snapshot, without a new kind', async () => {
      const { sut, operations } = setup();
      await expect(
        sut.create(owner, projectId, { clipId: 'voice', strength: 'standard', noises: ['background', 'wind', 'wind'] }),
      ).resolves.toEqual({ id: operationId, status: 'queued' });
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.StudioTranscription,
          destination: MediaOperationDestination.Local,
          label: 'Clean up voice',
          assetId,
          projectId,
          snapshot,
          settings: { task: 'voice-cleanup', strength: 'standard', noises: ['wind', 'background'] },
          // The two-second window and a second of handle on each side.
          totalUnits: 4000,
        }),
      );
    });

    it('cleans a clip cleaned before from its original', async () => {
      const cleaned = {
        ...clip,
        mediaId: importId,
        sourceStart: 30,
        sourceEnd: 90,
        voiceCleanup: { strength: 'light', original: { mediaId: assetId, sourceStart: 60, sourceEnd: 120 } },
      };
      const { sut, operations } = setup({ graph: { metadata: { fps: 30 }, timeline: { items: [cleaned] } } });
      await sut.create(owner, projectId, { clipId: 'voice', strength: 'strong', noises: ['echo'] });
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ mediaId: assetId, strength: 'strong' }) }),
      );
    });

    it('refuses nothing to remove, a reversed clip and a clip longer than ten minutes', async () => {
      await expect(
        setup().sut.create(owner, projectId, { clipId: 'voice', strength: 'light', noises: [] }),
      ).rejects.toThrow('Choose what to remove from the sound');
      const reversed = setup({
        graph: { metadata: { fps: 30 }, timeline: { items: [{ ...clip, isReversed: true }] } },
      });
      await expect(
        reversed.sut.create(owner, projectId, { clipId: 'voice', strength: 'light', noises: ['wind'] }),
      ).rejects.toThrow('A reversed clip cannot be cleaned up');
      const long = setup({
        graph: { metadata: { fps: 30 }, timeline: { items: [{ ...clip, sourceEnd: 60 + 30 * 601 }] } },
      });
      await expect(
        long.sut.create(owner, projectId, { clipId: 'voice', strength: 'light', noises: ['wind'] }),
      ).rejects.toThrow('A clip longer than 10 minutes cannot be cleaned up');
    });
  });

  describe('get', () => {
    it('answers only voice clean-ups of this project', async () => {
      const { sut, operations, operation } = setup();
      operations.getForOwner.mockResolvedValueOnce({ ...operation, snapshot: { kind: 'studio-transcription' } });
      await expect(sut.get(owner, projectId, operationId)).rejects.toThrow(NotFoundException);
      operations.getForOwner.mockResolvedValueOnce({ ...operation, projectId: 'other' });
      await expect(sut.get(owner, projectId, operationId)).rejects.toThrow(NotFoundException);
      await expect(sut.get(owner, projectId, operationId)).resolves.toEqual(
        expect.objectContaining({ id: operationId, clipId: 'voice', revision: 4, result: null }),
      );
    });
  });

  describe('run', () => {
    it('cleans the window, keeps it with the project as an audio import and records the result', async () => {
      const { sut, operation, audio, machineLearning, movies, imports, query, storage } = setup();
      await sut.run({ operation, claimToken });
      expect(audio.extractAudio).toHaveBeenCalledWith(
        '/source.mov',
        expect.stringMatching(new RegExp(String.raw`studio-voice-cleanup/${operationId}/${claimToken}/audio\.wav$`)),
        expect.objectContaining({ startSeconds: '1.000000', durationSeconds: '4.000000' }),
        expect.any(AbortSignal),
        48_000,
      );
      expect(machineLearning.cleanVoice).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId: local }),
        expect.stringMatching(/audio\.wav$/),
        { strength: 'standard', noises: ['wind', 'background'], humHz: null },
        expect.stringMatching(/cleaned\.wav$/),
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(movies.encodeMusic).toHaveBeenCalledWith(
        expect.stringMatching(/cleaned\.wav$/),
        expect.stringMatching(/\/studio-imports\/incoming\/[\da-f-]{36}\.upload$/),
        5,
        expect.any(AbortSignal),
      );
      expect(imports.upload).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: owner.user.id }) }),
        projectId,
        expect.any(String),
        expect.objectContaining({
          path: expect.stringMatching(/\/studio-imports\/incoming\/[\da-f-]{36}\.upload$/),
          mimetype: 'audio/mp4',
          originalname: 'Beach walk (cleaned voice).m4a',
        }),
      );
      expect(query.set).toHaveBeenCalledWith({
        result: {
          import: kept,
          strength: 'standard',
          noises: ['wind', 'background'],
          humHz: null,
          sourceStartSeconds: 1,
          durationSeconds: 4,
        },
        processedUnits: 4000,
      });
      expect(storage.unlinkDir).toHaveBeenCalledWith(
        expect.stringContaining(`studio-voice-cleanup/${operationId}/${claimToken}`),
        expect.anything(),
      );
    });

    it('names the same import on every attempt of the same clip and settings, and another for other settings', async () => {
      const first = setup();
      await first.sut.run({ operation: first.operation, claimToken });
      const second = setup();
      await second.sut.run({ operation: second.operation, claimToken });
      const other = setup();
      await other.sut.run({
        operation: { ...other.operation, snapshot: { ...snapshot, strength: 'strong' } } as MediaOperation,
        claimToken,
      });
      const [stable] = first.imports.upload.mock.calls[0].slice(2);
      expect(stable).toMatch(/^[\da-f]{8}-[\da-f]{4}-8[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      expect(second.imports.upload.mock.calls[0][2]).toBe(stable);
      expect(other.imports.upload.mock.calls[0][2]).not.toBe(stable);
    });

    it('a retry after a failure supersedes the unfinished import and keeps one cleaned track', async () => {
      const { sut, operation, imports, publications, query } = setup();
      await sut.run({ operation, claimToken });
      const stable = imports.upload.mock.calls[0][2] as string;
      imports.upload.mockClear();
      const unfinished = '0195e2a0-0000-4000-8000-000000000031';
      const aborted = '0195e2a0-0000-4000-8000-000000000032';
      const unrelated = '0195e2a0-0000-4000-8000-000000000033';
      publications.discover
        .mockResolvedValueOnce({
          items: [
            { publicationId: unfinished, importId: stable, state: 'preparing', cleanupPending: true },
            { publicationId: unrelated, importId, state: 'preparing', cleanupPending: true },
          ],
          nextCursor: 'next',
        })
        .mockResolvedValueOnce({
          items: [{ publicationId: aborted, importId: stable, state: 'aborted', cleanupPending: true }],
          nextCursor: null,
        });

      await sut.run({ operation, claimToken });

      const key = (publicationId: string) => ({ ownerId: owner.user.id, projectId, importId: stable, publicationId });
      expect(publications.discover).toHaveBeenLastCalledWith(expect.anything(), projectId, 'next');
      expect(publications.cancel).toHaveBeenCalledTimes(1);
      expect(publications.cancel).toHaveBeenCalledWith(expect.anything(), key(unfinished));
      expect(publications.release.mock.calls).toEqual([[key(unfinished)], [key(aborted)]]);
      expect(imports.upload).toHaveBeenCalledTimes(1);
      expect(imports.upload).toHaveBeenCalledWith(expect.anything(), projectId, stable, expect.anything());
      expect(query.set).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ import: kept }) }),
      );
    });

    it('a retry after a success reuses the finished import instead of keeping a second one', async () => {
      const { sut, operation, projects, imports, publications, movies, query, operations } = setup();
      projects.getImport.mockResolvedValue({ ...kept, createdAt: new Date(kept.createdAt), ownerId: owner.user.id });
      publications.discover.mockResolvedValue({
        items: [
          {
            publicationId: '0195e2a0-0000-4000-8000-000000000031',
            importId,
            state: 'published',
            cleanupPending: false,
          },
        ],
        nextCursor: null,
      });

      await sut.run({ operation, claimToken });

      expect(projects.getImport).toHaveBeenCalledWith(projectId, expect.any(String));
      expect(publications.cancel).not.toHaveBeenCalled();
      expect(publications.release).not.toHaveBeenCalled();
      expect(movies.encodeMusic).not.toHaveBeenCalled();
      expect(imports.upload).not.toHaveBeenCalled();
      expect(query.set).toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ import: kept }) }),
      );
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('two identical jobs at once keep one track and never cancel the live one', async () => {
      const { sut, operation, operations, projects, imports, publications, query } = setup();
      const live = '0195e2a0-0000-7000-8000-000000000041';
      const liveOperation = {
        ...operation,
        id: live,
        claimToken: '0195e2a0-0000-7000-8000-000000000042',
        claimExpiresAt: new Date(Date.now() + 60_000),
      };
      operations.listUnfinishedForProjects.mockResolvedValue([{ id: live }, { id: operationId }]);
      operations.getForWorker.mockImplementation((id: string) =>
        Promise.resolve(id === live ? liveOperation : operation),
      );
      publications.discover.mockResolvedValue({
        items: [{ publicationId: '0195e2a0-0000-4000-8000-000000000043', importId, state: 'preparing' }],
        nextCursor: null,
      });

      // The live job is publishing: this one keeps nothing, cancels nothing and is retried.
      await sut.run({ operation, claimToken });
      expect(publications.discover).not.toHaveBeenCalled();
      expect(publications.cancel).not.toHaveBeenCalled();
      expect(imports.upload).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'studio_voice_cleanup_failed' }),
        { retry: true },
      );

      // Its retry, after the live job finished, answers with that job's track.
      operations.listUnfinishedForProjects.mockResolvedValue([{ id: operationId }]);
      publications.discover.mockResolvedValue({ items: [], nextCursor: null });
      projects.getImport.mockResolvedValue({ ...kept, createdAt: new Date(kept.createdAt), ownerId: owner.user.id });
      await sut.run({ operation, claimToken });
      expect(imports.upload).not.toHaveBeenCalled();
      expect(query.set).toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ import: kept }) }),
      );
    });

    it('supersedes a twin whose claim has expired', async () => {
      const { sut, operation, operations, imports } = setup();
      const abandoned = '0195e2a0-0000-7000-8000-000000000044';
      operations.listUnfinishedForProjects.mockResolvedValue([{ id: abandoned }]);
      operations.getForWorker.mockImplementation((id: string) =>
        Promise.resolve(
          id === abandoned
            ? { ...operation, id: abandoned, claimToken: 'old', claimExpiresAt: new Date(Date.now() - 1000) }
            : operation,
        ),
      );
      await sut.run({ operation, claimToken });
      expect(imports.upload).toHaveBeenCalledTimes(1);
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('fails without a retry when the clip changed, and keeps nothing', async () => {
      const { sut, operation, operations, imports } = setup({
        graph: { metadata: { fps: 30 }, timeline: { items: [{ ...clip, mediaId: importId }] } },
      });
      await sut.run({ operation, claimToken });
      expect(imports.upload).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'studio_voice_cleanup_unavailable' }),
        { retry: false },
      );
    });

    it('retries a worker failure, and says the original sound is unchanged', async () => {
      const { sut, operation, operations, machineLearning } = setup();
      machineLearning.cleanVoice.mockRejectedValue(new Error('connection reset'));
      await sut.run({ operation, claimToken });
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        {
          errorCode: 'studio_voice_cleanup_failed',
          error: 'The voice clean-up failed; the original sound is unchanged',
        },
        { retry: true },
      );
    });

    it('removes the encoded file when it never reached the import service', async () => {
      const { sut, operation, imports, storage } = setup();
      storage.stat.mockRejectedValue(new Error('disk'));
      await sut.run({ operation, claimToken });
      expect(imports.upload).not.toHaveBeenCalled();
      expect(storage.unlink).toHaveBeenCalledWith(
        expect.stringMatching(/\/studio-imports\/incoming\/[\da-f-]{36}\.upload$/),
      );
    });

    it('validates only an active claim, and publishes nothing once the lease has expired', async () => {
      const { sut, operation, operations, query } = setup();
      query.executeTakeFirst.mockResolvedValue({ numUpdatedRows: 0n });
      await sut.run({ operation, claimToken });
      expect(operations.beginValidation).toHaveBeenCalledWith(operationId, claimToken, true);
      expect(query.where).toHaveBeenCalledWith('claimExpiresAt', '>', expect.anything());
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ errorCode: 'studio_voice_cleanup_failed' }),
        { retry: true },
      );
    });

    it('leaves the encoded file to the import service once the upload started', async () => {
      const { sut, operation, imports, storage } = setup();
      imports.upload.mockRejectedValue(new Error('quota'));
      await sut.run({ operation, claimToken });
      expect(storage.unlink).not.toHaveBeenCalled();
    });

    it('acknowledges a cancel', async () => {
      const { sut, operation, operations, machineLearning } = setup();
      machineLearning.cleanVoice.mockRejectedValue(new BadRequestException('aborted'));
      operations.getForWorker
        .mockResolvedValueOnce(operation)
        .mockResolvedValueOnce(operation)
        .mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelling });
      await sut.run({ operation, claimToken });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('claims only voice clean-ups', async () => {
      const { sut, operations } = setup();
      await sut.drain();
      expect(operations.claimNext).toHaveBeenCalledWith(
        expect.objectContaining({
          kinds: [MediaOperationKind.StudioTranscription],
          snapshotKinds: [VOICE_CLEANUP_SNAPSHOT_KIND],
        }),
      );
    });
  });
});
