import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { RenderWorkerAdmissionDto } from 'src/dtos/render-worker.dto.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
} from 'src/enum.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { BUNDLED_RENDER_WORKER_APPROVAL } from 'src/utils/bundled-render-worker.js';
import { evaluateApprovedRenderSession } from 'src/utils/gpu-working-budget-policy.js';
import { SDR_TEN_BIT_PROFILE } from 'src/utils/render-admission.js';
import { seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

// FL-408: the server-enrolled bundled machine-learning Studio worker, through the real SQL fences.
let db: Kysely<DB>;
let sut: RenderWorkerRepository;
const ttlMs = 12 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const engine = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';

const bundledWorker = async () => {
  const secret = randomBytes(32);
  const worker = await sut.createWorker({
    name: `bundled ${randomUUID()}`,
    destination: MediaOperationDestination.Local,
    kinds: [MediaOperationKind.StudioExport],
    enrolmentSecret: secret,
    engineDigest: null,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: null,
    createdBy: null,
    gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
  });
  return { worker, secret };
};

const admission = (
  worker: { id: string },
  secret: Buffer,
  overrides: Partial<Omit<RenderWorkerAdmissionDto, 'enrolmentSecret'>> = {},
) => ({
  report: {
    workerId: worker.id,
    engineDigest: engine,
    conformanceReportedAt: new Date(Date.now() - 1000).toISOString(),
    softwareRenderer: true,
    gpuMemoryBytes: String(4 * GIB),
    codecs: ['webcodecs-avc', 'webcodecs-aac'],
    formats: ['mp4'],
    ...overrides,
  },
  enrolmentSecret: secret,
  token: randomBytes(32),
  ttlMs,
});

const queueExport = async (resolution = '720p') => {
  const owner = await seedCanonicalUser(db, {});
  return db
    .insertInto('media_operation')
    .values({
      ownerId: owner.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'bundled claim',
      snapshot: { engineDigest: engine },
      settings: { format: 'mp4-h264', resolution, color: 'preserve', quality: 'high', audio: 'preserve' },
    })
    .returningAll()
    .executeTakeFirstOrThrow();
};

const claimOptions = (
  operation: Awaited<ReturnType<typeof queueExport>>,
  workerId: string,
  sessionId: string,
  token: Buffer,
) => ({
  id: operation.id,
  workerId,
  sessionId,
  sessionTokenHash: token,
  leaseMs: 10_000,
  expected: operation,
  destinationHealth: {
    destination: MediaOperationDestination.Local,
    state: 'available' as const,
    reason: null,
    // a second in the past: the host and database clocks may differ by a little
    checkedAt: new Date(Date.now() - 1000),
  },
  defaultInstanceLimits: { maxConcurrentOperations: 2, maxWallClockMs: null, maxOutputBytes: null },
});

beforeAll(async () => {
  db = await getKyselyDB();
  sut = new RenderWorkerRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});

describe('bundled Studio worker admission (FL-408)', () => {
  it('admits a declared software renderer without hardware evidence and records what it proved', async () => {
    const { worker, secret } = await bundledWorker();
    const result = await sut.admitSession(admission(worker, secret));
    if (!result.admitted) throw new Error(`Expected admission, got ${result.reason}`);
    expect(result.session).toMatchObject({
      workerId: worker.id,
      scopes: [MediaOperationKind.StudioExport],
      gpuMemoryBytes: String(4 * GIB),
      gpuWorkingBudgetEvidence: null,
      engineDigest: engine,
    });
    expect(await sut.getSessionCapabilities(result.session.id)).toEqual({
      codecs: ['webcodecs-avc', 'webcodecs-aac'],
      formats: ['mp4'],
    });
    const audit = await db
      .selectFrom('render_worker_audit')
      .selectAll()
      .where('workerId', '=', worker.id)
      .where('event', '=', RenderWorkerAuditEvent.Admitted)
      .executeTakeFirstOrThrow();
    expect(audit.detail).toMatchObject({ bundled: true, softwareRenderer: true });

    const live = (await sut.listLiveSessions()).find((entry) => entry.worker.id === worker.id);
    if (!live) throw new Error('Expected a live session');
    const capabilities = await sut.getSessionCapabilities(live.session.id);
    expect(evaluateApprovedRenderSession({ ...live, capabilities, now: new Date() })).toMatchObject({ valid: true });
  });

  it('refuses the wrong secret, hardware evidence it cannot have, too little memory and replays', async () => {
    const { worker, secret } = await bundledWorker();
    expect(await sut.admitSession(admission(worker, randomBytes(32)))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.InvalidCredential,
    });
    expect(
      await sut.admitSession(admission(worker, secret, { gpuWorkingBudgetEvidence: { workerId: worker.id } as never })),
    ).toMatchObject({ admitted: false, reason: RenderWorkerRefusalReason.GpuMemoryInsufficient });
    expect(await sut.admitSession(admission(worker, secret, { gpuMemoryBytes: String(GIB) }))).toMatchObject({
      admitted: false,
      reason: RenderWorkerRefusalReason.GpuMemoryInsufficient,
    });
    const reportedAt = new Date(Date.now() - 2000).toISOString();
    expect((await sut.admitSession(admission(worker, secret, { conformanceReportedAt: reportedAt }))).admitted).toBe(
      true,
    );
    expect(await sut.admitSession(admission(worker, secret, { conformanceReportedAt: reportedAt }))).toEqual({
      admitted: false,
      reason: RenderWorkerRefusalReason.ConformanceReplayed,
    });
  });

  it('replaces the session a restarted container lost, and refuses while it still holds a claim', async () => {
    const { worker, secret } = await bundledWorker();
    const first = await sut.admitSession(
      admission(worker, secret, { conformanceReportedAt: new Date(Date.now() - 3000).toISOString() }),
    );
    if (!first.admitted) throw new Error('Expected first admission');
    const firstToken = admission(worker, secret).token;
    await db
      .updateTable('render_worker_session')
      .set({ token: firstToken })
      .where('id', '=', first.session.id)
      .execute();

    const operation = await queueExport();
    const claimed = await sut.claimQueued(claimOptions(operation, worker.id, first.session.id, firstToken));
    expect(claimed).toMatchObject({ operation: { status: MediaOperationStatus.Preparing, claimedBy: worker.id } });

    // A restart mid-render cannot open a second session beside the claim it still holds.
    expect(
      await sut.admitSession(
        admission(worker, secret, { conformanceReportedAt: new Date(Date.now() - 2000).toISOString() }),
      ),
    ).toEqual({ admitted: false, reason: RenderWorkerRefusalReason.WorkerConcurrency });

    // Once the claim is settled (here: lease recovery requeued it), the new session replaces the old one.
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Queued, claimedBy: null, claimToken: null })
      .where('id', '=', operation.id)
      .execute();
    const second = await sut.admitSession(
      admission(worker, secret, { conformanceReportedAt: new Date(Date.now() - 1000).toISOString() }),
    );
    if (!second.admitted) throw new Error(`Expected re-admission, got ${second.reason}`);
    const sessions = await db
      .selectFrom('render_worker_session')
      .select(['id', 'revokedAt'])
      .where('workerId', '=', worker.id)
      .execute();
    expect(sessions.find((row) => row.id === first.session.id)?.revokedAt).not.toBeNull();
    expect(sessions.find((row) => row.id === second.session.id)?.revokedAt).toBeNull();
  });
});

