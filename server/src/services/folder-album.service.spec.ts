import path from 'node:path';
import { AlbumKind, JobName } from 'src/enum.js';
import { FolderAlbumService } from 'src/services/folder-album.service.js';
import { LibraryService } from 'src/services/library.service.js';
import {
  EVENT_FOLDER_ALBUM_OPTIONS,
  FolderAlbumOptions,
  LEGACY_FOLDER_ALBUM_OPTIONS,
  buildFolderTree,
  looksLikeEventFolders,
  matchMovedFolders,
  planFolderAlbums,
} from 'src/utils/folder-albums.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

type FakeAsset = {
  id: string;
  originalPath: string;
  originalFileName: string;
  fileModifiedAt: Date;
  isOffline: boolean;
  /** an item a folder album does not show, such as a hidden one */
  hidden?: boolean;
  libraryId: string | null;
};
type FakeAlbum = { id: string; albumName: string; parentId: string | null; kind: AlbumKind };
type FakeLink = {
  id: string;
  libraryId: string;
  folderPath: string;
  albumId: string;
  isUserEdited: boolean;
  isKept: boolean;
};

/**
 * An in-memory library and its albums behind the repository methods the sync uses, so the tests read as what
 * happens to the albums when files appear, go and move.
 */
const fakeWorld = (mocks: ServiceMocks, importPaths: string[]) => {
  const library = factory.library({ importPaths, folderAlbums: true, name: 'Photos' });
  const assets: FakeAsset[] = [];
  const albums = new Map<string, FakeAlbum>();
  const members = new Map<string, Set<string>>();
  // library_folder_album_asset: the photos the sync has put in each album once
  const seen = new Map<string, Set<string>>();
  const links: FakeLink[] = [];
  const shared = new Set<string>();
  const folderOf = (asset: FakeAsset) => path.posix.dirname(asset.originalPath);
  const ofLibrary = (asset: FakeAsset) => asset.libraryId === library.id;

  const removeAlbum = (id: string) => {
    const album = albums.get(id)!;
    for (const child of albums.values()) {
      if (child.parentId === id) {
        child.parentId = album.parentId;
      }
    }
    albums.delete(id);
    members.delete(id);
    for (let index = links.length - 1; index >= 0; index--) {
      if (links[index].albumId === id) {
        links.splice(index, 1);
      }
    }
  };

  mocks.library.get.mockImplementation(() => Promise.resolve(library as never));
  mocks.user.get.mockResolvedValue({ id: library.ownerId } as never);
  mocks.user.getMetadata.mockResolvedValue([]);
  mocks.library.getFolderPhotoCounts.mockImplementation(() => {
    const counts = new Map<string, { photos: number; items: number }>();
    for (const asset of assets) {
      if (ofLibrary(asset) && !asset.isOffline) {
        const row = counts.get(folderOf(asset)) ?? { photos: 0, items: 0 };
        row.items++;
        row.photos += asset.hidden ? 0 : 1;
        counts.set(folderOf(asset), row);
      }
    }
    return Promise.resolve([...counts].map(([folderPath, row]) => ({ folderPath, ...row })));
  });
  mocks.library.setFolderAlbumsKept.mockImplementation((_libraryId, kept) => {
    for (const link of links) {
      link.isKept = kept;
    }
    return Promise.resolve();
  });
  mocks.album.getSharedAlbumIds.mockImplementation(() => Promise.resolve(new Set(shared)));
  mocks.album.getMetadataForIds.mockImplementation((ids) =>
    Promise.resolve(ids.map((albumId) => ({ albumId, assetCount: members.get(albumId)?.size ?? 0 })) as never),
  );
  mocks.albumSummary.deleteByAlbumIds.mockResolvedValue();
  mocks.library.getFolderAlbums.mockImplementation(() =>
    Promise.resolve(
      links.map((link) => {
        const album = albums.get(link.albumId)!;
        return { ...link, albumName: album.albumName, parentId: album.parentId, kind: album.kind, deletedAt: null };
      }) as never,
    ),
  );
  mocks.library.createFolderAlbum.mockImplementation((value) => {
    const link = { id: newUuid(), isUserEdited: false, isKept: false, ...value } as FakeLink;
    links.push(link);
    return Promise.resolve(link as never);
  });
  mocks.library.updateFolderAlbum.mockImplementation((id, value) => {
    Object.assign(
      links.find((link) => link.id === id)!,
      value,
    );
    return Promise.resolve();
  });
  mocks.library.deleteFolderAlbum.mockImplementation((id) => {
    links.splice(
      links.findIndex((link) => link.id === id),
      1,
    );
    return Promise.resolve();
  });
  mocks.library.deleteFolderAlbums.mockImplementation(() =>
    Promise.resolve(links.splice(0).map(({ albumId, folderPath }) => ({ albumId, folderPath }))),
  );
  mocks.library.getFolderFileKeys.mockImplementation((_libraryId, gone, fresh) =>
    Promise.resolve(
      assets
        .filter((asset) => ofLibrary(asset))
        .flatMap((asset) => [
          ...(gone.includes(folderOf(asset)) ? [{ ...asset, folderPath: folderOf(asset), gone: true }] : []),
          ...(fresh.includes(folderOf(asset)) && !asset.isOffline
            ? [{ ...asset, folderPath: folderOf(asset), gone: false }]
            : []),
        ]),
    ),
  );
  mocks.library.getFolderAlbumsWithOtherItems.mockImplementation((_libraryId, folders) => {
    const result = new Set<string>();
    for (const { albumId } of folders) {
      for (const assetId of members.get(albumId) ?? []) {
        const asset = assets.find(({ id }) => id === assetId)!;
        const own = folders.some(
          (folder) => folder.albumId === albumId && ofLibrary(asset) && folder.folderPath === folderOf(asset),
        );
        if (!own) {
          result.add(albumId);
        }
      }
    }
    return Promise.resolve(result);
  });
  mocks.album.create.mockImplementation((value) => {
    const album = {
      id: newUuid(),
      albumName: value.albumName!,
      parentId: value.parentId ?? null,
      kind: value.kind as AlbumKind,
    };
    albums.set(album.id, album);
    members.set(album.id, new Set());
    return Promise.resolve(album as never);
  });
  mocks.album.update.mockImplementation((id, value) => {
    Object.assign(
      albums.get(id)!,
      value.albumName ? { albumName: value.albumName } : {},
      value.kind ? { kind: value.kind } : {},
    );
    return Promise.resolve(albums.get(id) as never);
  });
  mocks.album.delete.mockImplementation((id) => {
    removeAlbum(id);
    return Promise.resolve();
  });
  mocks.album.reparent.mockImplementation((id, parentId) => {
    albums.get(id)!.parentId = parentId;
    return Promise.resolve();
  });
  mocks.album.syncFolderMemberships.mockImplementation((_libraryId, add, remove, stale) => {
    const added: { albumId: string; assetId: string }[] = [];
    const removed: { albumId: string; assetId: string }[] = [];
    for (const asset of assets) {
      for (const { albumId, folderPath } of add) {
        const once = seen.get(albumId) ?? new Set<string>();
        seen.set(albumId, once);
        if (
          ofLibrary(asset) &&
          !asset.isOffline &&
          !asset.hidden &&
          folderPath === folderOf(asset) &&
          !once.has(asset.id)
        ) {
          once.add(asset.id);
          if (!members.get(albumId)!.has(asset.id)) {
            members.get(albumId)!.add(asset.id);
            added.push({ albumId, assetId: asset.id });
          }
        }
      }
    }
    for (const { albumId, folderPath } of remove) {
      for (const assetId of members.get(albumId) ?? []) {
        const asset = assets.find(({ id }) => id === assetId)!;
        if (ofLibrary(asset) && asset.isOffline && folderOf(asset) === folderPath) {
          members.get(albumId)!.delete(assetId);
          seen.get(albumId)?.delete(assetId);
          removed.push({ albumId, assetId });
        }
      }
    }
    for (const albumId of stale?.albumIds ?? []) {
      for (const assetId of seen.get(albumId) ?? []) {
        const asset = assets.find(({ id }) => id === assetId)!;
        const member = stale!.members.some(
          (folder) => folder.albumId === albumId && folder.folderPath === folderOf(asset),
        );
        if (!member) {
          seen.get(albumId)!.delete(assetId);
          if (members.get(albumId)?.delete(assetId)) {
            removed.push({ albumId, assetId });
          }
        }
      }
    }
    return Promise.resolve({ added, removed });
  });
  mocks.album.updateThumbnails.mockResolvedValue(0);
  mocks.album.updateNewestCovers.mockResolvedValue();
  mocks.partnerOrigin.markOverridden.mockResolvedValue();
  mocks.event.emit.mockResolvedValue();

  const addFile = (originalPath: string, options: Partial<FakeAsset> = {}) => {
    const asset: FakeAsset = {
      id: newUuid(),
      originalPath,
      originalFileName: path.posix.basename(originalPath),
      fileModifiedAt: new Date('2024-06-01T12:00:00Z'),
      isOffline: false,
      libraryId: library.id,
      ...options,
    };
    assets.push(asset);
    return asset;
  };

  /** A file gone from disk: the scan marks its item offline, and the item stays. */
  const removeFile = (originalPath: string) => {
    for (const asset of assets) {
      if (asset.originalPath === originalPath) {
        asset.isOffline = true;
      }
    }
  };

  /** A folder renamed on disk: its items go offline, and the scan makes new items at the new path. */
  const renameFolder = (from: string, to: string) => {
    const moving = assets.filter((asset) => !asset.isOffline && asset.originalPath.startsWith(`${from}/`));
    for (const asset of moving) {
      asset.isOffline = true;
      addFile(to + asset.originalPath.slice(from.length), { fileModifiedAt: asset.fileModifiedAt });
    }
  };

  const albumFor = (folderPath: string) => {
    const link = links.find((link) => link.folderPath === folderPath);
    return link ? albums.get(link.albumId) : undefined;
  };
  const photosOf = (folderPath: string) =>
    [...(members.get(albumFor(folderPath)!.id) ?? [])]
      .map((id) => assets.find((asset) => asset.id === id)!.originalPath)
      .toSorted();

  const childrenOf = (folderPath: string) =>
    albums
      .values()
      .filter((album) => album.parentId === albumFor(folderPath)!.id)
      .map(({ albumName }) => albumName)
      .toArray()
      .toSorted();

  return {
    library,
    assets,
    albums,
    members,
    links,
    shared,
    addFile,
    removeFile,
    renameFolder,
    albumFor,
    photosOf,
    childrenOf,
  };
};

