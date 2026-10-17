import { AlbumRepository } from 'src/repositories/album.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each([true, false])('checks for a committed rule after locking the album (rule exists: %s)', async (exists) => {
  const { db, queries } = scriptedKysely((query) => {
    if (query.sql.startsWith('select') && query.sql.includes('from "album"')) return { rows: [{ id: 'album' }] };
    if (query.sql.includes('from "classification_rule"')) return { rows: exists ? [{ id: 'rule' }] : [] };
    return { rows: [] };
  });
  const repository = new AlbumRepository(db);
  const remove = vi.spyOn(repository as unknown as { deleteIn: () => Promise<void> }, 'deleteIn').mockResolvedValue();
  await repository.deleteFailedClassificationAlbum('album', 'owner');
  const lock = queries.findIndex((query) => query.sql.includes('from "album"'));
  const check = queries.findIndex((query) => query.sql.includes('from "classification_rule"'));
  expect(lock).toBeGreaterThan(0);
  expect(queries[lock].sql).toContain('for update');
  expect(queries[lock].parameters).toContain('owner');
  expect(check).toBeGreaterThan(lock);
  expect(remove).toHaveBeenCalledTimes(exists ? 0 : 1);
  await db.destroy();
});
