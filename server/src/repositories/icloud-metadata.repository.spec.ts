import { randomUUID } from 'node:crypto';
import { AssetVisibility } from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('iCloud metadata lock effect transaction', () => {
  const fixture = (count = 1, failState = false) => {
    let pending = true;
    const ids = Array.from({ length: count }, () => randomUUID());
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('from "user"')) return { rows: [{ id: 'owner' }] };
      if (query.sql.includes('FROM public.icloud_connection')) return { rows: [{ id: 'connection' }] };
      if (query.sql.startsWith('SELECT DISTINCT ON'))
        return { rows: pending ? [{ id: 'resource', assetId: ids[0], signature: 'new' }] : [] };
      if (query.sql.startsWith('SELECT a."isFavorite"'))
        return {
          rows: [
            {
              isFavorite: false,
              visibility: AssetVisibility.Timeline,
              fileCreatedAt: new Date(0),
              timeZone: null,
              lockedProperties: [],
            },
          ],
        };
      if (query.sql.startsWith('SELECT source FROM')) return { rows: [{ source: { isHidden: true } }] };
      if (query.sql.startsWith('UPDATE public.icloud_resource SET source=')) {
        if (failState) throw new Error('metadata state failed');
        pending = false;
      }
      return { rows: [] };
    });
    vi.spyOn(AssetRepository.prototype, 'lock').mockResolvedValue(ids);
    vi.spyOn(AssetLocalEffectRepository, 'selectLockedAdmissions').mockImplementation((_tx, assetIds) =>
      Promise.try(() => ({
        assetIds,
        interactiveAdmissions: [],
      })),
    );
    const append = vi.spyOn(AssetLocalEffectRepository.prototype, 'append').mockImplementation((tx) =>
      Promise.try(() => {
        expect(tx.isTransaction).toBe(true);
        expect(queries.some((query) => query.sql === 'commit')).toBe(false);
        return {} as never;
      }),
    );
    return { db, queries, ids, append, sut: new ICloudMetadataRepository(db) };
  };
  afterEach(() => vi.restoreAllMocks());

  it('stages a lock effect before commit and exposes immediate-followup ids only after success', async () => {
    const f = fixture();
    const locked: string[] = [];
    try {
      await expect(f.sut.reconcile('connection', 'owner', undefined, locked)).resolves.toBe(true);
      expect(f.append).toHaveBeenCalledWith(expect.anything(), 'owner', expect.any(String), {
        origin: { kind: 'lock' },
        assets: [],
        stacks: [],
        lockedCascade: { assetIds: f.ids, interactiveAdmissions: [] },
      });
      expect(locked).toEqual(f.ids);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it('does not expose rolled-back lock ids when metadata state fails after the lock', async () => {
    const f = fixture(1, true);
    const locked: string[] = [];
    try {
      await expect(f.sut.reconcile('connection', 'owner', undefined, locked)).rejects.toThrow('metadata state failed');
      expect(locked).toEqual([]);
      expect(f.queries.at(-1)!.sql).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });

  it('rolls back the lock when durable effect insertion fails', async () => {
    const f = fixture();
    f.append.mockRejectedValueOnce(new Error('effect failed'));
    const locked: string[] = [];
    try {
      await expect(f.sut.reconcile('connection', 'owner', undefined, locked)).rejects.toThrow('effect failed');
      expect(locked).toEqual([]);
      expect(f.queries.at(-1)!.sql).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });

  it('preserves large lock groups using complete bounded outbox bundles', async () => {
    const f = fixture(205);
    try {
      await f.sut.reconcile('connection', 'owner');
      expect(f.append.mock.calls.map((call) => call[3].lockedCascade!.assetIds.length)).toEqual([100, 100, 5]);
      expect(f.append.mock.calls.flatMap((call) => call[3].lockedCascade!.assetIds)).toEqual(f.ids);
    } finally {
      await f.db.destroy();
    }
  });
});