describe(FolderAlbumService.name, () => {
  let sut: FolderAlbumService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(FolderAlbumService));
  });

  describe('sync', () => {
    it("makes an album for each folder, with the import folder's own photos in one named after the library", async () => {
      const world = fakeWorld(mocks, ['/photos/2020']);
      world.addFile('/photos/2020/a.jpg');
      world.addFile('/photos/2020/trip/b.jpg');
      world.addFile('/photos/2020/trip/day1/c.jpg');
      world.addFile('/photos/2020/trip/day1/d.jpg');

      await expect(sut.sync(world.library.id)).resolves.toEqual({
        created: 3,
        moved: 0,
        removed: 0,
        photosAdded: 4,
        photosRemoved: 0,
      });

      const top = world.albumFor('/photos/2020')!;
      const trip = world.albumFor('/photos/2020/trip')!;
      const day1 = world.albumFor('/photos/2020/trip/day1')!;
      // FL-838 decision 2: the library's own photos sit beside the folders' albums, not above them
      expect(top).toMatchObject({ albumName: 'Photos', parentId: null, kind: AlbumKind.Album });
      expect(trip).toMatchObject({ albumName: 'trip', parentId: null, kind: AlbumKind.Album });
      expect(day1).toMatchObject({ albumName: 'day1', parentId: trip.id, kind: AlbumKind.Album });
      expect(world.photosOf('/photos/2020')).toEqual(['/photos/2020/a.jpg']);
      expect(world.photosOf('/photos/2020/trip')).toEqual(['/photos/2020/trip/b.jpg']);
      expect(world.photosOf('/photos/2020/trip/day1')).toEqual([
        '/photos/2020/trip/day1/c.jpg',
        '/photos/2020/trip/day1/d.jpg',
      ]);
      expect(mocks.album.create).toHaveBeenCalledWith(
        expect.objectContaining({ albumName: 'Photos' }),
        [],
        [{ userId: world.library.ownerId, role: 'owner' }],
        world.library.ownerId,
      );
    });

    it('makes a top-level folder of folders a collection, a deeper one an album of albums', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/2020/trip/a.jpg');
      world.addFile('/photos/2020/summer/camping/b.jpg');

      await sut.sync(world.library.id);
      // the import folder holds no photos of its own, so it makes nothing
      expect(world.albumFor('/photos')).toBeUndefined();
      const year = world.albumFor('/photos/2020')!;
      const summer = world.albumFor('/photos/2020/summer')!;
      expect(year).toMatchObject({ albumName: '2020', parentId: null, kind: AlbumKind.Collection });
      expect(world.albumFor('/photos/2020/trip')).toMatchObject({ parentId: year.id, kind: AlbumKind.Album });
      expect(summer).toMatchObject({ parentId: year.id, kind: AlbumKind.Album });
      expect(world.albumFor('/photos/2020/summer/camping')).toMatchObject({ parentId: summer.id });

      world.addFile('/photos/2020/cover.jpg');
      world.addFile('/photos/loose.jpg');
      await sut.sync(world.library.id);
      expect(world.albumFor('/photos/2020')).toMatchObject({ kind: AlbumKind.Album });
      expect(world.photosOf('/photos/2020')).toEqual(['/photos/2020/cover.jpg']);
      expect(world.albumFor('/photos')).toMatchObject({ albumName: 'Photos', parentId: null });
      expect(world.photosOf('/photos')).toEqual(['/photos/loose.jpg']);
    });

    it("drops the library's own album once no photo is loose in the import folder", async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/loose.jpg');
      world.addFile('/photos/trip/a.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;

      world.removeFile('/photos/loose.jpg');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ removed: 1 });

      expect(world.albumFor('/photos')).toBeUndefined();
      expect(world.albumFor('/photos/trip')).toMatchObject({ id: trip.id, parentId: null });
    });

    it('brings albums made before the change in line: the library name, no collection below the top', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/loose.jpg');
      world.addFile('/photos/2020/x/y/b.jpg');
      await sut.sync(world.library.id);
      // as the first release left them: the import folder's album named after the folder, and every folder of
      // folders a collection (moving the top-level albums out of it is the migration's)
      const root = world.albumFor('/photos')!;
      root.albumName = 'photos';
      const x = world.albumFor('/photos/2020/x')!;
      x.kind = AlbumKind.Collection;

      await sut.sync(world.library.id);

      expect(root.albumName).toBe('Photos');
      expect(world.links.find((link) => link.folderPath === '/photos')?.isUserEdited).toBe(false);
      expect(x.kind).toBe(AlbumKind.Album);
    });

    it('leaves out a photo the owner took out of the album, and still adds new ones', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      const removed = world.addFile('/photos/trip/a.jpg');
      world.addFile('/photos/trip/b.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;
      world.members.get(trip.id)!.delete(removed.id);

      world.addFile('/photos/trip/c.jpg');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ photosAdded: 1 });

      expect(world.photosOf('/photos/trip')).toEqual(['/photos/trip/b.jpg', '/photos/trip/c.jpg']);
    });

    it('puts a photo back when its file comes back after going missing', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      const photo = world.addFile('/photos/trip/a.jpg');
      world.addFile('/photos/trip/b.jpg');
      await sut.sync(world.library.id);

      world.removeFile('/photos/trip/a.jpg');
      await sut.sync(world.library.id);
      photo.isOffline = false;
      await sut.sync(world.library.id);

      expect(world.photosOf('/photos/trip')).toEqual(['/photos/trip/a.jpg', '/photos/trip/b.jpg']);
    });

    it('puts a new file in its album after a rescan, without making albums again', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/a.jpg');
      await sut.sync(world.library.id);

      world.addFile('/photos/b.jpg');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ created: 0, photosAdded: 1 });

      expect(world.albums.size).toBe(1);
      expect(world.photosOf('/photos')).toEqual(['/photos/a.jpg', '/photos/b.jpg']);
    });

    it('takes a removed file out of its album and leaves the item itself alone', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/a.jpg');
      const gone = world.addFile('/photos/b.jpg');
      await sut.sync(world.library.id);

      world.removeFile('/photos/b.jpg');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ photosRemoved: 1, removed: 0 });

      expect(world.photosOf('/photos')).toEqual(['/photos/a.jpg']);
      expect(world.assets).toContainEqual(expect.objectContaining({ id: gone.id }));
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
    });

    it('drops the album of a folder that emptied, unless the owner edited it', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/keep/a.jpg');
      world.addFile('/photos/plain/b.jpg');
      world.addFile('/photos/renamed/c.jpg');
      await sut.sync(world.library.id);
      const renamed = world.albumFor('/photos/renamed')!;
      renamed.albumName = 'My favourites';

      world.removeFile('/photos/plain/b.jpg');
      world.removeFile('/photos/renamed/c.jpg');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ removed: 1 });

      expect(world.albumFor('/photos/plain')).toBeUndefined();
      expect(world.albumFor('/photos/renamed')).toMatchObject({ id: renamed.id, albumName: 'My favourites' });
      expect(world.links.find((link) => link.folderPath === '/photos/renamed')?.isUserEdited).toBe(true);
      expect(world.photosOf('/photos/renamed')).toEqual([]);
    });

    it('follows a renamed folder: same album, new name, the moved photos', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/a.jpg');
      world.addFile('/photos/trip/b.jpg');
      world.addFile('/photos/trip/day1/c.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;
      const day1 = world.albumFor('/photos/trip/day1')!;

      world.renameFolder('/photos/trip', '/photos/holiday');
      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ created: 0, moved: 2, removed: 0 });

      expect(world.albumFor('/photos/holiday')).toMatchObject({ id: trip.id, albumName: 'holiday' });
      expect(world.albumFor('/photos/holiday/day1')).toMatchObject({
        id: day1.id,
        albumName: 'day1',
        parentId: trip.id,
      });
      expect(world.albumFor('/photos/trip')).toBeUndefined();
      expect(world.photosOf('/photos/holiday')).toEqual(['/photos/holiday/a.jpg', '/photos/holiday/b.jpg']);
      expect(world.photosOf('/photos/holiday/day1')).toEqual(['/photos/holiday/day1/c.jpg']);
    });

    it('keeps the name the owner gave an album when its folder is renamed', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/a.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;
      trip.albumName = 'Summer in Rome';

      world.renameFolder('/photos/trip', '/photos/2024-rome');
      await sut.sync(world.library.id);

      expect(world.albumFor('/photos/2024-rome')).toMatchObject({ id: trip.id, albumName: 'Summer in Rome' });
      expect(world.photosOf('/photos/2024-rome')).toEqual(['/photos/2024-rome/a.jpg']);
      expect(mocks.album.update).not.toHaveBeenCalledWith(
        trip.id,
        expect.objectContaining({ albumName: '2024-rome' }),
        expect.anything(),
      );
    });

    it('keeps photos the owner put in by hand, and still syncs the folder', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/a.jpg');
      const upload = world.addFile('/upload/phone.jpg', { libraryId: null });
      const elsewhere = world.addFile('/photos/other/x.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;
      world.members.get(trip.id)!.add(upload.id);
      world.members.get(trip.id)!.add(elsewhere.id);

      world.addFile('/photos/trip/b.jpg');
      await sut.sync(world.library.id);

      expect(world.photosOf('/photos/trip')).toEqual([
        '/photos/other/x.jpg',
        '/photos/trip/a.jpg',
        '/photos/trip/b.jpg',
        '/upload/phone.jpg',
      ]);
      expect(world.links.find((link) => link.folderPath === '/photos/trip')?.isUserEdited).toBe(true);
    });

    it('writes the photos of a large library in batches of albums, each its own transaction', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      for (let index = 0; index < 120; index++) {
        world.addFile(`/photos/2026-11-${index} - Event/Capture/a.jpg`);
      }

      await expect(sut.sync(world.library.id)).resolves.toMatchObject({ created: 240, photosAdded: 120 });

      // 240 albums, 50 to a batch
      expect(mocks.album.syncFolderMemberships).toHaveBeenCalledTimes(5);
      for (const call of mocks.album.syncFolderMemberships.mock.calls) {
        expect(call[3]!.albumIds.length).toBeLessThanOrEqual(50);
      }
    });

    it('does nothing for a library with folder albums off', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.library.folderAlbums = false;
      world.addFile('/photos/a.jpg');

      await expect(sut.sync(world.library.id)).resolves.toBeUndefined();
      expect(mocks.album.create).not.toHaveBeenCalled();
    });
  });

  describe('which folders become albums (FL-1837)', () => {
    const events = (world: ReturnType<typeof fakeWorld>, options: Partial<FolderAlbumOptions> = {}) => {
      (world.library as { folderAlbumOptions?: FolderAlbumOptions }).folderAlbumOptions = {
        ...EVENT_FOLDER_ALBUM_OPTIONS,
        ...options,
      };
    };
    const eventLibrary = () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/2026-11-19 - Nathan/Capture/a.jpg');
      world.addFile('/photos/2026-11-19 - Nathan/Capture/b.jpg');
      world.addFile('/photos/2026-11-19 - Nathan/Videos/c.mp4');
      world.addFile('/photos/2026-11-19 - Nathan/Export/a-edit.jpg');
      world.addFile('/photos/2026-11-20 - Park/Capture/d.jpg');
      return world;
    };

    it('makes one album for each event folder, with an album inside for exports', async () => {
      const world = eventLibrary();
      events(world);

      await sut.sync(world.library.id);

      const nathan = world.albumFor('/photos/2026-11-19 - Nathan')!;
      expect(nathan).toMatchObject({ albumName: '2026-11-19 - Nathan', parentId: null, kind: AlbumKind.Album });
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).toEqual([
        '/photos/2026-11-19 - Nathan/Capture/a.jpg',
        '/photos/2026-11-19 - Nathan/Capture/b.jpg',
        '/photos/2026-11-19 - Nathan/Videos/c.mp4',
      ]);
      expect(world.albumFor('/photos/2026-11-19 - Nathan/Export')).toMatchObject({
        albumName: 'Export',
        parentId: nathan.id,
      });
      expect(world.albumFor('/photos/2026-11-19 - Nathan/Capture')).toBeUndefined();
      expect(world.albums.size).toBe(3);
    });

    it('names albums from the folders on the way when asked, and leaves out folders set to No album', async () => {
      const world = eventLibrary();
      events(world, { naming: 'path', subfolders: { videos: 'skip' } });

      await sut.sync(world.library.id);

      expect(world.albumFor('/photos/2026-11-19 - Nathan/Export')).toMatchObject({
        albumName: '2026-11-19 - Nathan › Export',
      });
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).not.toContain('/photos/2026-11-19 - Nathan/Videos/c.mp4');
    });

    it('changes the albums to match: unedited ones go, renamed or shared ones stay, photos only change albums', async () => {
      const world = eventLibrary();
      world.addFile('/photos/2026-11-19 - Nathan/Edits/e.jpg');
      await sut.sync(world.library.id);
      expect(world.albumFor('/photos/2026-11-19 - Nathan')).toMatchObject({ kind: AlbumKind.Collection });
      const videos = world.albumFor('/photos/2026-11-19 - Nathan/Videos')!;
      videos.albumName = 'Clips';
      const edits = world.albumFor('/photos/2026-11-19 - Nathan/Edits')!;
      const park = world.albumFor('/photos/2026-11-20 - Park/Capture')!;
      world.shared.add(park.id);
      const assetsBefore = world.assets.length;

      events(world, { subfolders: { edits: 'join' } });
      await sut.sync(world.library.id);

      const nathan = world.albumFor('/photos/2026-11-19 - Nathan')!;
      expect(nathan.kind).toBe(AlbumKind.Album);
      expect(world.albumFor('/photos/2026-11-19 - Nathan/Capture')).toBeUndefined();
      expect(world.albums.has(edits.id)).toBe(false);
      expect(world.albumFor('/photos/2026-11-19 - Nathan/Videos')).toMatchObject({ id: videos.id, albumName: 'Clips' });
      expect(world.photosOf('/photos/2026-11-19 - Nathan/Videos')).toEqual([
        '/photos/2026-11-19 - Nathan/Videos/c.mp4',
      ]);
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).toContain('/photos/2026-11-19 - Nathan/Edits/e.jpg');
      // the shared album stays, moved inside its event's new album
      const parkEvent = world.albumFor('/photos/2026-11-20 - Park')!;
      expect(world.albumFor('/photos/2026-11-20 - Park/Capture')).toMatchObject({
        id: park.id,
        parentId: parkEvent.id,
      });
      expect(world.photosOf('/photos/2026-11-20 - Park')).toEqual(['/photos/2026-11-20 - Park/Capture/d.jpg']);
      expect(world.assets).toHaveLength(assetsBefore);
      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
    });

    it('takes photos out of an album when their folder gets an album of its own, and puts them back on Undo', async () => {
      const world = eventLibrary();
      events(world, { subfolders: { export: 'join' } });
      await sut.sync(world.library.id);
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).toContain('/photos/2026-11-19 - Nathan/Export/a-edit.jpg');

      events(world);
      await sut.sync(world.library.id);
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).not.toContain(
        '/photos/2026-11-19 - Nathan/Export/a-edit.jpg',
      );
      expect(world.photosOf('/photos/2026-11-19 - Nathan/Export')).toEqual([
        '/photos/2026-11-19 - Nathan/Export/a-edit.jpg',
      ]);

      // Undo: back to an album for every folder; the event album is a collection of folder albums again
      (world.library as { folderAlbumOptions?: FolderAlbumOptions }).folderAlbumOptions = LEGACY_FOLDER_ALBUM_OPTIONS;
      await sut.sync(world.library.id);
      expect(world.albumFor('/photos/2026-11-19 - Nathan')).toMatchObject({ kind: AlbumKind.Collection });
      expect(world.photosOf('/photos/2026-11-19 - Nathan')).toEqual([]);
      expect(world.childrenOf('/photos/2026-11-19 - Nathan')).toEqual(['Capture', 'Export', 'Videos']);
    });

    it('with "new folders only" keeps the albums made so far as they were', async () => {
      const world = eventLibrary();
      await sut.sync(world.library.id);
      const capture = world.albumFor('/photos/2026-11-19 - Nathan/Capture')!;

      events(world);
      await sut.applyToExisting(world.library.id, 'newOnly');
      world.addFile('/photos/2026-11-21 - Zoo/Capture/z.jpg');
      world.addFile('/photos/2026-11-19 - Nathan/Capture/new.jpg');
      await sut.sync(world.library.id);

      expect(world.albumFor('/photos/2026-11-19 - Nathan/Capture')).toMatchObject({ id: capture.id });
      expect(world.photosOf('/photos/2026-11-19 - Nathan/Capture')).toContain(
        '/photos/2026-11-19 - Nathan/Capture/new.jpg',
      );
      expect(world.albumFor('/photos/2026-11-21 - Zoo')).toMatchObject({ kind: AlbumKind.Album });
      expect(world.albumFor('/photos/2026-11-21 - Zoo/Capture')).toBeUndefined();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LibraryFolderAlbumSync,
        data: { id: world.library.id },
      });
    });

    it('with "new folders only" a kept album keeps its own photos when a new folder appears inside it', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/Trip/a.jpg');
      world.addFile('/photos/Trip/b.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/Trip')!;

      events(world);
      await sut.applyToExisting(world.library.id, 'newOnly');
      world.addFile('/photos/Trip/Extra/c.jpg');
      await sut.sync(world.library.id);

      expect(world.albumFor('/photos/Trip')).toMatchObject({ id: trip.id, kind: AlbumKind.Album });
      expect(world.photosOf('/photos/Trip')).toEqual([
        '/photos/Trip/Extra/c.jpg',
        '/photos/Trip/a.jpg',
        '/photos/Trip/b.jpg',
      ]);
    });

    it('makes no album for a folder whose items are none of them shown, unless asked', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/a.jpg');
      world.addFile('/photos/hidden/b.jpg', { hidden: true });

      await sut.sync(world.library.id);
      expect(world.albumFor('/photos/hidden')).toBeUndefined();

      (world.library as { folderAlbumOptions?: FolderAlbumOptions }).folderAlbumOptions = {
        ...LEGACY_FOLDER_ALBUM_OPTIONS,
        skipEmpty: false,
      };
      await sut.sync(world.library.id);
      expect(world.albumFor('/photos/hidden')).toMatchObject({ kind: AlbumKind.Album });
      expect(world.photosOf('/photos/hidden')).toEqual([]);
    });

    it("asks album lists to count the changed albums again, so none stays 'Empty'", async () => {
      const world = eventLibrary();
      await sut.sync(world.library.id);
      const capture = world.albumFor('/photos/2026-11-19 - Nathan/Capture')!;
      expect(mocks.albumSummary.deleteByAlbumIds).toHaveBeenCalledWith(expect.arrayContaining([capture.id]));
    });

    it('suggests one album for each event folder for a library laid out by event', async () => {
      const world = eventLibrary();
      await sut.sync(world.library.id);
      mocks.library.getAll.mockResolvedValue([world.library] as never);
      mocks.library.getFolderAlbumCounts.mockResolvedValue({ albums: 6, empty: 1 });

      await expect(sut.getSuggestions(world.library.ownerId)).resolves.toEqual([
        expect.objectContaining({ libraryId: world.library.id, albums: 6, empty: 1, suggestedAlbums: 3 }),
      ]);
      await expect(sut.getSuggestions('someone-else')).resolves.toEqual([]);
    });
  });

  describe('removeAll', () => {
    it('keeps the albums as ordinary albums', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/day1/a.jpg');
      await sut.sync(world.library.id);

      await expect(sut.removeAll(world.library.id, { removeAlbums: false })).resolves.toBe(0);

      expect(world.links).toEqual([]);
      expect(world.albums.size).toBe(2);
      expect(mocks.album.delete).not.toHaveBeenCalled();
    });

    it('deletes the albums, deepest first, and never a photo', async () => {
      const world = fakeWorld(mocks, ['/photos']);
      world.addFile('/photos/trip/day1/a.jpg');
      await sut.sync(world.library.id);
      const trip = world.albumFor('/photos/trip')!;
      const day1 = world.albumFor('/photos/trip/day1')!;

      await expect(sut.removeAll(world.library.id, { removeAlbums: true })).resolves.toBe(2);

      expect(world.albums.size).toBe(0);
      expect(mocks.album.delete.mock.calls).toEqual([[day1.id], [trip.id]]);
      expect(world.assets).toHaveLength(1);
      expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });
  });

  it('queues one sync per library', async () => {
    await sut.queueSync('library-1');
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryFolderAlbumSync, data: { id: 'library-1' } });
  });
});

