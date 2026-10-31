import { Kysely } from 'kysely';
import { VersionHistoryRepository } from 'src/repositories/version-history.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

describe(VersionHistoryRepository.name, () => {
  let db: Kysely<DB>;
  let repository: VersionHistoryRepository;

  beforeAll(async () => {
    db = await getKyselyDB();
    repository = new VersionHistoryRepository(db);
  });

  beforeEach(async () => {
    await db.deleteFrom('version_history').execute();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('returns undefined for an empty history', async () => {
    await expect(repository.getLatest()).resolves.toBeUndefined();
    await expect(repository.getAll()).resolves.toEqual([]);
  });

  it('returns the most recently recorded version and keeps the complete history in date order', async () => {
    const oldest = await repository.create({ version: '7.0.0', createdAt: new Date('2026-01-01') });
    const newest = await repository.create({ version: '3.2.0', createdAt: new Date('2026-03-01') });
    const middle = await repository.create({ version: '4.0.0', createdAt: new Date('2026-02-01') });

    expect(newest).toEqual({ id: expect.any(String), createdAt: new Date('2026-03-01'), version: '3.2.0' });
    await expect(repository.getLatest()).resolves.toEqual(newest);
    await expect(repository.getAll()).resolves.toEqual([newest, middle, oldest]);
  });

  it('transfers only one history row from PostgreSQL for the startup lookup', async () => {
    await db
      .insertInto('version_history')
      .values(
        Array.from({ length: 128 }, (_, index) => ({
          version: `3.0.${index}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
        })),
      )
      .execute();
    const transferredRows: number[] = [];
    const observed = new VersionHistoryRepository(
      db.withPlugin({
        transformQuery: ({ node }) => node,
        transformResult: ({ result }) => {
          transferredRows.push(result.rows.length);
          return Promise.resolve(result);
        },
      }),
    );

    await expect(observed.getLatest()).resolves.toMatchObject({ version: '3.0.127' });
    expect(transferredRows).toEqual([1]);
    await expect(repository.getAll()).resolves.toHaveLength(128);
  });
});
