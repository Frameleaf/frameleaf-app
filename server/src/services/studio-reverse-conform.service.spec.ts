import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioReverseConformService } from 'src/services/studio-reverse-conform.service.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import {
  reverseClipGraph,
  reversePackets,
  reversePreviewInfo,
  reversePreviewPackets,
  reverseVideoInfo,
} from 'test/fixtures/studio-reverse-conform.stub.js';
import { getMocks } from 'test/utils.js';

const projectId = '0195e2a0-0000-7000-8000-000000000010';
const sourceId = '0195e2a0-0000-7000-8000-000000000011';
const operationId = '0195e2a0-0000-7000-8000-000000000012';
const claimToken = '0195e2a0-0000-7000-8000-000000000013';
const checksum = Buffer.from('ab'.repeat(32), 'hex').toString('base64');
const sourceKey = `library-asset:${sourceId}`;
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000014' } };

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
  } as unknown as MediaOperation;
  const operations = {
    claimNext: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(operation),
    createStudioReverseCommand: vi.fn().mockResolvedValue(operation),
    getForWorker: vi.fn().mockResolvedValue(operation),
    getForOwner: vi.fn().mockResolvedValue(operation),
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
    listImportDeclarations: vi.fn().mockResolvedValue([]),
    registerGeneratedResource: vi.fn().mockResolvedValue(undefined),
  };
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
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
    probe: vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(path.endsWith('.mp4') ? reversePreviewInfo() : reverseVideoInfo()),
      ),
    probePackets: vi.fn().mockResolvedValue(reversePackets()),
  };
  const renderer = {
    probeGeometry: vi.fn().mockResolvedValue({ width: 32, height: 32, sampleAspectRatio: '1:1' }),
    reverse: vi.fn().mockResolvedValue(undefined),
    preview: vi.fn().mockResolvedValue(undefined),
    previewPackets: vi.fn().mockResolvedValue(reversePreviewPackets()),
  };
  const storage = {
    openForRandomRead: vi.fn(),
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

  it('refuses a reviewer before authorizing or resolving reverse sources', async () => {
    const { sut, studio, resources, operations } = setup();
    const reviewer = { ...owner, user: { ...owner.user, id: '0195e2a0-0000-7000-8000-000000000099' } };
    studio.requireOwnedProject.mockRejectedValue(
      new ForbiddenException('Only an active project owner may reverse its sources'),
    );
    await expect(
      sut.enqueueSource(reviewer, { projectId, revision: 1, sourceKey, destination: StudioDestination.Local }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(studio.authorizeRevision).not.toHaveBeenCalled();
    expect(studio.requireOwnedProject).toHaveBeenCalledWith(
      reviewer,
      projectId,
      'Only an active project owner may reverse its sources',
    );
    expect(resources.resolveProjectResources).not.toHaveBeenCalled();
    expect(operations.create).not.toHaveBeenCalled();
  });

  it('stops a claim that completes after shutdown without rendering or publishing it', async () => {
    const { sut, operation, operations, renderer, projects, storage } = setup();
    const claim = Promise.withResolvers<{ operation: MediaOperation; claimToken: string }>();
    operations.claimNext.mockReturnValueOnce(claim.promise);

    sut.tick();
    expect(operations.claimNext).toHaveBeenCalledTimes(1);
    const shutdown = sut.onShutdown();
    claim.resolve({ operation, claimToken });
    await shutdown;

    expect(renderer.reverse).not.toHaveBeenCalled();
    expect(renderer.preview).not.toHaveBeenCalled();
    expect(storage.mkdirSync).not.toHaveBeenCalled();
    expect(operations.publishValidated).not.toHaveBeenCalled();
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
    expect(operations.fail).toHaveBeenCalledWith(operationId, claimToken, {
      errorCode: 'studio_reverse_conform_failed',
      error: 'Local source reversal failed; no result was published',
    });
    sut.tick();
    expect(operations.claimNext).toHaveBeenCalledTimes(1);
  });

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

  it('checks the command clip against probed source facts and persists the binding with the lease-checked insert', async () => {
    const { sut, studio, operations } = setup();
    studio.authorizeRevision.mockResolvedValue({
      project: { ownerId: owner.user.id },
      revision: { id: 'revision-id', digest: 'revision-digest' },
      envelope: { graph: reverseClipGraph(sourceId) },
    });
    const command = { clipId: 'clip-a', clientId: 'tab-a', requestKey: 'command-a' };
    await sut.enqueueSource(owner, {
      projectId,
      revision: 1,
      sourceKey,
      destination: StudioDestination.Local,
      command,
    });
    expect(operations.createStudioReverseCommand).toHaveBeenCalledWith(
      expect.objectContaining({ snapshot: expect.objectContaining(command) }),
      { ...command, revision: 1 },
    );
    expect(operations.create).not.toHaveBeenCalled();
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
    expect(projects.registerGeneratedResource).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId,
        ownerId: owner.user.id,
        sourceRevision: 1,
        id: `reverse-preview-${operationId}`,
        producer: 'proxy',
        checksum: 'cd'.repeat(32),
        path: expect.stringContaining(`/${operationId}/${claimToken}/source-reversed-preview.mp4`),
        derivedFrom: [`generated-intermediate:reverse-${operationId}`, sourceKey],
      }),
      tx,
    );
    expect(tx.updateTable).toHaveBeenCalledWith('media_operation');
    expect(operations.publishValidated).toHaveBeenCalledWith(operationId, claimToken, expect.any(Function));
    expect(operations.fail).not.toHaveBeenCalled();
    expect(storage.unlinkDir).not.toHaveBeenCalled();
  });

  it('records a non-deliverable checked preview in the same completion transaction', async () => {
    const { sut, operation, tx, renderer } = setup();
    await sut.run({ operation, claimToken });
    expect(renderer.preview).toHaveBeenCalledWith(
      expect.stringContaining('source-reversed.mkv'),
      expect.stringContaining('source-reversed-preview.mp4'),
      expect.objectContaining({ frames: 3 }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const query = tx.updateTable.mock.results[0].value;
    expect(query.set).toHaveBeenCalledWith({
      result: expect.objectContaining({
        browserPreview: expect.objectContaining({
          generatedId: `reverse-preview-${operationId}`,
          checksum: 'cd'.repeat(32),
          derivedFrom: [`generated-intermediate:reverse-${operationId}`, sourceKey],
          contentType: 'video/mp4',
          delivery: 'authenticated',
          audio: null,
          duration: 1,
        }),
      }),
    });
  });

  it('delivers only the checked preview buffer while its owner and source remain authorized', async () => {
    const { sut, operation, operations, projects, resources, storage, manifest } = setup();
    operation.status = MediaOperationStatus.Completed;
    const bytes = Buffer.from('checked preview bytes');
    const preview = {
      id: `reverse-preview-${operationId}`,
      producer: 'proxy',
      checksum: createHash('sha256').update(bytes).digest('hex'),
      path: '/private/source-reversed-preview.mp4',
      derivedFrom: [`generated-intermediate:reverse-${operationId}`, sourceKey],
    };
    projects.listGeneratedResources.mockResolvedValue([
      { id: `reverse-${operationId}`, producer: 'reverse-conform', derivedFrom: [sourceKey] },
      preview,
    ]);
    const file = { size: bytes.length, read: vi.fn().mockResolvedValue(bytes), close: vi.fn() };
    storage.openForRandomRead.mockResolvedValue(file);
    await expect(sut.readPreview(owner, operationId)).resolves.toBe(bytes);
    expect(operations.getForOwner).toHaveBeenCalledWith(operationId, owner.user.id);
    expect(file.read).toHaveBeenCalledWith(0, bytes.length + 1);
    expect(file.close).toHaveBeenCalledTimes(1);
    expect(resources.resolveProjectResources).toHaveBeenCalledTimes(2);
    expect(resources.resolveProjectResources).toHaveBeenLastCalledWith(
      owner,
      expect.objectContaining({ backgroundRunner: false }),
    );

    file.read.mockResolvedValue(Buffer.from('altered preview bytes'));
    await expect(sut.readPreview(owner, operationId)).rejects.toThrow('Reverse preview not found');
    expect(file.close).toHaveBeenCalledTimes(2);
    file.read.mockResolvedValue(bytes);
    file.size = 64 * 1024 * 1024 + 1;
    await expect(sut.readPreview(owner, operationId)).rejects.toThrow('Reverse preview not found');
    expect(file.read).toHaveBeenCalledTimes(2);
    expect(file.close).toHaveBeenCalledTimes(3);
    file.size = bytes.length;

    // A lock/trash/access change during the read must prevent release of the verified buffer.
    resources.resolveProjectResources
      .mockResolvedValueOnce({ manifest })
      .mockResolvedValueOnce({ manifest: { complete: false, entries: [] } });
    await expect(sut.readPreview(owner, operationId)).rejects.toThrow('complete source manifest');
    expect(file.close).toHaveBeenCalledTimes(4);

    preview.derivedFrom = [sourceKey];
    await expect(sut.readPreview(owner, operationId)).rejects.toThrow('Reverse preview not found');
    expect(storage.openForRandomRead).toHaveBeenCalledTimes(4);
    operations.getForOwner.mockResolvedValue(undefined);
    await expect(
      sut.readPreview({ ...owner, user: { ...owner.user, id: '0195e2a0-0000-7000-8000-000000000015' } }, operationId),
    ).rejects.toThrow('Reverse preview not found');
    await expect(sut.readPreview({ ...owner, sharedLink: {} } as never, operationId)).rejects.toThrow(
      'Reverse preview not found',
    );
    expect(storage.openForRandomRead).toHaveBeenCalledTimes(4);
  });

  it('projects only authorized completed reverse metadata and refuses ownership, revocation and lineage changes', async () => {
    const { sut, operation, projects, resources, manifest, storage } = setup();
    operation.status = MediaOperationStatus.Completed;
    const generatedId = `reverse-${operationId}`;
    const preview = {
      id: `reverse-preview-${operationId}`,
      producer: 'proxy',
      checksum: 'cd'.repeat(32),
      derivedFrom: [`generated-intermediate:${generatedId}`, sourceKey],
      path: '/private/preview.mp4',
    };
    projects.listGeneratedResources.mockResolvedValue([
      { id: generatedId, producer: 'reverse-conform', derivedFrom: [sourceKey] },
      preview,
    ]);
    operation.result = {
      kind: 'studio-source-reverse',
      generatedId,
      sourceKey,
      sourceRevision: 1,
      sourceRevisionDigest: 'revision-digest',
      sourceLevel: true,
      requiresClipRelink: true,
      frames: 3,
      frameRate: { num: 3, den: 1 },
      width: 32,
      height: 32,
      privatePath: '/private/master.mkv',
      browserPreview: {
        generatedId: preview.id,
        checksum: preview.checksum,
        derivedFrom: preview.derivedFrom,
        contentType: 'video/mp4',
        profile: 'h264-main-3.2-aac-lc-v1',
        delivery: 'authenticated',
        path: preview.path,
      },
    };
    const result = await sut.getResult(owner, operationId);
    expect(result).toEqual({
      operationId,
      projectId,
      clipId: null,
      sourceRevision: 1,
      generatedId,
      frames: 3,
      frameRate: { num: 3, den: 1 },
      width: 32,
      height: 32,
      browserPreview: {
        generatedId: preview.id,
        checksum: preview.checksum,
        contentType: 'video/mp4',
        profile: 'h264-main-3.2-aac-lc-v1',
        delivery: 'authenticated',
      },
    });
    expect(storage.openForRandomRead).not.toHaveBeenCalled();
    await expect(sut.getResult(authStub.admin, operationId)).rejects.toThrow('Reverse preview not found');
    await expect(sut.getResult({ ...owner, sharedLink: {} } as never, operationId)).rejects.toThrow();
    resources.resolveProjectResources.mockResolvedValue({ manifest: { complete: false, entries: [] } });
    await expect(sut.getResult(owner, operationId)).rejects.toThrow('complete source manifest');
    resources.resolveProjectResources.mockResolvedValue({ manifest });
    preview.derivedFrom = [sourceKey];
    await expect(sut.getResult(owner, operationId)).rejects.toThrow('Reverse preview not found');
    preview.derivedFrom = [`generated-intermediate:${generatedId}`, sourceKey];
    operation.result.sourceRevision = 2;
    await expect(sut.getResult(owner, operationId)).rejects.toThrow('Reverse result not found');
    operation.result.sourceRevision = 1;
    operation.status = MediaOperationStatus.Rendering;
    await expect(sut.getResult(owner, operationId)).rejects.toThrow('Reverse preview not found');
  });

  it('cleans up both files without registering either when preview packets fail validation', async () => {
    const { sut, operation, projects, operations, renderer, storage } = setup();
    renderer.previewPackets.mockResolvedValue([{ pts: 0, dts: 0, duration: 1 }]);
    await sut.run({ operation, claimToken });
    expect(projects.registerGeneratedResource).not.toHaveBeenCalled();
    expect(operations.publishValidated).not.toHaveBeenCalled();
    expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(claimToken), {
      recursive: true,
      force: true,
    });
  });

  it('kills a cancelled preview and never publishes the already-rendered master', async () => {
    vi.useFakeTimers();
    const { sut, operation, operations, renderer, projects, storage } = setup();
    const { promise: rendering, resolve: started } = Promise.withResolvers<void>();
    renderer.preview.mockImplementation(
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

  it('does not complete if the preview declaration is rejected inside the publication transaction', async () => {
    const { sut, operation, projects, operations, storage, tx } = setup();
    projects.registerGeneratedResource.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('conflict'));
    await sut.run({ operation, claimToken });
    expect(tx.updateTable).not.toHaveBeenCalled();
    expect(operations.fail).toHaveBeenCalled();
    expect(storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining(claimToken), {
      recursive: true,
      force: true,
    });
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
