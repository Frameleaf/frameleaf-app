import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { manualAuditClaimHolder } from 'src/repositories/icloud-audit.repository.js';
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
    stopState: vi.fn(),
  };
  const sync = { progress: vi.fn(), get: vi.fn(), withSession: vi.fn(), resource: vi.fn(), finish: vi.fn() };
  const identities = { claim: vi.fn(), renew: vi.fn(), release: vi.fn() };
  const transport = { enabled: vi.fn(), download: vi.fn(), decodeSession: vi.fn(), encodeSession: vi.fn() };
  const operations = {
    reportProgress: vi.fn(),
    settlePause: vi.fn(),
    getForWorker: vi.fn(),
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
    repository.stopState.mockImplementation(() =>
      Promise.resolve({
        live: operation.claimToken === token && operation.claimExpiresAt! > new Date(),
        pauseRequestedAt: operation.pauseRequestedAt,
        cancelRequestedAt: operation.cancelRequestedAt,
      }),
    );
    repository.allocate.mockResolvedValue(resource);
    identities.claim.mockImplementation(() =>
      Promise.resolve([
        {
          id: claimId,
          holder: manualAuditClaimHolder(operation.ownerId, { operationId: operation.id, operationClaimToken: token }),
        },
      ]),
    );
    identities.renew.mockResolvedValue([{ id: claimId }]);
    identities.release.mockResolvedValue([]);
    sync.finish.mockResolvedValue(undefined);
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
    operations.requeue.mockResolvedValue(true);
    operations.acknowledgeCancel.mockResolvedValue(true);
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

  it('derives an owner/operation/incarnation-scoped digest without placing the raw token in claim metadata', () => {
    const authority = { operationId: operation.id, operationClaimToken: token };
    const holder = manualAuditClaimHolder(operation.ownerId, authority);
    const digest = createHash('sha256')
      .update('frameleaf:manual-identity-audit:item-claim:v1\0')
      .update(JSON.stringify([operation.ownerId, operation.id, token]))
      .digest('hex');
    expect(holder).toBe(`icloud-sync:audit:${operation.id}:v1:${digest}`);
    expect(holder).not.toContain(token);
    expect(manualAuditClaimHolder(randomUUID(), authority)).not.toBe(holder);
    expect(manualAuditClaimHolder(operation.ownerId, { ...authority, operationId: randomUUID() })).not.toBe(holder);
    expect(manualAuditClaimHolder(operation.ownerId, { ...authority, operationClaimToken: randomUUID() })).not.toBe(
      holder,
    );
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

  it('settles an owner pause during the real on-demand audit stream without consuming a failure retry', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    operations.getForWorker.mockImplementation(() => Promise.resolve(operation));
    operations.settlePause.mockResolvedValue(true);
    sync.resource.mockImplementation(() => Promise.resolve({ ...resource, status: 'running' }));
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
    operation.pauseRequestedAt = new Date();
    // The production DB guard excludes paused requests; retain that real guard outcome at this mocked DB boundary.
    current = false;
    release.resolve();
    await running;
    expect(repository.publishMatch).not.toHaveBeenCalled();
    expect(recovery.reconcile).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
    expect(identities.release).toHaveBeenCalled();
    expect(sync.finish).toHaveBeenCalled();
    expect(operations.fail).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
      delayMs: 0,
      returnAttempt: true,
      requireActiveClaim: true,
    });
    expect(sync.finish.mock.invocationCallOrder[0]).toBeLessThan(operations.requeue.mock.invocationCallOrder[0]);
    expect(identities.release.mock.invocationCallOrder[0]).toBeLessThan(operations.requeue.mock.invocationCallOrder[0]);
    operation.pauseRequestedAt = null;
    current = true;
    sync.resource.mockImplementation(() => Promise.resolve({ ...resource, status: 'committed' }));
    await service.run(operation, token);
    expect(transport.download).toHaveBeenCalledTimes(2);
    expect(repository.publishMatch).toHaveBeenCalledTimes(1);
    expect(operations.complete).toHaveBeenCalledTimes(1);
  });

  it('withdraws a pause at settlement into a fresh verification without reusing interrupted bytes', async () => {
    current = false;
    operation.pauseRequestedAt = new Date();
    operations.requeue.mockImplementation(() => {
      operation.pauseRequestedAt = null;
      return Promise.resolve(true);
    });
    await service.run(operation, token);
    expect(operations.fail).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
      delayMs: 0,
      returnAttempt: true,
      requireActiveClaim: true,
    });
    expect(repository.publishMatch).not.toHaveBeenCalled();
    current = true;
    await service.run(operation, token);
    expect(transport.download).toHaveBeenCalledTimes(1);
    expect(repository.publishMatch).toHaveBeenCalledTimes(1);
    expect(operations.complete).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'replaced', 'cancelled'])(
    'hands an interrupted %s claim to token-fenced control settlement',
    async (reason) => {
      current = false;
      switch (reason) {
        case 'expired': {
          operation.claimExpiresAt = new Date(0);
          break;
        }
        case 'replaced': {
          operation.claimToken = randomUUID();
          break;
        }
        case 'cancelled': {
          operation.cancelRequestedAt = new Date();
          operation.pauseRequestedAt = new Date();
          break;
        }
      }
      await service.run(operation, token);
      expect(operations.fail).not.toHaveBeenCalled();
      expect(repository.publishMatch).not.toHaveBeenCalled();
      expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
        delayMs: 0,
        returnAttempt: true,
        requireActiveClaim: true,
      });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operation.id, token, {
        released: true,
        requireActiveClaim: true,
      });
    },
  );

  it.each(['transport', 'integrity'])('retains a genuine %s failure when a pause is also pending', async (reason) => {
    if (reason === 'transport') {
      transport.download.mockImplementation(() => {
        operation.pauseRequestedAt = new Date();
        throw new Error('fixture_transport_error');
      });
    } else {
      // The fixture decoder is a boundary mock; malformed bytes still exercise the real validator refusal.
      transport.download.mockImplementation(() => {
        operation.pauseRequestedAt = new Date();
        return Promise.resolve({
          stream: Readable.from([Buffer.alloc(fresh.length - 1)]),
          session: {},
          fingerprint: resource.fingerprint,
          size: fresh.length,
        });
      });
    }
    await service.run(operation, token);
    expect(operations.fail).toHaveBeenCalledWith(
      operation.id,
      token,
      { error: 'iCloud audit did not complete', errorCode: 'icloud_audit_failed' },
      { requireActiveClaim: true },
    );
    expect(operations.requeue).not.toHaveBeenCalled();
    expect(repository.publishMatch).not.toHaveBeenCalled();
    expect(identities.release).toHaveBeenCalled();
  });

  it('settles a mismatch-copy publication authority pause without treating a genuine recovery failure as a pause', async () => {
    expected = Buffer.alloc(32, 9);
    recovery.reconcile.mockImplementation(() => {
      operation.pauseRequestedAt = new Date();
      return Promise.resolve({ outcome: 'retry', reason: 'manual_audit_authority_changed' });
    });
    await service.run(operation, token);
    expect(operations.fail).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
      delayMs: 0,
      returnAttempt: true,
      requireActiveClaim: true,
    });
    expect(identities.release.mock.invocationCallOrder[0]).toBeLessThan(operations.requeue.mock.invocationCallOrder[0]);
    operation.pauseRequestedAt = null;
    recovery.reconcile.mockImplementation(() => {
      operation.pauseRequestedAt = new Date();
      return Promise.resolve({ outcome: 'retry', reason: 'recovery_not_committed' });
    });
    await service.run(operation, token);
    expect(operations.fail).toHaveBeenCalledTimes(1);
  });

  it.each(['claim', 'allocation'])(
    'acknowledges a cancellation that arrives during %s capacity refusal',
    async (phase) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      if (phase === 'claim')
        identities.claim.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return [];
        });
      else
        repository.allocate.mockImplementation(async () => {
          entered.resolve();
          await release.promise;
          return;
        });
      operations.requeue.mockResolvedValue(false);
      const running = service.run(operation, token);
      await entered.promise;
      operation.cancelRequestedAt = new Date();
      release.resolve();
      await running;
      expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
        delayMs: 60_000,
        returnAttempt: true,
        requireActiveClaim: true,
      });
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith(operation.id, token, {
        released: true,
        requireActiveClaim: true,
      });
      expect(transport.download).not.toHaveBeenCalled();
      if (phase === 'allocation')
        expect(identities.release.mock.invocationCallOrder[0]).toBeLessThan(
          operations.acknowledgeCancel.mock.invocationCallOrder[0],
        );
      else expect(identities.release).not.toHaveBeenCalled();
    },
  );

  it.each(['cancel', 'pause'].flatMap((stop) => ['resource', 'finish', 'claim'].map((cleanup) => ({ stop, cleanup }))))(
    'retains $cleanup cleanup failure during $stop without a false release acknowledgement or successful pause',
    async ({ stop, cleanup }) => {
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
      sync.resource.mockResolvedValue({ ...resource, status: 'running' });
      if (cleanup === 'resource') sync.resource.mockRejectedValue(new Error('fixture_resource_cleanup_failure'));
      else if (cleanup === 'finish') sync.finish.mockRejectedValue(new Error('fixture_finish_cleanup_failure'));
      else identities.release.mockRejectedValue(new Error('fixture_claim_cleanup_failure'));
      const running = service.run(operation, token);
      await entered.promise;
      if (stop === 'cancel') operation.cancelRequestedAt = new Date();
      else operation.pauseRequestedAt = new Date();
      current = false;
      release.resolve();
      await running;
      expect(identities.release).toHaveBeenCalledTimes(1);
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.acknowledgeCancel).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        operation.id,
        token,
        { error: 'iCloud audit did not complete', errorCode: 'icloud_audit_failed' },
        { requireActiveClaim: true },
      );
      expect(operations.complete).not.toHaveBeenCalled();
      expect(repository.publishMatch).not.toHaveBeenCalled();
    },
  );

  it('backs off a live older incarnation without inheriting or releasing its item claim', async () => {
    identities.claim.mockResolvedValue([{ id: randomUUID(), holder: `icloud-sync:audit:${operation.id}` }]);
    await service.run(operation, token);
    expect(repository.allocate).not.toHaveBeenCalled();
    expect(transport.download).not.toHaveBeenCalled();
    expect(identities.release).not.toHaveBeenCalled();
    expect(operations.fail).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledWith(operation.id, token, {
      delayMs: 60_000,
      returnAttempt: true,
      requireActiveClaim: true,
    });
  });

  it('releases the item claim before requeuing a staging-capacity refusal', async () => {
    repository.allocate.mockResolvedValue(undefined);
    await service.run(operation, token);
    expect(transport.download).not.toHaveBeenCalled();
    expect(identities.release).toHaveBeenCalledWith(
      operation.ownerId,
      [expect.any(String)],
      manualAuditClaimHolder(operation.ownerId, { operationId: operation.id, operationClaimToken: token }),
    );
    expect(identities.release.mock.invocationCallOrder[0]).toBeLessThan(operations.requeue.mock.invocationCallOrder[0]);
    expect(operations.requeue).toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
  });
});
