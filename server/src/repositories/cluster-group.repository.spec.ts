import { publicationTransaction } from 'src/queue/transaction.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('cluster membership existence query', () => {
  it.each([{ rows: [] }, { rows: [{ id: 'other-user' }] }])(
    'preserves membership filters and bounds returned rows for $rows',
    async ({ rows }) => {
      const { db, queries } = scriptedKysely(() => ({ rows }));
      try {
        const repository = new ClusterGroupRepository(db);
        await expect(repository.hasOtherMembers({ clusterGroupId: 'group', userId: 'current-user' })).resolves.toBe(
          rows.length > 0,
        );
        expect(queries).toHaveLength(1);
        expect(queries[0].sql).toContain('"user"."clusterGroupId" = $1');
        expect(queries[0].sql).toContain('"user"."id" != $2');
        expect(queries[0].sql).toContain('"user"."deletedAt" is null');
        expect(queries[0].sql).toMatch(/limit \$3$/);
        expect(queries[0].parameters).toEqual(['group', 'current-user', 1]);
      } finally {
        await db.destroy();
      }
    },
  );
});

it.each([false, true])('shares person/user/group writes in one transaction; user failure=%s', async (fail) => {
  const error = new Error('membership update failed');
  const { db, queries } = scriptedKysely(({ sql }) => {
    if (sql.startsWith('select "id" from "cluster_group"')) return { rows: [{ id: 'source' }] };
    if (sql.startsWith('select "clusterGroupId" from "user"')) return { rows: [{ clusterGroupId: 'source' }] };
    if (fail && sql.startsWith('update "user"')) throw error;
    return { rows: [{ id: 'target' }] };
  });
  try {
    const groups = new ClusterGroupRepository(db);
    const change = groups.withMembershipChange('user', async (source) => {
      expect(source).toBe('source');
      expect(publicationTransaction.getStore()).toBeDefined();
      await new PersonRepository(db).reassignCluster({ userId: 'user', newClusterId: 'target' });
      await new UserRepository(db).update('user', { clusterGroupId: 'target' });
      await groups.deleteRequest('request');
    });
    if (fail) await expect(change).rejects.toBe(error);
    else await expect(change).resolves.toBeUndefined();
    expect(queries.filter(({ sql }) => sql === 'begin')).toHaveLength(1);
    expect(queries[1].sql).toContain('for no key update');
    expect(queries[2].sql).toContain('for update');
    expect(queries.at(-1)?.sql).toBe(fail ? 'rollback' : 'commit');
    expect(queries.some(({ sql }) => sql.startsWith('delete from "cluster_group_request"'))).toBe(!fail);
    expect(publicationTransaction.getStore()).toBeUndefined();
  } finally {
    await db.destroy();
  }
});

it('rejects a membership changed while waiting for the source-group lock', async () => {
  const { db, queries } = scriptedKysely(({ sql }) => ({
    rows: sql.includes('from "cluster_group"') ? [{ id: 'source' }] : [{ clusterGroupId: 'changed' }],
  }));
  const change = vi.fn();
  try {
    await expect(new ClusterGroupRepository(db).withMembershipChange('user', change)).rejects.toThrow(
      'Cluster membership changed',
    );
    expect(change).not.toHaveBeenCalled();
    expect(queries.at(-1)?.sql).toBe('rollback');
  } finally {
    await db.destroy();
  }
});
