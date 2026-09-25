import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  captureDay,
  firstUsefulFolder,
  flattenFolderTree,
  folderAt,
  folderBreadcrumbs,
  formatBytes,
  resolveFolder,
  sortFolderFiles,
} from '$lib/frameleaf/folder-tree';

const rows = [
  { path: '/data/library/2026/2026-09-24', count: 3, size: 3000 },
  { path: '/data/library/2026/2026-09-25', count: 1, size: 500 },
  { path: '/data/library/2026', count: 2, size: 200 },
  { path: '/data/library/2025/a/b/c/d/e', count: 4, size: 4096 },
];

/** FL-46 folder tree (discovery-data.mjs folderTree, Folders.jsx firstUseful). */
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
    expect(folderAt(tree, '/p')!.children.map((node) => node.name)).toEqual(['9', '10', 'b']);
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
    expect(tree.root).toMatchObject({ count: 0, children: [] });
    expect(firstUsefulFolder(tree)).toBe(tree.root);
  });

  it('opens the first useful folder, skipping pass-through folders', () => {
    const tree = buildFolderTree(rows);
    expect(firstUsefulFolder(tree).path).toBe('/data/library');
    expect(resolveFolder(tree, null).path).toBe('/data/library');
    expect(resolveFolder(tree, '').path).toBe('/data/library');
  });

  it('opens the nearest remaining ancestor for a folder that is gone or was renamed', () => {
    const tree = buildFolderTree(rows);
    expect(resolveFolder(tree, '/data/library/2026/2026-09-24/').path).toBe('/data/library/2026/2026-09-24');
    expect(resolveFolder(tree, '/data/library/2026/renamed').path).toBe('/data/library/2026');
    expect(resolveFolder(tree, '/elsewhere/entirely').path).toBe('/');
    expect(resolveFolder(tree, '/').path).toBe('/');
  });

  it('flattens the tree root first', () => {
    const tree = buildFolderTree([{ path: '/a/b', count: 1, size: 1 }]);
    expect(flattenFolderTree(tree).map((node) => node.path)).toEqual(['/', '/a', '/a/b']);
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
    expect(sortFolderFiles(files, 'date').map((file) => file.id)).toEqual(['2', '1', '3']);
    expect(sortFolderFiles(files, 'size').map((file) => file.id)).toEqual(['2', '1', '3']);
  });

  it('formats sizes and days as the prototype does', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(12 * 1024 ** 3)).toBe('12 GB');
    expect(captureDay('2026-08-02T21:15:00.000Z')).toBe('2026-08-02');
    expect(captureDay(null)).toBeNull();
  });
});
