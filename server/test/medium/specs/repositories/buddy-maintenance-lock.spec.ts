import { sql } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

it('keeps a second recovery worker excluded through database connection termination', async () => {
  const db = await getKyselyDB('fl310_buddy_fence');
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  try {
    // Reserve the external restore connection before contention. A failed holdLock resolves before
    // its pool release; acquiring the terminator then can start an extra postgres.js type query
    // that the termination statement kills while it is still initializing.
    await db.connection().execute(async (restore) => {
      const first = await repository.holdLock(DatabaseLock.MaintenanceOperation);
      try {
        expect(first).not.toBeNull();
        expect(await repository.holdLock(DatabaseLock.MaintenanceOperation)).toBeNull();
        // The external restore process terminates other sessions, retaining its reserved maintenance owner.
        const { rows } = await sql<{ pid: number; terminated: boolean }>`
          SELECT pid, pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid() AND pid <> ${first!.backendPid}
        `.execute(restore);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.terminated && row.pid !== first!.backendPid)).toBe(true);
        expect(await first!.verify()).toBe(true);
        expect(await repository.holdLock(DatabaseLock.MaintenanceOperation)).toBeNull();
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
