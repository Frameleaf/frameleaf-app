import type { createPostgres } from '@frameleaf/sql-tools';
import { queueExecution } from 'src/queue/context.js';
import type { QueueExecution } from 'src/queue/types.js';
import { boundExecutionReservations, DATABASE_ACQUIRE_TIMEOUT_MS } from 'src/utils/execution-database.js';

describe('bounded execution database reservations', () => {
  afterEach(() => vi.useRealTimers());

  it('returns a reservation granted after acquisition timed out without ever running SQL', async () => {
    vi.useFakeTimers();
    let grant!: (value: unknown) => void;
    const release = vi.fn();
    const unsafe = vi.fn();
    const client = boundExecutionReservations({
      reserve: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
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
    let grant!: (value: unknown) => void;
    const release = vi.fn();
    const client = boundExecutionReservations({
      reserve: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    } as unknown as ReturnType<typeof createPostgres>);
    const abort = new AbortController();
    const reservation = queueExecution.run({ signal: abort.signal } as QueueExecution, () => client.reserve());
    abort.abort(new Error('Execution cancelled'));
    await expect(reservation).rejects.toThrow('Execution cancelled');
    grant({ release, unsafe: vi.fn() });
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
  });
});
