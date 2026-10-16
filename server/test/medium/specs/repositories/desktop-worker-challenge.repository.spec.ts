import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import {
  DesktopWorkerChallengeRepository,
  type DesktopWorkerChallengeTables,
} from 'src/repositories/desktop-worker-challenge.repository.js';
import { DesktopWorkerRepository, type DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt, type DesktopRuntimeIdentity } from 'src/utils/desktop-qualification.js';
import { canonicalJson } from 'src/utils/object.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let challengeDb: Kysely<DB & DesktopWorkerChallengeTables & DesktopWorkerTables>;
beforeAll(async () => {
  db = await getKyselyDB();
  challengeDb = db.withTables<DesktopWorkerChallengeTables & DesktopWorkerTables>();
});
afterAll(async () => {
  await db?.destroy();
});
const catalogue = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
);
const profile = catalogue.profiles[0];
const runtime = {
  manifestSha256: 'a'.repeat(64),
  sourceRevision: profile.runtimeSourceRevision,
  provider: profile.spec.provider,
  platform: 'macos',
  architecture: 'aarch64',
  epoch: 2,
} as const;
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const { session: photo } = await ctx.newSession({ userId: user.id });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 1).toString('base64'),
    name: 'Challenge fixture',
    platform: 'macos',
    architecture: 'arm64',
    mode: 'client-worker',
    state: 'preparing',
  }))!;
  const workers = new DesktopWorkerRepository(db);
  const tokenHash = Buffer.alloc(32, 21);
  const session = (await workers.issue({
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    photoSessionId: photo.id!,
    tokenHash,
    modelKeys: [],
  }))!;
  const grant = (await workers.consume(session.id, tokenHash, 1))!;
  return {
    sut: new DesktopWorkerChallengeRepository(db),
    second: new DesktopWorkerChallengeRepository(db),
    workers,
    grant,
    photo,
    user,
  };
};
const receipt = (
  row: { specJson: string; bindingSha256: string; runtime: DesktopRuntimeIdentity },
  warmMilliseconds = 10,
) => {
  const facts = {
    system: 'Darwin',
    release: 'fixture',
    architecture: 'arm64',
    processor: 'fixture',
    python: '3.12.13',
    ort: '1.30.0',
    packages: { onnxruntime: '1.30.0' },
    providers: ['CPUExecutionProvider'],
    gpus: [],
    totalMemoryBytes: 8 * 1024 ** 3,
  };
  return DesktopQualificationReceipt.validate(
    {
      protocolVersion: 1,
      modelKey: profile.modelKey,
      provider: profile.spec.provider,
      preprocessingSha256: profile.spec.preprocessingSha256,
      fixtureSha256: profile.spec.fixtureSha256,
      bindingSha256: row.bindingSha256,
      runtime: facts,
      runtimeFingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex'),
      coldMilliseconds: 120,
      warmMilliseconds,
      reason: null,
      state: 'ready-cpu',
      execution: [
        {
          state: 'ready-cpu',
          nodes: { CPUExecutionProvider: 123 },
          microseconds: { CPUExecutionProvider: 1000 },
          reason: null,
        },
      ],
    },
    profile,
    { specJson: row.specJson, bindingSha256: row.bindingSha256, fixtureBase64: profile.fixtureBase64 },
    row.runtime,
  );
};
it('persists one fresh challenge through two API instances and lost-response retries', async () => {
  const { sut, second, grant } = await setup();
  const requestId = randomUUID();
  const issued = await Promise.all([
    sut.issue(grant, requestId, profile, runtime),
    second.issue(grant, requestId, profile, runtime),
  ]);
  expect(issued[0]).toEqual(issued[1]);
  const row = issued[0]!;
  expect(row.id).not.toBe(requestId);
  expect(row.specJson).toContain(row.id);
  expect(new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()).toBeLessThanOrEqual(600_000);
  expect(await second.read(grant, row.id)).toEqual(row);
  await expect(second.issue(grant, requestId, catalogue.profiles[1], runtime)).rejects.toThrow(
    'desktop_challenge_conflict',
  );
  await expect(second.issue(grant, requestId, profile, { ...runtime, manifestSha256: 'b'.repeat(64) })).rejects.toThrow(
    'desktop_challenge_conflict',
  );
  const session = await challengeDb
    .selectFrom('desktop_worker_session')
    .select('modelKeys')
    .where('id', '=', grant.sessionId)
    .executeTakeFirstOrThrow();
  expect(session.modelKeys).toEqual([]);
  await expect(sut.issue(grant, randomUUID(), profile, { ...runtime, platform: 'linux' })).rejects.toThrow(
    'desktop_challenge_runtime_invalid',
  );
});
it('records only an exact sealed receipt, idempotently, without granting model scope', async () => {
  const { sut, second, grant } = await setup();
  const row = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  const validated = receipt(row);
  expect(await sut.record(grant, row.id, Object.freeze({ ...validated }) as never)).toBe(false);
  expect(await Promise.all([sut.record(grant, row.id, validated), second.record(grant, row.id, validated)])).toEqual([
    true,
    true,
  ]);
  expect(await sut.record(grant, row.id, receipt(row, 11))).toBe(false);
  const stored = (await sut.read(grant, row.id))!;
  expect(stored.reportSha256).toBe(validated.reportSha256);
  expect(stored.runtimeFingerprint).toBe(validated.runtimeFingerprint);
  const other = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  expect(await sut.record(grant, other.id, validated)).toBe(false);
  const scope = await challengeDb
    .selectFrom('desktop_worker_session')
    .select('modelKeys')
    .where('id', '=', grant.sessionId)
    .executeTakeFirstOrThrow();
  expect(scope.modelKeys).toEqual([]);
});
it('fences expiry, rotation, sign-out and cross-device attempts and prunes only bounded device rows', async () => {
  const { sut, grant, workers, photo } = await setup();
  const other = await setup();
  const row = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  expect(await sut.read(other.grant, row.id)).toBeUndefined();
  expect(await sut.record(other.grant, row.id, receipt(row))).toBe(false);
  await challengeDb
    .updateTable('desktop_worker_challenge')
    .set({ expiresAt: sql`clock_timestamp() - interval '1 second'` })
    .where('id', '=', row.id)
    .execute();
  expect(await sut.read(grant, row.id)).toBeUndefined();
  expect(await sut.record(grant, row.id, receipt(row))).toBe(false);
  for (let n = 0; n < 16; n++) expect(await sut.issue(grant, randomUUID(), profile, runtime)).toBeDefined();
  await expect(sut.issue(grant, randomUUID(), profile, runtime)).rejects.toThrow('desktop_challenge_capacity');
  const nextHash = Buffer.alloc(32, 22);
  expect(await workers.rotate(grant, grant.credentialHash, nextHash)).toBeDefined();
  expect(await sut.issue(grant, randomUUID(), profile, runtime)).toBeUndefined();
  const current = (await workers.consume(grant.sessionId, nextHash, 1))!;
  const fresh = (await sut.issue(current, randomUUID(), profile, runtime))!;
  expect(
    await challengeDb
      .selectFrom('desktop_worker_challenge')
      .select('id')
      .where('deviceId', '=', grant.deviceId)
      .execute(),
  ).toHaveLength(1);
  await db.deleteFrom('session').where('id', '=', photo.id!).execute();
  expect(await sut.read(current, fresh.id)).toBeUndefined();
  expect(
    await challengeDb
      .selectFrom('desktop_worker_challenge')
      .select('id')
      .where('deviceId', '=', grant.deviceId)
      .execute(),
  ).toHaveLength(0);
});

