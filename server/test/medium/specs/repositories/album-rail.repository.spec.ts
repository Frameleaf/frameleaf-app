import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole, LibraryScope } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AlbumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** FL-1791: the rail reads the same albums in the same order as the full list, with far less per album. */
describe(AlbumRepository.prototype.getRail.name, () => {
  it("lists the albums of the full list in the same order, with the viewer's role and whether each is shared", async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: friend } = await ctx.newUser();
    const { album: collection } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Collection, sortOrder: 2 });
    const { album: inside } = await ctx.newAlbum({ ownerId: owner.id, parentId: collection.id, sortOrder: 1 });
    const { album: unplaced } = await ctx.newAlbum({ ownerId: owner.id, icon: 'mdiCameraOutline', color: 'teal' });
    const { album: theirs } = await ctx.newAlbum({ ownerId: friend.id });
    await ctx.newAlbumUser({ albumId: theirs.id, userId: owner.id, role: AlbumUserRole.Viewer });
    await ctx.newAlbumUser({ albumId: inside.id, userId: friend.id, role: AlbumUserRole.Editor });
    await ctx.newAlbum({ ownerId: friend.id });

    const rail = await sut.getRail(owner.id, { libraryScope: LibraryScope.Personal });
    const full = await sut.getAll(owner.id, { libraryScope: LibraryScope.Personal });

    expect(rail.map(({ id }) => id)).toEqual(full.map(({ id }) => id));
    expect(rail).toHaveLength(4);
    const byId = new Map(rail.map((row) => [row.id, row]));
    expect(byId.get(collection.id)).toMatchObject({
      kind: AlbumKind.Collection,
      role: AlbumUserRole.Owner,
      shared: false,
    });
    expect(byId.get(inside.id)).toMatchObject({ parentId: collection.id, role: AlbumUserRole.Owner, shared: true });
    expect(byId.get(unplaced.id)).toMatchObject({ icon: 'mdiCameraOutline', color: 'teal', shared: false });
    expect(byId.get(theirs.id)).toMatchObject({ role: AlbumUserRole.Viewer, shared: true });
    expect(Object.keys(rail[0]).sort()).toEqual([
      'albumName',
      'color',
      'icon',
      'id',
      'isLocked',
      'kind',
      'parentId',
      'role',
      'shared',
      'sortOrder',
    ]);

    const without = await sut.getRail(owner.id, { libraryScope: LibraryScope.Personal, excludeIds: [unplaced.id] });
    expect(without.map(({ id }) => id)).not.toContain(unplaced.id);
  });

  it('keeps Boards albums out of the Library rail, and the other way round', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { album: library } = await ctx.newAlbum({ ownerId: owner.id });
    const { album: boards } = await ctx.newAlbum({ ownerId: owner.id, libraryScope: LibraryScope.Design });

    const personal = await sut.getRail(owner.id, { libraryScope: LibraryScope.Personal });
    const design = await sut.getRail(owner.id, { libraryScope: LibraryScope.Design });

    expect(personal.map(({ id }) => id)).toEqual([library.id]);
    expect(design.map(({ id }) => id)).toEqual([boards.id]);
  });
});
