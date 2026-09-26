import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  MediaOperationCheckpointState,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  RenderWorkerStatus,
} from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  RenderWorker,
  RenderWorkerRepository,
  RenderWorkerSession,
} from 'src/repositories/render-worker.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { RenderWorkerService } from 'src/services/render-worker.service.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { StudioAuthorizedManifest, StudioResourceService } from 'src/services/studio-resource.service.js';
import { signInputGrant } from 'src/utils/render-admission.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const OWNER_A = 'owner-a';
const OWNER_B = 'owner-b';
const SESSION_A = 'session-token-a';
const SESSION_B = 'session-token-b';

/** Mirrors the crypto mock: `hashSha256(x)` is `Buffer.from(`${x} (hashed)`)`. */
const hashed = (value: string) => Buffer.from(`${value} (hashed)`);

const workerStub = (overrides: Partial<RenderWorker> = {}): RenderWorker =>
  ({
    id: '0195e2a0-0000-7000-8000-00000000aaa1',
    name: 'Basement GPU',
    destination: MediaOperationDestination.Lan,
    status: RenderWorkerStatus.Active,
    enrolmentSecret: hashed('secret-a'),
    kinds: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
    engineDigest: 'engine-1',
    conformanceMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    lastConformanceReportedAt: null,
    maxConcurrentOperations: 2,
    maxWallClockMs: null,
    maxOutputBytes: '1000',
    gpuMemoryBytes: String(24 * 1024 ** 3),
    lastAdmittedAt: null,
    lastSeenAt: null,
    revokedAt: null,
    createdBy: authStub.admin.user.id,
    createdAt: new Date('2026-09-22T09:00:00.000Z'),
    updatedAt: new Date('2026-09-22T09:00:00.000Z'),
    updateId: 'update-id',
    ...overrides,
  }) as unknown as RenderWorker;

const sessionStub = (
  worker: RenderWorker,
  token: string,
  overrides: Partial<RenderWorkerSession> = {},
): RenderWorkerSession =>
  ({
    id: `session-${token}`,
    workerId: worker.id,
    token: hashed(token),
    scopes: worker.kinds,
    gpuMemoryBytes: worker.gpuMemoryBytes,
    engineDigest: 'engine-1',
    conformanceReportedAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  }) as unknown as RenderWorkerSession;

const operationStub = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    ownerId: OWNER_A,
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Queued,
    destination: MediaOperationDestination.Lan,
    destinationDetail: null,
    label: 'Summer in the Rockies',
    assetId: '11111111-1111-4111-8111-111111111111',
    resultAssetId: null,
    retryOfId: null,
    projectId: 'project-1',
    revisionId: 'revision-7',
    snapshot: { engineDigest: 'engine-1' },
    settings: { resolution: '3840×2160' },
    estimate: null,
    progress: 0,
    processedUnits: '0',
    totalUnits: null,
    attempt: 0,
    maxAttempts: 3,
    claimToken: null,
    claimedBy: null,
    claimExpiresAt: null,
    heartbeatAt: null,
    lastAdmissionRefusalReason: null,
    lastAdmissionRefusedAt: null,
    admissionRefusals: 0,
    outputBytes: '0',
    attemptStartedAt: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    remoteJobId: null,
    remoteReleasedAt: null,
    error: null,
    errorCode: null,
    startedAt: null,
    finishedAt: null,
    dismissedAt: null,
    createdAt: new Date('2026-09-22T09:49:00.000Z'),
    updatedAt: new Date('2026-09-22T09:59:00.000Z'),
    updateId: 'update-id',
    ...overrides,
  }) as unknown as MediaOperation;

/** A Studio export whose immutable snapshot carries the graph FL-90 re-resolves at claim time. */
const studioOperationStub = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  operationStub({
    id: '0195e2a0-0000-7000-8000-0000000000aa',
    assetId: null,
    projectId: 'project-1',
    snapshot: {
      engineDigest: 'engine-1',
      studio: { graph: { sequence: [{ assetId: 'clip-1' }] }, revision: 7, cloudConsent: false },
    },
    ...overrides,
  });

const studioManifestStub = (overrides: Partial<StudioAuthorizedManifest> = {}): StudioAuthorizedManifest => ({
  schemaVersion: 1,
  projectId: 'project-1',
  revision: 7,
  userId: OWNER_A,
  destination: StudioDestination.Lan,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  complete: true,
  refusedCount: 0,
  entries: [
    {
      key: 'library-asset:clip-1',
      kind: StudioResourceKind.LibraryAsset,
      id: 'clip-1',
      graphPath: '$.sequence[0]',
      ownerId: OWNER_A,
      checksum: 'sum-1',
      path: '/library/owner-a/clip-1.mov',
      sourceAccess: 'owner',
      grant: 'render',
    },
    {
      key: 'font:inter',
      kind: StudioResourceKind.Font,
      id: 'inter',
      graphPath: '$.titles[0].font',
      ownerId: null,
      checksum: 'sum-font',
      path: '/deployment/fonts/inter.ttf',
      sourceAccess: 'deployment',
      grant: 'render',
    },
    {
      key: 'preset:transition:Dissolve',
      kind: StudioResourceKind.Preset,
      id: 'Dissolve',
      graphPath: '$.sequence[0].transition',
      ownerId: null,
      checksum: null,
      path: null,
      sourceAccess: 'deployment',
      grant: 'none',
    },
  ],
  privacy: { includesSharedSources: false, includesPersonalData: false, originalAccess: false, leavesMachine: false },
  digest: 'digest-1',
  ...overrides,
});

