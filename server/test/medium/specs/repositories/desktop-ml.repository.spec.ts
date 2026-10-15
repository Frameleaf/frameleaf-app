import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository, type DesktopMlTables } from 'src/repositories/desktop-ml.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let brokerDb: Kysely<DB & DesktopMlTables>;
beforeAll(async () => {
  db = await getKyselyDB();
  brokerDb = db.withTables<DesktopMlTables>();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const devices = new DesktopDeviceRepository(db);
  const workers = await Promise.all(
    [1, 2].map((n) =>
      devices.enroll({
        userId: user.id,
        installationId: randomUUID(),
        publicKey: Buffer.alloc(32, n).toString('base64'),
        name: 'Synthetic worker',
        platform: 'linux',
        architecture: 'x86_64',
        mode: 'client-worker',
        state: 'preparing',
      }),
    ),
  );
  const grants = workers.map((row) => ({ deviceId: row!.id, authorizationEpoch: row!.authorizationEpoch }));
  const modelKey = randomUUID();
  const request = {
    ownerId: user.id,
    modelKey,
    authorityKey: 'asset-and-route-generation-1',
    config: { clip: { textual: { modelName: 'fixture' } } },
    input: Buffer.from('fixture input'),
    inputKind: 'text' as const,
    deadlineAt: new Date(Date.now() + 120_000),
  };
  return { sut: new DesktopMlRepository(db), second: new DesktopMlRepository(db), devices, grants, request };
};

it('two repository instances racing claim one task once and preserve scoped input', async () => {
  const { sut, second, grants, request } = await setup();
  const task = await sut.create(request);
  const claims = await Promise.all([
    sut.claim(grants[0], [request.modelKey]),
    second.claim(grants[1], [request.modelKey]),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const index = claims.findIndex(Boolean);
  const claim = claims[index]!;
  expect(claim.task.id).toBe(task.id);
  expect(claim.task).not.toHaveProperty('input');
  expect(await sut.result(task.id)).not.toHaveProperty('input');
  expect(await sut.input(grants[index], claim.attempt.id)).toEqual(request.input);
  expect(await sut.input(grants[1 - index], claim.attempt.id)).toBeUndefined();
  expect(
    await brokerDb.selectFrom('desktop_ml_attempt').selectAll().where('taskId', '=', task.id).execute(),
  ).toHaveLength(1);
});

it('expired attempts cannot read, renew or complete after another worker takes over', async () => {
  const { sut, second, grants, request } = await setup();
  const task = await sut.create(request);
  const first = (await sut.claim(grants[0], [request.modelKey]))!;
  await brokerDb
    .updateTable('desktop_ml_attempt')
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where('id', '=', first.attempt.id)
    .execute();
  const replacement = (await second.claim(grants[1], [request.modelKey]))!;
  expect(replacement.task.generation).toBe(first.task.generation + 1);
  expect(await sut.input(grants[0], first.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], first.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], first.attempt.id, { vector: [1, 2] })).toBe(false);
  expect(await second.complete(grants[1], replacement.attempt.id, { vector: [3, 4] })).toBe(true);
  expect(await second.complete(grants[1], replacement.attempt.id, { vector: [9, 9] })).toBe(false);
  expect(await sut.result(task.id)).toMatchObject({ state: 'completed', result: { vector: [3, 4] } });
  expect(
    await brokerDb.selectFrom('desktop_ml_task').select('input').where('id', '=', task.id).executeTakeFirst(),
  ).toEqual({
    input: null,
  });
});

it('sign-out and permanent revocation invalidate leases even after a fresh sign-in', async () => {
  const { sut, devices, grants, request } = await setup();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  await devices.endSession(request.ownerId, grants[0].deviceId);
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, {})).toBe(false);
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  const paused = (await devices.list(request.ownerId)).find((row) => row.id === grants[0].deviceId)!;
  const resumed = await devices.enroll({
    userId: paused.userId,
    installationId: paused.installationId,
    publicKey: paused.publicKey,
    name: paused.name,
    platform: paused.platform,
    architecture: paused.architecture,
    mode: paused.mode,
    state: 'preparing',
  });
  expect(resumed!.authorizationEpoch).toBe(grants[0].authorizationEpoch + 1);
  expect(await sut.complete(grants[0], claim.attempt.id, {})).toBe(false);
  await devices.revoke(request.ownerId, grants[1].deviceId);
  expect(await sut.claim(grants[1], [request.modelKey])).toBeUndefined();
});

it('cancellation releases private input and rejects a late completion', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  expect(await sut.cancel(task.id)).toBe(true);
  expect(await sut.complete(grants[0], claim.attempt.id, {})).toBe(false);
  expect(await sut.result(task.id)).toMatchObject({ state: 'cancelled', result: null });
  expect(
    await brokerDb.selectFrom('desktop_ml_task').select('input').where('id', '=', task.id).executeTakeFirst(),
  ).toEqual({
    input: null,
  });
});

