import * as fs from 'node:fs/promises';
import { DatabaseLock } from 'src/enum.js';
import { PhysicalFileTrashRepository } from 'src/repositories/physical-file-trash.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

it.each(['delete', 'move-acknowledgement', 'registration'])(
  'returns a moved original to its trash path after %s failure',
  async (failureAt) => {
    const entry = {
      id: 'trash-id',
      path: '/data/file-trash/trash-id/photo.jpg',
      originalFileName: 'photo.jpg',
      checksum: Buffer.alloc(32, 7),
    };
    const target = '/data/upload/owner/restored.jpg';
    const files = new Set([entry.path]);
    const failure = new Error('trash entry deletion failed');
    let intent: { id: string; oldPath: string; newPath: string } | undefined;
    const { db, queries } = scriptedKysely(({ sql, parameters }) => {
      if (sql.includes('INSERT INTO public.move_history')) {
        intent = { id: String(parameters[0]), oldPath: String(parameters[2]), newPath: String(parameters[3]) };
      }
      if (sql.includes('SELECT id, "oldPath", "newPath"')) return { rows: intent ? [intent] : [] };
      if (sql.includes('FROM public.move_history') && sql.includes('FOR UPDATE'))
        return { rows: intent ? [{ id: intent.id }] : [] };
      if (sql.includes('DELETE FROM public.move_history')) intent = undefined;
      if (sql.includes('count('))
        return { rows: [{ count: sql.includes('public.physical_file_trash trashed') ? '1' : '0' }] };
      if (
        sql.trimStart().startsWith('SELECT') &&
        sql.includes('FROM public.physical_file_trash') &&
        !sql.includes('count(')
      ) {
        return { rows: [entry] };
      }
      if (failureAt === 'delete' && sql.includes('DELETE FROM public.physical_file_trash')) throw failure;
    });
    const move = vi.fn((from: string, to: string) =>
      Promise.try(() => {
        if (!files.delete(from)) throw new Error('source missing');
        files.add(to);
        if (failureAt === 'move-acknowledgement' && from === entry.path) throw failure;
      }),
    );

    const inspection = vi.mocked(fs.lstat).mockImplementation((path) =>
      Promise.try(() => {
        if (!files.has(String(path))) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return {} as never;
      }),
    );
    onTestFinished(() => {
      inspection.mockReset();
    });

    await expect(
      new PhysicalFileTrashRepository(db).untrash(entry.id, target, move, () =>
        Promise.try(() => {
          expect(
            queries.some(({ sql }) => sql.includes('DELETE FROM public.physical_file_trash') || sql === 'commit'),
          ).toBe(false);
          if (failureAt === 'registration') throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    expect(queries.some(({ sql }) => sql === 'rollback')).toBe(true);
    expect(intent).toBeUndefined();
    const checksumLock = queries.findIndex(
      ({ sql, parameters }) =>
        sql.includes('pg_advisory_xact_lock(') && parameters[0] === DatabaseLock.UniversalStorageChecksum,
    );
    const pathLock = queries.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock_shared'));
    expect(checksumLock).toBeGreaterThanOrEqual(0);
    expect(checksumLock).toBeLessThan(pathLock);
    expect(queries.findIndex(({ sql }) => sql.includes('INSERT INTO public.move_history'))).toBeLessThan(
      queries.findIndex(({ sql }) => sql === 'begin'),
    );
    expect(files).toEqual(new Set([entry.path]));
    expect(move).toHaveBeenLastCalledWith(target, entry.path);
  },
);
