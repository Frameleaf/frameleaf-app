import { SyncEntityType } from 'src/enum.js';
import { TagSync } from 'src/repositories/tag-sync.repository.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('canonical tag sync maintenance', () => {
  it.each(['reset', 'cleanupAuditTables'] as const)('waits to write until the %s tables exist', async (method) => {
    const { db, queries } = scriptedKysely(() => ({ rows: [{ table: null }] }));
    const repo = new TagSync(db);
    await expect(method === 'reset' ? repo.reset('session-id') : repo.cleanupAuditTables(30)).resolves.toBeUndefined();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('to_regclass');
  });
  it.each(['reset', 'cleanupAuditTables'] as const)(
    'writes existing canonical %s tables with bounded scope',
    async (method) => {
      const { db, queries } = scriptedKysely((query) =>
        query.sql.includes('to_regclass') ? { rows: [{ table: 'present' }] } : {},
      );
      const repo = new TagSync(db);
      await expect(
        method === 'reset' ? repo.reset('session-id') : repo.cleanupAuditTables(30),
      ).resolves.toBeUndefined();
      const deletes = queries.filter(({ sql }) => sql.startsWith('delete from'));
      expect(deletes.length).toBeGreaterThan(0);
      if (method === 'reset') {
        expect(deletes).toHaveLength(1);
        expect(deletes[0].sql).toContain('session_tag_sync_state');
        expect(deletes[0].sql).toContain('"sessionId" =');
        expect(deletes[0].parameters).toContain('session-id');
      } else {
        expect(deletes.map(({ sql }) => sql)).toEqual(
          expect.arrayContaining([
            expect.stringContaining('"tag_audit"'),
            expect.stringContaining('"tag_asset_audit"'),
            expect.stringContaining('"pet_audit"'),
            expect.stringContaining('"pet_observation_audit"'),
          ]),
        );
        for (const query of deletes) {
          expect(query.sql).toContain('"deletedAt" <');
          expect(query.parameters).toContain(30);
        }
      }
    },
  );
});

const newestKinds = [
  ['tag', 'tag', 'TagV1'],
  ['assetTag', 'tag_asset', 'AssetTagV1'],
  ['pet', 'pet', 'PetV1'],
  ['petObservation', 'pet_observation', 'PetObservationV1'],
  ['spaceMember', 'album_user', 'SharedSpaceMemberV1'],
] as const;

it.each(newestKinds)('orders fresh %s by source before opaque event IDs', async (kind, table) => {
  const { db, queries } = scriptedKysely();
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
    return {};
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

it.each([
  SyncEntityType.MemoryV1,
  SyncEntityType.MemoryDeleteV1,
  SyncEntityType.MemoryToAssetV1,
  SyncEntityType.MemoryToAssetDeleteV1,
])('ignores a late legacy %s ACK without persisting a stale checkpoint', async (type) => {
  const { db, queries } = scriptedKysely();
  await expect(
    new TagSync(db).acknowledge(authStub.user1.session!.id, {
      type,
      updateId: '00000000-0000-7000-8000-000000000001',
    }),
  ).resolves.toBe(true);
  expect(queries).toEqual([]);
});

it.each(['memory', 'memoryAsset'] as const)(
  'scopes %s reconciliation to the owner and rejects any hidden source',
  async (kind) => {
    const { db, queries } = scriptedKysely();
    await new TagSync(db).reconcile(authStub.user1, kind);
    const projection = queries.find(({ sql }) => sql.includes('from "memory"'))!;
    expect(projection.sql).toContain('"memory"."ownerId" =');
    expect(projection.parameters).toContain(authStub.user1.user.id);
    expect(projection.sql).toContain('hidden_memory_asset');
    expect(projection.sql).toContain('asset_lock');
  },
);
