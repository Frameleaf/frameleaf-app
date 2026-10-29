import { sql } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

// FL-646: the pool's session lock_timeout (5 s) also cancels advisory-lock waits. A worker that waited longer than that
// for another worker's first migration failed to start with "canceling statement due to lock timeout" (55P03).
const HOLD_MS = 6500;

it('waits past the pool lock_timeout for the migration lock, then restores the timeout', async () => {
  const db = await getKyselyDB();
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  try {
    await db.connection().execute(async (holder) => {
      await sql`SELECT pg_advisory_lock(${DatabaseLock.Migrations})`.execute(holder);
      let released = false;
      const release = setTimeout(() => {
        released = true;
        void sql`SELECT pg_advisory_unlock(${DatabaseLock.Migrations})`.execute(holder);
      }, HOLD_MS);
      try {
        // Without the change, this is what every waiting worker did: the pool default gives up after 5 s.
        await expect(
          db.connection().execute((waiter) => sql`SELECT pg_advisory_lock(${DatabaseLock.Migrations})`.execute(waiter)),
        ).rejects.toMatchObject({ code: '55P03' });

        const timeouts = await repository.withLock(DatabaseLock.Migrations, async () => {
          expect(released).toBe(true);
          const { rows } = await sql<{ lock_timeout: string }>`SHOW lock_timeout`.execute(db);
          return rows.map((row) => row.lock_timeout);
        });
        expect(timeouts).toEqual(['5s']);
      } finally {
        clearTimeout(release);
      }
    });
  } finally {
    await db.destroy();
  }
}, 30_000);
