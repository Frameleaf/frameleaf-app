import { createPostgres } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { DB } from 'src/schema/index.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/** Enough places that each trigram index build holds its lock for well over the lock timeout below. */
const PLACES = 60_000;
/** Short enough that a statement waiting on another index statement's lock is cancelled. */
const LOCK_TIMEOUT_MS = 10;

let db: Kysely<DB>;
let ddl: Kysely<DB>;

beforeAll(async () => {
  db = await getKyselyDB();
  const { name } = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows[0];
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = `/${name}`;
  // A pool like the server's (several connections, each with a lock timeout), only with a shorter timeout.
  ddl = new Kysely<DB>({
    dialect: new PostgresJSDialect({
      postgres: createPostgres({
        connection: { connectionType: 'url', url: url.href },
        maxConnections: 10,
        lockTimeoutMs: LOCK_TIMEOUT_MS,
      }),
    }),
  });
});

afterAll(async () => {
  await ddl?.destroy();
  await db?.destroy();
});

describe('geodata import', () => {
  it('builds the primary key and the place indexes without them waiting on each other', async () => {
    // The table as the import leaves it after loading cities500: places, no primary key, no name indexes.
    await sql`CREATE TABLE geodata_places_tmp (LIKE geodata_places INCLUDING ALL EXCLUDING INDEXES)`.execute(db);
    await sql`DROP TABLE geodata_places`.execute(db);
    await sql`ALTER TABLE geodata_places_tmp RENAME TO geodata_places`.execute(db);
    await sql`
      INSERT INTO geodata_places
        ("id", "name", "alternateNames", "latitude", "longitude", "countryCode", "admin1Code", "admin2Code",
         "modificationDate", "admin1Name", "admin2Name")
      SELECT i, 'Place ' || md5(i::text), 'Lieu ' || md5(i::text), -80 + i % 160, -170 + i % 340, 'FR', '11', '75',
             '2026-01-01', 'Region ' || md5((i % 97)::text), 'District ' || md5((i % 991)::text)
      FROM generate_series(1, ${PLACES}) AS i
    `.execute(db);

    const logger = { setContext: () => {} };
    const sut = new MapRepository(undefined as never, undefined as never, logger as never, ddl as never);
    // Before the fix the primary key (ACCESS EXCLUSIVE) and four index builds (SHARE) started together,
    // so whichever waited past the lock timeout was cancelled and the microservices worker failed to start.
    await (sut as unknown as { createGeodataIndices: () => Promise<void> }).createGeodataIndices();

    const { rows } = await sql<{ name: string }>`
      SELECT indexname AS name FROM pg_indexes WHERE tablename = 'geodata_places' ORDER BY indexname
    `.execute(db);
    expect(rows.map(({ name }) => name)).toEqual([
      'geodata_places_pkey',
      'idx_geodata_places_admin1_name',
      'idx_geodata_places_admin2_name',
      'idx_geodata_places_alternate_names',
      'idx_geodata_places_name',
    ]);
  });
});
