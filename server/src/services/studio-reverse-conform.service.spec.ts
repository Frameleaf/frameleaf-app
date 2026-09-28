import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioReverseConformService } from 'src/services/studio-reverse-conform.service.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { reversePackets, reverseVideoInfo } from 'test/fixtures/studio-reverse-conform.stub.js';
import { getMocks } from 'test/utils.js';

const projectId = '0195e2a0-0000-7000-8000-000000000010';
const sourceId = '0195e2a0-0000-7000-8000-000000000011';
const operationId = '0195e2a0-0000-7000-8000-000000000012';
const claimToken = '0195e2a0-0000-7000-8000-000000000013';
const checksum = Buffer.from('ab'.repeat(32), 'hex').toString('base64');
const sourceKey = `library-asset:${sourceId}`;
const owner = authStub.user1;

const setup = () => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    projectId,
    claimToken,
    kind: MediaOperationKind.StudioReverseConform,
    destination: MediaOperationDestination.Local,
    status: MediaOperationStatus.Preparing,
    claimExpiresAt: new Date(Date.now() + 120_000),
    snapshot: { kind: 'studio-source-reverse', projectId, revision: 1, digest: 'revision-digest', sourceKey, checksum },
  } as MediaOperation;
  const operations = {
    create: vi.fn().mockResolvedValue(operation),
    getForWorker: vi.fn().mockResolvedValue(operation),
    heartbeat: vi.fn().mockResolvedValue(true),
    reportProgress: vi.fn().mockResolvedValue(true),
    beginValidation: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('failed'),
    acknowledgeCancel: vi.fn().mockResolvedValue(true),
    publishValidated: vi.fn(),
  };
  const query = {
    select: vi.fn(),
    where: vi.fn(),
    forShare: vi.fn(),
    set: vi.fn(),
    executeTakeFirst: vi.fn().mockResolvedValue({ id: operationId }),
    execute: vi.fn().mockResolvedValue([]),
  };
  for (const method of [query.select, query.where, query.forShare, query.set]) {
    method.mockReturnValue(query);
  }
  const tx = { selectFrom: vi.fn().mockReturnValue(query), updateTable: vi.fn().mockReturnValue(query) };
  operations.publishValidated.mockImplementation(
    (_id, _claim, publish: Parameters<MediaOperationRepository['publishValidated']>[2]) =>
      publish(tx as never).then((accepted) => (accepted ? 'completed' : 'rejected')),
  );
  const projects = {
    listGeneratedResources: vi.fn().mockResolvedValue([]),
    registerGeneratedResource: vi.fn().mockResolvedValue(undefined),
  };
  const studio = {
    authorizeRevision: vi.fn().mockResolvedValue({
      project: { ownerId: owner.user.id },
      revision: { id: 'revision-id', digest: 'revision-digest' },
      envelope: { graph: { assetId: sourceId } },
    }),
    forgetResolutions: vi.fn(),
  };
  const manifest = {
    complete: true,
    entries: [
      {
        key: sourceKey,
        kind: StudioResourceKind.LibraryAsset,
        id: sourceId,
        ownerId: owner.user.id,
        checksum,
        path: '/source.mkv',
        sourceAccess: 'owner',
      },
    ],
  };
  const resources = { resolveProjectResources: vi.fn().mockResolvedValue({ manifest }) };
  const users = { get: vi.fn().mockResolvedValue(owner.user) };
  const media = {
    probe: vi.fn().mockImplementation(() => Promise.resolve(reverseVideoInfo())),
    probePackets: vi.fn().mockResolvedValue(reversePackets()),
  };
  const renderer = {
    probeGeometry: vi.fn().mockResolvedValue({ width: 32, height: 32, sampleAspectRatio: '1:1' }),
    reverse: vi.fn().mockResolvedValue(undefined),
  };
  const storage = {
    stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 1000 }),
    mkdirSync: vi.fn(),
    unlinkDir: vi.fn().mockResolvedValue(undefined),
  };
  const crypto = {
    hashFileMatching: vi.fn().mockResolvedValue(Buffer.from(checksum, 'base64')),
    hashFile: vi.fn().mockResolvedValue(Buffer.from('cd'.repeat(32), 'hex')),
  };
  const sut = new StudioReverseConformService(
    getMocks().logger as never,
    operations as never,
    projects as never,
    studio as never,
    resources as never,
    users as never,
    media as never,
    renderer as never,
    storage as never,
    crypto as never,
  );
  return { sut, operation, operations, projects, studio, resources, media, renderer, storage, tx, manifest };
};

