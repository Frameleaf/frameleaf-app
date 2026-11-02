import { CompiledQuery, Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { assertFreshImportDestination } from 'src/library-import/admission.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { LibraryImportJournal } from 'src/library-import/state.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003043-LibraryImportJournal.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const wrap = (connection: Kysely<any>): ImportDatabase => ({
  query: async (statement, parameters = []) =>
    (await connection.executeQuery(CompiledQuery.raw(statement, parameters))).rows as Record<string, unknown>[],
  transaction: (body) => connection.transaction().execute((tx) => body(wrap(tx))),
});
const binding = () => ({
  operationId: randomUUID(),
  manifestSha256: 'a'.repeat(64),
  planSha256: 'b'.repeat(64),
  source: {
    kind: 'photoview',
    version: '2.4.0',
    identity: 'synthetic-library',
    revision: 'frozen-1',
    schemaSha256: 'c'.repeat(64),
  },
});
const mapping = () => ({
  kind: 'asset',
  sourceId: 'source-photo',
  destinationId: randomUUID(),
  recordSha256: 'd'.repeat(64),
});
const journal = () => new LibraryImportJournal(wrap(db));
const gate = () => new DatabaseRepository(db, LoggingRepository.create(), new ConfigRepository());

beforeAll(async () => {
  db = await getKyselyDB();
  await sql`CREATE TABLE public.import_probe (id uuid PRIMARY KEY, payload text NOT NULL)`.execute(db);
});
beforeEach(async () => {
  await sql`TRUNCATE public.frameleaf_library_import_mapping,public.frameleaf_library_import,public.frameleaf_immich_import,public.import_probe`.execute(
    db,
  );
});
afterAll(async () => db?.destroy());

it('retains binding and mappings after reconnect and does not replay a committed destination write', async () => {
  const input = binding(),
    item = mapping();
  await expect(journal().begin(input)).resolves.toMatchObject({ binding: input, status: 'copying' });
  const write = vi.fn(async (tx: ImportDatabase, id: string) => {
    await tx.query('INSERT INTO public.import_probe VALUES($1::uuid,$2)', [id, 'manual metadata']);
  });
  await journal().apply(input, item, write);
  const {
    rows: [identity],
  } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  await db.destroy();
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${identity.name}`;
  db = new Kysely<DB>(getKyselyConfig({ connectionType: 'url', url: url.href }));
  await expect(journal().begin(input)).resolves.toMatchObject({ status: 'copying' });
  await expect(journal().apply(input, item, write)).resolves.toBe(item.destinationId);
  expect(write).toHaveBeenCalledOnce();
  expect((await sql`SELECT * FROM public.import_probe`.execute(db)).rows).toEqual([
    { id: item.destinationId, payload: 'manual metadata' },
  ]);
  await expect(journal().status()).resolves.toEqual({
    run: { binding: input, status: 'copying' },
    mappings: [{ kind: 'asset', count: '1' }],
  });
});

it('rolls back destination data with an interrupted mapping transaction', async () => {
  const input = binding(),
    item = mapping();
  await journal().begin(input);
  await expect(
    journal().apply(input, item, async (tx, id) => {
      await tx.query('INSERT INTO public.import_probe VALUES($1::uuid,$2)', [id, 'partial']);
      throw new Error('synthetic interruption before mapping commit');
    }),
  ).rejects.toThrow('synthetic interruption');
  expect((await sql`SELECT * FROM public.import_probe`.execute(db)).rows).toEqual([]);
  expect((await journal().status()).mappings).toEqual([]);
  await expect(
    journal().apply(input, item, async (tx, id) => {
      await tx.query('INSERT INTO public.import_probe VALUES($1::uuid,$2)', [id, 'complete']);
    }),
  ).resolves.toBe(item.destinationId);
});

it('refuses changed bindings and mapping identities before touching destination content', async () => {
  const input = binding(),
    item = mapping(),
    write = vi.fn().mockResolvedValue(undefined);
  await journal().begin(input);
  for (const changed of [
    { ...input, manifestSha256: 'e'.repeat(64) },
    { ...input, planSha256: 'e'.repeat(64) },
    { ...input, source: { ...input.source, revision: 'changed' } },
  ])
    await expect(journal().apply(changed, item, write)).rejects.toThrow('IMPORT_BINDING_CHANGED');
  expect(write).not.toHaveBeenCalled();
  await journal().apply(input, item, write);
  for (const changed of [
    { ...item, destinationId: randomUUID() },
    { ...item, recordSha256: 'e'.repeat(64) },
  ])
    await expect(journal().apply(input, changed, write)).rejects.toThrow('IMPORT_MAPPING_CHANGED');
  expect(write).toHaveBeenCalledOnce();
});

it('rejects unexpected credential fields, malformed mappings and activation requests before effects', async () => {
  const input = binding(),
    write = vi.fn();
  await expect(
    journal().begin({ ...input, source: { ...input.source, password: 'synthetic-secret' } }),
  ).rejects.toThrow('INVALID_IMPORT_BINDING');
  expect((await journal().status()).run).toBeNull();
  await journal().begin(input);
  for (const item of [
    { ...mapping(), sourceId: '' },
    { ...mapping(), destinationId: 'invalid' },
    { ...mapping(), recordSha256: 'invalid' },
  ])
    await expect(journal().apply(input, item, write)).rejects.toThrow('INVALID_IMPORT_MAPPING');
  await expect(journal().phase(input, 'activated' as never)).rejects.toThrow('INVALID_IMPORT_PHASE');
  expect(write).not.toHaveBeenCalled();
  expect((await journal().status()).mappings).toEqual([]);
});

it('serializes competing writers with the exact lock used by import-immich', async () => {
  const input = binding();
  await db.connection().execute(async (connection) => {
    await sql`SELECT pg_advisory_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(connection);
    try {
      await expect(journal().begin(input)).rejects.toThrow('IMPORT_ALREADY_RUNNING');
    } finally {
      await sql`SELECT pg_advisory_unlock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(connection);
    }
  });
  expect((await journal().status()).run).toBeNull();
  await journal().begin(input);
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const first = journal().apply(input, mapping(), async () => {
    started.resolve();
    await release.promise;
  });
  try {
    await started.promise;
    const write = vi.fn();
    await expect(journal().apply(input, mapping(), write)).rejects.toThrow('IMPORT_ALREADY_RUNNING');
    expect(write).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await first;
  }
});

it('keeps partial and abandoned imports fenced and retains all recovery mappings', async () => {
  const input = binding();
  await expect(gate().assertImportActivated()).resolves.toBeUndefined();
  await journal().begin(input);
  await journal().apply(input, mapping(), async () => {});
  await expect(gate().assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  await expect(assertFreshImportDestination(wrap(db))).rejects.toThrow('DESTINATION_NOT_FRESH');
  await journal().phase(input, 'verifying');
  await expect(gate().assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  await expect(journal().apply(input, mapping(), async () => {})).rejects.toThrow('IMPORT_NOT_COPYING');
  await journal().phase(input, 'abandoned');
  await journal().phase(input, 'abandoned');
  await expect(gate().assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  await expect(journal().begin(input)).rejects.toThrow('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
  expect((await journal().status()).mappings).toEqual([{ kind: 'asset', count: '1' }]);
});

it('rejects nonempty destinations and every existing Immich import journal', async () => {
  await sql`INSERT INTO public.import_probe VALUES(${randomUUID()}::uuid,'unrelated content')`.execute(db);
  await expect(journal().begin(binding())).rejects.toThrow('DESTINATION_NOT_FRESH');
  await sql`TRUNCATE public.import_probe`.execute(db);
  await sql`INSERT INTO public.frameleaf_immich_import(source_fingerprint,config_fingerprint,source_version,status) VALUES('source','config','3.2.4','activated')`.execute(
    db,
  );
  await expect(journal().begin(binding())).rejects.toThrow('DESTINATION_ALREADY_IMPORTED');
  expect((await journal().status()).run).toBeNull();
});

it('refuses downgrade while recovery records exist and supports down/up on an empty journal', async () => {
  const input = binding();
  await journal().begin(input);
  await expect(down(db)).rejects.toThrow('recovery records must be retained');
  expect((await journal().status()).run?.binding).toEqual(input);
  await sql`TRUNCATE public.frameleaf_library_import_mapping,public.frameleaf_library_import`.execute(db);
  await down(db);
  await up(db);
  await expect(journal().begin(input)).resolves.toMatchObject({ status: 'copying' });
});
