import { SyncEntityType } from 'src/enum.js';
import { TagSync } from 'src/repositories/tag-sync.repository.js';
import { authStub } from 'test/fixtures/auth.stub.js';
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
  expect(queries.some(({ sql }) => sql.includes('from "tag"') || sql.includes('session_tag_sync_state'))).toBe(false);
});

const newestKinds = [
  ['tag', 'tag', 'TagV1'],
  ['assetTag', 'tag_asset', 'AssetTagV1'],
  ['pet', 'pet', 'PetV1'],
  ['petObservation', 'pet_observation', 'PetObservationV1'],
  ['spaceMember', 'album_user', 'SharedSpaceMemberV1'],
] as const;

it.each(newestKinds)('orders fresh %s by source before opaque event IDs', async (kind, table) => {
  const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'active' }));
  await new TagSync(db).reconcile(authStub.user1, kind);
  const pending = queries.find(({ sql }) => sql.includes('"acknowledged" =') && sql.startsWith('select'))!.sql;
  expect(pending).toContain('order by "deliveryOrder" asc nulls last');
  expect(pending).toContain(`from ${table}`);
  expect(pending).toContain(kind === 'assetTag' ? '"updateId"' : '"createdAt"');
  expect(pending).toContain('desc nulls last, "key" desc, "eventId" asc');
});

it.each(newestKinds)('acks delivered %s by durable order rather than UUID comparison', async (kind, _table, type) => {
  const { db, queries } = scriptedKysely((query) => {
    if (query.sql.startsWith('select') && query.sql.includes('"eventId" =')) {
      return { rows: [{ deliveryOrder: 7 }] };
    }
    return forkGuardAnswer({ phase: 'active' })(query);
  });
  await new TagSync(db).acknowledge(authStub.user1.session!.id, {
    type: SyncEntityType[type],
    updateId: '00000000-0000-7000-8000-000000000001',
  });
  const updated = queries.find(({ sql }) => sql.startsWith('update "session_tag_sync_state"'))!.sql;
  expect(updated).toContain('"deliveryOrder" <=');
  expect(updated).not.toContain('"eventId" <=');
  expect(updated).toContain('"delivered" =');
});
