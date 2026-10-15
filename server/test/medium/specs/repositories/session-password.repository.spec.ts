import { UnauthorizedException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
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

it('holds the password row through insertion and refuses its old value after a concurrent change', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ password: 'checked-hash' });
  const repository = new SessionRepository(db);
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const held = db.transaction().execute(async (trx) => {
    await sql`LOCK TABLE session IN ACCESS EXCLUSIVE MODE`.execute(trx);
    ready.resolve();
    await release.promise;
  });
  void held.catch(ready.reject);
  let creating: ReturnType<SessionRepository['create']> | undefined;
  let changing: Promise<unknown> | undefined;
  try {
    await ready.promise;
    creating = repository.create({ userId: user.id, token: Buffer.alloc(32, 1) }, 'checked-hash');
    void creating.catch((error) => error);
    await vi.waitFor(async () => {
      const result = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE relation='session'::regclass
        AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND mode='RowExclusiveLock' AND NOT granted
      ) AS waiting`.execute(db);
      expect(result.rows[0].waiting).toBe(true);
    });

    changing = db.updateTable('user').set({ password: 'changed-hash' }).where('id', '=', user.id).execute();
    void changing.catch((error) => error);
    await vi.waitFor(async () => {
      const result = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'update "user" set%'
      ) AS waiting`.execute(db);
      expect(result.rows[0].waiting).toBe(true);
    });

    release.resolve();
    await held;
    expect(await creating).toMatchObject({ userId: user.id });
    await changing;
    await expect(
      repository.create({ userId: user.id, token: Buffer.alloc(32, 2) }, 'checked-hash'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    const sessions = await db.selectFrom('session').select('id').where('userId', '=', user.id).execute();
    expect(sessions).toHaveLength(1);
  } finally {
    release.resolve();
    await Promise.allSettled([held, creating, changing]);
  }
});