it('refuses evidence after administrator removal or device revocation', async () => {
  const { sut, grant, user } = await setup();
  const row = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  await db.updateTable('user').set({ isAdmin: false }).where('id', '=', user.id).execute();
  expect(await sut.read(grant, row.id)).toBeUndefined();
  expect(await sut.record(grant, row.id, receipt(row))).toBe(false);
  await db.updateTable('user').set({ isAdmin: true }).where('id', '=', user.id).execute();
  await new DesktopDeviceRepository(db).endSession(user.id, grant.deviceId);
  expect(await sut.read(grant, row.id)).toBeUndefined();
  expect(await sut.record(grant, row.id, receipt(row))).toBe(false);
});

it('sign-in replacement deletes prior challenge evidence and cannot reuse its request identity', async () => {
  const { sut, workers, grant, photo } = await setup();
  const requestId = randomUUID();
  const row = (await sut.issue(grant, requestId, profile, runtime))!;
  expect(await sut.record(grant, row.id, receipt(row))).toBe(true);
  const session = (await workers.issue({
    deviceId: grant.deviceId,
    authorizationEpoch: grant.authorizationEpoch,
    photoSessionId: photo.id!,
    tokenHash: Buffer.alloc(32, 31),
    modelKeys: [],
  }))!;
  const current = (await workers.consume(session.id, session.tokenHash, 1))!;
  expect(await sut.read(grant, row.id)).toBeUndefined();
  expect(await sut.record(grant, row.id, receipt(row))).toBe(false);
  expect(await sut.read(current, row.id)).toBeUndefined();
  expect(await sut.record(current, row.id, receipt(row))).toBe(false);
  expect(
    await challengeDb
      .selectFrom('desktop_worker_challenge')
      .select('id')
      .where('deviceId', '=', grant.deviceId)
      .execute(),
  ).toHaveLength(0);
  const fresh = (await sut.issue(current, requestId, profile, runtime))!;
  expect(fresh.id).not.toBe(row.id);
  expect(fresh.reportSha256).toBeNull();
});

