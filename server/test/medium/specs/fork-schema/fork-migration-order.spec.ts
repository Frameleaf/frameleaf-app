import { Kysely, sql } from 'kysely';
import { Migration, Migrator } from 'kysely/migration';
import { join } from 'node:path';
import manifest from 'src/fork-schema/manifests/fork-migration-order.json' with { type: 'json' };
import { createForkMigrationProvider } from 'src/fork-schema/migration-provider.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Fork migrations run in Kysely's ordered mode (`DatabaseRepository.runForkMigrations`): a pending
 * migration whose name sorts before the last one a database already ran fails as "corrupted
 * migrations" and the server does not start.
 *
 * `manifests/fork-migration-order.json` is the append-only list of shipped fork migrations. Every
 * migration file must be in it or sort after its last entry, so a branch cannot add a migration
 * numbered below one already released. The spec also replays the upgrade a real server makes
 * (listed migrations first, then any new ones) through Kysely's own ordering check, with the
 * migrations' bodies replaced by no-ops: only their order is under test.
 */
const SCHEMA = 'fork_migration_order_probe';
const released: string[] = manifest.migrations;

describe('fork migration order', () => {
  let db: Kysely<DB>;
  let names: string[];

  beforeAll(async () => {
    db = await getKyselyDB();
    const migrations = await createForkMigrationProvider(
      join(import.meta.dirname, '../../../../src/fork-schema/migrations'),
    ).getMigrations();
    names = Object.keys(migrations).sort();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(SCHEMA)} CASCADE`.execute(db);
    await sql`CREATE SCHEMA ${sql.id(SCHEMA)}`.execute(db);
  });

  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(SCHEMA)} CASCADE`.execute(db);
    await db.destroy();
  });

  const migrator = (only: string[]) =>
    new Migrator({
      db,
      migrationTableSchema: SCHEMA,
      migrationTableName: 'migrations',
      migrationLockTableName: 'migrations_lock',
      provider: {
        getMigrations: () =>
          Promise.resolve(
            Object.fromEntries(only.map((name): [string, Migration] => [name, { up: () => Promise.resolve() }])),
          ),
      },
    });

  it('keeps the manifest strictly ascending', () => {
    for (let index = 1; index < released.length; index++) {
      expect(released[index] > released[index - 1], `${released[index]} after ${released[index - 1]}`).toBe(true);
    }
  });

  it('lists only migrations that exist', () => {
    for (const name of released) {
      expect(names).toContain(name);
    }
  });

  it('adds every unlisted migration after the last listed one', () => {
    const last = released.at(-1)!;
    for (const name of names) {
      if (!released.includes(name)) {
        expect(name > last, `${name} must sort after ${last}; append it to fork-migration-order.json`).toBe(true);
      }
    }
  });

  it('upgrades a database that ran the listed migrations, through Kysely’s ordering check', async () => {
    const first = await migrator(released).migrateToLatest();
    expect(first.error).toBeUndefined();
    const second = await migrator(names).migrateToLatest();
    expect(second.error).toBeUndefined();
    expect(second.results?.map(({ migrationName }) => migrationName)).toEqual(
      names.filter((name) => !released.includes(name)),
    );
  });
});
