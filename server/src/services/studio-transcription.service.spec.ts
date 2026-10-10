import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { TranscriptionUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioTranscriptionService } from 'src/services/studio-transcription.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { rational } from 'src/utils/rational-time.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
}));

const projectId = '0195e2a0-0000-7000-8000-000000000010';
const assetId = '0195e2a0-0000-7000-8000-000000000011';
const operationId = '0195e2a0-0000-7000-8000-000000000012';
const claimToken = '0195e2a0-0000-7000-8000-000000000013';
const destinationId = '0195e2a0-0000-4000-8000-000000000015';
const sourceKey = `library-asset:${assetId}`;
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000014' } };
const graph = {
  metadata: { fps: 30 },
  timeline: {
    items: [
      { id: 'clip', type: 'video', mediaId: assetId, from: 60, durationInFrames: 300, sourceStart: 90, sourceFps: 30 },
    ],
  },
};
const snapshot = {
  kind: 'studio-transcription',
  projectId,
  revision: 4,
  digest: 'revision-digest',
  clipId: 'clip',
  sourceKey,
  language: 'en-GB',
  whisperLanguage: 'en',
  destinationId,
};

const setup = (kind = MlDestinationKind.Local) => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    projectId,
    claimToken,
    kind: MediaOperationKind.StudioTranscription,
    status: MediaOperationStatus.Preparing,
    claimExpiresAt: new Date(Date.now() + 120_000),
    totalUnits: 10_000,
    progress: 0,
    error: null,
    result: null,
    snapshot,
  } as unknown as MediaOperation;
  const query = { set: vi.fn(), where: vi.fn(), execute: vi.fn().mockResolvedValue([]) };
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const tx = { updateTable: vi.fn().mockReturnValue(query) };
  const operations = {
    claimNext: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockImplementation((value) => Promise.resolve({ ...value, id: operationId, status: 'queued' })),
    getForWorker: vi.fn().mockResolvedValue(operation),
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
  };
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    authorizeRevision: vi.fn().mockResolvedValue({
      project: { ownerId: owner.user.id, archivedAt: null },
      revision: { id: 'revision-id', revision: 4, digest: 'revision-digest' },
      envelope: { graph },
    }),
  };
  const manifest = {
    complete: true,
    entries: [
      { key: sourceKey, kind: StudioResourceKind.LibraryAsset, id: assetId, path: '/source.mov', grant: 'render' },
    ],
  };
  const resources = { resolveProjectResources: vi.fn().mockResolvedValue({ manifest }) };
  const users = { get: vi.fn().mockResolvedValue(owner.user) };
  const media = { probe: vi.fn().mockResolvedValue({ audioStreams: [{ index: 1 }], videoStreams: [] }) };
  const storage = { mkdirSync: vi.fn(), unlinkDir: vi.fn().mockResolvedValue(undefined) };
  const audio = { extractAudio: vi.fn().mockResolvedValue(undefined) };
  const segments = [
    { type: 'segment', start: 0, end: 1.5, text: 'Hello there.', words: [{ start: 0, end: 0.5, text: ' Hello' }] },
    { type: 'segment', start: 5, end: 6, text: 'Bye.', words: [] },
  ];
  const machineLearning = {
    transcribe: vi.fn().mockImplementation((_selection, _path, _options, _signal, onSegment) => {
      for (const segment of segments) onSegment(segment);
      return Promise.resolve({
        info: { type: 'info', model: 'whisper-small', language: 'en', languageProbability: 0.5, duration: 10 },
        segments,
      });
    }),
  };
  const mlDestinations = { getById: vi.fn().mockResolvedValue({ id: destinationId, kind }) };
  const selection = {
    destinationId,
    kind,
    workload: MlWorkload.StudioAi,
    endpoint: { url: 'http://ml:3003' },
    record: vi.fn(),
  };
  vi.mocked(selectMlDestination).mockResolvedValue(selection as never);
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const sut = new StudioTranscriptionService(
    logger as never,
    operations as never,
    projects as never,
    studio as never,
    resources as never,
    users as never,
    media as never,
    storage as never,
    audio as never,
    machineLearning as never,
    mlDestinations as never,
  );
  return {
    sut,
    operation,
    operations,
    studio,
    resources,
    media,
    storage,
    audio,
    machineLearning,
    mlDestinations,
    query,
  };
};

