import { Kysely } from 'kysely';
import { AlbumKind, AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { AlbumSummaryRepository } from 'src/repositories/album-summary.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FolderAlbumService } from 'src/services/folder-album.service.js';
import { albumFolderView, resolveAlbumFolderChoices } from 'src/utils/album-folders.js';
import { EVENT_FOLDER_ALBUM_OPTIONS, LEGACY_FOLDER_ALBUM_OPTIONS } from 'src/utils/folder-albums.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(FolderAlbumService, {
    database: db || defaultDatabase,
    real: [
      AlbumRepository,
      AlbumSummaryRepository,
      AssetRepository,
      DatabaseRepository,
      LibraryRepository,
      PartnerOriginRepository,
      PartnerRepository,
      UserRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  services.ctx.getMock(JobRepository).queue.mockResolvedValue();
  services.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return services;
};

type Context = ReturnType<typeof setup>['ctx'];

const newLibrary = async (ctx: Context, importPaths: string[]) => {
  const { user } = await ctx.newUser();
  const library = await ctx.get(LibraryRepository).create({
    ownerId: user.id,
    name: 'Folder albums',
    importPaths,
    exclusionPatterns: [],
    folderAlbums: true,
  });
  const file = async (
    originalPath: string,
    options: { isOffline?: boolean; fileModifiedAt?: Date; takenAt?: Date; type?: AssetType } = {},
  ) => {
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      libraryId: library.id,
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      originalPath,
      originalFileName: originalPath.split('/').at(-1)!,
      fileModifiedAt: options.fileModifiedAt ?? new Date('2024-06-01T12:00:00Z'),
      isOffline: options.isOffline ?? false,
      deletedAt: options.isOffline ? new Date() : null,
      ...(options.takenAt && { fileCreatedAt: options.takenAt, localDateTime: options.takenAt }),
      ...(options.type && { type: options.type }),
    });
    return asset;
  };
  return { user, library, file };
};

const folderAlbum = (db: Kysely<DB>, libraryId: string, folderPath: string) =>
  db
    .selectFrom('library_folder_album')
    .innerJoin('album', 'album.id', 'library_folder_album.albumId')
    .select(['album.id', 'album.albumName', 'album.parentId', 'album.kind', 'library_folder_album.isUserEdited'])
    .where('library_folder_album.libraryId', '=', libraryId)
    .where('library_folder_album.folderPath', '=', folderPath)
    .executeTakeFirst();

const membersOf = async (db: Kysely<DB>, albumId: string) =>
  (await db.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute())
    .map(({ assetId }) => assetId)
    .toSorted();

