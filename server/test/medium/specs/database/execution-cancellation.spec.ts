import { createPostgres } from '@frameleaf/sql-tools';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { QueueExecution } from 'src/queue/types.js';
import { DatabaseLock } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { VideoMomentRepository } from 'src/repositories/video-moment.repository.js';
import { DATABASE_MAX_WAITERS, boundExecutionReservations, withDatabaseCleanup } from 'src/utils/execution-database.js';
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

it('terminates a real PostgreSQL session when cleanup hangs, releasing its advisory lock before restart', async () => {
  const connection = { connectionType: 'url' as const, url: process.env.IMMICH_TEST_POSTGRES_URL! };
  const restarted = Promise.withResolvers<void>();
  const restart = vi.fn(() => restarted.resolve());
  const client = boundExecutionReservations(createPostgres({ maxConnections: 1, connection }), restart);
  const observer = createPostgres({ maxConnections: 1, connection });
  const key = Math.floor(Math.random() * 2_000_000_000);
  try {
    const reserved = await client.reserve();
    const [{ pid }] = await reserved.unsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
    await reserved.unsafe('SELECT pg_advisory_lock(-333, $1)', [key]);
    const before = await observer.unsafe<{ acquired: boolean }[]>('SELECT pg_try_advisory_lock(-333, $1) AS acquired', [
      key,
    ]);
    expect(before[0].acquired).toBe(false);
    await expect(
      withDatabaseCleanup(async () => {
        await reserved.unsafe('SELECT pg_sleep(20)');
      }),
    ).rejects.toThrow();
    await restarted.promise;
    reserved.release();
    await expect(client.reserve()).rejects.toThrow('requires worker restart');
    // Closing the local socket requests a worker restart; PostgreSQL may observe that close later.
    // Confirm this exact backend has stopped before checking lock release or admitting fresh work.
    await vi.waitFor(
      async () => {
        const [{ count }] = await observer.unsafe<{ count: number }[]>(
          'SELECT count(*)::int AS count FROM pg_stat_activity WHERE pid = $1',
          [pid],
        );
        expect(count).toBe(0);
      },
      { timeout: 1000, interval: 20 },
    );
    const after = await observer.unsafe<{ acquired: boolean }[]>('SELECT pg_try_advisory_lock(-333, $1) AS acquired', [
      key,
    ]);
    expect(after[0].acquired).toBe(true);
    await observer.unsafe('SELECT pg_advisory_unlock(-333, $1)', [key]);
    expect(restart).toHaveBeenCalledOnce();
  } finally {
    await client.end({ timeout: 0 });
    await observer.end({ timeout: 0 });
  }
}, 10_000);

it('bounds real exhausted-pool waiters and releases late grants without executing cancelled work', async () => {
  const connection = { connectionType: 'url' as const, url: process.env.IMMICH_TEST_POSTGRES_URL! };
  const client = boundExecutionReservations(createPostgres({ maxConnections: 1, connection }), vi.fn());
  const controller = new AbortController();
  try {
    const held = await client.reserve();
    const outcomes = queueExecution.run({ signal: controller.signal } as QueueExecution, () =>
      Array.from({ length: DATABASE_MAX_WAITERS }, () =>
        client
          .reserve()
          .then((grant) => {
            grant.release();
            return 'unexpected grant';
          })
          .catch((error: unknown) => (error instanceof Error ? error.message : 'unknown error')),
      ),
    );
    await expect(client.reserve()).rejects.toThrow('Database acquisition capacity exhausted');
    controller.abort(new Error('Attempt cancelled while waiting'));
    expect(await Promise.all(outcomes)).toEqual(
      Array.from({ length: DATABASE_MAX_WAITERS }, () => 'Attempt cancelled while waiting'),
    );
    held.release();
    // The driver's remaining waiters are bounded and each late grant is released automatically.
    // Wait until they drain, without adding another reservation to that queue.
    await vi.waitFor(
      async () => {
        const available = await client.reserve();
        const [{ ok }] = await available.unsafe<{ ok: number }[]>('SELECT 1 AS ok');
        available.release();
        expect(ok).toBe(1);
      },
      { timeout: 5000, interval: 50 },
    );
  } finally {
    await client.end({ timeout: 0 });
  }
}, 10_000);

it('releases global session locks after cancellation, visible from a distinct reserved session', async () => {
  const db = await getKyselyDB();
  const repository = new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());
  const abort = new AbortController();
  try {
    await db.connection().execute(async (observer) => {
      const attempt = queueExecution.run({ signal: abort.signal } as QueueExecution, () =>
        repository.withLock(DatabaseLock.Migrations, () => {
          abort.abort(new Error('Attempt stopped'));
          return Promise.reject(abort.signal.reason);
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
