import { folderAlbumCounts, folderAlbumTree } from '$lib/frameleaf/folder-albums';

describe('folderAlbumTree (FL-838)', () => {
  const folders = [
    { path: '/nas/family', count: 38 },
    { path: '/nas/family/2024/Banff', count: 212 },
    { path: '/nas/family/2024/Christmas', count: 96 },
    { path: '/nas/family/2025/Summer/Camping', count: 140 },
    { path: '/nas/family/2025/Summer/Lake days', count: 88 },
    { path: '/nas/family/Scans', count: 410 },
    { path: '/nas/family/Scans/Grandma', count: 230 },
    { path: '/elsewhere/x', count: 5 },
  ];

  it('makes the approved tree: library album first, top-level folders of folders as collections', () => {
    const tree = folderAlbumTree(['/nas/family/'], folders, 'Family photos');

    expect(tree.map(({ name, kind, photos, total }) => ({ name, kind, photos, total }))).toEqual([
      { name: 'Family photos', kind: 'album', photos: 38, total: 38 },
      { name: '2024', kind: 'collection', photos: 0, total: 308 },
      { name: '2025', kind: 'collection', photos: 0, total: 228 },
      { name: 'Scans', kind: 'album', photos: 410, total: 640 },
    ]);
    // a deeper folder of folders holds albums, and is an album itself
    const [summer] = tree[2].children;
    expect(summer).toMatchObject({ name: 'Summer', kind: 'album', photos: 0, total: 228 });
    expect(summer.children.map(({ name }) => name)).toEqual(['Camping', 'Lake days']);
    expect(folderAlbumCounts(tree)).toEqual({ albums: 8, collections: 2 });
  });

  it('makes nothing for an import folder holding nothing', () => {
    expect(folderAlbumTree(['/nas/empty'], folders, 'Empty')).toEqual([]);
  });
});