describe(RenderWorkerService.name, () => {
  let sut: RenderWorkerService;
  let mocks: ServiceMocks;
  let workers: RenderWorkerRepository;
  let operations: MediaOperationRepository;
  let studioResources: {
    resolveProjectResources: ReturnType<typeof vi.fn>;
    issueReadGrants: ReturnType<typeof vi.fn>;
    verifyReadGrant: ReturnType<typeof vi.fn>;
  };
  let studioExports: Record<
    | 'onRenderClaimed'
    | 'onRenderCompleted'
    | 'onRenderFailed'
    | 'onRenderCancelAcknowledged'
    | 'listRemoteReferences'
    | 'acknowledgeRemoteReference',
    ReturnType<typeof vi.fn>
  >;
  let studioPreviews: Record<'onRenderClaimed' | 'onRenderCompleted' | 'onRenderFailed', ReturnType<typeof vi.fn>>;
  let studioProjects: {
    getById: ReturnType<typeof vi.fn>;
    getRevision: ReturnType<typeof vi.fn>;
  };

  const workerA = workerStub();
  const workerB = workerStub({
    id: '0195e2a0-0000-7000-8000-00000000bbb2',
    name: 'Attic GPU',
    enrolmentSecret: hashed('secret-b'),
  });
  const sessionA = sessionStub(workerA, SESSION_A);
  const sessionB = sessionStub(workerB, SESSION_B);

  /** Route the session lookup by digest the way the repository does. */
  const installSessions = (...entries: Array<{ worker: RenderWorker; session: RenderWorkerSession }>) => {
    vi.mocked(workers.getSessionByToken).mockImplementation((token: Buffer) =>
      Promise.resolve(entries.find((entry) => entry.session.token.equals(token))),
    );
  };

  beforeEach(() => {
    mocks = getMocks();
    workers = {
      createWorker: vi.fn(),
      getWorker: vi.fn().mockResolvedValue(workerA),
      getWorkerBySecret: vi.fn(),
      listWorkers: vi.fn().mockResolvedValue([]),
      updateWorker: vi.fn(),
      markAdmitted: vi.fn().mockResolvedValue(undefined),
      markSeen: vi.fn().mockResolvedValue(undefined),
      revokeWorker: vi.fn(),
      createSession: vi.fn(),
      getSessionByToken: vi.fn().mockResolvedValue(undefined),
      touchSession: vi.fn().mockResolvedValue(undefined),
      revokeSessions: vi.fn().mockResolvedValue(0),
      getLimit: vi.fn().mockResolvedValue(undefined),
      listLimits: vi.fn().mockResolvedValue([]),
      upsertLimit: vi.fn(),
      deleteLimit: vi.fn().mockResolvedValue(true),
      recordAudit: vi.fn().mockResolvedValue(undefined),
      listAudit: vi.fn().mockResolvedValue([]),
      countActiveForWorker: vi.fn().mockResolvedValue(0),
      countActiveForOwner: vi.fn().mockResolvedValue(0),
      peekQueued: vi.fn().mockResolvedValue([]),
      claimQueued: vi.fn(),
      recordRefusal: vi.fn().mockResolvedValue(undefined),
      getClaimed: vi.fn().mockResolvedValue(undefined),
      getClaimedByWorker: vi.fn().mockResolvedValue(undefined),
      recordOutputBytes: vi.fn().mockResolvedValue(true),
      recordSessionCapabilities: vi.fn().mockResolvedValue(undefined),
      getSessionCapabilities: vi.fn().mockResolvedValue(undefined),
    } as unknown as RenderWorkerRepository;

    operations = {
      getCheckpoints: vi.fn().mockResolvedValue([]),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      upsertCheckpoint: vi.fn().mockResolvedValue(true),
      completeCheckpoint: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      invalidateCheckpointsFrom: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
      isPublishableResult: vi.fn().mockResolvedValue(true),
    } as unknown as MediaOperationRepository;

    studioResources = {
      resolveProjectResources: vi.fn(),
      issueReadGrants: vi.fn().mockReturnValue([]),
      verifyReadGrant: vi.fn(),
    };
    studioProjects = {
      getById: vi.fn().mockResolvedValue(undefined),
      getRevision: vi.fn().mockResolvedValue(undefined),
    };
    studioExports = {
      onRenderClaimed: vi.fn().mockResolvedValue(undefined),
      onRenderCompleted: vi.fn().mockResolvedValue({ accepted: true }),
      onRenderFailed: vi.fn().mockResolvedValue(undefined),
      onRenderCancelAcknowledged: vi.fn().mockResolvedValue(undefined),
      listRemoteReferences: vi.fn().mockResolvedValue([]),
      acknowledgeRemoteReference: vi.fn().mockResolvedValue(true),
    };
    studioPreviews = {
      onRenderClaimed: vi.fn().mockReturnValue('/data/exports/owner/studio-previews/frame'),
      onRenderCompleted: vi.fn().mockResolvedValue({ published: true }),
      onRenderFailed: vi.fn().mockResolvedValue(undefined),
    };
    mocks.user.get.mockImplementation((id: string) =>
      Promise.resolve(id === OWNER_A ? { ...userStub.user1, id: OWNER_A } : undefined),
    );

    sut = new RenderWorkerService(
      mocks.logger as never,
      workers,
      operations,
      mocks.crypto as never,
      mocks.access as never,
      mocks.asset as never,
      mocks.user as never,
      studioResources as unknown as StudioResourceService,
      studioProjects as unknown as StudioProjectRepository,
      studioExports as unknown as StudioExportService,
      studioPreviews as unknown as StudioPreviewService,
    );

    installSessions({ worker: workerA, session: sessionA }, { worker: workerB, session: sessionB });
  });

  describe('create', () => {
    it('stores only the digest of the enrolment secret and returns the secret once', async () => {
      vi.mocked(workers.createWorker).mockImplementation((dto) =>
        Promise.resolve(workerStub({ ...dto, id: workerA.id } as never)),
      );

      const response = await sut.create(authStub.admin, {
        name: 'Basement GPU',
        destination: MediaOperationDestination.Lan,
        kinds: [MediaOperationKind.StudioExport],
      } as never);

      expect(response.enrolmentSecret).toBe(mocks.crypto.randomBytesAsText(32));
      expect(workers.createWorker).toHaveBeenCalledWith(
        expect.objectContaining({
          enrolmentSecret: hashed(response.enrolmentSecret),
          createdBy: authStub.admin.user.id,
        }),
      );
      expect(response.worker).not.toHaveProperty('enrolmentSecret');
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ event: RenderWorkerAuditEvent.Enrolled, actorId: authStub.admin.user.id }),
      );
      const audit = vi.mocked(workers.recordAudit).mock.calls[0][0];
      expect(JSON.stringify(audit)).not.toContain(response.enrolmentSecret);
    });

    it.each([
      MediaOperationKind.Bulk,
      MediaOperationKind.StudioBundleExport,
      MediaOperationKind.EnrichmentPlan,
      MediaOperationKind.MediaHealth,
      MediaOperationKind.ICloudSync,
      MediaOperationKind.TakeoutImport,
      MediaOperationKind.PhysicalDeduplication,
    ])('refuses to enrol a worker for %s, whatever its destination (FL-73)', async (kind) => {
      await expect(
        sut.create(authStub.admin, {
          name: 'Local box',
          destination: MediaOperationDestination.Local,
          kinds: [MediaOperationKind.StudioExport, kind],
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(workers.createWorker).not.toHaveBeenCalled();
    });

    it('refuses to re-scope a worker to a server-side kind (FL-73)', async () => {
      await expect(
        sut.update(authStub.admin, workerA.id, { kinds: [MediaOperationKind.TakeoutImport] } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(workers.updateWorker).not.toHaveBeenCalled();
    });
  });

  describe('admit', () => {
    const admission = {
      workerId: workerA.id,
      enrolmentSecret: 'secret-a',
      engineDigest: 'engine-1',
      conformanceReportedAt: new Date(Date.now() - 60_000).toISOString(),
      softwareRenderer: false,
      gpuMemoryBytes: String(8 * 1024 ** 3),
    };

    it('refuses an unknown secret generically and audits the refusal', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(undefined);

      await expect(sut.admit(admission as never)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(workers.createSession).not.toHaveBeenCalled();
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          event: RenderWorkerAuditEvent.Refused,
          reason: RenderWorkerRefusalReason.InvalidCredential,
        }),
      );
    });

    it('refuses a valid secret presented under another worker’s id', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(workerA);

      await expect(sut.admit({ ...admission, workerId: workerB.id } as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(workers.createSession).not.toHaveBeenCalled();
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: workerA.id, reason: RenderWorkerRefusalReason.InvalidCredential }),
      );
    });

    it('refuses a revoked worker with a still-valid secret', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(
        workerStub({ status: RenderWorkerStatus.Revoked, revokedAt: new Date() }),
      );

      await expect(sut.admit(admission as never)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ reason: RenderWorkerRefusalReason.WorkerRevoked }),
      );
    });

    it('refuses a replayed conformance report', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(
        workerStub({ lastConformanceReportedAt: new Date(admission.conformanceReportedAt) }),
      );

      await expect(sut.admit(admission as never)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ reason: RenderWorkerRefusalReason.ConformanceReplayed }),
      );
    });

    it('refuses a software renderer and a mismatched engine digest', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(workerA);

      await expect(sut.admit({ ...admission, softwareRenderer: true } as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(sut.admit({ ...admission, engineDigest: 'engine-2' } as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(workers.createSession).not.toHaveBeenCalled();
    });

    it('issues a scoped session stored by digest, capped to the qualified GPU memory', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(workerA);
      vi.mocked(workers.createSession).mockImplementation((dto) => Promise.resolve(dto as never));

      const session = await sut.admit(admission as never);

      expect(session.sessionToken).toBe(mocks.crypto.randomBytesAsText(32));
      expect(session.scopes).toEqual(workerA.kinds);
      expect(workers.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: workerA.id,
          token: hashed(session.sessionToken),
          scopes: workerA.kinds,
          gpuMemoryBytes: String(8 * 1024 ** 3),
        }),
      );
      expect(workers.markAdmitted).toHaveBeenCalledWith(workerA.id, new Date(admission.conformanceReportedAt));
      const audits = vi.mocked(workers.recordAudit).mock.calls.map(([entry]) => JSON.stringify(entry));
      expect(audits.some((entry) => entry.includes(session.sessionToken))).toBe(false);
      expect(audits.some((entry) => entry.includes('secret-a'))).toBe(false);
    });

    it('binds the codecs and containers the check verified to the new session (FL-95)', async () => {
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(workerA);
      vi.mocked(workers.createSession).mockImplementation((dto) =>
        Promise.resolve({ ...dto, id: 'session-new' } as never),
      );

      await sut.admit({ ...admission, codecs: ['hevc_nvenc'], formats: ['mp4'] } as never);

      expect(workers.recordSessionCapabilities).toHaveBeenCalledWith('session-new', {
        codecs: ['hevc_nvenc'],
        formats: ['mp4'],
      });
    });

    it('scopes the session to renders only, even for a worker enrolled with a server-side kind (FL-73)', async () => {
      const legacy = workerStub({ kinds: [MediaOperationKind.QuickEdit, MediaOperationKind.Bulk] as never });
      vi.mocked(workers.getWorkerBySecret).mockResolvedValue(legacy);
      vi.mocked(workers.createSession).mockImplementation((dto) => Promise.resolve(dto as never));

      const session = await sut.admit(admission as never);

      expect(session.scopes).toEqual([MediaOperationKind.QuickEdit]);
      expect(workers.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: [MediaOperationKind.QuickEdit] }),
      );
    });
  });

  describe('authenticate', () => {
    it('rejects a missing, unknown, expired or revoked session and a revoked worker', async () => {
      await expect(sut.authenticate(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.authenticate('nope')).rejects.toBeInstanceOf(UnauthorizedException);

      installSessions({ worker: workerA, session: sessionStub(workerA, SESSION_A, { expiresAt: new Date(0) }) });
      await expect(sut.authenticate(SESSION_A)).rejects.toBeInstanceOf(UnauthorizedException);

      installSessions({ worker: workerA, session: sessionStub(workerA, SESSION_A, { revokedAt: new Date() }) });
      await expect(sut.authenticate(SESSION_A)).rejects.toBeInstanceOf(UnauthorizedException);

      installSessions({ worker: workerStub({ status: RenderWorkerStatus.Revoked }), session: sessionA });
      await expect(sut.authenticate(SESSION_A)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('claim', () => {
    const queued = operationStub();

    beforeEach(() => {
      vi.mocked(workers.peekQueued)
        .mockResolvedValueOnce([queued] as never)
        .mockResolvedValue([]);
      vi.mocked(workers.claimQueued).mockImplementation(({ id, workerId }) =>
        Promise.resolve({
          operation: operationStub({
            id,
            status: MediaOperationStatus.Preparing,
            claimToken: 'claim-1',
            claimedBy: workerId,
            attempt: 1,
          }) as never,
          claimToken: 'claim-1',
        }),
      );
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([queued.assetId!]));
    });

    it('hands out the claim with grants only for inputs the owner can still read', async () => {
      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim).toBeDefined();
      expect(claim!.operationId).toBe(queued.id);
      expect(claim!.claimToken).toBe('claim-1');
      expect(claim).not.toHaveProperty('ownerId');
      expect(claim).not.toHaveProperty('label');
      expect(claim!.inputs).toHaveLength(1);
      expect(claim!.inputs[0]).toEqual(
        expect.objectContaining({ inputId: 'source', resourceId: queued.assetId, kind: 'library-asset' }),
      );
      expect(claim!.inputs[0]).not.toHaveProperty('token');
      expect(studioResources.resolveProjectResources).not.toHaveBeenCalled();
      expect(claim!.inputs[0].url).toMatch(new RegExp(`^/api/render-workers/operations/${queued.id}/inputs/`));
      // Elevated: a Locked source is rendered like any other once its owner submitted the job.
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(OWNER_A, new Set([queued.assetId]), true);
      expect(workers.claimQueued).toHaveBeenCalledWith(
        expect.objectContaining({ id: queued.id, workerId: workerA.id }),
      );
    });

    it('measures an export against the codecs and containers its session proved (FL-95)', async () => {
      const hevc = operationStub({ settings: { format: 'mp4-hevc-main10', resolution: '2160p' } });
      vi.mocked(workers.peekQueued).mockReset();
      vi.mocked(workers.peekQueued)
        .mockResolvedValueOnce([hevc] as never)
        .mockResolvedValue([]);
      vi.mocked(workers.getSessionCapabilities).mockResolvedValue({ codecs: ['h264_nvenc'], formats: ['mp4'] });

      await expect(sut.claim(SESSION_A, {} as never)).resolves.toBeUndefined();
      expect(workers.getSessionCapabilities).toHaveBeenCalledWith(sessionA.id);
      expect(workers.recordRefusal).toHaveBeenCalledWith(hevc.id, RenderWorkerRefusalReason.CodecUnsupported);
      expect(workers.claimQueued).not.toHaveBeenCalled();
    });

    it('issues no grant for an input the owner has lost access to', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim!.inputs).toEqual([]);
    });

    describe('Studio operations', () => {
      const studioOp = studioOperationStub();

      beforeEach(() => {
        vi.mocked(workers.peekQueued).mockReset();
        vi.mocked(workers.peekQueued)
          .mockResolvedValueOnce([studioOp] as never)
          .mockResolvedValue([]);
        vi.mocked(workers.claimQueued).mockImplementation(({ id, workerId }) =>
          Promise.resolve({
            operation: studioOperationStub({
              id,
              status: MediaOperationStatus.Preparing,
              claimToken: 'claim-1',
              claimedBy: workerId,
              attempt: 1,
            }) as never,
            claimToken: 'claim-1',
          }),
        );
        const manifest = studioManifestStub();
        studioResources.resolveProjectResources.mockResolvedValue({ manifest, refused: [] });
        studioResources.issueReadGrants.mockReturnValue([
          {
            key: 'library-asset:clip-1',
            kind: StudioResourceKind.LibraryAsset,
            id: 'clip-1',
            path: '/library/owner-a/clip-1.mov',
            token: 'fl90-clip-1',
            expiresAt: manifest.expiresAt,
          },
          {
            key: 'font:inter',
            kind: StudioResourceKind.Font,
            id: 'inter',
            path: '/deployment/fonts/inter.ttf',
            token: 'fl90-font',
            expiresAt: manifest.expiresAt,
          },
        ]);
      });

      it('re-resolves the snapshot graph as the owner and hands out FL-90 grants bound to this worker', async () => {
        const claim = await sut.claim(SESSION_A, {} as never);

        expect(claim!.operationId).toBe(studioOp.id);
        expect(studioResources.resolveProjectResources).toHaveBeenCalledWith(
          expect.objectContaining({ user: expect.objectContaining({ id: OWNER_A }) }),
          expect.objectContaining({
            projectId: 'project-1',
            ownerId: OWNER_A,
            revision: 7,
            destination: StudioDestination.Lan,
            cloudConsent: false,
            backgroundRunner: true,
          }),
        );
        // The owner's Locked, sensitive and hidden sources resolve for a background task: the
        // acting session is the worker's, elevated, with no hidden-content filter and no shared link.
        const auth = studioResources.resolveProjectResources.mock.calls[0][0];
        expect(auth).not.toHaveProperty('sharedLink');
        expect(auth).not.toHaveProperty('hiddenContent');
        expect(auth.session).toEqual({ id: sessionA.id, hasElevatedPermission: true });
        expect(studioResources.issueReadGrants).toHaveBeenCalledWith(
          expect.objectContaining({ digest: 'digest-1' }),
          expect.objectContaining({ workerId: workerA.id }),
        );
        expect(claim!.inputs.map((input) => [input.inputId, input.kind, input.resourceId, input.checksum])).toEqual([
          ['library-asset:clip-1', StudioResourceKind.LibraryAsset, 'clip-1', 'sum-1'],
          ['font:inter', StudioResourceKind.Font, 'inter', 'sum-font'],
        ]);
        for (const input of claim!.inputs) {
          expect(input).not.toHaveProperty('token');
          expect(input).not.toHaveProperty('path');
          expect(input.url).not.toContain('/library/');
        }
        expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
      });

      it('refuses, without claiming, a job whose manifest is no longer complete and records why', async () => {
        studioResources.resolveProjectResources.mockResolvedValue({
          manifest: studioManifestStub({ complete: false, refusedCount: 1, entries: [] }),
          refused: [
            {
              key: 'library-asset:clip-1',
              kind: StudioResourceKind.LibraryAsset,
              id: 'clip-1',
              graphPath: '$',
              reason: 'no-access',
              detail: 'Trashed.',
            },
          ],
        });

        const claim = await sut.claim(SESSION_A, {} as never);

        expect(claim).toBeUndefined();
        expect(workers.claimQueued).not.toHaveBeenCalled();
        expect(workers.recordRefusal).toHaveBeenCalledWith(studioOp.id, RenderWorkerRefusalReason.ManifestIncomplete);
        expect(workers.recordAudit).toHaveBeenCalledWith(
          expect.objectContaining({
            event: RenderWorkerAuditEvent.ClaimRefused,
            reason: RenderWorkerRefusalReason.ManifestIncomplete,
            operationId: studioOp.id,
            detail: { refused: [{ key: 'library-asset:clip-1', reason: 'no-access' }] },
          }),
        );
        expect(studioResources.issueReadGrants).not.toHaveBeenCalled();
      });

      it('treats a resolver precondition failure (cloud without consent) as an incomplete manifest', async () => {
        studioResources.resolveProjectResources.mockRejectedValue(
          new Error('A cloud destination requires explicit consent'),
        );

        const claim = await sut.claim(SESSION_A, {} as never);

        expect(claim).toBeUndefined();
        expect(workers.claimQueued).not.toHaveBeenCalled();
        expect(workers.recordRefusal).toHaveBeenCalledWith(studioOp.id, RenderWorkerRefusalReason.ManifestIncomplete);
      });

      it('refuses a job whose owner no longer exists instead of resolving as anyone else', async () => {
        vi.mocked(workers.peekQueued).mockReset();
        vi.mocked(workers.peekQueued)
          .mockResolvedValueOnce([studioOperationStub({ ownerId: OWNER_B })] as never)
          .mockResolvedValue([]);

        const claim = await sut.claim(SESSION_A, {} as never);

        expect(claim).toBeUndefined();
        expect(studioResources.resolveProjectResources).not.toHaveBeenCalled();
        expect(workers.claimQueued).not.toHaveBeenCalled();
      });

      describe('bound to a stored project revision (FL-89)', () => {
        const storedGraph = { sequence: [{ assetId: 'clip-1' }] };
        const storedOp = studioOperationStub({
          snapshot: { engineDigest: 'engine-1', studio: { stored: true, revision: 7, cloudConsent: false } },
        });
        const projectRow = (overrides: Record<string, unknown> = {}) => ({
          id: 'project-1',
          ownerId: OWNER_A,
          spaceId: null,
          currentRevision: 8,
          ...overrides,
        });

        beforeEach(() => {
          vi.mocked(workers.peekQueued).mockReset();
          vi.mocked(workers.peekQueued)
            .mockResolvedValueOnce([storedOp] as never)
            .mockResolvedValue([]);
          studioProjects.getById.mockResolvedValue(projectRow());
          studioProjects.getRevision.mockResolvedValue({
            projectId: 'project-1',
            revision: 7,
            envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev-1', graph: storedGraph },
          });
        });

        it('refuses, without claiming, a job whose project is in the trash (FL-106)', async () => {
          studioProjects.getById.mockResolvedValue(projectRow({ deletedAt: new Date() }));

          const claim = await sut.claim(SESSION_A, {} as never);

          expect(claim).toBeUndefined();
          expect(workers.claimQueued).not.toHaveBeenCalled();
          expect(studioResources.resolveProjectResources).not.toHaveBeenCalled();
          expect(workers.recordRefusal).toHaveBeenCalledWith(storedOp.id, RenderWorkerRefusalReason.ManifestIncomplete);
        });

        it('records what a Studio export claim may read before handing it out (FL-106)', async () => {
          await sut.claim(SESSION_A, {} as never);

          expect(studioExports.onRenderClaimed).toHaveBeenCalledWith(
            expect.objectContaining({ id: storedOp.id, claimToken: 'claim-1' }),
            expect.objectContaining({
              workerId: workerA.id,
              entries: expect.arrayContaining([expect.objectContaining({ key: 'library-asset:clip-1' })]),
            }),
          );
        });

        it('reads the graph from storage at the named revision and resolves it as a background runner', async () => {
          await sut.claim(SESSION_A, {} as never);

          // The named revision, not the head: a job renders exactly what it was submitted for.
          expect(studioProjects.getRevision).toHaveBeenCalledWith('project-1', 7);
          expect(studioResources.resolveProjectResources).toHaveBeenCalledWith(
            expect.objectContaining({ session: { id: sessionA.id, hasElevatedPermission: true } }),
            expect.objectContaining({
              projectId: 'project-1',
              ownerId: OWNER_A,
              revision: 7,
              graph: storedGraph,
              backgroundRunner: true,
            }),
          );
        });

        it("resolves a reviewer's job as the reviewer, with project resources owned by the owner", async () => {
          const spaceId = 'space-1';
          studioProjects.getById.mockResolvedValue(projectRow({ ownerId: OWNER_B, spaceId }));
          mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
          mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set([spaceId]));

          await sut.claim(SESSION_A, {} as never);

          const [auth, context] = studioResources.resolveProjectResources.mock.calls[0];
          expect(auth.user.id).toBe(OWNER_A);
          expect(context).toEqual(expect.objectContaining({ ownerId: OWNER_B, backgroundRunner: true }));
        });

        it('refuses, without reading the graph, once the account can no longer read the project', async () => {
          studioProjects.getById.mockResolvedValue(projectRow({ ownerId: OWNER_B, spaceId: 'space-1' }));
          mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
          mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());

          const claim = await sut.claim(SESSION_A, {} as never);

          expect(claim).toBeUndefined();
          expect(studioProjects.getRevision).not.toHaveBeenCalled();
          expect(studioResources.resolveProjectResources).not.toHaveBeenCalled();
          expect(workers.recordRefusal).toHaveBeenCalledWith(storedOp.id, RenderWorkerRefusalReason.ManifestIncomplete);
        });

        it('refuses a job whose project or revision is gone', async () => {
          studioProjects.getRevision.mockResolvedValue(undefined);

          const claim = await sut.claim(SESSION_A, {} as never);

          expect(claim).toBeUndefined();
          expect(studioResources.resolveProjectResources).not.toHaveBeenCalled();
          expect(workers.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ detail: { refused: [{ key: 'revision', reason: 'revision-missing' }] } }),
          );
        });
      });
    });

    it('applies the tightest of worker, instance and account limits to the claim', async () => {
      vi.mocked(workers.getLimit).mockImplementation((subject) =>
        Promise.resolve(
          subject === 'instance'
            ? ({ subject, maxConcurrentOperations: 5, maxWallClockMs: '600000', maxOutputBytes: null } as never)
            : ({ subject, maxConcurrentOperations: 1, maxWallClockMs: '300000', maxOutputBytes: '5000' } as never),
        ),
      );

      const claim = await sut.claim(SESSION_A, {} as never);

      // Worker: no wall clock, 1000 output bytes. Instance: 600 s. Account: 300 s, 5000 bytes.
      expect(claim!.limits).toEqual({ maxWallClockMs: '300000', maxOutputBytes: '1000' });
    });

    it('skips an operation whose owner is at their concurrency and records the refusal on it', async () => {
      const other = operationStub({ id: '0195e2a0-0000-7000-8000-000000000002', ownerId: OWNER_B });
      vi.mocked(workers.peekQueued).mockReset();
      vi.mocked(workers.peekQueued)
        .mockResolvedValueOnce([queued, other] as never)
        .mockResolvedValue([]);
      vi.mocked(workers.countActiveForOwner).mockImplementation((ownerId) =>
        Promise.resolve(ownerId === OWNER_A ? 2 : 0),
      );

      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim!.operationId).toBe(other.id);
      expect(workers.recordRefusal).toHaveBeenCalledWith(queued.id, RenderWorkerRefusalReason.UserConcurrency);
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          event: RenderWorkerAuditEvent.ClaimRefused,
          reason: RenderWorkerRefusalReason.UserConcurrency,
          operationId: queued.id,
          workerId: workerA.id,
        }),
      );
      expect(workers.claimQueued).toHaveBeenCalledTimes(1);
    });

    it('stops without claiming when the worker itself is at its concurrency', async () => {
      vi.mocked(workers.countActiveForWorker).mockResolvedValue(2);

      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim).toBeUndefined();
      expect(workers.claimQueued).not.toHaveBeenCalled();
      expect(workers.recordRefusal).not.toHaveBeenCalled();
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ reason: RenderWorkerRefusalReason.WorkerConcurrency }),
      );
    });

    it('only ever asks the queue for the worker’s own destination', async () => {
      await sut.claim(SESSION_A, {} as never);

      expect(workers.peekQueued).toHaveBeenCalledWith(
        expect.objectContaining({ destination: MediaOperationDestination.Lan, kinds: workerA.kinds }),
      );
    });

    it('never asks the queue for a server-side kind, even one a saved scope still lists (FL-73)', async () => {
      installSessions({
        worker: workerA,
        session: sessionStub(workerA, SESSION_A, {
          scopes: [
            MediaOperationKind.StudioExport,
            MediaOperationKind.Bulk,
            MediaOperationKind.PhysicalDeduplication,
          ] as never,
        }),
      });

      await sut.claim(SESSION_A, {} as never);

      expect(workers.peekQueued).toHaveBeenCalledWith(
        expect.objectContaining({ kinds: [MediaOperationKind.StudioExport] }),
      );
      await expect(
        sut.claim(SESSION_A, { kinds: [MediaOperationKind.PhysicalDeduplication] } as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a claim narrowed to kinds outside the session scopes', async () => {
      await expect(sut.claim(SESSION_A, { kinds: [MediaOperationKind.QuickEdit] } as never)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(workers.peekQueued).not.toHaveBeenCalled();
    });

    it('records a refusal rather than claiming when the job needs more GPU memory than admitted', async () => {
      vi.mocked(workers.peekQueued).mockReset();
      vi.mocked(workers.peekQueued)
        .mockResolvedValueOnce([operationStub({ snapshot: { gpuMemoryHintBytes: 80 * 1024 ** 3 } })] as never)
        .mockResolvedValue([]);

      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim).toBeUndefined();
      expect(workers.recordRefusal).toHaveBeenCalledWith(queued.id, RenderWorkerRefusalReason.GpuMemoryInsufficient);
      expect(workers.claimQueued).not.toHaveBeenCalled();
    });

    it('moves on when another worker took the candidate first', async () => {
      vi.mocked(workers.claimQueued).mockResolvedValue(undefined);

      const claim = await sut.claim(SESSION_A, {} as never);

      expect(claim).toBeUndefined();
      expect(workers.recordRefusal).not.toHaveBeenCalled();
    });

    it('rejects a claim with an unknown session before touching the queue', async () => {
      await expect(sut.claim('forged', {} as never)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(workers.peekQueued).not.toHaveBeenCalled();
    });
  });

  describe('guarded writes', () => {
    const claimedByA = operationStub({
      status: MediaOperationStatus.Rendering,
      claimToken: 'claim-1',
      claimedBy: workerA.id,
      startedAt: new Date(Date.now() - 60_000),
    });

    beforeEach(() => {
      // The repository only answers when id, worker and token all match: this is that contract.
      vi.mocked(workers.getClaimed).mockImplementation((id, workerId, claimToken) =>
        Promise.resolve(
          id === claimedByA.id && workerId === workerA.id && claimToken === 'claim-1'
            ? (claimedByA as never)
            : undefined,
        ),
      );
    });

    it('lets the claiming worker heartbeat and reports a pending cancel', async () => {
      const result = await sut.heartbeat(SESSION_A, claimedByA.id, { claimToken: 'claim-1' } as never);

      expect(result).toEqual(expect.objectContaining({ leaseExtended: true, cancelRequested: false, refusal: null }));
      expect(operations.heartbeat).toHaveBeenCalledWith(claimedByA.id, 'claim-1', expect.any(Number));
    });

    it('hands a paused job back on heartbeat instead of extending the lease (FL-104)', async () => {
      vi.mocked(workers.getClaimed).mockResolvedValue({ ...claimedByA, pauseRequestedAt: new Date() } as never);

      const result = await sut.heartbeat(SESSION_A, claimedByA.id, { claimToken: 'claim-1' } as never);

      expect(result).toEqual(
        expect.objectContaining({ leaseExtended: false, pauseRequested: true, cancelRequested: false, refusal: null }),
      );
      expect(operations.settlePause).toHaveBeenCalledWith(claimedByA.id, 'claim-1');
      expect(operations.heartbeat).not.toHaveBeenCalled();
    });

    it('lets a job already validating its output finish despite a pause request', async () => {
      vi.mocked(workers.getClaimed).mockResolvedValue({
        ...claimedByA,
        status: MediaOperationStatus.Validating,
        pauseRequestedAt: new Date(),
      } as never);

      const result = await sut.heartbeat(SESSION_A, claimedByA.id, { claimToken: 'claim-1' } as never);

      expect(result).toEqual(expect.objectContaining({ leaseExtended: true, pauseRequested: false }));
      expect(operations.settlePause).not.toHaveBeenCalled();
    });

    it('keeps the lease when the owner resumed before the heartbeat arrived', async () => {
      vi.mocked(workers.getClaimed).mockResolvedValue({ ...claimedByA, pauseRequestedAt: new Date() } as never);
      vi.mocked(operations.settlePause).mockResolvedValueOnce(false);

      const result = await sut.heartbeat(SESSION_A, claimedByA.id, { claimToken: 'claim-1' } as never);

      expect(result).toEqual(expect.objectContaining({ leaseExtended: true, pauseRequested: false }));
    });

    it('refuses another worker presenting the real claim token: cross-worker', async () => {
      await expect(sut.heartbeat(SESSION_B, claimedByA.id, { claimToken: 'claim-1' } as never)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(operations.heartbeat).not.toHaveBeenCalled();
      expect(workers.getClaimed).toHaveBeenCalledWith(claimedByA.id, workerB.id, 'claim-1');
    });

    it('refuses the claiming worker presenting a stale or guessed token', async () => {
      await expect(
        sut.progress(SESSION_A, claimedByA.id, {
          claimToken: 'claim-0',
          status: 'rendering',
          processedUnits: 1,
          totalUnits: 2,
        } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(operations.reportProgress).not.toHaveBeenCalled();
    });

    it("fails the job instead of publishing a result that is not the owner's asset (FL-43)", async () => {
      // A Studio export's result is adopted by publication (FL-106); a quick edit names its own.
      vi.mocked(workers.getClaimed).mockResolvedValue({ ...claimedByA, kind: MediaOperationKind.QuickEdit } as never);
      const foreign = '0195e2a0-0000-4000-8000-0000000000f1';
      vi.mocked(operations.isPublishableResult).mockResolvedValue(false);

      const result = await sut.complete(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        resultAssetId: foreign,
      } as never);

      expect(result).toEqual({ accepted: false, refusal: null });
      expect(operations.isPublishableResult).toHaveBeenCalledWith(claimedByA.ownerId, foreign);
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({ errorCode: 'result_not_owned' }),
      );
    });

    it("publishes a result that is the owner's own asset (FL-43)", async () => {
      // A Studio export's result is adopted by publication (FL-106); a quick edit names its own.
      vi.mocked(workers.getClaimed).mockResolvedValue({ ...claimedByA, kind: MediaOperationKind.QuickEdit } as never);
      const mine = '0195e2a0-0000-4000-8000-0000000000f2';

      const result = await sut.complete(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        resultAssetId: mine,
      } as never);

      expect(result).toEqual({ accepted: true, refusal: null });
      expect(operations.complete).toHaveBeenCalledWith(claimedByA.id, 'claim-1', { resultAssetId: mine });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('refuses every write without a live session', async () => {
      const body = { claimToken: 'claim-1' } as never;
      await expect(sut.heartbeat(undefined, claimedByA.id, body)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.complete('forged', claimedByA.id, body)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.fail('forged', claimedByA.id, body)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(operations.complete).not.toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('accepts a failure report that sends the job to its automatic retry (FL-104)', async () => {
      vi.mocked(operations.fail).mockResolvedValue('retrying');

      const result = await sut.fail(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        error: 'decoder crashed',
        errorCode: 'decoder_crashed',
      } as never);

      expect(result).toEqual({ accepted: true, refusal: null });
    });

    it('does not accept a failure report the job no longer takes', async () => {
      vi.mocked(operations.fail).mockResolvedValue(false);

      const result = await sut.fail(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        error: 'late',
        errorCode: 'late',
      } as never);

      expect(result).toEqual({ accepted: false, refusal: null });
    });

    it('stops an operation over its output ceiling on heartbeat, under the claim, and audits it', async () => {
      const result = await sut.heartbeat(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        outputBytes: '5000',
      } as never);

      expect(result.refusal).toBe(RenderWorkerRefusalReason.OutputBytesExceeded);
      expect(result.leaseExtended).toBe(false);
      expect(operations.fail).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({ errorCode: RenderWorkerRefusalReason.OutputBytesExceeded }),
      );
      expect(operations.heartbeat).not.toHaveBeenCalled();
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          event: RenderWorkerAuditEvent.LimitExceeded,
          reason: RenderWorkerRefusalReason.OutputBytesExceeded,
          operationId: claimedByA.id,
        }),
      );
    });

    it('stops an operation over the account’s wall clock on progress', async () => {
      vi.mocked(workers.getLimit).mockImplementation((subject) =>
        Promise.resolve(
          subject === OWNER_A
            ? ({ subject, maxConcurrentOperations: 2, maxWallClockMs: '1000', maxOutputBytes: null } as never)
            : undefined,
        ),
      );

      const result = await sut.progress(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        status: MediaOperationStatus.Rendering,
        processedUnits: 5,
        totalUnits: 10,
      } as never);

      expect(result).toEqual({ accepted: false, refusal: RenderWorkerRefusalReason.WallClockExceeded });
      expect(operations.reportProgress).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({ errorCode: RenderWorkerRefusalReason.WallClockExceeded }),
      );
    });

    it('measures the wall clock from the current attempt, so an automatic re-dispatch starts from zero', async () => {
      // First attempt started long ago and failed; the retry was claimed just now. The account's
      // one-second ceiling applies to this attempt alone.
      vi.mocked(workers.getClaimed).mockResolvedValue(
        operationStub({
          ...claimedByA,
          attempt: 2,
          startedAt: new Date(Date.now() - 60_000),
          attemptStartedAt: new Date(),
        }) as never,
      );
      vi.mocked(workers.getLimit).mockImplementation((subject) =>
        Promise.resolve(
          subject === OWNER_A
            ? ({ subject, maxConcurrentOperations: 2, maxWallClockMs: '1000', maxOutputBytes: null } as never)
            : undefined,
        ),
      );

      const result = await sut.progress(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        status: MediaOperationStatus.Rendering,
        processedUnits: 5,
        totalUnits: 10,
      } as never);

      expect(result).toEqual({ accepted: true, refusal: null });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('derives progress on the server from counted units', async () => {
      await sut.progress(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        status: MediaOperationStatus.Rendering,
        processedUnits: 1,
        totalUnits: 3,
      } as never);

      expect(operations.reportProgress).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({ progress: 33.33, processedUnits: 1, totalUnits: 3 }),
      );
    });

    it('passes checkpoints through under the claim token only', async () => {
      await sut.planCheckpoint(SESSION_A, claimedByA.id, {
        claimToken: 'claim-1',
        sequence: 0,
        chunkKey: 'k',
        inputDigest: 'i',
        historyDigest: 'h',
        configDigest: 'c',
        seed: null,
        timebase: '30000/1001',
        startTicks: '0',
        endTicks: '1000',
      } as never);
      expect(operations.upsertCheckpoint).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({ sequence: 0, chunkKey: 'k', prerollTicks: '0', requiresSequentialContext: false }),
      );

      await sut.completeCheckpoint(SESSION_A, claimedByA.id, 0, {
        claimToken: 'claim-1',
        chunkKey: 'k',
        outputPath: '/render/chunk-0.mkv',
        outputChecksum: 'abcd',
        sizeInBytes: '42',
      } as never);
      expect(operations.completeCheckpoint).toHaveBeenCalledWith(
        claimedByA.id,
        'claim-1',
        expect.objectContaining({
          sequence: 0,
          chunkKey: 'k',
          outputChecksum: Buffer.from('abcd', 'hex'),
          sizeInBytes: 42,
        }),
      );
    });

    describe('server-validated chunk reuse (FL-104)', () => {
      const chunk = (sequence: number, overrides: Record<string, unknown> = {}) => ({
        id: `chunk-${sequence}`,
        operationId: claimedByA.id,
        sequence,
        state: MediaOperationCheckpointState.Complete,
        chunkKey: `k${sequence}`,
        inputDigest: 'i',
        historyDigest: 'h',
        configDigest: 'c',
        seed: null,
        timebase: '30000/1001',
        startTicks: String(sequence * 1000),
        endTicks: String((sequence + 1) * 1000),
        prerollTicks: '0',
        requiresSequentialContext: false,
        outputPath: `/render/chunk-${sequence}.mkv`,
        ...overrides,
      });
      const plan = (sequence: number, overrides: Record<string, unknown> = {}) =>
        ({
          claimToken: 'claim-1',
          sequence,
          chunkKey: `k${sequence}`,
          inputDigest: 'i',
          historyDigest: 'h',
          configDigest: 'c',
          seed: null,
          timebase: '30000/1001',
          startTicks: String(sequence * 1000),
          endTicks: String((sequence + 1) * 1000),
          ...overrides,
        }) as never;

      it('keeps a finished chunk only when every digest, the timebase and the range match', async () => {
        vi.mocked(operations.getCheckpoints).mockResolvedValue([chunk(0), chunk(1)] as never);

        await expect(sut.planCheckpoint(SESSION_A, claimedByA.id, plan(0))).resolves.toEqual({
          accepted: true,
          refusal: null,
        });
        expect(operations.upsertCheckpoint).not.toHaveBeenCalled();

        // A changed effect history is re-rendered, and everything after it loses its reuse.
        await sut.planCheckpoint(SESSION_A, claimedByA.id, plan(0, { historyDigest: 'h2' }));
        expect(operations.upsertCheckpoint).toHaveBeenCalledTimes(1);
        expect(operations.invalidateCheckpointsFrom).toHaveBeenCalledWith(claimedByA.id, 1);
      });

      it('restarts at the first chunk of a run whose state flows into the re-rendered one', async () => {
        vi.mocked(operations.getCheckpoints).mockResolvedValue([
          chunk(0),
          chunk(1, { requiresSequentialContext: true }),
          chunk(2, { requiresSequentialContext: true }),
          chunk(3),
        ] as never);

        await sut.planCheckpoint(SESSION_A, claimedByA.id, plan(3, { seed: '7' }));

        expect(operations.invalidateCheckpointsFrom).toHaveBeenCalledWith(claimedByA.id, 1);
        // The re-planned chunk is pending again, not invalid.
        expect(operations.upsertCheckpoint).toHaveBeenLastCalledWith(
          claimedByA.id,
          'claim-1',
          expect.objectContaining({ sequence: 3, seed: '7' }),
        );
      });

      it('refuses validation while a chunk is invalid or unfinished', async () => {
        vi.mocked(operations.getCheckpoints).mockResolvedValue([
          chunk(0),
          chunk(1, { state: MediaOperationCheckpointState.Invalid }),
        ] as never);
        await expect(
          sut.beginValidation(SESSION_A, claimedByA.id, { claimToken: 'claim-1', resultAssetId: null } as never),
        ).resolves.toEqual({ accepted: false, refusal: null });
        expect(operations.beginValidation).not.toHaveBeenCalled();
      });
    });

    it('only acknowledges a cancel on a job that is cancelling and held by this worker', async () => {
      expect(
        await sut.acknowledgeCancel(SESSION_A, claimedByA.id, { claimToken: 'claim-1', released: true } as never),
      ).toEqual({
        accepted: false,
        refusal: null,
      });
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();

      // Still only for worker A and its token: the repository answers nothing to anybody else.
      const cancelling = operationStub({
        ...claimedByA,
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: new Date(),
      });
      vi.mocked(workers.getClaimed).mockImplementation((id, workerId, claimToken) =>
        Promise.resolve(
          id === claimedByA.id && workerId === workerA.id && claimToken === 'claim-1'
            ? (cancelling as never)
            : undefined,
        ),
      );
      expect(
        await sut.acknowledgeCancel(SESSION_A, claimedByA.id, { claimToken: 'claim-1', released: true } as never),
      ).toEqual({
        accepted: true,
        refusal: null,
      });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(claimedByA.id, 'claim-1', { released: true });

      await expect(
        sut.acknowledgeCancel(SESSION_B, claimedByA.id, { claimToken: 'claim-1', released: true } as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('readInput', () => {
    const claimedByA = operationStub({
      status: MediaOperationStatus.Rendering,
      claimToken: 'claim-1',
      claimedBy: workerA.id,
    });
    const asset = {
      id: claimedByA.assetId,
      ownerId: OWNER_A,
      originalPath: '/library/owner-a/summer.mov',
      deletedAt: null,
    };
    const grantFor = (operation: MediaOperation, session: RenderWorkerSession, claimToken = 'claim-1') =>
      signInputGrant(
        {
          operationId: operation.id,
          inputId: 'source',
          resourceId: operation.assetId!,
          token: null,
          expiresAt: Date.now() + 60_000,
        },
        { claimToken, sessionTokenHash: session.token },
      );

    beforeEach(() => {
      vi.mocked(workers.getClaimedByWorker).mockImplementation((id, workerId) =>
        Promise.resolve(id === claimedByA.id && workerId === workerA.id ? (claimedByA as never) : undefined),
      );
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([claimedByA.assetId!]));
      mocks.asset.getById.mockResolvedValue(asset as never);
    });

    it('serves the input to the claiming worker under a grant minted for its claim and session', async () => {
      const file = await sut.readInput(SESSION_A, claimedByA.id, grantFor(claimedByA, sessionA));

      expect(file.path).toBe(asset.originalPath);
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(OWNER_A, new Set([claimedByA.assetId]), true);
    });

    it('refuses another worker using a grant minted for the claiming worker: cross-worker', async () => {
      await expect(sut.readInput(SESSION_B, claimedByA.id, grantFor(claimedByA, sessionA))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });

    it('refuses a grant for one operation replayed against another the same worker holds', async () => {
      const otherOp = operationStub({
        id: '0195e2a0-0000-7000-8000-000000000009',
        ownerId: OWNER_B,
        assetId: '22222222-2222-4222-8222-222222222222',
        status: MediaOperationStatus.Rendering,
        claimToken: 'claim-9',
        claimedBy: workerA.id,
      });
      vi.mocked(workers.getClaimedByWorker).mockImplementation((id) =>
        Promise.resolve(
          id === otherOp.id ? (otherOp as never) : id === claimedByA.id ? (claimedByA as never) : undefined,
        ),
      );

      // A grant minted for owner A's job, presented on owner B's job. Cross-user through the worker.
      await expect(sut.readInput(SESSION_A, otherOp.id, grantFor(claimedByA, sessionA))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });

    it('refuses a grant once the claim has been reissued', async () => {
      await expect(
        sut.readInput(SESSION_A, claimedByA.id, grantFor(claimedByA, sessionA, 'claim-from-a-previous-attempt')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an input the owner can no longer read, even with a valid unexpired grant', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.readInput(SESSION_A, claimedByA.id, grantFor(claimedByA, sessionA))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.asset.getById).not.toHaveBeenCalled();
    });

    it('refuses an asset that turns out to belong to another account: cross-user', async () => {
      mocks.asset.getById.mockResolvedValue({ ...asset, ownerId: OWNER_B } as never);

      await expect(sut.readInput(SESSION_A, claimedByA.id, grantFor(claimedByA, sessionA))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses a grant for an asset the manifest does not list, even if the owner owns it', async () => {
      const grant = signInputGrant(
        {
          operationId: claimedByA.id,
          inputId: 'source',
          resourceId: '33333333-3333-4333-8333-333333333333',
          token: null,
          expiresAt: Date.now() + 60_000,
        },
        { claimToken: 'claim-1', sessionTokenHash: sessionA.token },
      );

      await expect(sut.readInput(SESSION_A, claimedByA.id, grant)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an operation this worker never claimed', async () => {
      const foreign = operationStub({
        id: '0195e2a0-0000-7000-8000-000000000077',
        claimedBy: workerB.id,
        claimToken: 'x',
      });

      await expect(sut.readInput(SESSION_A, foreign.id, grantFor(foreign, sessionA, 'x'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    describe('Studio inputs', () => {
      const studioClaimed = studioOperationStub({
        status: MediaOperationStatus.Rendering,
        claimToken: 'claim-1',
        claimedBy: workerA.id,
      });
      const studioGrant = (input: { inputId: string; resourceId: string; token: string }, claimToken = 'claim-1') =>
        signInputGrant(
          { operationId: studioClaimed.id, ...input, expiresAt: Date.now() + 60_000 },
          { claimToken, sessionTokenHash: sessionA.token },
        );
      const verified = (grant: Record<string, unknown>, path: string) => ({
        valid: true,
        grant: {
          v: 1,
          scope: 'render',
          projectId: 'project-1',
          revision: 7,
          userId: OWNER_A,
          workerId: workerA.id,
          manifest: 'digest-1',
          checksum: null,
          ownerId: null,
          ...grant,
        },
        path,
      });

      beforeEach(() => {
        vi.mocked(workers.getClaimedByWorker).mockImplementation((id, workerId) =>
          Promise.resolve(id === studioClaimed.id && workerId === workerA.id ? (studioClaimed as never) : undefined),
        );
        studioResources.resolveProjectResources.mockResolvedValue({ manifest: studioManifestStub(), refused: [] });
      });

      it('serves a library source only after FL-90 re-verifies the grant as the owner for this worker', async () => {
        studioResources.verifyReadGrant.mockResolvedValue(
          verified(
            { kind: StudioResourceKind.LibraryAsset, id: 'clip-1', key: 'library-asset:clip-1' },
            '/library/owner-a/clip-1.mov',
          ),
        );

        const file = await sut.readInput(
          SESSION_A,
          studioClaimed.id,
          studioGrant({ inputId: 'library-asset:clip-1', resourceId: 'clip-1', token: 'fl90-clip-1' }),
        );

        expect(file.path).toBe('/library/owner-a/clip-1.mov');
        expect(studioResources.verifyReadGrant).toHaveBeenCalledWith('fl90-clip-1', {
          workerId: workerA.id,
          auth: expect.objectContaining({
            user: expect.objectContaining({ id: OWNER_A }),
            session: { id: sessionA.id, hasElevatedPermission: true },
          }),
          backgroundRunner: true,
        });
        expect(mocks.asset.getById).not.toHaveBeenCalled();
      });

      it('resolves a deployment file from a fresh manifest when FL-90 reports it by reference only', async () => {
        studioResources.verifyReadGrant.mockResolvedValue(
          verified({ kind: StudioResourceKind.Font, id: 'inter', key: 'font:inter', checksum: 'sum-font' }, ''),
        );

        const file = await sut.readInput(
          SESSION_A,
          studioClaimed.id,
          studioGrant({ inputId: 'font:inter', resourceId: 'inter', token: 'fl90-font' }),
        );

        expect(file.path).toBe('/deployment/fonts/inter.ttf');
        expect(studioResources.resolveProjectResources).toHaveBeenCalledTimes(1);
      });

      it('refuses a source the owner lost since the claim, even under a valid unexpired grant', async () => {
        studioResources.verifyReadGrant.mockResolvedValue({ valid: false, reason: 'no-access', detail: 'Relocked.' });

        await expect(
          sut.readInput(
            SESSION_A,
            studioClaimed.id,
            studioGrant({ inputId: 'library-asset:clip-1', resourceId: 'clip-1', token: 'fl90-clip-1' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('refuses an FL-90 grant that names a different resource than the operation grant wraps', async () => {
        studioResources.verifyReadGrant.mockResolvedValue(
          verified(
            { kind: StudioResourceKind.LibraryAsset, id: 'clip-2', key: 'library-asset:clip-2' },
            '/library/owner-a/clip-2.mov',
          ),
        );

        await expect(
          sut.readInput(
            SESSION_A,
            studioClaimed.id,
            studioGrant({ inputId: 'library-asset:clip-1', resourceId: 'clip-1', token: 'fl90-clip-2' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('refuses a preview-scope grant on the input route', async () => {
        studioResources.verifyReadGrant.mockResolvedValue(
          verified({ scope: 'preview', kind: StudioResourceKind.RemotePreviewFrame, id: 'digest-1', key: 'x' }, ''),
        );

        await expect(
          sut.readInput(
            SESSION_A,
            studioClaimed.id,
            studioGrant({ inputId: 'x', resourceId: 'digest-1', token: 'fl90-preview' }),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      it('never calls FL-90 for another worker presenting the claiming worker’s grant', async () => {
        await expect(
          sut.readInput(
            SESSION_B,
            studioClaimed.id,
            studioGrant({ inputId: 'library-asset:clip-1', resourceId: 'clip-1', token: 'fl90-clip-1' }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(studioResources.verifyReadGrant).not.toHaveBeenCalled();
      });
    });
  });

  describe('revoke', () => {
    it('revokes the worker, its sessions and audits the actor', async () => {
      vi.mocked(workers.revokeWorker).mockResolvedValue(workerStub({ status: RenderWorkerStatus.Revoked }));

      await sut.revoke(authStub.admin, workerA.id);

      expect(workers.revokeWorker).toHaveBeenCalledWith(workerA.id);
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ event: RenderWorkerAuditEvent.Revoked, actorId: authStub.admin.user.id }),
      );
    });

    it('answers not found for an unknown worker', async () => {
      vi.mocked(workers.getWorker).mockResolvedValue(undefined);

      await expect(sut.revoke(authStub.admin, workerA.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('limits', () => {
    it('writes the instance default when no user is named and audits it', async () => {
      vi.mocked(workers.upsertLimit).mockImplementation((subject, userId, limit) =>
        Promise.resolve({ subject, userId, ...limit, updatedAt: new Date() } as never),
      );

      const result = await sut.updateLimits(authStub.admin, {
        maxConcurrentOperations: 3,
        maxWallClockMs: null,
        maxOutputBytes: '100',
      } as never);

      expect(workers.upsertLimit).toHaveBeenCalledWith('instance', null, {
        maxConcurrentOperations: 3,
        maxWallClockMs: null,
        maxOutputBytes: '100',
      });
      expect(result.subject).toBe('instance');
    });

    it('keys a per-account ceiling by the user id', async () => {
      vi.mocked(workers.upsertLimit).mockImplementation((subject, userId, limit) =>
        Promise.resolve({ subject, userId, ...limit, updatedAt: new Date() } as never),
      );

      await sut.updateLimits(authStub.admin, {
        userId: authStub.user1.user.id,
        maxConcurrentOperations: 1,
        maxWallClockMs: null,
        maxOutputBytes: null,
      } as never);

      expect(workers.upsertLimit).toHaveBeenCalledWith(
        authStub.user1.user.id,
        authStub.user1.user.id,
        expect.anything(),
      );
    });
  });

  describe('Studio preview frames (FL-96)', () => {
    const rendering = operationStub({
      kind: MediaOperationKind.StudioPreview,
      status: MediaOperationStatus.Validating,
      claimToken: 'claim-1',
      claimedBy: workerA.id,
      snapshot: { previewFrameId: 'frame-1' },
    });
    const output = {
      path: '/data/exports/owner/studio-previews/frame-1/frame.png',
      checksum: 'b'.repeat(64),
      sizeInBytes: '2048',
      contentType: 'image/png',
    };

    beforeEach(() => {
      vi.mocked(workers.getClaimed).mockImplementation((id, workerId, claimToken) =>
        Promise.resolve(
          id === rendering.id && workerId === workerA.id && claimToken === 'claim-1' ? (rendering as never) : undefined,
        ),
      );
    });

    it('publishes the frame before completing the render', async () => {
      const result = await sut.complete(SESSION_A, rendering.id, {
        claimToken: 'claim-1',
        resultAssetId: null,
        output,
      } as never);

      expect(result).toEqual({ accepted: true, refusal: null });
      expect(studioPreviews.onRenderCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ id: rendering.id }),
        output,
      );
      expect(operations.complete).toHaveBeenCalledWith(rendering.id, 'claim-1', { resultAssetId: null });
    });

    it('completes a render whose frame was superseded meanwhile, without publishing it', async () => {
      studioPreviews.onRenderCompleted.mockResolvedValue({ published: false });
      const result = await sut.complete(SESSION_A, rendering.id, {
        claimToken: 'claim-1',
        resultAssetId: null,
        output,
      } as never);
      expect(result).toEqual({ accepted: true, refusal: null });
    });

    it('refuses a worker-named result and a completion without a frame', async () => {
      await expect(
        sut.complete(SESSION_A, rendering.id, {
          claimToken: 'claim-1',
          resultAssetId: '00000000-0000-4000-8000-000000000001',
          output,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.complete(SESSION_A, rendering.id, { claimToken: 'claim-1', resultAssetId: null } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('marks the frame failed only once the render failed for good', async () => {
      vi.mocked(operations.fail).mockResolvedValueOnce('retrying');
      await sut.fail(SESSION_A, rendering.id, { claimToken: 'claim-1', error: 'lost', errorCode: 'gpu' } as never);
      expect(studioPreviews.onRenderFailed).not.toHaveBeenCalled();

      vi.mocked(operations.fail).mockResolvedValueOnce('failed');
      await sut.fail(SESSION_A, rendering.id, { claimToken: 'claim-1', error: 'lost', errorCode: 'gpu' } as never);
      expect(studioPreviews.onRenderFailed).toHaveBeenCalledWith(expect.objectContaining({ id: rendering.id }), 'gpu');
    });
  });

  describe('Studio export results (FL-106)', () => {
    const validating = operationStub({
      status: MediaOperationStatus.Validating,
      claimToken: 'claim-1',
      claimedBy: workerA.id,
    });
    const output = {
      path: '/data/exports/owner/studio-exports/staging/op/out.mp4',
      checksum: 'a'.repeat(64),
      sizeInBytes: '1024',
      contentType: 'video/mp4',
    };

    beforeEach(() => {
      vi.mocked(workers.getClaimed).mockImplementation((id, workerId, claimToken) =>
        Promise.resolve(
          id === validating.id && workerId === workerA.id && claimToken === 'claim-1'
            ? (validating as never)
            : undefined,
        ),
      );
    });

    it('refuses a worker-supplied result asset: only publication adopts one', async () => {
      await expect(
        sut.complete(SESSION_A, validating.id, {
          claimToken: 'claim-1',
          resultAssetId: '00000000-0000-4000-8000-000000000001',
          output,
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(studioExports.onRenderCompleted).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('refuses a completion without the file it produced', async () => {
      await expect(
        sut.complete(SESSION_A, validating.id, { claimToken: 'claim-1', resultAssetId: null } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('stages the output for publication and completes the render without a result asset', async () => {
      const result = await sut.complete(SESSION_A, validating.id, {
        claimToken: 'claim-1',
        resultAssetId: null,
        output,
      } as never);

      expect(result).toEqual({ accepted: true, refusal: null });
      expect(studioExports.onRenderCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ id: validating.id }),
        workerA.id,
        expect.objectContaining({ path: output.path, checksum: output.checksum, remoteRef: null }),
      );
      expect(operations.complete).toHaveBeenCalledWith(validating.id, 'claim-1', { resultAssetId: null });
    });

    it('does not complete the render when its version is no longer waiting for it', async () => {
      studioExports.onRenderCompleted.mockResolvedValue({ accepted: false });

      const result = await sut.complete(SESSION_A, validating.id, {
        claimToken: 'claim-1',
        resultAssetId: null,
        output,
      } as never);

      expect(result).toEqual({ accepted: false, refusal: null });
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('revokes every session of a worker whose GPU was lost, until it re-admits (FL-95)', async () => {
      vi.mocked(workers.revokeSessions).mockResolvedValue(2);
      await sut.fail(SESSION_A, validating.id, {
        claimToken: 'claim-1',
        error: 'CUDA device lost',
        errorCode: 'device_lost',
      } as never);

      expect(operations.fail).toHaveBeenCalled();
      expect(workers.revokeSessions).toHaveBeenCalledWith(workerA.id);
      expect(workers.recordAudit).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: workerA.id, event: RenderWorkerAuditEvent.DeviceLost }),
      );
    });

    it('keeps the sessions of a worker whose job failed for another reason', async () => {
      await sut.fail(SESSION_A, validating.id, { claimToken: 'claim-1', error: 'x', errorCode: 'encode' } as never);
      expect(workers.revokeSessions).not.toHaveBeenCalled();
    });

    it('fails the version only once the render failed for good', async () => {
      vi.mocked(operations.fail).mockResolvedValueOnce('retrying');
      await sut.fail(SESSION_A, validating.id, { claimToken: 'claim-1', error: 'gpu lost', errorCode: 'gpu' } as never);
      expect(studioExports.onRenderFailed).not.toHaveBeenCalled();

      vi.mocked(operations.fail).mockResolvedValueOnce('failed');
      await sut.fail(SESSION_A, validating.id, { claimToken: 'claim-1', error: 'gpu lost', errorCode: 'gpu' } as never);
      expect(studioExports.onRenderFailed).toHaveBeenCalledWith(expect.objectContaining({ id: validating.id }), {
        errorCode: 'gpu',
        error: 'gpu lost',
      });
    });

    it('settles the version and the remote obligation when a cancel is acknowledged', async () => {
      vi.mocked(workers.getClaimed).mockResolvedValue({
        ...validating,
        status: MediaOperationStatus.Cancelling,
      } as never);

      await sut.acknowledgeCancel(SESSION_A, validating.id, { claimToken: 'claim-1', released: true } as never);

      expect(studioExports.onRenderCancelAcknowledged).toHaveBeenCalledWith(
        expect.objectContaining({ id: validating.id }),
        workerA.id,
        true,
      );
    });

    it("lists only this worker's remote references and refuses to acknowledge another's", async () => {
      studioExports.listRemoteReferences.mockResolvedValue([
        {
          id: 'ref-1',
          operationId: validating.id,
          reason: 'cancel',
          remoteRef: null,
          requestedAt: new Date('2026-09-23T10:00:00.000Z'),
        },
      ]);

      await expect(sut.listRemoteReferences(SESSION_A)).resolves.toEqual([
        {
          id: 'ref-1',
          operationId: validating.id,
          reason: 'cancel',
          remoteRef: null,
          requestedAt: '2026-09-23T10:00:00.000Z',
        },
      ]);
      expect(studioExports.listRemoteReferences).toHaveBeenCalledWith(workerA.id);

      studioExports.acknowledgeRemoteReference.mockResolvedValue(false);
      await expect(sut.acknowledgeRemoteReference(SESSION_B, 'ref-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(studioExports.acknowledgeRemoteReference).toHaveBeenCalledWith('ref-1', workerB.id);
    });
  });

  describe('getCompatibility (FL-71 CC-9)', () => {
    const live = (worker: RenderWorker, session: RenderWorkerSession) => ({ worker, session });

    it('lists the render kinds a qualified worker can take, and the rest as unavailable', async () => {
      (workers as unknown as { listLiveSessions: ReturnType<typeof vi.fn> }).listLiveSessions = vi
        .fn()
        .mockResolvedValue([live(workerA, sessionA)]);

      await expect(sut.getCompatibility()).resolves.toEqual({
        qualified: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration],
        unavailable: [
          MediaOperationKind.StudioPreview,
          MediaOperationKind.RestorationPreview,
          MediaOperationKind.QuickEdit,
        ],
      });
    });

    it('does not count a session whose conformance is stale', async () => {
      (workers as unknown as { listLiveSessions: ReturnType<typeof vi.fn> }).listLiveSessions = vi
        .fn()
        .mockResolvedValue([
          live(workerA, { ...sessionA, conformanceReportedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }),
        ]);

      const { qualified, unavailable } = await sut.getCompatibility();
      expect(qualified).toEqual([]);
      expect(unavailable).toHaveLength(5);
    });
  });
});
