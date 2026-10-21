import { Kysely, PostgresDialect } from 'kysely';
import { down, up } from 'src/schema/migrations/2100000003004-ReadOnlyExternalLibraries.js';

function database(protectedLibrary: boolean) {
  const query = vi.fn((statement: string) =>
    Promise.resolve({
      rows: statement.includes('SELECT EXISTS') ? [{ protectedLibrary }] : [],
      rowCount: 0,
    }),
  );
  const db = new Kysely({
    dialect: new PostgresDialect({
      pool: { connect: () => Promise.resolve({ query, release() {} }), async end() {} } as never,
    }),
  });
  return { db, query };
}

it('defaults existing libraries to their legacy policy', async () => {
  const { db, query } = database(false);
  try {
    await up(db);
    expect(query.mock.calls[0][0]).toContain('"readOnly" boolean NOT NULL DEFAULT false');
  } finally {
    await db.destroy();
  }
});

it.each([false, true])('never downgrades an active read-only policy (%s)', async (protectedLibrary) => {
  const { db, query } = database(protectedLibrary);
  try {
    if (protectedLibrary) {
      await expect(down(db)).rejects.toThrow('Cannot discard read-only library protection');
    } else {
      await down(db);
    }
    expect(query.mock.calls[0][0]).toContain('LOCK TABLE "library" IN ACCESS EXCLUSIVE MODE');
    expect(query.mock.calls.some(([statement]) => statement.includes('DROP COLUMN'))).toBe(!protectedLibrary);
  } finally {
    await db.destroy();
  }
});
