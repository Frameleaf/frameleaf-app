import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { TimelineService } from 'src/services/timeline.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-786: a heart on someone else's item seen through a shared album is the viewer's own, and only theirs. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () =>
  newMediumService(TimelineService, {
    database: db,
    real: [AssetRepository, AccessRepository, PartnerRepository, AlbumRepository, SearchRepository, TagRepository],
    mock: [LoggingRepository],
  });

const TAKEN = new Date('2024-06-10T12:00:00.000Z');
const BUCKET = '2024-06-01';

describe('personal favourites on shared items (FL-786)', () => {
  it("lists a member's own heart, never the owner's, and only while the item is shared with them", async () => {
    const { sut, ctx } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: member } = await ctx.newUser();
    const { asset: photo } = await ctx.newAsset({
      ownerId: owner.id,
      isFavorite: true,
      fileCreatedAt: TAKEN,
      localDateTime: TAKEN,
    });
    await ctx.newExif({ assetId: photo.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [photo.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id });
    const ownerAuth = factory.auth({ user: owner });
    const memberAuth = factory.auth({ user: member });
    const favourites = async (auth: typeof memberAuth) =>
      JSON.parse(await sut.getTimeBucket(auth, { userId: auth.user.id, isFavorite: true, timeBucket: BUCKET })).id ??
      [];
    const albumHearts = async (auth: typeof memberAuth) =>
      JSON.parse(await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: BUCKET })).isFavorite ?? [];

    // the owner's heart stays the owner's
    await expect(favourites(memberAuth)).resolves.toEqual([]);
    await expect(albumHearts(memberAuth)).resolves.toEqual([false]);

    await ctx.get(AssetRepository).setSharedFavorites(member.id, [photo.id], true);
    await expect(favourites(memberAuth)).resolves.toEqual([photo.id]);
    await expect(albumHearts(memberAuth)).resolves.toEqual([true]);
    // the owner's own view is unchanged, and the member's heart never shows to the owner
    await db.updateTable('asset').set({ isFavorite: false }).where('id', '=', photo.id).execute();
    await expect(favourites(ownerAuth)).resolves.toEqual([]);
    await expect(albumHearts(ownerAuth)).resolves.toEqual([false]);

    // leaving the album hides the heart; coming back shows it again
    await db.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', member.id).execute();
    await expect(favourites(memberAuth)).resolves.toEqual([]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id });
    await expect(favourites(memberAuth)).resolves.toEqual([photo.id]);

    // unhearting removes it
    await ctx.get(AssetRepository).setSharedFavorites(member.id, [photo.id], false);
    await expect(favourites(memberAuth)).resolves.toEqual([]);
  });
});
