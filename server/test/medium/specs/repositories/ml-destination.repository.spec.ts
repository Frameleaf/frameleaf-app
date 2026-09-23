import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
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
});
