import { sql } from 'kysely';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import {
  hiddenAssetIdExists,
  hiddenContentOrOthersRules,
  hiddenFromSession,
  searchAssetBuilder,
  withHiddenContentFilter,
} from 'src/utils/database.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

/**
 * FL-446 (owner decision, October 17, 2026: "hidden items are only shared with partner sharing,
 * they're never shared any other way"): the predicate that withholds an item matching its owner's
 * Locked rules from everyone but that owner, and where it is applied.
 */
const viewerId = '00000000-0000-4000-8000-000000000001';
const albumId = '00000000-0000-4000-8000-0000000000a1';

const withScripted = async (run: (db: ReturnType<typeof scriptedKysely>['db']) => void) => {
  const { db } = scriptedKysely();
  try {
    run(db);
  } finally {
    await db.destroy();
  }
};

describe('owner Locked rules (FL-446)', () => {
  it('adds nothing to a read that does not ask for it', async () => {
    await withScripted((db) => {
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .$call((qb) => withHiddenContentFilter(qb, { excludeNsfw: true }))
        .compile();
      expect(query.sql).not.toContain('owner_rules');
    });
    expect(hiddenContentOrOthersRules({})).toBeUndefined();
    expect(hiddenAssetIdExists(sql.ref('album.albumThumbnailAssetId'), {})).toBeUndefined();
  });

  it("reads every kind of rule from the asset owner's stored preferences, sparing the viewer's own media", async () => {
    await withScripted((db) => {
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .$call((qb) => withHiddenContentFilter(qb, { othersRulesViewerId: viewerId }))
        .compile();
      expect(query.sql).toContain('from user_metadata as owner_rules');
      expect(query.sql).toContain(`owner_rules."userId" = "asset"."ownerId"`);
      expect(query.sql).toContain(`owner_rules.key = 'preferences'`);
      for (const key of ['tagIds', 'personIds', 'petIds']) {
        expect(query.sql).toContain(`'$.privacy.suppression.${key}[*]'`);
      }
      // a rejected pet observation or another owner's pet never matches
      expect(query.sql).toContain(`pet_observation.state = 'confirmed'`);
      expect(query.sql).toContain(`pet."ownerId" = "asset"."ownerId"`);
      expect(query.sql).toContain(`not ("asset"."ownerId" != $1::uuid and exists (`);
      expect(query.parameters).toEqual([viewerId]);
    });
  });

  it('spares nobody when every member sees the read alike (a shared space, a link)', async () => {
    await withScripted((db) => {
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .$call((qb) => withHiddenContentFilter(qb, { othersRulesViewerId: null }))
        .compile();
      expect(query.sql).toContain('owner_rules');
      expect(query.sql).not.toContain('!=');
      expect(query.parameters).toEqual([]);
    });
  });

  it("keeps the session's own filter alongside the owner rules", async () => {
    await withScripted((db) => {
      const options: HiddenContentQueryOptions = { excludeNsfw: true, othersRulesViewerId: viewerId };
      const query = db
        .selectFrom('asset')
        .select('asset.id')
        .$call((qb) => withHiddenContentFilter(qb, options))
        .compile();
      expect(query.sql).toContain('owner_rules');
      expect(query.sql).toContain('nsfw_asset.is_nsfw = true');

      const hidden = db.selectFrom('asset').select('asset.id').where(hiddenFromSession(options)).compile();
      expect(hidden.sql).toContain('owner_rules');
      expect(hidden.sql).toContain('nsfw_asset.is_nsfw = true');
    });
  });

  it('confines an album search by the owner rules, and leaves a library search alone', async () => {
    await withScripted((db) => {
      const confined = searchAssetBuilder(
        db,
        { filter: { albumIds: { any: [albumId] } } },
        {
          userIds: [viewerId],
          lockedOwnerId: viewerId,
          viewingUserId: viewerId,
        },
      )
        .select('asset.id')
        .compile();
      expect(confined.sql).toContain('owner_rules');
      expect(confined.parameters).toContain(viewerId);

      const library = searchAssetBuilder(
        db,
        { filter: {} },
        {
          userIds: [viewerId],
          lockedOwnerId: viewerId,
          viewingUserId: viewerId,
        },
      )
        .select('asset.id')
        .compile();
      expect(library.sql).not.toContain('owner_rules');
    });
  });
});
