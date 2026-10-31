import { Kysely, type Updateable, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';
import { defaults } from 'src/config.js';
import { AssetType, AssetVisibility, JobName, MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository, type DesktopMlTables } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerRepository, type DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import {
  down as removeDisclosure,
  up as addDisclosure,
} from 'src/schema/migrations/2100000003001-DesktopMlDisclosure.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { desktopImageModelKeys } from 'src/utils/desktop-model-catalogue.js';
import { lockEffectiveConfig } from 'src/utils/effective-config-lock.js';
import { seedDesktopQualification } from 'test/desktop-qualification.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
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
const setup = async (withQualification = true, profile?: DesktopModelProfile, member = false) => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: !member });
  const policies = new DesktopAssistancePolicyService(new SystemMetadataRepository(db));
  if (member) {
    const { user: administrator } = await ctx.newUser({ isAdmin: true });
    const { session } = await ctx.newSession({ userId: administrator.id });
    await policies.setMemberApproval({ user: administrator, session } as never, user.id, true);
  } else await policies.enable(user.id);
  const { session: photoSession } = await ctx.newSession({ userId: user.id });
  const modelKey = profile?.modelKey ?? randomUUID();
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
    config: profile?.spec.entries ?? { clip: { textual: { modelName: 'fixture' } } },
    input: profile ? Buffer.from(profile.fixtureBase64, 'base64') : Buffer.from('fixture input'),
    inputKind: profile?.spec.fixtureKind ?? ('text' as const),
    deadlineAt: new Date(Date.now() + 120_000),
  };
  await Promise.all(
    grants.map((grant) => new DesktopWorkerRepository(db).consume(grant.sessionId, grant.credentialHash, 1)),
  );
  if (withQualification) await Promise.all(grants.map((grant) => seedDesktopQualification(db, grant, request)));
  return { sut: new DesktopMlRepository(db), second: new DesktopMlRepository(db), devices, grants, request };
};

it('lets an approved member claim its own work and never another account with the same model', async () => {
  const own = await setup(true, undefined, true);
  const other = await setup();
  await own.sut.create({ ...other.request, modelKey: own.request.modelKey });
  expect(await own.sut.claim(own.grants[0], [own.request.modelKey])).toBeUndefined();
  const task = await own.sut.create(own.request);
  const claimed = await own.sut.claim(own.grants[0], [own.request.modelKey]);
  expect(claimed?.task.id).toBe(task.id);
  expect(await own.sut.hasLiveAttempt(task.id)).toBe(true);
});

