import * as fs from 'node:fs/promises';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  BUDDY_CAPTURE_LOCK,
  PhysicalFileRepository,
  recoverFileTrashMoves,
  withFileTrashMove,
} from 'src/repositories/physical-file.repository.js';
import { ScriptedQuery, scriptedKysely } from 'test/scripted-kysely.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

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
    const unlink = vi.fn(() => {
      const statements = queries.map(({ sql }) => sql);
      expect(statements[0]).toBe('begin');
      expect(queries.find(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'))?.parameters).toContain(
        BUDDY_CAPTURE_LOCK,
      );
      expect(statements.some((sql) => sql.includes('pg_advisory_xact_lock('))).toBe(true);
      expect(statements).not.toContain('commit');
      return Promise.resolve();
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
      new PhysicalFileRepository(db).deleteUnreferencedPath(path, () => Promise.reject(new Error('disk failure'))),
    ).rejects.toThrow('disk failure');
    expect(queries.at(-1)?.sql).toBe('rollback');
    expect(queries.some(({ sql }) => sql === 'commit')).toBe(false);
  });
});

describe('file trash recovery storage errors', () => {
  it.each(['EACCES', 'EIO'])('retains the journal when path inspection returns %s', async (code) => {
    const intent = { id: 'intent-id', oldPath: path, newPath: '/data/file-trash/intent/photo.jpg' };
    const { db, queries } = scriptedKysely((query) => {
      if (query.sql.includes('SELECT id, "oldPath", "newPath"')) return { rows: [intent] };
      if (query.sql.includes('FOR UPDATE')) return { rows: [{ id: intent.id }] };
      return referenceAnswer(1)(query);
    });
    const inspection = vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error(code), { code }));
    const move = vi.fn();
    try {
      await expect(recoverFileTrashMoves(db, move)).rejects.toThrow(code);
      expect(move).not.toHaveBeenCalled();
      expect(queries.some(({ sql }) => sql.includes('DELETE FROM public.move_history'))).toBe(false);
      expect(queries.at(-1)?.sql).toBe('rollback');
    } finally {
      inspection.mockReset();
    }
  });
});

it('reserves before a transaction and refuses a reservation that recovery already cleared', async () => {
  StorageCore.setMediaLocation('/data');
  const { db, queries } = scriptedKysely();
  const callback = vi.fn().mockResolvedValue(undefined);
  await expect(withFileTrashMove(db, path, 'photo.jpg', vi.fn(), callback)).rejects.toThrow('reservation changed');
  expect(callback).not.toHaveBeenCalled();
  const journal = queries.findIndex(({ sql }) => sql.includes('INSERT INTO public.move_history'));
  const transaction = queries.findIndex(({ sql }) => sql === 'begin');
  expect(journal).toBeGreaterThanOrEqual(0);
  expect(journal).toBeLessThan(transaction);
});
