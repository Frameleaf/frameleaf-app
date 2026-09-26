import { ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as cloudJobIndexMigration from 'src/fork-schema/migrations/0000000000201-MlWorkloadAccountingCloudJobIndex.js';
import { FrameleafConsentRepository } from 'src/repositories/frameleaf-consent.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DB } from 'src/schema/index.js';
import * as cloudModelChoiceMigration from 'src/schema/migrations/2100000000650-AddMlCloudModelChoice.js';
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

  it('certifies the cloud job id index against the catalogue and rolls it back cleanly (FL-159)', async () => {
    const isIndex = (entry: { identity: string }) =>
      entry.identity === 'public.ml_workload_accounting.ml_workload_accounting_cloudJobId_idx';
    const before = await getCatalogEvidence(defaultDatabase);
    expect(before.indexes.filter((entry) => isIndex(entry))).toEqual(
      manifest.indexes.filter((entry) => isIndex(entry)),
    );
    expect(before.indexes.filter((entry) => isIndex(entry))).toHaveLength(1);

    await cloudJobIndexMigration.down(defaultDatabase);
    expect((await getCatalogEvidence(defaultDatabase)).indexes.filter((entry) => isIndex(entry))).toEqual([]);
    await cloudJobIndexMigration.up(defaultDatabase);
    expect((await getCatalogEvidence(defaultDatabase)).indexes).toEqual(before.indexes);
  });

  it('withdraws Frameleaf Cloud consent and clears the destination in one step, never during a handoff (FL-159)', async () => {
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

    await sql`
      INSERT INTO immich_fork.migration_audit (name, phase, status)
      VALUES ('official-handoff-preparation', 'active', 'running')
    `.execute(defaultDatabase);
    try {
      await expect(consents.revoke(destination.id)).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await sql`
        DELETE FROM immich_fork.migration_audit WHERE name = 'official-handoff-preparation' AND status = 'running'
      `.execute(defaultDatabase);
    }
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

  it('copies the valid cloud route models into the model choices, and matches the catalogue (FL-186)', async () => {
    const { sut } = setup();
    const cloud = await sut.create({
      kind: MlDestinationKind.FrameleafCloud,
      name: `cloud ${randomUUID()}`,
      url: null,
      authToken: null,
      enabled: true,
      workloads: [MlWorkload.Enrichment, MlWorkload.RestorationCreative, MlWorkload.Upscale, MlWorkload.StudioAi],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    await sut.recordProbe(cloud.id, {
      health: MlDestinationHealth.Healthy,
      summary: null,
      workloads: null,
      probedAt: new Date(),
      cloud: {
        region: 'eu',
        consentRequiredVersion: null,
        consentRecordedVersion: null,
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        entitled: true,
        balanceUsd: 1,
        heldUsd: 0,
        dailyCapUsd: null,
        spentTodayUsd: 0,
        limits: {},
        catalogEtag: null,
        modelIds: ['ms_DESCRIBE', 'ms_CREATIVE', 'ms_FAITHFUL', 'ms_STUDIOVO'],
        modelWorkloads: {
          ms_DESCRIBE: MlWorkload.Enrichment,
          ms_CREATIVE: MlWorkload.RestorationCreative,
          ms_FAITHFUL: MlWorkload.RestorationFaithful,
          ms_STUDIOVO: MlWorkload.StudioAi,
        },
        refusal: null,
      },
    });
    const route = (workload: MlWorkload, modelId: string) =>
      sql`
        INSERT INTO ml_workload_route ("workload", "destinationId", "modelId")
        VALUES (${workload}, ${cloud.id}::uuid, ${modelId})
        ON CONFLICT ("workload") DO UPDATE SET "destinationId" = excluded."destinationId", "modelId" = excluded."modelId"
      `.execute(defaultDatabase);
    // copied: in the last catalogue check, for this workload
    await route(MlWorkload.Enrichment, 'ms_DESCRIBE');
    // not copied: a faithful model on the creative route, a model the catalogue dropped, and Studio AI,
    // whose speech to text and speech models cannot be told apart
    await route(MlWorkload.RestorationCreative, 'ms_FAITHFUL');
    await route(MlWorkload.Upscale, 'ms_RETIRED1');
    await route(MlWorkload.StudioAi, 'ms_STUDIOVO');

    try {
      await cloudModelChoiceMigration.down(defaultDatabase);
      await cloudModelChoiceMigration.up(defaultDatabase);

      const choices = await sut.getCloudModelChoices();
      expect(choices.map(({ modelGroup, modelId }) => [modelGroup, modelId])).toEqual([
        ['descriptions', 'ms_DESCRIBE'],
      ]);

      const isChoice = (entry: { identity: string }) =>
        entry.identity === 'public.ml_cloud_model_choice' || entry.identity.startsWith('public.ml_cloud_model_choice.');
      const evidence = await getCatalogEvidence(defaultDatabase);
      expect(evidence.tables.filter((entry) => isChoice(entry))).toEqual(
        manifest.tables.filter((entry) => isChoice(entry)),
      );
      expect(evidence.columns.filter((entry) => isChoice(entry))).toEqual(
        manifest.columns.filter((entry) => isChoice(entry)),
      );
      expect(evidence.constraints.filter((entry) => isChoice(entry))).toEqual(
        manifest.constraints.filter((entry) => isChoice(entry)),
      );
      expect(evidence.indexes.filter((entry) => isChoice(entry))).toEqual(
        manifest.indexes.filter((entry) => isChoice(entry)),
      );
    } finally {
      await sql`DELETE FROM ml_workload_route WHERE "destinationId" = ${cloud.id}::uuid`.execute(defaultDatabase);
      await sql`DELETE FROM ml_cloud_model_choice`.execute(defaultDatabase);
    }
  });
});
