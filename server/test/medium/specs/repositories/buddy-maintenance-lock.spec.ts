import { sql } from 'kysely';
import { DatabaseLock } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { getKyselyDB } from 'test/utils.js';

it('keeps a second recovery worker excluded through database connection termination', async () => {
  const db = await getKyselyDB('fl310_buddy_fence');
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  const first = await repository.holdLock(DatabaseLock.MaintenanceOperation);
  expect(first).not.toBeNull();
  try {
    expect(await repository.holdLock(DatabaseLock.MaintenanceOperation)).toBeNull();
    // The external restore process terminates other sessions, retaining its reserved maintenance owner.
    await sql`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database()
      AND pid <> pg_backend_pid() AND pid <> ${first!.backendPid}`.execute(db);
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
