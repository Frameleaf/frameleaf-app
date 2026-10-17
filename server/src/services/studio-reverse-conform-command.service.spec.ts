import { ConflictException, ForbiddenException } from '@nestjs/common';
import { StudioProjectController } from 'src/controllers/studio-project.controller.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { StudioReverseConformCommandService } from 'src/services/studio-reverse-conform-command.service.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { reverseClipGraph } from 'test/fixtures/studio-reverse-conform.stub.js';

const projectId = '0195e2a0-0000-7000-8000-000000000010';
const operationId = '0195e2a0-0000-7000-8000-000000000012';
const owner = authStub.user1;
const graph = reverseClipGraph();
const sourceKey = `library-asset:${graph.timeline.items[0].mediaId}`;
const command = {
  id: 'job.enqueueReverseConform',
  payload: { clipId: 'clip-a', destinationId: 'local' },
  revision: 1,
  idempotencyKey: 'request-a',
  issuedAt: 1234,
};
const setup = () => {
  const generated = {
    id: `reverse-${operationId}`,
    checksum: 'ab'.repeat(32),
    producer: 'reverse-conform',
    path: '/private/result.mkv',
    derivedFrom: [sourceKey],
  };
  const operation = {
    id: operationId,
    projectId,
    ownerId: owner.user.id,
    kind: MediaOperationKind.StudioReverseConform,
    status: MediaOperationStatus.Completed,
    destination: MediaOperationDestination.Local,
    snapshot: {
      kind: 'studio-source-reverse',
      projectId,
      revision: 1,
      clipId: 'clip-a',
      sourceKey,
      digest: 'digest',
      checksum: 'original-checksum',
    },
    result: {
      kind: 'studio-source-reverse',
      sourceKey,
      sourceRevision: 1,
      sourceRevisionDigest: 'digest',
      generatedId: generated.id,
      sourceLevel: true,
      requiresClipRelink: true,
      frames: 3,
      frameRate: { num: 3, den: 1 },
    },
  };
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    authorizeRevision: vi.fn().mockResolvedValue({
      project: { ownerId: owner.user.id, currentRevision: 1 },
      revision: { digest: 'digest' },
      envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'r', graph },
    }),
    acquireLease: vi.fn().mockResolvedValue({ heldByYou: true }),
    save: vi.fn().mockResolvedValue({ revision: 2, replayed: false }),
  };
  const projects = {
    listGeneratedResources: vi.fn().mockResolvedValue([generated]),
    listImportDeclarations: vi.fn().mockResolvedValue([]),
  };
  const producer = { enqueueSource: vi.fn().mockResolvedValue(operation) };
  const operations = { getForOwner: vi.fn().mockResolvedValue(operation) };
  const resources = {
    resolveProjectResources: vi.fn().mockResolvedValue({
      manifest: {
        complete: true,
        entries: [
          { ...generated, kind: StudioResourceKind.GeneratedIntermediate },
          { key: sourceKey, kind: StudioResourceKind.LibraryAsset, checksum: 'original-checksum' },
        ],
      },
    }),
  };
  const sut = new StudioReverseConformCommandService(
    studio as never,
    projects as never,
    producer as never,
    operations as never,
    resources as never,
  );
  return { sut, studio, projects, producer, operations, resources, operation };
};

