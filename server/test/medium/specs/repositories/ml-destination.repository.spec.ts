import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as cloudJobIndexMigration from 'src/fork-schema/migrations/0000000000201-MlWorkloadAccountingCloudJobIndex.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DB } from 'src/schema/index.js';
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
});
