import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DesktopDeviceCreate } from 'src/repositories/desktop-device.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const row: DesktopDeviceCreate = {
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Fixture desktop',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'preparing',
  };
  return { sut: new DesktopDeviceRepository(db), row, other };
};

it('concurrent retry after a lost response creates one durable identity', async () => {
  const { sut, row } = await setup();
  const [first, retry] = await Promise.all([sut.enroll(row), sut.enroll(row)]);
  expect(first!.id).toEqual(retry!.id);
  expect(await sut.list(row.userId)).toHaveLength(1);
});
it('refuses a changed public key without changing existing identity', async () => {
  const { sut, row } = await setup();
  const first = await sut.enroll(row);
  expect(await sut.enroll({ ...row, publicKey: Buffer.alloc(32, 8).toString('base64') })).toBeUndefined();
  expect((await sut.list(row.userId))[0]).toEqual(first);
});
it('sign-out advances authority epoch and the same identity resumes on a fresh sign-in', async () => {
  const { sut, row } = await setup();
  const first = (await sut.enroll(row))!;
  expect(await sut.endSession(row.userId, first.id)).toBe(true);
  const paused = (await sut.list(row.userId))[0];
  expect(paused.state).toBe('paused');
  expect(paused.authorizationEpoch).toBe(first.authorizationEpoch + 1);
  expect(await sut.enroll(row)).toMatchObject({
    id: first.id,
    state: 'preparing',
    authorizationEpoch: paused.authorizationEpoch,
  });
});
it('permanent revocation cannot be revived through sign-in', async () => {
  const { sut, row } = await setup();
  const first = (await sut.enroll(row))!;
  expect(await sut.revoke(row.userId, first.id)).toBe(true);
  expect(await sut.enroll(row)).toBeUndefined();
  expect(await sut.endSession(row.userId, first.id)).toBe(false);
  expect((await sut.list(row.userId))[0]).toMatchObject({
    state: 'revoked',
    authorizationEpoch: first.authorizationEpoch + 1,
  });
});
it('other accounts cannot list, pause or revoke an enrolled device', async () => {
  const { sut, row, other } = await setup();
  const first = (await sut.enroll(row))!;
  expect(await sut.list(other.id)).toEqual([]);
  expect(await sut.endSession(other.id, first.id)).toBe(false);
  expect(await sut.revoke(other.id, first.id)).toBe(false);
  expect((await sut.list(row.userId))[0]).toEqual(first);
});
