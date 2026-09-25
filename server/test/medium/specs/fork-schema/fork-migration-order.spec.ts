import { Kysely, sql } from 'kysely';
import { Migration, Migrator } from 'kysely/migration';
import { join } from 'node:path';
import { createForkMigrationProvider } from 'src/fork-schema/migration-provider.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Fork migrations run in Kysely's ordered mode (`DatabaseRepository.runForkMigrations`): a pending
 * migration whose name sorts before the last one a database already ran fails as "corrupted
 * migrations" and the server does not start. A migration this branch adds must therefore sort after
 * every migration already on `master/frameleaf-implementation`.
 *
 * `BRANCH_MIGRATIONS` lists the migrations this branch adds; once the branch lands they are released
 * and leave the list, and the next branch lists its own. The spec replays the upgrade a real server
 * makes: the released migrations first, then the rest, through Kysely's own ordering check (the
 * migrations' bodies are replaced with no-ops; only their order is under test).
 */
const BRANCH_MIGRATIONS = [
  '0000000000202-FrameleafAccountLinks',
  '0000000000203-FrameleafSessions',
  '0000000000204-FrameleafUserLicenses',
];

const SCHEMA = 'fork_migration_order_probe';

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

  it('lists only migrations that exist', () => {
    for (const name of BRANCH_MIGRATIONS) {
      expect(names).toContain(name);
    }
  });

  it('adds every branch migration after the released ones', async () => {
    const released = names.filter((name) => !BRANCH_MIGRATIONS.includes(name));
    const last = released.at(-1)!;
    for (const name of BRANCH_MIGRATIONS) {
      expect(name > last, `${name} must sort after the released ${last}`).toBe(true);
    }

    const first = await migrator(released).migrateToLatest();
    expect(first.error).toBeUndefined();
    const second = await migrator(names).migrateToLatest();
    expect(second.error).toBeUndefined();
    expect(second.results?.map(({ migrationName }) => migrationName)).toEqual(BRANCH_MIGRATIONS);
  });
});
