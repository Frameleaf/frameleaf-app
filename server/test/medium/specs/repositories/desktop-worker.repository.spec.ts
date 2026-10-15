import { Kysely, sql } from 'kysely';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { desktopSessionMessage, desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopWorkerRepository, type DesktopWorkerTables } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let workerDb: Kysely<DB & DesktopWorkerTables>;
beforeAll(async () => {
  db = await getKyselyDB();
  workerDb = db.withTables<DesktopWorkerTables>();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const photo = await db
    .insertInto('session')
    .values({
      userId: user.id,
      token: Buffer.alloc(32, 1),
      expiresAt: null,
      parentId: null,
      appVersion: null,
      pinExpiresAt: null,
      oauthSid: null,
      oauthBearerToken: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const devices = new DesktopDeviceRepository(db);
  const keys = generateKeyPairSync('ed25519');
  const device = (await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'preparing',
  }))!;
  const input = {
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    photoSessionId: photo.id,
    tokenHash: createHash('sha256').update(randomUUID()).digest(),
    modelKeys: ['approved-model'],
  };
  return { sut: new DesktopWorkerRepository(db), second: new DesktopWorkerRepository(db), devices, user, input, keys };
};
it('keeps one association through retry and rotation, and invalidates the previous secret', async () => {
  const { sut, input } = await setup();
  const first = (await sut.issue(input))!;
  const hash = Buffer.alloc(32, 8);
  const retried = (await sut.issue({ ...input, tokenHash: hash }))!;
  expect(retried.id).toBe(first.id);
  expect(await sut.session(first.id, input.tokenHash)).toBeUndefined();
  const grant = (await sut.consume(first.id, hash, 1))!;
  const rotated = await sut.rotate(grant, hash, Buffer.alloc(32, 7));
  expect(rotated).toMatchObject({ id: first.id, lastSequence: 0, modelKeys: ['approved-model'] });
  expect(await sut.consume(first.id, hash, 2)).toBeUndefined();
});
it('two API instances accept a signed request counter only once', async () => {
  const { sut, second, input } = await setup();
  const session = (await sut.issue(input))!;
  const accepted = await Promise.all([
    sut.consume(session.id, input.tokenHash, 1),
    second.consume(session.id, input.tokenHash, 1),
  ]);
  expect(accepted.filter(Boolean)).toHaveLength(1);
  expect(await sut.consume(session.id, input.tokenHash, 1)).toBeUndefined();
  expect(await sut.consume(session.id, input.tokenHash, 2)).toBeDefined();
});
it('rechecks administrator status, parent session, device epoch and grant expiry', async () => {
  const { sut, devices, user, input } = await setup();
  const session = (await sut.issue(input))!;
  await db.updateTable('user').set({ isAdmin: false }).where('id', '=', user.id).execute();
  expect(await sut.consume(session.id, input.tokenHash, 1)).toBeUndefined();
  await db.updateTable('user').set({ isAdmin: true }).where('id', '=', user.id).execute();
  await workerDb
    .updateTable('desktop_worker_session')
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where('id', '=', session.id)
    .execute();
  expect(await sut.consume(session.id, input.tokenHash, 1)).toBeUndefined();
  await sut.issue(input);
  await devices.endSession(user.id, input.deviceId);
  expect(await sut.consume(session.id, input.tokenHash, 1)).toBeUndefined();
  expect(await sut.issue(input)).toBeUndefined();
});
it('photo sign-out and explicit worker revocation cannot be renewed with the old credential', async () => {
  const { sut, input } = await setup();
  const session = (await sut.issue(input))!;
  const grant = (await sut.consume(session.id, input.tokenHash, 1))!;
  expect(await sut.revoke(grant)).toBe(true);
  expect(await sut.rotate(grant, input.tokenHash, Buffer.alloc(32, 5))).toBeUndefined();
  await sut.issue(input);
  await db.deleteFrom('session').where('id', '=', input.photoSessionId).execute();
  expect(await sut.session(session.id, input.tokenHash)).toBeUndefined();
  expect(
    await workerDb.selectFrom('desktop_worker_session').select('id').where('id', '=', session.id).executeTakeFirst(),
  ).toBeUndefined();
});
it('refuses a parent photo session belonging to another account', async () => {
  const { sut, input } = await setup();
  const other = await setup();
  expect(await sut.issue({ ...input, photoSessionId: other.input.photoSessionId })).toBeUndefined();
});

it('uses the real signed credential through issuance, replay fencing and parent photo logout', async () => {
  const { sut, user, input, keys } = await setup();
  const metadata = new SystemMetadataRepository(db);
  const serverId = await stableServerId({ systemMetadataRepository: metadata });
  const auth = new DesktopWorkerAuthService(sut, metadata);
  const request = { deviceId: input.deviceId, requestId: randomUUID(), timestamp: Date.now(), signature: '' };
  request.signature = sign(
    null,
    Buffer.from(desktopSessionMessage(serverId, user.id, request)),
    keys.privateKey,
  ).toString('base64');
  const credential = await auth.issue({ user, session: { id: input.photoSessionId } } as never, request);
  const proof = (sequence: number) => {
    const dto = { sessionId: credential.sessionId, sequence, timestamp: Date.now(), signature: '' };
    dto.signature = sign(
      null,
      Buffer.from(
        desktopWorkerMessage(serverId, credential.authorizationEpoch, credential.workerToken, dto, 'claim', '{}'),
      ),
      keys.privateKey,
    ).toString('base64');
    return Buffer.from(JSON.stringify(dto)).toString('base64');
  };
  expect(await auth.authenticate('Bearer ' + credential.workerToken, proof(1), 'claim', '{}')).toMatchObject({
    deviceId: input.deviceId,
  });
  await expect(auth.authenticate('Bearer ' + credential.workerToken, proof(1), 'claim', '{}')).rejects.toThrow();
  await db.deleteFrom('session').where('id', '=', input.photoSessionId).execute();
  await expect(auth.authenticate('Bearer ' + credential.workerToken, proof(2), 'claim', '{}')).rejects.toThrow();
});
