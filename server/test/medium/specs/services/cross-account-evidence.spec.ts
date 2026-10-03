import { Kysely } from 'kysely';
import { SearchSuggestionType } from 'src/dtos/search.dto.js';
import { AlbumUserRole, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { SearchService } from 'src/services/search.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

/**
 * FL-137 (QA-101) counts, dates and names another account sees: an album member's album list (dates
 * and last-modified), and a partner's place and camera suggestions, Explore cities and city counts,
 * never carry evidence of the owner's Locked items. (Playback through a shared link uses AssetView,
 * which the access matrix covers.)
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const albums = () => {
  const { sut, ctx } = newMediumService(AlbumService, {
    database: db,
    real: [
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      ClassificationRepository,
      MapRepository,
      PartnerRepository,
      SmartAlbumRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx };
};

const search = () =>
  newMediumService(SearchService, {
    database: db,
    real: [
      AccessRepository,
      AssetRepository,
      DatabaseRepository,
      SearchRepository,
      PartnerRepository,
      PersonRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  });

const elevated = { session: { id: factory.uuid(), hasElevatedPermission: true } };

describe('cross-account evidence of Locked items (FL-137)', () => {
  it("never dates a member's view of an album by the owner's Locked item", async () => {
    const { sut, ctx } = albums();
    const { user: owner } = await ctx.newUser();
    const { user: member } = await ctx.newUser();
    const early = '2020-01-01T00:00:00.000Z';
    const late = '2025-06-01T00:00:00.000Z';
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: early, localDateTime: early });
    const { asset: locked } = await ctx.newAsset({
      ownerId: owner.id,
      fileCreatedAt: late,
      localDateTime: late,
      visibility: AssetVisibility.Locked,
    });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [visible.id, locked.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

    for (const auth of [factory.auth({ user: member }), factory.auth({ user: member, ...elevated })]) {
      const listed = (await sut.getAll(auth, {})).find(({ id }) => id === album.id);
      expect(listed).toMatchObject({ assetCount: 1 });
      expect(listed?.startDate).toBe(new Date(early).toISOString());
      expect(listed?.endDate).toBe(new Date(early).toISOString());
      expect(JSON.stringify(listed)).not.toContain('2025-06-01');
      expect(JSON.stringify(listed)).not.toContain(locked.id);
    }
    // the owner's unlocked session does see it
    const own = (await sut.getAll(factory.auth({ user: owner, ...elevated }), {})).find(({ id }) => id === album.id);
    expect(own?.endDate).toBe(new Date(late).toISOString());
  });

  it("never suggests or counts a partner's places and cameras, Locked or not (FL-326)", async () => {
    const { sut, ctx } = search();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newExif({
      assetId: visible.id,
      city: 'Openville',
      state: 'Openstate',
      country: 'Opencountry',
      make: 'OpenMake',
    });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    await ctx.newExif({
      assetId: locked.id,
      city: 'Hiddenville',
      state: 'Hiddenstate',
      country: 'Hiddencountry',
      make: 'HiddenMake',
    });

    for (const auth of [factory.auth({ user: partner }), factory.auth({ user: partner, ...elevated })]) {
      const suggestions = await Promise.all(
        [
          SearchSuggestionType.CITY,
          SearchSuggestionType.STATE,
          SearchSuggestionType.COUNTRY,
          SearchSuggestionType.CAMERA_MAKE,
        ].map((type) => sut.getSearchSuggestions(auth, { type })),
      );
      const cities = await sut.getAssetsByCity(auth);
      const counts = await sut.getCityAssetCounts(auth);
      const body = JSON.stringify({ suggestions, cities, counts });
      // FL-326: a partner's own rows are never searched; their items arrive as the viewer's copies
      expect(body).not.toContain('Openville');
      expect(body).not.toMatch(/Hidden/);
      expect(body).not.toContain(locked.id);
    }
  });
});
