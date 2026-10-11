import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  defaultFoldersView,
  findFolders,
  firstUsefulFolder,
  flattenFolderTree,
  folderAccountName,
  folderAt,
  folderBreadcrumbs,
  folderSiblings,
  folderTrail,
  formatBytes,
  normalizeFoldersView,
  resolveFolder,
  sortFolderFiles,
  sortFolders,
  type FolderNode,
} from '$lib/frameleaf/folder-tree';

const rows = [
  { path: '/data/library/2026/2026-09-24', count: 3, size: 3000 },
  { path: '/data/library/2026/2026-09-25', count: 1, size: 500 },
  { path: '/data/library/2026', count: 2, size: 200 },
  { path: '/data/library/2025/a/b/c/d/e', count: 4, size: 4096 },
];

const day = (value: string) => `${value}T00:00:00.000Z`;
const names = (folders: readonly FolderNode[]) => folders.map((folder) => folder.name);

/** FL-46 folder tree (discovery-data.mjs folderTree / folderTreeV2, FoldersV2.jsx). */
describe('folder tree', () => {
  it('nests folders to any depth and adds counts and sizes up the tree', () => {
    const tree = buildFolderTree(rows);
    expect(tree.root).toMatchObject({ path: '/', count: 10, size: 7796, directCount: 0 });
    expect(folderAt(tree, '/data/library/2026')).toMatchObject({ count: 6, size: 3700, directCount: 2 });
    const deep = folderAt(tree, '/data/library/2025/a/b/c/d/e')!;
    expect(deep).toMatchObject({ count: 4, directCount: 4, depth: 8 });
    expect(folderBreadcrumbs(deep).map((node) => node.path)).toEqual([
      '/',
      '/data',
      '/data/library',
      '/data/library/2025',
      '/data/library/2025/a',
      '/data/library/2025/a/b',
      '/data/library/2025/a/b/c',
      '/data/library/2025/a/b/c/d',
      '/data/library/2025/a/b/c/d/e',
    ]);
  });

  it('orders subfolders by name, numbers numerically', () => {
    const tree = buildFolderTree([
      { path: '/p/10', count: 1, size: 1 },
      { path: '/p/9', count: 1, size: 1 },
      { path: '/p/b', count: 1, size: 1 },
    ]);
    expect(names(folderAt(tree, '/p')!.children)).toEqual(['9', '10', 'b']);
  });

  it('keeps a folder with no files of its own (only subfolders) as a node with zero here', () => {
    const tree = buildFolderTree(rows);
    expect(folderAt(tree, '/data/library/2025/a')).toMatchObject({ directCount: 0, count: 4 });
  });

  it('keeps relative storage paths relative, so the folder view can still query them', () => {
    const tree = buildFolderTree([{ path: 'upload/library/2026', count: 1, size: 1 }]);
    expect(folderAt(tree, 'upload/library/2026')).toMatchObject({ count: 1 });
    expect(tree.root.children.map((node) => node.path)).toEqual(['upload']);
  });

  it('shows "No folders yet" data for an empty library: a root with nothing in it', () => {
    const tree = buildFolderTree([]);
    expect(tree.root).toMatchObject({ count: 0, children: [], coverAssetIds: [], startDate: null, endDate: null });
    expect(firstUsefulFolder(tree)).toBe(tree.root);
  });

  it('flattens the tree root first', () => {
    const tree = buildFolderTree([{ path: '/a/b', count: 1, size: 1 }]);
    expect(flattenFolderTree(tree).map((node) => node.path)).toEqual(['/', '/a', '/a/b']);
  });
});

