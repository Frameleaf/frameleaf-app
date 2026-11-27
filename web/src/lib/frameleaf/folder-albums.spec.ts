import { FolderAlbumNaming, FolderAlbumShape } from '@frameleaf/sdk';
import {
  EVENT_FOLDER_ALBUM_OPTIONS,
  LEGACY_FOLDER_ALBUM_OPTIONS,
  folderAlbumCounts,
  folderAlbumExample,
  looksLikeEventFolders,
  planFolderAlbums,
  subfolderNames,
} from '$lib/frameleaf/folder-albums';

describe('planFolderAlbums (FL-838, FL-1837)', () => {
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

  it('an album for every folder: library album, top-level folders of folders as collections', () => {
    const plan = planFolderAlbums(['/nas/family/'], folders, LEGACY_FOLDER_ALBUM_OPTIONS, 'Family photos');
    const byName = Object.fromEntries(plan.map(({ name, kind, photos }) => [name, { kind, photos }]));
    expect(byName).toMatchObject({
      'Family photos': { kind: 'album', photos: 38 },
      2024: { kind: 'collection', photos: 0 },
      Summer: { kind: 'album', photos: 0 },
      Scans: { kind: 'album', photos: 410 },
    });
    expect(folderAlbumCounts(plan)).toEqual({ albums: 8, collections: 2 });
    expect(planFolderAlbums(['/nas/empty'], folders, LEGACY_FOLDER_ALBUM_OPTIONS, 'Empty')).toEqual([]);
  });

  it('one album for each event folder, with deeper photos joining it', () => {
    const plan = planFolderAlbums(['/nas/family'], folders, EVENT_FOLDER_ALBUM_OPTIONS, 'Family photos');
    expect(plan.find(({ name }) => name === '2025')).toMatchObject({ kind: 'album', photos: 228 });
    expect(plan.find(({ name }) => name === 'Scans')).toMatchObject({ photos: 640 });
    expect(folderAlbumCounts(plan)).toEqual({ albums: 4, collections: 0 });
  });

  it('albums at level 2, named from the folders on the way, under collections', () => {
    const plan = planFolderAlbums(
      ['/nas/family'],
      folders,
      { ...LEGACY_FOLDER_ALBUM_OPTIONS, shape: FolderAlbumShape.Level, level: 2, naming: FolderAlbumNaming.Path },
      'Family photos',
    );
    expect(plan.find(({ path }) => path === '/nas/family/2025/Summer')).toMatchObject({
      name: '2025 › Summer',
      photos: 228,
      parentPath: '/nas/family/2025',
    });
    expect(plan.find(({ path }) => path === '/nas/family/2025')).toMatchObject({ kind: 'collection' });
  });

  it('finds the folders inside event folders, and an example event', () => {
    const events = [
      { path: '/p/A/Capture', count: 10 },
      { path: '/p/A/Export', count: 4 },
      { path: '/p/B/Capture', count: 3 },
    ];
    expect(looksLikeEventFolders(['/p'], events)).toBe(true);
    expect(looksLikeEventFolders(['/nas/family'], folders)).toBe(false);
    expect(subfolderNames(['/p'], events, EVENT_FOLDER_ALBUM_OPTIONS)).toEqual([
      { name: 'Capture', folders: 2 },
      { name: 'Export', folders: 1 },
    ]);
    const plan = planFolderAlbums(['/p'], events, EVENT_FOLDER_ALBUM_OPTIONS, 'P');
    expect(folderAlbumExample(['/p'], events, plan)).toEqual({
      name: 'A',
      drive: [
        { name: 'Capture', photos: 10 },
        { name: 'Export', photos: 4 },
      ],
      albums: [
        expect.objectContaining({ name: 'A', photos: 10, depth: 0 }),
        expect.objectContaining({ name: 'Export', photos: 4, depth: 1 }),
      ],
    });
  });
});
