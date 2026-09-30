import { authStub } from 'test/fixtures/auth.stub.js';
import { TagSync } from 'src/repositories/tag-sync.repository.js';
import { forkGuardAnswer, scriptedKysely } from 'test/scripted-kysely.js';

describe('tag sync maintenance on official-origin libraries', () => {
  it.each(['reset', 'cleanupAuditTables'] as const)(
    'keeps existing %s usable before legacy-fork adoption',
    async (method) => {
      const { db, queries } = scriptedKysely((query) =>
        query.sql.includes("to_regclass('public.")
          ? { rows: [{ table: null }] }
          : forkGuardAnswer({ phase: 'inactive' })(query),
      );
      const repo = new TagSync(db);
      await expect(
        method === 'reset' ? repo.reset('session-id') : repo.cleanupAuditTables(30),
      ).resolves.toBeUndefined();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain('to_regclass');
    },
  );
  it.each(['reset', 'cleanupAuditTables'] as const)(
    'retains handoff write refusal for existing %s tables',
    async (method) => {
      const { db, queries } = scriptedKysely((query) =>
        query.sql.includes("to_regclass('public.")
          ? { rows: [{ table: 'present' }] }
          : forkGuardAnswer({ phase: 'failed' })(query),
      );
      const repo = new TagSync(db);
      await expect(method === 'reset' ? repo.reset('session-id') : repo.cleanupAuditTables(30)).rejects.toThrow(
        'This change is unavailable during database handoff',
      );
      expect(queries.some(({ sql }) => sql.startsWith('delete from'))).toBe(false);
    },
  );
});

it('rejects new tag streaming before querying identifiers on an inactive official-origin library', async () => {
  const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'inactive' }));
  await expect(new TagSync(db).reconcile(authStub.user1, 'tag')).rejects.toThrow(
    'This change is unavailable during database handoff',
  );
  expect(queries.some(({ sql }) => sql.includes('from \"tag\"') || sql.includes('session_tag_sync_state'))).toBe(false);
});
