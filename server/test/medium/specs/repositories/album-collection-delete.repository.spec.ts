import { Kysely } from 'kysely';
import { AlbumKind } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-146: deleting a collection keeps its albums, moved to the collection's own parent (the prototype's
 * `deleteCollection`, collections-data.mjs), in one transaction.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, albums: ctx.get(AlbumRepository) };
};

type Context = ReturnType<typeof setup>['ctx'];

const parentOf = async (id: string) =>
  (await db.selectFrom('album').select('parentId').where('id', '=', id).executeTakeFirst())?.parentId;

const ancestorsOf = async (id: string) =>
  (
    await db
      .selectFrom('album_closure')
      .select('id_ancestor')
      .where('id_descendant', '=', id)
      .where('id_ancestor', '!=', id)
      .execute()
  )
    .map(({ id_ancestor }) => id_ancestor)
    .toSorted();

/** outer collection › inner collection › two albums */
const tree = async (ctx: Context, albums: AlbumRepository) => {
  const { user } = await ctx.newUser();
  const { album: outer } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
  const { album: inner } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
  const { album: first } = await ctx.newAlbum({ ownerId: user.id });
  const { album: second } = await ctx.newAlbum({ ownerId: user.id });
  await albums.reparent(inner.id, outer.id);
  await albums.reparent(first.id, inner.id);
  await albums.reparent(second.id, inner.id);
  return { outer, inner, first, second };
};

describe('deleting a collection (FL-146)', () => {
  it("moves its albums to the collection's parent, with their ancestry", async () => {
    const { ctx, albums } = setup();
    const { outer, inner, first, second } = await tree(ctx, albums);

    await albums.deleteCollection(inner.id);

    await expect(parentOf(inner.id)).resolves.toBeUndefined();
    for (const album of [first, second]) {
      await expect(parentOf(album.id)).resolves.toBe(outer.id);
      await expect(ancestorsOf(album.id)).resolves.toEqual([outer.id]);
    }
  });

  it('moves the albums of a top-level collection to the top level', async () => {
    const { ctx, albums } = setup();
    const { outer, inner } = await tree(ctx, albums);

    await albums.deleteCollection(outer.id);

    await expect(parentOf(inner.id)).resolves.toBeNull();
    await expect(ancestorsOf(inner.id)).resolves.toEqual([]);
  });

  it('keeps everything as it was when the delete fails part-way', async () => {
    const { ctx, albums } = setup();
    const { outer, inner, first, second } = await tree(ctx, albums);
    const smartAlbums = (albums as unknown as { smartAlbums: { deleteAlbums: () => Promise<void> } }).smartAlbums;
    const spy = vi.spyOn(smartAlbums, 'deleteAlbums').mockRejectedValueOnce(new Error('interrupted'));

    await expect(albums.deleteCollection(inner.id)).rejects.toThrow('interrupted');
    spy.mockRestore();

    await expect(parentOf(inner.id)).resolves.toBe(outer.id);
    for (const album of [first, second]) {
      await expect(parentOf(album.id)).resolves.toBe(inner.id);
      await expect(ancestorsOf(album.id)).resolves.toEqual([inner.id, outer.id].toSorted());
    }
  });
});
