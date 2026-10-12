import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { RenderWorkerAdmissionDto } from 'src/dtos/render-worker.dto.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  MediaOperationStatus,
} from 'src/enum.js';
import { RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';
import { seedCanonicalUser } from 'test/fixtures/canonical-database.js';

let db: Kysely<DB>;
let sut: RenderWorkerRepository;
const ttlMs = 12 * 60 * 60 * 1000;
// Synthetic contract evidence exercises SQL fences; it does not qualify a real device.
const receipt = (deviceLifetimeId: string = randomUUID(), validFor = 60_000) => {
  const completedAt = new Date(Date.now() - 1000);
  return {
    metric: 'measured-usable-gpu-working-budget-v1' as const,
    profileDigest: 'a'.repeat(64),
    measurementId: randomUUID() as string,
    receiptDigest: randomBytes(32).toString('hex'),
    engineDigest: 'sha256:engine',
    buildDigest: 'c'.repeat(64),
    browserIdentity: 'synthetic-browser',
    deviceLifetimeId,
    bindingMethod: 'same-export-device' as const,
    topology: 'unknown' as const,
    topologyEvidenceDigest: null,
    hardwareBackend: 'hardware' as const,
    encoderEvidenceDigest: 'd'.repeat(64),
    pressureEnvelopeDigest: 'e'.repeat(64),
    outputReceiptDigest: 'f'.repeat(64),
    measuredBytes: '2147483648' as const,
    headroomBytes: '536870912' as const,
    completedAt: completedAt.toISOString(),
    validUntil: new Date(completedAt.getTime() + validFor).toISOString(),
    status: 'passed' as const,
  };
};
const capabilities = { codecs: ['h264'], formats: ['mp4'], colorPrecision: null };
const candidate = async (evidence = receipt(), ceiling: string | null = null) => {
  const secret = randomBytes(32);
  const worker = await sut.createWorker({
    name: `synthetic ${randomUUID()}`,
    destination: MediaOperationDestination.Lan,
    kinds: [MediaOperationKind.StudioExport, MediaOperationKind.Bulk],
    enrolmentSecret: secret,
    engineDigest: evidence.engineDigest,
    conformanceMaxAgeMs: 60_000,
    maxConcurrentOperations: 1,
    maxWallClockMs: null,
    maxOutputBytes: null,
    gpuMemoryBytes: ceiling,
    createdBy: null,
    gpuWorkingBudgetApproval: { evidence, capabilities },
  });
  const report: Omit<RenderWorkerAdmissionDto, 'enrolmentSecret'> = {
    workerId: worker.id,
    engineDigest: evidence.engineDigest,
    conformanceReportedAt: evidence.completedAt,
    softwareRenderer: false,
    gpuMemoryBytes: evidence.measuredBytes,
    gpuWorkingBudgetEvidence: { ...evidence, workerId: worker.id },
    codecs: capabilities.codecs,
    formats: capabilities.formats,
  };
  return { worker, report, enrolmentSecret: secret, token: randomBytes(32), ttlMs };
};
beforeAll(async () => {
  db = await getKyselyDB();
  sut = new RenderWorkerRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});

describe('measured GPU budget atomic admission', () => {
  it('preserves existing unmeasured sessions as nullable evidence', async () => {
    const input = await candidate();
    const legacy = await sut.createSession({
      workerId: input.worker.id,
      token: randomBytes(32),
      scopes: [MediaOperationKind.StudioExport],
      gpuMemoryBytes: null,
      engineDigest: input.worker.engineDigest,
      conformanceReportedAt: new Date(),
      expiresAt: new Date(Date.now() + ttlMs),
    });
    expect(legacy.gpuWorkingBudgetEvidence).toBeNull();
    await sut.recordSessionCapabilities(legacy.id, { codecs: ['h264'], formats: ['mp4'] });
    expect(await sut.getSessionCapabilities(legacy.id)).toEqual({ codecs: ['h264'], formats: ['mp4'] });
  });

  it('refuses active work on any worker associated with the same lifetime before revoking it', async () => {
    const first = await candidate();
    const admitted = await sut.admitSession(first);
    if (!admitted.admitted) throw Error('Expected admission');
    const owner = await seedCanonicalUser(db);
    const operation = await db
      .insertInto('media_operation')
      .values({
        ownerId: owner.id,
        kind: MediaOperationKind.StudioExport,
        destination: MediaOperationDestination.Lan,
        label: 'synthetic active work',
        snapshot: {},
        settings: {},
        status: MediaOperationStatus.Rendering,
        claimedBy: first.worker.id,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
    expect(operation.status).toBe(MediaOperationStatus.Rendering);
    const next = await candidate(receipt(first.report.gpuWorkingBudgetEvidence!.deviceLifetimeId));
    try {
      expect(await sut.admitSession(next)).toEqual({
        admitted: false,
        reason: RenderWorkerRefusalReason.WorkerConcurrency,
      });
    } finally {
      await db
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Completed })
        .where('id', '=', operation.id)
        .execute();
    }
    expect((await sut.getSessionByToken(first.token))?.session.revokedAt).toBeNull();
  });

  it('refuses capability mutation on measured sessions', async () => {
    const result = await sut.admitSession(await candidate());
    if (!result.admitted) throw Error('Expected admission');
    await expect(
      sut.recordSessionCapabilities(result.session.id, { codecs: ['av1'], formats: ['webm'] }),
    ).rejects.toThrow('immutable');
    expect(await sut.getSessionCapabilities(result.session.id)).toEqual({ codecs: ['h264'], formats: ['mp4'] });
  });
  it('persists policy, raw M, capped Q, exact capabilities and independent credential expiry', async () => {
    const input = await candidate(undefined, '1073741824');
    const result = await sut.admitSession(input);
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw Error('Expected admission');
    expect(result.session.gpuMemoryBytes).toBe('1073741824');
    expect(result.session.gpuWorkingBudgetEvidence).toEqual(input.report.gpuWorkingBudgetEvidence);
    expect(result.session.scopes).toEqual([MediaOperationKind.StudioExport]);
    expect(new Date(result.session.expiresAt).getTime() - Date.now()).toBeGreaterThan(ttlMs - 5000);
    expect(await sut.getSessionCapabilities(result.session.id)).toEqual({
      codecs: capabilities.codecs,
      formats: capabilities.formats,
    });
    expect((await sut.listLiveSessions()).find(({ session }) => session.id === result.session.id)?.session).toEqual(
      result.session,
    );
    expect((await sut.getWorker(input.worker.id))?.lastConformanceReportedAt).toEqual(
      new Date(input.report.conformanceReportedAt),
    );
    expect(await sut.listAudit({ workerId: input.worker.id, take: 10 })).toEqual([
      expect.objectContaining({ event: RenderWorkerAuditEvent.Admitted }),
    ]);
  });
  it.each(['0', '9223372036854775807'])('never rounds ceiling %s', async (ceiling) => {
    const input = await candidate(undefined, ceiling);
    expect(input.worker.gpuMemoryBytes).toBe(ceiling);
    expect((await sut.getWorker(input.worker.id))?.gpuMemoryBytes).toBe(ceiling);
    expect((await sut.getWorkerBySecret(input.enrolmentSecret))?.gpuMemoryBytes).toBe(ceiling);
    expect((await sut.listWorkers()).find((worker) => worker.id === input.worker.id)?.gpuMemoryBytes).toBe(ceiling);
    const result = await sut.admitSession(input);
    expect(result.admitted).toBe(true);
    if (result.admitted) expect(result.session.gpuMemoryBytes).toBe(ceiling === '0' ? '0' : '2147483648');
  });
  it.each([
    'missing-evidence',
    'missing-approval',
    'wrong-capabilities',
    'wrong-engine',
    'software',
    'revoked',
    'wrong-secret',
    'wrong-worker',
    'replayed-conformance',
  ])('refuses %s without creating a session', async (mode) => {
    const input = await candidate();
    if (mode === 'missing-evidence') input.report.gpuWorkingBudgetEvidence = null;
    if (mode === 'missing-approval') await sut.updateWorker(input.worker.id, { gpuWorkingBudgetApproval: null });
    if (mode === 'wrong-capabilities') input.report.formats = ['mov'];
    if (mode === 'wrong-engine') input.report.engineDigest = 'another-engine';
    if (mode === 'software') input.report.softwareRenderer = true;
    if (mode === 'revoked') await sut.revokeWorker(input.worker.id);
    if (mode === 'wrong-secret') input.enrolmentSecret = randomBytes(32);
    if (mode === 'wrong-worker') input.report.workerId = randomUUID();
    if (mode === 'replayed-conformance')
      await sut.markAdmitted(input.worker.id, new Date(input.report.conformanceReportedAt));
    expect((await sut.admitSession(input)).admitted).toBe(false);
    expect(
      await db.selectFrom('render_worker_session').selectAll().where('workerId', '=', input.worker.id).execute(),
    ).toEqual([]);
    if (mode !== 'replayed-conformance')
      expect((await sut.getWorker(input.worker.id))?.lastConformanceReportedAt).toBeNull();
  });
  it.each(['measurementId', 'receiptDigest'] as const)(
    'rejects replayed %s across enrollment and revoked history',
    async (key) => {
      const evidence = receipt();
      const first = await candidate(evidence);
      expect((await sut.admitSession(first)).admitted).toBe(true);
      await sut.revokeSessions(first.worker.id);
      const next = receipt();
      next[key] = evidence[key];
      const second = await candidate(next);
      expect(await sut.admitSession(second)).toEqual({
        admitted: false,
        reason: RenderWorkerRefusalReason.ConformanceReplayed,
      });
      expect((await sut.getWorker(second.worker.id))?.lastConformanceReportedAt).toBeNull();
    },
  );
  it('serializes admissions on one device lifetime and leaves one live session', async () => {
    const lifetime = randomUUID();
    const inputs = await Promise.all([candidate(receipt(lifetime)), candidate(receipt(lifetime))]);
    const results = await Promise.all(inputs.map((input) => sut.admitSession(input)));
    expect(results.every((result) => result.admitted)).toBe(true);
    const sessions = await db
      .selectFrom('render_worker_session')
      .selectAll()
      .where(
        'workerId',
        'in',
        inputs.map((input) => input.worker.id),
      )
      .execute();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.revokedAt === null)).toHaveLength(1);
  });
  it('rolls back session, prior revocation, watermark and audit on capability insert failure', async () => {
    const old = await candidate();
    const admitted = await sut.admitSession(old);
    if (!admitted.admitted) throw Error('Expected admission');
    const next = await candidate(receipt(old.report.gpuWorkingBudgetEvidence!.deviceLifetimeId));
    await sql`CREATE FUNCTION public.fl105_fail_capability() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert failure'; END $$`.execute(
      db,
    );
    await sql`CREATE TRIGGER fl105_fail_capability BEFORE INSERT ON public.render_worker_session_capability FOR EACH ROW EXECUTE FUNCTION public.fl105_fail_capability()`.execute(
      db,
    );
    try {
      await expect(sut.admitSession(next)).rejects.toThrow('synthetic insert failure');
    } finally {
      await sql`DROP TRIGGER fl105_fail_capability ON public.render_worker_session_capability; DROP FUNCTION public.fl105_fail_capability()`.execute(
        db,
      );
    }
    expect((await sut.getWorker(next.worker.id))?.lastConformanceReportedAt).toBeNull();
    expect(await sut.listAudit({ workerId: next.worker.id, take: 10 })).toEqual([]);
    expect(
      (await sut.listLiveSessions()).filter(({ worker }) => [old.worker.id, next.worker.id].includes(worker.id)),
    ).toEqual([expect.objectContaining({ session: admitted.session })]);
  });
  it('samples freshness after a worker row lock wait', async () => {
    const input = await candidate(receipt(undefined, 1800));
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lock = db.transaction().execute(async (tx) => {
      await tx.selectFrom('render_worker').select('id').where('id', '=', input.worker.id).forUpdate().execute();
      locked();
      await held;
    });
    await ready;
    const result = sut.admitSession(input);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    } finally {
      release();
      await lock;
    }
    expect((await result).admitted).toBe(false);
    expect((await sut.getWorker(input.worker.id))?.lastConformanceReportedAt).toBeNull();
  });
});
