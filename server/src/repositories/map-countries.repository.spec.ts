import * as fs from 'node:fs/promises';
import { MapRepository } from 'src/repositories/map.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

vi.mock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()), readFile: vi.fn() }));
const countries = {
  type: 'FeatureCollection',
  features: [
    {
      properties: { ADMIN: 'Country', ADM0_A3: 'CTR', TYPE: 'Country' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [1, 2],
            [3, 4],
            [1, 2],
          ],
        ],
      },
    },
  ],
};
const repository = (db: unknown) =>
  new MapRepository(
    { getEnv: () => ({ resourcePaths: { geodata: { naturalEarthCountriesPath: '/synthetic-countries' } } }) } as never,
    undefined as never,
    { setContext: vi.fn(), fatal: vi.fn() } as never,
    db as never,
  );

describe('country boundary replacement', () => {
  beforeEach(() => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(countries));
  });

  it('loads replacement rows before dropping the live table and commits only after the primary key', async () => {
    const { db, queries } = scriptedKysely();
    try {
      await repository(db)['importNaturalEarthCountries']();
      const insert = queries.findIndex(({ sql }) => sql.startsWith('insert into "naturalearth_countries_tmp"'));
      const drop = queries.findIndex(({ sql }) => sql.startsWith('drop table'));
      const primary = queries.findIndex(({ sql }) => sql.includes('ADD PRIMARY KEY'));
      expect(insert).toBeGreaterThan(0);
      expect(drop).toBeGreaterThan(insert);
      expect(primary).toBeGreaterThan(drop);
      expect(queries.at(-1)?.sql).toBe('commit');
      expect(queries[insert].parameters).toEqual(['Country', 'CTR', 'Country', '((1,2), (3,4), (1,2))']);
    } finally {
      await db.destroy();
    }
  });

  it('rolls back a failed insert without dropping the live table', async () => {
    const failure = new Error('insert failed');
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.startsWith('insert into')) {
        throw failure;
      }
    });
    try {
      await expect(repository(db)['importNaturalEarthCountries']()).rejects.toBe(failure);
      expect(queries.some(({ sql }) => sql.startsWith('drop table'))).toBe(false);
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });

  it('rolls back the replacement if primary-key creation fails', async () => {
    const failure = new Error('duplicate boundary ID');
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('ADD PRIMARY KEY')) {
        throw failure;
      }
    });
    try {
      await expect(repository(db)['importNaturalEarthCountries']()).rejects.toBe(failure);
      expect(queries.some(({ sql }) => sql === 'commit')).toBe(false);
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      await db.destroy();
    }
  });
});