describe(StudioReverseConformService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));
  afterEach(() => vi.useRealTimers());

  it.each([StudioDestination.Lan, StudioDestination.FrameleafCloud])(
    'refuses %s before creating work',
    async (destination) => {
      const { sut, operations } = setup();
      await expect(sut.enqueueSource(owner, { projectId, revision: 1, sourceKey, destination })).rejects.toThrow(
        'only on this server',
      );
      expect(operations.create).not.toHaveBeenCalled();
    },
  );

  it('requires the complete manifest at submit', async () => {
    const { sut, operations, resources } = setup();
    resources.resolveProjectResources.mockResolvedValue({ manifest: { complete: false, entries: [] } });
    await expect(
      sut.enqueueSource(owner, { projectId, revision: 1, sourceKey, destination: StudioDestination.Local }),
    ).rejects.toThrow('complete source manifest');
    expect(operations.create).not.toHaveBeenCalled();
  });

  it('enqueues only a checked source with an explicit source-level contract', async () => {
    const { sut, operations } = setup();
    await sut.enqueueSource(owner, { projectId, revision: 1, sourceKey, destination: StudioDestination.Local });
    expect(operations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: MediaOperationKind.StudioReverseConform,
        destination: MediaOperationDestination.Local,
        settings: { sourceLevel: true, requiresClipRelink: true },
        totalUnits: 3,
        snapshot: expect.objectContaining({ checksum, sourceKey, revision: 1, digest: 'revision-digest' }),
      }),
    );
  });

  it('refuses coded dimensions hidden by display geometry before enqueuing work', async () => {
    const { sut, operations, renderer } = setup();
    renderer.probeGeometry.mockResolvedValue({ width: 1920, height: 32, sampleAspectRatio: '1:60' });
    await expect(
      sut.enqueueSource(owner, { projectId, revision: 1, sourceKey, destination: StudioDestination.Local }),
    ).rejects.toThrow('square-pixel');
    expect(operations.create).not.toHaveBeenCalled();
    expect(renderer.reverse).not.toHaveBeenCalled();
  });

  it('checks claim and publication access and registers the checked file inside the completion transaction', async () => {
    const { sut, operation, projects, operations, resources, storage, tx } = setup();
    await sut.run({ operation, claimToken });
    expect(resources.resolveProjectResources).toHaveBeenCalledTimes(2);
    expect(projects.registerGeneratedResource).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        ownerId: owner.user.id,
        sourceRevision: 1,
        id: `reverse-${operationId}`,
        producer: 'reverse-conform',
        checksum: 'cd'.repeat(32),
        derivedFrom: [sourceKey],
        path: expect.stringContaining(`/${operationId}/${claimToken}/source-reversed.mkv`),
      }),
      tx,
    );
    expect(operations.publishValidated).toHaveBeenCalledWith(operationId, claimToken, expect.any(Function));
    expect(operations.fail).not.toHaveBeenCalled();
    expect(storage.unlinkDir).not.toHaveBeenCalled();
  });

  it('refuses a lapsed claim before opening its source or starting ffmpeg', async () => {
    const { sut, operation, operations, renderer, resources, projects } = setup();
    operations.getForWorker.mockResolvedValue({ ...operation, claimExpiresAt: new Date(0) });
    await sut.run({ operation, claimToken });
    expect(renderer.reverse).not.toHaveBeenCalled();
    expect(resources.resolveProjectResources).not.toHaveBeenCalled();
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
  });

  it('does not register when the publication claim has been lost', async () => {
    const { sut, operation, operations, projects, storage } = setup();
    operations.publishValidated.mockResolvedValue('lost');
    await sut.run({ operation, claimToken });
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
    expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(claimToken), {
      recursive: true,
      force: true,
    });
  });

  it('refuses revoked sources at claim without running ffmpeg', async () => {
    const { sut, operation, resources, renderer, projects } = setup();
    resources.resolveProjectResources.mockResolvedValue({ manifest: { complete: false, entries: [] } });
    await sut.run({ operation, claimToken });
    expect(renderer.reverse).not.toHaveBeenCalled();
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
  });

  it('discards a checked render if source access is revoked before publication', async () => {
    const { sut, operation, resources, manifest, projects, storage } = setup();
    resources.resolveProjectResources
      .mockResolvedValueOnce({ manifest })
      .mockResolvedValueOnce({ manifest: { complete: false, entries: [] } });
    await sut.run({ operation, claimToken });
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
    expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(claimToken), {
      recursive: true,
      force: true,
    });
  });

  it('does not register an incomplete output', async () => {
    const { sut, operation, media, projects } = setup();
    const partial = reverseVideoInfo();
    partial.videoStreams[0].frameCount = 2;
    media.probe.mockResolvedValueOnce(reverseVideoInfo()).mockResolvedValueOnce(partial);
    await sut.run({ operation, claimToken });
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
  });

  it('kills a cancelled render, acknowledges cancellation, and removes only its claim directory', async () => {
    vi.useFakeTimers();
    const { sut, operation, operations, renderer, projects, storage } = setup();
    const { promise: rendering, resolve: started } = Promise.withResolvers<void>();
    renderer.reverse.mockImplementation(
      (_input, _output, _source, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          started();
        }),
    );
    const run = sut.run({ operation, claimToken });
    await rendering;
    operations.getForWorker.mockResolvedValue({ ...operation, status: MediaOperationStatus.Cancelling });
    await vi.advanceTimersByTimeAsync(5000);
    await run;
    expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operationId, claimToken, { released: true });
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
    expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(claimToken), {
      recursive: true,
      force: true,
    });
  });

  it('preserves a completed output when a trashed project hides its declarations after a lost acknowledgement', async () => {
    const { sut, operation, operations, storage } = setup();
    operations.publishValidated.mockImplementation(() => {
      operations.getForWorker.mockResolvedValue({
        ...operation,
        status: MediaOperationStatus.Completed,
        claimToken: null,
      });
      return Promise.reject(new Error('commit acknowledged too late'));
    });
    await sut.run({ operation, claimToken });
    expect(storage.unlinkDir).not.toHaveBeenCalled();
  });

  it('preserves a registered file after a lost commit acknowledgement', async () => {
    const { sut, operation, operations, projects, storage } = setup();
    operations.publishValidated.mockRejectedValue(new Error('connection lost after commit'));
    projects.listGeneratedResources
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { path: `/data/exports/${owner.user.id}/studio-generated/${operationId}/${claimToken}/source-reversed.mkv` },
      ]);
    await sut.run({ operation, claimToken });
    expect(storage.unlinkDir).not.toHaveBeenCalled();
  });
});
