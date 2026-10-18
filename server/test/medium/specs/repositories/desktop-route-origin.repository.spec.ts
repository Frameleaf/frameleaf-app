import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { down } from 'src/schema/migrations/2100000002996-MlRouteOrigin.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let routes: MlDestinationRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  routes = new MlDestinationRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});
const destination = () =>
  routes.create({
    kind: MlDestinationKind.Local,
    name: 'This server',
    url: `http://${randomUUID()}.lan:3003`,
    authToken: null,
    enabled: true,
    workloads: [MlWorkload.Clip, MlWorkload.Face, MlWorkload.Ocr, MlWorkload.Enrichment, MlWorkload.PetRecognition],
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
  });
const origin = async (workload: MlWorkload) =>
  (await routes.getRouteStates()).find((row) => row.workload === workload)?.origin;

it('records fresh defaults and preserves a later explicit pin despite the same destination name', async () => {
  const first = await destination();
  const second = await destination();
  expect(await routes.setDefaultRoute(MlWorkload.Clip, first.id)).toBe(true);
  expect(await origin(MlWorkload.Clip)).toBe('default');
  await routes.setRoute(MlWorkload.Clip, second.id);
  expect(await origin(MlWorkload.Clip)).toBe('pinned');
  const revision = (await routes.getRouteStates()).find((row) => row.workload === MlWorkload.Clip)!.revisionId;
  await routes.setRoute(MlWorkload.Clip, second.id);
  expect((await routes.getRouteStates()).find((row) => row.workload === MlWorkload.Clip)!.revisionId).not.toBe(
    revision,
  );
  expect(await routes.setDefaultRoute(MlWorkload.Clip, first.id)).toBe(false);
  expect((await routes.getRoute(MlWorkload.Clip))?.destinationId).toBe(second.id);
});

it('an explicit unrouted choice survives bootstrap and can later be pinned again', async () => {
  const first = await destination();
  await routes.clearRoute(MlWorkload.Face);
  expect(await routes.getRoute(MlWorkload.Face)).toBeUndefined();
  expect(await origin(MlWorkload.Face)).toBe('pinned');
  expect(await routes.setDefaultRoute(MlWorkload.Face, first.id)).toBe(false);
  await routes.setRoute(MlWorkload.Face, first.id);
  expect((await routes.getRoute(MlWorkload.Face))?.destinationId).toBe(first.id);
  expect(await origin(MlWorkload.Face)).toBe('pinned');
});

it('preserves legacy routes without guessing intent from their local kind or URL', async () => {
  const first = await destination();
  const second = await destination();
  await db
    .insertInto('ml_workload_route')
    .values({ workload: MlWorkload.Ocr, destinationId: first.id, modelId: null })
    .execute();
  expect(await origin(MlWorkload.Ocr)).toBe('legacy');
  expect(await routes.setDefaultRoute(MlWorkload.Ocr, second.id)).toBe(false);
  expect((await routes.getRoute(MlWorkload.Ocr))?.destinationId).toBe(first.id);
});

it('two API instances cannot overwrite a concurrent explicit pin or unrouted choice with defaults', async () => {
  const first = await destination();
  const second = await destination();
  const other = new MlDestinationRepository(db);
  await Promise.all([
    routes.setDefaultRoute(MlWorkload.Enrichment, first.id),
    other.setRoute(MlWorkload.Enrichment, second.id),
  ]);
  expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(second.id);
  expect(await origin(MlWorkload.Enrichment)).toBe('pinned');
  await Promise.all([routes.clearRoute(MlWorkload.Enrichment), other.setDefaultRoute(MlWorkload.Enrichment, first.id)]);
  expect(await routes.getRoute(MlWorkload.Enrichment)).toBeUndefined();
  expect(await origin(MlWorkload.Enrichment)).toBe('pinned');
});

it('stale provenance and a removed default destination require review rather than automatic reassignment', async () => {
  const first = await destination();
  const second = await destination();
  await routes.setDefaultRoute(MlWorkload.PetRecognition, first.id);
  await db
    .updateTable('ml_workload_route')
    .set({ destinationId: second.id })
    .where('workload', '=', MlWorkload.PetRecognition)
    .execute();
  expect(await origin(MlWorkload.PetRecognition)).toBe('legacy');
  expect(
    (await routes.getRouteStates()).find((row) => row.workload === MlWorkload.PetRecognition)!.revisionId,
  ).toBeNull();
  await sql`DELETE FROM ml_destination WHERE id=${second.id}::uuid`.execute(db);
  expect(await routes.setDefaultRoute(MlWorkload.PetRecognition, first.id)).toBe(false);
  expect(await origin(MlWorkload.PetRecognition)).toBe('legacy');
});

it('refuses schema downgrade when it would discard recorded route intent', async () => {
  await routes.clearRoute(MlWorkload.StudioAi);
  await expect(db.transaction().execute((tx) => down(tx))).rejects.toThrow('recorded route intent');
  expect(await origin(MlWorkload.StudioAi)).toBe('pinned');
});
