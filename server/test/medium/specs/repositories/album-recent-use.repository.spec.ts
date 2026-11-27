import { Kysely } from 'kysely';
import { AlbumUserRole, LibraryScope } from 'src/enum.js';
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

/** FL-1814: "Used lately" is the albums this account itself last added to, never anyone else's adds. */
describe(AlbumRepository.prototype.getRecentlyUsedIds.name, () => {
  it('lists the albums this account added to, most recent first, and moves one forward when used again', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { album: first } = await ctx.newAlbum({ ownerId: user.id });
    const { album: second } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbum({ ownerId: user.id });

    await sut.recordUse(user.id, [first.id]);
    await sut.recordUse(user.id, [second.id]);
    expect(await sut.getRecentlyUsedIds(user.id)).toEqual([second.id, first.id]);

    await sut.recordUse(user.id, [first.id, first.id]);
    expect(await sut.getRecentlyUsedIds(user.id)).toEqual([first.id, second.id]);
  });

  it('keeps each account to its own adds, and drops albums it can no longer add to', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: friend } = await ctx.newUser();
    const { album: shared } = await ctx.newAlbum({ ownerId: owner.id });
    await ctx.newAlbumUser({ albumId: shared.id, userId: friend.id, role: AlbumUserRole.Editor });
    const { album: deleted } = await ctx.newAlbum({ ownerId: owner.id, deletedAt: new Date() });

    await sut.recordUse(friend.id, [shared.id]);
    await sut.recordUse(owner.id, [deleted.id]);
    expect(await sut.getRecentlyUsedIds(owner.id)).toEqual([]);
    expect(await sut.getRecentlyUsedIds(friend.id, { libraryScope: LibraryScope.Personal })).toEqual([shared.id]);

    // demoted to viewer: it can no longer add, so it is no longer offered
    await ctx.database
      .updateTable('album_user')
      .set({ role: AlbumUserRole.Viewer })
      .where('albumId', '=', shared.id)
      .where('userId', '=', friend.id)
      .execute();
    expect(await sut.getRecentlyUsedIds(friend.id)).toEqual([]);
  });

  it('leaves Locked albums out for a connected app', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { album: locked } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });
    await sut.recordUse(user.id, [locked.id]);

    expect(await sut.getRecentlyUsedIds(user.id)).toEqual([locked.id]);
    expect(await sut.getRecentlyUsedIds(user.id, { excludeLocked: true })).toEqual([]);
  });
});
