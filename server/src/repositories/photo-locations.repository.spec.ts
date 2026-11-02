import { PhotoLocationsRepository } from 'src/repositories/photo-locations.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('photo location publication', () => {
  it('locks the scan before touching any photo and refuses a cancelled lease', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [] }));
    try {
      expect(
        await new PhotoLocationsRepository(db).adopt('scan', 'lease', [{ itemKey: 'opaque', state: 'unmatched' }]),
      ).toBe(false);
      expect(queries.some(({ sql }) => sql.includes('insert into "asset_location_insight"'))).toBe(false);
      expect(queries.some(({ sql }) => sql.includes('photo_location_scan') && sql.includes('for update'))).toBe(true);
    } finally {
      await db.destroy();
    }
  });

  it('limits every user status lookup to its owner', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [] }));
    try {
      expect(await new PhotoLocationsRepository(db).latest('owner')).toBeUndefined();
      expect(queries[0].sql).toContain('"ownerId" = $1');
      expect(queries[0].parameters).toContain('owner');
    } finally {
      await db.destroy();
    }
  });
});