describe(StudioTranscriptionService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));
  beforeEach(() => vi.mocked(selectMlDestination).mockReset());

  describe('create', () => {
    it('queues the head revision clip on the named destination', async () => {
      const { sut, operations, studio, resources } = setup();
      await expect(sut.create(owner, projectId, { clipId: 'clip', language: 'en-GB', destinationId })).resolves.toEqual(
        { id: operationId, status: 'queued' },
      );
      expect(studio.authorizeRevision).toHaveBeenCalledWith(owner, {
        projectId,
        revision: undefined,
        destination: StudioDestination.Local,
      });
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({ destination: StudioDestination.Local, backgroundRunner: false }),
      );
      expect(selectMlDestination).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ workload: MlWorkload.StudioAi, destinationId, studioFeature: 'captions' }),
      );
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.StudioTranscription,
          destination: MediaOperationDestination.Local,
          destinationDetail: destinationId,
          projectId,
          assetId,
          totalUnits: 10_000,
          snapshot,
        }),
      );
    });

    it('resolves sources for the home network when the destination is a LAN worker', async () => {
      const { sut, operations, resources } = setup(MlDestinationKind.Lan);
      await sut.create(owner, projectId, { clipId: 'clip', language: 'auto', destinationId });
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({ destination: StudioDestination.Lan }),
      );
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: MediaOperationDestination.Lan,
          snapshot: expect.objectContaining({ language: 'auto', whisperLanguage: null }),
        }),
      );
    });

    it('never sends a clip to Frameleaf Cloud', async () => {
      const { sut, operations } = setup(MlDestinationKind.FrameleafCloud);
      await expect(sut.create(owner, projectId, { clipId: 'clip', language: 'en', destinationId })).rejects.toThrow(
        BadRequestException,
      );
      expect(selectMlDestination).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses a clip whose source the manifest does not admit', async () => {
      const { sut, resources, operations } = setup();
      resources.resolveProjectResources.mockResolvedValue({ manifest: { complete: false, entries: [] } });
      await expect(sut.create(owner, projectId, { clipId: 'clip', language: 'en', destinationId })).rejects.toThrow(
        "The clip's source is not available to transcribe",
      );
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses a bad language before admitting anything', async () => {
      const { sut } = setup();
      await expect(
        sut.create(owner, projectId, { clipId: 'clip', language: 'klingon', destinationId }),
      ).rejects.toThrow(BadRequestException);
      expect(selectMlDestination).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('extracts the window, transcribes on the destination, records the cues and deletes the audio', async () => {
      const { sut, operation, operations, audio, machineLearning, storage, query } = setup();
      await sut.run({ operation, claimToken });

      expect(audio.extractAudio).toHaveBeenCalledWith(
        '/source.mov',
        expect.stringMatching(/studio-transcription\/.+\/audio\.wav$/),
        expect.objectContaining({ startSeconds: '3.000000', durationSeconds: '10.000000' }),
        expect.any(AbortSignal),
      );
      expect(machineLearning.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ destinationId }),
        expect.stringMatching(/audio\.wav$/),
        { language: 'en' },
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(operations.beginValidation).toHaveBeenCalledWith(operationId, claimToken);
      expect(query.set).toHaveBeenCalledWith({
        result: {
          language: 'en',
          languageProbability: 1,
          model: 'whisper-small',
          cues: [
            { start: rational(2), end: rational(7, 2), text: 'Hello there.' },
            { start: rational(7), end: rational(8), text: 'Bye.' },
          ],
          words: [{ start: rational(2), end: rational(5, 2), text: 'Hello', cue: 0 }],
        },
        processedUnits: 10_000,
      });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(operationId), {
        recursive: true,
        force: true,
      });
    });

    it('fails without a retry when the worker cannot transcribe', async () => {
      const { sut, operation, operations, machineLearning } = setup();
      machineLearning.transcribe.mockRejectedValue(
        new TranscriptionUnavailableError('The worker cannot transcribe (503)'),
      );
      await sut.run({ operation, claimToken });
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        { errorCode: 'studio_transcription_unavailable', error: 'The worker cannot transcribe (503)' },
        { retry: false },
      );
    });

    it('fails a clip without sound', async () => {
      const { sut, operation, operations, media, machineLearning } = setup();
      media.probe.mockResolvedValue({ audioStreams: [], videoStreams: [{}] });
      await sut.run({ operation, claimToken });
      expect(machineLearning.transcribe).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ error: 'The clip has no sound to transcribe' }),
        { retry: false },
      );
    });

    it('refuses a revision whose graph changed since submit', async () => {
      const { sut, operation, operations, studio, audio } = setup();
      studio.authorizeRevision.mockResolvedValue({
        project: { archivedAt: null },
        revision: { id: 'revision-id', revision: 4, digest: 'other' },
        envelope: { graph },
      });
      await sut.run({ operation, claimToken });
      expect(audio.extractAudio).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalled();
    });

    it('acknowledges a cancel instead of failing', async () => {
      const { sut, operation, operations, machineLearning } = setup();
      machineLearning.transcribe.mockImplementation(() => {
        operations.getForWorker.mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelling });
        return Promise.reject(new Error('aborted'));
      });
      await sut.run({ operation, claimToken });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('answers the result once the job completed', async () => {
      const { sut, operation, operations } = setup();
      const result = { language: 'en', languageProbability: 1, model: 'whisper-small', cues: [], words: [] };
      operations.getForOwner.mockResolvedValue({
        ...operation,
        status: MediaOperationStatus.Completed,
        progress: 100,
        result,
      });
      await expect(sut.get(owner, projectId, operationId)).resolves.toEqual({
        id: operationId,
        projectId,
        clipId: 'clip',
        revision: 4,
        language: 'en-GB',
        destinationId,
        status: MediaOperationStatus.Completed,
        progress: 100,
        error: null,
        result,
      });
    });

    it('answers no result while the job runs', async () => {
      const { sut } = setup();
      await expect(sut.get(owner, projectId, operationId)).resolves.toMatchObject({
        result: null,
        status: 'preparing',
      });
    });

    it('does not find another kind of job or another project', async () => {
      const { sut, operation, operations } = setup();
      await expect(sut.get(owner, '0195e2a0-0000-7000-8000-0000000000ff', operationId)).rejects.toThrow(
        NotFoundException,
      );
      operations.getForOwner.mockResolvedValue({ ...operation, kind: MediaOperationKind.StudioExport });
      await expect(sut.get(owner, projectId, operationId)).rejects.toThrow(NotFoundException);
    });
  });
});
