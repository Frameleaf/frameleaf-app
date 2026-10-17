import { DummyDriver, Kysely, PostgresDialect } from 'kysely';
import { readFileSync } from 'node:fs';
import { format } from 'sql-formatter';
import type { DB } from 'src/schema/index.js';
import { AlbumUserRole, SyncEntityType } from 'src/enum.js';
import { SyncRepository } from 'src/repositories/sync.repository.js';

const queries: { sql: string; parameters: readonly unknown[] }[] = [];
class Driver extends DummyDriver {
  acquireConnection() {
    return Promise.resolve({
      executeQuery: () => Promise.resolve({ rows: [] }),
      async *streamQuery(query: { sql: string; parameters: readonly unknown[] }) {
        queries.push(query);
        await Promise.resolve();
        yield { rows: [] };
      },
    });
  }
}
const dialect = new PostgresDialect({ pool: {} as never });
dialect.createDriver = () => new Driver();
const db = new Kysely<DB>({ dialect });
const album = new SyncRepository(db).album;
afterAll(() => db.destroy());
beforeEach(() => {
  queries.length = 0;
});

it('projects the album owner in the same authorized and ordered V1 stream query', async () => {
  await Array.fromAsync(
    album.getUpserts(
      { userId: 'user-id', nowId: 'now-id', ack: { type: SyncEntityType.AlbumV1, updateId: 'ack-id' } },
      true,
    ),
  );
  expect(queries).toHaveLength(1);
  const query = queries[0];
  expect(query.sql).toContain('"album_owner"."albumId" = "album"."id"');
  expect(query.sql).toContain('"album_owner"."role" =');
  expect(query.sql).toContain('as "ownerId"');
  expect(query.sql).toContain('"album_users"."userId" =');
  expect(query.sql).toContain('order by "album"."updateId" asc');
  expect(query.parameters).toEqual(expect.arrayContaining([AlbumUserRole.Owner, 'user-id', 'now-id', 'ack-id']));
});

it('leaves the V2 query free of the V1-only owner projection', async () => {
  await Array.fromAsync(album.getUpserts({ userId: 'user-id', nowId: 'now-id' }));
  expect(queries).toHaveLength(1);
  expect(queries[0].sql).not.toContain('album_owner');
  expect(queries[0].sql).not.toContain('"ownerId"');
  expect(queries[0].parameters).toEqual(['now-id', 'user-id']);
});

it.each([false, true])(
  'binds the checked-in SQL catalog to the actual compiled owner projection (%s)',
  async (includeOwner) => {
    await Array.fromAsync(
      album.getUpserts(
        {
          userId: 'user-id',
          nowId: 'now-id',
          ack: { type: includeOwner ? SyncEntityType.AlbumV1 : SyncEntityType.AlbumV2, updateId: 'ack-id' },
          excludeNsfw: true,
        },
        includeOwner,
      ),
    );
    const label = `-- SyncRepository.album.getUpserts${includeOwner ? ' (v1)' : ''}\n`;
    const catalog = readFileSync(new URL('../queries/sync.repository.sql', import.meta.url), 'utf8');
    const section = catalog.split(label)[1]?.split('\n-- ', 1)[0].trim();
    expect(section).toBe(format(queries[0].sql, { language: 'postgresql' }));
  },
);