describe('folder covers and dates', () => {
  const tree = buildFolderTree([
    {
      path: '/photos/2026',
      count: 2,
      size: 1,
      coverAssetIds: ['own-1', 'own-2'],
      startDate: day('2026-03-01'),
      endDate: day('2026-03-02'),
    },
    {
      path: '/photos/2026/Rockies',
      count: 9,
      size: 1,
      coverAssetIds: ['rockies-1', 'rockies-2', 'rockies-3', 'rockies-4'],
      startDate: day('2026-08-02'),
      endDate: day('2026-08-09'),
    },
    {
      path: '/photos/2026/Winter',
      count: 3,
      size: 1,
      coverAssetIds: ['winter-1', 'winter-2', 'winter-3'],
      startDate: day('2026-01-10'),
      endDate: day('2026-01-12'),
    },
    {
      path: '/photos/2024/Japan/Kyoto',
      count: 1,
      size: 1,
      coverAssetIds: ['kyoto-1'],
      startDate: day('2024-11-03'),
      endDate: day('2024-11-03'),
    },
  ]);

  it("keeps a folder's own cover and dates when it has no subfolders", () => {
    expect(folderAt(tree, '/photos/2026/Rockies')).toMatchObject({
      coverAssetIds: ['rockies-1', 'rockies-2', 'rockies-3', 'rockies-4'],
      startDate: day('2026-08-02'),
      endDate: day('2026-08-09'),
    });
  });

  it("puts a folder's own files first, then one from each subfolder in turn, the newest subfolder first", () => {
    expect(folderAt(tree, '/photos/2026')!.coverAssetIds).toEqual(['own-1', 'own-2', 'rockies-1', 'winter-1']);
  });

  it('gives a folder with only subfolders a cover and a date range from below, however deep', () => {
    expect(folderAt(tree, '/photos/2024')).toMatchObject({
      directCount: 0,
      coverAssetIds: ['kyoto-1'],
      startDate: day('2024-11-03'),
      endDate: day('2024-11-03'),
    });
    // 2026 is newer than 2024, so its cover leads; each subfolder gives one before any gives a second.
    expect(folderAt(tree, '/photos')).toMatchObject({
      coverAssetIds: ['own-1', 'kyoto-1', 'own-2', 'rockies-1'],
      startDate: day('2024-11-03'),
      endDate: day('2026-08-09'),
    });
  });

  it('spans the oldest and newest day of everything under a folder', () => {
    expect(folderAt(tree, '/photos/2026')).toMatchObject({
      startDate: day('2026-01-10'),
      endDate: day('2026-08-09'),
    });
  });

  it('never repeats a photo in a cover and never draws more than four', () => {
    const repeated = buildFolderTree([
      { path: '/a', count: 2, size: 1, coverAssetIds: ['one', 'one', 'two'] },
      { path: '/a/b', count: 5, size: 1, coverAssetIds: ['two', 'three', 'four', 'five'] },
    ]);
    expect(folderAt(repeated, '/a')!.coverAssetIds).toEqual(['one', 'two', 'three', 'four']);
  });

  it('leaves the cover empty and the dates unknown for a server that sends neither', () => {
    const old = buildFolderTree(rows);
    expect(folderAt(old, '/data/library/2026')).toMatchObject({ coverAssetIds: [], startDate: null, endDate: null });
  });
});

describe('the top of the browser and what an address opens', () => {
  it('starts where the tree first branches or holds files, skipping pass-through folders', () => {
    const tree = buildFolderTree(rows);
    expect(firstUsefulFolder(tree).path).toBe('/data/library');
    expect(resolveFolder(tree, null).path).toBe('/data/library');
    expect(resolveFolder(tree, '').path).toBe('/data/library');
  });

  it('starts at the folder holding the files when the whole library is one chain', () => {
    const tree = buildFolderTree([{ path: '/media/upload/user/ab/cd', count: 1, size: 1 }]);
    expect(firstUsefulFolder(tree).path).toBe('/media/upload/user/ab/cd');
  });

  it('stops at a pass-through folder that holds files of its own', () => {
    const tree = buildFolderTree([
      { path: '/media', count: 1, size: 1 },
      { path: '/media/upload/2026', count: 1, size: 1 },
    ]);
    expect(firstUsefulFolder(tree).path).toBe('/media');
  });

  it('opens the nearest remaining ancestor for a folder that is gone or was renamed', () => {
    const tree = buildFolderTree(rows);
    expect(resolveFolder(tree, '/data/library/2026/2026-09-24/').path).toBe('/data/library/2026/2026-09-24');
    expect(resolveFolder(tree, '/data/library/2026/renamed').path).toBe('/data/library/2026');
    // a pass-through folder inside the tree is still a folder of its own
    expect(resolveFolder(tree, '/data/library/2025/a/b').path).toBe('/data/library/2025/a/b');
  });

  it('opens the top for an address above it or outside the tree, never "/"', () => {
    const tree = buildFolderTree(rows);
    expect(resolveFolder(tree, '/').path).toBe('/data/library');
    expect(resolveFolder(tree, '/data').path).toBe('/data/library');
    expect(resolveFolder(tree, '/elsewhere/entirely').path).toBe('/data/library');
    expect(resolveFolder(tree, 'relative/elsewhere').path).toBe('/data/library');
  });

  it('draws the path from the top down, leaving out the folders above it', () => {
    const tree = buildFolderTree(rows);
    const top = firstUsefulFolder(tree);
    expect(names(folderTrail(folderAt(tree, '/data/library/2026/2026-09-24')!, top))).toEqual([
      'library',
      '2026',
      '2026-09-24',
    ]);
    expect(folderTrail(top, top)).toEqual([top]);
    // a folder above the top has no place in the path
    expect(folderTrail(tree.root, top)).toEqual([top]);
  });

  it('lists the folders beside a folder, itself included, in name order', () => {
    const tree = buildFolderTree(rows);
    expect(names(folderSiblings(folderAt(tree, '/data/library/2026')!))).toEqual(['2025', '2026']);
    expect(names(folderSiblings(folderAt(tree, '/data/library/2025/a')!))).toEqual(['a']);
    expect(folderSiblings(tree.root)).toEqual([]);
  });
});

