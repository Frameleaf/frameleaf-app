import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ICloudAlbumRepository, mergeICloudAlbum } from 'src/repositories/icloud-album.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('manual album membership ownership', () => {
  it.each(['single', 'all'])('ends iCloud provenance only for memberships actually removed by %s', async (mode) => {
    let syncOwned = true;
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.startsWith('select') && query.sql.includes('from "album_asset"'))
        return { rows: [{ albumId: 'album' }] };
      if (query.sql.startsWith('delete from "album_asset"')) return { rows: [{ albumId: 'album', assetId: 'asset' }] };
      if (/UPDATE public\.icloud_membership/.test(query.sql)) syncOwned = false;
      return { rows: [] };
    });
    try {
      const albums = new AlbumRepository(db);
      if (mode === 'single') await albums.removeAssetIds('album', ['asset']);
      else await albums.removeAssetsFromAll(['asset']);
      expect(syncOwned).toBe(false);
      const update = queries.find((query) => query.sql.includes('UPDATE public.icloud_membership'))!;
      expect(update.sql).toContain('"addedBySync"=false');
      expect(update.parameters).toContainEqual(['album']);
      expect(update.parameters).toContainEqual(['asset']);
      expect(queries.at(-1)!.sql).toBe('commit');
    } finally {
      await db.destroy();
    }
  });

  it('does not take ownership from a membership that was not removed', async () => {
    const { db, queries } = scriptedKysely();
    try {
      await new AlbumRepository(db).removeAssetIds('album', ['missing']);
      expect(queries.some((query) => query.sql.includes('icloud_membership'))).toBe(false);
    } finally {
      await db.destroy();
    }
  });
});

describe('iCloud membership serialization', () => {
  const fixture = (change: 'manual' | 'mapping' | 'none') => {
    let locked = false;
    let present = true;
    const row = {
      libraryKey: 'private',
      sourceAlbumId: 'source-album',
      sourceAssetId: 'source-asset',
      albumId: 'album',
      assetId: 'asset',
      addedBySync: true,
      sourcePresent: false,
      targetAlbumId: 'album',
      targetAssetId: null,
    };
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('FROM public.icloud_connection'))
        return { rows: [{ label: 'Family', config: ICloudConfigSchema.parse({}) }] };
      if (query.sql.startsWith('SELECT * FROM public.icloud_album'))
        return { rows: [{ albumId: 'container', source: {} }] };
      if (query.sql.includes('SELECT a.id,a."albumName"')) return { rows: [{ id: 'container' }] };
      if (query.sql.includes('for no key update')) {
        locked = true;
        return { rows: [{ id: 'album' }] };
      }
      if (query.sql.startsWith('SELECT m.*'))
        return {
          rows:
            locked && change === 'manual'
              ? []
              : [{ ...row, targetAlbumId: locked && change === 'mapping' ? 'new-album' : row.targetAlbumId }],
        };
      if (query.sql.startsWith('DELETE FROM album_asset')) present = false;
      return { rows: [] };
    });
    return { db, queries, sut: new ICloudAlbumRepository(db), present: () => present };
  };

  it('rereads provenance after the manual remove/readd finishes under the same album lock', async () => {
    const f = fixture('manual');
    try {
      await expect(f.sut.reconcile('connection', 'owner')).resolves.toBe(true);
      expect(f.present()).toBe(true);
      expect(f.queries.filter((query) => query.sql.startsWith('SELECT m.*'))).toHaveLength(2);
      expect(f.queries.some((query) => query.sql.startsWith('DELETE FROM album_asset'))).toBe(false);
    } finally {
      await f.db.destroy();
    }
  });

  it('refuses a newly mapped album outside the locked set before any membership writes', async () => {
    const f = fixture('mapping');
    try {
      await expect(f.sut.reconcile('connection', 'owner')).rejects.toThrow('icloud_album_membership_changed');
      expect(f.present()).toBe(true);
      expect(f.queries.at(-1)!.sql).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });

  it('still removes an unchanged sync-owned membership after locking and rechecking it', async () => {
    const f = fixture('none');
    try {
      await expect(f.sut.reconcile('connection', 'owner')).resolves.toBe(true);
      expect(f.present()).toBe(false);
      const lock = f.queries.findIndex((query) => query.sql.includes('for no key update'));
      const remove = f.queries.findIndex((query) => query.sql.startsWith('DELETE FROM album_asset'));
      expect(lock).toBeGreaterThan(-1);
      expect(remove).toBeGreaterThan(lock);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it('preserves local album overrides and resumes remote values only when the applied baseline matches', () => {
    const remote = { name: 'remote', parentId: 'remote-parent', parentSourceId: 'remote-source' };
    const previous = { appliedName: 'old', appliedParentId: 'old-parent' };
    expect(mergeICloudAlbum({ albumName: 'local', parentId: null }, remote, previous)).toMatchObject({
      albumName: 'local',
      parentId: null,
      state: previous,
    });
    expect(mergeICloudAlbum({ albumName: 'old', parentId: 'old-parent' }, remote, previous)).toMatchObject({
      albumName: 'remote',
      parentId: 'remote-parent',
      state: { appliedName: 'remote', appliedParentId: 'remote-parent' },
    });
  });
});
