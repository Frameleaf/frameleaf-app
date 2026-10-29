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
