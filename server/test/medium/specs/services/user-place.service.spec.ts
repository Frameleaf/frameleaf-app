import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import type { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { SharedLinkType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { UserPlaceService } from 'src/services/user-place.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-949: named places and the name on a photo's info line, on a real database. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const setup = () => {
  const { sut, ctx } = newMediumService(UserPlaceService, {
    database: db,
    real: [MapRepository, ConfigRepository, SystemMetadataRepository],
    mock: [LoggingRepository],
  });
  const { sut: assets } = newMediumService(AssetService, {
    database: db,
    real: [
      AssetRepository,
      DuplicateRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      PartnerRepository,
      PersonRepository,
      SharedLinkAssetRepository,
      SharedLinkRepository,
      StackRepository,
      UserRepository,
      MapRepository,
      MediaOperationRepository,
      PhysicalFileRepository,
      ConfigRepository,
      SearchRepository,
      SystemMetadataRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository, WebsocketRepository],
  });
  return { sut, assets, ctx };
};

// about 111 m a thousandth of a degree of latitude
const HOME = { name: 'Home', latitude: 51.05, longitude: -114.07, radiusMeters: 200 };
const GARDEN = { name: 'Garden', latitude: 51.051, longitude: -114.07, radiusMeters: 60 };

describe(UserPlaceService.name, () => {
  it('creates, renames, resizes and removes a place, for its owner alone', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const auth = factory.auth({ user });

    const home = await sut.create(auth, HOME);
    expect(home).toMatchObject(HOME);
    await sut.create(auth, GARDEN);
    expect((await sut.getAll(auth)).map(({ name }) => name)).toEqual(['Garden', 'Home']);

    const renamed = await sut.update(auth, home.id, { name: 'Our house', radiusMeters: 350 });
    expect(renamed).toMatchObject({ id: home.id, name: 'Our house', radiusMeters: 350, latitude: HOME.latitude });
    expect(new Date(renamed.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(home.updatedAt).getTime());

    for (const other of [partner, admin]) {
      const otherAuth = factory.auth({ user: other });
      await expect(sut.getAll(otherAuth)).resolves.toEqual([]);
      await expect(sut.update(otherAuth, home.id, { name: 'Theirs' })).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.delete(otherAuth, home.id)).rejects.toBeInstanceOf(NotFoundException);
    }

    await sut.delete(auth, home.id);
    expect((await sut.getAll(auth)).map(({ name }) => name)).toEqual(['Garden']);
    await expect(sut.delete(auth, home.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses a name once per person, whatever its capitals', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const auth = factory.auth({ user });

    const home = await sut.create(auth, HOME);
    await expect(sut.create(auth, { ...GARDEN, name: 'HOME' })).rejects.toThrow(
      'You already have a place with this name',
    );
    const garden = await sut.create(auth, GARDEN);
    await expect(sut.update(auth, garden.id, { name: 'home' })).rejects.toBeInstanceOf(BadRequestException);
    // its own name in other capitals is a rename, and someone else's Home is theirs
    await expect(sut.update(auth, home.id, { name: 'HOME' })).resolves.toMatchObject({ name: 'HOME' });
    await expect(sut.create(factory.auth({ user: other }), HOME)).resolves.toMatchObject({ name: 'Home' });
  });

  it('keeps at most 200 places, and refuses a radius the database would', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    await db
      .insertInto('user_place')
      .values(Array.from({ length: 200 }, (_, index) => ({ ...HOME, ownerId: user.id, name: `Place ${index}` })))
      .execute();

    await expect(sut.create(auth, GARDEN)).rejects.toThrow('You can keep up to 200 places');
    const [first] = await sut.getAll(auth);
    await sut.delete(auth, first.id);
    await expect(sut.create(auth, GARDEN)).resolves.toMatchObject({ name: 'Garden' });
    await expect(
      db
        .insertInto('user_place')
        .values({ ...HOME, ownerId: user.id, name: 'Too wide', radiusMeters: 5001 })
        .execute(),
    ).rejects.toThrow(/user_place_radiusMeters_check/);
  });

  it('removes an account’s places with the account', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    await sut.create(factory.auth({ user }), HOME);
    await db.deleteFrom('user').where('id', '=', user.id).execute();
    await expect(db.selectFrom('user_place').select('id').where('ownerId', '=', user.id).execute()).resolves.toEqual(
      [],
    );
  });

  describe('the name on a photo', () => {
    it('shows the viewer their own place, the nearest centre where places overlap', async () => {
      const { sut, assets, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const home = await sut.create(auth, HOME);
      const garden = await sut.create(auth, GARDEN);
      const at = async (latitude: number | null, longitude: number | null) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, latitude, longitude });
        return asset.id;
      };
      const inGarden = await at(51.0508, -114.07);
      const inHouse = await at(51.0502, -114.0701);
      const downtown = await at(51.0443, -114.0631);
      const nowhere = await at(null, null);

      await expect(assets.get(auth, inGarden)).resolves.toMatchObject({
        namedPlace: { id: garden.id, name: 'Garden' },
      });
      await expect(assets.get(auth, inHouse)).resolves.toMatchObject({ namedPlace: { id: home.id, name: 'Home' } });
      expect(((await assets.get(auth, downtown)) as AssetResponseDto).namedPlace).toBeNull();
      expect(((await assets.get(auth, nowhere)) as AssetResponseDto).namedPlace).toBeUndefined();

      // a change shows at once: no cache stands between a place and the info line
      await sut.update(auth, garden.id, { name: 'Veg patch' });
      await expect(assets.get(auth, inGarden)).resolves.toMatchObject({ namedPlace: { name: 'Veg patch' } });
      await sut.delete(auth, garden.id);
      await expect(assets.get(auth, inGarden)).resolves.toMatchObject({ namedPlace: { name: 'Home' } });
      await sut.delete(auth, home.id);
      const after = (await assets.get(auth, inGarden)) as AssetResponseDto;
      expect(after.namedPlace).toBeNull();
      // the photo keeps where it was taken
      expect(after.exifInfo).toMatchObject({ latitude: 51.0508, longitude: -114.07 });
    });

    it('shows a partner their own name for the spot, never the owner’s, and a shared link neither name', async () => {
      const { sut, assets, ctx } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
      const ownerAuth = factory.auth({ user: owner });
      const partnerAuth = factory.auth({ user: partner });
      await sut.create(ownerAuth, HOME);
      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      await ctx.newExif({ assetId: asset.id, latitude: HOME.latitude, longitude: HOME.longitude });
      // what a partner holds of a shared photo is their own copy of it (FL-326), location included
      const { asset: copy } = await ctx.newAsset({ ownerId: partner.id });
      await ctx.newExif({ assetId: copy.id, latitude: HOME.latitude, longitude: HOME.longitude });

      await expect(assets.get(ownerAuth, asset.id)).resolves.toMatchObject({ namedPlace: { name: 'Home' } });
      // the owner's own row is never read by the partner, name or no name
      await expect(assets.get(partnerAuth, asset.id)).rejects.toThrow();

      const seenByPartner = (await assets.get(partnerAuth, copy.id)) as AssetResponseDto;
      expect(seenByPartner.exifInfo).toMatchObject({ latitude: HOME.latitude, longitude: HOME.longitude });
      expect(seenByPartner.namedPlace).toBeNull();
      // the partner's own name for the same spot is what the partner sees
      await sut.create(partnerAuth, { ...HOME, name: 'Their place' });
      await expect(assets.get(partnerAuth, copy.id)).resolves.toMatchObject({ namedPlace: { name: 'Their place' } });
      await expect(assets.get(ownerAuth, asset.id)).resolves.toMatchObject({ namedPlace: { name: 'Home' } });

      const link = await ctx.get(SharedLinkRepository).create({
        allowUpload: false,
        key: Buffer.from(factory.uuid()),
        type: SharedLinkType.Individual,
        userId: owner.id,
        assetIds: [asset.id],
      });
      const linkAuth = factory.auth({ user: owner, sharedLink: { id: link.id, showExif: true } });
      const seenByLink = await assets.get(linkAuth, asset.id);
      expect(seenByLink).not.toHaveProperty('namedPlace');
      expect(JSON.stringify(seenByLink)).not.toContain('Home');
    });
  });
});