it('accepted runtime evidence has an absolute lifetime across retries and renewal, and replacement cannot revive it', async () => {
  const { sut, workers, grant, photo, user } = await setup();
  const proofDb =
    db.withTables<import('src/schema/tables/desktop-worker-qualification.table.js').DesktopQualificationTables>();
  const first = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  const validated = receipt(first);
  expect(await sut.record(grant, first.id, validated)).toBe(true);
  expect(await sut.readAccepted(grant, first.id)).toMatchObject({ id: first.id });
  const accepted = await proofDb
    .selectFrom('desktop_worker_qualification')
    .selectAll()
    .where('id', '=', first.id)
    .executeTakeFirstOrThrow();
  expect(accepted).toMatchObject({
    sessionId: grant.sessionId,
    deviceId: grant.deviceId,
    modelKey: profile.modelKey,
    profileSha256: validated.profileSha256,
    runtime,
    runtimeFingerprint: validated.runtimeFingerprint,
    reportSha256: validated.reportSha256,
    inputKind: 'text',
  });
  expect(new Date(accepted.expiresAt).getTime() - new Date(accepted.createdAt).getTime()).toBe(3_600_000);
  // The fixture supplies explicit NAS model scope; recording runtime evidence does not grant it.
  await challengeDb
    .updateTable('desktop_worker_session')
    .set({ modelKeys: sql`${[profile.modelKey]}::jsonb` })
    .where('id', '=', grant.sessionId)
    .execute();
  const broker = new DesktopMlRepository(db);
  const task = await broker.create({
    ownerId: user.id,
    modelKey: profile.modelKey,
    authorityKey: 'qualification-fixture',
    config: profile.spec.entries,
    input: Buffer.from(profile.fixtureBase64, 'base64'),
    inputKind: 'text',
    deadlineAt: new Date(Date.now() + 120_000),
  });
  const attempt = (await broker.claim(grant, [profile.modelKey]))!;
  expect(attempt.attempt.qualificationId).toBe(first.id);
  expect(await broker.complete(grant, attempt.attempt.id, { clip: [1, 2] })).toBe(true);
  await expect(broker.assertAdoption(task.id, task)).resolves.toBeUndefined();

  expect(await sut.record(grant, first.id, validated)).toBe(true);
  expect(
    await proofDb
      .selectFrom('desktop_worker_qualification')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(accepted);
  const nextHash = Buffer.alloc(32, 32);
  expect(await workers.rotate(grant, grant.credentialHash, nextHash)).toBeDefined();
  const current = (await workers.consume(grant.sessionId, nextHash, 1))!;
  await expect(broker.assertAdoption(task.id, task)).resolves.toBeUndefined();
  expect(await sut.readAccepted(grant, first.id)).toBeUndefined();
  expect(await sut.readAccepted(current, first.id)).toMatchObject({ id: first.id });
  const second = (await sut.issue(current, randomUUID(), profile, runtime))!;
  expect(
    await proofDb
      .selectFrom('desktop_worker_qualification')
      .selectAll()
      .where('id', '=', first.id)
      .executeTakeFirstOrThrow(),
  ).toEqual(accepted);
  expect(await sut.record(current, second.id, receipt(second))).toBe(true);
  await expect(broker.assertAdoption(task.id, task)).rejects.toThrow('desktop_result_authority_lost');
  expect(await sut.readAccepted(current, first.id)).toBeUndefined();
  expect(
    await proofDb.selectFrom('desktop_worker_qualification').select('id').where('id', '=', first.id).executeTakeFirst(),
  ).toBeUndefined();
  expect(await sut.record(grant, first.id, validated)).toBe(false);
  await proofDb
    .updateTable('desktop_worker_qualification')
    .set({ createdAt: sql`now() - interval '2 hours'`, expiresAt: sql`now() - interval '1 hour'` })
    .where('id', '=', second.id)
    .execute();
  expect(await sut.readAccepted(current, second.id)).toBeUndefined();
  const replacement = await workers.issue({
    deviceId: grant.deviceId,
    authorizationEpoch: grant.authorizationEpoch,
    photoSessionId: photo.id!,
    tokenHash: Buffer.alloc(32, 33),
    modelKeys: [],
  });
  expect(replacement).toBeDefined();
  expect(
    await proofDb
      .selectFrom('desktop_worker_qualification')
      .select('id')
      .where('deviceId', '=', grant.deviceId)
      .execute(),
  ).toHaveLength(0);
});

it('accepted evidence cannot be read by a different authenticated worker', async () => {
  const { sut, grant } = await setup();
  const other = await setup();
  const row = (await sut.issue(grant, randomUUID(), profile, runtime))!;
  expect(await sut.record(grant, row.id, receipt(row))).toBe(true);
  expect(await sut.readAccepted(grant, row.id)).toMatchObject({ id: row.id });
  expect(await sut.readAccepted(other.grant, row.id)).toBeUndefined();
});