it('only an exact qualified model key may claim a task; a deadline bounds renewal and publication', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  expect(await sut.claim(grants[0], ['different-model-artifact'])).toBeUndefined();
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  await brokerDb
    .updateTable('desktop_ml_task')
    .set({ deadlineAt: sql`now() - interval '1 second'` })
    .where('id', '=', task.id)
    .execute();
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, {})).toBe(false);
});

it('refuses oversized and non-finite output without consuming the current lease', async () => {
  const { sut, grants, request } = await setup();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  await expect(sut.complete(grants[0], claim.attempt.id, { vector: [NaN] })).rejects.toThrow();
  await expect(sut.complete(grants[0], claim.attempt.id, { text: 'x'.repeat(4 * 1024 * 1024) })).rejects.toThrow(
    'desktop_result_too_large',
  );
  expect(await sut.complete(grants[0], claim.attempt.id, { vector: [1, 2] })).toBe(true);
});

it('records a failed lease and retries with a new generation, stopping after three failures', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  for (let n = 0; n < 3; n++) {
    const claim = (await sut.claim(grants[0], [request.modelKey]))!;
    expect(claim.task.generation).toBe(n + 1);
    expect(await sut.fail(grants[0], claim.attempt.id)).toBe(true);
    expect(await sut.complete(grants[0], claim.attempt.id, {})).toBe(false);
  }
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  expect(await sut.result(task.id)).toMatchObject({ state: 'failed', result: null });
});

it('one worker cannot drain queued tasks while it has an active lease', async () => {
  const { sut, grants, request } = await setup();
  await sut.create(request);
  await sut.create(request);
  expect(await sut.claim(grants[0], [request.modelKey])).toBeDefined();
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  expect(await sut.claim(grants[1], [request.modelKey])).toBeDefined();
});

it('rechecks device authority after result staging and rejects a changed immutable task identity', async () => {
  const { sut, devices, grants, request } = await setup();
  const task = await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  expect(await sut.complete(grants[0], claim.attempt.id, { vector: [1, 2] })).toBe(true);
  await expect(sut.assertAdoption(task.id, task)).resolves.toBeUndefined();
  await db.transaction().execute((tx) => sut.assertAdoption(task.id, task, tx));
  await brokerDb
    .updateTable('desktop_ml_task')
    .set({ authorityKey: 'changed-source' })
    .where('id', '=', task.id)
    .execute();
  await expect(sut.assertAdoption(task.id, task)).rejects.toThrow('desktop_result_authority_lost');
  await brokerDb
    .updateTable('desktop_ml_task')
    .set({ authorityKey: request.authorityKey })
    .where('id', '=', task.id)
    .execute();
  await devices.endSession(request.ownerId, grants[0].deviceId);
  await expect(sut.assertAdoption(task.id, task)).rejects.toThrow('desktop_result_authority_lost');
});

it('dispatches a bounded request through a second worker connection and deletes consumed private data', async () => {
  const { sut, second, grants, request } = await setup();
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof sut.create>>>();
  const create = sut.create.bind(sut);
  vi.spyOn(sut, 'create').mockImplementation(async (input) => {
    const task = await create(input);
    ready.resolve(task);
    return task;
  });
  const authority = vi.fn().mockResolvedValue(undefined);
  const dispatch = new DesktopMlService(sut).dispatch({
    request,
    assertAuthority: authority,
    decodeResult: (value) => value,
  });
  const task = await ready.promise;
  const claim = (await second.claim(grants[0], [request.modelKey]))!;
  expect(await second.input(grants[0], claim.attempt.id)).toEqual(request.input);
  expect(await second.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(true);
  expect(await dispatch).toEqual({ clip: [1, 2] });
  expect(authority).toHaveBeenCalledTimes(2);
  expect(await sut.result(task.id)).toBeUndefined();
  expect(await second.complete(grants[0], claim.attempt.id, { clip: [9, 9] })).toBe(false);
});

it('NAS cancellation removes task input and fences a worker already holding the attempt', async () => {
  const { sut, second, grants, request } = await setup();
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof sut.create>>>();
  const create = sut.create.bind(sut);
  vi.spyOn(sut, 'create').mockImplementation(async (input) => {
    const task = await create(input);
    ready.resolve(task);
    return task;
  });
  const controller = new AbortController();
  const dispatch = new DesktopMlService(sut).dispatch({
    request,
    assertAuthority: async () => {},
    decodeResult: (value) => value,
    signal: controller.signal,
  });
  const rejection = expect(dispatch).rejects.toThrow();
  const task = await ready.promise;
  const claim = (await second.claim(grants[0], [request.modelKey]))!;
  controller.abort();
  await rejection;
  expect(await sut.result(task.id)).toBeUndefined();
  expect(await second.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await second.complete(grants[0], claim.attempt.id, {})).toBe(false);
});
