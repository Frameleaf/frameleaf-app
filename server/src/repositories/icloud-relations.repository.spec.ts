import { AssetType, AssetVisibility } from 'src/enum.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('iCloud Live Photo lock records', () => {
  const fixture = (locked: string[]) => {
    let pending = true;
    let state: Record<string, unknown> | undefined;
    const original = {
      id: 'original-resource',
      sourceAssetId: 'logical',
      assetId: 'still',
      signature: 'current',
      source: {},
    };
    const resources = [
      { ...original, libraryKey: 'private', role: 'original', status: 'finalized', sha256: null },
      {
        id: 'motion-resource',
        sourceAssetId: 'logical',
        assetId: 'motion',
        libraryKey: 'private',
        role: 'motion',
        status: 'finalized',
        sha256: null,
        source: {},
      },
    ];
    const targets = [
      {
        id: 'still',
        ownerId: 'owner',
        type: AssetType.Image,
        stackId: null,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      },
      {
        id: 'motion',
        ownerId: 'owner',
        type: AssetType.Video,
        stackId: null,
        livePhotoVideoId: null,
        visibility: AssetVisibility.Timeline,
      },
    ];
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.startsWith('SELECT DISTINCT ON')) return { rows: pending ? [original] : [] };
      if (query.sql.startsWith('SELECT DISTINCT upper')) return { rows: [{ item: 'LOGICAL' }] };
      if (query.sql.includes('SELECT r.id,r."sourceAssetId"')) return { rows: resources };
      if (query.sql.includes('SELECT id FROM public.icloud_connection')) return { rows: [{ id: 'connection' }] };
      if (query.sql.includes('FROM asset\n')) return { rows: targets };
      if (query.sql.includes('from "asset_lock"')) return { rows: locked.map((assetId) => ({ assetId })) };
      if (query.sql.startsWith('UPDATE public.icloud_resource SET source=')) {
        state = query.parameters.find((value) => value && typeof value === 'object' && 'signature' in value) as Record<
          string,
          unknown
        >;
        pending = false;
      }
      return { rows: [] };
    });
    return { db, queries, sut: new ICloudRelationsRepository(db), state: () => state };
  };

  it.each([['still'], ['motion']])('refuses a mixed pair when %s alone has a real lock record', async (...locked) => {
    const f = fixture(locked);
    try {
      await expect(f.sut.reconcile('connection', 'owner')).resolves.toBe(true);
      expect(f.state()).toMatchObject({ status: 'needs-review', reason: 'motion_visibility_override', events: [] });
      expect(f.queries.some((query) => query.sql.startsWith('update "asset"'))).toBe(false);
      const lockRead = f.queries.findIndex((query) => query.sql.includes('from "asset_lock"'));
      const rowLock = f.queries.findIndex((query) => query.sql.includes('FROM asset\n'));
      expect(lockRead).toBeGreaterThan(rowLock);
    } finally {
      await f.db.destroy();
    }
  });

  it.each([[], ['still', 'motion']])('retains valid pairing for matching lock classes %j', async (...locked) => {
    const f = fixture(locked);
    try {
      await expect(f.sut.reconcile('connection', 'owner')).resolves.toBe(true);
      expect(f.state()).toMatchObject({
        status: 'applied',
        motionAssetId: 'motion',
        events: [{ name: 'AssetHide', assetId: 'motion', userId: 'owner' }],
      });
      expect(f.queries.filter((query) => query.sql.startsWith('update "asset"'))).toHaveLength(2);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });
});