describe('folder album planning', () => {
  it('leaves out folders outside the import folders and those nested too deep', () => {
    const tree = buildFolderTree(
      ['/photos'],
      [
        { folderPath: '/photos/a/b', photos: 2 },
        { folderPath: '/elsewhere', photos: 1 },
        { folderPath: '/photos/a/b/c/d', photos: 1 },
      ],
      4,
    );
    // '/photos/a/b/c/d' would be the fifth level; '/photos' holds no photo of its own
    expect(tree.keys().toArray().toSorted()).toEqual(['/photos/a', '/photos/a/b']);
    expect(tree.get('/photos/a')).toMatchObject({ parentPath: null, photos: 0, depth: 2 });
    expect(tree.get('/photos/a/b')).toMatchObject({ parentPath: '/photos/a', photos: 2, depth: 3 });
    expect(buildFolderTree(['/photos'], [{ folderPath: '/photos', photos: 3 }]).get('/photos')).toMatchObject({
      parentPath: null,
      photos: 3,
      depth: 1,
    });
    expect(buildFolderTree(['/photos'], [{ folderPath: '/photos/a/b/c/d', photos: 1 }], 4).size).toBe(0);
  });

  it('plans albums at a chosen level, with the folders above as collections when asked', () => {
    const counts = [
      { folderPath: '/p/2026/Trip/Capture', photos: 3 },
      { folderPath: '/p/2026/Trip', photos: 1 },
      { folderPath: '/p/2026/cover.jpg-folder', photos: 0, items: 2 },
      { folderPath: '/p/2026', photos: 1 },
    ];
    const options = { ...LEGACY_FOLDER_ALBUM_OPTIONS, shape: 'level' as const, level: 2 };
    const flat = planFolderAlbums(['/p'], counts, { ...options, collectionsAbove: false }, 'Lib');
    expect(flat.get('/p/2026/Trip')).toMatchObject({
      parentPath: null,
      kind: AlbumKind.Album,
      photos: 4,
      members: ['/p/2026/Trip/Capture', '/p/2026/Trip'],
    });
    // a folder above the level holding photos of its own still gets an album
    expect(flat.get('/p/2026')).toMatchObject({ parentPath: null, members: ['/p/2026'] });
    expect(flat.has('/p/2026/cover.jpg-folder')).toBe(false);

    const nested = planFolderAlbums(['/p'], counts, { ...options, naming: 'path', skipEmpty: false }, 'Lib');
    expect(nested.get('/p/2026/Trip')).toMatchObject({ parentPath: '/p/2026', name: '2026 › Trip' });
    expect(nested.get('/p/2026/cover.jpg-folder')).toMatchObject({ photos: 0, parentPath: '/p/2026' });
  });

  it('plans an album for every folder as FL-838 did', () => {
    const plan = planFolderAlbums(
      ['/photos'],
      [
        { folderPath: '/photos', photos: 1 },
        { folderPath: '/photos/2020/trip', photos: 2 },
      ],
      LEGACY_FOLDER_ALBUM_OPTIONS,
      'Photos',
    );
    expect(plan.get('/photos')).toMatchObject({ name: 'Photos', kind: AlbumKind.Album, parentPath: null });
    expect(plan.get('/photos/2020')).toMatchObject({ kind: AlbumKind.Collection, members: [] });
    expect(plan.get('/photos/2020/trip')).toMatchObject({ parentPath: '/photos/2020', members: ['/photos/2020/trip'] });
  });

  it('tells a folder-by-event layout from an ordinary one', () => {
    const event = (name: string) => [
      { folderPath: `/p/${name}/Capture`, photos: 1 },
      { folderPath: `/p/${name}/RAW`, photos: 1 },
    ];
    expect(looksLikeEventFolders(['/p'], [...event('2026-01-01 A'), ...event('2026-01-02 B')])).toBe(true);
    expect(
      looksLikeEventFolders(
        ['/p'],
        [
          { folderPath: '/p/2020/trip', photos: 1 },
          { folderPath: '/p/2021/party', photos: 1 },
        ],
      ),
    ).toBe(false);
  });

  it('matches a moved folder by most of its files, and a folder of folders by where they went', () => {
    const moves = matchMovedFolders(
      [
        { folderPath: '/p/old', keys: new Set() },
        { folderPath: '/p/old/x', keys: new Set(['1', '2', '3']) },
        { folderPath: '/p/gone', keys: new Set(['9', '8']) },
      ],
      new Map([
        ['/p/new/x', new Set(['1', '2', '4'])],
        ['/p/other', new Set(['8'])],
      ]),
      new Set(['/p/new', '/p/new/x', '/p/other']),
    );
    expect(moves).toEqual(
      new Map([
        ['/p/old/x', '/p/new/x'],
        ['/p/gone', '/p/other'],
        ['/p/old', '/p/new'],
      ]),
    );
  });
});

