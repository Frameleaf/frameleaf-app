import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AlbumKind, DecodeRefusal } from 'src/enum.js';
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
import { StudioDestination, StudioRefusalReason, StudioResourceKind } from 'src/utils/studio-resources.js';
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
  let websocket: ReturnType<typeof getMocks>['websocket'];
  let repository: Record<keyof StudioProjectRepository, AnyMock>;
  let access: {
    album: { checkOwnerAccess: AnyMock; checkSharedAlbumAccess: AnyMock };
    asset: {
      checkOwnerAccess: AnyMock;
      checkAlbumAccess: AnyMock;
      checkPartnerAccess: AnyMock;
      checkItemShareAccess: AnyMock;
    };
  };
  /** The owner's items the session may not see (Locked while locked, or hidden by a rule). */
  let hiddenFromSession: Set<string>;
  let resources: { resolveProjectResources: AnyMock; hdrLibraryAssets: AnyMock; studioHdrProxies: AnyMock };
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
      listGeneratedResources: vi.fn().mockResolvedValue([]),
      listImportDeclarations: vi.fn().mockResolvedValue([]),
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
      isLiveSharedSpaceOf: vi.fn().mockResolvedValue(false),
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
    hiddenFromSession = new Set();
    access = {
      album: {
        checkOwnerAccess: vi.fn().mockResolvedValue(new Set()),
        checkSharedAlbumAccess: vi.fn().mockResolvedValue(new Set()),
      },
      asset: {
        // every id is the owner's; an elevated lookup (`true`) sees them all, a session check not the hidden ones
        checkOwnerAccess: vi.fn((_userId: string, ids: Set<string>, elevated?: boolean) =>
          Promise.resolve(new Set([...ids].filter((id) => elevated === true || !hiddenFromSession.has(id)))),
        ),
        checkAlbumAccess: vi.fn().mockResolvedValue(new Set()),
        checkPartnerAccess: vi.fn().mockResolvedValue(new Set()),
        checkItemShareAccess: vi.fn().mockResolvedValue(new Set()),
      },
    };
    resources = {
      resolveProjectResources: vi.fn().mockResolvedValue(manifest(true)),
      hdrLibraryAssets: vi.fn().mockResolvedValue([]),
      studioHdrProxies: vi.fn().mockResolvedValue([]),
    };

    websocket = getMocks().websocket;
    sut = new StudioProjectService(
      getMocks().logger as never,
      repository as unknown as StudioProjectRepository,
      access as unknown as AccessRepository,
      resources as unknown as StudioResourceService,
      websocket as never,
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

    it('names placed videos this server cannot decode to the owner only (FL-101)', async () => {
      const assetId = newUuid();
      resources.resolveProjectResources.mockResolvedValue({
        ...manifest(false),
        refused: [
          {
            key: `library-asset:${assetId}`,
            kind: StudioResourceKind.LibraryAsset,
            id: assetId,
            graphPath: '$.sequences[0]',
            reason: StudioRefusalReason.UnsupportedSource,
            detail: 'Dolby Vision profile 7 carries a separate enhancement layer',
            decodeRefusal: DecodeRefusal.DolbyVisionEnhancementLayer,
          },
          {
            key: 'library-asset:other',
            kind: StudioResourceKind.LibraryAsset,
            id: newUuid(),
            graphPath: '$.sequences[1]',
            reason: StudioRefusalReason.Trashed,
            detail: 'In the trash.',
          },
        ],
      });

      const seen = await sut.get(owner, project.id);
      expect(seen.resources?.unsupportedSources).toEqual([
        {
          assetId,
          refusal: DecodeRefusal.DolbyVisionEnhancementLayer,
          reason: 'Dolby Vision profile 7 carries a separate enhancement layer',
        },
      ]);

      sut.forgetResolutions([project.id]);
      const reviewed = await sut.get(reviewer, project.id);
      expect(reviewed.resources?.unsupportedSources).toEqual([]);
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

    it('refuses canonical commands that are not the catalogue’s or not issued against this head (FL-92)', async () => {
      const command = (overrides: Record<string, unknown> = {}) => ({
        id: 'track.add',
        payload: { kind: 'video' },
        revision: 3,
        idempotencyKey: 'k-1',
        issuedAt: 1,
        ...overrides,
      });
      await expect(
        sut.save(owner, project.id, dto({ commands: [command({ id: 'clip.teleport' })] })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.save(owner, project.id, dto({ commands: [command({ revision: 4 })] }))).rejects.toThrow(
        /issued against revision 4, after 3/,
      );
      await expect(
        sut.save(owner, project.id, dto({ commands: [command(), command({ id: 'track.add' })] })),
      ).rejects.toThrow(/used twice/);
      await expect(
        sut.save(owner, project.id, dto({ commands: [command({ id: 'preview.release', payload: {} })] })),
      ).rejects.toThrow(/does not change the graph/);
      await expect(
        sut.save(owner, project.id, dto({ commands: [command({ payload: { kind: 'video', extra: 1 } })] })),
      ).rejects.toThrow(/unknown field extra/);
      expect(repository.getRevisionByRequestKey).not.toHaveBeenCalled();
      expect(repository.appendRevision).not.toHaveBeenCalled();
    });

    it('counts the revision summary from the checked commands, keeping the editor’s own saves (FL-92)', async () => {
      const saved = dto({
        commands: [
          // Issued while the previous autosave was in flight: an earlier head is fine.
          { id: 'track.add', payload: { kind: 'video' }, revision: 2, idempotencyKey: 'k-1', issuedAt: 1 },
          {
            id: 'title.add',
            payload: { at: { num: 1, den: 1 }, text: 'Hello' },
            revision: 3,
            idempotencyKey: 'k-2',
            issuedAt: 2,
          },
        ],
        // A client cannot inflate catalogue counts; its own non-catalogue entries are kept.
        summary: { counts: { 'track.add': 40, 'editor.save': 1 }, total: 41 },
      });
      const digest = studioEnvelopeDigest(saved.envelope);
      repository.appendRevision.mockResolvedValue({
        status: 'appended',
        revision: revisionStub({ revision: 4, digest, requestKey: 'req-4' }),
      });

      await sut.save(owner, project.id, saved);

      expect(repository.appendRevision).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: { counts: { 'track.add': 1, 'title.add': 1, 'editor.save': 1 }, total: 3 },
        }),
      );
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
      // FL-101: the new revision's sources are resolved and reported with the save.
      expect(result.resources).toMatchObject({ complete: true, refusedCount: 0, unsupportedSources: [] });
      expect(resources.resolveProjectResources).toHaveBeenLastCalledWith(
        owner,
        expect.objectContaining({ projectId: project.id, revision: 4, destination: StudioDestination.Local }),
      );
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
    it('hydrates server-owned generated files and re-resolves after publication without a graph save', async () => {
      const first = await sut.authorizeRevision(owner, { projectId: project.id });
      expect(first.cached).toBe(false);
      const generated = [
        {
          id: 'reverse',
          producer: 'reverse-conform',
          checksum: 'ab'.repeat(32),
          path: '/private/generated.mp4',
          derivedFrom: ['library-asset:source'],
        },
      ];
      repository.listGeneratedResources.mockResolvedValue(generated);
      const next = await sut.authorizeRevision(owner, { projectId: project.id });
      expect(next.cached).toBe(false);
      expect(repository.listGeneratedResources).toHaveBeenLastCalledWith(project.id);
      expect(resources.resolveProjectResources).toHaveBeenLastCalledWith(owner, expect.objectContaining({ generated }));
      const repeated = await sut.authorizeRevision(owner, { projectId: project.id });
      expect(repeated.cached).toBe(true);
      expect(repeated.manifest).toBe(next.manifest);
      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(2);
      sut.forgetResolutions([project.id]);
      expect((await sut.authorizeRevision(owner, { projectId: project.id })).cached).toBe(false);
      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(3);
    });

    it('reuses an unexpired manifest for the same project, revision, account and destination', async () => {
      const first = await sut.authorizeRevision(owner, { projectId: project.id });
      const second = await sut.authorizeRevision(owner, { projectId: project.id });

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.manifest).toBe(first.manifest);
      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(1);
    });

    it('never shares a resolution between an unlocked and a locked session of the same account (FL-195)', async () => {
      const unlocked = { ...owner, session: { id: 'session', hasElevatedPermission: true } } as typeof owner;
      await sut.authorizeRevision(unlocked, { projectId: project.id });
      const locked = await sut.authorizeRevision(owner, { projectId: project.id });

      expect(locked.cached).toBe(false);
      expect(resources.resolveProjectResources).toHaveBeenCalledTimes(2);
      expect(vi.mocked(resources.resolveProjectResources).mock.calls[1][0]).toBe(owner);
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
    it('invalidates admitted content only in the owner room after committed lifecycle and audience changes', async () => {
      const send = vi.mocked(websocket.clientSend);
      const event = ['StudioProjectInvalidatedV1', owner.user.id, { projectId: project.id }];
      let commit!: (row: StudioProject) => void;
      repository.update.mockReturnValueOnce(new Promise<StudioProject>((resolve) => (commit = resolve)));
      const archiving = sut.update(owner, project.id, { archived: true });
      await vi.waitFor(() => expect(repository.update).toHaveBeenCalledOnce());
      expect(send).not.toHaveBeenCalled();
      commit({ ...project, archivedAt: new Date() });
      await archiving;
      expect(send.mock.calls).toEqual([event]);
      expect(repository.update.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);

      send.mockClear();
      project = { ...project, spaceId: newUuid() };
      repository.update.mockResolvedValue({ ...project, spaceId: null });
      await sut.update(owner, project.id, { spaceId: null });
      expect(send.mock.calls).toEqual([event]);

      send.mockClear();
      await sut.remove(owner, project.id);
      expect(send.mock.calls).toEqual([event]);
      expect(repository.trash.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);

      send.mockClear();
      await sut.remove(owner, project.id, { permanent: true });
      expect(send.mock.calls).toEqual([event]);
      expect(repository.delete.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);

      send.mockClear();
      await sut.emptyTrash(owner);
      expect(send.mock.calls).toEqual([['StudioProjectInvalidatedV1', owner.user.id, { projectId: null }]]);
      expect(repository.emptyTrash.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
      expect(websocket.clientBroadcast).not.toHaveBeenCalled();
    });

    it('invalidates the final write when concurrent shelf changes return to the initial state', async () => {
      const initial = { ...project, archivedAt: null };
      repository.getById.mockResolvedValue(initial);
      const { promise, resolve } = Promise.withResolvers<StudioProject>();
      repository.update.mockReturnValueOnce(promise);
      const returningToInitial = sut.update(owner, project.id, { archived: false });
      await vi.waitFor(() => expect(repository.update).toHaveBeenCalledOnce());

      repository.update.mockResolvedValueOnce({ ...initial, archivedAt: new Date() });
      await sut.update(owner, project.id, { archived: true });
      expect(websocket.clientSend).toHaveBeenCalledOnce();
      vi.mocked(websocket.clientSend).mockClear();

      resolve(initial);
      await returningToInitial;
      expect(vi.mocked(websocket.clientSend).mock.calls).toEqual([
        ['StudioProjectInvalidatedV1', owner.user.id, { projectId: project.id }],
      ]);
    });

    it('invalidates both restore and retrash when a trash request read the earlier trashed state', async () => {
      project = { ...project, deletedAt: new Date(), purgeAfter: future() };
      const { promise, resolve } = Promise.withResolvers<StudioProject>();
      repository.trash.mockReturnValueOnce(promise);
      const retrashing = sut.remove(owner, project.id);
      await vi.waitFor(() => expect(repository.trash).toHaveBeenCalledOnce());
      expect(websocket.clientSend).not.toHaveBeenCalled();

      await sut.restoreFromTrash(owner, project.id);
      const event = ['StudioProjectInvalidatedV1', owner.user.id, { projectId: project.id }];
      expect(vi.mocked(websocket.clientSend).mock.calls).toEqual([event]);
      vi.mocked(websocket.clientSend).mockClear();

      resolve(project);
      await retrashing;
      expect(vi.mocked(websocket.clientSend).mock.calls).toEqual([event]);
    });

    it('does not invalidate for refused, failed, missing-row or unrelated mutations', async () => {
      await expect(sut.remove(reviewer, project.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.update(reviewer, project.id, { archived: true })).rejects.toBeInstanceOf(NotFoundException);
      const failure = new Error('write failed');
      repository.update.mockRejectedValueOnce(failure);
      await expect(sut.update(owner, project.id, { archived: true })).rejects.toBe(failure);
      repository.update.mockResolvedValueOnce(undefined);
      await expect(sut.update(owner, project.id, { archived: true })).rejects.toBeInstanceOf(NotFoundException);
      repository.update.mockResolvedValue(project);
      await sut.update(owner, project.id, {});
      await sut.update(owner, project.id, { name: 'Renamed' });
      await sut.restoreFromTrash(owner, project.id);
      project = { ...project, deletedAt: new Date() };
      repository.untrash.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
      await expect(sut.restoreFromTrash(owner, project.id)).rejects.toBe(failure);
      await sut.restoreFromTrash(owner, project.id);
      repository.trash.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
      await expect(sut.remove(owner, project.id)).rejects.toBe(failure);
      await sut.remove(owner, project.id);
      repository.delete.mockRejectedValueOnce(failure);
      await expect(sut.remove(owner, project.id, { permanent: true })).rejects.toBe(failure);
      repository.emptyTrash.mockResolvedValueOnce(0);
      await sut.emptyTrash(owner);
      expect(websocket.clientSend).not.toHaveBeenCalled();
      expect(websocket.clientBroadcast).not.toHaveBeenCalled();
    });

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

    it('keeps a poster whose item is hidden, but shows it only to a session that may see it (FL-195)', async () => {
      const poster = newUuid();
      project = projectStub({ thumbnailAssetId: poster } as never);
      repository.listVisible.mockResolvedValue({ items: [project], total: 1 });

      await expect(sut.get(owner, project.id)).resolves.toMatchObject({ thumbnailAssetId: poster });

      hiddenFromSession.add(poster);
      await expect(sut.get(owner, project.id)).resolves.toMatchObject({ thumbnailAssetId: null });
      const listed = await sut.search(owner, {});
      expect(listed.items.map((item) => item.thumbnailAssetId)).toEqual([null]);
      // the poster stays set: nothing was written
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('tells the owner which placed items are hidden from the session, and a reviewer nothing (FL-195)', async () => {
      const hidden = newUuid();
      const missing = newUuid();
      resources.resolveProjectResources.mockResolvedValue({
        ...manifest(false),
        refused: [hidden, missing].map((id) => ({
          key: `library-asset:${id}`,
          kind: StudioResourceKind.LibraryAsset,
          id,
          graphPath: '$.sequences[0]',
          reason: StudioRefusalReason.NotFound,
          detail: 'No such asset.',
        })),
      });
      hiddenFromSession.add(hidden);
      // the missing one is not the owner's (it does not exist)
      access.asset.checkOwnerAccess.mockImplementation((_userId: string, ids: Set<string>, elevated?: boolean) =>
        Promise.resolve(new Set([...ids].filter((id) => id !== missing && (elevated === true || id !== hidden)))),
      );

      const seen = await sut.get(owner, project.id);
      expect(seen.resources?.hiddenSources).toEqual([hidden]);

      sut.forgetResolutions([project.id]);
      project = projectStub({ spaceId: newUuid() });
      memberOf(project.spaceId as string);
      const reviewed = await sut.get(reviewer, project.id);
      expect(reviewed.resources?.hiddenSources).toEqual([]);
    });

    it('names the placed HDR sources it resolved, so the editor makes the project HDR (FL-97)', async () => {
      const hdr = newUuid();
      const sdr = newUuid();
      const resolved = manifest(true);
      resources.resolveProjectResources.mockResolvedValue({
        ...resolved,
        manifest: {
          ...resolved.manifest,
          entries: [hdr, sdr].map((id) => ({ key: `library-asset:${id}`, kind: StudioResourceKind.LibraryAsset, id })),
        },
      });
      resources.hdrLibraryAssets.mockResolvedValue([hdr]);
      resources.studioHdrProxies.mockResolvedValue([hdr]);

      const seen = await sut.get(owner, project.id);

      expect(seen.resources?.hdrSources).toEqual([hdr]);
      expect(seen.resources?.hdrProxySources).toEqual([hdr]);
      expect(resources.hdrLibraryAssets).toHaveBeenCalledWith([hdr, sdr]);
      expect(resources.studioHdrProxies).toHaveBeenCalledWith([hdr], {
        ownerId: project.ownerId,
        sharedSpace: false,
      });
    });

    it('treats a project as shared-space only while its space is live, shared and still the owner’s (FL-97)', async () => {
      const hdr = newUuid();
      const resolved = manifest(true);
      resources.resolveProjectResources.mockResolvedValue({
        ...resolved,
        manifest: {
          ...resolved.manifest,
          entries: [{ key: `library-asset:${hdr}`, kind: StudioResourceKind.LibraryAsset, id: hdr }],
        },
      });
      resources.hdrLibraryAssets.mockResolvedValue([hdr]);
      project = projectStub({ spaceId: newUuid() });

      // a solo, deleted or left space: personal rules
      repository.isLiveSharedSpaceOf.mockResolvedValue(false);
      await sut.get(owner, project.id);
      expect(repository.isLiveSharedSpaceOf).toHaveBeenCalledWith(project.spaceId, project.ownerId);
      expect(resources.studioHdrProxies).toHaveBeenLastCalledWith([hdr], {
        ownerId: project.ownerId,
        sharedSpace: false,
      });

      repository.isLiveSharedSpaceOf.mockResolvedValue(true);
      await sut.get(owner, project.id);
      expect(resources.studioHdrProxies).toHaveBeenLastCalledWith([hdr], {
        ownerId: project.ownerId,
        sharedSpace: true,
      });
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