describe(StudioReverseConformCommandService.name, () => {
  it('refuses a reviewer before authorizing the clip revision or acquiring work', async () => {
    const { sut, studio, producer, resources } = setup();
    const reviewer = { ...owner, user: { ...owner.user, id: '0195e2a0-0000-7000-8000-000000000099' } };
    studio.requireOwnedProject.mockRejectedValue(new ForbiddenException('Only the project owner can conform a clip'));
    await expect(sut.enqueue(reviewer, projectId, 'tab-a', command)).rejects.toBeInstanceOf(ForbiddenException);
    expect(studio.authorizeRevision).not.toHaveBeenCalled();
    expect(studio.requireOwnedProject).toHaveBeenCalledWith(
      reviewer,
      projectId,
      'Only the project owner can conform a clip',
    );
    expect(studio.acquireLease).not.toHaveBeenCalled();
    expect(producer.enqueueSource).not.toHaveBeenCalled();
    expect(resources.resolveProjectResources).not.toHaveBeenCalled();
  });

  it('preserves apply conflict before any revision resolution for an unfinished owned conform', async () => {
    const { sut, studio, operation } = setup();
    operation.status = MediaOperationStatus.Preparing;
    await expect(sut.apply(owner, projectId, 'tab-a', operationId)).rejects.toBeInstanceOf(ConflictException);
    expect(studio.requireOwnedProject).not.toHaveBeenCalled();
    expect(studio.authorizeRevision).not.toHaveBeenCalled();
  });

  it('accepts the canonical local command and binds the stored clip/revision under an acquired edit lease', async () => {
    const { sut, studio, producer } = setup();
    await sut.enqueue(owner, projectId, 'tab-a', command);
    expect(studio.acquireLease).toHaveBeenCalledWith(owner, projectId, { clientId: 'tab-a' });
    expect(producer.enqueueSource).toHaveBeenCalledWith(owner, {
      projectId,
      revision: 1,
      sourceKey,
      destination: 'local',
      command: { clipId: 'clip-a', clientId: 'tab-a', requestKey: 'request-a' },
    });
    expect(studio.save).not.toHaveBeenCalled();
  });

  it.each(['lan', 'frameleaf-cloud'])('refuses %s before acquiring a lease or queueing', async (destinationId) => {
    const { sut, studio, producer } = setup();
    await expect(
      sut.enqueue(owner, projectId, 'tab-a', { ...command, payload: { ...command.payload, destinationId } }),
    ).rejects.toThrow('local destination');
    expect(studio.acquireLease).not.toHaveBeenCalled();
    expect(producer.enqueueSource).not.toHaveBeenCalled();
  });

  it('does not queue when another editor holds the lease', async () => {
    const { sut, studio, producer } = setup();
    studio.acquireLease.mockRejectedValue(new Error('lease-held'));
    await expect(sut.enqueue(owner, projectId, 'tab-a', command)).rejects.toThrow('lease-held');
    expect(producer.enqueueSource).not.toHaveBeenCalled();
  });

  it('resolves generated lineage before saving a lease-bound revision, without exposing its path in the graph', async () => {
    const { sut, studio, resources } = setup();
    await expect(sut.apply(owner, projectId, 'tab-b', operationId)).resolves.toEqual({ revision: 2, replayed: false });
    expect(resources.resolveProjectResources).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ generated: [expect.objectContaining({ derivedFrom: [sourceKey] })] }),
    );
    expect(studio.save).toHaveBeenCalledWith(
      owner,
      projectId,
      expect.objectContaining({
        clientId: 'tab-b',
        expectedRevision: 1,
        requestKey: `reverse-apply-${operationId}`,
        envelope: expect.objectContaining({
          graph: expect.objectContaining({
            timeline: expect.objectContaining({
              items: [
                expect.objectContaining({
                  generatedId: `reverse-${operationId}`,
                  sourceStart: 2,
                  sourceEnd: 3,
                  from: 20,
                  durationInFrames: 1,
                  isReversed: false,
                }),
              ],
            }),
          }),
        }),
      }),
    );
    expect(JSON.stringify(studio.save.mock.calls[0])).not.toContain('/private/');
  });

  it('routes enqueue/apply through owner, live resource and original-revision guards', async () => {
    const { sut, studio, resources, operation } = setup();
    const controller = new StudioProjectController(studio as never, {} as never, sut, {} as never);
    await expect(
      controller.enqueueStudioReverseConform(
        owner,
        { id: projectId },
        {
          clientId: 'tab-a',
          command: command as never,
        },
      ),
    ).resolves.toEqual({ operationId });
    expect(studio.save).not.toHaveBeenCalled();
    await expect(
      controller.applyStudioReverseConform(
        authStub.admin,
        { id: projectId },
        {
          clientId: 'tab-a',
          operationId,
        },
      ),
    ).rejects.toThrow('not found');
    resources.resolveProjectResources.mockResolvedValueOnce({ manifest: { complete: false, entries: [] } });
    await expect(
      controller.applyStudioReverseConform(
        owner,
        { id: projectId },
        {
          clientId: 'tab-a',
          operationId,
        },
      ),
    ).rejects.toThrow('no longer available');
    expect(studio.save).not.toHaveBeenCalled();
    studio.save.mockRejectedValueOnce(new Error('stale-revision'));
    await expect(
      controller.applyStudioReverseConform(
        owner,
        { id: projectId },
        {
          clientId: 'tab-a',
          operationId,
        },
      ),
    ).rejects.toThrow('stale-revision');
    expect(studio.save).toHaveBeenCalledTimes(1);
    expect(studio.save.mock.calls[0][2].expectedRevision).toBe(operation.snapshot.revision);
  });

  it('uses the same save idempotency key on repeated result application', async () => {
    const { sut, studio } = setup();
    await sut.apply(owner, projectId, 'tab-a', operationId);
    await sut.apply(owner, projectId, 'tab-a', operationId);
    expect(studio.save.mock.calls[0][2]).toEqual(studio.save.mock.calls[1][2]);
  });

  it('propagates stale saves and never rebases the result over newer edits', async () => {
    const { sut, studio } = setup();
    studio.save.mockRejectedValue(new Error('stale-revision'));
    await expect(sut.apply(owner, projectId, 'tab-a', operationId)).rejects.toThrow('stale-revision');
    expect(studio.save).toHaveBeenCalledTimes(1);
    expect(studio.save.mock.calls[0][2].expectedRevision).toBe(1);
  });

  it('refuses a source whose checksum changed after the conform completed', async () => {
    const { sut, operations, operation, studio } = setup();
    operations.getForOwner.mockResolvedValue({
      ...operation,
      snapshot: { ...operation.snapshot, checksum: 'changed' },
    });
    await expect(sut.apply(owner, projectId, 'tab-a', operationId)).rejects.toThrow('no longer available');
    expect(studio.save).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'missing-declaration', 'wrong-lineage', 'incomplete', 'other-owner'])(
    'refuses %s results without saving',
    async (reason) => {
      const { sut, studio, resources, projects, operations, operation } = setup();
      switch (reason) {
        case 'revoked': {
          resources.resolveProjectResources.mockResolvedValue({ manifest: { complete: false, entries: [] } });
          break;
        }
        case 'missing-declaration': {
          projects.listGeneratedResources.mockResolvedValue([]);
          break;
        }
        case 'wrong-lineage': {
          projects.listGeneratedResources.mockResolvedValue([
            { id: operation.result.generatedId, producer: 'reverse-conform', derivedFrom: ['library-asset:other'] },
          ]);
          break;
        }
        case 'incomplete': {
          operations.getForOwner.mockResolvedValue({ ...operation, status: MediaOperationStatus.Rendering });
          break;
        }
        case 'other-owner': {
          operations.getForOwner.mockResolvedValue(undefined);
          break;
        }
      }
      await expect(sut.apply(owner, projectId, 'tab-a', operationId)).rejects.toThrow();
      expect(studio.save).not.toHaveBeenCalled();
    },
  );
});
