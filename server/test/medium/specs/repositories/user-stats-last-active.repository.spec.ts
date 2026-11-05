import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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
