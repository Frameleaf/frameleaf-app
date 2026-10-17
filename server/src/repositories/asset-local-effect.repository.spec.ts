import { randomUUID } from 'node:crypto';
import { AssetStatus } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('local lock effect envelopes', () => {
  const fixture = () => {
    const ownerId = randomUUID(),
      assetId = randomUUID(),
      streamEpoch = randomUUID();
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('from "asset"'))
        return { rows: [{ id: assetId, ownerId, status: AssetStatus.Active, deletedAt: null }] };
      if (query.sql.startsWith('INSERT INTO asset_local_effect_stream')) return { rows: [{ ownerId }] };
      if (query.sql.includes('SELECT "streamEpoch","nextSequence"')) return { rows: [{ streamEpoch, sequence: '1' }] };
      if (query.sql.includes('SELECT a.id AS "assetId"')) return { rows: [{ assetId, ownerId, epoch: '0' }] };
      return { rows: [] };
    });
    return { db, queries, ownerId, assetId, streamEpoch };
  };

  it('accepts a proven lock cascade without inventing a status change or issuing an empty IN clause', async () => {
    const f = fixture();
    try {
      const bundle = await f.db.transaction().execute((tx) =>
        new AssetLocalEffectRepository(f.db).append(tx, f.ownerId, randomUUID(), {
          origin: { kind: 'lock' },
          assets: [],
          stacks: [],
          lockedCascade: { assetIds: [f.assetId], interactiveAdmissions: [] },
        }),
      );
      expect(bundle).toMatchObject({
        origin: { kind: 'lock' },
        assets: [],
        revocations: [],
        lockedCascade: { assetIds: [f.assetId], interactiveAdmissions: [] },
      });
      expect(f.queries.some((query) => query.sql.includes('in ()'))).toBe(false);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it('preserves existing status-change envelopes and source epochs', async () => {
    const f = fixture();
    try {
      const bundle = await f.db.transaction().execute((tx) =>
        new AssetLocalEffectRepository(f.db).append(tx, f.ownerId, randomUUID(), {
          origin: { kind: 'restore' },
          assets: [{ assetId: f.assetId, status: AssetStatus.Active, revoke: false }],
          stacks: [],
        }),
      );
      expect(bundle.assets).toEqual([{ assetId: f.assetId, status: AssetStatus.Active, sourceEpoch: '0' }]);
      expect(bundle.revocations).toEqual([]);
    } finally {
      await f.db.destroy();
    }
  });
});
