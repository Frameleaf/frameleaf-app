import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
const setup = async (mode = 'reference') => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const session = await new SessionRepository(db).create({ userId: user.id, token: randomBytes(32) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: randomBytes(32).toString('base64'),
    name: 'Source fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const source = await new PhotoSourceRepository(db).create(
    { ownerId: user.id, sessionId: session.id },
    {
      id: randomUUID(),
      deviceId: device.id,
      kind: 'folder',
      mode: 'copy',
      name: 'Fixture',
      scopeFingerprint: 'a'.repeat(64),
    },
  );
  // Reference registration is not exposed yet; construct the database authority explicitly.
  await sql`UPDATE photo_source SET mode = ${mode} WHERE id = ${source.id}::uuid`.execute(db);
  const request = {
    sourceId: source.id,
    deviceId: device.id,
    scopeFingerprint: source.scopeFingerprint,
    requestId: randomUUID(),
    timestamp: Date.now(),
    signature: Buffer.alloc(64).toString('base64'),
  };
  const input = {
    ownerId: user.id,
    photoSessionId: session.id,
    request,
    authorizationEpoch: device.authorizationEpoch,
    publicKey: device.publicKey,
    tokenHash: randomBytes(32),
  };
  const sut = new SourceResourceRepository(db);
  return { db, sut, input, source, device, session, user };
};
it('requires live reference authority independently of ML approval and consumes a sequence only once', async () => {
  const { sut, input } = await setup();
  const grant = (await sut.issue(input))!;
  expect(grant).toMatchObject({
    sourceId: input.request.sourceId,
    deviceId: input.request.deviceId,
    ownerId: input.ownerId,
  });
  const credential = (await sut.session(grant.grantId, input.tokenHash))!;
  const attempts = await Promise.all([sut.consume(credential, 1), sut.consume(credential, 1)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(await sut.consume(credential, 0)).toBeUndefined();
  expect(await sut.consume(credential, 2)).toMatchObject({ grantId: grant.grantId });
  expect(await sut.session(grant.grantId, randomBytes(32))).toBeUndefined();
  const copy = await setup('copy');
  expect(await copy.sut.device(copy.input.ownerId, copy.input.photoSessionId, copy.input.request)).toBeUndefined();
  expect(await copy.sut.issue(copy.input)).toBeUndefined();
});
it('serializes duplicate issuance and rotates credentials without restoring old sequence authority', async () => {
  const { sut, input } = await setup();
  const attempts = await Promise.all([sut.issue(input), sut.issue(input)]);
  expect(attempts.filter(Boolean)).toHaveLength(1);
  const first = attempts.find(Boolean)!;
  const old = (await sut.session(first.grantId, input.tokenHash))!;
  const replacement = { ...input, request: { ...input.request, requestId: randomUUID() }, tokenHash: randomBytes(32) };
  expect(await sut.issue(replacement)).toMatchObject({ grantId: first.grantId });
  expect(await sut.session(first.grantId, input.tokenHash)).toBeUndefined();
  expect(await sut.consume(old, 1)).toBeUndefined();
  expect(await sut.consume((await sut.session(first.grantId, replacement.tokenHash))!, 1)).toBeTruthy();
  expect(await sut.issue(input)).toBeUndefined();
});
it('pins live source authority around a scoped transaction and refuses a rotated or paused grant', async () => {
  const { sut, input, device } = await setup();
  const grant = (await sut.issue(input))!;
  const action = vi.fn(async (tx: Kysely<DB>) => {
    const { rows } = await sql<{ id: string }>`SELECT id FROM photo_source WHERE id=${grant.sourceId}::uuid`.execute(
      tx,
    );
    return rows[0].id;
  });
  expect(await sut.withGrant(grant, action)).toBe(grant.sourceId);
  expect(action).toHaveBeenCalledTimes(1);
  for (const change of [
    { ownerId: randomUUID() },
    { deviceId: randomUUID() },
    { sourceId: randomUUID() },
    { scopeFingerprint: 'f'.repeat(64) },
    { authorizationEpoch: grant.authorizationEpoch + 1 },
  ]) {
    expect(await sut.withGrant({ ...grant, ...change }, action)).toBeUndefined();
  }
  expect(action).toHaveBeenCalledTimes(1);
  await sut.issue({ ...input, request: { ...input.request, requestId: randomUUID() }, tokenHash: randomBytes(32) });
  expect(await sut.withGrant(grant, action)).toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
  const replacement = (await sut.issue({
    ...input,
    request: { ...input.request, requestId: randomUUID() },
    tokenHash: randomBytes(32),
  }))!;
  await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', device.id).execute();
  expect(await sut.withGrant(replacement, action)).toBeUndefined();
  expect(action).toHaveBeenCalledTimes(1);
});
it.each([
  'source-revoked',
  'source-scope',
  'device-paused',
  'device-revoked',
  'device-epoch',
  'device-key',
  'photo-expired',
  'photo-rebound',
  'owner-deleted',
  'grant-expired',
  'grant-revoked',
])('refuses cached authority after %s', async (change) => {
  const { sut, input, source, device, session, user } = await setup();
  const grant = (await sut.issue(input))!;
  const credential = (await sut.session(grant.grantId, input.tokenHash))!;
  switch (change) {
    case 'source-revoked': {
      await db.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', source.id).execute();
      break;
    }
    case 'source-scope': {
      await db
        .updateTable('photo_source')
        .set({ scopeFingerprint: 'b'.repeat(64) })
        .where('id', '=', source.id)
        .execute();
      break;
    }
    case 'device-paused': {
      await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', device.id).execute();
      break;
    }
    case 'device-revoked': {
      await db.updateTable('desktop_device').set({ revokedAt: new Date() }).where('id', '=', device.id).execute();
      break;
    }
    case 'device-epoch': {
      await db
        .updateTable('desktop_device')
        .set({ authorizationEpoch: device.authorizationEpoch + 1 })
        .where('id', '=', device.id)
        .execute();
      break;
    }
    case 'device-key': {
      await db
        .updateTable('desktop_device')
        .set({ publicKey: randomBytes(32).toString('base64') })
        .where('id', '=', device.id)
        .execute();
      break;
    }
    case 'photo-expired': {
      await db
        .updateTable('session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', session.id)
        .execute();
      break;
    }
    case 'photo-rebound': {
      await db.updateTable('photo_source').set({ photoSessionId: randomUUID() }).where('id', '=', source.id).execute();
      break;
    }
    case 'owner-deleted': {
      await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', user.id).execute();
      break;
    }
    case 'grant-expired': {
      await db
        .updateTable('source_resource_grant')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', grant.grantId)
        .execute();
      break;
    }
    case 'grant-revoked': {
      await db
        .updateTable('source_resource_grant')
        .set({ revokedAt: new Date() })
        .where('id', '=', grant.grantId)
        .execute();
      break;
    }
  }
  expect(await sut.consume(credential, 1)).toBeUndefined();
  if (change !== 'device-key') expect(await sut.session(grant.grantId, input.tokenHash)).toBeUndefined();
});
it('limits recent issuance nonces without forgetting a still-valid replay', async () => {
  const { sut, input } = await setup();
  expect(await sut.issue({ ...input, publicKey: randomBytes(32).toString('base64') })).toBeUndefined();
  expect(await sut.issue({ ...input, request: { ...input.request, timestamp: Date.now() - 120_001 } })).toBeUndefined();
  for (let i = 0; i < 8; i++) {
    expect(await sut.issue({ ...input, request: { ...input.request, requestId: randomUUID() } })).toBeTruthy();
  }
  await expect(sut.issue(input)).rejects.toThrow('source_grant_issue_busy');
  expect(
    await db
      .selectFrom('source_resource_grant_nonce')
      .select('requestId')
      .where('sourceId', '=', input.request.sourceId)
      .execute(),
  ).toHaveLength(8);
});

it.each(['grant', 'photo-session'])('rolls back scoped changes when %s expires during the action', async (expiry) => {
  const { sut, input, session, source } = await setup();
  const grant = (await sut.issue(input))!;
  const result = await sut.withGrant(grant, async (tx) => {
    if (expiry === 'grant') {
      await tx
        .updateTable('source_resource_grant')
        .set({ expiresAt: sql`clock_timestamp()+interval '10 milliseconds'` })
        .where('id', '=', grant.grantId)
        .execute();
    } else {
      await tx
        .updateTable('session')
        .set({ expiresAt: sql`clock_timestamp()+interval '10 milliseconds'` })
        .where('id', '=', session.id)
        .execute();
    }
    await sql`SELECT pg_sleep(0.03)`.execute(tx);
    await tx.updateTable('photo_source').set({ name: 'Must roll back' }).where('id', '=', source.id).execute();
    return true;
  });
  expect(result).toBeUndefined();
  expect(
    (await db.selectFrom('photo_source').select('name').where('id', '=', source.id).executeTakeFirst())?.name,
  ).toBe(source.name);
});
