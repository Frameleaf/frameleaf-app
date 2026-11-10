import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { MediaHealthRepository } from 'src/repositories/media-health.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

/**
 * FL-1337 (final review W3): a photo its owner kept as it is waits for no one, so the missing and damaged counts
 * leave it out. The medium specs check the counts against a database; these check that every branch of each
 * count carries the rule.
 */
describe('counts leave out a photo kept as it is', () => {
  it('in the file checks overview, for both checkers and both kinds', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [{ missing: 0, damaged: 0, stray: 0, rawToMatch: 0 }] }));
    try {
      await new IntegrityRepository(db).getFindingsOverview(['.cr2']);
      expect(queries).toHaveLength(1);
      const [query] = queries;
      // the kept problems: open, not dismissed, left as they are
      expect(query.sql).toMatch(
        /WITH kept AS \(\s*SELECT h\."assetId", h\.category\s*FROM public\.asset_health h\s*WHERE h\.evidence->>'fixState' = 'left-as-is' AND h\."resolvedAt" IS NULL AND h\."dismissedAt" IS NULL/,
      );
      // each file check report of a kept photo, by kind
      expect(query.sql).toContain(
        `NOT EXISTS (SELECT 1 FROM kept k WHERE k."assetId" = r."assetId" AND k.category = 'missing')`,
      );
      expect(query.sql).toContain(
        `NOT EXISTS (SELECT 1 FROM kept k WHERE k."assetId" = r."assetId" AND k.category = 'corrupt')`,
      );
      // and Library care's own findings of both kinds
      expect(query.sql.match(/\(h\.evidence->>'fixState'\) IS DISTINCT FROM 'left-as-is'/g)).toHaveLength(2);
    } finally {
      await db.destroy();
    }
  });

  it("in Library care's queue counts", async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [] }));
    try {
      await new MediaHealthRepository(db).countByStatus({
        ownerId: '00000000-0000-4000-8000-000000000001',
        privacy: {},
      });
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain(`(asset_health.evidence->>'fixState') IS DISTINCT FROM 'left-as-is'`);
    } finally {
      await db.destroy();
    }
  });
});
