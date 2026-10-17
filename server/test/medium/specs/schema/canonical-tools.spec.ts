import { Migrator as CliMigrator, createMigrationProvider, schemaDiff, schemaFromDatabase } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { getKyselyConfig } from 'src/utils/database.js';

// Real hosted PostgreSQL: this catches information lost by the schema reader and generation renderer.
describe('canonical SQL tools on PostgreSQL', () => {
  let admin: ReturnType<typeof postgres>;
  let db: Kysely<any>;
  let url: string;
  const name = `canonical_tools_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    endpoint.pathname = '/postgres';
    admin = postgres(endpoint.href, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    endpoint.pathname = `/${name}`;
    url = endpoint.href;
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url }));
    await sql`CREATE EXTENSION vector`.execute(db);
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
  const read = () => schemaFromDatabase({ connection: { connectionType: 'url', url }, overrides: false });

  it('reads each enum column once and retains declared enum ordering', async () => {
    await sql
      .raw(
        `
      CREATE TYPE catalog_state AS ENUM ('waiting', 'completed');
      ALTER TYPE catalog_state ADD VALUE 'active' BEFORE 'completed';
      CREATE TABLE catalog_enum (id integer, state catalog_state, history catalog_state[]);
    `,
      )
      .execute(db);
    const schema = await read();
    expect(schema.warnings).toEqual([]);
    const table = schema.tables.find((table) => table.name === 'catalog_enum')!;
    expect(table.columns.map(({ name }) => name).sort()).toEqual(['history', 'id', 'state']);
    expect(table.columns.find(({ name }) => name === 'state')).toMatchObject({
      type: 'enum',
      enumName: 'catalog_state',
    });
    expect(table.columns.find(({ name }) => name === 'history')).toMatchObject({
      type: 'enum',
      enumName: 'catalog_state',
      isArray: true,
    });
    expect(schema.enums.find(({ name }) => name === 'catalog_state')?.values).toEqual([
      'waiting',
      'active',
      'completed',
    ]);
  });

  it('captures and restores vector dimensions, CHECK bodies, deferred FKs, expression indexes and multi-event triggers', async () => {
    await sql
      .raw(
        `
      CREATE TABLE catalog_parent (id integer PRIMARY KEY);
      CREATE TABLE catalog_identity (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      CREATE TABLE catalog_serial (id bigserial PRIMARY KEY);
      CREATE TABLE catalog_child (
        id integer PRIMARY KEY, parent_id integer, label text, embedding vector(768),
        CONSTRAINT child_positive CHECK (id > 0),
        CONSTRAINT child_parent FOREIGN KEY (parent_id) REFERENCES catalog_parent(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE UNIQUE INDEX catalog_expression ON catalog_child (parent_id, (coalesce(label, ''))) WHERE label IS NOT NULL;
      CREATE FUNCTION catalog_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER catalog_change BEFORE INSERT OR UPDATE OF label ON catalog_child FOR EACH ROW EXECUTE FUNCTION catalog_trigger();
    `,
      )
      .execute(db);
    const desired = await read();
    expect(desired.warnings).toEqual([]);
    expect(desired.tables.find((table) => table.name === 'catalog_identity')!.columns[0]).toMatchObject({
      identity: true,
      identityMode: 'always',
    });
    expect(desired.sequences!.find((sequence) => sequence.name === 'catalog_serial_id_seq')).toMatchObject({
      max: '9223372036854775807',
      identity: false,
      owner: { tableName: 'catalog_serial', columnName: 'id' },
    });
    const child = desired.tables.find((table) => table.name === 'catalog_child')!;
    expect(child.columns.find((column) => column.name === 'embedding')).toMatchObject({ type: 'vector', length: 768 });
    expect(child.constraints.find((constraint) => constraint.name === 'child_parent')?.definition).toContain(
      'DEFERRABLE INITIALLY DEFERRED',
    );
    expect(child.triggers[0].actions).toEqual(['insert', 'update']);
    expect(child.triggers[0].definition).toContain('UPDATE OF label');
    expect(child.indexes[0].definition).toContain('COALESCE');

    await sql
      .raw(
        `
      ALTER SEQUENCE catalog_serial_id_seq CACHE 7;
      DROP TABLE catalog_identity;
      DROP TABLE catalog_serial;
      ALTER TABLE catalog_child DROP CONSTRAINT child_positive;
      ALTER TABLE catalog_child ADD CONSTRAINT child_positive CHECK (id >= 0);
      ALTER TABLE catalog_child ALTER CONSTRAINT child_parent NOT DEFERRABLE;
      DROP INDEX catalog_expression;
      CREATE INDEX catalog_expression ON catalog_child (label);
      DROP TRIGGER catalog_change ON catalog_child;
      CREATE TRIGGER catalog_change BEFORE INSERT ON catalog_child FOR EACH ROW EXECUTE FUNCTION catalog_trigger();
    `,
      )
      .execute(db);
    const drift = schemaDiff(desired, await read());
    for (const type of [
      'ConstraintDrop',
      'ConstraintAdd',
      'IndexDrop',
      'IndexCreate',
      'TriggerDrop',
      'TriggerCreate',
      'SequenceCreate',
      'SequenceOwnership',
    ]) {
      expect(drift.items.some((item) => item.type === type)).toBe(true);
    }
    for (const statement of drift.asSql()) await sql.raw(statement).execute(db);
    expect(schemaDiff(desired, await read()).items).toEqual([]);
    await sql`ALTER TABLE catalog_child ALTER COLUMN embedding TYPE vector(512)`.execute(db);
    expect(schemaDiff(desired, await read()).items.some((item) => item.type === 'ColumnDrop')).toBe(true);
  });

  it('appends a migration through CLI and subsequently boots through the runtime provider without replay', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-chain-'));
    const first = '0000000000000-FixtureBaseline';
    const second = '0000000000001-FixtureNext';
    const runtime = () =>
      new Migrator({
        db,
        migrationTableName: 'frameleaf_migrations',
        migrationLockTableName: 'frameleaf_migrations_lock',
        provider: createMigrationProvider(folder),
      });
    try {
      await writeFile(join(folder, 'package.json'), '{"type":"module"}');
      await writeFile(
        join(folder, `${first}.js`),
        "export async function up(db) { await db.schema.createTable('chain_probe').addColumn('id', 'integer', c => c.primaryKey()).execute(); }",
      );
      await writeFile(join(folder, 'ORDER'), `${first}\n`);
      expect((await runtime().migrateToLatest()).error).toBeUndefined();
      await writeFile(
        join(folder, `${second}.js`),
        "export async function up(db) { await db.insertInto('chain_probe').values({id: 1}).execute(); }",
      );
      await writeFile(join(folder, 'ORDER'), `${first}\n${second}\n`);
      const cli = new CliMigrator({
        connectionParams: { connectionType: 'url', url },
        allowUnorderedMigrations: false,
        migrationFolder: folder,
      });
      try {
        await cli.runMigrations();
      } finally {
        await cli.destroy();
      }
      const resumed = await runtime().migrateToLatest();
      expect(resumed.error).toBeUndefined();
      expect(resumed.results).toEqual([]);
      expect(await db.selectFrom('chain_probe').selectAll().execute()).toEqual([{ id: 1 }]);
      expect(
        (await db.selectFrom('frameleaf_migrations').select('name').orderBy('name').execute()).map(({ name }) => name),
      ).toEqual([first, second]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
