import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DatabaseLock } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import type { QueueExecution } from 'src/queue/types.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
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

it('releases global session locks after cancellation, visible from a distinct reserved session', async () => {
  const db = await getKyselyDB();
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  const abort = new AbortController();
  try {
    await db.connection().execute(async (observer) => {
      const attempt = queueExecution.run({ signal: abort.signal } as QueueExecution, () =>
        repository.withLock(DatabaseLock.Migrations, async () => {
          abort.abort(new Error('Attempt stopped'));
          abort.signal.throwIfAborted();
        }),
      );
      await expect(attempt).rejects.toThrow('Attempt stopped');
      const { rows } = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_lock(${DatabaseLock.Migrations}) AS acquired`.execute(observer);
      expect(rows[0].acquired).toBe(true);
      await sql`SELECT pg_advisory_unlock(${DatabaseLock.Migrations})`.execute(observer);
    });
  } finally {
    await db.destroy();
  }
}, 10_000);

it('releases video frame locks after cancellation without permitting further ordinary writes', async () => {
  const db = await getKyselyDB();
  const repository = new VideoMomentRepository(db);
  const abort = new AbortController();
  const assetId = randomUUID();
  try {
    await db.connection().execute(async (observer) => {
      await expect(
        queueExecution.run({ signal: abort.signal } as QueueExecution, () =>
          repository.withFrameLock(assetId, async () => {
            abort.abort(new Error('Frame extraction stopped'));
            await sql`SELECT 1`.execute(db);
          }),
        ),
      ).rejects.toThrow('Frame extraction stopped');
      const { rows } = await sql<{
        acquired: boolean;
      }>`SELECT pg_try_advisory_lock(-59, hashtext(${assetId})::int) AS acquired`.execute(observer);
      expect(rows[0].acquired).toBe(true);
      await sql`SELECT pg_advisory_unlock(-59, hashtext(${assetId})::int)`.execute(observer);
    });
  } finally {
    await db.destroy();
  }
}, 10_000);
