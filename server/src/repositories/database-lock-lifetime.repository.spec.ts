import { DatabaseLock } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('serializes callbacks and releases each lock after its result settles', async () => {
  const { db, queries } = scriptedKysely();
  const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, undefined as never);
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<object>();
  const second = vi.fn().mockResolvedValue('second');
  try {
    const first = repository.withLock(DatabaseLock.Migrations, () => {
      started.resolve();
      return result.promise;
    });
    await started.promise;
    const next = repository.withLock(DatabaseLock.Migrations, second);
    expect(second).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => sql)).toEqual(['SELECT pg_advisory_lock($1)']);
    const value = {};
    result.resolve(value);
    await expect(first).resolves.toBe(value);
    await expect(next).resolves.toBe('second');
    expect(queries.map(({ sql }) => sql)).toEqual([
      'SELECT pg_advisory_lock($1)',
      'SELECT pg_advisory_unlock($1)',
      'SELECT pg_advisory_lock($1)',
      'SELECT pg_advisory_unlock($1)',
    ]);
    expect(queries.every(({ parameters }) => parameters[0] === DatabaseLock.Migrations)).toBe(true);
  } finally {
    result.resolve({});
    await db.destroy();
  }
});

it.each(['acquire', 'callback', 'release'] as const)('preserves %s errors and cleanup', async (stage) => {
  const failure = new Error(stage);
  const { db, queries } = scriptedKysely(({ sql }) => {
    if (
      (stage === 'acquire' && sql.includes('pg_advisory_lock')) ||
      (stage === 'release' && sql.includes('pg_advisory_unlock'))
    ) {
      throw failure;
    }
  });
  const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, undefined as never);
  const callback = vi.fn(() => (stage === 'callback' ? Promise.reject(failure) : Promise.resolve()));
  try {
    await expect(repository.withLock(DatabaseLock.Migrations, callback)).rejects.toBe(failure);
    expect(queries.map(({ sql }) => sql)).toEqual(['SELECT pg_advisory_lock($1)', 'SELECT pg_advisory_unlock($1)']);
    expect(callback).toHaveBeenCalledTimes(stage === 'acquire' ? 0 : 1);
  } finally {
    await db.destroy();
  }
});

// FL-648: the boot migration lock waits for a migrating worker without the pool's timeouts, and
// gives the session its timeouts back once the lock is held (or the wait failed).
it.each([false, true])(
  'lifts and restores the session timeouts around an untilFree wait (wait fails: %s)',
  async (fail) => {
    const failure = new Error('connection lost');
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (fail && sql.includes('pg_advisory_lock')) {
        throw failure;
      }
    });
    const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, undefined as never);
    const callback = vi.fn().mockResolvedValue('migrated');
    try {
      const result = repository.withLock(DatabaseLock.Migrations, callback, { untilFree: true });
      await (fail ? expect(result).rejects.toBe(failure) : expect(result).resolves.toBe('migrated'));
      expect(queries.map(({ sql }) => sql)).toEqual([
        'SET lock_timeout = 0',
        'SET statement_timeout = 0',
        'SELECT pg_advisory_lock($1)',
        'RESET lock_timeout',
        'RESET statement_timeout',
        'SELECT pg_advisory_unlock($1)',
      ]);
      expect(callback).toHaveBeenCalledTimes(fail ? 0 : 1);
    } finally {
      await db.destroy();
    }
  },
);
