import { describe, expect, it } from 'vitest';
import {
  childPath,
  crumbsOf,
  folderWords,
  heldVersion,
  isChosen,
  isFolderPath,
  manifestOnDay,
  nameOf,
  pickTotals,
  togglePick,
  type BrowsePick,
} from '$lib/frameleaf/backup-browse';

const pick = (path: string, folder = false, size = 10, files = 1): BrowsePick => ({ path, folder, size, files });

describe('browsing a Cloud Backup (FL-1666)', () => {
  it('names paths from the top', () => {
    expect(childPath('/', 'data')).toBe('/data');
    expect(childPath('/data/library', 'admin')).toBe('/data/library/admin');
    expect(nameOf('/data/library/a.jpg')).toBe('a.jpg');
    expect(nameOf('/')).toBe('/');
    expect(crumbsOf('/')).toEqual([]);
    expect(crumbsOf('/data/library')).toEqual([
      { name: 'data', path: '/data' },
      { name: 'library', path: '/data/library' },
    ]);
    expect(folderWords('/data/library/a.jpg')).toBe('data › library');
    expect(folderWords('/data')).toBe('');
  });

  it('ticks a folder in place of what was ticked inside it, and covers what is inside', () => {
    let picks = togglePick([], pick('/data/library/a.jpg'));
    picks = togglePick(picks, pick('/data/other.jpg'));
    picks = togglePick(picks, pick('/data/library', true, 100, 5));
    expect(picks.map(({ path }) => path)).toEqual(['/data/other.jpg', '/data/library']);
    expect(isChosen(picks, '/data/library/a.jpg')).toBe(true);
    expect(isChosen(picks, '/data/library-2')).toBe(false);
    // Ticking something already covered changes nothing; unticking the folder frees it.
    expect(togglePick(picks, pick('/data/library/b.jpg'))).toEqual(picks);
    expect(togglePick(picks, pick('/data/library', true)).map(({ path }) => path)).toEqual(['/data/other.jpg']);
    expect(pickTotals(picks)).toEqual({ files: 6, size: 110 });
  });

  it('finds the copy a backup holds: the newest made on or before it', () => {
    const versions = [
      { manifestKey: 'c', createdAt: '2026-11-10T02:00:00Z', modifiedAt: '', size: 3 },
      { manifestKey: 'b', createdAt: '2026-11-05T02:00:00Z', modifiedAt: '', size: 2 },
      { manifestKey: 'a', createdAt: '2026-11-01T02:00:00Z', modifiedAt: '', size: 1 },
    ];
    const at = (createdAt: string) => ({ key: 'x', createdAt }) as never;
    expect(heldVersion(versions, at('2026-11-07T02:00:00Z'))?.manifestKey).toBe('b');
    expect(heldVersion(versions, at('2026-11-10T02:00:00Z'))?.manifestKey).toBe('c');
    expect(heldVersion(versions, at('2026-10-01T02:00:00Z'))?.manifestKey).toBe('a');
  });

  it('finds the newest Cloud Backup of a day', () => {
    const manifests = [
      { key: 'late', createdAt: new Date(2026, 10, 16, 23).toISOString() },
      { key: 'early', createdAt: new Date(2026, 10, 16, 2).toISOString() },
    ] as never;
    expect(manifestOnDay(manifests, '2026-11-16')?.key).toBe('late');
    expect(manifestOnDay(manifests, '2026-11-15')).toBeUndefined();
  });

  it('takes only a whole folder path to save to', () => {
    expect(isFolderPath('/mnt/photos/Restored')).toBe(true);
    expect(isFolderPath('mnt/photos')).toBe(false);
    expect(isFolderPath('/')).toBe(false);
    expect(isFolderPath('/mnt/../etc')).toBe(false);
  });
});
