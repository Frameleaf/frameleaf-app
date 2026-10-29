import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { randomUUID } from 'node:crypto';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

// FL-646: the pool's session lock_timeout (5 s, the createPostgres default) also cancels advisory-lock waits. A worker
// that waited longer than that for another worker's first migration failed to start with "canceling statement due to
// lock timeout" (55P03).
const HOLD_MS = 7000;

/** One session with the production pool's defaults, so the session withLock reserves is the one checked afterwards. */
const singleSession = (suffix: string) => {
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/frameleaf_${suffix}`;
  return new Kysely<DB>({
    dialect: new PostgresJSDialect({
      postgres: createPostgres({ maxConnections: 1, connection: { connectionType: 'url', url: url.href } }),
    }),
  });
};

it('waits a full timeout and more for the migration lock, then restores the timeout on its session', async () => {
  const suffix = randomUUID().replaceAll('-', '');
  const db = await getKyselyDB(suffix);
  const session = singleSession(suffix);
  const repository = new DatabaseRepository(session, LoggingRepository.create(), new ConfigRepository());
  try {
    await db.connection().execute(async (holder) => {
      await sql`SELECT pg_advisory_lock(${DatabaseLock.Migrations})`.execute(holder);

      // Without the change, this is what every waiting worker did: the pool default gives up after 5 s.
      await expect(sql`SELECT pg_advisory_lock(${DatabaseLock.Migrations})`.execute(session)).rejects.toMatchObject({
        code: '55P03',
      });

      // The hold starts only now, so withLock alone has to wait longer than the pool's lock_timeout.
      let released = false;
      const release = setTimeout(() => {
        released = true;
        void sql`SELECT pg_advisory_unlock(${DatabaseLock.Migrations})`.execute(holder);
      }, HOLD_MS);
      try {
        const startedAt = Date.now();
        await repository.withLock(DatabaseLock.Migrations, () => {
          expect(released).toBe(true);
          return Promise.resolve();
        });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(HOLD_MS - 100);
      } finally {
        clearTimeout(release);
      }
    });

    // withLock reserved the only session; it must be back on the pool default.
    const { rows } = await sql<{ lock_timeout: string }>`SHOW lock_timeout`.execute(session);
    expect(rows[0].lock_timeout).toBe('5s');
  } finally {
    await session.destroy();
    await db.destroy();
  }
}, 30_000);
