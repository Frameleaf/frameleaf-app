import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationKind, StudioPreviewQuality, StudioPreviewStatus } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioPreviewFrame, StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioPreviewService, studioPreviewFrameFolder } from 'src/services/studio-preview.service.js';
import {
  StudioProjectService,
  StudioRevisionAuthorization,
  StudioRevisionListener,
} from 'src/services/studio-project.service.js';
import { StudioAuthorizedManifest, StudioResourceService } from 'src/services/studio-resource.service.js';
import { rational } from 'src/utils/rational-time.js';
import { previewETag } from 'src/utils/studio-preview.js';
import { StudioDestination } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

// eslint-friendly alias: a mock whose implementation may return anything, promises included.
type AnyMock = Mock<(...args: any[]) => any>;

const frameStub = (overrides: Partial<StudioPreviewFrame> = {}): StudioPreviewFrame =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    ownerId: authStub.user1.user.id,
    projectId: 'project-1',
    revisionDigest: 'rev-a',
    cacheKey: 'cache-key',
    projectRevision: 7,
    grantToken: 'grant-token',
    grantSessionId: 'session-1',
    timeNumerator: '1001',
    timeDenominator: '30000',
    quality: StudioPreviewQuality.Standard,
    viewportWidth: 1920,
    viewportHeight: 1080,
    status: StudioPreviewStatus.Ready,
    operationId: '0195e2a0-0000-7000-8000-0000000000ff',
    seekGeneration: '7',
    framePath: '/frames/a.png',
    contentType: 'image/png',
    sizeInBytes: '2048',
    frameChecksum: null,
    framePts: '3003',
    framePtsTimebase: '1/90000',
    toneMapped: false,
    errorCode: null,
    requestedAt: new Date('2026-09-22T11:59:00.000Z'),
    readyAt: new Date('2026-09-22T11:59:02.000Z'),
    lastAccessedAt: new Date('2026-09-22T11:59:02.000Z'),
    expiresAt: new Date('2100-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-22T11:59:00.000Z'),
    updatedAt: new Date('2026-09-22T11:59:02.000Z'),
    updateId: 'update-id',
    ...overrides,
  }) as unknown as StudioPreviewFrame;

/** What the client sends: the project and the stored revision it is on, never a graph or digest. */
const request = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId: 'project-1',
    revision: 7,
    time: { numerator: '1001', denominator: '30000' },
    quality: StudioPreviewQuality.Standard,
    viewportWidth: 1920,
    viewportHeight: 1080,
    seekGeneration: 7,
    ...overrides,
  }) as never;

const conflictOf = async (promise: Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected a conflict');
};

