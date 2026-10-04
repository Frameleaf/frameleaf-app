import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

it('keeps a second recovery worker excluded through database connection termination', async () => {
  const db = await getKyselyDB('fl310_buddy_fence');
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  try {
    // The owner and restore connection survive. A terminated worker needs its own disposable client:
    // postgres.js can return a closed reserved connection to the pool when Kysely releases it.
    await db.connection().execute(async (restore) => {
      const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(restore);
      const url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, database.rows[0].name);
      const withExcludedContender = async (afterProbe: (pid: number) => void | Promise<void>) => {
        const client = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url }));
        try {
          return await client.connection().execute(async (connection) => {
            const contender = new DatabaseRepository(connection, LoggingRepository.create(), new ConfigRepository());
            const attempt = await contender.holdLock(DatabaseLock.MaintenanceOperation);
            try {
              expect(attempt).toBeNull();
              // A live query on the same reserved session rules out null from a connection failure.
              const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection);
              await afterProbe(rows[0].pid);
              return rows[0].pid;
            } finally {
              await attempt?.release();
            }
          });
        } finally {
          // Never send another query through the client after the termination callback.
          await client.destroy();
        }
      };
      const first = await repository.holdLock(DatabaseLock.MaintenanceOperation);
      try {
        expect(first).not.toBeNull();
        const terminatedPid = await withExcludedContender(async (pid) => {
          // The external restore process terminates other sessions, retaining its reserved maintenance owner.
          const { rows } = await sql<{ pid: number; terminated: boolean }>`
            SELECT pid, pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> ${first!.backendPid}
          `.execute(restore);
          expect(rows.length).toBeGreaterThan(0);
          expect(rows).toContainEqual({ pid, terminated: true });
          expect(rows.every((row) => row.terminated && row.pid !== first!.backendPid)).toBe(true);
        });
        expect(await first!.verify()).toBe(true);
        await withExcludedContender((pid) => {
          expect(pid).not.toBe(terminatedPid);
        });
      } finally {
        await first?.release();
      }
      const next = await repository.holdLock(DatabaseLock.MaintenanceOperation);
      try {
        expect(await next?.verify()).toBe(true);
      } finally {
        await next?.release();
      }
    });
  } finally {
    await db.destroy();
  }
});
