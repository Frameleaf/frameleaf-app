import { SearchFilter } from 'src/dtos/search.dto.js';
import { searchAssetBuilder, searchFilterPredicate } from 'src/utils/database.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const viewerId = '00000000-0000-4000-8000-000000000001';
const partnerId = '00000000-0000-4000-8000-000000000002';
const family = '00000000-0000-4000-8000-0000000000f1';
const work = '00000000-0000-4000-8000-0000000000f2';

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

const inViewerCategories =
  'from "asset_face" inner join "person_category_member" on "person_category_member"."personId" = "asset_face"."personGroupId" ' +
  'where "asset_face"."assetId" = "asset"."id" and "asset_face"."deletedAt" is null and "asset_face"."isVisible" = $';

describe('personCategoryIds search filter (FL-874)', () => {
  it("matches items with a visible face of someone in any of the viewer's own categories", () =>
    withDb((db) => {
      const query = compile(db, { personCategoryIds: { any: [family, work] } });
      expect(query.sql).toContain(`exists (select ${inViewerCategories}`);
      expect(query.sql).toMatch(
        /"person_category_member"\."ownerId" = \$\d+ and "person_category_member"\."categoryId" = any\(\$\d+::uuid\[\]\)\)/,
      );
      expect(query.parameters).toContain(viewerId);
      expect(query.parameters).toContain(`{${family},${work}}`);
    }));

  it('asks for every category with all, counting distinct categories', () =>
    withDb((db) => {
      const query = compile(db, { personCategoryIds: { all: [family, work] } });
      expect(query.sql).toContain(
        'group by "asset_face"."assetId" having count(distinct "person_category_member"."categoryId") = $',
      );
      expect(query.parameters).toContain(2);
    }));

  it('leaves out items with someone in a category with none', () =>
    withDb((db) => {
      const query = compile(db, { personCategoryIds: { none: [work] } });
      expect(query.sql).toContain(`not exists (select ${inViewerCategories}`);
    }));

  it('combines with other conditions and inside or branches', () =>
    withDb((db) => {
      const query = compile(db, {
        isFavorite: { eq: true },
        or: [{ personCategoryIds: { any: [family] } }, { personCategoryIds: { any: [work] }, city: { eq: 'Paris' } }],
      });
      expect(query.sql.split(inViewerCategories)).toHaveLength(3);
      expect(query.sql).toContain('"asset"."isFavorite" =');
      expect(query.sql).toContain('"asset_exif"."city" =');
      expect(query.sql).toMatch(/ or /);
    }));

  it('matches nothing without a viewer, as through a shared link, and none then excludes nothing', () =>
    withDb((db) => {
      const any = compile(db, { albumIds: { any: [family] }, personCategoryIds: { any: [family] } }, true);
      expect(any.sql).not.toContain('person_category_member');
      expect(any.sql).toContain('false');
      const none = compile(db, { albumIds: { any: [family] }, personCategoryIds: { none: [family] } }, true);
      expect(none.sql).not.toContain('person_category_member');
      expect(none.sql).toContain('not false');
    }));

  it('is the same predicate the timeline and library searches compose', () =>
    withDb((db) => {
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .where((eb) => searchFilterPredicate(eb, { personCategoryIds: { any: [family] } }, viewerId))
        .compile();
      expect(query.sql).toContain(inViewerCategories);
      expect(query.parameters).toContain(viewerId);
    }));
});
