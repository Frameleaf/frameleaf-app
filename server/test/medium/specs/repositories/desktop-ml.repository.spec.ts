import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository, type DesktopMlTables } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerRepository, type DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { seedDesktopQualification } from 'test/desktop-qualification.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let brokerDb: Kysely<DB & DesktopMlTables & DesktopWorkerTables>;
beforeAll(async () => {
  db = await getKyselyDB();
  brokerDb = db.withTables<DesktopMlTables & DesktopWorkerTables>();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async (withQualification = true) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const { session: photoSession } = await ctx.newSession({ userId: user.id });
  const modelKey = randomUUID();
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
  const sessions = await Promise.all(
    workers.map((row) =>
      new DesktopWorkerRepository(db).issue({
        deviceId: row!.id,
        authorizationEpoch: row!.authorizationEpoch,
        photoSessionId: photoSession.id!,
        tokenHash: createHash('sha256').update(randomUUID()).digest(),
        modelKeys: [modelKey],
      }),
    ),
  );
  const grants = workers.map((row, index) => ({
    deviceId: row!.id,
    authorizationEpoch: row!.authorizationEpoch,
    sessionId: sessions[index]!.id,
    credentialHash: sessions[index]!.tokenHash,
  }));
  const request = {
    ownerId: user.id,
    modelKey,
    authorityKey: 'asset-and-route-generation-1',
    config: { clip: { textual: { modelName: 'fixture' } } },
    input: Buffer.from('fixture input'),
    inputKind: 'text' as const,
    deadlineAt: new Date(Date.now() + 120_000),
  };
  if (withQualification) await Promise.all(grants.map((grant) => seedDesktopQualification(db, grant, request)));
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
  expect(new Date(claim.attempt.expiresAt)).toEqual(request.deadlineAt);
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
  const first = (await sut.claim(grants[0], [request.modelKey]))!;
  expect((await sut.claim(grants[0], [request.modelKey]))?.attempt.id).toBe(first.attempt.id);
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

it('returns an identical result acknowledgment after NAS consumption, without retaining the private output', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(true);
  await sut.discard(task.id);
  expect(await sut.result(task.id)).toBeUndefined();
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(true);
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [9, 9] })).toBe(false);
  const receipt = await brokerDb
    .selectFrom('desktop_ml_task')
    .select(['input', 'result', 'config'])
    .where('id', '=', task.id)
    .executeTakeFirst();
  expect(receipt).toEqual({ input: null, result: null, config: {} });
});

it('requires an exact NAS-approved model and rechecks scope for every lease operation', async () => {
  const { sut, grants, request } = await setup();
  await sut.create({ ...request, modelKey: request.modelKey.slice(0, -1) });
  expect(await sut.claim(grants[0], [request.modelKey.slice(0, -1)])).toBeUndefined();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  await brokerDb
    .updateTable('desktop_worker_session')
    .set({ modelKeys: sql<string[]>`'[]'::jsonb` })
    .where('id', '=', grants[0].sessionId)
    .execute();
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, { vector: [1] })).toBe(false);
});

it('returns the exact renewed lease expiry for the outbound heartbeat response', async () => {
  const { sut, grants, request } = await setup();
  request.deadlineAt = new Date(Date.now() + 300_000);
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  const expiresAt = await sut.heartbeatLease(grants[0], claim.attempt.id);
  expect(expiresAt).toBeDefined();
  const stored = await brokerDb
    .selectFrom('desktop_ml_attempt')
    .select('expiresAt')
    .where('id', '=', claim.attempt.id)
    .executeTakeFirstOrThrow();
  expect(new Date(expiresAt!)).toEqual(new Date(stored.expiresAt));
  await new DesktopWorkerRepository(db).revoke(grants[0]);
  expect(await sut.heartbeatLease(grants[0], claim.attempt.id)).toBeUndefined();
});

it('fences stale authenticated broker operations across renewal while a fresh credential resumes its lease', async () => {
  const { sut, grants, request } = await setup();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  const session = await brokerDb
    .selectFrom('desktop_worker_session')
    .selectAll()
    .where('id', '=', grants[0].sessionId)
    .executeTakeFirstOrThrow();
  const sessions = new DesktopWorkerRepository(db);
  const nextHash = Buffer.alloc(32, 29);
  expect(await sessions.rotate(grants[0], session.tokenHash, nextHash)).toBeDefined();
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(false);
  expect(await sut.fail(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  const current = (await sessions.consume(session.id, nextHash, 1))!;
  for (const credentialHash of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(32, 99), undefined]) {
    const malformed = { ...current, credentialHash } as typeof current;
    expect(await sut.input(malformed, claim.attempt.id)).toBeUndefined();
    expect(await sut.claim(malformed, [request.modelKey])).toBeUndefined();
  }
  expect(await sut.input(current, claim.attempt.id)).toEqual(request.input);
  expect(await sut.heartbeat(current, claim.attempt.id)).toBe(true);
  expect(await sut.complete(current, claim.attempt.id, { clip: [1, 2] })).toBe(true);
});

it('preserves NAS adoption of a staged result through token renewal and still rechecks revoked model scope', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(true);
  const session = await brokerDb
    .selectFrom('desktop_worker_session')
    .selectAll()
    .where('id', '=', grants[0].sessionId)
    .executeTakeFirstOrThrow();
  expect(
    await new DesktopWorkerRepository(db).rotate(grants[0], session.tokenHash, Buffer.alloc(32, 30)),
  ).toBeDefined();
  await expect(sut.assertAdoption(task.id, task)).resolves.toBeUndefined();
  await brokerDb
    .updateTable('desktop_worker_session')
    .set({ modelKeys: sql<string[]>`'[]'::jsonb` })
    .where('id', '=', grants[0].sessionId)
    .execute();
  await expect(sut.assertAdoption(task.id, task)).rejects.toThrow('desktop_result_authority_lost');
});