describe('bundled Studio worker claims (FL-408)', () => {
  const admitted = async (memory = 4 * GIB) => {
    const { worker, secret } = await bundledWorker();
    const input = admission(worker, secret, { gpuMemoryBytes: String(memory) });
    const result = await sut.admitSession(input);
    if (!result.admitted) throw new Error('Expected admission');
    return { worker, session: result.session, token: input.token };
  };

  it('claims a local export it proved it can write within its working memory', async () => {
    const { worker, session, token } = await admitted();
    const operation = await queueExport('1080p');
    const result = await sut.claimQueued(claimOptions(operation, worker.id, session.id, token));
    expect(result).toMatchObject({
      operation: { id: operation.id, status: MediaOperationStatus.Preparing, claimedBy: worker.id, attempt: 1 },
      engineDigest: engine,
    });
  });

  it('refuses a resolution beyond its working memory', async () => {
    const { worker, session, token } = await admitted(2 * GIB);
    const operation = await queueExport('1080p');
    expect(await sut.claimQueued(claimOptions(operation, worker.id, session.id, token))).toEqual({
      refused: RenderWorkerRefusalReason.GpuMemoryInsufficient,
    });
  });

  it('refuses a format its conformance encode did not produce', async () => {
    const { worker, session, token } = await admitted();
    const operation = await queueExport();
    await db
      .updateTable('media_operation')
      .set({ settings: { ...operation.settings, format: 'webm-av1' } })
      .where('id', '=', operation.id)
      .execute();
    const expected = { ...operation, settings: { ...operation.settings, format: 'webm-av1' } };
    expect(await sut.claimQueued({ ...claimOptions(operation, worker.id, session.id, token), expected })).toEqual({
      refused: RenderWorkerRefusalReason.CodecUnsupported,
    });
  });

  it('leaves a sealed SDR Main10 export to a worker that writes 10-bit SDR, not one with HDR masters only (FL-674)', async () => {
    const claimable = async (formats: string[]) => {
      const { worker, secret } = await bundledWorker();
      const input = admission(worker, secret, {
        codecs: ['webcodecs-avc', 'webcodecs-aac', 'libx265'],
        formats,
        colorPrecision: { maxBitDepth: 10, hdr10: true, dolbyVision: false },
      });
      const result = await sut.admitSession(input);
      if (!result.admitted) throw new Error(`Expected admission, got ${result.reason}`);
      const operation = await queueExport();
      const settings = { ...operation.settings, format: 'mp4-hevc-main10' };
      const snapshot = { engineDigest: engine, contract: { video: { minBitDepth: 10, transfer: null } } };
      await db.updateTable('media_operation').set({ settings, snapshot }).where('id', '=', operation.id).execute();
      return sut.claimQueued({
        ...claimOptions(operation, worker.id, result.session.id, input.token),
        expected: { ...operation, settings, snapshot },
      });
    };
    const masters = ['mp4', 'mp4-hevc-main10', 'mp4-hevc-main10+pq', 'mp4-hevc-main10+hlg'];
    expect(await claimable(masters)).toEqual({ refused: RenderWorkerRefusalReason.CodecUnsupported });
    expect(await claimable([...masters, SDR_TEN_BIT_PROFILE])).toMatchObject({
      operation: { status: MediaOperationStatus.Preparing },
    });
  });

  it('refuses when local health is not available, and once the bundled worker is revoked', async () => {
    const { worker, session, token } = await admitted();
    const operation = await queueExport();
    const options = claimOptions(operation, worker.id, session.id, token);
    expect(
      await sut.claimQueued({
        ...options,
        destinationHealth: { ...options.destinationHealth, state: 'unknown' as never },
      }),
    ).toEqual({ refused: RenderWorkerRefusalReason.DestinationUnavailable });
    await sut.revokeWorker(worker.id);
    expect(await sut.claimQueued(options)).toMatchObject({ refused: expect.any(String) });
    const row = await db
      .selectFrom('media_operation')
      .select('status')
      .where('id', '=', operation.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe(MediaOperationStatus.Queued);
  });
});
