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

describe('universal storage upload linking from the file trash', () => {
  const checksum = Buffer.alloc(32, 9);
  const upload = '/data/upload/owner/aa/bb/upload.jpg';
  const trashed = { id: '00000000-0000-4000-8000-000000000009', path: '/data/file-trash/trash-id/photo.jpg' };
  const script = (failAt?: string) =>
    scriptedKysely(({ sql }) => {
      if (failAt && sql.includes(failAt)) {
        throw new Error('registration failed');
      }
      if (sql.startsWith('select "asset"."id", "asset"."originalPath"') && sql.endsWith('for update')) {
        return { rows: [{ id: 'asset-id', originalPath: upload, physicalOriginalFileId: null }] };
      }
      if (sql.includes('FROM public.physical_file_trash')) {
        return { rows: [trashed] };
      }
      if (sql.startsWith('insert into "physical_file"')) {
        return { rows: [{ id: 'physical-id', path: '/data/upload/owner/aa/bb/upload-restored.jpg' }] };
      }
    });
  const options = (untrash: (from: string, to: string) => Promise<void>) => ({
    verify: vi.fn(),
    identify: vi.fn(),
    untrash,
  });

  it('takes the trashed copy back and links the upload to it', async () => {
    const { db, queries } = script();
    const untrash = vi.fn().mockResolvedValue(undefined);
    await expect(
      new PhysicalFileRepository(db).linkUploadedOriginal('asset-id', { checksum, sizeInBytes: 10 }, options(untrash)),
    ).resolves.toMatchObject({ linked: true });
    expect(untrash).toHaveBeenCalledExactlyOnceWith(trashed.path, '/data/upload/owner/aa/bb/upload-restored.jpg');
    expect(queries.at(-1)?.sql).toBe('commit');
  });

  it('puts the file back in the trash when the link cannot be recorded', async () => {
    const { db, queries } = script('insert into "physical_file"');
    const untrash = vi.fn().mockResolvedValue(undefined);
    await expect(
      new PhysicalFileRepository(db).linkUploadedOriginal('asset-id', { checksum, sizeInBytes: 10 }, options(untrash)),
    ).rejects.toThrow('registration failed');
    expect(untrash.mock.calls).toEqual([
      [trashed.path, '/data/upload/owner/aa/bb/upload-restored.jpg'],
      ['/data/upload/owner/aa/bb/upload-restored.jpg', trashed.path],
    ]);
    expect(queries.at(-1)?.sql).toBe('rollback');
  });
});
