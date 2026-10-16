import { AssetVisibility } from 'src/enum.js';
import { ArchiveOperationRepository, archiveAnswerOutcome } from 'src/repositories/archive-operation.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('archive lock admission at publication', () => {
  it.each([
    { undo: false, elevated: false, expected: 'locked' },
    { undo: true, elevated: false, expected: 'locked' },
    { undo: false, elevated: true, expected: 'archived' },
    { undo: true, elevated: true, expected: 'undone' },
  ])('undo=$undo elevated=$elevated answers $expected', async ({ undo, elevated, expected }) => {
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('FROM public.archive_operation WHERE'))
        return {
          rows: [{ id: 'operation', ownerId: 'owner', prepared: false, archiveJobId: 'job', undoJobId: 'job' }],
        };
      if (sql.includes('SELECT "assetId", status FROM public.archive_operation_item'))
        return { rows: [{ assetId: 'asset', status: undo ? 'archived' : 'pending' }] };
      if (sql.includes('FROM asset') || sql.includes('from "asset"'))
        return {
          rows: [
            { id: 'asset', visibility: undo ? AssetVisibility.Archive : AssetVisibility.Timeline, isLocked: true },
          ],
        };
      if (sql.includes('UPDATE asset SET visibility')) return { rows: [{ id: 'asset', updateId: 'update' }] };
      return {};
    });
    try {
      const repo = new ArchiveOperationRepository(db);
      const answers = undo
        ? await repo.restore('owner', 'operation', 'job', ['asset'], elevated)
        : await repo.publish('owner', 'operation', 'job', ['asset'], elevated);
      expect(answers.get('asset')).toBe(expected);
      const writes = queries.filter(({ sql }) => sql.includes('UPDATE asset SET visibility'));
      expect(writes).toHaveLength(elevated ? 1 : 0);
      if (!elevated) {
        const lock = queries.findIndex(({ sql }) => sql.includes('from "asset"') && sql.endsWith('for update'));
        const freshRead = queries.findIndex(({ sql }) => sql.includes('as "isLocked"'));
        expect(lock).toBeGreaterThan(-1);
        expect(freshRead).toBeGreaterThan(lock);
        if (undo) {
          // A locked archive stays available to a later elevated undo; it is not consumed as a conflict.
          expect(queries.some(({ parameters }) => parameters.includes('conflict'))).toBe(false);
        }
      }
      expect(queries.at(-1)?.sql).toBe('commit');
    } finally {
      await db.destroy();
    }
  });

  it('reports a late lock as a lock refusal', () => {
    expect(archiveAnswerOutcome('locked')).toEqual({ status: 'skipped', reasonKey: 'frameleaf_bulk_reason_locked' });
  });
});