describe('friendly names for upload folders', () => {
  const jamie = '3f9a1c2e-7b4d-4e8a-9c61-0d2f5a8b7e14';
  const accounts = { [jamie]: 'Jamie' };
  const tree = buildFolderTree([
    { path: `/media/upload/${jamie}/ab/cd`, count: 1, size: 1 },
    { path: '/media/upload/11111111-2222-4333-8444-555555555555/ab/cd', count: 1, size: 1 },
    { path: '/media/library/Jamie/2026', count: 1, size: 1 },
  ]);

  it('names the account whose id a folder carries', () => {
    expect(folderAccountName(folderAt(tree, `/media/upload/${jamie}`)!, accounts)).toBe('Jamie');
  });

  it('leaves every other folder alone: an unknown id, a folder that only looks like a name, the root', () => {
    expect(
      folderAccountName(folderAt(tree, '/media/upload/11111111-2222-4333-8444-555555555555')!, accounts),
    ).toBeNull();
    expect(folderAccountName(folderAt(tree, '/media/library/Jamie')!, accounts)).toBeNull();
    expect(folderAccountName(folderAt(tree, `/media/upload/${jamie}/ab`)!, accounts)).toBeNull();
    expect(folderAccountName(tree.root, accounts)).toBeNull();
    expect(folderAccountName(tree.root, { '': 'Nobody' })).toBeNull();
  });

  it('ignores an account without a name, and names that are not accounts at all', () => {
    expect(folderAccountName({ name: jamie }, { [jamie]: '  ' })).toBeNull();
    expect(folderAccountName({ name: 'toString' }, accounts)).toBeNull();
    expect(folderAccountName({ name: jamie }, {})).toBeNull();
  });
});

