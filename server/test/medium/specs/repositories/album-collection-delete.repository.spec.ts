import { Kysely } from 'kysely';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
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

describe('nested album mutation boundaries', () => {
  it.each(['delete', 'deleteCollection'] as const)('%s preserves child albums and file membership', async (method) => {
    const { ctx, albums } = setup();
    const { user } = await ctx.newUser();
    const { album: outer } = await ctx.newAlbum({ ownerId: user.id });
    const { album: parent } = await ctx.newAlbum({ ownerId: user.id });
    const { album: child } = await ctx.newAlbum({ ownerId: user.id });
    const { album: leaf } = await ctx.newAlbum({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await albums.reparent(parent.id, outer.id);
    await albums.reparent(child.id, parent.id);
    await albums.reparent(leaf.id, child.id);
    await albums.addAssetIdsToAlbums([{ albumId: child.id, assetId: asset.id }]);

    await albums[method](parent.id);

    await expect(parentOf(child.id)).resolves.toBe(outer.id);
    await expect(parentOf(leaf.id)).resolves.toBe(child.id);
    await expect(ancestorsOf(leaf.id)).resolves.toEqual([outer.id, child.id].toSorted());
    expect(await db.selectFrom('album_asset').selectAll().where('albumId', '=', child.id).execute()).toEqual([
      expect.objectContaining({ assetId: asset.id }),
    ]);
    expect(await db.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst()).toBeDefined();
  });

  it("moving a subtree keeps each node's existing grants", async () => {
    const { ctx, albums } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const { album: parent } = await ctx.newAlbum({ ownerId: owner.id });
    const { album: child } = await ctx.newAlbum({ ownerId: owner.id });
    const { album: destination } = await ctx.newAlbum({ ownerId: owner.id });
    await albums.reparent(child.id, parent.id);
    await db
      .insertInto('album_user')
      .values({ albumId: child.id, userId: viewer.id, role: AlbumUserRole.Viewer })
      .execute();
    const before = await db
      .selectFrom('album_user')
      .select(['albumId', 'userId', 'role'])
      .orderBy('albumId')
      .orderBy('userId')
      .execute();
    await albums.reparent(parent.id, destination.id);
    expect(
      await db
        .selectFrom('album_user')
        .select(['albumId', 'userId', 'role'])
        .orderBy('albumId')
        .orderBy('userId')
        .execute(),
    ).toEqual(before);
  });

  it('concurrent deletion and move preserve a surviving child with valid ancestry', async () => {
    const { ctx, albums } = setup();
    const { user } = await ctx.newUser();
    const { album: parent } = await ctx.newAlbum({ ownerId: user.id });
    const { album: child } = await ctx.newAlbum({ ownerId: user.id });
    const { album: destination } = await ctx.newAlbum({ ownerId: user.id });
    await albums.reparent(child.id, parent.id);
    await Promise.all([albums.deleteCollection(parent.id), albums.reparent(child.id, destination.id)]);
    await expect(parentOf(child.id)).resolves.toBe(destination.id);
    await expect(ancestorsOf(child.id)).resolves.toEqual([destination.id]);
  });

  it('rejects depth 33 including the height of a moved subtree', async () => {
    const { ctx, albums } = setup();
    const { user } = await ctx.newUser();
    const nodes: string[] = [];
    for (let i = 0; i < 32; i++) {
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      nodes.push(album.id);
      if (i > 0) await albums.reparent(album.id, nodes[i - 1]);
    }
    const { album: extra } = await ctx.newAlbum({ ownerId: user.id });
    await expect(albums.reparent(extra.id, nodes[31])).rejects.toThrow('32');
    await expect(parentOf(extra.id)).resolves.toBeNull();
    await expect(albums.reparent(nodes[0], extra.id)).rejects.toThrow('32');
    await expect(parentOf(nodes[0])).resolves.toBeNull();
  });

  it('rejects insertion below the deepest allowed parent', async () => {
    const { ctx, albums } = setup();
    const { user } = await ctx.newUser();
    let parentId: string | null = null;
    for (let i = 0; i < 32; i++) {
      const album = await albums.create(
        { albumName: `level-${i}`, parentId },
        [],
        [{ userId: user.id, role: AlbumUserRole.Owner }],
        user.id,
      );
      parentId = album.id;
    }
    await expect(
      albums.create({ albumName: 'too deep', parentId }, [], [{ userId: user.id, role: AlbumUserRole.Owner }], user.id),
    ).rejects.toThrow('32');
  });

  it('serializes opposite concurrent moves so exactly one is rejected', async () => {
    const { ctx, albums } = setup();
    const { user } = await ctx.newUser();
    const { album: first } = await ctx.newAlbum({ ownerId: user.id });
    const { album: second } = await ctx.newAlbum({ ownerId: user.id });
    const results = await Promise.allSettled([
      albums.reparent(first.id, second.id),
      albums.reparent(second.id, first.id),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const parents = await Promise.all([parentOf(first.id), parentOf(second.id)]);
    expect(parents.filter((id) => id === null)).toHaveLength(1);
    const ancestors = await Promise.all([ancestorsOf(first.id), ancestorsOf(second.id)]);
    expect(ancestors.map((ids) => ids.length).toSorted((a, b) => a - b)).toEqual([0, 1]);
  });
});