describe(`${LibraryService.name} folder albums`, () => {
  let sut: LibraryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(LibraryService));
    mocks.library.getAssetCounts.mockResolvedValue(new Map());
    mocks.library.getAll.mockResolvedValue([]);
  });

  it('turning folder albums on queues a sync', async () => {
    const library = factory.library();
    mocks.library.get.mockResolvedValue(library);
    mocks.library.update.mockResolvedValue({ ...library, folderAlbums: true });

    await expect(sut.update(library.id, { folderAlbums: true })).resolves.toMatchObject({ folderAlbums: true });

    expect(mocks.library.update).toHaveBeenCalledWith(library.id, expect.objectContaining({ folderAlbums: true }));
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryFolderAlbumSync, data: { id: library.id } });
  });

  it('turning folder albums off keeps the albums unless asked to remove them, never their photos', async () => {
    const library = factory.library({ folderAlbums: true });
    mocks.library.get.mockResolvedValue(library);
    mocks.library.update.mockResolvedValue({ ...library, folderAlbums: false });
    mocks.library.deleteFolderAlbums.mockResolvedValue([
      { albumId: 'album-root', folderPath: '/photos' },
      { albumId: 'album-trip', folderPath: '/photos/trip' },
    ]);
    mocks.album.delete.mockResolvedValue();

    await sut.update(library.id, { folderAlbums: false });
    expect(mocks.library.deleteFolderAlbums).toHaveBeenCalledWith(library.id);
    expect(mocks.album.delete).not.toHaveBeenCalled();

    await sut.update(library.id, { folderAlbums: false, removeFolderAlbums: true });
    expect(mocks.album.delete.mock.calls).toEqual([['album-trip'], ['album-root']]);
    expect(mocks.asset.deleteAll).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.LibraryFolderAlbumSync }));
  });

  it('leaves folder albums alone when the setting is not part of the update', async () => {
    const library = factory.library({ folderAlbums: true });
    mocks.library.get.mockResolvedValue(library);
    mocks.library.update.mockResolvedValue(library);

    await sut.update(library.id, { name: 'Renamed', removeFolderAlbums: true });

    expect(mocks.library.deleteFolderAlbums).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.LibraryFolderAlbumSync }));
  });
  it('new rules change the albums made so far to match, or apply to new folders only', async () => {
    const library = factory.library({ folderAlbums: true });
    mocks.library.get.mockResolvedValue(library);
    mocks.library.update.mockResolvedValue(library);
    mocks.library.setFolderAlbumsKept.mockResolvedValue();

    await sut.update(library.id, { folderAlbumOptions: EVENT_FOLDER_ALBUM_OPTIONS });
    expect(mocks.library.setFolderAlbumsKept).toHaveBeenLastCalledWith(library.id, false);

    await sut.update(library.id, { folderAlbumOptions: EVENT_FOLDER_ALBUM_OPTIONS, folderAlbumExisting: 'newOnly' });
    expect(mocks.library.setFolderAlbumsKept).toHaveBeenLastCalledWith(library.id, true);
    expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LibraryFolderAlbumSync, data: { id: library.id } });

    // the same rules again change nothing
    mocks.library.setFolderAlbumsKept.mockClear();
    await sut.update(library.id, { folderAlbumOptions: LEGACY_FOLDER_ALBUM_OPTIONS });
    expect(mocks.library.setFolderAlbumsKept).not.toHaveBeenCalled();
  });
});
