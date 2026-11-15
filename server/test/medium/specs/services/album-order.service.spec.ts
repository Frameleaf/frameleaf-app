import { Kysely } from 'kysely';
import { AssetOrder } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumOrderService } from 'src/services/album-order.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumOrderService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository],
    mock: [EventRepository, LoggingRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return services;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/** Photos and cards of an album in custom order, as `asset:<id>` / `card:<heading>`. */
const readOrder = async (db: Kysely<DB>, albumId: string) => {
  const assets = await db
    .selectFrom('album_asset')
    .select(['assetId as id', 'position'])
    .where('albumId', '=', albumId)
    .execute();
  const cards = await db
    .selectFrom('album_text_card')
    .select(['heading as id', 'position'])
    .where('albumId', '=', albumId)
    .execute();
  return [
    ...assets.map((row) => ({ key: `asset:${row.id}`, position: row.position })),
    ...cards.map((row) => ({ key: `card:${row.id}`, position: row.position as number | null })),
  ]
    .toSorted((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
    .map(({ key }) => key);
};

describe(AlbumOrderService.name, () => {
  const makeAlbum = async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset: first } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2026-01-01T00:00:00Z') });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2026-01-02T00:00:00Z') });
    const { asset: third } = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2026-01-03T00:00:00Z') });
    const { album } = await ctx.newAlbum({ ownerId: user.id, order: AssetOrder.Asc }, [third.id, first.id, second.id]);
    return { sut, ctx, auth, album, first, second, third };
  };

  it('seeds the order from the date order, moves photos and keeps it', async () => {
    const { sut, ctx, auth, album, first, second, third } = await makeAlbum();

    await sut.setAssetOrder(auth, album.id, { assetIds: [first.id], afterAssetId: third.id });

    expect(await readOrder(ctx.database, album.id)).toEqual([
      `asset:${second.id}`,
      `asset:${third.id}`,
      `asset:${first.id}`,
    ]);
    const stored = await ctx.database
      .selectFrom('album')
      .select('isCustomOrder')
      .where('id', '=', album.id)
      .executeTakeFirstOrThrow();
    expect(stored.isCustomOrder).toBe(true);
  });

  it('places a card between photos and photos after a card', async () => {
    const { sut, ctx, auth, album, first, second, third } = await makeAlbum();

    const card = await sut.createTextCard(auth, album.id, { heading: 'Day two', body: '', afterAssetId: first.id });
    expect(card.afterAssetId).toBe(first.id);
    await sut.setAssetOrder(auth, album.id, { assetIds: [third.id], afterTextCardId: card.id });

    expect(await readOrder(ctx.database, album.id)).toEqual([
      `asset:${first.id}`,
      'card:Day two',
      `asset:${third.id}`,
      `asset:${second.id}`,
    ]);

    await sut.deleteTextCard(auth, album.id, card.id);
    expect(await readOrder(ctx.database, album.id)).toEqual([
      `asset:${first.id}`,
      `asset:${third.id}`,
      `asset:${second.id}`,
    ]);
  });

  it('renumbers the album when neighbours are too close to place between', async () => {
    const { sut, ctx, auth, album, first, second, third } = await makeAlbum();
    await sut.setAssetOrder(auth, album.id, { assetIds: [first.id], afterAssetId: null });
    await ctx.database.updateTable('album_asset').set({ position: 1 }).where('assetId', '=', first.id).execute();
    await ctx.database
      .updateTable('album_asset')
      .set({ position: 1 + 1e-12 })
      .where('assetId', '=', second.id)
      .execute();
    await ctx.database.updateTable('album_asset').set({ position: 2 }).where('assetId', '=', third.id).execute();

    await sut.setAssetOrder(auth, album.id, { assetIds: [third.id], afterAssetId: first.id });

    expect(await readOrder(ctx.database, album.id)).toEqual([
      `asset:${first.id}`,
      `asset:${third.id}`,
      `asset:${second.id}`,
    ]);
    const positions = await ctx.database
      .selectFrom('album_asset')
      .select('position')
      .where('albumId', '=', album.id)
      .orderBy('position')
      .execute();
    const values = positions.map(({ position }) => position!);
    expect(values[1] - values[0]).toBeGreaterThan(1e-6);
  });

  it('moves 500 photos in one request', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const ids: string[] = [];
    for (let index = 0; index < 501; index++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      ids.push(asset.id);
    }
    const { album } = await ctx.newAlbum({ ownerId: user.id }, ids);
    const [anchor, ...moving] = ids;

    const started = performance.now();
    await sut.setAssetOrder(auth, album.id, { assetIds: moving.toReversed(), afterAssetId: anchor });
    expect(performance.now() - started).toBeLessThan(1000);

    expect(await readOrder(ctx.database, album.id)).toEqual(
      [anchor, ...moving.toReversed()].map((id) => `asset:${id}`),
    );
  });
});
