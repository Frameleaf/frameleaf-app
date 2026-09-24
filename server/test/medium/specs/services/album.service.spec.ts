import { BadRequestException, ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AlbumKind, AlbumUserRole, AssetMetadataKey, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const services = newMediumService(AlbumService, {
    database: db || defaultDatabase,
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
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return services;
};

const nsfwMetadata = (isNsfw: boolean, review?: { action: string; isNsfw: boolean }) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
    ...(review && { review }),
  },
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumService.name, () => {
  describe('getAll', () => {
    it('should not reveal album membership for hidden NSFW asset lookups', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const albumRepository = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();

      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });

      const { album: unreviewedAlbum } = await ctx.newAlbum({ ownerId: user.id }, [unreviewedNsfw.id]);
      const { album: markedSafeAlbum } = await ctx.newAlbum({ ownerId: user.id }, [markedSafe.id]);
      const { album: markedNsfwAlbum } = await ctx.newAlbum({ ownerId: user.id }, [markedNsfw.id]);
      const { album: tagOnlyAlbum } = await ctx.newAlbum({ ownerId: user.id }, [tagOnly.id]);

      await ctx.newMetadata({
        assetId: unreviewedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });
      await ctx.newMetadata({
        assetId: markedSafe.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true, { action: 'marked-safe', isNsfw: false }),
      });
      await ctx.newMetadata({
        assetId: markedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(false, { action: 'marked-nsfw', isNsfw: true }),
      });

      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenAuth = { ...factory.auth({ user: { id: user.id } }), hideNsfwAssets: true };
      await expect(sut.getAll(hiddenAuth, { assetId: unreviewedNsfw.id })).resolves.toEqual([]);
      await expect(sut.getAll(hiddenAuth, { assetId: markedNsfw.id })).resolves.toEqual([]);
      await expect(sut.getAll(hiddenAuth, { assetId: markedSafe.id })).resolves.toEqual([
        expect.objectContaining({ id: markedSafeAlbum.id, assetCount: 1 }),
      ]);
      await expect(sut.getAll(hiddenAuth, { assetId: tagOnly.id })).resolves.toEqual([
        expect.objectContaining({ id: tagOnlyAlbum.id, assetCount: 1 }),
      ]);

      await expect(
        sut.getAll(factory.auth({ user: { id: user.id } }), { assetId: unreviewedNsfw.id }),
      ).resolves.toEqual([expect.objectContaining({ id: unreviewedAlbum.id, assetCount: 1 })]);

      await expect(albumRepository.getAssetIds(markedNsfwAlbum.id, [markedNsfw.id])).resolves.toEqual(
        new Set([markedNsfw.id]),
      );
    });

    it('should compute suppressed-only album metadata and thumbnails from configured tags, people, and NSFW assets', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: visible } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-01-01T00:00:00.000Z'),
      });
      const { asset: faceSuppressed } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-02-01T00:00:00.000Z'),
      });
      const { asset: tagSuppressed } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-03-01T00:00:00.000Z'),
      });
      const { asset: nsfwSuppressed } = await ctx.newAsset({
        ownerId: user.id,
        fileCreatedAt: new Date('2024-04-01T00:00:00.000Z'),
      });
      const { asset: otherVisible } = await ctx.newAsset({ ownerId: user.id });

      const { album: mixedAlbum } = await ctx.newAlbum({ ownerId: user.id, albumThumbnailAssetId: visible.id }, [
        visible.id,
        faceSuppressed.id,
        tagSuppressed.id,
        nsfwSuppressed.id,
      ]);
      const { album: visibleOnlyAlbum } = await ctx.newAlbum(
        { ownerId: user.id, albumThumbnailAssetId: otherVisible.id },
        [otherVisible.id],
      );

      const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['medical'] });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagSuppressed.id] });

      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Private Person' });
      await ctx.newAssetFace({ assetId: faceSuppressed.id, personGroupId: person.personGroupId });

      await ctx.newMetadata({
        assetId: nsfwSuppressed.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });

      const suppressedContent: HiddenContentFilter = {
        userId: user.id,
        includeNsfw: true,
        tagIds: [tag.id],
        personIds: [person.personGroupId],
        petIds: [],
        scope: 'owned',
      };
      const hiddenAuth = {
        ...factory.auth({ user: { id: user.id } }),
        hideNsfwAssets: true,
        hiddenContent: suppressedContent,
      };
      const elevatedAuth = {
        ...factory.auth({ user: { id: user.id } }),
        session: { id: factory.uuid(), hasElevatedPermission: true },
        suppressedContent,
      };

      const hiddenAlbums = await sut.getAll(hiddenAuth, {});
      expect(hiddenAlbums).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: mixedAlbum.id, assetCount: 1, albumThumbnailAssetId: visible.id }),
          expect.objectContaining({ id: visibleOnlyAlbum.id, assetCount: 1, albumThumbnailAssetId: otherVisible.id }),
        ]),
      );

      const suppressedAlbums = await sut.getAll(elevatedAuth, { suppressedOnly: true });
      expect(suppressedAlbums).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: mixedAlbum.id,
            assetCount: 3,
            albumThumbnailAssetId: nsfwSuppressed.id,
          }),
          expect.objectContaining({
            id: visibleOnlyAlbum.id,
            assetCount: 0,
            albumThumbnailAssetId: null,
          }),
        ]),
      );

      await expect(sut.get(elevatedAuth, mixedAlbum.id, { suppressedOnly: true })).resolves.toEqual(
        expect.objectContaining({
          id: mixedAlbum.id,
          assetCount: 3,
          albumThumbnailAssetId: nsfwSuppressed.id,
        }),
      );
    });
  });

  describe('getMapMarkers', () => {
    it('filters album map markers using private NSFW metadata only', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedSafe } = await ctx.newAsset({ ownerId: user.id });
      const { asset: markedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [
        visible.id,
        unreviewedNsfw.id,
        markedSafe.id,
        markedNsfw.id,
        tagOnly.id,
      ]);

      for (const [index, asset] of [visible, unreviewedNsfw, markedSafe, markedNsfw, tagOnly].entries()) {
        await ctx.newExif({
          assetId: asset.id,
          latitude: 42 + index / 100,
          longitude: 69 + index / 100,
          city: `city-${index}`,
          state: 'state',
          country: 'country',
        });
      }

      await Promise.all([
        ctx.newMetadata({
          assetId: unreviewedNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true),
        }),
        ctx.newMetadata({
          assetId: markedSafe.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(true, { action: 'marked-safe', isNsfw: false }),
        }),
        ctx.newMetadata({
          assetId: markedNsfw.id,
          key: AssetMetadataKey.MlEnrichment,
          value: nsfwMetadata(false, { action: 'marked-nsfw', isNsfw: true }),
        }),
      ]);

      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenAuth = { ...factory.auth({ user: { id: user.id } }), hideNsfwAssets: true };
      const hiddenMarkers = await sut.getMapMarkers(hiddenAuth, album.id);
      expect(hiddenMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([visible.id, markedSafe.id, tagOnly.id]),
      );
      expect(hiddenMarkers.map(({ id }) => id)).not.toEqual(expect.arrayContaining([unreviewedNsfw.id, markedNsfw.id]));

      const elevatedMarkers = await sut.getMapMarkers(factory.auth({ user: { id: user.id } }), album.id);
      expect(elevatedMarkers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([visible.id, unreviewedNsfw.id, markedSafe.id, markedNsfw.id, tagOnly.id]),
      );
    });

    it('narrows an album map by the settings sheet without reaching past the album (FL-51)', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();

      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id, fileCreatedAt: '2026-03-01T00:00:00.000Z' });
      const { asset: archived } = await ctx.newAsset({
        ownerId: owner.id,
        visibility: AssetVisibility.Archive,
        fileCreatedAt: '2026-03-02T00:00:00.000Z',
      });
      const { asset: ownerFavorite } = await ctx.newAsset({
        ownerId: owner.id,
        isFavorite: true,
        fileCreatedAt: '2025-06-01T00:00:00.000Z',
      });
      const { asset: memberFavorite } = await ctx.newAsset({
        ownerId: member.id,
        isFavorite: true,
        fileCreatedAt: '2026-03-03T00:00:00.000Z',
      });
      const { asset: outside } = await ctx.newAsset({ ownerId: owner.id, isFavorite: true });
      for (const [index, asset] of [plain, archived, ownerFavorite, memberFavorite, outside].entries()) {
        await ctx.newExif({ assetId: asset.id, latitude: 10 + index, longitude: 10 + index });
      }
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [
        plain.id,
        archived.id,
        ownerFavorite.id,
        memberFavorite.id,
      ]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });

      const ids = (markers: { id: string }[]) => markers.map(({ id }) => id).sort();
      const ownerAuth = factory.auth({ user: { id: owner.id } });
      const memberAuth = factory.auth({ user: { id: member.id } });

      // no filters: the album as before, archived items included, nothing from outside it
      await expect(sut.getMapMarkers(ownerAuth, album.id).then(ids)).resolves.toEqual(
        [plain.id, archived.id, ownerFavorite.id, memberFavorite.id].sort(),
      );
      await expect(sut.getMapMarkers(ownerAuth, album.id, { isArchived: false }).then(ids)).resolves.toEqual(
        [plain.id, ownerFavorite.id, memberFavorite.id].sort(),
      );
      // favorites are each viewer's own, and never the favorite outside the album
      await expect(sut.getMapMarkers(ownerAuth, album.id, { isFavorite: true }).then(ids)).resolves.toEqual([
        ownerFavorite.id,
      ]);
      await expect(sut.getMapMarkers(memberAuth, album.id, { isFavorite: true }).then(ids)).resolves.toEqual([
        memberFavorite.id,
      ]);
      await expect(
        sut
          .getMapMarkers(ownerAuth, album.id, {
            fileCreatedAfter: new Date('2026-01-01T00:00:00.000Z'),
            fileCreatedBefore: new Date('2026-12-31T00:00:00.000Z'),
          })
          .then(ids),
      ).resolves.toEqual([plain.id, archived.id, memberFavorite.id].sort());
    });

    it("keeps only the viewer's own album items when Partner items is off, as the prototype does (FL-51)", async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: viewer } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      await ctx.newPartner({ sharedById: partner.id, sharedWithId: viewer.id });

      const { asset: own } = await ctx.newAsset({ ownerId: viewer.id });
      const { asset: partnerItem } = await ctx.newAsset({ ownerId: partner.id });
      const { asset: memberItem } = await ctx.newAsset({ ownerId: member.id });
      const { asset: partnerOutside } = await ctx.newAsset({ ownerId: partner.id });
      for (const [index, asset] of [own, partnerItem, memberItem, partnerOutside].entries()) {
        await ctx.newExif({ assetId: asset.id, latitude: 20 + index, longitude: 20 + index });
      }
      const { album } = await ctx.newAlbum({ ownerId: viewer.id }, [own.id, partnerItem.id, memberItem.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: partner.id, role: AlbumUserRole.Editor });
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });

      const ids = (markers: { id: string }[]) => markers.map(({ id }) => id).sort();
      const auth = factory.auth({ user: { id: viewer.id } });

      await expect(
        sut.getMapMarkers(auth, album.id, { withPartners: true, withSharedAlbums: true }).then(ids),
      ).resolves.toEqual([own.id, partnerItem.id, memberItem.id].sort());
      // the prototype treats every item someone else owns as a partner item, partner or not
      await expect(sut.getMapMarkers(auth, album.id, { withPartners: false }).then(ids)).resolves.toEqual([own.id]);
      // "Shared spaces" only hides the viewer's own shared-space-only items, which album markers never are
      await expect(sut.getMapMarkers(auth, album.id, { withSharedAlbums: false }).then(ids)).resolves.toEqual(
        [own.id, partnerItem.id, memberItem.id].sort(),
      );
      // neither switch reaches the partner's item outside the album
      await expect(
        sut.getMapMarkers(auth, album.id, { withPartners: false, withSharedAlbums: false }).then(ids),
      ).resolves.toEqual([own.id]);
    });
  });

  describe('removeAssets', () => {
    it('does not remove hidden NSFW assets from album membership in hidden mode', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const albumRepository = ctx.get(AlbumRepository);
      const { user } = await ctx.newUser();

      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: unreviewedNsfw } = await ctx.newAsset({ ownerId: user.id });
      const { asset: tagOnly } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [visible.id, unreviewedNsfw.id, tagOnly.id]);

      await ctx.newMetadata({
        assetId: unreviewedNsfw.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });
      const [visibleNsfwTag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['nsfw'] });
      await ctx.newTagAsset({ tagIds: [visibleNsfwTag.id], assetIds: [tagOnly.id] });

      const hiddenAuth = { ...factory.auth({ user: { id: user.id } }), hideNsfwAssets: true };
      await expect(
        sut.removeAssets(hiddenAuth, album.id, { ids: [visible.id, unreviewedNsfw.id, tagOnly.id] }),
      ).resolves.toEqual([
        { id: visible.id, success: true },
        { id: unreviewedNsfw.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
        { id: tagOnly.id, success: true },
      ]);

      await expect(albumRepository.getAssetIds(album.id, [visible.id, unreviewedNsfw.id, tagOnly.id])).resolves.toEqual(
        new Set([unreviewedNsfw.id]),
      );
    });

    it('should not remove assets from an album of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(sut.removeAssets(factory.auth({ user: otherUser }), album.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('custom order (FL-52)', () => {
    it("keeps each person's own order of the same albums, and changes nothing else", async () => {
      const { sut, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { album: first } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'First' });
      const { album: second } = await ctx.newAlbum({ ownerId: owner.id, albumName: 'Second' });
      await ctx.newAlbumUser({ albumId: first.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      await ctx.newAlbumUser({ albumId: second.id, userId: viewer.id, role: AlbumUserRole.Viewer });
      const ownerAuth = factory.auth({ user: { id: owner.id } });
      const viewerAuth = factory.auth({ user: { id: viewer.id } });

      await sut.setOrder(ownerAuth, { parentId: null, albumIds: [second.id, first.id] });
      await sut.setOrder(viewerAuth, { parentId: null, albumIds: [first.id, second.id] });

      const ids = async (auth: typeof ownerAuth) => (await sut.getTree(auth)).albums.map(({ id }) => id);
      await expect(ids(ownerAuth)).resolves.toEqual([second.id, first.id]);
      await expect(ids(viewerAuth)).resolves.toEqual([first.id, second.id]);
      // A viewer arranging their directory never gains rights or changes the owner's albums.
      const [album] = await ctx.get(AlbumRepository).getAll(owner.id, { id: first.id });
      expect(album.albumUsers?.find(({ user }) => user.id === viewer.id)?.role).toBe(AlbumUserRole.Viewer);
    });

    it('arranges the albums inside a collection and refuses an order from a stale tree', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album: collection } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
      const { album: a } = await ctx.newAlbum({ ownerId: user.id, parentId: collection.id });
      const { album: b } = await ctx.newAlbum({ ownerId: user.id, parentId: collection.id });

      await sut.setOrder(auth, { parentId: collection.id, albumIds: [b.id, a.id] });
      const tree = await sut.getTree(auth);
      expect(tree.collections[0].albums.map(({ id }) => id)).toEqual([b.id, a.id]);

      // Somebody (another tab) takes `a` out of the collection; the first tab still shows it inside.
      await sut.moveToCollection(auth, a.id, { collectionId: null });
      await expect(sut.setOrder(auth, { parentId: collection.id, albumIds: [a.id, b.id] })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('refuses a move of a node that was moved since the client loaded it', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });
      const { album: family } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
      const { album: trips } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      // Tab one moves the album into Family.
      await sut.moveToCollection(auth, album.id, { collectionId: family.id, expectedParentId: null });
      // Tab two, still showing it on its own, tries to move it into Trips.
      await expect(
        sut.moveToCollection(auth, album.id, { collectionId: trips.id, expectedParentId: null }),
      ).rejects.toBeInstanceOf(ConflictException);

      const moved = await sut.get(auth, album.id);
      expect(moved.parentId).toBe(family.id);
    });
  });

  describe('database triggers', () => {
    it('should cascade delete an album when the owner is deleted', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await ctx.get(UserRepository).delete({ id: user.id }, true);

      await expect(ctx.database.selectFrom('album').selectAll().where('id', '=', album.id).execute()).resolves.toEqual(
        [],
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  describe('Locked media in albums (FL-32)', () => {
    const elevated = (userId: string) =>
      factory.auth({ user: { id: userId }, session: { id: factory.uuid(), hasElevatedPermission: true } });
    const ordinary = (userId: string) => factory.auth({ user: { id: userId } });

    it('lets only an elevated owner add Locked media, then shows it only to that owner while unlocked', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [plain.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });

      await expect(sut.addAssets(ordinary(owner.id), album.id, { ids: [locked.id] })).resolves.toEqual([
        { id: locked.id, success: false, error: BulkIdErrorReason.NO_PERMISSION },
      ]);
      await expect(sut.addAssets(elevated(owner.id), album.id, { ids: [locked.id] })).resolves.toEqual([
        { id: locked.id, success: true },
      ]);

      await expect(sut.get(elevated(owner.id), album.id)).resolves.toEqual(
        expect.objectContaining({ assetCount: 2, albumThumbnailAssetId: plain.id }),
      );
      await expect(sut.get(ordinary(owner.id), album.id)).resolves.toEqual(
        expect.objectContaining({ assetCount: 1, albumThumbnailAssetId: plain.id }),
      );
      // another member never sees it, whatever their own session
      await expect(sut.get(elevated(member.id), album.id)).resolves.toEqual(
        expect.objectContaining({ assetCount: 1, albumThumbnailAssetId: plain.id }),
      );

      // album membership grants no access to the Locked item either
      const access = ctx.get(AccessRepository);
      await expect(access.asset.checkAlbumAccess(member.id, new Set([plain.id, locked.id]))).resolves.toEqual(
        new Set([plain.id]),
      );
    });

    it('never uses Locked media as the album cover and repairs a Locked cover on read', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: owner } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [locked.id]);

      await expect(sut.get(elevated(owner.id), album.id)).resolves.toEqual(
        expect.objectContaining({ assetCount: 1, albumThumbnailAssetId: null }),
      );

      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      await sut.addAssets(elevated(owner.id), album.id, { ids: [plain.id] });
      await expect(sut.get(ordinary(owner.id), album.id)).resolves.toEqual(
        expect.objectContaining({ assetCount: 1, albumThumbnailAssetId: plain.id }),
      );

      await expect(
        sut.update(elevated(owner.id), album.id, { albumThumbnailAssetId: locked.id }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await ctx.database
        .updateTable('album')
        .set({ albumThumbnailAssetId: locked.id })
        .where('id', '=', album.id)
        .execute();
      await expect(sut.get(ordinary(owner.id), album.id)).resolves.toEqual(
        expect.objectContaining({ albumThumbnailAssetId: plain.id }),
      );
    });

    it('shows Locked map markers only to the elevated owner', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      await ctx.newExif({ assetId: plain.id, latitude: 1, longitude: 1 });
      await ctx.newExif({ assetId: locked.id, latitude: 2, longitude: 2 });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [plain.id, locked.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

      const ids = (markers: { id: string }[]) => markers.map(({ id }) => id).sort();
      await expect(sut.getMapMarkers(elevated(owner.id), album.id).then(ids)).resolves.toEqual(
        [plain.id, locked.id].sort(),
      );
      await expect(sut.getMapMarkers(ordinary(owner.id), album.id).then(ids)).resolves.toEqual([plain.id]);
      await expect(sut.getMapMarkers(elevated(member.id), album.id).then(ids)).resolves.toEqual([plain.id]);
    });

    it('counts hidden items for their contributor and Locked items only for the elevated owner', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user: owner } = await ctx.newUser();
      const { user: member } = await ctx.newUser();
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: hidden } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
      const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      const { asset: memberAsset } = await ctx.newAsset({ ownerId: member.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [plain.id, hidden.id, locked.id, memberAsset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Editor });

      const counts = (response: { contributorCounts?: { userId: string; assetCount: number }[] }) =>
        Object.fromEntries(
          (response.contributorCounts ?? []).map(({ userId, assetCount }) => [userId, Number(assetCount)]),
        );

      await expect(sut.get(elevated(owner.id), album.id).then(counts)).resolves.toEqual({
        [owner.id]: 3,
        [member.id]: 1,
      });
      await expect(sut.get(ordinary(owner.id), album.id).then(counts)).resolves.toEqual({
        [owner.id]: 2,
        [member.id]: 1,
      });
      // another member never counts the owner's Locked item, whatever their own session
      await expect(sut.get(elevated(member.id), album.id).then(counts)).resolves.toEqual({
        [owner.id]: 2,
        [member.id]: 1,
      });
    });
  });
});
