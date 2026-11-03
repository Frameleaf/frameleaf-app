import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { withLibraryImportExecution } from 'src/library-import/execution-binding.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let connection: ReturnType<typeof connectImportDatabase>;
const input = () => ({
  binding: {
    operationId: randomUUID(),
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: fixture.plan.source,
  },
  destinationId: randomUUID(),
  identity: { database: { device: '1', inode: '2' }, lock: { device: '1', inode: '3' } },
});
beforeAll(async () => {
  db = await getKyselyDB();
  const {
    rows: [row],
  } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${row.name}`;
  connection = connectImportDatabase(url.href, false);
});
beforeEach(async () => {
  await sql`DELETE FROM system_metadata WHERE key='frameleaf-library-import-execution'`.execute(db);
});
afterAll(async () => {
  await connection?.close();
  await db?.destroy();
});

it('retains destination identity and refuses another journal or operation', async () => {
  const value = input();
  const first = await withLibraryImportExecution(connection.db, value, (nonce) => Promise.resolve(nonce));
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(await withLibraryImportExecution(connection.db, value, (nonce) => Promise.resolve(nonce))).toBe(first);
  await expect(
    withLibraryImportExecution(
      connection.db,
      {
        ...value,
        identity: { ...value.identity, lock: { device: '1', inode: '4' } },
      },
      async () => {},
    ),
  ).rejects.toThrow('IMPORT_EXECUTION_IDENTITY_CHANGED');
  await expect(withLibraryImportExecution(connection.db, input(), async () => {})).rejects.toThrow(
    'IMPORT_EXECUTION_IDENTITY_CHANGED',
  );
});

it('assigns a distinct nonce when the same local journal is pointed at another fresh database', async () => {
  const other = await getKyselyDB();
  const {
    rows: [row],
  } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(other);
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${row.name}`;
  const target = connectImportDatabase(url.href, false);
  try {
    const value = input();
    const original = await withLibraryImportExecution(connection.db, value, (nonce) => Promise.resolve(nonce));
    expect(await withLibraryImportExecution(target.db, value, (nonce) => Promise.resolve(nonce))).not.toBe(original);
  } finally {
    await target.close();
    await other.destroy();
  }
});

it('keeps concurrent commands out and releases the session after failure', async () => {
  const value = input();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const owner = withLibraryImportExecution(connection.db, value, async () => {
    entered.resolve();
    await release.promise;
    throw new Error('synthetic command interruption');
  });
  const observed = owner.catch((error: unknown) => error);
  await entered.promise;
  try {
    await expect(withLibraryImportExecution(connection.db, value, async () => {})).rejects.toThrow(
      'IMPORT_ALREADY_RUNNING',
    );
  } finally {
    release.resolve();
  }
  expect(await observed).toMatchObject({ message: 'synthetic command interruption' });
  await withLibraryImportExecution(connection.db, value, async () => {});
});

it('refuses corrupted retained executor identity instead of replacing it', async () => {
  await sql`INSERT INTO system_metadata(key,value) VALUES('frameleaf-library-import-execution','{}'::jsonb)`.execute(
    db,
  );
  await expect(withLibraryImportExecution(connection.db, input(), async () => {})).rejects.toThrow(
    'IMPORT_EXECUTION_IDENTITY_INVALID',
  );
});
