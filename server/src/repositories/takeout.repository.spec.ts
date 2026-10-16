import { TakeoutNotFound, TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('Takeout account admission transaction', () => {
  const fixture = (owner = true, imported = true) => {
    const quota = { quotaSizeInBytes: 10, quotaUsageInBytes: 8 };
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('from "user"')) return { rows: owner ? [quota] : [] };
      if (query.sql.includes('from takeout_import'))
        return {
          rows: imported
            ? [
                {
                  id: 'import',
                  ownerId: 'owner',
                  name: 'Import',
                  phase: 'sources',
                  options: {},
                  createdAt: new Date(0),
                  updatedAt: new Date(0),
                },
              ]
            : [],
        };
      return { rows: [] };
    });
    return { db, queries, quota, sut: new TakeoutRepository(db) };
  };

  it('locks the current owner before the import and passes fresh quota to admission', async () => {
    const f = fixture();
    try {
      await expect(f.sut.withImport('owner', 'import', async (_tx, _row, _operation, quota) => quota)).resolves.toEqual(
        f.quota,
      );
      const owner = f.queries.findIndex((query) => query.sql.includes('from "user"'));
      const imported = f.queries.findIndex((query) => query.sql.includes('from takeout_import'));
      expect(owner).toBeGreaterThanOrEqual(0);
      expect(owner).toBeLessThan(imported);
      expect(f.queries[owner].sql).toContain('for no key update');
      expect(f.queries[owner].parameters).toEqual(['owner']);
      expect(f.queries.at(-1)!.sql).toBe('commit');
    } finally {
      await f.db.destroy();
    }
  });

  it('refuses a missing owner before touching the import or callback', async () => {
    const f = fixture(false),
      callback = vi.fn();
    try {
      await expect(f.sut.withImport('owner', 'import', callback)).rejects.toBeInstanceOf(TakeoutNotFound);
      expect(callback).not.toHaveBeenCalled();
      expect(f.queries.some((query) => query.sql.includes('from takeout_import'))).toBe(false);
      expect(f.queries.at(-1)!.sql).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });

  it('keeps another owner’s or missing import invisible', async () => {
    const f = fixture(true, false),
      callback = vi.fn();
    try {
      await expect(f.sut.withImport('owner', 'import', callback)).rejects.toBeInstanceOf(TakeoutNotFound);
      expect(callback).not.toHaveBeenCalled();
    } finally {
      await f.db.destroy();
    }
  });

  it('rolls back the owner/import transaction when admission fails', async () => {
    const f = fixture();
    try {
      await expect(
        f.sut.withImport('owner', 'import', async () => {
          throw new Error('admission failed');
        }),
      ).rejects.toThrow('admission failed');
      expect(f.queries.at(-1)!.sql).toBe('rollback');
    } finally {
      await f.db.destroy();
    }
  });
});