describe('sorting and finding folders', () => {
  const jamie = 'aaaaaaaa-0000-4000-8000-000000000001';
  const tree = buildFolderTree([
    { path: '/p/Banff', count: 30, size: 300, startDate: day('2026-08-01'), endDate: day('2026-08-09') },
    { path: '/p/jasper', count: 22, size: 900, startDate: day('2026-09-01'), endDate: day('2026-09-03') },
    { path: '/p/Videos', count: 6, size: 5000, startDate: day('2025-01-01'), endDate: day('2025-01-01') },
    { path: '/p/10', count: 30, size: 300 },
    { path: '/p/9', count: 1, size: 1 },
    { path: `/p/${jamie}/2026-09`, count: 4, size: 40, endDate: day('2026-09-30') },
    { path: '/p/Videos/raw/Banff clips', count: 2, size: 20 },
  ]);
  const folders = folderAt(tree, '/p')!.children;
  const label = (node: FolderNode) => (node.name === jamie ? 'Jamie’s uploads' : node.name);

  it('sorts by name, numbers numerically and case aside', () => {
    expect(names(sortFolders(folders, 'name'))).toEqual(['9', '10', jamie, 'Banff', 'jasper', 'Videos']);
  });

  it('sorts by the name shown, so a friendly name sits where it reads', () => {
    expect(sortFolders(folders, 'name', label).map((folder) => label(folder))).toEqual([
      '9',
      '10',
      'Banff',
      'Jamie’s uploads',
      'jasper',
      'Videos',
    ]);
  });

  it('sorts newest first, folders without dates last', () => {
    expect(names(sortFolders(folders, 'newest'))).toEqual([jamie, 'jasper', 'Banff', 'Videos', '9', '10']);
  });

  it('sorts largest first and by most items, equal folders by name', () => {
    expect(names(sortFolders(folders, 'largest'))).toEqual(['Videos', 'jasper', '10', 'Banff', jamie, '9']);
    expect(names(sortFolders(folders, 'items'))).toEqual(['10', 'Banff', 'jasper', 'Videos', jamie, '9']);
  });

  it('does not reorder the tree itself', () => {
    const before = names(folders);
    sortFolders(folders, 'largest');
    expect(names(folders)).toEqual(before);
  });

  it('finds folders at any depth by a part of their name, whatever its case', () => {
    const top = folderAt(tree, '/p')!;
    expect(findFolders(top, 'banff').map((folder) => folder.path)).toEqual(['/p/Banff', '/p/Videos/raw/Banff clips']);
    expect(findFolders(top, '  RAW ').map((folder) => folder.path)).toEqual(['/p/Videos/raw']);
    expect(findFolders(top, 'zebra')).toEqual([]);
    expect(findFolders(top, ' '.repeat(3))).toEqual([]);
  });

  it('finds a folder by the name shown and by its name on disk', () => {
    const top = folderAt(tree, '/p')!;
    expect(findFolders(top, 'jamie', label).map((folder) => folder.name)).toEqual([jamie]);
    expect(findFolders(top, 'aaaaaaaa', label).map((folder) => folder.name)).toEqual([jamie]);
    expect(findFolders(top, 'jamie')).toEqual([]);
  });

  it('never finds the top itself, nor anything outside it', () => {
    expect(findFolders(folderAt(tree, '/p/Videos')!, 'videos')).toEqual([]);
    expect(findFolders(folderAt(tree, '/p/Videos')!, 'banff').map((folder) => folder.path)).toEqual([
      '/p/Videos/raw/Banff clips',
    ]);
  });
});

describe('folder files', () => {
  const files = [
    { id: '1', originalFileName: 'IMG_10.jpg', localDateTime: '2026-09-01T10:00:00.000Z', fileSizeInByte: 100 },
    { id: '2', originalFileName: 'IMG_9.jpg', localDateTime: '2026-09-03T10:00:00.000Z', fileSizeInByte: 300 },
    { id: '3', originalFileName: 'a.mov', localDateTime: null, fileSizeInByte: null },
  ];

  it('sorts by name (numeric), by newest capture, or by largest size', () => {
    expect(sortFolderFiles(files, 'name').map((file) => file.id)).toEqual(['3', '2', '1']);
    expect(sortFolderFiles(files, 'newest').map((file) => file.id)).toEqual(['2', '1', '3']);
    expect(sortFolderFiles(files, 'largest').map((file) => file.id)).toEqual(['2', '1', '3']);
  });

  it('keeps files in name order under "Most items", which orders folders only', () => {
    expect(sortFolderFiles(files, 'items').map((file) => file.id)).toEqual(['3', '2', '1']);
  });

  it('formats sizes as the prototype does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
  });
});

describe('the remembered view', () => {
  it('starts as the grid without file names', () => {
    expect(defaultFoldersView).toEqual({ view: 'grid', fileNames: false });
  });

  it('keeps a valid choice and repairs anything else', () => {
    expect(normalizeFoldersView({ view: 'columns', fileNames: true })).toEqual({ view: 'columns', fileNames: true });
    expect(normalizeFoldersView({ view: 'list', fileNames: 'yes' })).toEqual({ view: 'grid', fileNames: false });
    expect(normalizeFoldersView(null)).toEqual({ view: 'grid', fileNames: false });
    expect(normalizeFoldersView('columns')).toEqual({ view: 'grid', fileNames: false });
    expect(normalizeFoldersView({ view: 'columns' })).toEqual({ view: 'columns', fileNames: false });
  });
});
