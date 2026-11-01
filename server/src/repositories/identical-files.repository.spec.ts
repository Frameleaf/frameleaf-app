import { IdenticalFilesRepository } from 'src/repositories/identical-files.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe(IdenticalFilesRepository.name, () => {
  it('never counts a file an encrypted Locked item reads as an extra copy (FL-721)', async () => {
    const { db, queries } = scriptedKysely(() => ({ rows: [{ files: 0, contents: 0, bytes: '0' }] }));
    try {
      await new IdenticalFilesRepository(db).countExtraCopies();
      expect(queries).toHaveLength(1);
      // the same rule as `getMembers`: such a file is never merged, so it frees no space
      expect(queries[0].sql).toContain('sealed_lock');
    } finally {
      await db.destroy();
    }
  });
});