describe(StudioPreviewService.name, () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));
  let sut: StudioPreviewService;
  let mocks: ServiceMocks;
  let previews: StudioPreviewRepository;
  let operations: MediaOperationRepository;
  let resources: StudioResourceService;
  let storage: { mkdirSync: AnyMock; stat: AnyMock; unlinkDir: AnyMock };
  let projects: {
    registerRevisionListener: AnyMock;
    authorizeRevision: AnyMock;
    getReadableRevision: AnyMock;
  };

  const manifest = (overrides: Partial<StudioAuthorizedManifest> = {}) =>
    ({
      schemaVersion: 1,
      projectId: 'project-1',
      revision: 7,
      userId: authStub.user1.user.id,
      destination: 'local',
      issuedAt: '2026-09-22T11:58:00.000Z',
      expiresAt: '2100-01-01T00:00:00.000Z',
      complete: true,
      refusedCount: 0,
      entries: [],
      privacy: {
        includesSharedSources: false,
        includesPersonalData: false,
        originalAccess: false,
        leavesMachine: false,
      },
      digest: 'manifest-digest',
      ...overrides,
    }) as unknown as StudioAuthorizedManifest;

  const authorization = (overrides: Partial<StudioRevisionAuthorization> = {}) =>
    ({
      project: { id: 'project-1', ownerId: authStub.user1.user.id, spaceId: null, currentRevision: 7 },
      access: 'owner',
      revision: { projectId: 'project-1', revision: 7, digest: 'graph-digest' },
      envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev-1', graph: { tracks: [] } },
      manifest: manifest(),
      refused: [],
      cached: false,
      ...overrides,
    }) as unknown as StudioRevisionAuthorization;

  const frameRequest = {
    time: { numerator: '0', denominator: '1' },
    quality: StudioPreviewQuality.Draft,
    viewportWidth: 960,
    viewportHeight: 540,
  } as never;

  beforeEach(() => {
    mocks = getMocks();

    previews = {
      upsert: vi.fn().mockResolvedValue({
        frame: frameStub({ status: StudioPreviewStatus.Pending, operationId: null }),
        created: true,
      }),
      getForOwner: vi.fn(),
      getByCacheKey: vi.fn(),
      getLatestRevisionDigest: vi.fn().mockResolvedValue(undefined),
      listForProject: vi.fn().mockResolvedValue([]),
      markAccessed: vi.fn(),
      markRendering: vi.fn().mockResolvedValue(true),
      publish: vi.fn(),
      markFailed: vi.fn(),
      supersede: vi.fn().mockResolvedValue([]),
      supersedeBeforeRevision: vi.fn().mockResolvedValue([]),
      evict: vi.fn().mockResolvedValue([]),
      listExpired: vi.fn().mockResolvedValue([]),
      listRetired: vi.fn().mockResolvedValue([]),
      listLiveForProjects: vi.fn().mockResolvedValue([]),
      deleteEvictedBefore: vi.fn().mockResolvedValue(0),
    } as unknown as StudioPreviewRepository;

    storage = {
      mkdirSync: vi.fn(),
      stat: vi.fn().mockResolvedValue({ isFile: () => true, size: 2048 }),
      unlinkDir: vi.fn().mockResolvedValue(undefined),
    };

    operations = {
      create: vi.fn().mockResolvedValue({ id: '0195e2a0-0000-7000-8000-0000000000ff' }),
      requestCancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaOperationRepository;

    resources = {
      assertAuthorizedManifest: vi.fn(),
      issuePreviewGrant: vi.fn().mockReturnValue('grant-token'),
      verifyReadGrant: vi.fn().mockResolvedValue({ valid: true, grant: {}, path: '' }),
      cacheKey: vi.fn().mockReturnValue('studio:project-1:7:user:local:manifest-digest'),
    } as unknown as StudioResourceService;

    projects = {
      registerRevisionListener: vi.fn(),
      authorizeRevision: vi.fn().mockResolvedValue(authorization()),
      getReadableRevision: vi.fn().mockResolvedValue(7),
    };

    sut = new StudioPreviewService(
      mocks.logger as never,
      previews,
      operations,
      resources,
      projects as unknown as StudioProjectService,
      storage as unknown as StorageRepository,
    );
  });

  describe('render worker publication (FL-96)', () => {
    const operation = {
      id: '0195e2a0-0000-7000-8000-0000000000ff',
      ownerId: authStub.user1.user.id,
      snapshot: { previewFrameId: 'frame-1' },
    } as never;
    let folder: string;
    let output: { path: string; checksum: string; sizeInBytes: string; contentType: string };
    beforeEach(() => {
      folder = studioPreviewFrameFolder(authStub.user1.user.id, 'frame-1');
      output = { path: `${folder}/frame.png`, checksum: 'c'.repeat(64), sizeInBytes: '2048', contentType: 'image/png' };
    });

    it('gives the claim its own frame directory', () => {
      expect(sut.onRenderClaimed(operation)).toBe(folder);
      expect(storage.mkdirSync).toHaveBeenCalledWith(folder);
    });

    it('publishes a frame from its own directory with the requested instant as its PTS', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ id: 'frame-1', status: StudioPreviewStatus.Rendering, framePath: null }),
      );
      vi.mocked(previews.publish).mockResolvedValue(true);

      await expect(sut.onRenderCompleted(operation, output)).resolves.toEqual({ published: true });
      expect(previews.publish).toHaveBeenCalledWith(
        'frame-1',
        'rev-a',
        expect.objectContaining({
          framePath: output.path,
          contentType: 'image/png',
          frameChecksum: Buffer.from(output.checksum, 'hex'),
          framePts: '1001',
          framePtsTimebase: '1/30000',
        }),
      );
      expect(storage.unlinkDir).not.toHaveBeenCalled();
    });

    it('refuses a path outside the frame directory, a non-image and a size mismatch', async () => {
      await expect(sut.onRenderCompleted(operation, { ...output, path: '/etc/passwd' })).rejects.toThrow(
        'inside the directory',
      );
      await expect(sut.onRenderCompleted(operation, { ...output, contentType: 'text/html' })).rejects.toThrow(
        'PNG, JPEG or WebP',
      );
      storage.stat.mockResolvedValueOnce({ isFile: () => true, size: 1 });
      await expect(sut.onRenderCompleted(operation, output)).rejects.toThrow('size does not match');
      expect(previews.publish).not.toHaveBeenCalled();
    });

    it('discards a frame superseded or handed to another render meanwhile', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub({ id: 'frame-1', operationId: 'another' }));
      await expect(sut.onRenderCompleted(operation, output)).resolves.toEqual({ published: false });
      expect(previews.publish).not.toHaveBeenCalled();
      expect(storage.unlinkDir).toHaveBeenCalledWith(folder, { recursive: true, force: true });
    });

    it('marks a frame failed and removes its files', async () => {
      await sut.onRenderFailed(operation, 'gpu_lost');
      expect(previews.markFailed).toHaveBeenCalledWith('frame-1', 'gpu_lost');
      expect(storage.unlinkDir).toHaveBeenCalledWith(folder, { recursive: true, force: true });
    });
  });

  describe('revocation and retention (FL-90, FL-96)', () => {
    it('evicts live frames with their files and cancels renders still in flight', async () => {
      const ready = frameStub({ id: 'ready-1' });
      const rendering = frameStub({ id: 'rendering-1', status: StudioPreviewStatus.Rendering, operationId: 'op-2' });
      vi.mocked(previews.listLiveForProjects).mockResolvedValue([ready, rendering]);

      await expect(sut.revokeForProjects(['project-1'], 'user-2')).resolves.toBe(2);
      expect(previews.listLiveForProjects).toHaveBeenCalledWith(['project-1'], 'user-2');
      expect(operations.requestCancel).toHaveBeenCalledTimes(1);
      expect(operations.requestCancel).toHaveBeenCalledWith('op-2', rendering.ownerId);
      expect(previews.evict).toHaveBeenCalledWith(['ready-1', 'rendering-1']);
      expect(storage.unlinkDir).toHaveBeenCalledTimes(2);
    });

    it('sweeps retired frames and old tombstones', async () => {
      const expired = frameStub({ id: 'old-1' });
      vi.mocked(previews.listRetired).mockResolvedValue([expired]);
      const now = new Date('2026-09-25T12:00:00.000Z');

      await sut.sweep(now);

      expect(previews.listRetired).toHaveBeenCalledWith(now, new Date('2026-09-25T11:50:00.000Z'), 500);
      expect(previews.evict).toHaveBeenCalledWith(['old-1']);
      expect(storage.unlinkDir).toHaveBeenCalledWith(studioPreviewFrameFolder(expired.ownerId, 'old-1'), {
        recursive: true,
        force: true,
      });
      expect(previews.deleteEvictedBefore).toHaveBeenCalledWith(new Date('2026-09-24T12:00:00.000Z'), 500);
    });
  });

  describe('request (bound to FL-89 stored revisions)', () => {
    it('resolves the stored head through project storage for this account, locally', async () => {
      await sut.request(authStub.user1, request());

      expect(projects.authorizeRevision).toHaveBeenCalledWith(authStub.user1, {
        projectId: 'project-1',
        destination: StudioDestination.Local,
      });
    });

    it('binds the frame to the authorized manifest of the stored revision, never to a client value', async () => {
      await sut.request(authStub.user1, request());

      expect(previews.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          projectId: 'project-1',
          revisionDigest: 'manifest-digest',
          projectRevision: 7,
          grantToken: 'grant-token',
          timeNumerator: '1001',
          timeDenominator: '30000',
          viewportWidth: 1920,
          viewportHeight: 1080,
        }),
      );
    });

    it('reports the stored revision it answered for', async () => {
      const result = await sut.request(authStub.user1, request());

      expect(result.currentRevision).toBe(7);
      expect(result.preview.revision).toBe(7);
    });

    it('canonicalises the time so the same instant is one cache entry', async () => {
      await sut.request(authStub.user1, request({ time: { numerator: '2002', denominator: '60000' } }));

      expect(previews.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ timeNumerator: '1001', timeDenominator: '30000' }),
      );
    });

    it('creates a durable preview operation naming the stored revision and carrying no graph', async () => {
      await sut.request(authStub.user1, request());

      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.StudioPreview,
          projectId: 'project-1',
          revisionId: 'manifest-digest',
          maxAttempts: 1,
          snapshot: expect.objectContaining({
            time: '1001/30000',
            manifestDigest: 'manifest-digest',
            projectRevision: 7,
            // FL-95's renderer reads the graph from storage and resolves it as a background runner.
            studio: { stored: true, revision: 7, cloudConsent: false },
          }),
        }),
      );
      const { snapshot } = vi.mocked(operations.create).mock.calls[0][0] as { snapshot: Record<string, any> };
      expect(snapshot.studio).not.toHaveProperty('graph');
      expect(JSON.stringify(snapshot)).not.toContain('tracks');
    });

    it('refuses a request naming a revision the project has moved past, with the current one', async () => {
      projects.authorizeRevision.mockResolvedValue(
        authorization({ revision: { projectId: 'project-1', revision: 8, digest: 'graph-8' } as never }),
      );

      const body = await conflictOf(sut.request(authStub.user1, request({ revision: 7 })));

      expect(body).toEqual(expect.objectContaining({ code: 'studio_preview_stale_revision', currentRevision: 8 }));
      expect(previews.upsert).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses, without issuing a grant, when a source is unavailable to this account', async () => {
      // Locked, trashed, unshared: the interactive resolution refuses it, so no frame is rendered.
      projects.authorizeRevision.mockResolvedValue(
        authorization({ manifest: manifest({ complete: false, refusedCount: 1 }) }),
      );

      const body = await conflictOf(sut.request(authStub.user1, request()));

      expect(body).toEqual(expect.objectContaining({ code: 'studio_preview_sources_refused', refusedCount: 1 }));
      expect(resources.issuePreviewGrant).not.toHaveBeenCalled();
      expect(previews.upsert).not.toHaveBeenCalled();
    });

    it('answers "not found" when the account may not read the project', async () => {
      projects.authorizeRevision.mockRejectedValue(new NotFoundException('Studio project not found'));

      await expect(sut.request(authStub.user1, request())).rejects.toBeInstanceOf(NotFoundException);
      expect(previews.upsert).not.toHaveBeenCalled();
    });

    it('refuses an out-of-range viewport before resolving anything', async () => {
      await expect(sut.request(authStub.user1, request({ viewportWidth: 99_999 }))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(projects.authorizeRevision).not.toHaveBeenCalled();
      expect(previews.upsert).not.toHaveBeenCalled();
    });

    it('refuses a zero denominator rather than rendering an undefined instant', async () => {
      await expect(
        sut.request(authStub.user1, request({ time: { numerator: '1', denominator: '0' } })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(projects.authorizeRevision).not.toHaveBeenCalled();
    });

    it('does not start a second render for a frame that already has one', async () => {
      vi.mocked(previews.upsert).mockResolvedValue({
        frame: frameStub({ status: StudioPreviewStatus.Rendering }),
        created: false,
      });

      await sut.request(authStub.user1, request());

      expect(operations.create).not.toHaveBeenCalled();
    });

    it('does not start a render for a pending row another request created', async () => {
      vi.mocked(previews.upsert).mockResolvedValue({
        frame: frameStub({ status: StudioPreviewStatus.Pending, operationId: null }),
        created: false,
      });

      await sut.request(authStub.user1, request());

      expect(operations.create).not.toHaveBeenCalled();
    });

    it('renders a revived row again (evicted, superseded or failed before)', async () => {
      vi.mocked(previews.upsert).mockResolvedValue({
        frame: frameStub({ status: StudioPreviewStatus.Pending, operationId: null, framePath: null }),
        created: true,
      });

      const { preview } = await sut.request(authStub.user1, request());

      expect(operations.create).toHaveBeenCalledTimes(1);
      expect(previews.markRendering).toHaveBeenCalledWith(frameStub().id, '0195e2a0-0000-7000-8000-0000000000ff');
      expect(preview.status).toBe(StudioPreviewStatus.Rendering);
    });

    it('cancels the operation it just created when the row stopped waiting for it', async () => {
      vi.mocked(previews.markRendering).mockResolvedValue(false);

      const { preview } = await sut.request(authStub.user1, request());

      expect(operations.requestCancel).toHaveBeenCalledWith(
        '0195e2a0-0000-7000-8000-0000000000ff',
        authStub.user1.user.id,
      );
      expect(preview.status).toBe(StudioPreviewStatus.Pending);
    });

    it('never shares a row between accounts previewing the same project and revision', async () => {
      projects.authorizeRevision.mockImplementation((auth: typeof authStub.user1) =>
        Promise.resolve(authorization({ manifest: manifest({ userId: auth.user.id }) })),
      );

      await sut.request(authStub.user1, request());
      await sut.request(authStub.admin, request());

      const [first, second] = vi.mocked(previews.upsert).mock.calls.map(([row]) => row);
      expect(first.ownerId).toBe(authStub.user1.user.id);
      expect(second.ownerId).toBe(authStub.admin.user.id);
      expect(first.cacheKey).not.toBe(second.cacheKey);
    });

    it('supersedes and cancels previews bound to an earlier resolution', async () => {
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('older-manifest-digest');
      vi.mocked(previews.supersede).mockResolvedValue([
        frameStub({
          id: 'old-1',
          revisionDigest: 'older-manifest-digest',
          status: StudioPreviewStatus.Rendering,
          operationId: 'op-1',
        }),
      ]);

      const result = await sut.request(authStub.user1, request());

      expect(previews.supersede).toHaveBeenCalledWith('project-1', authStub.user1.user.id, 'manifest-digest');
      expect(operations.requestCancel).toHaveBeenCalledWith('op-1', authStub.user1.user.id);
      expect(result.supersededPreviewIds).toEqual(['old-1']);
    });

    it('does not cancel a frame that is already rendered', async () => {
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('older-manifest-digest');
      vi.mocked(previews.supersede).mockResolvedValue([
        frameStub({
          id: 'old-1',
          revisionDigest: 'older-manifest-digest',
          status: StudioPreviewStatus.Ready,
          operationId: 'op-1',
        }),
      ]);

      await sut.request(authStub.user1, request());

      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('never returns the frame path, the store key or the grant', async () => {
      const { preview } = await sut.request(authStub.user1, request());

      expect(preview).not.toHaveProperty('framePath');
      expect(preview).not.toHaveProperty('cacheKey');
      expect(preview).not.toHaveProperty('ownerId');
      expect(preview).not.toHaveProperty('grantToken');
      expect(JSON.stringify(preview)).not.toContain('grant-token');
    });

    it('echoes the seek generation so a late frame can be discarded', async () => {
      await sut.request(authStub.user1, request({ seekGeneration: 12 }));

      expect(previews.upsert).toHaveBeenCalledWith(expect.objectContaining({ seekGeneration: '12' }));
    });
  });

  describe('requestForManifest (FL-90)', () => {
    it('asserts the manifest before anything is recorded or enqueued', async () => {
      vi.mocked(resources.assertAuthorizedManifest).mockImplementation(() => {
        throw new Error('expired');
      });

      await expect(sut.requestForManifest(authStub.user1, manifest(), frameRequest)).rejects.toThrow('expired');

      expect(previews.upsert).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('issues a viewer-session preview grant and records the manifest on the render snapshot', async () => {
      await sut.requestForManifest(authStub.user1, manifest(), frameRequest);

      expect(resources.issuePreviewGrant).toHaveBeenCalledWith(
        expect.objectContaining({ digest: 'manifest-digest' }),
        expect.objectContaining({ workerId: expect.any(String) }),
      );
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ manifestDigest: 'manifest-digest', projectRevision: 7 }),
        }),
      );
    });

    it('answers "not found" for a manifest resolved for another account', async () => {
      await expect(
        sut.requestForManifest(authStub.user1, manifest({ userId: 'someone-else' }), frameRequest),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('revision commits (FL-89 listener)', () => {
    const listener = (): StudioRevisionListener => projects.registerRevisionListener.mock.calls[0][0];

    it('registers with project storage at startup', () => {
      expect(projects.registerRevisionListener).toHaveBeenCalledTimes(1);
    });

    it("supersedes every account's previews of earlier revisions and cancels the ones rendering", async () => {
      vi.mocked(previews.supersedeBeforeRevision).mockResolvedValue([
        frameStub({ id: 'owner-1', status: StudioPreviewStatus.Rendering, operationId: 'op-owner' }),
        frameStub({
          id: 'reviewer-1',
          ownerId: authStub.admin.user.id,
          status: StudioPreviewStatus.Pending,
          operationId: 'op-reviewer',
        }),
        frameStub({ id: 'ready-1', status: StudioPreviewStatus.Ready, operationId: 'op-ready' }),
      ]);

      await listener()({
        projectId: 'project-1',
        ownerId: authStub.user1.user.id,
        revision: 8,
        digest: 'graph-8',
        restoredFromRevision: null,
      });

      expect(previews.supersedeBeforeRevision).toHaveBeenCalledWith('project-1', 8);
      // Each operation is cancelled as the account it belongs to, not as the project owner.
      expect(operations.requestCancel).toHaveBeenCalledWith('op-owner', authStub.user1.user.id);
      expect(operations.requestCancel).toHaveBeenCalledWith('op-reviewer', authStub.admin.user.id);
      expect(operations.requestCancel).not.toHaveBeenCalledWith('op-ready', expect.anything());
    });
  });

  describe('get', () => {
    it('answers "not found" for a frame belonging to another account', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(undefined);

      await expect(sut.get(authStub.user1, frameStub().id)).rejects.toBeInstanceOf(NotFoundException);
      expect(previews.getForOwner).toHaveBeenCalledWith(frameStub().id, authStub.user1.user.id);
    });

    it('reports a binding-bound entity tag and the stored revision', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());

      const preview = await sut.get(authStub.user1, frameStub().id);

      expect(preview.etag).toContain('rev-a');
      expect(preview.revision).toBe(7);
    });
  });

  describe('getFrame', () => {
    const etag = () =>
      previewETag({
        ownerId: authStub.user1.user.id,
        projectId: 'project-1',
        revisionDigest: 'rev-a',
        time: rational(1001, 30_000),
        quality: StudioPreviewQuality.Standard,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

    beforeEach(() => {
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');
    });

    it('serves a ready frame on the current revision and records the access', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());

      const result = await sut.getFrame(authStub.user1, frameStub().id, {});

      expect(result).toMatchObject({ etag: etag(), file: expect.objectContaining({ path: '/frames/a.png' }) });
      expect(previews.markAccessed).toHaveBeenCalled();
      expect(projects.getReadableRevision).toHaveBeenCalledWith('project-1', authStub.user1.user.id);
    });

    it('refuses once the stored revision has advanced, even before any new preview was asked for', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      projects.getReadableRevision.mockResolvedValue(8);

      const body = await conflictOf(sut.getFrame(authStub.user1, frameStub().id, {}));

      expect(body).toEqual(expect.objectContaining({ code: 'studio_preview_stale_revision', currentRevision: 8 }));
      expect(previews.markAccessed).not.toHaveBeenCalled();
    });

    it('refuses a frame bound to an earlier resolution of the same revision', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-b');

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a conditional request for a superseded revision instead of answering 304', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      projects.getReadableRevision.mockResolvedValue(8);

      await expect(sut.getFrame(authStub.user1, frameStub().id, { ifNoneMatch: etag() })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses a row recorded before previews were bound to project storage', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ projectRevision: null, grantToken: null, grantSessionId: null }),
      );

      const body = await conflictOf(sut.getFrame(authStub.user1, frameStub().id, {}));

      expect(body).toEqual(expect.objectContaining({ code: 'studio_preview_stale_revision' }));
    });

    it('answers "not found", and drops the frame, once the account may no longer read the project', async () => {
      // A reviewer removed from the space, or a deleted project.
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      projects.getReadableRevision.mockResolvedValue(null);

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(previews.evict).toHaveBeenCalledWith([frameStub().id]);
      expect(previews.markAccessed).not.toHaveBeenCalled();
    });

    it('answers 304 for an unchanged frame on the current revision', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());

      await expect(sut.getFrame(authStub.user1, frameStub().id, { ifNoneMatch: etag() })).resolves.toEqual({
        notModified: true,
        etag: etag(),
      });
    });

    it('reports an evicted frame as gone', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ status: StudioPreviewStatus.Evicted, framePath: null }),
      );

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(GoneException);
    });

    it('reports a render in flight as still rendering, not as a missing file', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ status: StudioPreviewStatus.Rendering, framePath: null }),
      );

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers "not found" for a frame belonging to another account', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(undefined);

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(projects.getReadableRevision).not.toHaveBeenCalled();
    });

    it('verifies the FL-90 grant on every request, not once at admission', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());

      await sut.getFrame(authStub.user1, frameStub().id, {});

      expect(resources.verifyReadGrant).toHaveBeenCalledWith('grant-token', {
        workerId: 'session-1',
        auth: authStub.user1,
      });
    });

    it('stops serving, and drops the frame, the moment the grant stops verifying', async () => {
      // An expired grant or a re-resolution lands here: the picture must stop at once, not at the
      // next render.
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(resources.verifyReadGrant).mockResolvedValue({
        valid: false,
        reason: 'expired',
        detail: 'gone',
      } as never);

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(ConflictException);
      expect(previews.evict).toHaveBeenCalledWith([frameStub().id]);
    });
  });

  describe('cancel', () => {
    it('releases the frame and stops the render', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub({ status: StudioPreviewStatus.Rendering }));
      vi.mocked(previews.evict).mockResolvedValue([frameStub({ status: StudioPreviewStatus.Evicted })]);

      const preview = await sut.cancel(authStub.user1, frameStub().id);

      expect(previews.evict).toHaveBeenCalledWith([frameStub().id]);
      expect(operations.requestCancel).toHaveBeenCalledWith(frameStub().operationId, authStub.user1.user.id);
      expect(preview.status).toBe(StudioPreviewStatus.Evicted);
    });
  });
});
