import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { MediaOperationKind, StudioPreviewQuality, StudioPreviewStatus } from 'src/enum.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioPreviewFrame, StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioAuthorizedManifest, StudioResourceService } from 'src/services/studio-resource.service.js';
import { rational } from 'src/utils/rational-time.js';
import { previewETag } from 'src/utils/studio-preview.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const frameStub = (overrides: Partial<StudioPreviewFrame> = {}): StudioPreviewFrame =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    ownerId: authStub.user1.user.id,
    projectId: 'project-1',
    revisionDigest: 'rev-a',
    cacheKey: 'cache-key',
    projectRevision: null,
    grantToken: null,
    grantSessionId: null,
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

const request = (overrides: Record<string, unknown> = {}) =>
  ({
    projectId: 'project-1',
    revisionDigest: 'rev-a',
    time: { numerator: '1001', denominator: '30000' },
    quality: StudioPreviewQuality.Standard,
    viewportWidth: 1920,
    viewportHeight: 1080,
    seekGeneration: 7,
    ...overrides,
  }) as never;

describe(StudioPreviewService.name, () => {
  let sut: StudioPreviewService;
  let mocks: ServiceMocks;
  let previews: StudioPreviewRepository;
  let operations: MediaOperationRepository;
  let resources: StudioResourceService;

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

  beforeEach(() => {
    mocks = getMocks();

    previews = {
      upsert: vi.fn().mockResolvedValue(frameStub({ status: StudioPreviewStatus.Pending, operationId: null })),
      getForOwner: vi.fn(),
      getByCacheKey: vi.fn(),
      getLatestRevisionDigest: vi.fn().mockResolvedValue(undefined),
      listForProject: vi.fn().mockResolvedValue([]),
      markAccessed: vi.fn(),
      markRendering: vi.fn().mockResolvedValue(true),
      publish: vi.fn(),
      markFailed: vi.fn(),
      supersede: vi.fn().mockResolvedValue([]),
      evict: vi.fn().mockResolvedValue([]),
      listExpired: vi.fn().mockResolvedValue([]),
      deleteEvictedBefore: vi.fn(),
    } as unknown as StudioPreviewRepository;

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

    sut = new StudioPreviewService(mocks.logger as never, previews, operations, resources);
  });

  describe('request', () => {
    it('records the request against the exact revision and rational time', async () => {
      await sut.request(authStub.user1, request());

      expect(previews.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: authStub.user1.user.id,
          projectId: 'project-1',
          revisionDigest: 'rev-a',
          timeNumerator: '1001',
          timeDenominator: '30000',
          viewportWidth: 1920,
          viewportHeight: 1080,
        }),
      );
    });

    it('canonicalises the time so the same instant is one cache entry', async () => {
      await sut.request(authStub.user1, request({ time: { numerator: '2002', denominator: '60000' } }));

      expect(previews.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ timeNumerator: '1001', timeDenominator: '30000' }),
      );
    });

    it('creates a durable preview operation carrying the immutable binding', async () => {
      await sut.request(authStub.user1, request());

      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.StudioPreview,
          projectId: 'project-1',
          revisionId: 'rev-a',
          maxAttempts: 1,
          snapshot: expect.objectContaining({
            revisionDigest: 'rev-a',
            time: '1001/30000',
            // FL-90 owns the authorized manifest; a preview with none has nothing it may read.
            manifestDigest: null,
          }),
        }),
      );
    });

    it('does not start a second render for a frame that already has one', async () => {
      vi.mocked(previews.upsert).mockResolvedValue(frameStub({ status: StudioPreviewStatus.Rendering }));

      await sut.request(authStub.user1, request());

      expect(operations.create).not.toHaveBeenCalled();
    });

    it('supersedes and cancels previews of the revision that was replaced', async () => {
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-old');
      vi.mocked(previews.supersede).mockResolvedValue([
        frameStub({ id: 'old-1', revisionDigest: 'rev-old', status: StudioPreviewStatus.Rendering, operationId: 'op-1' }),
      ]);

      const result = await sut.request(authStub.user1, request({ revisionDigest: 'rev-b' }));

      expect(previews.supersede).toHaveBeenCalledWith('project-1', authStub.user1.user.id, 'rev-b');
      expect(operations.requestCancel).toHaveBeenCalledWith('op-1', authStub.user1.user.id);
      expect(result.supersededPreviewIds).toEqual(['old-1']);
      expect(result.currentRevisionDigest).toBe('rev-b');
    });

    it('does not cancel a frame that is already rendered', async () => {
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-old');
      vi.mocked(previews.supersede).mockResolvedValue([
        frameStub({ id: 'old-1', revisionDigest: 'rev-old', status: StudioPreviewStatus.Ready, operationId: 'op-1' }),
      ]);

      await sut.request(authStub.user1, request({ revisionDigest: 'rev-b' }));

      expect(operations.requestCancel).not.toHaveBeenCalled();
    });

    it('refuses a request naming a revision the project has moved past', async () => {
      sut.setRevisionAuthority({ getCurrentRevisionDigest: vi.fn().mockResolvedValue('rev-b') });

      await expect(sut.request(authStub.user1, request({ revisionDigest: 'rev-a' }))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(previews.upsert).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('answers "not found" when the revision authority says the project is not readable', async () => {
      sut.setRevisionAuthority({ getCurrentRevisionDigest: vi.fn().mockResolvedValue(null) });

      await expect(sut.request(authStub.user1, request())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an out-of-range viewport before touching the store', async () => {
      await expect(sut.request(authStub.user1, request({ viewportWidth: 99_999 }))).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(previews.upsert).not.toHaveBeenCalled();
    });

    it('refuses a zero denominator rather than rendering an undefined instant', async () => {
      await expect(
        sut.request(authStub.user1, request({ time: { numerator: '1', denominator: '0' } })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never returns the frame path or the store key', async () => {
      const { preview } = await sut.request(authStub.user1, request());

      expect(preview).not.toHaveProperty('framePath');
      expect(preview).not.toHaveProperty('cacheKey');
      expect(preview).not.toHaveProperty('ownerId');
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

      await expect(
        sut.requestForManifest(authStub.user1, manifest(), {
          time: { numerator: '1001', denominator: '30000' },
          quality: StudioPreviewQuality.Standard,
          viewportWidth: 1920,
          viewportHeight: 1080,
        } as never),
      ).rejects.toThrow('expired');

      expect(previews.upsert).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('binds the frame to the manifest digest, not to the graph revision alone', async () => {
      await sut.requestForManifest(authStub.user1, manifest(), {
        time: { numerator: '1001', denominator: '30000' },
        quality: StudioPreviewQuality.Standard,
        viewportWidth: 1920,
        viewportHeight: 1080,
      } as never);

      expect(previews.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ revisionDigest: 'manifest-digest', projectRevision: 7, grantToken: 'grant-token' }),
      );
    });

    it('issues a viewer-session preview grant and records the manifest on the render snapshot', async () => {
      await sut.requestForManifest(authStub.user1, manifest(), {
        time: { numerator: '0', denominator: '1' },
        quality: StudioPreviewQuality.Draft,
        viewportWidth: 960,
        viewportHeight: 540,
      } as never);

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
        sut.requestForManifest(authStub.user1, manifest({ userId: 'someone-else' }), {
          time: { numerator: '0', denominator: '1' },
          quality: StudioPreviewQuality.Draft,
          viewportWidth: 960,
          viewportHeight: 540,
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never leaks the grant to the browser', async () => {
      const { preview } = await sut.requestForManifest(authStub.user1, manifest(), {
        time: { numerator: '0', denominator: '1' },
        quality: StudioPreviewQuality.Draft,
        viewportWidth: 960,
        viewportHeight: 540,
      } as never);

      expect(preview).not.toHaveProperty('grantToken');
      expect(JSON.stringify(preview)).not.toContain('grant-token');
    });
  });

  describe('get', () => {
    it('answers "not found" for a frame belonging to another account', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(undefined);

      await expect(sut.get(authStub.user1, frameStub().id)).rejects.toBeInstanceOf(NotFoundException);
      expect(previews.getForOwner).toHaveBeenCalledWith(frameStub().id, authStub.user1.user.id);
    });

    it('reports a revision-bound entity tag', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());

      const preview = await sut.get(authStub.user1, frameStub().id);

      expect(preview.etag).toContain('rev-a');
    });
  });

  describe('getFrame', () => {
    const etag = () =>
      previewETag({
        projectId: 'project-1',
        revisionDigest: 'rev-a',
        time: { numerator: 1001n, denominator: 30_000n },
        quality: StudioPreviewQuality.Standard,
        viewportWidth: 1920,
        viewportHeight: 1080,
      });

    it('serves a ready frame on the current revision and records the access', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');

      const result = await sut.getFrame(authStub.user1, frameStub().id, {});

      expect(result).toMatchObject({ etag: etag(), file: expect.objectContaining({ path: '/frames/a.png' }) });
      expect(previews.markAccessed).toHaveBeenCalled();
    });

    it('refuses rather than serves once the revision has advanced', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-b');

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a conditional request for a superseded revision instead of answering 304', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-b');

      await expect(
        sut.getFrame(authStub.user1, frameStub().id, { ifNoneMatch: etag() }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 304 for an unchanged frame on the current revision', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(frameStub());
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');

      await expect(sut.getFrame(authStub.user1, frameStub().id, { ifNoneMatch: etag() })).resolves.toEqual({
        notModified: true,
        etag: etag(),
      });
    });

    it('reports an evicted frame as gone', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ status: StudioPreviewStatus.Evicted, framePath: null }),
      );
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(GoneException);
    });

    it('reports a render in flight as still rendering, not as a missing file', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ status: StudioPreviewStatus.Rendering, framePath: null }),
      );
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers "not found" for a frame belonging to another account', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(undefined);

      await expect(sut.getFrame(authStub.user1, frameStub().id, {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('verifies the FL-90 grant on every request, not once at admission', async () => {
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ grantToken: 'grant-token', grantSessionId: 'session-1' }),
      );
      vi.mocked(previews.getLatestRevisionDigest).mockResolvedValue('rev-a');

      await sut.getFrame(authStub.user1, frameStub().id, {});

      expect(resources.verifyReadGrant).toHaveBeenCalledWith('grant-token', {
        workerId: 'session-1',
        auth: authStub.user1,
      });
    });

    it('stops serving, and drops the frame, the moment the grant stops verifying', async () => {
      // A relock, an unshare or a re-resolution all land here: the picture must stop at once,
      // not at the next render.
      vi.mocked(previews.getForOwner).mockResolvedValue(
        frameStub({ grantToken: 'grant-token', grantSessionId: 'session-1' }),
      );
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
