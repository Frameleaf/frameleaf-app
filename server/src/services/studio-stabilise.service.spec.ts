import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { STABILISE_SNAPSHOT_KIND, StudioStabiliseService } from 'src/services/studio-stabilise.service.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';

/** A base64 float32 little-endian path as numbers. */
const floats = (base64: string): number[] => {
  const bytes = Buffer.from(base64, 'base64');
  return Array.from({ length: bytes.length / 4 }, (_, index) => bytes.readFloatLE(index * 4));
};

const projectId = '0195e2a0-0000-7000-8000-000000000020';
const assetId = '0195e2a0-0000-7000-8000-000000000021';
const operationId = '0195e2a0-0000-7000-8000-000000000022';
const claimToken = '0195e2a0-0000-7000-8000-000000000023';
const sourceKey = `library-asset:${assetId}`;
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000024' } };
const graph = {
  metadata: { fps: 30 },
  timeline: {
    items: [
      { id: 'clip', type: 'video', mediaId: assetId, from: 0, durationInFrames: 90, sourceStart: 90, sourceFps: 30 },
      { id: 'voice', type: 'audio', mediaId: assetId, from: 0, durationInFrames: 90 },
    ],
  },
};
const snapshot = {
  kind: STABILISE_SNAPSHOT_KIND,
  projectId,
  revision: 4,
  digest: 'revision-digest',
  clipId: 'clip',
  sourceKey,
};

/** A grey picture with a soft pattern shifted `shift` pixels right, so analysis has texture. */
const picture = (shift: number) => {
  const frame = new Uint8Array(160 * 90);
  for (let y = 0; y < 90; y++) {
    for (let x = 0; x < 160; x++) {
      const u = x - shift;
      frame[y * 160 + x] = Math.round(128 + 60 * Math.sin(u / 5) * Math.cos(y / 7) + 40 * Math.sin((u + y) / 11));
    }
  }
  return frame;
};

const setup = () => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    projectId,
    claimToken,
    kind: MediaOperationKind.StudioTranscription,
    status: MediaOperationStatus.Preparing,
    claimExpiresAt: new Date(Date.now() + 120_000),
    totalUnits: 7000,
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
  const media = {
    probe: vi.fn().mockResolvedValue({
      audioStreams: [],
      videoStreams: [{ index: 0, width: 1920, height: 1080, rotation: 0, frameRate: 59.94 }],
    }),
  };
  const frames = {
    readGreyFrames: vi.fn().mockImplementation((_path, _options, _signal, onFrame: (frame: Uint8Array) => void) => {
      for (const shift of [0, 2, 4, 3]) {
        onFrame(picture(shift));
      }
      return Promise.resolve(4);
    }),
  };
  const logger = { setContext: vi.fn(), warn: vi.fn() };
  const sut = new StudioStabiliseService(
    logger as never,
    operations as never,
    projects as never,
    studio as never,
    resources as never,
    users as never,
    media as never,
    frames as never,
  );
  return { sut, operation, operations, studio, resources, media, frames, query };
};

