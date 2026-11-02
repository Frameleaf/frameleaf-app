import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it.each(['copying', 'verifying', 'abandoned'])('blocks startup during a generic %s import', async (status) => {
  const { db } = scriptedKysely(({ sql }) => ({
    rows: sql.includes('frameleaf_library_import') ? [{ status }] : [],
  }));
  try {
    const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, {} as never);
    await expect(repository.assertImportActivated()).rejects.toThrow('DESTINATION_IMPORT_NOT_ACTIVATED');
  } finally {
    await db.destroy();
  }
});

it.each([null, 'activated'])('permits startup when generic import state is %s', async (status) => {
  const { db } = scriptedKysely(({ sql }) => ({
    rows: status && sql.includes('frameleaf_library_import') ? [{ status }] : [],
  }));
  try {
    const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, {} as never);
    await expect(repository.assertImportActivated()).resolves.toBeUndefined();
  } finally {
    await db.destroy();
  }
});
