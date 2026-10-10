import { createHash, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DatabaseLock,
  MediaOperationKind,
  MediaOperationStatus,
  NotificationLevel,
  NotificationType,
} from 'src/enum.js';
import { BuddyBackupRepository, type BuddyState } from 'src/repositories/buddy-backup.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { BuddyBackupCaptureService, type BuddyCapture } from 'src/services/buddy-backup-capture.service.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BuddyBackupService } from 'src/services/buddy-backup.service.js';
import { buddyObjectId, createBuddyKeyring, encryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { buddyCommitReceipt } from 'src/utils/buddy-backup-protocol.js';
import { type BuddySignedSnapshot, BuddyVault } from 'src/utils/buddy-backup-vault.js';
import { CLOUD_BACKUP_MANIFEST_FORMAT } from 'src/utils/cloud-backup.js';
import { BuddyGrantResponse, BuddyPairing } from 'src/utils/frameleaf-buddy.js';
import { type FrameleafKeySigner, jwsSigningInput } from 'src/utils/frameleaf-dpop.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { makeLicenseSigner } from 'test/fixtures/frameleaf-license.fixture.js';
import { automock } from 'test/utils.js';

const now = new Date('2026-10-02T23:59:00.000Z');

const makeSigner = (): FrameleafKeySigner => {
  const { privateKey, key } = makeLicenseSigner();
  return {
    kid: key.kid,
    publicJwk: { kty: 'OKP', crv: 'Ed25519', x: key.x },
    signBytes: (bytes) => sign(null, bytes, privateKey),
    sign: (header, payload) => {
      const input = jwsSigningInput(header, payload);
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    },
  };
};

const createRunFixture = async (directory: string) => {
  const source = makeSigner();
  const destination = makeSigner();
  const instanceId = randomUUID();
  const buddyId = randomUUID();
  const ring = createBuddyKeyring(randomUUID());
  const priorSnapshot = randomUUID();
  const pairing = BuddyPairing.parse({
    version: 1,
    pairId: randomUUID(),
    state: 'active',
    readUntil: null,
    vaults: [
      {
        vaultId: ring.vaultId,
        sourceInstanceId: instanceId,
        destinationInstanceId: buddyId,
        sourceKey: source.publicJwk,
        destinationKey: destination.publicJwk,
        quotaBytes: 10 * 1024 ** 3,
        retention: { days: 30, monthly: 12 },
      },
      {
        vaultId: randomUUID(),
        sourceInstanceId: buddyId,
        destinationInstanceId: instanceId,
        sourceKey: destination.publicJwk,
        destinationKey: source.publicJwk,
        quotaBytes: 10 * 1024 ** 3,
        retention: { days: 30, monthly: 12 },
      },
    ],
  });
  const operation = {
    id: randomUUID(),
    ownerId: authStub.admin.user.id,
    kind: MediaOperationKind.BuddyBackup,
    status: MediaOperationStatus.Rendering,
    claimToken: 'first-claim',
    cancelRequestedAt: null,
    pauseRequestedAt: null,
    result: {},
    snapshot: { version: 1, task: 'backup', pairId: pairing.pairId, vaultId: ring.vaultId, keyVersion: 1 },
  } as unknown as MediaOperation;
  const state: BuddyState = {
    version: 1,
    settings: {
      directory: join(directory, 'incoming'),
      quotaBytes: 10 * 1024 ** 3,
      uploadMbps: 20,
      downloadMbps: 20,
      schedule: '0 2 * * *',
      timezone: 'UTC',
      windowStart: '00:00',
      windowEnd: '00:00',
      pausedSending: false,
      pausedReceiving: true,
      includeDerived: false,
      configurationFiles: [],
    },
    pairing,
    recoveryVerified: true,
    probeVerified: true,
    nextScheduledAt: null,
    lastCompleteAt: '2026-10-01T02:00:00.000Z',
    lastVerifiedAt: null,
    lastSequence: 7,
    run: {
      id: operation.id,
      state: 'sending',
      startedAt: now.toISOString(),
      finishedAt: null,
      uploadedBytes: 0,
      totalBytes: 0,
      objects: 3,
      uploadedObjects: 0,
      error: null,
    },
  };
  await writeFile(join(directory, 'state.json'), JSON.stringify(state));
  await writeFile(join(directory, `${ring.vaultId}.keys.json`), JSON.stringify(ring));
  const repository = new BuddyBackupRepository(undefined as never, undefined as never);
  vi.spyOn(repository, 'root').mockReturnValue(directory);
  // Lock admission is covered by repository/PG specs; keep the real durable state reader and writer here.
  vi.spyOn(repository, 'locked').mockImplementation((_name, callback) => callback(undefined as never));
  const capture = new BuddyBackupCaptureService(repository, undefined as never, undefined as never, undefined as never);
  vi.spyOn(capture, 'reconcile').mockResolvedValue(undefined);
  const release = vi
    .spyOn(capture, 'release')
    .mockImplementation((id) => rm(capture.runDirectory(id), { recursive: true, force: true }));
  const captured: BuddyCapture = {
    manifest: {
      version: 1,
      vaultId: ring.vaultId,
      snapshotId: randomUUID(),
      sequence: 8,
      previous: priorSnapshot,
      frameleafVersion: 'test',
      contents: {},
      library: {
        format: CLOUD_BACKUP_MANIFEST_FORMAT,
        version: 2,
        instanceId,
        createdAt: now.toISOString(),
        database: null,
        assets: {},
        albums: {},
        people: {},
        profiles: {},
      },
      assetLinks: {},
      assetFiles: {},
      dependencies: [],
      configurationFiles: [],
      environment: {},
      storageRoot: directory,
      storageRoots: [directory],
      settings: { system: null, users: [] },
    },
    manifestBlocks: [],
    objects: [],
  };
  const addBlock = async (plain: Buffer) => {
    const key = Buffer.from(ring.keys[1], 'base64url');
    const id = buddyObjectId(key, ring.vaultId, plain);
    const sealed = encryptBuddyBlock(key, { vaultId: ring.vaultId, id, keyVersion: 1 }, plain);
    await writeFile(capture.blockPath(id, operation.id), sealed);
    captured.objects.push(BuddyVault.receipt(id, sealed));
    return id;
  };
  await mkdir(join(capture.runDirectory(operation.id), 'blocks'), { recursive: true });
  for (const plain of [Buffer.from('captured original'), Buffer.from('captured sidecar')]) {
    const id = await addBlock(plain);
    captured.manifest.contents[createHash('sha256').update(plain).digest('hex')] = {
      blocks: [id],
      bytes: plain.length,
      keyVersion: 1,
    };
  }
  captured.manifestBlocks.push(await addBlock(Buffer.from(JSON.stringify(captured.manifest))));
  const capturePath = join(capture.runDirectory(operation.id), 'capture.json');
  await writeFile(capturePath, JSON.stringify(captured));
  const captureBytes = await readFile(capturePath);
  const peer = automock(BuddyBackupPeerService, { strict: false });
  peer.identity.mockResolvedValue({ instanceId } as Awaited<ReturnType<BuddyBackupPeerService['identity']>>);
  peer.signer.mockReturnValue(source);
  const grant = BuddyGrantResponse.parse({
    version: 1,
    token: 'signed-test-capability',
    expiresAt: new Date(now.getTime() + 300_000).toISOString(),
    claims: {
      version: 1,
      iss: 'https://cloud.test',
      aud: 'frameleaf-buddy',
      sub: instanceId,
      jti: randomUUID(),
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 300,
      pairId: pairing.pairId,
      vaultId: ring.vaultId,
      sourceInstanceId: instanceId,
      destinationInstanceId: buddyId,
      scope: 'write',
      cnf: { jkt: source.kid, jwk: source.publicJwk },
      destinationKey: destination.publicJwk,
    },
    connections: [
      {
        kind: 'local',
        uri: 'https://buddy.test',
        protocol: 'https',
        address: 'buddy.test',
        port: 443,
        local: true,
        relay: false,
        ipv6: false,
        custom: false,
        dnsRebindingProtection: true,
        httpsRequired: true,
        verified: true,
      },
    ],
  });
  peer.grant.mockResolvedValue(grant);
  const operations = automock(MediaOperationRepository, { strict: false });
  operations.getActiveOfKind.mockImplementation((kind) =>
    Promise.resolve(kind === MediaOperationKind.BuddyBackup ? { id: operation.id, fingerprint: null } : undefined),
  );
  operations.getOfKind.mockImplementation(() => Promise.resolve(operation));
  operations.reportProgress.mockResolvedValue(true);
  operations.setBulkResult.mockResolvedValue(operation);
  operations.beginValidation.mockResolvedValue(true);
  operations.complete.mockResolvedValue(true);
  operations.requeue.mockImplementation(async (_id, _token, _options, settled) => {
    await settled?.(undefined as never);
    return true;
  });
  operations.requestPause.mockResolvedValue(operation);
  operations.resume.mockResolvedValue(operation);
  operations.requestCancel.mockResolvedValue(operation);
  operations.acknowledgeCancel.mockResolvedValue(true);
  operations.claimNext.mockResolvedValue(undefined);
  const rates = automock(RateLimitRepository, { strict: false });
  rates.hit.mockResolvedValue({ count: 1, resetSeconds: 1 });
  const logger = automock(LoggingRepository, { strict: false });
  const events = automock(EventRepository, { args: [undefined, undefined, logger], strict: false });
  const service = new BuddyBackupService(repository, peer, capture, operations, rates, events, logger);
  vi.spyOn(service, 'tick').mockImplementation(() => {});
  vi.spyOn(service, 'status').mockResolvedValue({} as never);
  const worker = service as unknown as {
    run: (operation: MediaOperation, token: string) => Promise<void>;
    drain: () => Promise<void>;
    housekeepingAt: number;
  };
  worker.housekeepingAt = Number.MAX_SAFE_INTEGER;
  const transport = {
    objects: new Map<string, Buffer>(),
    commits: [] as BuddySignedSnapshot[],
    onUpload: (): Promise<void> => Promise.resolve(),
    uploadStatus: 200,
    uploads: 0,
    interruptAt: 2,
  };
  const replies = automock(BuddyBackupPeerService, { strict: false });
  replies.signer.mockReturnValue(destination);
  // Only transport and PG are mocked. Production client request/proof/receipt validation still runs.
  const fetch = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname.split(`/${ring.vaultId}/`)[1];
    let data: unknown =
      path === 'snapshots' && options?.method === 'GET'
        ? [{ id: priorSnapshot, sequence: 7, keyVersion: 1, createdAt: state.lastCompleteAt }]
        : { ok: true };
    if (path === 'inventory') {
      const { ids } = JSON.parse(options!.body as string) as { ids: string[] };
      data = ids
        .filter((id) => transport.objects.has(id))
        .map((id) => BuddyVault.receipt(id, transport.objects.get(id)!));
    }
    if (path.startsWith('objects/')) {
      const chunks: Buffer[] = [];
      for await (const chunk of options!.body as unknown as Readable) chunks.push(Buffer.from(chunk));
      if (++transport.uploads === transport.interruptAt) await transport.onUpload();
      if (transport.uploadStatus !== 200) return new Response(null, { status: transport.uploadStatus });
      const id = path.slice('objects/'.length);
      const bytes = Buffer.concat(chunks);
      transport.objects.set(id, bytes);
      data = BuddyVault.receipt(id, bytes);
    }
    if (path === 'snapshots' && options?.method === 'POST') {
      const envelope = JSON.parse(options.body as string) as BuddySignedSnapshot;
      transport.commits.push(envelope);
      data = buddyCommitReceipt(envelope);
    }
    const proof = (options!.headers as Record<string, string>).DPoP;
    const { jti } = JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString()) as { jti: string };
    return Response.json(
      BuddyBackupPeerService.prototype.signed.call(
        replies,
        {
          grant: grant.claims,
          requestId: jti,
          vault: new BuddyVault(directory, ring.vaultId),
          quotaBytes: state.settings!.quotaBytes,
          uploadMbps: 20,
          downloadMbps: 20,
          sourceKey: source.publicJwk,
        },
        data,
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return {
    service,
    events,
    worker,
    repository,
    capture,
    release,
    operations,
    transport,
    grant,
    operation,
    captured,
    capturePath,
    captureBytes,
    state,
    fetch,
  };
};

describe('Buddy production run controls and checkpoints', () => {
  let directory: string;
  let fixture: Awaited<ReturnType<typeof createRunFixture>>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.stubEnv('FRAMELEAF_BUDDY_BACKUP', 'true');
    directory = await mkdtemp(join(tmpdir(), 'buddy-run-control-'));
    fixture = await createRunFixture(directory);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([
    ['2026-09-25T00:00:00.000Z', 'ended', '2026-11-07T12:30:00.000Z', 'buddy-backup-stale', 'buddy-pairing-ended'],
    [null, 'blocked', null, 'buddy-backup-first-stale', 'buddy-access-blocked'],
  ] as const)(
    'registers the %s / %s maintenance notices (FL-329)',
    async (lastCompleteAt, state, readUntil, stale, access) => {
      const { service, events, repository } = fixture;
      const current = await repository.update((current) => ({
        ...current,
        lastCompleteAt,
        protectionStartedAt: '2026-09-25T00:00:00.000Z',
        pairing: { ...current.pairing!, state, readUntil },
      }));
      await mkdir(current.settings!.directory, { recursive: true });
      vi.mocked(service.peer.pairing).mockResolvedValue(current.pairing);
      vi.mocked(service.peer.cloud).mockResolvedValue({ version: 1, reports: [] });
      vi.spyOn(BuddyVault.prototype, 'prune').mockResolvedValue({ committedBytes: 0, reservedBytes: 0 });
      vi.spyOn(BuddyVault.prototype, 'usage').mockResolvedValue({ committedBytes: 99 * 1024 ** 3, reservedBytes: 0 });

      await service['housekeeping']();
      const notices = events.emit.mock.calls.filter(([event]) => event === 'AdminNotify').map(([, notice]) => notice);
      expect(notices).toEqual([
        expect.objectContaining({ dedupeKey: 'buddy:stale', systemTemplate: { version: 1, key: stale, args: {} } }),
        expect.objectContaining({
          dedupeKey: 'buddy:capacity',
          systemTemplate: { version: 1, key: 'buddy-storage-low', args: {} },
        }),
        expect.objectContaining({
          dedupeKey: `buddy:${state}`,
          systemTemplate: { version: 1, key: access, args: readUntil ? { readUntil } : {} },
        }),
      ]);
      for (const notice of notices) {
        expect(notice).toMatchObject({
          type: NotificationType.SystemMessage,
          level: NotificationLevel.Warning,
          dedupeDays: 1,
        });
      }
    },
  );

  it.each(['timeout', 'reset', 'http-503'] as const)(
    'charges %s to the automatic retry budget and preserves its capture',
    async (fault) => {
      const { worker, operation, operations, fetch, capturePath, captureBytes } = fixture;
      if (fault === 'http-503') fetch.mockResolvedValue(new Response(null, { status: 503 }));
      else if (fault === 'reset')
        fetch.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
      else fetch.mockRejectedValue(new DOMException('stalled peer', 'TimeoutError'));
      await worker.run(operation, 'first-claim');
      expect(operations.requeue).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        operation.id,
        'first-claim',
        expect.objectContaining({ errorCode: 'buddy_incomplete' }),
        { retry: true },
      );
      expect(await readFile(capturePath)).toEqual(captureBytes);
    },
  );

  it('pauses at an upload checkpoint and resumes the same capture without resending acknowledged objects', async () => {
    const {
      service,
      worker,
      operations,
      operation,
      repository,
      transport,
      capturePath,
      captureBytes,
      release,
      captured,
      fetch,
      state,
    } = fixture;
    let paused = false;
    transport.onUpload = async () => {
      if (paused) return;
      paused = true;
      await service.control(authStub.admin, { action: 'pause-sending' });
    };
    await worker.run(operation, 'first-claim');

    expect(operations.requestPause).toHaveBeenCalledWith(operation.id, operation.ownerId, [
      MediaOperationKind.BuddyBackup,
      MediaOperationKind.BuddyRestore,
    ]);
    expect(operations.requeue).toHaveBeenCalledExactlyOnceWith(operation.id, 'first-claim', {
      delayMs: 30_000,
      returnAttempt: true,
    });
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastSequence: 7,
      settings: { pausedSending: true, pausedReceiving: true },
      run: { state: 'paused', uploadedObjects: 2 },
    });
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
    expect(transport.commits).toHaveLength(0);

    await service.control(authStub.admin, { action: 'resume-sending' });
    expect(operations.resume).toHaveBeenCalledExactlyOnceWith(operation.id, operation.ownerId);
    operation.claimToken = 'replacement-claim';
    await worker.run(operation, 'replacement-claim');
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/objects/'))).toHaveLength(3);
    expect(transport.commits).toHaveLength(1);
    expect(transport.commits[0].snapshot).toMatchObject({
      id: captured.manifest.snapshotId,
      sequence: 8,
      previous: captured.manifest.previous,
    });
    expect(operations.complete).toHaveBeenCalledExactlyOnceWith(
      operation.id,
      'replacement-claim',
      { resultAssetId: null },
      undefined,
      true,
    );
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: transport.commits[0].snapshot.createdAt,
      lastSequence: 8,
      settings: { pausedSending: false, pausedReceiving: true },
      run: { state: 'complete', uploadedObjects: 3 },
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(operation.id);
  });

  it('keeps restart staging until cancel acknowledgement, then starts a fresh operation', async () => {
    const { service, worker, operations, operation, repository, capturePath, captureBytes, release, state, transport } =
      fixture;
    transport.onUpload = async () => {
      await service.control(authStub.admin, { action: 'restart' });
      expect(operations.requestCancel).toHaveBeenCalledExactlyOnceWith(operation.id, operation.ownerId);
      expect(await readFile(capturePath)).toEqual(captureBytes);
      expect(release).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(join(directory, 'restart.json'), 'utf8'))).toEqual({
        ownerId: operation.ownerId,
      });
      // The real repository's cancel-request transition is independently covered by its PG spec.
      operation.cancelRequestedAt = new Date();
    };
    await worker.run(operation, 'first-claim');
    expect(transport.objects.size).toBe(2);
    expect(release).toHaveBeenCalledExactlyOnceWith(operation.id);
    expect(operations.acknowledgeCancel).toHaveBeenCalledExactlyOnceWith(operation.id, 'first-claim', {
      released: true,
    });
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(operations.acknowledgeCancel.mock.invocationCallOrder[0]);
    operations.getActiveOfKind.mockResolvedValue(undefined);
    operations.createExclusive.mockResolvedValue({
      created: { ...operation, id: randomUUID(), cancelRequestedAt: null },
    });
    await worker.drain();
    expect(operations.createExclusive).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: operation.ownerId,
        kind: MediaOperationKind.BuddyBackup,
        snapshot: operation.snapshot,
      }),
      DatabaseLock.BuddyBackup,
    );
    await expect(readFile(join(directory, 'restart.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastSequence: 7,
      settings: { pausedReceiving: true },
    });
    expect(transport.commits).toHaveLength(0);
    expect(operations.complete).not.toHaveBeenCalled();
  });

  it('preserves the encrypted capture and last restore point when a grant expires during an upload', async () => {
    const { worker, operation, transport, grant, operations, repository, capturePath, captureBytes, release, state } =
      fixture;
    // Let the first batch's signed acknowledgements settle before the final upload expires.
    transport.interruptAt = 3;
    transport.onUpload = () => {
      vi.setSystemTime(new Date(grant.claims.exp * 1000 + 1));
      transport.uploadStatus = 401;
      return Promise.resolve();
    };
    await worker.run(operation, 'first-claim');
    expect(transport.objects.size).toBe(2);
    expect(transport.commits).toHaveLength(0);
    expect(operations.beginValidation).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledWith(
      operation.id,
      'first-claim',
      expect.objectContaining({ returnAttempt: true }),
      expect.any(Function),
    );
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastSequence: 7,
      run: { state: 'waiting-authorization' },
    });
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
  });

  it('does not commit a restore point when pairing revocation is learned during an upload', async () => {
    const { worker, operation, transport, operations, repository, capturePath, captureBytes, release, state } = fixture;
    transport.onUpload = async () => {
      await repository.update((state) => ({ ...state, pairing: { ...state.pairing!, state: 'blocked' } }));
    };
    await worker.run(operation, 'first-claim');
    expect(transport.objects.size).toBe(2);
    expect(transport.commits).toHaveLength(0);
    expect(operations.complete).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledExactlyOnceWith(operation.id, 'first-claim', {
      delayMs: 30_000,
      returnAttempt: true,
    });
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastSequence: 7,
      run: { state: 'paused' },
    });
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
  });

  it.each(['restore', 'window'] as const)('yields to %s and keeps its upload checkpoint', async (reason) => {
    const { worker, operation, transport, operations, repository, capturePath, captureBytes, release, state } = fixture;
    let restoring = false;
    operations.getActiveOfKind.mockImplementation((kind) =>
      Promise.resolve(
        kind === MediaOperationKind.BuddyRestore && restoring
          ? { id: 'priority-restore', fingerprint: null }
          : kind === MediaOperationKind.BuddyBackup
            ? { id: operation.id, fingerprint: null }
            : undefined,
      ),
    );
    if (reason === 'window')
      await repository.update((state) => ({
        ...state,
        settings: { ...state.settings!, windowStart: '22:00', windowEnd: '00:00' },
      }));
    transport.onUpload = () => {
      if (reason === 'restore') restoring = true;
      else vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
      return Promise.resolve();
    };
    await worker.run(operation, 'first-claim');
    expect(transport.objects.size).toBe(2);
    expect(transport.commits).toHaveLength(0);
    expect(operations.complete).not.toHaveBeenCalled();
    expect(operations.requeue).toHaveBeenCalledExactlyOnceWith(operation.id, 'first-claim', {
      delayMs: 30_000,
      returnAttempt: true,
    });
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastSequence: 7,
      run: { state: 'paused', uploadedObjects: 2 },
    });
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
  });

  it('gives an already-active restore priority before claiming a backup', async () => {
    fixture.operations.getActiveOfKind.mockImplementation((kind) =>
      Promise.resolve({
        id: kind === MediaOperationKind.BuddyRestore ? 'priority-restore' : fixture.operation.id,
        fingerprint: null,
      }),
    );
    await fixture.worker.drain();
    expect(fixture.operations.getActiveOfKind).toHaveBeenCalledWith(MediaOperationKind.BuddyRestore);
    expect(fixture.operations.claimNext).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(await readFile(fixture.capturePath)).toEqual(fixture.captureBytes);
  });

  it('settles a rate-limited peer into the same durable operation and preserves its capture for recovery', async () => {
    const { worker, operation, fetch, operations, repository, capturePath, captureBytes, release, state } = fixture;
    fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await worker.run(operation, 'first-claim');
    expect(operations.requeue).toHaveBeenCalledExactlyOnceWith(
      operation.id,
      'first-claim',
      { delayMs: expect.any(Number), returnAttempt: true },
      expect.any(Function),
    );
    const delayMs = operations.requeue.mock.calls[0][2].delayMs;
    expect(delayMs).toBeGreaterThanOrEqual(60_000);
    expect(delayMs).toBeLessThan(120_000);
    expect(await repository.state()).toMatchObject({
      lastCompleteAt: state.lastCompleteAt,
      lastVerifiedAt: null,
      settings: { pausedSending: false },
      run: { id: operation.id, state: 'waiting-peer' },
    });
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
    expect(operations.complete).not.toHaveBeenCalled();
    expect(operations.fail).not.toHaveBeenCalled();

    operation.claimToken = 'recovered-claim';
    await worker.run(operation, 'recovered-claim');
    expect(operations.complete).toHaveBeenCalledExactlyOnceWith(
      operation.id,
      'recovered-claim',
      { resultAssetId: null },
      undefined,
      true,
    );
    expect(await repository.state()).toMatchObject({ run: { id: operation.id, state: 'complete' } });
  });

  it('does not overwrite a replacement worker status when its rate-limited-peer settlement loses the claim', async () => {
    const { worker, operation, fetch, operations, repository, capturePath, captureBytes, release, state } = fixture;
    operations.requeue.mockResolvedValue(false);
    fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await worker.run(operation, 'first-claim');
    expect(operations.requeue).toHaveBeenCalledTimes(1);
    expect(await repository.state()).toEqual(state);
    expect(await readFile(capturePath)).toEqual(captureBytes);
    expect(release).not.toHaveBeenCalled();
    expect(operations.fail).not.toHaveBeenCalled();
  });

  it('keeps same-operation replacement completion when the old worker resumes after successful settlement', async () => {
    const { worker, operation, fetch, operations, repository } = fixture;
    const { promise: oldBarrier, resolve: releaseOld } = Promise.withResolvers<void>();
    const { promise: settled, resolve: settledOld } = Promise.withResolvers<void>();
    operations.requeue.mockImplementationOnce(async (_id, _token, _options, publish) => {
      // The real repository calls publication before committing its locked requeue.
      await publish?.(undefined as never);
      settledOld();
      // Model a stalled old worker after committed requeue, before its await returns.
      await oldBarrier;
      return true;
    });
    fetch.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const oldWorker = worker.run(operation, 'first-claim');
    try {
      await settled;
      operation.claimToken = 'replacement-claim';
      await worker.run(operation, 'replacement-claim');
      const replacement = await repository.state();
      expect(replacement.run).toMatchObject({ id: operation.id, state: 'complete', error: null });
      releaseOld();
      await oldWorker;
      expect(await repository.state()).toEqual(replacement);
    } finally {
      releaseOld();
      await oldWorker;
    }
  });
});