it('knows when an online, qualified helper of the owner is ready for a model (FL-456)', async () => {
  const own = await setup();
  const other = await setup();
  expect(await own.sut.hasReadyWorker(own.request.ownerId, own.request.modelKey)).toBe(true);
  // another account's helpers, or another model, never count
  expect(await own.sut.hasReadyWorker(other.request.ownerId, own.request.modelKey)).toBe(false);
  expect(await own.sut.hasReadyWorker(own.request.ownerId, randomUUID())).toBe(false);
  const counts = await new MlDestinationRepository(db).getDesktopCounts();
  expect(counts.ready).toBeGreaterThanOrEqual(4);

  // not seen for a while: not ready
  await sql`UPDATE desktop_worker_session SET "lastSeenAt" = clock_timestamp() - interval '5 minutes'
    WHERE "deviceId" IN (${sql.join(own.grants.map((grant) => grant.deviceId))})`.execute(db);
  expect(await own.sut.hasReadyWorker(own.request.ownerId, own.request.modelKey)).toBe(false);

  const unqualified = await setup(false);
  expect(await unqualified.sut.hasReadyWorker(unqualified.request.ownerId, unqualified.request.modelKey)).toBe(false);
});

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
  expect(await sut.input(grants[index], claim.attempt.id, () => Promise.resolve())).toEqual(request.input);
  expect(await sut.input(grants[1 - index], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], first.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  const dispatch = new DesktopMlService(sut, new DesktopClipIndexRepository(db)).dispatch({
    request,
    assertAuthority: authority,
    decodeResult: (value) => value,
  });
  const task = await ready.promise;
  const claim = (await second.claim(grants[0], [request.modelKey]))!;
  expect(await second.input(grants[0], claim.attempt.id, () => Promise.resolve())).toEqual(request.input);
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
  const dispatch = new DesktopMlService(sut, new DesktopClipIndexRepository(db)).dispatch({
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
  expect(await second.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(false);
  expect(await sut.fail(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.claim(grants[0], [request.modelKey])).toBeUndefined();
  const current = (await sessions.consume(session.id, nextHash, 1))!;
  for (const credentialHash of [Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(32, 99), undefined]) {
    const malformed = { ...current, credentialHash } as typeof current;
    expect(await sut.input(malformed, claim.attempt.id, () => Promise.resolve())).toBeUndefined();
    expect(await sut.claim(malformed, [request.modelKey])).toBeUndefined();
  }
  expect(await sut.input(current, claim.attempt.id, () => Promise.resolve())).toEqual(request.input);
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
  expect(await sut.input(replacements[0], active.attempt.id, () => Promise.resolve())).toBeUndefined();
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
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
  expect(await sut.heartbeat(grants[0], claim.attempt.id)).toBe(false);
  expect(await sut.complete(grants[0], claim.attempt.id, { clip: [1, 2] })).toBe(false);
  expect(await sut.fail(grants[0], claim.attempt.id)).toBe(false);
  await seedDesktopQualification(db, grants[0], request);
  expect(await sut.input(grants[0], claim.attempt.id, () => Promise.resolve())).toBeUndefined();
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

it('publishes a synthetic pool result only with the real index and broker transaction fences', async () => {
  const profiles: DesktopModelProfile[] = JSON.parse(
    readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'),
  ).profiles;
  const profile = profiles.find((p) => p.spec.fixtureKind === 'image')!;
  const space = JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-spaces.json'), 'utf8')).spaces[0];
  for (const table of ['smart_search', 'smart_search_description', 'video_moment_frame_embedding'])
    await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN embedding TYPE vector(768)`.execute(db);
  const index = new DesktopClipIndexRepository(db);
  const binding = await index.admit(space.spaceKey);
  const { sut, second, grants, request } = await setup(true, profile);
  const asset = mediumFactory.assetInsert({ ownerId: request.ownerId, type: AssetType.Image });
  await new AssetRepository(db).create(asset);
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-pool-database-'));
  const path = join(root, 'fixture.png');
  const ready = Promise.withResolvers<Awaited<ReturnType<typeof sut.create>>>();
  const create = sut.create.bind(sut);
  vi.spyOn(sut, 'create').mockImplementation(async (input) => {
    const row = await create(input);
    ready.resolve(row);
    return row;
  });
  const context: QueueExecution = {
    claim: {
      id: randomUUID(),
      token: randomUUID(),
      queue: 'smart-search',
      name: JobName.SmartSearch,
      data: { id: asset.id },
      workerId: 'synthetic-NAS',
      attempt: 1,
      runId: null,
      itemKey: null,
      deadlineMs: 120_000,
      startedAt: new Date(),
    },
    signal: new AbortController().signal,
    progress: vi.fn(),
    progressUnits: 0,
    adoptions: [],
    followups: [],
    buffering: false,
  };
  const ml = new MachineLearningRepository(LoggingRepository.create(), undefined, undefined, undefined, index);
  ml.setup(defaults.machineLearning);
  const pool = new DesktopMlService(sut, index);
  const search = new SearchRepository(db);
  const authority = vi.fn().mockResolvedValue(undefined);
  try {
    await writeFile(path, request.input);
    const prepared = queueExecution.run(context, async () => {
      const selected = pool.selectClipPool(
        {
          destinationId: 'synthetic-NAS-route',
          kind: MlDestinationKind.Local,
          workload: MlWorkload.Clip,
          endpoint: { url: 'https://unused.invalid', assertAuthority: authority },
          record: vi.fn(),
        },
        {
          ownerId: request.ownerId,
          authorityKey: 'synthetic-explicit-pool-policy',
          binding,
          assertAuthority: authority,
        },
      );
      const result = await ml.encodeImage(selected, path, {
        ...defaults.machineLearning.clip,
        modelName: profile.modelName,
      });
      await search.upsert(asset.id!, result);
    });
    const task = await ready.promise;
    const claim = (await second.claim(grants[0], [profile.modelKey]))!;
    expect(await second.input(grants[0], claim.attempt.id, () => Promise.resolve())).toEqual(request.input);
    expect(await second.complete(grants[0], claim.attempt.id, profile.spec.expectedOutput)).toBe(true);
    await prepared;
    expect(await search.getEmbedding(asset.id!)).toBeUndefined();
    expect(context.adoptions).toHaveLength(2);
    await db.transaction().execute((tx) =>
      queueExecution.run(context, () =>
        publicationTransaction.run(tx, async () => {
          for (const adopt of context.adoptions) await adopt(tx);
        }),
      ),
    );
    for (const after of context.afterCommit ?? []) await after();
    const persisted = await search.getEmbedding(asset.id!);
    expect(persisted?.producerModelKey).toBe(profile.modelKey);
    expect(JSON.parse(persisted!.embedding).map((v: number) => Math.fround(v))).toEqual(
      JSON.parse(String(profile.spec.expectedOutput.clip)).map((v: number) => Math.fround(v)),
    );
    expect(await sut.result(task.id)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['unclaimed', 'stale-worker'] as const)(
  'durably waits for %s, restarts, and completes the same pinned job without retry-credit loss',
  async (mode) => {
    const { sut: broker, second: helper, grants, request } = await setup();
    const queue = `desktop-wait-${randomUUID()}`;
    let worker = randomUUID();
    let store = new SqlQueueStore(db);
    await store.initialize([queue], worker);
    const pinned = randomUUID();
    const runId = await store.createRun('desktop-helper-wait', {});
    await store.enqueue([
      {
        queue,
        name: JobName.SmartSearch,
        data: { id: randomUUID(), _queueDestinations: { clip: pinned } },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 120_000,
        runId,
        itemKey: request.ownerId,
        rootItemKey: request.ownerId,
      },
    ]);
    await store.finishEnumeration(runId);
    const executor = (repository: DesktopMlRepository) => {
      const service = new DesktopMlService(repository, new DesktopClipIndexRepository(db));
      const jobs = new JobRepository(
        {} as never,
        {} as never,
        {
          emit: async () => {
            expect(await jobs.pinDestination(MlWorkload.Clip, randomUUID())).toBe(pinned);
            await service.dispatch({
              request: { ...request, deadlineAt: new Date(Date.now() + 120_000) },
              assertAuthority: async () => {},
              decodeResult: (value) => value,
            });
          },
        } as never,
        LoggingRepository.create(),
        db,
      );
      return jobs;
    };
    const firstReady = Promise.withResolvers<Awaited<ReturnType<typeof broker.create>>>();
    const createFirst = broker.create.bind(broker);
    vi.spyOn(broker, 'create').mockImplementation(async (input) => {
      const task = await createFirst(input);
      firstReady.resolve(task);
      return task;
    });
    const [first] = await store.claim(queue, worker);
    const firstExecution = executor(broker)['execute'](first, new AbortController());
    if (mode === 'stale-worker') {
      const task = await firstReady.promise;
      const held = (await helper.claim(grants[0], [request.modelKey]))!;
      expect(held.task.id).toBe(task.id);
      await sql`update desktop_worker_session set "lastSeenAt"=clock_timestamp()-interval '91 seconds'
      where id=${grants[0].sessionId}::uuid`.execute(db);
      await firstExecution;
      expect(await helper.input(grants[0], held.attempt.id, () => Promise.resolve())).toBeUndefined();
      expect(await helper.complete(grants[0], held.attempt.id, { clip: [9, 9] })).toBe(false);
    } else await firstExecution;
    const blocked = await db
      .selectFrom('job')
      .select(['state', 'dependencyReason', 'retryBaseAttempt', 'data'])
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow();
    expect(blocked).toMatchObject({
      state: 'pending',
      dependencyReason: 'destination-unavailable',
      retryBaseAttempt: 1,
    });
    expect(blocked.data).toMatchObject({ _queueDestinations: { clip: pinned } });
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      state: 'blocked',
      blocked: 1,
      failed: 0,
      completed: 0,
    });
    expect(
      await brokerDb.selectFrom('desktop_ml_task').selectAll().where('ownerId', '=', request.ownerId).execute(),
    ).toEqual([]);

    // New queue and broker facades use only persisted state, as after a NAS process restart.
    worker = randomUUID();
    store = new SqlQueueStore(db);
    await store.initialize([queue], worker);
    await sql`update job set "availableAt" = now() where id = ${first.id}::uuid`.execute(db);
    expect(
      await new DesktopWorkerRepository(db).consume(grants[0].sessionId, grants[0].credentialHash, 2),
    ).toBeDefined();
    const [resumed] = await store.claim(queue, worker);
    expect(resumed.id).toBe(first.id);
    const reloaded = new DesktopMlRepository(db);
    const ready = Promise.withResolvers<Awaited<ReturnType<typeof reloaded.create>>>();
    const create = reloaded.create.bind(reloaded);
    vi.spyOn(reloaded, 'create').mockImplementation(async (input) => {
      const task = await create(input);
      ready.resolve(task);
      return task;
    });
    const executing = executor(reloaded)['execute'](resumed, new AbortController());
    const task = await ready.promise;
    const assigned = (await helper.claim(grants[0], [request.modelKey]))!;
    expect(assigned.task.id).toBe(task.id);
    expect(await helper.complete(grants[0], assigned.attempt.id, { clip: [1, 2] })).toBe(true);
    await executing;
    expect((await store.listRuns(100, 0)).find((run) => run.id === runId)).toMatchObject({
      state: 'completed',
      failed: 0,
      completed: 1,
    });
    expect(
      await db
        .selectFrom('job')
        .select(['state', 'attempt', 'retryBaseAttempt'])
        .where('id', '=', first.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ state: 'completed', attempt: 2, retryBaseAttempt: 1 });
    expect(await reloaded.result(task.id)).toBeUndefined();
  },
  20_000,
);

it.each([
  'unknown',
  'stale',
  'revoked-worker',
  'revoked-device',
  'removed-admin',
  'expired-photo',
  'expired-qualification',
  'changed-config',
  'removed-model',
  'expired-attempt',
] as const)('does not treat %s as a live admitted attempt', async (reason) => {
  const { sut, grants, request, devices } = await setup();
  const task = await sut.create(request);
  const grant = grants[0];
  const claimed = (await sut.claim(grant, [request.modelKey]))!;
  try {
    expect(await sut.hasLiveAttempt(task.id)).toBe(true);
    switch (reason) {
      case 'unknown': {
        await workerDbUpdate({ lastSeenAt: null });
        break;
      }
      case 'stale': {
        await workerDbUpdate({ lastSeenAt: new Date(Date.now() - 91_000) });
        break;
      }
      case 'revoked-worker': {
        await workerDbUpdate({ revokedAt: new Date() });
        break;
      }
      case 'revoked-device': {
        await devices.revoke(request.ownerId, grant.deviceId);
        break;
      }
      case 'removed-admin': {
        await db.updateTable('user').set({ isAdmin: false }).where('id', '=', request.ownerId).execute();
        break;
      }
      case 'expired-photo': {
        await sql`update session set "expiresAt"=clock_timestamp()-interval '1 second' where id=(
            select "photoSessionId" from desktop_worker_session where id=${grant.sessionId}::uuid)`.execute(db);
        break;
      }
      case 'expired-qualification': {
        await sql`update desktop_worker_qualification set "expiresAt"=clock_timestamp()-interval '1 second',
            "createdAt"=clock_timestamp()-interval '1 hour' where "sessionId"=${grant.sessionId}::uuid`.execute(db);
        break;
      }
      case 'changed-config': {
        await sql`update desktop_worker_qualification set "configSha256"=${'f'.repeat(64)}
            where "sessionId"=${grant.sessionId}::uuid`.execute(db);
        break;
      }
      case 'removed-model': {
        await workerDbUpdate({ modelKeys: [] });
        break;
      }
      case 'expired-attempt': {
        await brokerDb
          .updateTable('desktop_ml_attempt')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', claimed.attempt.id)
          .execute();
        break;
      }
    }
    expect(await sut.hasLiveAttempt(task.id)).toBe(false);
  } finally {
    await sut.cancel(task.id);
    await sut.discard(task.id);
  }
  async function workerDbUpdate(value: Updateable<DesktopWorkerTables['desktop_worker_session']>) {
    await brokerDb.updateTable('desktop_worker_session').set(value).where('id', '=', grant.sessionId).execute();
  }
});
it('ordinary credential rotation preserves current authenticated presence and the accepted attempt', async () => {
  const { sut, grants, request } = await setup();
  const task = await sut.create(request);
  await sut.claim(grants[0], [request.modelKey]);
  try {
    const rotated = await new DesktopWorkerRepository(db).rotate(
      grants[0],
      grants[0].credentialHash,
      Buffer.alloc(32, 76),
    );
    expect(rotated).toBeDefined();
    expect(await sut.hasLiveAttempt(task.id)).toBe(true);
  } finally {
    await sut.cancel(task.id);
    await sut.discard(task.id);
  }
});

it('never claims another account task even when its qualified model and configuration match', async () => {
  const a = await setup();
  const b = await setup();
  const key = a.request.modelKey;
  await brokerDb
    .updateTable('desktop_worker_session')
    .set({ modelKeys: [key] })
    .where('id', '=', b.grants[0].sessionId)
    .execute();
  await seedDesktopQualification(db, b.grants[0], a.request);
  const foreign = await a.sut.create({ ...a.request, ownerId: b.request.ownerId, input: Buffer.from('synthetic B') });
  const own = await a.sut.create({ ...a.request, input: Buffer.from('synthetic A') });
  try {
    const assignedA = (await a.sut.claim(a.grants[0], [key]))!;
    expect(assignedA.task.id).toBe(own.id);
    expect(await a.sut.input(a.grants[0], assignedA.attempt.id, () => Promise.resolve())).toEqual(
      Buffer.from('synthetic A'),
    );
    const assignedB = (await b.sut.claim(b.grants[0], [key]))!;
    expect(assignedB.task.id).toBe(foreign.id);
    expect(await b.sut.input(b.grants[0], assignedB.attempt.id, () => Promise.resolve())).toEqual(
      Buffer.from('synthetic B'),
    );
  } finally {
    for (const task of [own, foreign]) {
      await a.sut.cancel(task.id);
      await a.sut.discard(task.id);
    }
  }
});
it.each(['running', 'completed'] as const)(
  'fences an existing %s cross-account attempt at every data boundary',
  async (state) => {
    const a = await setup();
    const b = await setup();
    const task = await a.sut.create(a.request);
    const lease = (await a.sut.claim(a.grants[0], [a.request.modelKey]))!;
    try {
      if (state === 'completed')
        expect(await a.sut.complete(a.grants[0], lease.attempt.id, { clip: [1, 2] })).toBe(true);
      await brokerDb
        .updateTable('desktop_ml_task')
        .set({ ownerId: b.request.ownerId })
        .where('id', '=', task.id)
        .execute();
      expect(await a.sut.input(a.grants[0], lease.attempt.id, () => Promise.resolve())).toBeUndefined();
      expect(await a.sut.heartbeat(a.grants[0], lease.attempt.id)).toBe(false);
      expect(await a.sut.complete(a.grants[0], lease.attempt.id, { clip: [1, 2] })).toBe(false);
      if (state === 'running') expect(await a.sut.claim(a.grants[0], [a.request.modelKey])).toBeUndefined();
      else
        await expect(a.sut.assertAdoption(task.id, { ...task, ownerId: b.request.ownerId })).rejects.toThrow(
          'desktop_result_authority_lost',
        );
    } finally {
      await a.sut.cancel(task.id);
      await a.sut.discard(task.id);
    }
  },
);

it('revalidates disclosure authority inside the authenticated lease before returning input', async () => {
  const { sut, grants, request } = await setup();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  const authorize = vi.fn().mockRejectedValue(new Error('desktop_pool_policy_changed'));
  await expect(sut.input(grants[0], claim.attempt.id, authorize)).rejects.toThrow('desktop_pool_policy_changed');
  expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ ownerId: request.ownerId }), expect.anything());
});

it.each([
  { workload: MlWorkload.Clip, legacy: false },
  { workload: MlWorkload.Ocr, legacy: false },
  { workload: MlWorkload.Face, legacy: false },
  { workload: MlWorkload.Ocr, legacy: true },
  { workload: MlWorkload.Face, legacy: true },
])(
  'reconstructs durable $workload disclosure (legacy=$legacy) and refuses revoked source, policy, route, config and job authority',
  async ({ workload, legacy }) => {
    const profiles: DesktopModelProfile[] = JSON.parse(
      readFileSync('resources/desktop/model-catalogue.json', 'utf8'),
    ).profiles;
    const profile = profiles.find(
      (p) =>
        p.workload === workload &&
        p.spec.fixtureKind === 'image' &&
        (workload === MlWorkload.Clip || legacy || p.modelKey === desktopImageModelKeys[workload]),
    )!;
    const space = JSON.parse(readFileSync('resources/desktop/model-spaces.json', 'utf8')).spaces[0];
    for (const table of ['smart_search', 'smart_search_description', 'video_moment_frame_embedding'])
      await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN embedding TYPE vector(768)`.execute(db);
    const index = new DesktopClipIndexRepository(db);
    const priorIndex = await index.getActive();
    const binding = workload === MlWorkload.Clip ? await index.admit(space.spaceKey) : undefined;
    const { sut: broker, grants, request } = await setup(true, profile);
    const { sut: base, ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { asset } = await ctx.newAsset({ ownerId: request.ownerId });
    const metadata = new SystemMetadataRepository(db);
    const configRepo = new ConfigRepository();
    const originalConfig = await base.readConfigForUpdate({
      configRepo,
      metadataRepo: metadata,
      logger: LoggingRepository.create(),
    });
    const config = structuredClone(defaults);
    if (workload === MlWorkload.Clip) config.machineLearning.clip.modelName = profile.modelName;
    config.machineLearning.urls = ['https://disclosure-fixture.invalid'];
    const writeConfig = (enabled: boolean) =>
      metadata.withConfigTransaction((metadataRepo) =>
        base.updateConfig(
          { ...config, machineLearning: { ...config.machineLearning, enabled } },
          { configRepo, metadataRepo, logger: LoggingRepository.create() },
        ),
      );
    const policies = new DesktopAssistancePolicyService(metadata);
    await policies.enable(request.ownerId);
    const savedPolicy = await policies.snapshot();
    const routes = new MlDestinationRepository(db);
    const destination = await routes.create({
      kind: MlDestinationKind.Local,
      name: 'synthetic disclosure NAS',
      url: config.machineLearning.urls[0],
      authToken: null,
      enabled: true,
      workloads: [workload],
      budgetLimitUsd: null,
      maxRuntimeMinutes: null,
      maxUploadBytes: null,
    });
    // Each case owns a fresh route, including the preceding case's pinned removal.
    await db.deleteFrom('ml_workload_route').where('workload', '=', workload).execute();
    await db.deleteFrom('ml_workload_route_origin').where('workload', '=', workload).execute();
    expect(await routes.setDefaultRoute(workload, destination.id)).toBe(true);
    const store = new SqlQueueStore(db);
    const workerId = randomUUID();
    const queue = 'disclosure-' + randomUUID();
    await store.initialize([queue], workerId);
    await store.enqueue([
      {
        queue,
        name:
          workload === MlWorkload.Clip
            ? JobName.SmartSearch
            : workload === MlWorkload.Face
              ? JobName.AssetDetectFaces
              : JobName.Ocr,
        data: { id: asset.id },
        safeToRetry: true,
        sensitive: false,
        deadlineMs: 120_000,
      },
    ]);
    const [claim] = await store.claim(queue, workerId);
    const controller = new AbortController();
    const execution: QueueExecution = {
      claim,
      signal: controller.signal,
      progress: vi.fn(),
      progressUnits: 0,
      adoptions: [],
      followups: [],
      buffering: false,
    };
    const jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-disclosure-'));
    const path = join(root, 'synthetic.png');
    let taskId: string | undefined;
    let dispatched: Promise<unknown> | undefined;
    const resumeObserver = Promise.withResolvers<void>();
    const result = broker.result.bind(broker);
    // Model a stopped dispatcher: only the restarted service observes temporary authority revocations.
    vi.spyOn(broker, 'result').mockImplementation(async (id) => {
      await resumeObserver.promise;
      return result(id);
    });
    try {
      await writeConfig(true);
      const ml = new MachineLearningRepository(LoggingRepository.create(), routes, configRepo, metadata, index);
      ml.setup(config.machineLearning);
      const service = new DesktopMlService(broker, index, policies, routes, ml);
      service.onBootstrap();
      const ready = Promise.withResolvers<Awaited<ReturnType<typeof broker.create>>>();
      const create = broker.create.bind(broker);
      vi.spyOn(broker, 'create').mockImplementation(async (input) => {
        // Persist a previous release's binding; the restarted service must use its stored identity.
        if (legacy) {
          if (input.disclosure?.version !== 2 && input.disclosure?.version !== 3)
            throw new Error('legacy_image_disclosure_expected');
          input = {
            ...input,
            modelKey: profile.modelKey,
            disclosure: { ...input.disclosure, modelKey: profile.modelKey },
          };
        }
        const row = await create(input);
        ready.resolve(row);
        return row;
      });
      await writeFile(path, request.input);
      dispatched = queueExecution.run(execution, async () => {
        await jobs.guardAssetSource(asset.id);
        const selected = await ml.selectBackgroundPool(
          {
            destinationId: destination.id,
            kind: destination.kind,
            workload,
            endpoint: { url: destination.url!, assertAuthority: () => Promise.resolve() },
            record: vi.fn(),
          },
          asset.id,
        );
        return workload === MlWorkload.Clip
          ? ml.encodeImage(selected, path, config.machineLearning.clip)
          : workload === MlWorkload.Face
            ? ml.detectFaces(selected, path, config.machineLearning.facialRecognition)
            : ml.ocr(selected, path, config.machineLearning.ocr);
      });
      // Observe rejection immediately so teardown cancellation cannot become an unhandled promise.
      void dispatched.catch(() => {});
      const task = await Promise.race([
        ready.promise,
        dispatched.then(() => {
          throw new Error('task was not dispatched');
        }),
      ]);
      taskId = task.id;
      expect(task.disclosure).not.toBeNull();
      expect(JSON.stringify(task.disclosure)).not.toContain('authToken');
      const attempt = (await new DesktopMlRepository(db).claim(grants[0], [request.modelKey]))!;
      const input = () => {
        const freshMetadata = new SystemMetadataRepository(db);
        const freshRoutes = new MlDestinationRepository(db);
        const freshIndex = new DesktopClipIndexRepository(db);
        const freshMl = new MachineLearningRepository(
          LoggingRepository.create(),
          freshRoutes,
          configRepo,
          freshMetadata,
          freshIndex,
        );
        freshMl.setup(config.machineLearning);
        return new DesktopMlService(
          new DesktopMlRepository(db),
          freshIndex,
          new DesktopAssistancePolicyService(freshMetadata),
          freshRoutes,
          freshMl,
        ).input(grants[0], attempt.attempt.id);
      };
      expect(await input()).toEqual(request.input);
      const changed = async (mutate: () => Promise<unknown>, restore: () => Promise<unknown>, error: string) => {
        await mutate();
        try {
          await expect(input()).rejects.toThrow(error);
        } finally {
          await restore();
        }
        expect(await input()).toEqual(request.input);
      };
      await changed(
        () => db.updateTable('asset').set({ originalPath: '/synthetic/replaced' }).where('id', '=', asset.id).execute(),
        () => db.updateTable('asset').set({ originalPath: asset.originalPath }).where('id', '=', asset.id).execute(),
        'Asset inputs changed',
      );
      await changed(
        () => db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', asset.id).execute(),
        () => db.updateTable('asset').set({ visibility: asset.visibility }).where('id', '=', asset.id).execute(),
        'Asset inputs changed',
      );
      await changed(
        () =>
          metadata.withConfigTransaction((m) =>
            m.set(SystemMetadataKey.FrameleafDesktopAssistance, { version: 1, accounts: {} }),
          ),
        () => metadata.withConfigTransaction((m) => m.set(SystemMetadataKey.FrameleafDesktopAssistance, savedPolicy)),
        'desktop_pool_policy_changed',
      );
      await changed(
        () => routes.update(destination.id, { enabled: false }),
        () => routes.update(destination.id, { enabled: true }),
        'desktop_pool_destination_changed',
      );
      await changed(
        () => routes.update(destination.id, { authToken: 'synthetic-changed-token' }),
        () => routes.update(destination.id, { authToken: null }),
        'desktop_pool_destination_changed',
      );
      await changed(
        () => writeConfig(false),
        () => writeConfig(true),
        'desktop_pool_config_changed',
      );
      if (binding) {
        await changed(
          () =>
            db
              .updateTable('desktop_clip_index')
              .set({ revisionId: randomUUID() })
              .where('scope', '=', 'clip')
              .execute(),
          () =>
            db
              .updateTable('desktop_clip_index')
              .set({ revisionId: binding.revisionId })
              .where('scope', '=', 'clip')
              .execute(),
          'desktop_clip_index_changed',
        );
      } else {
        expect(await index.getActive()).toEqual(priorIndex);
        const settings =
          workload === MlWorkload.Face ? config.machineLearning.facialRecognition : config.machineLearning.ocr;
        const scoreKey = workload === MlWorkload.Face ? 'minScore' : 'minDetectionScore';
        const originalScore = settings[scoreKey as keyof typeof settings];
        await changed(
          () => {
            Object.assign(settings, { [scoreKey]: 0.6 });
            return writeConfig(true);
          },
          () => {
            Object.assign(settings, { [scoreKey]: originalScore });
            return writeConfig(true);
          },
          'desktop_pool_config_changed',
        );
      }
      await changed(
        () => sql`update job set token=gen_random_uuid() where id=${claim.id}::uuid`.execute(db),
        () => sql`update job set token=${claim.token}::uuid where id=${claim.id}::uuid`.execute(db),
        'desktop_pool_queue_changed',
      );
      await changed(
        () =>
          sql`update job set "leaseExpiresAt"=clock_timestamp()-interval '1 second' where id=${claim.id}::uuid`.execute(
            db,
          ),
        () =>
          sql`update job set "leaseExpiresAt"=clock_timestamp()+interval '60 seconds' where id=${claim.id}::uuid`.execute(
            db,
          ),
        'desktop_pool_queue_changed',
      );
      await changed(
        () => sql`update job set "cancelRequestedAt"=clock_timestamp() where id=${claim.id}::uuid`.execute(db),
        () => sql`update job set "cancelRequestedAt"=null where id=${claim.id}::uuid`.execute(db),
        'desktop_pool_queue_changed',
      );
      await changed(
        () => brokerDb.updateTable('desktop_ml_task').set({ disclosure: null }).where('id', '=', task.id).execute(),
        () =>
          brokerDb
            .updateTable('desktop_ml_task')
            .set({ disclosure: task.disclosure })
            .where('id', '=', task.id)
            .execute(),
        'desktop_input_authority_invalid',
      );
      await routes.clearRoute(workload);
      await expect(input()).rejects.toThrow('desktop_pool_route_changed');
    } finally {
      controller.abort();
      resumeObserver.resolve();
      await dispatched?.catch(() => {});
      if (taskId) {
        await broker.cancel(taskId);
        await broker.discard(taskId);
      }
      await rm(root, { recursive: true, force: true });
      await metadata.withConfigTransaction((metadataRepo) =>
        base.updateConfig(originalConfig, { configRepo, metadataRepo, logger: LoggingRepository.create() }),
      );
    }
  },
  90_000,
);

it('migrates old broker tasks to unproven disclosure and reverses without deleting their rows', async () => {
  const schema = 'disclosure_' + randomUUID().replaceAll('-', '');
  await db.schema.createSchema(schema).execute();
  const scratch = db.withSchema(schema) as Kysely<any>;
  try {
    await scratch.schema
      .createTable('desktop_ml_task')
      .addColumn('id', 'integer', (c) => c.primaryKey())
      .execute();
    await scratch.insertInto('desktop_ml_task').values({ id: 1 }).execute();
    await addDisclosure(scratch);
    expect(await scratch.selectFrom('desktop_ml_task').selectAll().execute()).toEqual([{ id: 1, disclosure: null }]);
    await removeDisclosure(scratch);
    expect(await scratch.selectFrom('desktop_ml_task').selectAll().execute()).toEqual([{ id: 1 }]);
  } finally {
    await db.schema.dropSchema(schema).cascade().execute();
  }
});

it('does not hold a worker row while waiting for disclosure configuration authority', async () => {
  const { sut, grants, request } = await setup();
  await sut.create(request);
  const claim = (await sut.claim(grants[0], [request.modelKey]))!;
  const entered = Promise.withResolvers<void>();
  let receiving: Promise<Buffer | undefined> | undefined;
  try {
    await db.transaction().execute(async (blocking) => {
      await lockEffectiveConfig(blocking, 'write');
      receiving = sut.input(grants[0], claim.attempt.id, async (_task, tx) => {
        entered.resolve();
        await lockEffectiveConfig(tx, 'read');
      });
      void receiving.catch(() => {});
      await entered.promise;
      await db.transaction().execute(async (observer) => {
        const { rows } =
          await sql`SELECT id FROM desktop_device WHERE id=${grants[0].deviceId}::uuid FOR UPDATE NOWAIT`.execute(
            observer,
          );
        expect(rows).toHaveLength(1);
      });
    });
    expect(await receiving).toEqual(request.input);
  } finally {
    await receiving?.catch(() => {});
  }
});
