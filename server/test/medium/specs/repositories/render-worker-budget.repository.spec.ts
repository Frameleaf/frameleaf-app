import { Kysely, sql } from 'kysely';
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
import { seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

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
    if (!admitted.admitted) throw new Error('Expected admission');
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
    if (!result.admitted) throw new Error('Expected admission');
    await expect(
      sut.recordSessionCapabilities(result.session.id, { codecs: ['av1'], formats: ['webm'] }),
    ).rejects.toThrow('immutable');
    expect(await sut.getSessionCapabilities(result.session.id)).toEqual({ codecs: ['h264'], formats: ['mp4'] });
  });
  it('persists policy, raw M, capped Q, exact capabilities and independent credential expiry', async () => {
    const input = await candidate(undefined, '1073741824');
    const result = await sut.admitSession(input);
    expect(result.admitted).toBe(true);
    if (!result.admitted) throw new Error('Expected admission');
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
    switch (mode) {
      case 'missing-evidence': {
        input.report.gpuWorkingBudgetEvidence = null;
        break;
      }
      case 'missing-approval': {
        await sut.updateWorker(input.worker.id, { gpuWorkingBudgetApproval: null });
        break;
      }
      case 'wrong-capabilities': {
        input.report.formats = ['mov'];
        break;
      }
      case 'wrong-engine': {
        input.report.engineDigest = 'another-engine';
        break;
      }
      case 'software': {
        input.report.softwareRenderer = true;
        break;
      }
      case 'revoked': {
        await sut.revokeWorker(input.worker.id);
        break;
      }
      case 'wrong-secret': {
        input.enrolmentSecret = randomBytes(32);
        break;
      }
      case 'wrong-worker': {
        input.report.workerId = randomUUID();
        break;
      }
      case 'replayed-conformance': {
        await sut.markAdmitted(input.worker.id, new Date(input.report.conformanceReportedAt));
        // No default
        break;
      }
    }
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
    if (!admitted.admitted) throw new Error('Expected admission');
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
    const { promise: ready, resolve: locked } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
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

const prepareClaim = async (evidence = receipt(), ceiling: string | null = null, ownerId?: string) => {
  const input = await candidate(evidence, ceiling);
  const writer = { codecs: ['webcodecs-avc'], formats: ['mp4'], colorPrecision: null };
  await sut.updateWorker(input.worker.id, { gpuWorkingBudgetApproval: { evidence, capabilities: writer } });
  input.report.codecs = writer.codecs;
  const admission = await sut.admitSession(input);
  if (!admission.admitted) throw new Error('Expected synthetic admission');
  const owner = await seedCanonicalUser(db, ownerId ? { id: ownerId } : {});
  const operation = await db
    .insertInto('media_operation')
    .values({
      ownerId: owner.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Lan,
      label: 'synthetic claim',
      snapshot: { engineDigest: evidence.engineDigest },
      settings: { format: 'mp4-h264', resolution: '720p', color: 'preserve', quality: 'high', audio: 'preserve' },
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const options = {
    id: operation.id,
    workerId: input.worker.id,
    sessionId: admission.session.id,
    sessionTokenHash: input.token,
    leaseMs: 10_000,
    expected: operation,
    destinationHealth: {
      destination: MediaOperationDestination.Lan,
      state: 'available' as const,
      reason: null,
      checkedAt: new Date(),
    },
    defaultInstanceLimits: { maxConcurrentOperations: 2, maxWallClockMs: null, maxOutputBytes: null },
  };
  return { input, admission, operation, options };
};

describe('final measured claim transaction', () => {
  it('refuses health older than 30 seconds even inside a still-valid 60-second measurement', async () => {
    const evidence = receipt();
    const now = Date.now();
    evidence.completedAt = new Date(now - 50_000).toISOString();
    evidence.validUntil = new Date(now + 10_000).toISOString();
    const value = await prepareClaim(evidence);
    value.options.destinationHealth.checkedAt = new Date(now - 45_000);
    expect(await sut.claimQueued(value.options)).toEqual({ refused: RenderWorkerRefusalReason.DestinationUnavailable });
  });
  it('claims known720p without a memory hint and returns current committed identity/limits/time', async () => {
    const value = await prepareClaim();
    const result = await sut.claimQueued(value.options);
    expect(result).toEqual(
      expect.objectContaining({
        operation: expect.objectContaining({
          id: value.operation.id,
          status: MediaOperationStatus.Preparing,
          claimedBy: value.input.worker.id,
          attempt: 1,
        }),
        engineDigest: value.input.report.engineDigest,
        limits: expect.objectContaining({ maxConcurrentOperations: 1 }),
      }),
    );
    if (!result || 'refused' in result) throw new Error('Expected claim');
    expect(result.operation.claimExpiresAt).toEqual(new Date(result.claimedAt.getTime() + value.options.leaseMs));
    expect(result.operation.attemptStartedAt).toEqual(result.claimedAt);
  });

  it.each(['1080p', '1440p', '2160p', 'original', 'unknown', null])(
    'refuses current resolution %s without gpuMemoryHint',
    async (resolution) => {
      const value = await prepareClaim();
      value.options.expected.settings = { ...value.operation.settings, resolution };
      await db
        .updateTable('media_operation')
        .set({ settings: value.options.expected.settings })
        .where('id', '=', value.operation.id)
        .execute();
      expect(await sut.claimQueued(value.options)).toEqual({
        refused: RenderWorkerRefusalReason.GpuMemoryInsufficient,
      });
    },
  );

  it.each([
    'legacy',
    'policy',
    'worker-revoked',
    'session-revoked',
    'credential',
    'engine',
    'scope',
    'caps',
    'ceiling',
    'token',
    'health',
    'old-health',
  ])('refuses changed %s after initial authorization', async (mode) => {
    const value = await prepareClaim();
    switch (mode) {
      case 'legacy': {
        await db
          .updateTable('render_worker_session')
          .set({ gpuWorkingBudgetEvidence: null })
          .where('id', '=', value.admission.session.id)
          .execute();
        break;
      }
      case 'policy': {
        await sut.updateWorker(value.input.worker.id, { gpuWorkingBudgetApproval: null });
        break;
      }
      case 'worker-revoked': {
        await sut.revokeWorker(value.input.worker.id);
        break;
      }
      case 'session-revoked': {
        await sut.revokeSessions(value.input.worker.id);
        break;
      }
      case 'credential': {
        await db
          .updateTable('render_worker_session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', value.admission.session.id)
          .execute();
        break;
      }
      case 'engine': {
        await sut.updateWorker(value.input.worker.id, { engineDigest: 'changed' });
        break;
      }
      case 'scope': {
        await sut.updateWorker(value.input.worker.id, { kinds: [MediaOperationKind.StudioPreview] });
        break;
      }
      case 'caps': {
        await sql`UPDATE public.render_worker_session_capability SET codecs=ARRAY['av1'] WHERE "sessionId"=${value.admission.session.id}::uuid`.execute(
          db,
        );
        break;
      }
      case 'ceiling': {
        await sut.updateWorker(value.input.worker.id, { gpuMemoryBytes: '1073741824' });
        break;
      }
      case 'token': {
        value.options.sessionTokenHash = randomBytes(32);
        break;
      }
      case 'health': {
        value.options.destinationHealth.state = 'unknown' as never;
        break;
      }
      case 'old-health': {
        value.options.destinationHealth.checkedAt = new Date(0);
        // No default
        break;
      }
    }
    const result = await sut.claimQueued(value.options);
    expect(result).toMatchObject({ refused: expect.any(String) });
    expect(
      (
        await db
          .selectFrom('media_operation')
          .select('status')
          .where('id', '=', value.operation.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe(MediaOperationStatus.Queued);
  });

  it('never widens persistedQ when A is raised and a low hint cannot loosen the floor', async () => {
    const value = await prepareClaim(undefined, '1073741824');
    await sut.updateWorker(value.input.worker.id, { gpuMemoryBytes: '9223372036854775807' });
    value.options.expected.snapshot = { ...value.operation.snapshot, gpuMemoryHintBytes: 1 };
    await db
      .updateTable('media_operation')
      .set({ snapshot: value.options.expected.snapshot })
      .where('id', '=', value.operation.id)
      .execute();
    expect(await sut.claimQueued(value.options)).toEqual({ refused: RenderWorkerRefusalReason.GpuMemoryInsufficient });
  });

  it('refuses an immutable operation binding changed while the manifest was resolved', async () => {
    const value = await prepareClaim();
    await db
      .updateTable('media_operation')
      .set({ settings: { ...value.operation.settings, color: 'hdr10' } })
      .where('id', '=', value.operation.id)
      .execute();
    expect(await sut.claimQueued(value.options)).toEqual({ refused: RenderWorkerRefusalReason.ManifestIncomplete });
  });

  it.each(['cancel', 'retry', 'attempts'])(
    'does not claim an operation changed to %s during resolution',
    async (mode) => {
      const value = await prepareClaim();
      const patch =
        mode === 'cancel'
          ? { cancelRequestedAt: new Date() }
          : mode === 'retry'
            ? { retryAt: new Date(Date.now() + 60_000) }
            : { attempt: 3, maxAttempts: 3 };
      await db.updateTable('media_operation').set(patch).where('id', '=', value.operation.id).execute();
      expect(await sut.claimQueued(value.options)).toBeUndefined();
    },
  );

  it.each(['instance', 'owner'])('serializes an inserted %s ceiling even before its row exists', async (target) => {
    const owner = await seedCanonicalUser(db);
    const subject = target === 'instance' ? 'instance' : owner.id;
    await db.deleteFrom('render_worker_limit').where('subject', '=', subject).execute();
    const key = target === 'instance' ? 'render-worker-limit:instance' : 'render-worker-owner:' + subject;
    let settled = false;
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: locked, resolve: ready } = Promise.withResolvers<void>();
    const lock = db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key},0))`.execute(tx);
      ready();
      await held;
    });
    await locked;
    const pending = sut
      .upsertLimit(subject, target === 'instance' ? null : owner.id, {
        maxConcurrentOperations: 1,
        maxWallClockMs: null,
        maxOutputBytes: null,
      })
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
    } finally {
      release();
      await lock;
    }
    expect((await pending).maxConcurrentOperations).toBe(1);
  });

  it('reads the tightest current worker, instance and account ceilings inside the final transaction', async () => {
    const value = await prepareClaim();
    await sut.updateWorker(value.input.worker.id, { maxOutputBytes: '1000' });
    await sut.upsertLimit('instance', null, {
      maxConcurrentOperations: 5,
      maxWallClockMs: '600000',
      maxOutputBytes: null,
    });
    await sut.upsertLimit(value.operation.ownerId, value.operation.ownerId, {
      maxConcurrentOperations: 1,
      maxWallClockMs: '300000',
      maxOutputBytes: '5000',
    });
    const result = await sut.claimQueued(value.options);
    if (!result || 'refused' in result) throw new Error('Expected claim');
    expect(result.limits).toEqual({ maxConcurrentOperations: 1, maxWallClockMs: 300_000, maxOutputBytes: 1000 });
  });

  it('serializes the owner ceiling across separate workers and lifetimes', async () => {
    const first = await prepareClaim();
    const second = await prepareClaim(undefined, null, first.operation.ownerId);
    await sut.upsertLimit(first.operation.ownerId, first.operation.ownerId, {
      maxConcurrentOperations: 1,
      maxWallClockMs: null,
      maxOutputBytes: null,
    });
    const results = await Promise.all([sut.claimQueued(first.options), sut.claimQueued(second.options)]);
    expect(results.filter((result) => result && !('refused' in result))).toHaveLength(1);
    expect(results.filter((result) => result && 'refused' in result)).toEqual([
      { refused: RenderWorkerRefusalReason.UserConcurrency },
    ]);
  });

  it('permits only one concurrent active claim for a lifetime', async () => {
    const value = await prepareClaim();
    const other = await db
      .insertInto('media_operation')
      .values({
        ownerId: value.operation.ownerId,
        kind: MediaOperationKind.StudioExport,
        destination: MediaOperationDestination.Lan,
        label: 'second',
        snapshot: value.operation.snapshot,
        settings: value.operation.settings,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const results = await Promise.all([
      sut.claimQueued(value.options),
      sut.claimQueued({ ...value.options, id: other.id, expected: other }),
    ]);
    expect(results.filter((result) => result && !('refused' in result))).toHaveLength(1);
    expect(results.filter((result) => result && 'refused' in result)).toEqual([
      { refused: RenderWorkerRefusalReason.WorkerConcurrency },
    ]);
  });

  it.each(['worker', 'session', 'operation'])(
    'refuses measurement expiry after an unchanged %s lock wait',
    async (table) => {
      const value = await prepareClaim(receipt(undefined, 2500));
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const { promise: locked, resolve: ready } = Promise.withResolvers<void>();
      const lock = db.transaction().execute(async (tx) => {
        switch (table) {
          case 'worker': {
            await tx
              .selectFrom('render_worker')
              .select('id')
              .where('id', '=', value.input.worker.id)
              .forUpdate()
              .execute();
            break;
          }
          case 'session': {
            await tx
              .selectFrom('render_worker_session')
              .select('id')
              .where('id', '=', value.admission.session.id)
              .forUpdate()
              .execute();
            break;
          }
          case 'operation': {
            await tx
              .selectFrom('media_operation')
              .select('id')
              .where('id', '=', value.operation.id)
              .forUpdate()
              .execute();
            // No default
            break;
          }
        }
        ready();
        await held;
      });
      await locked;
      const pending = sut.claimQueued(value.options);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1700));
      } finally {
        release();
        await lock;
      }
      expect(await pending).toMatchObject({
        refused: RenderWorkerRefusalReason.GpuMemoryInsufficient,
        budgetReason: 'expired',
      });
    },
  );

  it('refuses credential expiry after an unchanged operation lock wait', async () => {
    const value = await prepareClaim();
    await db
      .updateTable('render_worker_session')
      .set({ expiresAt: new Date(Date.now() + 300) })
      .where('id', '=', value.admission.session.id)
      .execute();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    const { promise: locked, resolve: ready } = Promise.withResolvers<void>();
    const lock = db.transaction().execute(async (tx) => {
      await tx.selectFrom('media_operation').select('id').where('id', '=', value.operation.id).forUpdate().execute();
      ready();
      await held;
    });
    await locked;
    const pending = sut.claimQueued(value.options);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      release();
      await lock;
    }
    expect(await pending).toEqual({
      refused: RenderWorkerRefusalReason.GpuMemoryInsufficient,
      budgetReason: 'session-unqualified',
    });
  });
});
