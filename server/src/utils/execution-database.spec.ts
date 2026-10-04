import type { createPostgres } from '@frameleaf/sql-tools';
import type { QueueExecution } from 'src/queue/types.js';
import { queueExecution } from 'src/queue/context.js';
import {
  DATABASE_ACQUIRE_TIMEOUT_MS,
  boundExecutionReservations,
  withDatabaseCleanup,
} from 'src/utils/execution-database.js';

describe('bounded execution database reservations', () => {
  afterEach(() => vi.useRealTimers());

  it('returns a reservation granted after acquisition timed out without ever running SQL', async () => {
    vi.useFakeTimers();
    const { promise, resolve: grant } = Promise.withResolvers<unknown>();
    const release = vi.fn();
    const unsafe = vi.fn();
    const client = boundExecutionReservations({
      reserve: () => promise,
    } as unknown as ReturnType<typeof createPostgres>);
    const refused = expect(client.reserve()).rejects.toThrow('Database acquisition timed out');
    await vi.advanceTimersByTimeAsync(DATABASE_ACQUIRE_TIMEOUT_MS);
    await refused;
    grant({ release, unsafe });
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(unsafe).not.toHaveBeenCalled();
  });

  it('aborts a queued reservation and releases its late connection', async () => {
    const { promise, resolve: grant } = Promise.withResolvers<unknown>();
    const release = vi.fn();
    const client = boundExecutionReservations({
      reserve: () => promise,
    } as unknown as ReturnType<typeof createPostgres>);
    const abort = new AbortController();
    const reservation = queueExecution.run({ signal: abort.signal } as QueueExecution, () => client.reserve());
    abort.abort(new Error('Execution cancelled'));
    await expect(reservation).rejects.toThrow('Execution cancelled');
    grant({ release, unsafe: vi.fn() });
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs explicit cleanup after cancellation while refusing ordinary queries', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();
    const release = vi.fn();
    const unsafe = vi.fn(() => Promise.resolve([]));
    const client = boundExecutionReservations(
      {
        reserve: () => Promise.resolve({ release, unsafe }),
        end,
      } as unknown as ReturnType<typeof createPostgres>,
      restart,
    );
    const connection = await client.reserve();
    const abort = new AbortController();
    abort.abort(new Error('Attempt stopped'));
    await queueExecution.run({ signal: abort.signal } as QueueExecution, async () => {
      await expect(Promise.resolve(connection.unsafe('SELECT 1'))).rejects.toThrow('Attempt stopped');
      await withDatabaseCleanup(async () => {
        await connection.unsafe('SELECT pg_advisory_unlock(9)');
      });
    });
    connection.release();
    expect(release).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('closes the pool before a failed cleanup can release its session', async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const restart = vi.fn();
    const release = vi.fn();
    const client = boundExecutionReservations(
      {
        reserve: () => Promise.resolve({ release, unsafe: () => Promise.reject(new Error('Cleanup failed')) }),
        end,
      } as unknown as ReturnType<typeof createPostgres>,
      restart,
    );
    const connection = await client.reserve();
    await expect(
      withDatabaseCleanup(async () => {
        await connection.unsafe('SELECT pg_advisory_unlock(9)');
      }),
    ).rejects.toThrow('Cleanup failed');
    connection.release();
    expect(end).toHaveBeenCalledWith({ timeout: 0 });
    expect(release).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledOnce();
    await expect(client.reserve()).rejects.toThrow('requires worker restart');
  });
});
