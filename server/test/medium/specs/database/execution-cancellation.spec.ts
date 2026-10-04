import { sql } from 'kysely';
import { queueExecution } from 'src/queue/context.js';
import type { QueueExecution } from 'src/queue/types.js';
import { getKyselyDB } from 'test/utils.js';

it('cancels underlying PostgreSQL work and rolls back before reusing its connection', async () => {
  const db = await getKyselyDB();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    await sql`CREATE TABLE cancellation_probe (id integer PRIMARY KEY)`.execute(db);
    const execution = queueExecution.run({ signal: controller.signal } as QueueExecution, () =>
      db.transaction().execute(async (tx) => {
        await sql`INSERT INTO cancellation_probe VALUES (1)`.execute(tx);
        timer = setTimeout(() => controller.abort(new Error('Stopped attempt')), 100);
        await sql`SELECT pg_sleep(20)`.execute(tx);
      }),
    );
    await expect(execution).rejects.toThrow();
    const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count FROM cancellation_probe`.execute(db);
    expect(rows[0].count).toBe('0');
    const waiting = await sql<{ count: string }>`SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active' AND query = 'SELECT pg_sleep(20)'`.execute(db);
    expect(waiting.rows[0].count).toBe('0');
  } finally {
    clearTimeout(timer);
    await db.destroy();
  }
}, 10_000);
