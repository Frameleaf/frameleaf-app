import { AssetVisibility, ClassificationMatchDecision, ClassificationRuleAction } from 'src/enum.js';
import {
  ClassificationRepository,
  type ClassificationRuleEffects,
} from 'src/repositories/classification.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const rule: ClassificationRuleEffects = {
  id: 'rule',
  ownerId: 'owner',
  albumId: 'album',
  action: ClassificationRuleAction.Review,
  tagId: null,
  archive: false,
};

describe('classification review effects', () => {
  it.each([
    { label: 'deleted rule', current: undefined },
    { label: 'different owner', current: { ...rule, ownerId: 'other' } },
    { label: 'different album', current: { ...rule, albumId: 'other' } },
    { label: 'different action', current: { ...rule, action: ClassificationRuleAction.Tag } },
    { label: 'different tag', current: { ...rule, tagId: 'other' } },
    { label: 'different archive consent', current: { ...rule, archive: true } },
  ])('refuses $label before touching assets or decisions', async ({ current }) => {
    const { db, queries } = scriptedKysely(({ sql }) => ({
      rows: sql.includes('from "classification_rule"') && current ? [current] : [],
    }));
    try {
      await expect(
        new ClassificationRepository(db).decide(rule, ['asset'], ClassificationMatchDecision.Accepted),
      ).rejects.toThrow('Classification rule changed while reviewing');
      expect(queries.map(({ sql }) => sql)).toEqual([
        'begin',
        expect.stringMatching(/from "classification_rule".*for no key update$/),
        'rollback',
      ]);
    } finally {
      await db.destroy();
    }
  });

  it.each([ClassificationMatchDecision.Accepted, ClassificationMatchDecision.Rejected] as const)(
    'keeps an explicit %s decision available when only automatic application is disabled',
    async (decision) => {
      const { db, queries } = scriptedKysely(({ sql }) => {
        if (sql.includes('from "classification_rule"')) return { rows: [{ ...rule, enabled: false }] };
        if (sql.includes('from "asset"'))
          return { rows: [{ id: 'asset', visibility: AssetVisibility.Timeline, isLocked: false }] };
        if (sql.includes('from "classification_match"'))
          return {
            rows: [
              {
                assetId: 'asset',
                decision: ClassificationMatchDecision.Suggested,
                score: 0.8,
                tagContributed: false,
                archiveContributed: false,
              },
            ],
          };
        return {};
      });
      try {
        await expect(new ClassificationRepository(db).decide(rule, ['asset'], decision)).resolves.toMatchObject({
          updated: 1,
          skipped: 0,
        });
        expect(queries.at(-1)?.sql).toBe('commit');
        const write = queries.find(({ sql }) => sql.startsWith('insert into "classification_match"'));
        expect(write?.parameters).toContain(decision);
      } finally {
        await db.destroy();
      }
    },
  );
});
