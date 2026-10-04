import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { ICloudAuditService } from 'src/services/icloud-audit.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { getMocks } from 'test/utils.js';

/** Real stream, staging and digest calculation; database CAS is covered by the medium suite. */
describe(ICloudAuditService.name, () => {
  let directory: string;
  let service: ICloudAuditService;
  let operation: MediaOperation;
  let resource: ICloudResource;
  let expected: Buffer;
  let current = true;
  const fresh = Buffer.from('fresh provider source bytes');
  const token = randomUUID();
  const repository = {
    operationPurpose: vi.fn(),
    get: vi.fn(),
    check: vi.fn(),
    setItemClaim: vi.fn(),
    allocate: vi.fn(),
    publishMatch: vi.fn(),
    housekeeping: vi.fn(),
  };
  const sync = { progress: vi.fn(), get: vi.fn(), withSession: vi.fn(), resource: vi.fn(), finish: vi.fn() };
  const identities = { claim: vi.fn(), renew: vi.fn(), release: vi.fn() };
  const transport = { enabled: vi.fn(), download: vi.fn(), decodeSession: vi.fn(), encodeSession: vi.fn() };
  const operations = {
    reportProgress: vi.fn(),
    heartbeat: vi.fn(),
    requeue: vi.fn(),
    fail: vi.fn(),
    acknowledgeCancel: vi.fn(),
    beginValidation: vi.fn(),
    complete: vi.fn(),
  };
  const recovery = { reconcile: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    current = true;
    directory = await realpath(await mkdtemp(join(tmpdir(), 'icloud-audit-worker-')));
    StorageCore.setMediaLocation(join(directory, 'managed'));
    vi.stubEnv('FRAMELEAF_ICLOUD_STAGING_PATH', join(directory, 'private'));
    vi.stubEnv('FRAMELEAF_ICLOUD_FREE_SPACE_BYTES', '0');
    const ownerId = randomUUID(),
      connectionId = randomUUID(),
      auditRequestId = randomUUID(),
      claimId = randomUUID();
    operation = {
      id: randomUUID(),
      ownerId,
      kind: MediaOperationKind.ICloudSync,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Verify iCloud originals',
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: { task: 'identity-audit', auditIds: [auditRequestId] },
      settings: {},
      estimate: null,
      result: null,
      status: MediaOperationStatus.Rendering,
      progress: 0,
      processedUnits: 0,
      totalUnits: 1,
      outputBytes: 0,
      attempt: 1,
      attemptStartedAt: new Date('2026-10-03T00:00:00Z'),
      maxAttempts: 3,
      autoRetries: 0,
      retryAt: null,
      claimToken: token,
      claimedBy: 'fixture-audit-worker',
      claimExpiresAt: new Date('2099-10-03T00:00:00Z'),
      heartbeatAt: new Date('2026-10-03T00:00:00Z'),
      lastAdmissionRefusalReason: null,
      lastAdmissionRefusedAt: null,
      admissionRefusals: 0,
      cancelRequestedAt: null,
      cancelAcknowledgedAt: null,
      pauseRequestedAt: null,
      remoteJobId: null,
      remoteReleasedAt: null,
      error: null,
      errorCode: null,
      startedAt: new Date('2026-10-03T00:00:00Z'),
      finishedAt: null,
      dismissedAt: null,
      createdAt: new Date('2026-10-03T00:00:00Z'),
      updatedAt: new Date('2026-10-03T00:00:00Z'),
      updateId: randomUUID(),
    };
    resource = {
      id: randomUUID(),
      auditRequestId,
      ownerId,
      connectionId,
      libraryKey: 'private',
      library: { area: 'private', zoneID: { zoneName: 'PrimarySync' } },
      sourceAssetId: '32A01DD9-75DF-41B2-8773-80C153D73A5A',
      recordId: 'actual-master',
      resourceKey: 'resOriginalRes',
      role: 'original',
      fingerprint: 'actual-fingerprint',
      expectedSize: fresh.length,
      status: 'running',
      sha1: null,
      sha256: null,
      assetId: null,
      path: null,
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date('2099-10-03T00:00:00Z'),
      stagingPath: null,
      promotedPath: null,
      expectedTarget: null,
      verification: null,
      pendingJobs: [],
      attempts: 1,
      reservedBytes: 0,
      lastError: null,
      source: { type: AssetType.Image, originalFileName: 'source.jpg' },
    };
    const connection = {
      id: connectionId,
      ownerId,
      state: 'connected',
      encryptedSession: 'fixture',
      config: ICloudConfigSchema.parse({}),
    };
    expected = createHash('sha256').update(fresh).digest();
    repository.get.mockImplementation(() =>
      Promise.resolve({ id: auditRequestId, operationId: operation.id, result: 'running' }),
    );
    repository.check.mockImplementation(() =>
      Promise.resolve(
        current ? { source: resource, connection, private: false, request: { expectedSha256: expected } } : undefined,
      ),
    );
    repository.allocate.mockResolvedValue(resource);
    identities.claim.mockImplementation(() =>
      Promise.resolve([{ id: claimId, holder: `icloud-sync:audit:${operation.id}` }]),
    );
    identities.renew.mockResolvedValue([{ id: claimId }]);
    sync.progress.mockResolvedValue(true);
    sync.get.mockResolvedValue(connection);
    sync.withSession.mockImplementation(async (_id, _owner, callback) => (await callback(connection)).value);
    sync.resource.mockImplementation(() => Promise.resolve({ ...resource, status: 'committed' }));
    transport.enabled.mockReturnValue(true);
    transport.download.mockImplementation(() =>
      Promise.resolve({
        stream: Readable.from([fresh]),
        session: { version: 1 },
        fingerprint: resource.fingerprint,
        size: fresh.length,
      }),
    );
    operations.reportProgress.mockResolvedValue(true);
    operations.heartbeat.mockResolvedValue(true);
    operations.beginValidation.mockResolvedValue(true);
    operations.complete.mockResolvedValue(true);
    repository.publishMatch.mockImplementation(async (_authority, _resource, verified, validate) => {
      expect(verified.sha256).toEqual(createHash('sha256').update(fresh).digest());
      expect((await validate()).sha256).toEqual(verified.sha256);
      return current;
    });
    recovery.reconcile.mockResolvedValue({ outcome: 'imported', assetId: randomUUID() });
    const mocks = getMocks();
    mocks.media.decodeImage.mockResolvedValue({ data: fresh, info: {} } as never);
    const staging = new ICloudStagingService(
      sync as never,
      transport as never,
      { getAll: vi.fn().mockResolvedValue([]) } as never,
    );
    const integrity = new MediaIntegrityService(
      new StorageRepository(mocks.logger as never),
      new CryptoRepository(),
      mocks.media as never,
    );
    service = new ICloudAuditService(
      repository as never,
      sync as never,
      identities as never,
      transport as never,
      staging,
      integrity,
      recovery as never,
      operations as never,
      {} as never,
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([{ purpose: 'scheduled-weekly' }, { grantId: null }, { cohortId: 'reserved' }, { purpose: null }])(
    'refuses scheduled bindings in the direct manual worker before byte work: %j',
    async (input) => {
      operation.snapshot = { ...operation.snapshot, ...input };
      await service.run(operation, token);
      expect(operations.fail).toHaveBeenCalledWith(
        operation.id,
        token,
        { error: 'Invalid audit request', errorCode: 'icloud_audit_snapshot_invalid' },
        { retry: false },
      );
      expect(repository.get).not.toHaveBeenCalled();
      expect(repository.allocate).not.toHaveBeenCalled();
      expect(transport.download).not.toHaveBeenCalled();
      expect(recovery.reconcile).not.toHaveBeenCalled();
    },
  );

  it('certifies freshly fetched bytes rather than hashing a mapped local original', async () => {
    const original = join(directory, 'already-mapped.jpg');
    await writeFile(original, 'unrelated mapped bytes');
    await service.run(operation, token);
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(repository.publishMatch).toHaveBeenCalledTimes(1);
    expect(recovery.reconcile).not.toHaveBeenCalled();
    expect(operations.complete).toHaveBeenCalled();
    expect(await readFile(original, 'utf8')).toBe('unrelated mapped bytes');
    expect(await readFile(join(directory, 'private', resource.id, 'complete'))).toEqual(fresh);
    expect(identities.release).toHaveBeenCalled();
  });

  it('hands differing source bytes to request-bound recovery without publishing match', async () => {
    expected = Buffer.alloc(32, 9);
    await service.run(operation, token);
    expect(repository.publishMatch).not.toHaveBeenCalled();
    expect(recovery.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: resource.id,
        audit: { auditRequestId: resource.auditRequestId, operationId: operation.id, operationClaimToken: token },
        stagedPath: join(directory, 'private', resource.id, 'complete'),
      }),
    );
    expect(operations.complete).toHaveBeenCalled();
  });

  it('does not publish or import when source authority is revoked before a blocked stream finishes', async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    transport.download.mockImplementation(() =>
      Promise.resolve({
        stream: Readable.from(
          (async function* () {
            entered.resolve();
            await release.promise;
            yield fresh;
          })(),
        ),
        session: {},
        fingerprint: resource.fingerprint,
        size: fresh.length,
      }),
    );
    const running = service.run(operation, token);
    await entered.promise;
    current = false;
    release.resolve();
    await running;
    expect(repository.publishMatch).not.toHaveBeenCalled();
    expect(recovery.reconcile).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
    expect(operations.fail).toHaveBeenCalled();
    expect(identities.release).toHaveBeenCalled();
  });

  it('releases the item claim before requeuing a staging-capacity refusal', async () => {
    repository.allocate.mockResolvedValue(undefined);
    await service.run(operation, token);
    expect(transport.download).not.toHaveBeenCalled();
    expect(identities.release).toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
  });
});
