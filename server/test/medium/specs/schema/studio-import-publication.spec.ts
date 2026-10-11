import { schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DB } from 'src/schema/index.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { DECLARATION, KEY, PREPARED } from 'test/fixtures/studio-import-retention.js';
import { getLibraryQueueDB as createRetentionTestDatabase } from 'test/medium/library-queue-database.js';

let db: Kysely<DB>;
const createdAt = new Date('2026-10-10T00:00:00.000Z');
const expiresAt = new Date(createdAt.getTime() + 6 * 60 * 60 * 1000);
const ownedFields = {
  stagedPath: PREPARED.stagedPath,
  targetPath: PREPARED.targetPath,
  declaration: DECLARATION,
  stagedIdentity: PREPARED.identity,
};

const insertPublication = (
  overrides: Partial<{
    id: string;
    importId: string;
    state: string;
    stagedPath: string | null;
    targetPath: string | null;
    declaration: unknown;
    stagedIdentity: unknown;
    expiresAt: Date;
  }> = {},
) => {
  const row = {
    id: randomUUID(),
    importId: randomUUID(),
    state: 'registered',
    stagedPath: null,
    targetPath: null,
    declaration: null,
    stagedIdentity: null,
    expiresAt,
    ...overrides,
  };
  return sql`INSERT INTO public.studio_import_publication
    (id, "ownerId", "projectId", "importId", state, "stagedPath", "targetPath", declaration,
     "stagedIdentity", "createdAt", "expiresAt")
    VALUES (${row.id}::uuid, ${KEY.ownerId}::uuid, ${KEY.projectId}::uuid, ${row.importId}::uuid,
      ${row.state}, ${row.stagedPath}, ${row.targetPath},
      ${row.declaration === null ? null : JSON.stringify(row.declaration)}::jsonb,
      ${row.stagedIdentity === null ? null : JSON.stringify(row.stagedIdentity)}::jsonb,
      ${createdAt}, ${row.expiresAt})`.execute(db);
};

