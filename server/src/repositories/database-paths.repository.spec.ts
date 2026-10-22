import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('binds literal folder paths and limits all five updates to folder boundaries', async () => {
  const source = "/old/猫🍁'[]%_";
  const target = String.raw`/new/💾\1'folder`;
  const { db, queries } = scriptedKysely();
  try {
    const repository = new DatabaseRepository(db, { setContext: vi.fn() } as never, undefined as never);
    await repository.migrateFilePaths(source + '/', target + '/');
    expect(queries).toHaveLength(7);
    expect(queries[0].sql).toBe('begin');
    expect(queries.at(-1)?.sql).toBe('commit');
    for (const query of queries.slice(1, -1)) {
      expect(query.sql).toContain('starts_with(');
      expect(query.sql).toContain('char_length(');
      expect(query.sql).not.toContain(source);
      expect(query.sql).not.toContain(target);
      expect(query.parameters).toEqual([target, source, source, source + '/']);
    }
  } finally {
    await db.destroy();
  }
});