it('a new photo association cannot resume or publish an old attempt when the same model is reapproved', async () => {
  const { sut, grants, request } = await setup();
  const running = await sut.create(request);
  const active = (await sut.claim(grants[0], [request.modelKey]))!;
  const staged = await sut.create(request);
  const other = (await sut.claim(grants[1], [request.modelKey]))!;
  expect(await sut.complete(grants[1], other.attempt.id, { clip: [1, 2] })).toBe(true);
  const sessions = new DesktopWorkerRepository(db);
  const replacements = [];
  for (const grant of grants) {
    const previous = await brokerDb
      .selectFrom('desktop_worker_session')
      .selectAll()
      .where('id', '=', grant.sessionId)
      .executeTakeFirstOrThrow();
    const session = (await sessions.issue({
      deviceId: grant.deviceId,
      authorizationEpoch: grant.authorizationEpoch,
      photoSessionId: previous.photoSessionId,
      tokenHash: createHash('sha256').update(randomUUID()).digest(),
      modelKeys: [request.modelKey],
    }))!;
    const current = (await sessions.consume(session.id, session.tokenHash, 1))!;
    await seedDesktopQualification(db, current, request);
    replacements.push(current);
  }
  expect(await sut.input(replacements[0], active.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(replacements[0], active.attempt.id)).toBe(false);
  expect(await sut.complete(replacements[0], active.attempt.id, { clip: [9, 9] })).toBe(false);
  expect(await sut.fail(replacements[0], active.attempt.id)).toBe(false);
  expect(await sut.claim(replacements[0], [request.modelKey])).toBeUndefined();
  await expect(sut.assertAdoption(staged.id, staged)).rejects.toThrow('desktop_result_authority_lost');
  expect((await sut.result(running.id))?.state).toBe('running');
});

it('a model key alone cannot authorize a claim without current qualified runtime evidence', async () => {
  const { sut, grants, request } = await setup(false);
  await sut.create(request);
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
});

it('qualification expiry and replacement fence input, renewal, completion and staged publication', async () => {
  const { sut, grants, request } = await setup();
  const qualificationDb =
    db.withTables<import('src/schema/tables/desktop-worker-qualification.table.js').DesktopQualificationTables>();
  await qualificationDb
    .updateTable('desktop_worker_qualification')
    .set({ expiresAt: sql`now() + interval '30 seconds'` })
    .where('sessionId', '=', grants[0].sessionId)
    .execute();
  const task = await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  const proofDb =
    db.withTables<import('src/schema/tables/desktop-worker-qualification.table.js').DesktopQualificationTables>();
  const proof = await proofDb
    .selectFrom('desktop_worker_qualification')
    .selectAll()
    .where('id', '=', claim.attempt.qualificationId!)
    .executeTakeFirstOrThrow();
  expect(new Date(claim.attempt.expiresAt)).toEqual(new Date(proof.expiresAt));
  expect(await sut.heartbeatLease(grants[0], claim.attempt.id)).toEqual(new Date(proof.expiresAt));
  await proofDb
    .updateTable('desktop_worker_qualification')
    .set({ createdAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() - interval '1 hour'` })
    .where('id', '=', proof.id)
    .execute();
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(false);
  expect(await sut.fail(grants[0], claim.attempt.id)).toBe(false);
  await seedDesktopQualification(db, grants[0], request);
  expect(await sut.input(grants[0], claim.attempt.id)).toBeUndefined();
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  const secondTask = await sut.create(request);
  const second = (await sut.claim(grants[1], [request.modelKey]))!;
  expect(second.task.id).toBe(secondTask.id);
  expect(await sut.complete(grants[1], second.attempt.id, { clip: [3, 4] })).toBe(true);
  await expect(sut.assertAdoption(secondTask.id, secondTask)).resolves.toBeUndefined();
  await seedDesktopQualification(db, grants[1], request);
  await expect(sut.assertAdoption(secondTask.id, secondTask)).rejects.toThrow('desktop_result_authority_lost');
  expect((await sut.result(task.id))?.state).toBe('running');
});

it('qualification authorizes only the exact request configuration and input kind', async () => {
  const { sut, grants, request } = await setup();
  await sut.create({ ...request, config: { clip: { textual: { modelName: 'different' } } } });
  await sut.create({ ...request, inputKind: 'image' });
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  const task = await sut.create(request);
  expect((await sut.claim(grants[0], [request.modelKey]))?.task.id).toBe(task.id);
});