beforeAll(async () => {
  db = await createRetentionTestDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

it('stores a legacy import with null processing lineage', async () => {
  const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }>`
    SELECT column_name, data_type, is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'studio_project_import'
      AND column_name = 'processingProvenance'
  `.execute(db);
  expect(columns.rows).toEqual([{ column_name: 'processingProvenance', data_type: 'jsonb', is_nullable: 'YES' }]);
  const stored = await sql<{ processingProvenance: unknown }>`
    INSERT INTO public.studio_project_import
      (id, "ownerId", "projectId", checksum, "contentType", "sizeBytes", path, "fileName")
    VALUES (${KEY.importId}::uuid, ${KEY.ownerId}::uuid, ${KEY.projectId}::uuid,
      ${DECLARATION.checksum}, ${DECLARATION.contentType}, ${DECLARATION.sizeBytes},
      ${PREPARED.targetPath}, ${DECLARATION.fileName})
    RETURNING "processingProvenance"
  `.execute(db);
  expect(stored.rows).toEqual([{ processingProvenance: null }]);
});

it.each([
  ['state', { state: 'unknown' }, 'studio_import_publication_state_check'],
  ['expiry', { expiresAt: new Date(expiresAt.getTime() + 1) }, 'studio_import_publication_expiry_check'],
  ['partial file handles', { stagedPath: PREPARED.stagedPath }, 'studio_import_publication_file_fields_check'],
  ['registered file ownership', ownedFields, 'studio_import_publication_registered_check'],
  ['preparing without handles', { state: 'preparing' }, 'studio_import_publication_preparing_check'],
  [
    'nonobject declaration',
    { state: 'preparing', ...ownedFields, declaration: [] },
    'studio_import_publication_declaration_check',
  ],
  [
    'nonobject identity',
    { state: 'preparing', ...ownedFields, stagedIdentity: [] },
    'studio_import_publication_identity_check',
  ],
] as const)('rejects %s through its exact schema check', async (_label, fields, constraint) => {
  await expect(insertPublication(fields)).rejects.toMatchObject({ code: '23514', constraint_name: constraint });
});

it('allows multiple registered receipts without a file reservation, even alongside a prepared intent', async () => {
  const importId = randomUUID();
  await insertPublication({ importId });
  await insertPublication({ importId });
  await insertPublication({ importId, state: 'preparing', ...ownedFields });
  await insertPublication({ importId });
  const registered = await sql<{ count: number }>`
    SELECT count(*)::integer AS count FROM public.studio_import_publication
    WHERE "projectId" = ${KEY.projectId}::uuid AND "importId" = ${importId}::uuid AND state = 'registered'
      AND "stagedPath" IS NULL AND "targetPath" IS NULL AND declaration IS NULL AND "stagedIdentity" IS NULL
  `.execute(db);
  expect(registered.rows).toEqual([{ count: 3 }]);
});

it('keeps a publication ID unique even without file handles', async () => {
  const id = randomUUID();
  await insertPublication({ id });
  await expect(insertPublication({ id })).rejects.toMatchObject({
    code: '23505',
    constraint_name: 'studio_import_publication_pkey',
  });
});

it.each(['preparing', 'published', 'aborted'])('reserves an import until a %s intent is cleaned', async (state) => {
  const importId = randomUUID();
  const id = randomUUID();
  await insertPublication({ id, importId, state, ...ownedFields });
  await expect(insertPublication({ importId, state: 'preparing', ...ownedFields })).rejects.toMatchObject({
    code: '23505',
    constraint_name: 'studio_import_publication_active_import',
  });
  const terminalState = state === 'preparing' ? 'aborted' : state;
  await sql`UPDATE public.studio_import_publication SET state = ${terminalState}, "stagedPath" = NULL,
    "targetPath" = NULL, declaration = NULL, "stagedIdentity" = NULL WHERE id = ${id}::uuid`.execute(db);
  await insertPublication({ importId, state: 'preparing', ...ownedFields });
  const receipt = await sql<{ state: string }>`SELECT state FROM public.studio_import_publication
    WHERE id = ${id}::uuid`.execute(db);
  expect(receipt.rows).toEqual([{ state: terminalState }]);
});

it('indexes owner/project discovery and never cascades away pending handles', async () => {
  const indexes = await sql<{ indexname: string; indexdef: string }>`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'studio_import_publication'
  `.execute(db);
  expect(indexes.rows.find(({ indexname }) => indexname === 'studio_import_publication_discovery')?.indexdef)
    .toContain('("ownerId", "projectId", "createdAt", id)');
  const cascades = await sql<{ conname: string }>`SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.studio_import_publication'::regclass AND contype = 'f' AND confdeltype = 'c'`.execute(db);
  expect(cascades.rows).toEqual([]);
});

it('reads the real migrated catalog without warnings or desired-schema drift', async () => {
  const name = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows[0].name;
  const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  endpoint.pathname = `/${name}`;
  const catalog = await schemaFromDatabase({
    connection: { connectionType: 'url', url: endpoint.href },
    maxConnections: 1,
    connectTimeoutSeconds: 5,
    statementTimeoutMs: 5000,
    lockTimeoutMs: 3000,
    overrides: false,
    excludeMigrationTables: true,
  });
  expect(catalog.warnings).toEqual([]);
  expect(
    catalog.tables.find(({ name }) => name === 'studio_import_publication')?.columns.map(({ name }) => name).sort(),
  ).toEqual([
    'createdAt',
    'declaration',
    'expiresAt',
    'id',
    'importId',
    'ownerId',
    'projectId',
    'stagedIdentity',
    'stagedPath',
    'state',
    'targetPath',
  ].sort());
  expect(
    schemaDiff(getFrameleafSchema(), catalog, {
      parameters: { ignoreExtra: true },
      extensions: { ignoreExtra: true },
    }).asSql(),
  ).toEqual([]);
});
