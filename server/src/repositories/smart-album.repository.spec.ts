import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('smart album final exclusion admission', () => {
  it.each([false, true])('adds a late match only when excluded=%s is false', async (excluded) => {
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "smart_album"')) return { rows: [{ albumId: 'album' }] };
      if (sql.includes('from "smart_album_exclusion"')) return { rows: excluded ? [{ smartAlbumId: 'smart' }] : [] };
      return {};
    });
    try {
      await new SmartAlbumRepository(db).addAssetToSmartAlbum('smart', 'asset', 'tag');
      const inserts = queries.filter(({ sql }) => sql.startsWith('insert into'));
      expect(inserts).toHaveLength(excluded ? 0 : 2);
      expect(queries.at(-1)?.sql).toBe('commit');
      const lock = queries.findIndex(({ sql }) => sql.includes('from "asset"') && sql.endsWith('for update'));
      const admission = queries.findIndex(({ sql }) => sql.includes('from "smart_album_exclusion"'));
      expect(lock).toBeGreaterThan(-1);
      expect(admission).toBeGreaterThan(lock);
    } finally {
      await db.destroy();
    }
  });
});
