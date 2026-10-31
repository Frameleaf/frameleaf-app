import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetLockReason } from 'src/enum.js';
import { MediaRecoveryRepository } from 'src/repositories/media-recovery.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('recovery copy protection', () => {
  it('does not read protection when the owned source row is unavailable', async () => {
    const { db, queries } = scriptedKysely();
    const repository = new MediaRecoveryRepository(db) as unknown as {
      inheritedProtection: (db: Kysely<DB>, ownerId: string, assetId: string) => Promise<AssetLockReason | undefined>;
    };
    expect(await repository.inheritedProtection(db, 'owner', 'source')).toBeUndefined();
    expect(queries.some((query) => query.sql.includes('asset_lock'))).toBe(false);
  });

  it.each([
    [AssetLockReason.Detected, false, AssetLockReason.Detected],
    [null, true, AssetLockReason.Marked],
    [null, false, undefined],
  ])('reads current protection after acquiring the source row (%s, %s)', async (lockReason, hidden, expected) => {
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('from "asset"') && /for share/i.test(query.sql)) return { rows: [{ id: 'source' }] };
      if (query.sql.includes('asset_lock')) return { rows: [{ lockReason, hidden }] };
      return {};
    });
    const repository = new MediaRecoveryRepository(db) as unknown as {
      inheritedProtection: (db: Kysely<DB>, ownerId: string, assetId: string) => Promise<AssetLockReason | undefined>;
    };

    expect(await repository.inheritedProtection(db, 'owner', 'source')).toBe(expected);
    const acquired = queries.findIndex((query) => query.sql.includes('from "asset"') && /for share/i.test(query.sql));
    const protection = queries.findIndex((query) => query.sql.includes('asset_lock'));
    expect(acquired).toBeGreaterThanOrEqual(0);
    expect(protection).toBeGreaterThan(acquired);
    expect(queries[acquired].sql).not.toContain('asset_lock');
    expect(queries[acquired].parameters).toEqual(['source', 'owner']);
  });
});
