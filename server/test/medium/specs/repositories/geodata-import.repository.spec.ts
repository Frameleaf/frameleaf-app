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

beforeEach(async () => {
  vi.restoreAllMocks();
  await sql`DROP TABLE IF EXISTS geodata_places_tmp`.execute(db);
  await db.deleteFrom('geodata_places').execute();
});

const indexNames = [
  'IDX_geodata_gist_earthcoord',
  'geodata_places_pkey',
  'idx_geodata_places_admin1_name',
  'idx_geodata_places_admin2_name',
  'idx_geodata_places_alternate_names',
  'idx_geodata_places_name',
];

const putPlace = (table: 'geodata_places' | 'geodata_places_tmp', id: number, name: string) =>
  sql`INSERT INTO ${sql.id(table)} (id, name, latitude, longitude, "countryCode", "modificationDate")
      VALUES (${id}, ${name}, 1, 1, 'FR', '2026-01-01')`.execute(db);

function publicationFixture() {
  const sut = new MapRepository(
    {
      getEnv: () => ({ resourcePaths: { geodata: { admin1: '/fixture/admin1', admin2: '/fixture/admin2' } } }),
    } as never,
    undefined as never,
    { setContext: vi.fn(), warn: vi.fn() } as never,
    ddl as never,
  );
  const internals = sut as unknown as {
    importGeodata: () => Promise<void>;
    loadAdmin: (path: string) => Promise<Map<string, string>>;
    loadCities500: () => Promise<void>;
    createGeodataIndices: () => Promise<void>;
  };
  vi.spyOn(internals, 'loadAdmin').mockResolvedValue(new Map());
  const load = vi.spyOn(internals, 'loadCities500').mockImplementation(async () => {
    await putPlace('geodata_places_tmp', 2, 'Replacement');
    expect(await db.selectFrom('geodata_places').select(['id', 'name']).execute()).toEqual([
      { id: 1, name: 'Previous' },
    ]);
  });
  return { internals, load };
}

const stagingTable = async () =>
  (await sql<{ name: string | null }>`SELECT to_regclass('public.geodata_places_tmp')::text AS name`.execute(db))
    .rows[0].name;

describe('geodata import', () => {
  it('builds the primary key and the place indexes without them waiting on each other', async () => {
    // Loaded staging data has no indexes; the live table remains available during all index builds.
    await sql`CREATE TABLE geodata_places_tmp (LIKE geodata_places INCLUDING ALL EXCLUDING INDEXES)`.execute(db);
    await sql`
      INSERT INTO geodata_places_tmp
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
      SELECT indexname AS name FROM pg_indexes WHERE tablename = 'geodata_places_tmp' ORDER BY indexname
    `.execute(db);
    expect(rows.map(({ name }) => name)).toEqual(
      expect.arrayContaining(
        indexNames.map((name) => (name === 'geodata_places_pkey' ? 'geodata_places_tmp_pkey' : `${name}_tmp`)),
      ),
    );
    expect(rows).toHaveLength(indexNames.length);
  });

  it('retains the live dataset when loading the replacement fails', async () => {
    await putPlace('geodata_places', 1, 'Previous');
    const { internals, load } = publicationFixture();
    const failure = new Error('load failed');
    load.mockImplementation(async () => {
      await putPlace('geodata_places_tmp', 2, 'Incomplete');
      throw failure;
    });
    await expect(internals.importGeodata()).rejects.toBe(failure);
    expect(await db.selectFrom('geodata_places').select(['id', 'name']).execute()).toEqual([
      { id: 1, name: 'Previous' },
    ]);
    expect(await stagingTable()).toBeNull();
  });

  it('publishes the complete replacement with canonical primary/index names', async () => {
    await putPlace('geodata_places', 1, 'Previous');
    const { internals } = publicationFixture();
    await internals.importGeodata();
    expect(await db.selectFrom('geodata_places').select(['id', 'name']).execute()).toEqual([
      { id: 2, name: 'Replacement' },
    ]);
    const { rows } = await sql<{
      name: string;
    }>`SELECT indexname AS name FROM pg_indexes WHERE tablename = 'geodata_places' ORDER BY indexname`.execute(db);
    expect(rows.map(({ name }) => name)).toEqual(expect.arrayContaining(indexNames));
    expect(rows).toHaveLength(indexNames.length);
    expect(await stagingTable()).toBeNull();
  });

  it('restores the old table if PostgreSQL rejects publication after the table swap', async () => {
    await putPlace('geodata_places', 1, 'Previous');
    const { internals } = publicationFixture();
    const createIndices = internals.createGeodataIndices.bind(internals);
    vi.spyOn(internals, 'createGeodataIndices').mockImplementation(async () => {
      await createIndices();
      await sql`ALTER TABLE geodata_places_tmp RENAME CONSTRAINT geodata_places_tmp_pkey TO unexpected_pkey`.execute(
        db,
      );
    });
    await expect(internals.importGeodata()).rejects.toThrow();
    expect(await db.selectFrom('geodata_places').select(['id', 'name']).execute()).toEqual([
      { id: 1, name: 'Previous' },
    ]);
    expect(await stagingTable()).toBeNull();
    const { rows } = await sql<{
      name: string;
    }>`SELECT conname AS name FROM pg_constraint WHERE conrelid = 'geodata_places'::regclass AND contype = 'p'`.execute(
      db,
    );
    expect(rows).toEqual([{ name: 'geodata_places_pkey' }]);
  });
});
