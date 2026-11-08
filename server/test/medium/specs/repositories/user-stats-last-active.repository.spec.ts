import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
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

// Users › "Last active" (prototype People.jsx): when a signed-in device of the account was last used.
it('says when the account last used any of its sessions, and null without one', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: active } = await ctx.newUser();
  const { user: never } = await ctx.newUser();
  await ctx.newSession({ userId: active.id });
  const { session: newer } = await ctx.newSession({ userId: active.id });
  // the updatedAt trigger stamps "now" on every update, as signing in with a session does
  await db.updateTable('session').set({ appVersion: 'used' }).where('id', '=', newer.id).execute();
  const { latest } = await db
    .selectFrom('session')
    .select((eb) => eb.fn.max('updatedAt').as('latest'))
    .where('userId', '=', active.id)
    .executeTakeFirstOrThrow();
  const stats = await new UserRepository(db).getUserStats();

  expect(new Date(stats.find((row) => row.userId === active.id)!.lastActiveAt!)).toEqual(new Date(latest));
  expect(stats.find((row) => row.userId === never.id)?.lastActiveAt).toBeNull();
});

// A partner copy is the same photo again: its account's row counts it, and `copy*` says how much of the
// row is copies so the server totals count each photo once. A copy whose source is trashed is no copy.
it('marks partner copies of live photos so the server totals can count them once', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user: alice } = await ctx.newUser();
  const { user: bob } = await ctx.newUser();
  await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });
  const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
  await ctx.newExif({ assetId: source.id, fileSizeInByte: 1000 });
  const original = await ctx.get(PhysicalFileRepository).ensureOriginalPhysicalFile(source.id);
  if (!original) throw new Error('Expected source physical file');
  const copyId = await ctx.get(PartnerOriginRepository).insertAssetCopy({
    sourceAssetId: source.id,
    ownerId: bob.id,
    rootOwnerId: alice.id,
    partnerSharedById: alice.id,
    original,
  });
  expect(copyId).toBeDefined();
  const row = async (userId: string) =>
    (await new UserRepository(db).getUserStats()).find((stats) => stats.userId === userId)!;

  expect(await row(alice.id)).toMatchObject({ photos: 1, copyPhotos: 0, copyUsage: 0 });
  const copy = await row(bob.id);
  expect(copy).toMatchObject({ photos: 1, copyPhotos: 1, copyVideos: 0 });
  expect(Number(copy.copyUsage)).toBe(Number(copy.usage));
  expect(Number(copy.copyUsage)).toBeGreaterThan(0);

  await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', source.id).execute();
  expect(await row(bob.id)).toMatchObject({ photos: 1, copyPhotos: 0, copyUsage: 0 });
});

// A server start locks every session of an account with Locked key files (SessionService.onBootstrap).
// Only a session elevated right now is written; the others keep their updatedAt, so "Last active" does
// not jump to the restart.
it('locks only elevated sessions, leaving the others’ last activity alone', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { session: locked } = await ctx.newSession({ userId: user.id });
  const { session: expired } = await ctx.newSession({ userId: user.id });
  const { session: elevated } = await ctx.newSession({ userId: user.id });
  const hour = 60 * 60 * 1000;
  await db
    .updateTable('session')
    .set({ pinExpiresAt: new Date(Date.now() - hour) })
    .where('id', '=', expired.id)
    .execute();
  await db
    .updateTable('session')
    .set({ pinExpiresAt: new Date(Date.now() + hour) })
    .where('id', '=', elevated.id)
    .execute();
  const read = () =>
    db.selectFrom('session').select(['id', 'updatedAt', 'pinExpiresAt']).where('userId', '=', user.id).execute();
  const before = new Map((await read()).map((row) => [row.id, row]));

  await new SessionRepository(db).lockAll(user.id);

  const after = new Map((await read()).map((row) => [row.id, row]));
  expect(after.get(elevated.id)!.pinExpiresAt).toBeNull();
  for (const id of [locked.id, expired.id]) {
    expect(after.get(id)!.updatedAt).toEqual(before.get(id)!.updatedAt);
  }
});
