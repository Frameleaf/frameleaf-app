import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { Readable } from 'node:stream';
import type { DB } from 'src/schema/index.js';
import { MapRepository } from 'src/repositories/map.repository.js';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function setup(execute: (sql: string) => Promise<void> = () => Promise.resolve()) {
  const queries: string[] = [];
  const events: string[] = [];
  class Driver extends DummyDriver {
    acquireConnection() {
      return Promise.resolve({
        executeQuery(query: { sql: string }) {
          queries.push(query.sql);
          events.push(query.sql);
          return execute(query.sql).then(() => ({ rows: [] }));
        },
        streamQuery() {
          return Readable.from([])[Symbol.asyncIterator]();
        },
      });
    }
    beginTransaction() {
      events.push('tx:begin');
      return Promise.resolve();
    }
    commitTransaction() {
      events.push('tx:commit');
      return Promise.resolve();
    }
    rollbackTransaction() {
      events.push('tx:rollback');
      return Promise.resolve();
    }
  }
  const dialect = new PostgresDialect({ pool: {} as never });
  dialect.createDriver = () => new Driver();
  const db = new Kysely<DB>({ dialect });
  databases.push(db);
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() };
  const repository = new MapRepository(
    {
      getEnv: () => ({ resourcePaths: { geodata: { admin1: '/fixture/admin1', admin2: '/fixture/admin2' } } }),
    } as never,
    undefined as never,
    logger as never,
    db as never,
  );
  const internals = repository as unknown as {
    loadAdmin: (file: string) => Promise<Map<string, string>>;
    loadCities500: (first: Map<string, string>, second: Map<string, string>) => Promise<void>;
    createGeodataIndices: () => Promise<void>;
    importGeodata: () => Promise<void>;
  };
  vi.spyOn(internals, 'loadAdmin').mockResolvedValue(new Map());
  const load = vi.spyOn(internals, 'loadCities500').mockImplementation(() => {
    events.push('load');
    return Promise.resolve();
  });
  return { internals, load, queries, events, logger };
}

const dropsLive = (query: string) => /^drop table "geodata_places"$/i.test(query);

it('keeps the live table when the replacement load fails', async () => {
  const { internals, load, queries } = setup();
  const failure = new Error('load failed');
  load.mockRejectedValue(failure);
  await expect(internals.importGeodata()).rejects.toBe(failure);
  expect(queries.some((query) => dropsLive(query))).toBe(false);
  expect(queries.at(-1)).toBe('drop table if exists "geodata_places_tmp"');
});

it('keeps the live table when an index build fails', async () => {
  const failure = new Error('index failed');
  const { internals, queries } = setup((query) =>
    query.startsWith('create index') && query.includes('admin2_name') ? Promise.reject(failure) : Promise.resolve(),
  );
  await expect(internals.importGeodata()).rejects.toBe(failure);
  expect(queries.some((query) => dropsLive(query))).toBe(false);
});

it('loads and indexes the staging table before publishing with canonical names in one transaction', async () => {
  const { internals, events, queries } = setup();
  await internals.importGeodata();
  const begin = events.indexOf('tx:begin');
  const commit = events.indexOf('tx:commit');
  expect(events.indexOf('load')).toBeLessThan(begin);
  const indices = queries.filter((query) => query.startsWith('create index'));
  expect(indices).toHaveLength(5);
  for (const query of indices) {
    expect(query).toContain('on "geodata_places_tmp"');
    expect(events.indexOf(query)).toBeLessThan(begin);
  }
  expect(events.findIndex((query) => dropsLive(query))).toBeGreaterThan(begin);
  expect(events.findIndex((query) => dropsLive(query))).toBeLessThan(commit);
  expect(
    queries.some((query) => query.includes('RENAME CONSTRAINT geodata_places_tmp_pkey TO geodata_places_pkey')),
  ).toBe(true);
  for (const name of [
    'IDX_geodata_gist_earthcoord',
    'idx_geodata_places_alternate_names',
    'idx_geodata_places_name',
    'idx_geodata_places_admin1_name',
    'idx_geodata_places_admin2_name',
  ]) {
    expect(queries).toContain(`ALTER INDEX "${name}_tmp" RENAME TO "${name}"`);
  }
  expect(events.at(-1)).toBe('tx:commit');
});

it('rolls back a failed publication before cleaning its staging table', async () => {
  const failure = new Error('rename failed');
  const { internals, events } = setup((query) =>
    query.startsWith('ALTER INDEX') && query.includes('admin1_name') ? Promise.reject(failure) : Promise.resolve(),
  );
  await expect(internals.importGeodata()).rejects.toBe(failure);
  expect(events).toContain('tx:rollback');
  expect(events).not.toContain('tx:commit');
  expect(events.at(-1)).toBe('drop table if exists "geodata_places_tmp"');
});

it('drains sibling index builds before cleaning a failed replacement', async () => {
  const gate = Promise.withResolvers<void>();
  const failure = new Error('index failed');
  const { internals, queries } = setup((query) => {
    if (!query.startsWith('create index')) return Promise.resolve();
    if (query.includes('alternate_names')) return gate.promise;
    return query.includes('admin2_name') ? Promise.reject(failure) : Promise.resolve();
  });
  let settled = false;
  const pending = internals
    .importGeodata()
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await vi.waitFor(() =>
      expect(queries.some((query) => query.startsWith('create index') && query.includes('admin2_name'))).toBe(true),
    );
    expect(settled).toBe(false);
    expect(queries.filter((query) => query === 'drop table if exists "geodata_places_tmp"')).toHaveLength(1);
  } finally {
    gate.resolve();
  }
  expect(await pending).toBe(failure);
});

it('preserves the load error if staging cleanup also fails', async () => {
  const original = new Error('load failed');
  let drops = 0;
  const { internals, load, logger } = setup((query) => {
    if (query === 'drop table if exists "geodata_places_tmp"' && ++drops > 1)
      return Promise.reject(new Error('cleanup failed'));
    return Promise.resolve();
  });
  load.mockRejectedValue(original);
  await expect(internals.importGeodata()).rejects.toBe(original);
  expect(logger.warn).toHaveBeenCalled();
});
