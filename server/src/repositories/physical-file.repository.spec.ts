import { BUDDY_CAPTURE_LOCK, PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { ScriptedQuery, scriptedKysely } from 'test/scripted-kysely.js';

const path = '/data/library/owner/2024/photo.jpg';
const referenceAnswer =
  (retained = 0) =>
  (query: ScriptedQuery) => {
    if (query.sql.includes('public.buddy_backup_reference')) {
      return { rows: [{ count: String(retained) }] };
    }
    if (query.sql.includes('count(')) {
      return { rows: [{ count: '0' }] };
    }
  };

describe(PhysicalFileRepository.name, () => {
  it('retains a path pinned by a saved output or Buddy capture', async () => {
    const { db } = scriptedKysely(referenceAnswer(1));
    const unlink = vi.fn().mockResolvedValue(undefined);
    await expect(new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink)).resolves.toEqual({
      deleted: false,
      references: 1,
    });
    expect(unlink).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced path inside the Buddy and path locks', async () => {
    const { db, queries } = scriptedKysely(referenceAnswer());
    const unlink = vi.fn(async () => {
      const statements = queries.map(({ sql }) => sql);
      expect(statements[0]).toBe('begin');
      expect(queries.find(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'))?.parameters).toContain(
        BUDDY_CAPTURE_LOCK,
      );
      expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock('))).toBe(true);
      expect(statements).not.toContain('commit');
    });
    await expect(new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink)).resolves.toEqual({
      deleted: true,
      references: 0,
    });
    expect(unlink).toHaveBeenCalledTimes(1);
    expect(queries.at(-1)?.sql).toBe('commit');
  });

  it('keeps a queued deletion when the asset removal rolled back', async () => {
    const { db } = scriptedKysely((query) =>
      query.sql.startsWith('select "id" from "asset"') ? { rows: [{ id: 'asset-id' }] } : referenceAnswer()(query),
    );
    const unlink = vi.fn().mockResolvedValue(undefined);
    await expect(
      new PhysicalFileRepository(db).deleteUnreferencedPath(path, unlink, { removedAssetId: 'asset-id' }),
    ).resolves.toEqual({ deleted: false, references: 1 });
    expect(unlink).not.toHaveBeenCalled();
  });

  it('rolls back the physical row cleanup when unlink fails', async () => {
    const { db, queries } = scriptedKysely(referenceAnswer());
    await expect(
      new PhysicalFileRepository(db).deleteUnreferencedPath(path, async () => {
        throw new Error('disk failure');
      }),
    ).rejects.toThrow('disk failure');
    expect(queries.at(-1)?.sql).toBe('rollback');
    expect(queries.some(({ sql }) => sql === 'commit')).toBe(false);
  });
});