const offline = (db: Kysely<DB>, assetIds: string[]) =>
  db.updateTable('asset').set({ isOffline: true, deletedAt: new Date() }).where('id', 'in', assetIds).execute();

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(FolderAlbumService.name, () => {
  it('fills the albums of subfolders whose parent folder holds only folders', async () => {
    const { sut, ctx } = setup();
    const { library, file } = await newLibrary(ctx, ['/fl838/events']);
    const photo = await file("/fl838/events/2026-10-12 - Nathan's Birth/Capture/a.jpg");
    const video = await file("/fl838/events/2026-10-12 - Nathan's Birth/Videos/b.mp4");

    await expect(sut.sync(library.id)).resolves.toMatchObject({ created: 3, photosAdded: 2 });

    const event = await folderAlbum(defaultDatabase, library.id, "/fl838/events/2026-10-12 - Nathan's Birth");
    const capture = await folderAlbum(defaultDatabase, library.id, "/fl838/events/2026-10-12 - Nathan's Birth/Capture");
    const videos = await folderAlbum(defaultDatabase, library.id, "/fl838/events/2026-10-12 - Nathan's Birth/Videos");
    expect(event).toMatchObject({ kind: AlbumKind.Collection, parentId: null });
    expect(capture).toMatchObject({ parentId: event!.id });
    expect(await membersOf(defaultDatabase, capture!.id)).toEqual([photo.id]);
    expect(await membersOf(defaultDatabase, videos!.id)).toEqual([video.id]);
  });

  it('FL-1837: one album for each event folder, changed to match and back again', async () => {
    const { sut, ctx } = setup();
    const { library, file } = await newLibrary(ctx, ['/fl1837/events']);
    const root = '/fl1837/events/2026-11-19 - Nathan';
    const capture = await file(`${root}/Capture/a.jpg`);
    const exported = await file(`${root}/Export/a-edit.jpg`);
    await sut.sync(library.id);
    expect(await folderAlbum(defaultDatabase, library.id, root)).toMatchObject({ kind: AlbumKind.Collection });

    await ctx.get(LibraryRepository).update(library.id, { folderAlbumOptions: EVENT_FOLDER_ALBUM_OPTIONS });
    await sut.sync(library.id);
    const event = await folderAlbum(defaultDatabase, library.id, root);
    expect(event).toMatchObject({ kind: AlbumKind.Album, parentId: null });
    expect(await membersOf(defaultDatabase, event!.id)).toEqual([capture.id]);
    expect(await folderAlbum(defaultDatabase, library.id, `${root}/Capture`)).toBeUndefined();
    const exportAlbum = await folderAlbum(defaultDatabase, library.id, `${root}/Export`);
    expect(exportAlbum).toMatchObject({ parentId: event!.id });
    expect(await membersOf(defaultDatabase, exportAlbum!.id)).toEqual([exported.id]);

    // back to an album for every folder: the event's album is emptied and a collection again
    await ctx.get(LibraryRepository).update(library.id, { folderAlbumOptions: LEGACY_FOLDER_ALBUM_OPTIONS });
    await sut.sync(library.id);
    expect(await folderAlbum(defaultDatabase, library.id, root)).toMatchObject({
      id: event!.id,
      kind: AlbumKind.Collection,
    });
    expect(await membersOf(defaultDatabase, event!.id)).toEqual([]);
    const captureAlbum = await folderAlbum(defaultDatabase, library.id, `${root}/Capture`);
    expect(await membersOf(defaultDatabase, captureAlbum!.id)).toEqual([capture.id]);
  });

  it("makes nested albums for nested folders, owned by the library owner, with the import folder's own photos beside them", async () => {
    const { sut, ctx } = setup();
    const { user, library, file } = await newLibrary(ctx, ['/fl838/nested']);
    const a = await file('/fl838/nested/a.jpg');
    const b = await file('/fl838/nested/trip/b.jpg');
    const c = await file('/fl838/nested/trip/day1/c.jpg');
    await file('/fl838/nested/trip/day1/gone.jpg', { isOffline: true });

    await expect(sut.sync(library.id)).resolves.toMatchObject({ created: 3, photosAdded: 3 });

    const top = await folderAlbum(defaultDatabase, library.id, '/fl838/nested');
    const trip = await folderAlbum(defaultDatabase, library.id, '/fl838/nested/trip');
    const day1 = await folderAlbum(defaultDatabase, library.id, '/fl838/nested/trip/day1');
    // FL-838 decision 2: the import folder's own photos are in an album named after the library, beside the
    // folders' albums rather than above them
    expect(top).toMatchObject({ albumName: 'Folder albums', parentId: null, kind: AlbumKind.Album });
    expect(trip).toMatchObject({ albumName: 'trip', parentId: null, kind: AlbumKind.Album });
    expect(day1).toMatchObject({ albumName: 'day1', parentId: trip!.id, kind: AlbumKind.Album });
    expect(await membersOf(defaultDatabase, top!.id)).toEqual([a.id]);
    expect(await membersOf(defaultDatabase, trip!.id)).toEqual([b.id]);
    expect(await membersOf(defaultDatabase, day1!.id)).toEqual([c.id]);

    const owner = await defaultDatabase
      .selectFrom('album_user')
      .select(['userId', 'role'])
      .where('albumId', '=', day1!.id)
      .execute();
    expect(owner).toEqual([{ userId: user.id, role: 'owner' }]);
    const ancestors = await defaultDatabase
      .selectFrom('album_closure')
      .select('id_ancestor')
      .where('id_descendant', '=', day1!.id)
      .execute();
    expect(ancestors.map(({ id_ancestor }) => id_ancestor).toSorted()).toEqual([trip!.id, day1!.id].toSorted());

    // a second run changes nothing
    await expect(sut.sync(library.id)).resolves.toEqual({
      created: 0,
      moved: 0,
      removed: 0,
      photosAdded: 0,
      photosRemoved: 0,
    });
  });

  it('adds new files, takes out gone ones, keeps photos put in by hand and never touches an item', async () => {
    const { sut, ctx } = setup();
    const { user, library, file } = await newLibrary(ctx, ['/fl838/members']);
    const a = await file('/fl838/members/a.jpg');
    const b = await file('/fl838/members/b.jpg');
    await sut.sync(library.id);
    const album = (await folderAlbum(defaultDatabase, library.id, '/fl838/members'))!;
    const { asset: upload } = await ctx.newAsset({ ownerId: user.id });
    await ctx.get(AlbumRepository).addAssetIds(album.id, [upload.id]);

    const c = await file('/fl838/members/c.jpg');
    await offline(defaultDatabase, [b.id]);
    await expect(sut.sync(library.id)).resolves.toMatchObject({ photosAdded: 1, photosRemoved: 1 });

    expect(await membersOf(defaultDatabase, album.id)).toEqual([a.id, c.id, upload.id].toSorted());
    expect(await folderAlbum(defaultDatabase, library.id, '/fl838/members')).toMatchObject({ isUserEdited: true });
    expect(await defaultDatabase.selectFrom('asset').select('id').where('id', '=', b.id).executeTakeFirst()).toEqual({
      id: b.id,
    });
  });

  it('follows a renamed folder unless the owner renamed its album, and drops albums of emptied folders', async () => {
    const { sut, ctx } = setup();
    const { library, file } = await newLibrary(ctx, ['/fl838/rename']);
    const old = [await file('/fl838/rename/trip/a.jpg'), await file('/fl838/rename/trip/b.jpg')];
    const named = await file('/fl838/rename/named/x.jpg');
    const emptied = await file('/fl838/rename/emptied/y.jpg');
    await file('/fl838/rename/keep.jpg');
    await sut.sync(library.id);
    const trip = (await folderAlbum(defaultDatabase, library.id, '/fl838/rename/trip'))!;
    const namedAlbum = (await folderAlbum(defaultDatabase, library.id, '/fl838/rename/named'))!;
    await defaultDatabase.updateTable('album').set({ albumName: 'Best of' }).where('id', '=', namedAlbum.id).execute();

    // the scan sees the renamed folders as new files, and the old ones go offline
    await offline(defaultDatabase, [...old.map(({ id }) => id), named.id, emptied.id]);
    const moved = [await file('/fl838/rename/holiday/a.jpg'), await file('/fl838/rename/holiday/b.jpg')];
    const movedNamed = await file('/fl838/rename/renamed/x.jpg');

    await expect(sut.sync(library.id)).resolves.toMatchObject({ created: 0, moved: 2, removed: 1 });

    expect(await folderAlbum(defaultDatabase, library.id, '/fl838/rename/holiday')).toMatchObject({
      id: trip.id,
      albumName: 'holiday',
    });
    expect(await membersOf(defaultDatabase, trip.id)).toEqual(moved.map(({ id }) => id).toSorted());
    expect(await folderAlbum(defaultDatabase, library.id, '/fl838/rename/renamed')).toMatchObject({
      id: namedAlbum.id,
      albumName: 'Best of',
      isUserEdited: true,
    });
    expect(await membersOf(defaultDatabase, namedAlbum.id)).toEqual([movedNamed.id]);
    expect(await folderAlbum(defaultDatabase, library.id, '/fl838/rename/emptied')).toBeUndefined();
    expect(await defaultDatabase.selectFrom('asset').select('id').where('id', '=', emptied.id).execute()).toHaveLength(
      1,
    );
  });

  it('turned off, keeps the albums or deletes them, and never a photo', async () => {
    const { sut, ctx } = setup();
    const { library, file } = await newLibrary(ctx, ['/fl838/off']);
    const a = await file('/fl838/off/trip/a.jpg');
    await sut.sync(library.id);
    const trip = (await folderAlbum(defaultDatabase, library.id, '/fl838/off/trip'))!;

    await expect(sut.removeAll(library.id, { removeAlbums: false })).resolves.toBe(0);
    expect(await defaultDatabase.selectFrom('album').select('id').where('id', '=', trip.id).execute()).toHaveLength(1);
    expect(
      await defaultDatabase
        .selectFrom('library_folder_album')
        .select('id')
        .where('libraryId', '=', library.id)
        .execute(),
    ).toEqual([]);

    // only trip has an album: no photo is loose in the import folder, so it has none (FL-838 decision 2)
    await sut.sync(library.id);
    await expect(sut.removeAll(library.id, { removeAlbums: true })).resolves.toBe(1);
    expect(
      await defaultDatabase
        .selectFrom('library_folder_album')
        .select('id')
        .where('libraryId', '=', library.id)
        .execute(),
    ).toEqual([]);
    expect(await defaultDatabase.selectFrom('asset').select('id').where('id', '=', a.id).execute()).toHaveLength(1);
  });

  it("tells only the library's owner which folder an album shows", async () => {
    const { sut, ctx } = setup();
    const { user, library, file } = await newLibrary(ctx, ['/fl838/source']);
    await file('/fl838/source/a.jpg');
    await sut.sync(library.id);
    const album = (await folderAlbum(defaultDatabase, library.id, '/fl838/source'))!;
    const { user: other } = await ctx.newUser();

    const albums = ctx.get(AlbumRepository);
    expect(await albums.getFolderAlbumSources([album.id], user.id)).toEqual(
      new Map([[album.id, { libraryId: library.id, folderPath: '/fl838/source' }]]),
    );
    expect(await albums.getFolderAlbumSources([album.id], other.id)).toEqual(new Map());
  });

  it('FL-1838: an album shows its folders as chosen, each photo once with its versions behind it', async () => {
    const { sut, ctx } = setup();
    const { user, library, file } = await newLibrary(ctx, ['/fl1838/events']);
    await ctx.get(LibraryRepository).update(library.id, {
      folderAlbumOptions: { ...EVENT_FOLDER_ALBUM_OPTIONS, subfolders: { edits: 'join' } },
    });
    const root = '/fl1838/events/2026-11-19 - Nathan';
    const at = (hour: number) => new Date(`2026-11-19T${String(hour).padStart(2, '0')}:00:00Z`);
    const raw = await file(`${root}/RAW/IMG_1.CR3`, { takenAt: at(10) });
    const original = await file(`${root}/Original/IMG_1.JPG`, { takenAt: at(10) });
    const edit = await file(`${root}/Edits/IMG_1-edit.jpg`, { takenAt: at(10) });
    const lonely = await file(`${root}/Original/IMG_2.JPG`, { takenAt: at(11) });
    const renamed = await file(`${root}/Edits/Nathan-hug.jpg`, { takenAt: at(11) });
    const video = await file(`${root}/Video/clip.mp4`, { takenAt: at(12), type: AssetType.Video });
    await sut.sync(library.id);
    const event = await folderAlbum(defaultDatabase, library.id, root);
    expect(await membersOf(defaultDatabase, event!.id)).toHaveLength(6);

    const albums = ctx.get(AlbumRepository);
    const link = await albums.getFolderAlbumLink(event!.id);
    expect(link).toMatchObject({ folderPath: root, displayChoices: null, libraryOwnerId: user.id });
    const versions = await albums.getFolderVersions(event!.id, raw.id, root);
    expect(versions.map(({ id, folder, isFront }) => [id, folder, isFront])).toEqual([
      [edit.id, 'Edits', true],
      [raw.id, 'RAW', false],
      [original.id, 'Original', false],
    ]);

    const assets = ctx.get(AssetRepository);
    const auth = { user: { id: user.id } } as never;
    const bucket = async (only?: string, choices = resolveAlbumFolderChoices(null)) => {
      const albumView = albumFolderView(event!.id, root, choices, only);
      const { assets: json } = await assets.getTimeBucket('2026-11-01', { albumId: event!.id, albumView }, auth);
      const parsed = JSON.parse(json) as { id: string[]; versionCount?: number[] };
      return Object.fromEntries(parsed.id.map((id, index) => [id, parsed.versionCount?.[index] ?? null]));
    };
    // RAW hidden, Video in its own section, the edits in front of their originals
    expect(await bucket()).toEqual({ [edit.id]: 3, [renamed.id]: 2 });
    expect(await bucket('raw')).toEqual({ [raw.id]: null });
    expect(await bucket('Video')).toEqual({ [video.id]: null });
    const each = resolveAlbumFolderChoices({ versions: 'each', folders: { RAW: 'with', Video: 'with' } });
    expect(Object.keys(await bucket(undefined, each)).toSorted()).toEqual(
      [raw.id, original.id, edit.id, lonely.id, renamed.id, video.id].toSorted(),
    );
    // a version in front taken out of the album leaves the others showing
    await defaultDatabase.deleteFrom('album_asset').where('assetId', '=', edit.id).execute();
    expect(await bucket()).toEqual({ [original.id]: 0, [renamed.id]: 2 });
  });
});