describe(StudioStabiliseService.name, () => {
  describe('in Activity', () => {
    it('names the job Stabilise through studioWork, while its kind stays studio_transcription', () => {
      const { operation } = setup();
      const dto = mapOperation(operation);
      expect(dto.kind).toBe(MediaOperationKind.StudioTranscription);
      expect(dto.studioWork).toBe('stabilise');
      expect(mapOperation({ ...operation, snapshot: { ...snapshot, kind: 'studio-voice-cleanup' } }).studioWork).toBe(
        'voice-cleanup',
      );
      expect(
        mapOperation({ ...operation, snapshot: { ...snapshot, kind: 'studio-transcription' } }).studioWork,
      ).toBeNull();
      expect(mapOperation({ ...operation, kind: MediaOperationKind.StudioExport }).studioWork).toBeNull();
    });
  });

  describe('create', () => {
    it('queues the head revision clip on this server, as a Studio clip job Activity shows', async () => {
      const { sut, operations, studio, resources } = setup();
      await expect(sut.create(owner, projectId, { clipId: 'clip' })).resolves.toEqual({
        id: operationId,
        status: 'queued',
      });
      expect(studio.authorizeRevision).toHaveBeenCalledWith(owner, {
        projectId,
        revision: undefined,
        destination: StudioDestination.Local,
      });
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({ destination: StudioDestination.Local, backgroundRunner: false }),
      );
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.StudioTranscription,
          destination: MediaOperationDestination.Local,
          destinationDetail: null,
          label: 'Stabilise',
          settings: { task: 'stabilise' },
          projectId,
          assetId,
          // Three seconds shown, two seconds before (source starts at 3s) and two after.
          totalUnits: 7000,
          snapshot,
        }),
      );
    });

    it('refuses an audio clip, a missing clip, a shared link and a source the owner cannot render', async () => {
      const { sut, resources } = setup();
      await expect(sut.create(owner, projectId, { clipId: 'voice' })).rejects.toThrow('Only a video clip');
      await expect(sut.create(owner, projectId, { clipId: 'gone' })).rejects.toThrow(BadRequestException);
      await expect(sut.create({ ...owner, sharedLink: {} } as never, projectId, { clipId: 'clip' })).rejects.toThrow(
        NotFoundException,
      );
      resources.resolveProjectResources.mockResolvedValue({
        manifest: { complete: false, entries: [{ key: sourceKey, grant: 'none' }] },
      });
      await expect(sut.create(owner, projectId, { clipId: 'clip' })).rejects.toThrow('not available to stabilise');
    });
  });

  describe('get', () => {
    it('answers only for a stabilise job of this project', async () => {
      const { sut, operations, operation } = setup();
      operations.getForOwner.mockResolvedValue({
        ...operation,
        snapshot: { ...snapshot, kind: 'studio-transcription' },
      });
      await expect(sut.get(owner, projectId, operationId)).rejects.toThrow(NotFoundException);
      operations.getForOwner.mockResolvedValue({ ...operation, projectId: '0195e2a0-0000-7000-8000-0000000000ff' });
      await expect(sut.get(owner, projectId, operationId)).rejects.toThrow(NotFoundException);
    });

    it('returns the camera path once the job completed', async () => {
      const { sut, operations, operation } = setup();
      const result = {
        version: 1,
        method: 'block-similarity-v1',
        rate: 30,
        start: 1,
        count: 2,
        width: 160,
        height: 90,
        x: 'AAAAAAAAAAA=',
        y: 'AAAAAAAAAAA=',
        a: 'AAAAAAAAAAA=',
        found: 1,
      };
      operations.getForOwner.mockResolvedValue({ ...operation, status: MediaOperationStatus.Completed, result });
      await expect(sut.get(owner, projectId, operationId)).resolves.toMatchObject({
        clipId: 'clip',
        revision: 4,
        status: MediaOperationStatus.Completed,
        result,
      });
    });
  });

  describe('the worker', () => {
    it('claims only stabilise jobs of the shared kind', async () => {
      const { sut, operations } = setup();
      await sut.drain();
      expect(operations.claimNext).toHaveBeenCalledWith(
        expect.objectContaining({
          kinds: [MediaOperationKind.StudioTranscription],
          snapshotKinds: ['studio-stabilise'],
        }),
      );
    });

    it('analyses the window at up to 30 frames a second and records the camera path', async () => {
      const { sut, operation, operations, frames, query, resources } = setup();
      await sut.run({ operation, claimToken });
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ revision: 4, backgroundRunner: true, destination: StudioDestination.Local }),
      );
      expect(frames.readGreyFrames).toHaveBeenCalledWith(
        '/source.mov',
        { startSeconds: 1, durationSeconds: 7, rate: 30, width: 160, height: 90 },
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(operations.fail).not.toHaveBeenCalled();
      const result = query.set.mock.calls[0][0].result;
      expect(result).toMatchObject({ version: 1, rate: 30, start: 1, count: 4, width: 160, height: 90, found: 1 });
      const x = floats(result.x);
      expect(x.map((value) => Math.round(value * 160 * 10) / 10)).toEqual([0, 2, 4, 3]);
    });

    it('analyses a turned phone video the way it plays', async () => {
      const { sut, operation, media, frames } = setup();
      media.probe.mockResolvedValue({
        audioStreams: [],
        videoStreams: [{ index: 0, width: 1920, height: 1080, rotation: 90, frameRate: 24 }],
      });
      frames.readGreyFrames.mockResolvedValue(0);
      await sut.run({ operation, claimToken });
      expect(frames.readGreyFrames).toHaveBeenCalledWith(
        '/source.mov',
        expect.objectContaining({ rate: 24, width: 160, height: 284 }),
        expect.anything(),
        expect.anything(),
      );
    });

    it('fails without retry when the clip changed or has no picture, and with retry when ffmpeg fails', async () => {
      const { sut, operation, operations, media, frames } = setup();
      await sut.run({ operation, claimToken });
      operations.fail.mockClear();

      await sut.run({ operation: { ...operation, snapshot: { ...snapshot, digest: 'other' } }, claimToken });
      expect(operations.fail).toHaveBeenLastCalledWith(
        operationId,
        claimToken,
        { errorCode: 'studio_stabilise_failed', error: 'The project revision or its clip changed' },
        { retry: false },
      );

      media.probe.mockResolvedValueOnce({ audioStreams: [], videoStreams: [] });
      await sut.run({ operation, claimToken });
      expect(operations.fail).toHaveBeenLastCalledWith(
        operationId,
        claimToken,
        expect.objectContaining({ error: 'The clip has no picture to stabilise' }),
        { retry: false },
      );

      frames.readGreyFrames.mockRejectedValueOnce(new Error('ffmpeg could not read the video'));
      await sut.run({ operation, claimToken });
      expect(operations.fail).toHaveBeenLastCalledWith(
        operationId,
        claimToken,
        { errorCode: 'studio_stabilise_failed', error: 'The camera movement could not be analysed' },
        { retry: true },
      );
    });

    it('acknowledges a cancel instead of failing', async () => {
      const { sut, operation, operations, frames } = setup();
      frames.readGreyFrames.mockRejectedValueOnce(new Error('aborted'));
      operations.getForWorker
        .mockResolvedValueOnce(operation)
        .mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelling });
      await sut.run({ operation, claimToken });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });
  });
});
