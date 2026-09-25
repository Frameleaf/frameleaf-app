import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import {
  StudioProject,
  StudioProjectComment,
  StudioProjectRepository,
  StudioProjectRevision,
} from 'src/repositories/studio-project.repository.js';
import { StudioProjectService, StudioRevisionEvent } from 'src/services/studio-project.service.js';
import { StudioAuthorizedManifest, StudioResourceService } from 'src/services/studio-resource.service.js';
import {
  STUDIO_ENGINE,
  STUDIO_ENVELOPE_SCHEMA_VERSION,
  STUDIO_LEASE_MS,
  STUDIO_TRASH_RETENTION_DAYS,
  studioEnvelopeDigest,
} from 'src/utils/studio-project.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { getMocks } from 'test/utils.js';

// eslint-friendly alias: a mock whose implementation may return anything, promises included.
type AnyMock = Mock<(...args: any[]) => any>;

const envelope = (graph?: Record<string, unknown>) => ({
  schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
  engine: STUDIO_ENGINE,
  engineRevision: 'rev-1',
  graph: graph ?? { tracks: [] },
});

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 1000);

const conflictOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a conflict');
};

describe(StudioProjectService.name, () => {
  let sut: StudioProjectService;
  let repository: Record<keyof StudioProjectRepository, AnyMock>;
  let access: {
    album: { checkOwnerAccess: AnyMock; checkSharedAlbumAccess: AnyMock };
  };
  let resources: { resolveProjectResources: AnyMock };
  let owner: AuthDto;
  let reviewer: AuthDto;
  let project: StudioProject;
  let head: StudioProjectRevision;

  const manifest = (complete: boolean, overrides: Partial<StudioAuthorizedManifest> = {}) => ({
    manifest: {
      complete,
      refusedCount: complete ? 0 : 2,
      issuedAt: new Date().toISOString(),
      expiresAt: future().toISOString(),
      digest: complete ? 'complete' : 'partial',
      entries: [],
      ...overrides,
    } as StudioAuthorizedManifest,
    refused: [],
  });

  const projectStub = (overrides: Partial<StudioProject> = {}): StudioProject =>
    ({
      id: newUuidV7(),
      ownerId: owner.user.id,
      name: 'Lake trip',
      spaceId: null,
      currentRevision: 3,
      leaseHolderId: owner.user.id,
      leaseClientId: 'tab-a',
      leaseExpiresAt: future(),
      createdAt: new Date('2026-09-22T10:00:00.000Z'),
      updatedAt: new Date('2026-09-22T10:05:00.000Z'),
      updateId: newUuidV7(),
      ...overrides,
    }) as StudioProject;

  const revisionStub = (overrides: Partial<StudioProjectRevision> = {}): StudioProjectRevision => {
    const stored = envelope({ tracks: [{ id: 't1' }] });
    return {
      id: newUuidV7(),
      projectId: project.id,
      revision: 3,
      authorId: owner.user.id,
      envelope: stored,
      digest: studioEnvelopeDigest(stored),
      graphBytes: 20,
      summary: { counts: { 'clip.add': 1 }, total: 1 },
      requestKey: 'req-3',
      restoredFromRevision: null,
      createdAt: new Date('2026-09-22T10:05:00.000Z'),
      ...overrides,
    } as StudioProjectRevision;
  };

  const memberOf = (spaceId: string) => {
    access.album.checkOwnerAccess.mockResolvedValue(new Set());
    access.album.checkSharedAlbumAccess.mockImplementation((_userId: string, ids: Set<string>) =>
      Promise.resolve(ids.has(spaceId) ? new Set([spaceId]) : new Set()),
    );
  };

  beforeEach(() => {
    owner = AuthFactory.create();
    reviewer = AuthFactory.create();
    project = projectStub();
    head = revisionStub();

    repository = {
      create: vi.fn(),
      getById: vi.fn().mockImplementation((id: string) => Promise.resolve(id === project.id ? project : undefined)),
      listVisible: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      update: vi.fn(),
      delete: vi.fn(),
      trash: vi
        .fn()
        .mockImplementation((id: string, purgeAfter: Date) =>
          Promise.resolve({ ...project, id, deletedAt: new Date(), purgeAfter, leaseHolderId: null }),
        ),
      untrash: vi
        .fn()
        .mockImplementation((id: string) => Promise.resolve({ ...project, id, deletedAt: null, purgeAfter: null })),
      emptyTrash: vi.fn().mockResolvedValue(2),
      clearLease: vi.fn(),
      createWithRevision: vi.fn(),
      getSpace: vi.fn(),
      acquireLease: vi.fn(),
      releaseLease: vi.fn().mockResolvedValue(true),
      appendRevision: vi.fn(),
      getRevision: vi
        .fn()
        .mockImplementation((_projectId: string, revision: number) =>
          Promise.resolve(revision === head.revision ? head : undefined),
        ),
      getRevisionByRequestKey: vi.fn().mockResolvedValue(undefined),
      listRevisions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listRevisionSummariesBetween: vi.fn().mockResolvedValue([]),
      createComment: vi.fn(),
      getComment: vi.fn(),
      getCommentByRequestKey: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      updateComment: vi.fn(),
      deleteComment: vi.fn().mockResolvedValue(true),
    } as never;
    access = {
      album: {
        checkOwnerAccess: vi.fn().mockResolvedValue(new Set()),
        checkSharedAlbumAccess: vi.fn().mockResolvedValue(new Set()),
      },
    };
    resources = { resolveProjectResources: vi.fn().mockResolvedValue(manifest(true)) };

    sut = new StudioProjectService(
      getMocks().logger as never,
      repository as unknown as StudioProjectRepository,
      access as unknown as AccessRepository,
      resources as unknown as StudioResourceService,
    );
  });

  describe('access', () => {
    it('answers not found for somebody else, exactly like a missing project', async () => {
      await expect(sut.get(reviewer, project.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.get(owner, newUuidV7())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a shared-link session before touching the repository', async () => {
      const sharedLink = AuthFactory.from().sharedLink().build();
      await expect(sut.get(sharedLink, project.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getById).not.toHaveBeenCalled();
    });

    it('lets a live space member review and drops them the moment the membership row is gone', async () => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);

      const seen = await sut.get(reviewer, project.id);
      expect(seen.access).toBe('reviewer');
      expect(seen.envelope).toEqual(head.envelope);

      access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      await expect(sut.get(reviewer, project.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never lets a reviewer write, take the lease, rename or delete', async () => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);

      const save = { clientId: 'tab-r', requestKey: 'r1', expectedRevision: 3, envelope: envelope() };
      await expect(sut.save(reviewer, project.id, save)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.acquireLease(reviewer, project.id, { clientId: 'tab-r' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(sut.update(reviewer, project.id, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.remove(reviewer, project.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.appendRevision).not.toHaveBeenCalled();
      expect(repository.acquireLease).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe('review exposure', () => {
    beforeEach(() => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);
    });

    it('withholds the graph and the digest from a reviewer when any source is unavailable to them', async () => {
      resources.resolveProjectResources.mockResolvedValue(manifest(false));

      const seen = await sut.get(reviewer, project.id);

      expect(seen).toMatchObject({ withheld: true, envelope: null, digest: null });
      expect(seen.resources).toMatchObject({ complete: false, refusedCount: 2 });
      expect(resources.resolveProjectResources).toHaveBeenCalledWith(
        reviewer,
        expect.objectContaining({
          projectId: project.id,
          ownerId: project.ownerId,
          revision: 3,
          graph: (head.envelope as { graph: unknown }).graph,
          destination: StudioDestination.Local,
        }),
      );
    });

    it('never withholds the owner’s own document, but still reports the resolution', async () => {
      resources.resolveProjectResources.mockResolvedValue(manifest(false));

      const seen = await sut.get(owner, project.id);

      expect(seen).toMatchObject({ withheld: false, digest: head.digest, resources: { complete: false } });
      expect(seen.envelope).toEqual(head.envelope);
    });

    it('omits digests from a reviewer’s history list and refuses their diff when withheld', async () => {
      repository.listRevisions.mockResolvedValue({ items: [head], total: 1 });
      const history = await sut.getHistory(reviewer, project.id, {});
      expect(history.items[0].digest).toBeNull();

      const ownerHistory = await sut.getHistory(owner, project.id, {});
      expect(ownerHistory.items[0].digest).toBe(head.digest);

      resources.resolveProjectResources.mockResolvedValue(manifest(false));
      repository.getRevision.mockImplementation((_projectId: string, revision: number) =>
        Promise.resolve(revision === 3 ? head : revision === 2 ? revisionStub({ revision: 2 }) : undefined),
      );
      await expect(sut.diff(reviewer, project.id, 3, 2)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('save', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      clientId: 'tab-a',
      requestKey: 'req-4',
      expectedRevision: 3,
      envelope: envelope({ tracks: [{ id: 't1' }, { id: 't2' }] }),
      ...overrides,
    });

    it('refuses an envelope this server does not store, before any read of history', async () => {
      await expect(
        sut.save(owner, project.id, dto({ envelope: { ...envelope(), engine: 'other' } })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.getRevisionByRequestKey).not.toHaveBeenCalled();
    });

    it('replays an already-answered request key with the same document instead of writing again', async () => {
      const saved = dto();
      const digest = studioEnvelopeDigest(saved.envelope);
      repository.getRevisionByRequestKey.mockResolvedValue(revisionStub({ revision: 4, digest, requestKey: 'req-4' }));

      const result = await sut.save(owner, project.id, saved);

      expect(result).toMatchObject({ revision: 4, digest, replayed: true, unchanged: false });
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('refuses the same request key carrying a different document', async () => {
      repository.getRevisionByRequestKey.mockResolvedValue(
        revisionStub({ revision: 4, digest: 'other', requestKey: 'req-4' }),
      );

      const body = await conflictOf(sut.save(owner, project.id, dto()));

      expect(body).toMatchObject({ reason: 'request-key-reused', currentRevision: 3 });
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('reports a stale head with the current revision so the editor can reconcile', async () => {
      const body = await conflictOf(sut.save(owner, project.id, dto({ expectedRevision: 2 })));
      expect(body).toMatchObject({ reason: 'stale-revision', currentRevision: 3 });
    });

    it('reports a lost lease ahead of writing, and says whether another instance holds it', async () => {
      project = projectStub({ leaseClientId: 'tab-b' });
      const other = await conflictOf(sut.save(owner, project.id, dto()));
      expect(other).toMatchObject({ reason: 'lease-lost', lease: { heldByYou: false, heldByAnother: true } });

      project = projectStub({ leaseExpiresAt: past() });
      const lapsed = await conflictOf(sut.save(owner, project.id, dto()));
      expect(lapsed).toMatchObject({ reason: 'lease-lost', lease: { heldByYou: false, heldByAnother: false } });
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('writes nothing for a document identical to the head', async () => {
      const result = await sut.save(owner, project.id, dto({ envelope: head.envelope }));

      expect(result).toMatchObject({ revision: 3, revisionId: null, unchanged: true, replayed: false });
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('appends the next revision, renews the lease and tells listeners', async () => {
      const saved = dto();
      const digest = studioEnvelopeDigest(saved.envelope);
      const appended = revisionStub({ revision: 4, digest, requestKey: 'req-4' });
      repository.appendRevision.mockResolvedValue({ status: 'appended', revision: appended });
      const events: StudioRevisionEvent[] = [];
      sut.registerRevisionListener((event) => {
        events.push(event);
      });

      const result = await sut.save(owner, project.id, { ...saved, summary: { counts: { 'clip.add': 2 }, total: 2 } });

      expect(repository.appendRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: project.id,
          expectedRevision: 3,
          authorId: owner.user.id,
          leaseClientId: 'tab-a',
          leaseMs: STUDIO_LEASE_MS,
          digest,
          requestKey: 'req-4',
          summary: { counts: { 'clip.add': 2 }, total: 2 },
          restoredFromRevision: null,
        }),
      );
      expect(result).toMatchObject({ revision: 4, revisionId: appended.id, digest, replayed: false, unchanged: false });
      expect(events).toEqual([
        { projectId: project.id, ownerId: owner.user.id, revision: 4, digest, restoredFromRevision: null },
      ]);
    });

    it('re-reads after a lost race and reports the true reason', async () => {
      repository.appendRevision.mockResolvedValue({ status: 'rejected' });
      repository.getById.mockResolvedValueOnce(project).mockResolvedValueOnce(projectStub({ currentRevision: 4 }));

      const body = await conflictOf(sut.save(owner, project.id, dto()));

      expect(body).toMatchObject({ reason: 'stale-revision', currentRevision: 4 });
    });

    it('answers a concurrent duplicate retry from the row that won', async () => {
      const saved = dto();
      const digest = studioEnvelopeDigest(saved.envelope);
      repository.appendRevision.mockResolvedValue({ status: 'duplicate-key' });
      repository.getRevisionByRequestKey
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(revisionStub({ revision: 4, digest, requestKey: 'req-4' }));

      const result = await sut.save(owner, project.id, saved);

      expect(result).toMatchObject({ revision: 4, replayed: true });
    });
  });

  describe('restore', () => {
    it('appends a copy of the earlier revision and records where it came from', async () => {
      const older = revisionStub({ revision: 1, digest: 'd1', envelope: envelope({ tracks: [] }) });
      repository.getRevision.mockImplementation((_projectId: string, revision: number) =>
        Promise.resolve(revision === 1 ? older : revision === 3 ? head : undefined),
      );
      repository.appendRevision.mockResolvedValue({
        status: 'appended',
        revision: revisionStub({ revision: 4, digest: 'd1', restoredFromRevision: 1 }),
      });

      const result = await sut.restore(owner, project.id, {
        clientId: 'tab-a',
        requestKey: 'restore-1',
        expectedRevision: 3,
        revision: 1,
      });

      expect(repository.appendRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          envelope: older.envelope,
          digest: 'd1',
          restoredFromRevision: 1,
          summary: { counts: { 'history.restore': 1 }, total: 1 },
        }),
      );
      expect(result).toMatchObject({ revision: 4, digest: 'd1' });
    });

    it('refuses to restore a revision that does not exist', async () => {
      const body = await conflictOf(
        sut.restore(owner, project.id, { clientId: 'tab-a', requestKey: 'r', expectedRevision: 3, revision: 9 }),
      );
      expect(body).toMatchObject({ reason: 'revision-missing', currentRevision: 3 });
    });
  });

  describe('lease', () => {
    it('acquires or renews, and never takes over unless asked', async () => {
      repository.acquireLease.mockResolvedValue(projectStub({ leaseClientId: 'tab-a' }));

      const lease = await sut.acquireLease(owner, project.id, { clientId: 'tab-a' });

      expect(repository.acquireLease).toHaveBeenCalledWith(project.id, {
        userId: owner.user.id,
        clientId: 'tab-a',
        leaseMs: STUDIO_LEASE_MS,
        takeover: false,
      });
      expect(lease).toMatchObject({ heldByYou: true, heldByAnother: false, leaseMs: STUDIO_LEASE_MS });
    });

    it('refuses a live lease held elsewhere with its expiry, and takes over only explicitly', async () => {
      repository.acquireLease.mockResolvedValueOnce(undefined);
      repository.getById.mockResolvedValue(projectStub({ id: project.id, leaseClientId: 'tab-b' }));

      const body = await conflictOf(sut.acquireLease(owner, project.id, { clientId: 'tab-a' }));
      expect(body).toMatchObject({ reason: 'lease-held', lease: { heldByAnother: true } });

      repository.acquireLease.mockResolvedValueOnce(projectStub({ leaseClientId: 'tab-a' }));
      await sut.acquireLease(owner, project.id, { clientId: 'tab-a', takeover: true });
      expect(repository.acquireLease).toHaveBeenLastCalledWith(project.id, expect.objectContaining({ takeover: true }));
    });
  });

  describe('sharing', () => {
    it('only shares into a live shared space the owner belongs to', async () => {
      const spaceId = newUuid();
      repository.getSpace.mockResolvedValue({
        id: spaceId,
        ownerId: newUuid(),
        kind: AlbumKind.Album,
        deletedAt: null,
      });
      await expect(sut.update(owner, project.id, { spaceId })).rejects.toBeInstanceOf(BadRequestException);

      repository.getSpace.mockResolvedValue({
        id: spaceId,
        ownerId: newUuid(),
        kind: AlbumKind.Space,
        deletedAt: null,
      });
      await expect(sut.update(owner, project.id, { spaceId })).rejects.toBeInstanceOf(BadRequestException);

      memberOf(spaceId);
      repository.update.mockResolvedValue(projectStub({ spaceId }));
      await expect(sut.update(owner, project.id, { spaceId })).resolves.toMatchObject({ spaceId });
    });
  });

  describe('comments', () => {
    const comment = (overrides: Partial<StudioProjectComment> = {}): StudioProjectComment =>
      ({
        id: newUuidV7(),
        projectId: project.id,
        authorId: reviewer.user.id,
        revision: 3,
        timeNum: '1001',
        timeDen: '30000',
        text: 'Hold the lake shot',
        resolvedAt: null,
        resolvedById: null,
        requestKey: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      }) as StudioProjectComment;

    beforeEach(() => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);
    });

    it('lets a reviewer comment at an exact, reduced time without any lease', async () => {
      repository.createComment.mockImplementation((input) => Promise.resolve(comment(input)));

      const created = await sut.addComment(reviewer, project.id, {
        revision: 3,
        time: { num: 2002, den: 60_000 },
        text: 'Hold the lake shot',
      });

      expect(repository.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ authorId: reviewer.user.id, timeNum: 1001, timeDen: 30_000 }),
      );
      expect(created.time).toEqual({ num: 1001, den: 30_000 });
    });

    it('refuses an inexact time and a revision that does not exist yet', async () => {
      await expect(
        sut.addComment(reviewer, project.id, { revision: 3, time: { num: 1, den: 0 }, text: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.addComment(reviewer, project.id, { revision: 9, time: { num: 1, den: 1 }, text: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('lets the owner resolve a reviewer’s comment but not rewrite it', async () => {
      repository.getComment.mockResolvedValue(comment());
      repository.updateComment.mockImplementation((_p, _id, patch) =>
        Promise.resolve(comment({ resolvedById: patch.resolvedById ?? null, resolvedAt: new Date() })),
      );

      await expect(sut.updateComment(owner, project.id, 'c1', { text: 'no' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      const resolved = await sut.updateComment(owner, project.id, 'c1', { resolved: true });
      expect(resolved.resolvedById).toBe(owner.user.id);
    });

    it('lets neither a different reviewer resolve nor remove somebody else’s comment', async () => {
      const other = AuthFactory.create();
      memberOf(project.spaceId as string);
      repository.getComment.mockResolvedValue(comment());

      await expect(sut.updateComment(other, project.id, 'c1', { resolved: true })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(sut.removeComment(other, project.id, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.deleteComment).not.toHaveBeenCalled();
    });
  });

  describe('authorizeRevision', () => {
    it('reuses an unexpired manifest for the same project, revision, account and destination', async () => {
      const first = await sut.authorizeRevision(owner, { projectId: project.id });
      const second = await sut.authorizeRevision(owner, { projectId: project.id });

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.manifest).toBe(first.manifest);
      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(1);
    });

    it('resolves again for another account and never caches a cloud destination', async () => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);

      await sut.authorizeRevision(owner, { projectId: project.id });
      await sut.authorizeRevision(reviewer, { projectId: project.id });
      await sut.authorizeRevision(owner, {
        projectId: project.id,
        destination: StudioDestination.FrameleafCloud,
        cloudConsent: true,
      });
      await sut.authorizeRevision(owner, {
        projectId: project.id,
        destination: StudioDestination.FrameleafCloud,
        cloudConsent: true,
      });

      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(4);
    });

    it('forgets cached manifests when a new revision commits', async () => {
      await sut.authorizeRevision(owner, { projectId: project.id });
      repository.appendRevision.mockResolvedValue({ status: 'appended', revision: revisionStub({ revision: 4 }) });
      await sut.save(owner, project.id, {
        clientId: 'tab-a',
        requestKey: 'req-4',
        expectedRevision: 3,
        envelope: envelope({ tracks: [{ id: 't1' }, { id: 't2' }] }),
      });

      const again = await sut.authorizeRevision(owner, { projectId: project.id, revision: 3 });
      expect(again.cached).toBe(false);
    });

    it('answers the head revision only to an account that may read the project', async () => {
      await expect(sut.getReadableRevision(project.id, owner.user.id)).resolves.toBe(3);
      await expect(sut.getReadableRevision(project.id, reviewer.user.id)).resolves.toBeNull();
      await expect(sut.getReadableRevision(newUuidV7(), owner.user.id)).resolves.toBeNull();
    });

    it('answers a space member with the head, and stops the moment they leave the space', async () => {
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);
      await expect(sut.getReadableRevision(project.id, reviewer.user.id)).resolves.toBe(3);

      memberOf(newUuid());
      await expect(sut.getReadableRevision(project.id, reviewer.user.id)).resolves.toBeNull();
    });
  });
  describe('lifecycle (FL-91)', () => {
    it('moves a project to the trash with the retention deadline, and never touches the library', async () => {
      const before = Date.now();
      await sut.remove(owner, project.id);

      expect(repository.delete).not.toHaveBeenCalled();
      expect(repository.trash).toHaveBeenCalledTimes(1);
      const purgeAfter = repository.trash.mock.calls[0][1] as Date;
      expect(purgeAfter.getTime()).toBeGreaterThanOrEqual(before + STUDIO_TRASH_RETENTION_DAYS * 86_400_000);
    });

    it('deletes for good only when asked to', async () => {
      await sut.remove(owner, project.id, { permanent: true });
      expect(repository.delete).toHaveBeenCalledWith(project.id);
      expect(repository.trash).not.toHaveBeenCalled();
    });

    it('restores a trashed project to the shelf it came from', async () => {
      project = projectStub({ deletedAt: new Date(), purgeAfter: future(), archivedAt: new Date() } as never);
      const restored = await sut.restoreFromTrash(owner, project.id);
      expect(repository.untrash).toHaveBeenCalledWith(project.id);
      expect(restored.shelf).toBe('archived');
      expect(restored.purgeAfter).toBeNull();
    });

    it('refuses every edit to a trashed project until it is restored', async () => {
      project = projectStub({ deletedAt: new Date(), purgeAfter: future() } as never);
      const save = { clientId: 'tab-a', requestKey: 'r9', expectedRevision: 3, envelope: envelope({ tracks: [1] }) };

      expect(await conflictOf(sut.save(owner, project.id, save))).toMatchObject({ reason: 'project-trashed' });
      expect(await conflictOf(sut.acquireLease(owner, project.id, { clientId: 'tab-a' }))).toMatchObject({
        reason: 'project-trashed',
      });
      expect(await conflictOf(sut.update(owner, project.id, { name: 'x' }))).toMatchObject({
        reason: 'project-trashed',
      });
      expect(await conflictOf(sut.authorizeRevision(owner, { projectId: project.id }))).toMatchObject({
        reason: 'project-trashed',
      });
      await expect(sut.getReadableRevision(project.id, owner.user.id)).resolves.toBeNull();
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('makes an archived project read-only for its owner and invisible to reviewers', async () => {
      project = projectStub({ spaceId: newUuid(), archivedAt: new Date() } as never);
      memberOf(project.spaceId as string);

      const save = { clientId: 'tab-a', requestKey: 'r9', expectedRevision: 3, envelope: envelope({ tracks: [1] }) };
      expect(await conflictOf(sut.save(owner, project.id, save))).toMatchObject({ reason: 'project-archived' });
      await expect(sut.get(owner, project.id)).resolves.toMatchObject({ shelf: 'archived' });
      await expect(sut.get(reviewer, project.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getReadableRevision(project.id, reviewer.user.id)).resolves.toBeNull();
    });

    it('drops the write lease when a project is archived', async () => {
      repository.update.mockResolvedValue(projectStub({ archivedAt: new Date() } as never));
      const archived = await sut.update(owner, project.id, { archived: true });

      expect(repository.update).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({ archivedAt: expect.any(Date) }),
      );
      expect(repository.clearLease).toHaveBeenCalledWith(project.id);
      expect(archived.shelf).toBe('archived');
    });

    it('accepts a poster only when the resolver authorizes it for this session', async () => {
      const assetId = newUuid();
      resources.resolveProjectResources.mockResolvedValueOnce(manifest(false));
      await expect(sut.update(owner, project.id, { thumbnailAssetId: assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      resources.resolveProjectResources.mockResolvedValueOnce(
        manifest(true, { entries: [{ kind: StudioResourceKind.LibraryAsset, id: assetId }] as never }),
      );
      repository.update.mockResolvedValue(projectStub({ thumbnailAssetId: assetId } as never));
      await expect(sut.update(owner, project.id, { thumbnailAssetId: assetId })).resolves.toMatchObject({
        thumbnailAssetId: assetId,
      });
      expect(resources.resolveProjectResources).toHaveBeenLastCalledWith(
        owner,
        expect.objectContaining({ graph: { poster: { assetId } }, destination: StudioDestination.Local }),
      );
    });

    it('duplicates the head byte for byte into a new project of the owner, unshared', async () => {
      project = projectStub({ spaceId: newUuid() });
      const copy = projectStub({ id: newUuidV7(), duplicatedFromId: project.id, currentRevision: 1 } as never);
      repository.createWithRevision.mockResolvedValue({ project: copy, created: true });

      const result = await sut.duplicate(owner, project.id, { name: 'Lake trip (copy)' });

      expect(repository.createWithRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: owner.user.id,
          name: 'Lake trip (copy)',
          duplicatedFromId: project.id,
          revision: expect.objectContaining({ envelope: head.envelope, digest: head.digest }),
        }),
      );
      expect(repository.createWithRevision.mock.calls[0][0].spaceId).toBeUndefined();
      expect(result.duplicatedFromId).toBe(project.id);
    });

    it('hides lineage, recents and the poster from a reviewer', async () => {
      project = projectStub({
        spaceId: newUuid(),
        thumbnailAssetId: newUuid(),
        lastOpenedAt: new Date(),
        duplicatedFromId: newUuidV7(),
        importedFromDigest: 'a'.repeat(64),
      } as never);
      memberOf(project.spaceId as string);

      const seen = await sut.get(reviewer, project.id);
      expect(seen.thumbnailAssetId).toBeNull();
      expect(seen.lastOpenedAt).toBeNull();
      expect(seen.duplicatedFromId).toBeNull();
      expect(seen.importedFromBundle).toBe(false);

      const own = await sut.get(owner, project.id);
      expect(own.importedFromBundle).toBe(true);
      expect(own.duplicatedFromId).toBe(project.duplicatedFromId);
    });

    it('lists one shelf with the query and order the library asked for', async () => {
      await sut.search(owner, { shelf: 'trashed', query: 'lake', sort: 'recent' });
      expect(repository.listVisible).toHaveBeenCalledWith(owner.user.id, {
        take: 50,
        skip: 0,
        state: 'trashed',
        query: 'lake',
        sort: 'recent',
      });
    });

    it('empties the trash for the acting account only', async () => {
      await expect(sut.emptyTrash(owner)).resolves.toEqual({ count: 2 });
      expect(repository.emptyTrash).toHaveBeenCalledWith(owner.user.id);
    });
  });
});
