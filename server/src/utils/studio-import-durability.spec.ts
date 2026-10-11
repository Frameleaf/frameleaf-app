import { describe, expect, it } from 'vitest';
import { assertSameOwnedInode, syncAncestors } from 'src/utils/studio-import-durability.js';

describe('import namespace barriers (synthetic paths)', () => {
  it('includes new owner/project entries and stops at the first failed barrier', async () => {
    const seen: string[] = [];
    await expect(
      syncAncestors('/exports/o/p', '/exports', (path) => {
        seen.push(path);
        if (path === '/exports/o') throw new Error('directory_barrier_failed');
        return Promise.resolve();
      }),
    ).rejects.toThrow('directory_barrier_failed');
    expect(seen).toEqual(['/exports/o/p', '/exports/o']);
  });

  it('covers the complete ancestry including the anchor', async () => {
    const seen: string[] = [];
    await syncAncestors('/exports/o/p', '/exports', (path) => {
      seen.push(path);
      return Promise.resolve();
    });
    expect(seen).toEqual(['/exports/o/p', '/exports/o', '/exports']);
  });

  it.each(['/outside', '/exports/../other', 'relative'])(
    'refuses an outside or noncanonical path: %s',
    async (leaf) => {
      const seen: string[] = [];
      await expect(
        syncAncestors(leaf, '/exports', (path) => {
          seen.push(path);
          return Promise.resolve();
        }),
      ).rejects.toThrow();
      expect(seen).toEqual([]);
    },
  );

  it('syncs an anchor that is itself the leaf', async () => {
    const seen: string[] = [];
    await syncAncestors('/exports', '/exports', (path) => {
      seen.push(path);
      return Promise.resolve();
    });
    expect(seen).toEqual(['/exports']);
  });

  it.each([
    { dev: '9', ino: '2', size: 4 },
    { dev: '1', ino: '3', size: 4 },
    { dev: '1', ino: '2', size: 5 },
  ])('refuses foreign inode/device/size %j', (other) => {
    expect(() => assertSameOwnedInode({ dev: '1', ino: '2', size: 4 }, other)).toThrow('publication_identity_changed');
  });
});
