import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AttemptDirectoryWindows } from 'src/utils/attempt-directory.js';
import { ATTEMPT_GRACE_MS, emptyAttemptCursor, sweepAttemptTree } from 'src/utils/attempt-tree.js';

describe('bounded attempt tree traversal (real temporary files)', () => {
  let root: string;
  const now = Date.now();
  const old = new Date(now - ATTEMPT_GRACE_MS * 2);
  const file = async (path: string, age = old) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
    await utimes(path, age, age);
    return path;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'attempt-tree-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recovers one-level worker staging across bounded restart slices without admitting foreign or deeper paths', async () => {
    const jobId = randomUUID();
    const token = randomUUID();
    const base = join(root, '.attempts', jobId, token);
    const stale = await file(join(base, '.sharp-abc123', 'preview.jpg'));
    const recent = await file(join(base, '.sharp-def456', 'preview.jpg'), new Date(now));
    const protectedPaths = await Promise.all([
      file(join(base, '.sharp-short', 'preview.jpg')),
      file(join(base, '.sharp-abc123', 'deeper', 'preview.jpg')),
      file(join(base, '.sharp-abc123', '.sharp-xyz789', 'preview.jpg')),
      file(join(root, '.sharp-abc123', 'preview.jpg')),
      file(join(root, '.attempts', 'foreign', token, '.sharp-abc123', 'preview.jpg')),
    ]);
    await symlink(dirname(protectedPaths[3]), join(base, '.sharp-lnk123'));
    let cursor = emptyAttemptCursor();
    let deleted = 0;
    let done = false;
    const admitted: string[] = [];
    for (let slice = 0; slice < 50 && !done; slice++) {
      const result = await sweepAttemptTree({
        roots: [root],
        cursor: JSON.parse(JSON.stringify(cursor)),
        now,
        maxEntries: 3,
        maxFiles: 1,
        remove: async (path, identity, unlink) => {
          expect(identity).toEqual({ jobId, token });
          admitted.push(path);
          return unlink();
        },
      });
      expect(result.visited).toBeLessThanOrEqual(3);
      expect(result.examined).toBeLessThanOrEqual(1);
      deleted += result.deleted;
      cursor = result.cursor;
      done = result.done;
    }
    expect(done).toBe(true);
    expect(deleted).toBe(1);
    expect(admitted).toContain(stale);
    expect(admitted).toContain(recent);
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of [recent, ...protectedPaths]) expect(await readFile(path, 'utf8')).toBe('fixture');
    expect((await lstat(join(base, '.sharp-lnk123'))).isSymbolicLink()).toBe(true);
  });

  it('removes old empty staging through the attempt authority without removing a fresh claim directory', async () => {
    const base = join(root, '.attempts', randomUUID(), randomUUID());
    const staging = join(base, '.sharp-abc123');
    await mkdir(staging, { recursive: true });
    await utimes(staging, old, old);
    const remove = vi.fn<Parameters<typeof sweepAttemptTree>[0]['remove']>(async (_path, _identity, unlink) =>
      unlink(),
    );
    await sweepAttemptTree({ roots: [root], cursor: emptyAttemptCursor(), now, remove });
    expect(remove.mock.calls.map(([path]) => path)).toContain(staging);
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(base)).isDirectory()).toBe(true);
  });

  it('deletes only old regular files in literal attempt trees; leaves other files and symlinks untouched', async () => {
    const base = join(root, '.attempts', randomUUID(), randomUUID());
    const stale = await file(join(base, 'old.jpeg'));
    const recent = await file(join(base, 'recent.jpeg'), new Date(now));
    const ordinary = await file(join(root, 'ordinary.jpeg'));
    const similar = await file(join(root, 'attempts', randomUUID(), randomUUID(), 'old.jpeg'));
    const outside = await file(join(root, 'outside', '.attempts', randomUUID(), randomUUID(), 'image.jpeg'));
    const link = join(base, 'linked.jpeg');
    await symlink(ordinary, link);
    await symlink(join(root, 'outside'), join(base, 'linked-directory'));
    const paths: string[] = [];
    // Restrict the configured root so the symlink is the only route to outside.
    const result = await sweepAttemptTree({
      roots: [join(root, '.attempts')],
      cursor: emptyAttemptCursor(),
      now,
      remove: async (path, _identity, unlink) => {
        paths.push(path);
        return unlink();
      },
    });
    expect(result.deleted).toBe(1);
    expect(paths.filter((path) => path.endsWith('.jpeg'))).toEqual([stale, recent]);
    await expect(lstat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of [recent, ordinary, similar, outside]) expect(await readFile(path, 'utf8')).toBe('fixture');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('persists progress across new invocations, bounds each slice, and revisits a retained reference next cycle', async () => {
    const base = join(root, '.attempts', randomUUID(), randomUUID());
    const kept = await file(join(base, '0-reference.jpeg'));
    for (let index = 1; index <= 7; index++) await file(join(base, `${index}.jpeg`));
    let cursor = emptyAttemptCursor();
    let total = 0;
    let done = false;
    for (let slice = 0; slice < 20 && !done; slice++) {
      const result = await sweepAttemptTree({
        roots: [root],
        cursor: JSON.parse(JSON.stringify(cursor)),
        now,
        maxEntries: 5,
        maxFiles: 2,
        remove: async (path, _identity, unlink) => (path === kept ? false : unlink()),
      });
      expect(result.visited).toBeLessThanOrEqual(5);
      expect(result.examined).toBeLessThanOrEqual(2);
      total += result.deleted;
      cursor = result.cursor;
      done = result.done;
    }
    expect(done).toBe(true);
    expect(total).toBe(7);
    expect(await readFile(kept, 'utf8')).toBe('fixture');
    const released = await sweepAttemptTree({
      roots: [root],
      cursor,
      now,
      remove: (_path, _identity, unlink) => unlink(),
    });
    expect(released.deleted).toBe(1);
  });

  it('continues a large directory across bounded reads and refuses symlink roots or out-of-root cursors', async () => {
    const base = join(root, '.attempts', randomUUID(), randomUUID());
    for (let index = 0; index < 4; index++) await file(join(base, `${index}.jpeg`));
    const remove = vi.fn<Parameters<typeof sweepAttemptTree>[0]['remove']>(async (_path, _identity, unlink) =>
      unlink(),
    );
    const windows = new AttemptDirectoryWindows();
    try {
      const first = await sweepAttemptTree({
        roots: [base],
        cursor: emptyAttemptCursor(),
        windows,
        maxDirectoryEntries: 3,
        now,
        remove,
      });
      expect(first.done).toBe(false);
      expect(remove).not.toHaveBeenCalled();
      const next = await sweepAttemptTree({ roots: [base], cursor: first.cursor, windows, now, remove });
      expect(next.deleted).toBe(4);
    } finally {
      await windows.close();
    }
    remove.mockClear();
    const link = join(root, 'link');
    await symlink(base, link);
    const linked = await sweepAttemptTree({ roots: [link], cursor: emptyAttemptCursor(), now, remove });
    expect(linked.incomplete).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await expect(
      sweepAttemptTree({ roots: [base], cursor: { root: 0, stack: [{ path: root, after: '' }] }, now, remove }),
    ).rejects.toThrow('Invalid attempt cleanup cursor');
  });

  it('rechecks inode, age and symlink status immediately before unlink', async () => {
    const path = await file(join(root, '.attempts', randomUUID(), randomUUID(), 'image.jpeg'));
    const result = await sweepAttemptTree({
      roots: [root],
      cursor: emptyAttemptCursor(),
      now,
      remove: async (_path, _identity, unlink) => {
        await rm(path);
        await file(path, new Date(now));
        return unlink();
      },
    });
    expect(result.deleted).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('fixture');
  });
});
