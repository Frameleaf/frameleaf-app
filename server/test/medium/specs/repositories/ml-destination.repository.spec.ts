import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { FrameleafConsentRepository } from 'src/repositories/frameleaf-consent.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => ({ sut: new MlDestinationRepository(defaultDatabase) });

const jsonTypes = async (id: string) => {
  const { rows } = await sql<{
    workloads: string;
    lastProbeWorkloads: string | null;
    lastProbeHardware: string | null;
  }>`
    SELECT
      jsonb_typeof("workloads") AS "workloads",
      jsonb_typeof("lastProbeWorkloads") AS "lastProbeWorkloads",
      jsonb_typeof("lastProbeHardware") AS "lastProbeHardware"
    FROM ml_destination
    WHERE id = ${id}::uuid
  `.execute(defaultDatabase);
  return rows[0];
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(MlDestinationRepository.name, () => {
  it('writes a probe once under concurrent admissions and refuses older observations', async () => {
    const { sut } = setup();
    const created = await sut.create({
      kind: MlDestinationKind.Lan,
      name: `probe ${randomUUID()}`,
      url: `http://${randomUUID()}.lan:3003`,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Clip],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    const observation = {
      health: MlDestinationHealth.Healthy,
      summary: 'fresh',
      workloads: [MlWorkload.Clip],
      probedAt: new Date('2026-10-07T00:00:00Z'),
    };
    const tuple = async () =>
      (
        await sql<{
          version: string;
        }>`SELECT ctid::text AS version FROM ml_destination WHERE id = ${created.id}::uuid`.execute(defaultDatabase)
      ).rows[0]!.version;
    await sut.recordProbe(created.id, observation);
    const first = await tuple();
    await Promise.all(Array.from({ length: 8 }, () => sut.recordProbe(created.id, observation)));
    await sut.recordProbe(created.id, {
      ...observation,
      health: MlDestinationHealth.Unhealthy,
      probedAt: new Date(observation.probedAt.getTime() - 1),
    });
    expect(await tuple()).toBe(first);
    expect((await sut.getById(created.id))?.lastProbeHealth).toBe(MlDestinationHealth.Healthy);

    const diagnostics = {
      hardware: { preferredAcceleration: 'cuda', providers: ['CUDAExecutionProvider'], cudaDeviceCount: 1, gpus: [] },
      latencyMs: 22,
    };
    await sut.recordProbe(created.id, { ...observation, ...diagnostics });
    const enriched = await tuple();
    expect(enriched).not.toBe(first);
    expect(await sut.getById(created.id)).toMatchObject({
      lastProbeHardware: diagnostics.hardware,
      lastProbeLatencyMs: 22,
    });
    await Promise.all(Array.from({ length: 8 }, () => sut.recordProbe(created.id, { ...observation, ...diagnostics })));
    await sut.recordProbe(created.id, {
      ...observation,
      hardware: null,
      probedAt: new Date(observation.probedAt.getTime() - 1),
    });
    expect(await tuple()).toBe(enriched);

    await sut.recordProbe(created.id, {
      ...observation,
      health: MlDestinationHealth.Unhealthy,
      probedAt: new Date(observation.probedAt.getTime() + 1),
    });
    expect(await tuple()).not.toBe(enriched);
    expect((await sut.getById(created.id))?.lastProbeHealth).toBe(MlDestinationHealth.Unhealthy);
  });

  it('stores workloads and probe results as JSON arrays and objects, not as JSON text', async () => {
    const { sut } = setup();
    const created = await sut.create({
      kind: MlDestinationKind.Lan,
      name: `lan ${randomUUID()}`,
      url: `http://${randomUUID()}.lan:3003`,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Clip, MlWorkload.Face],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });

    expect(await jsonTypes(created.id)).toEqual({
      workloads: 'array',
      lastProbeWorkloads: null,
      lastProbeHardware: null,
    });
    expect(created.workloads).toEqual([MlWorkload.Clip, MlWorkload.Face]);

    const updated = await sut.update(created.id, { workloads: [MlWorkload.Ocr] });
    expect(updated.workloads).toEqual([MlWorkload.Ocr]);
    expect((await jsonTypes(created.id))?.workloads).toBe('array');

    const hardware = {
      preferredAcceleration: 'cuda',
      providers: ['CUDAExecutionProvider'],
      cudaDeviceCount: 1,
      gpus: [{ name: 'GPU', memoryTotalBytes: 1024 }],
    };
    await sut.recordProbe(created.id, {
      health: MlDestinationHealth.Healthy,
      summary: null,
      workloads: [MlWorkload.Ocr],
      probedAt: new Date(),
      hardware,
    });

    expect(await jsonTypes(created.id)).toEqual({
      workloads: 'array',
      lastProbeWorkloads: 'array',
      lastProbeHardware: 'object',
    });
    const probed = await sut.getById(created.id);
    expect(probed?.lastProbeWorkloads).toEqual([MlWorkload.Ocr]);
    expect(probed?.lastProbeHardware).toEqual(hardware);
  });

  it('applies Frameleaf Cloud settlements in one statement, matched by cloud job id (FL-159)', async () => {
    const { sut } = setup();
    const jobA = `cloud-${randomUUID()}`;
    const jobB = `cloud-${randomUUID()}`;
    const destination = await sut.create({
      kind: MlDestinationKind.Lan,
      name: `lan ${randomUUID()}`,
      url: `http://${randomUUID()}.lan:3003`,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Enrichment],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    const row = (cloudJobId: string | null) =>
      sut.recordAccounting({
        destinationId: destination.id,
        destinationKind: MlDestinationKind.Lan,
        workload: MlWorkload.Enrichment,
        jobId: null,
        jobName: null,
        bytesSent: 0,
        bytesReceived: 0,
        durationMs: 0,
        outcome: 'success',
        costUsd: null,
        cloudJobId,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    await row(jobA);
    await row(jobB);
    await row(null);

    await expect(sut.applySettlements([])).resolves.toBe(0);
    await expect(
      sut.applySettlements([
        { cloudJobId: jobA, costUsd: 0.42, credits: 42 },
        { cloudJobId: jobB, costUsd: 1.5, credits: null },
        { cloudJobId: `missing-${randomUUID()}`, costUsd: 9, credits: 9 },
      ]),
    ).resolves.toBe(2);
    // A job reported twice is applied once, with its last report.
    await expect(
      sut.applySettlements([
        { cloudJobId: jobB, costUsd: 9, credits: 9 },
        { cloudJobId: jobB, costUsd: 1.75, credits: 5 },
      ]),
    ).resolves.toBe(1);
    await expect(sut.applySettlements([{ cloudJobId: jobB, costUsd: 1.5, credits: null }])).resolves.toBe(1);
    // Already settled with the same figures: nothing is rewritten.
    await expect(sut.applySettlements([{ cloudJobId: jobA, costUsd: 0.42, credits: 42 }])).resolves.toBe(0);

    const settled = await defaultDatabase
      .selectFrom('ml_workload_accounting')
      .select(['cloudJobId', 'costUsd', 'credits'])
      .where('cloudJobId', 'in', [jobA, jobB])
      .orderBy('costUsd')
      .execute();
    expect(settled).toEqual([
      { cloudJobId: jobA, costUsd: 0.42, credits: 42 },
      { cloudJobId: jobB, costUsd: 1.5, credits: null },
    ]);
  });

  it('records a Frameleaf Cloud job once, however often its admission is replayed (FL-163)', async () => {
    const { sut } = setup();
    const cloudJobId = `cloud-${randomUUID()}`;
    const destination = await sut.create({
      kind: MlDestinationKind.Lan,
      name: `lan ${randomUUID()}`,
      url: `http://${randomUUID()}.lan:3003`,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Enrichment],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    const entry = {
      destinationId: destination.id,
      destinationKind: MlDestinationKind.Lan,
      workload: MlWorkload.Enrichment,
      jobId: null,
      jobName: null,
      bytesSent: 10,
      bytesReceived: 0,
      durationMs: 0,
      outcome: 'success' as const,
      costUsd: null,
      cloudJobId,
      startedAt: new Date(),
      finishedAt: new Date(),
    };

    const results = await Promise.all([sut.recordCloudJobAccounting(entry), sut.recordCloudJobAccounting(entry)]);
    await expect(sut.recordCloudJobAccounting(entry)).resolves.toBe(false);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await defaultDatabase
      .selectFrom('ml_workload_accounting')
      .select('id')
      .where('cloudJobId', '=', cloudJobId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('indexes the canonical cloud job identity used for replayed admission', async () => {
    const { rows } = await sql<{ indexdef: string }>`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'
      AND indexname = 'ml_workload_accounting_cloudJobId_idx'`.execute(defaultDatabase);
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain('"cloudJobId"');
  });

  it('withdraws Frameleaf Cloud consent and clears the destination atomically (FL-159)', async () => {
    const { sut } = setup();
    const consents = new FrameleafConsentRepository(defaultDatabase);
    const destination = await sut.create({
      kind: MlDestinationKind.FrameleafCloud,
      name: `cloud ${randomUUID()}`,
      url: null,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Enrichment],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const acceptedBy = user.id;
    await consents.record({
      destinationId: destination.id,
      version: '2026-10-01',
      features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      acceptedBy,
      cloudRecordedVersion: '2026-10-01',
    });
    await sut.update(destination.id, {
      consentAcknowledgedAt: new Date(),
      consentAcknowledgedBy: acceptedBy,
      consentVersion: '2026-10-01',
    });

    expect(await consents.getCurrent(destination.id)).toBeDefined();
    expect((await sut.getById(destination.id))?.consentVersion).toBe('2026-10-01');

    await consents.revoke(destination.id);
    expect(await consents.getCurrent(destination.id)).toBeUndefined();
    expect(await sut.getById(destination.id)).toMatchObject({
      consentVersion: null,
      consentAcknowledgedAt: null,
      consentAcknowledgedBy: null,
    });
  });

  it('keeps the chosen Frameleaf Cloud model per model group, apart from the routes (FL-186)', async () => {
    const { sut } = setup();
    await sut.clearCloudModelChoice('tts');
    expect(await sut.getCloudModelChoice('tts')).toBeNull();

    await sut.setCloudModelChoice('tts', 'ms_VOICE001');
    await sut.setCloudModelChoice('tts', 'ms_VOICE002');
    await sut.setCloudModelChoice('transcription', 'ms_WORDS001');
    expect(await sut.getCloudModelChoice('tts')).toBe('ms_VOICE002');
    expect(await sut.getCloudModelChoices()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelGroup: 'transcription', modelId: 'ms_WORDS001' }),
        expect.objectContaining({ modelGroup: 'tts', modelId: 'ms_VOICE002' }),
      ]),
    );

    await sut.clearCloudModelChoice('tts');
    expect(await sut.getCloudModelChoice('tts')).toBeNull();
    expect(await sut.getCloudModelChoice('transcription')).toBe('ms_WORDS001');
    await sut.clearCloudModelChoice('transcription');
  });

  it('rejects a model choice without its model group', async () => {
    await expect(
      sql`INSERT INTO ml_cloud_model_choice ("modelId") VALUES ('ms_UNSCOPED')`.execute(defaultDatabase),
    ).rejects.toThrow();
  });
});
