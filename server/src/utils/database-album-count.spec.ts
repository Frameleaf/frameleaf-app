import { SearchFilter } from 'src/dtos/search.dto.js';
import { searchAssetBuilder, searchFilterPredicate } from 'src/utils/database.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const viewerId = '00000000-0000-4000-8000-000000000001';
const partnerId = '00000000-0000-4000-8000-000000000002';

const withDb = async (run: (db: ReturnType<typeof scriptedKysely>['db']) => void) => {
  const { db } = scriptedKysely();
  try {
    run(db);
  } finally {
    await db.destroy();
  }
};

const compile = (db: ReturnType<typeof scriptedKysely>['db'], filter: SearchFilter, sharedLink = false) =>
  searchAssetBuilder(
    db,
    { filter },
    {
      userIds: [viewerId, partnerId],
      lockedOwnerId: viewerId,
      viewingUserId: viewerId,
      sharedLink,
    },
  )
    .select('asset.id')
    .compile();

const viewerAlbumCount =
  '(select count(*) as "count" from "album_asset" inner join "album" on "album"."id" = "album_asset"."albumId" ' +
  'inner join "album_user" on "album_user"."albumId" = "album"."id" and "album_user"."userId" = $';

describe('albumCount search filter (FL-976)', () => {
  it('counts only the non-deleted albums the viewer owns or is a member of', () =>
    withDb((db) => {
      const query = compile(db, { albumCount: { gt: 1 } });
      expect(query.sql).toContain(viewerAlbumCount);
      expect(query.sql).toContain(
        'where "album_asset"."assetId" = "asset"."id" and "album"."deletedAt" is null)::double precision > $',
      );
      expect(query.parameters).toContain(viewerId);
      expect(query.parameters).toContain(1);
    }));

  it('applies every comparison operator to the same count', () =>
    withDb((db) => {
      const query = compile(db, { albumCount: { gte: 2, lte: 4, ne: 3, notIn: [5], in: [2, 4] } });
      for (const operator of ['>=', '<=', '!=', 'not in', 'in']) {
        expect(query.sql).toMatch(new RegExp(String.raw`\)::double precision ${operator} \(?\$`));
      }
    }));

  it('combines with other conditions and inside or branches', () =>
    withDb((db) => {
      const query = compile(db, {
        isFavorite: { eq: true },
        or: [{ albumCount: { eq: 0 } }, { albumCount: { gte: 2 }, city: { eq: 'Paris' } }],
      });
      expect(query.sql.split(viewerAlbumCount)).toHaveLength(3);
      expect(query.sql).toContain('"asset"."isFavorite" =');
      expect(query.sql).toContain('"asset_exif"."city" =');
      expect(query.sql).toMatch(/ or /);
    }));

  it('leaves the search universe to ownership, as albumCount is not album-confined', () =>
    withDb((db) => {
      const plain = compile(db, { isFavorite: { eq: true } });
      const counted = compile(db, { isFavorite: { eq: true }, albumCount: { gte: 1 } });
      expect(counted.sql.startsWith(plain.sql.split(' and "asset"."isFavorite"', 1)[0])).toBe(true);
      expect(counted.sql).toContain('"asset"."ownerId" = any(');
    }));

  it('counts no album without a viewer, as through a shared link', () =>
    withDb((db) => {
      const query = compile(db, { albumCount: { gte: 1 } }, true);
      expect(query.sql).not.toContain('from "album_asset"');
      expect(query.sql).toContain('0::double precision >= $');
    }));

  it('is the same predicate the timeline and library searches compose', () =>
    withDb((db) => {
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .where((eb) => searchFilterPredicate(eb, { albumCount: { gt: 1 } }, viewerId))
        .compile();
      expect(query.sql).toContain(viewerAlbumCount);
    }));
});
