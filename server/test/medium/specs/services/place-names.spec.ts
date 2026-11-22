import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { SharedLinkType, SystemMetadataKey, UserMetadataKey } from 'src/enum.js';
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
import { MapService } from 'src/services/map.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { SearchService } from 'src/services/search.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const fixtures = join(process.cwd(), 'test', 'fixtures', 'place-names');
const linesOf = (file: string) =>
  createInterface({ input: createReadStream(join(fixtures, file)), crlfDelay: Infinity });
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

const MUNICH = 2_867_714;
const BAVARIA = 2_951_839;
const TOKYO = 1_850_147;

/** The fixture places as the geodata import would have stored them. */
const places = [
  {
    id: MUNICH,
    name: 'Munich',
    latitude: 48.137_43,
    longitude: 11.575_49,
    countryCode: 'DE',
    admin1Code: '02',
    admin2Code: '091',
    admin1Name: 'Bavaria',
    admin2Name: 'Upper Bavaria',
    alternateNames: 'Muenchen,München',
    modificationDate: '2026-01-01',
  },
  {
    id: TOKYO,
    name: 'Tokyo',
    latitude: 35.6895,
    longitude: 139.691_71,
    countryCode: 'JP',
    admin1Code: '40',
    admin2Code: null,
    admin1Name: 'Tokyo',
    admin2Name: null,
    alternateNames: 'Tokio',
    modificationDate: '2026-01-01',
  },
];

describe('place names in the viewer’s language (FL-987)', () => {
  let db: Kysely<DB>;
  let server: Server;
  let url: string;
  /** The pack built from the fixture files by the real builder, gzipped as it is published. */
  let pack: Buffer;
  let served: Buffer | undefined;
  let requests = 0;

  beforeAll(async () => {
    // a variable path keeps the plain script out of type-checking
    const builderPath = join(process.cwd(), 'bin', 'build-place-names-pack.mjs');
    const builder = (await import(pathToFileURL(builderPath).href)) as {
      placesOf(lines: AsyncIterable<string>, kind: string): Promise<Map<number, string>>;
      selectNames(lines: AsyncIterable<string>, places: Map<number, string>): Promise<string[]>;
    };
    const shipped = new Map<number, string>();
    for (const [file, kind] of [
      ['cities500.txt', 'cities'],
      ['admin1CodesASCII.txt', 'admin'],
      ['admin2Codes.txt', 'admin'],
      ['countryInfo.txt', 'countries'],
    ]) {
      for (const [id, name] of await builder.placesOf(linesOf(file), kind)) {
        shipped.set(id, name);
      }
    }
    pack = gzipSync((await builder.selectNames(linesOf('alternateNamesV2.txt'), shipped)).join('\n') + '\n');

    server = createServer((_, response) => {
      requests++;
      if (served) {
        response.writeHead(200).end(served);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/place-names.tsv.gz`;
  });
  afterAll(() => server.close());

  beforeEach(async () => {
    db = await getKyselyDB();
    await db.insertInto('geodata_places').values(places).execute();
    served = pack;
    requests = 0;
  });

  /** The repository reads the region and country ids from the fixture files instead of /build/geodata. */
  const withFixtureGeodata = (ctx: MediumTestContext<any>) => {
    const map = ctx.get(MapRepository);
    const config = map['configRepository'];
    const env = config.getEnv();
    vi.spyOn(config, 'getEnv').mockReturnValue({
      ...env,
      resourcePaths: {
        ...env.resourcePaths,
        geodata: {
          ...env.resourcePaths.geodata,
          admin1: join(fixtures, 'admin1CodesASCII.txt'),
          countries: join(fixtures, 'countryInfo.txt'),
        },
      },
    });
    return map;
  };

  const metadataService = () => {
    const { sut, ctx } = newMediumService(MetadataService, {
      database: db,
      real: [AssetRepository, ConfigRepository, MapRepository, SystemMetadataRepository, UserRepository],
      mock: [EventRepository, JobRepository, LoggingRepository, StorageRepository],
    });
    return { sut, ctx, map: withFixtureGeodata(ctx) };
  };

  const assetService = () => {
    const { sut, ctx } = newMediumService(AssetService, {
      database: db,
      real: [
        AssetRepository,
        DuplicateRepository,
        AssetEditRepository,
        AssetJobRepository,
        AlbumRepository,
        AccessRepository,
        PersonRepository,
        SharedLinkRepository,
        SharedLinkAssetRepository,
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
    withFixtureGeodata(ctx);
    return { sut, ctx };
  };

  /** A person whose account language is `locale` (none: English), as Your preferences saves it. */
  const newViewer = async (ctx: MediumTestContext<any>, locale?: string) => {
    const { user } = await ctx.newUser();
    if (locale) {
      await ctx.get(UserRepository).upsertMetadata(user.id, {
        key: UserMetadataKey.Preferences,
        value: { notifications: { locale } },
      });
    }
    return user;
  };

  const newPhoto = async (
    ctx: MediumTestContext<any>,
    ownerId: string,
    exif: { latitude: number; longitude: number; city?: string; state?: string; country?: string },
  ) => {
    const { asset } = await ctx.newAsset({ ownerId });
    await ctx.newExif({ assetId: asset.id, ...exif });
    return asset;
  };
  const inMunich = { latitude: 48.14, longitude: 11.58, city: 'Munich', state: 'Bavaria', country: 'Germany' };
  const inTokyo = { latitude: 35.68, longitude: 139.7, city: 'Tokyo', state: 'Tokyo', country: 'Japan' };

  const linkOf = (assetId: string) =>
    db.selectFrom('asset_geoname').selectAll().where('assetId', '=', assetId).executeTakeFirst();

  describe('the pack', () => {
    it('is fetched once, checked, and loaded whole', async () => {
      const { map } = metadataService();

      await expect(map.installPlaceNames({ url, sha256: sha256(pack) })).resolves.toBe(true);

      await expect(map.getPlaceNames('de', [MUNICH, BAVARIA, TOKYO, 1])).resolves.toEqual(
        expect.arrayContaining([
          { geonameId: MUNICH, name: 'München' },
          { geonameId: BAVARIA, name: 'Bayern' },
          { geonameId: TOKYO, name: 'Tokio' },
        ]),
      );
      await expect(new SystemMetadataRepository(db).get(SystemMetadataKey.PlaceNamesState)).resolves.toEqual({
        sha256: sha256(pack),
      });

      // the same pack again asks nothing of the network
      await expect(map.installPlaceNames({ url, sha256: sha256(pack) })).resolves.toBe(false);
      expect(requests).toBe(1);
    });

    it('comes back when a restored database has the state without the names', async () => {
      const { map } = metadataService();
      await map.installPlaceNames({ url, sha256: sha256(pack) });
      await db.deleteFrom('geodata_place_name').execute();

      await expect(map.installPlaceNames({ url, sha256: sha256(pack) })).resolves.toBe(true);
      await expect(map.getPlaceNames('de', [MUNICH])).resolves.toEqual([{ geonameId: MUNICH, name: 'München' }]);
    });

    it('keeps the names it has when a download fails, is not the pinned file, or is malformed', async () => {
      const { map } = metadataService();
      await map.installPlaceNames({ url, sha256: sha256(pack) });

      await expect(map.installPlaceNames({ url, sha256: 'f'.repeat(64) })).rejects.toThrow('checksum');
      served = gzipSync(`${MUNICH}\tde\tMünchen\n${MUNICH}\txx\tnot a language\n`);
      await expect(map.installPlaceNames({ url, sha256: sha256(served) })).rejects.toThrow('malformed');
      served = undefined;
      await expect(map.installPlaceNames({ url, sha256: 'e'.repeat(64) })).rejects.toThrow('404');
      await expect(map.installPlaceNames({ url, sha256: 'not a checksum' })).rejects.toThrow('malformed');

      await expect(map.getPlaceNames('de', [MUNICH, BAVARIA])).resolves.toHaveLength(2);
      await expect(new SystemMetadataRepository(db).get(SystemMetadataKey.PlaceNamesState)).resolves.toEqual({
        sha256: sha256(pack),
      });
    });
  });

  describe('the backfill', () => {
    it('links located items to the places their stored names came from, and changes nothing in asset_exif', async () => {
      const { sut, ctx } = metadataService();
      const user = await newViewer(ctx);
      const munich = await newPhoto(ctx, user.id, inMunich);
      const tokyo = await newPhoto(ctx, user.id, inTokyo);
      // typed by its owner: near Munich, but not a name Munich gave it
      const renamed = await newPhoto(ctx, user.id, { ...inMunich, city: 'Grandma’s house' });
      // far from any city: the country alone is known
      const atSea = await newPhoto(ctx, user.id, { latitude: 72, longitude: -40, country: 'Greenland' });
      const { asset: unlocated } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: unlocated.id, city: 'Munich' });
      const before = await db.selectFrom('asset_exif').select(['assetId', 'city', 'state', 'country']).execute();

      await expect(sut.handlePlaceNameBackfill()).resolves.toBe('success');

      await expect(linkOf(munich.id)).resolves.toEqual({
        assetId: munich.id,
        cityGeonameId: MUNICH,
        admin1GeonameId: BAVARIA,
        countryCode: 'DE',
      });
      await expect(linkOf(tokyo.id)).resolves.toMatchObject({ cityGeonameId: TOKYO, countryCode: 'JP' });
      await expect(linkOf(renamed.id)).resolves.toMatchObject({
        cityGeonameId: null,
        admin1GeonameId: null,
        countryCode: 'DE',
      });
      await expect(linkOf(atSea.id)).resolves.toMatchObject({ cityGeonameId: null, countryCode: 'GL' });
      await expect(linkOf(unlocated.id)).resolves.toBeUndefined();
      await expect(
        db.selectFrom('asset_exif').select(['assetId', 'city', 'state', 'country']).execute(),
      ).resolves.toEqual(before);
    });

    it('reads each item once and carries on where it stopped', async () => {
      const { sut, ctx, map } = metadataService();
      const user = await newViewer(ctx);
      const photos = [];
      for (let index = 0; index < 5; index++) {
        photos.push(await newPhoto(ctx, user.id, index % 2 ? inTokyo : inMunich));
      }
      const ids = photos.map(({ id }) => id).toSorted();

      // a run that was stopped after two slices of two
      const first = await map.linkAssetGeonames({ limit: 2 });
      expect(first).toEqual({ count: 2, last: ids[1] });
      await expect(map.linkAssetGeonames({ after: first.last, limit: 2 })).resolves.toEqual({ count: 2, last: ids[3] });

      // the next run starts from the top and finds only the item that is left
      const read = vi.spyOn(map, 'linkAssetGeonames');
      await sut.handlePlaceNameBackfill();
      expect(read).toHaveBeenCalledTimes(1);
      await expect(read.mock.results[0].value).resolves.toEqual({ count: 1, last: ids[4] });
      await expect(db.selectFrom('asset_geoname').select('assetId').orderBy('assetId').execute()).resolves.toEqual(
        ids.map((assetId) => ({ assetId })),
      );

      // and a run after that has nothing to read, new items aside
      await expect(map.linkAssetGeonames({ limit: 2 })).resolves.toEqual({ count: 0 });
      const later = await newPhoto(ctx, user.id, inTokyo);
      await expect(map.linkAssetGeonames({ limit: 2 })).resolves.toEqual({ count: 1, last: later.id });
    });

    it('never overwrites the link metadata extraction wrote, which follows the item’s place', async () => {
      const { ctx, map } = metadataService();
      const user = await newViewer(ctx);
      const photo = await newPhoto(ctx, user.id, inMunich);

      await map.linkAssetGeonames({ assetId: photo.id });
      await expect(linkOf(photo.id)).resolves.toMatchObject({ cityGeonameId: MUNICH });

      // the place changes: the one-item call replaces the row, a slice leaves it alone
      await ctx.newExif({ assetId: photo.id, ...inTokyo });
      await map.linkAssetGeonames({ limit: 10 });
      await expect(linkOf(photo.id)).resolves.toMatchObject({ cityGeonameId: MUNICH });
      await map.linkAssetGeonames({ assetId: photo.id });
      await expect(linkOf(photo.id)).resolves.toMatchObject({ cityGeonameId: TOKYO, countryCode: 'JP' });

      // the location is removed: so is the row
      await db
        .updateTable('asset_exif')
        .set({ latitude: null, longitude: null, city: null, state: null, country: null })
        .where('assetId', '=', photo.id)
        .execute();
      await map.linkAssetGeonames({ assetId: photo.id });
      await expect(linkOf(photo.id)).resolves.toBeUndefined();
    });

    it('does nothing while reverse geocoding is switched off', async () => {
      const { sut, ctx } = metadataService();
      const user = await newViewer(ctx);
      const photo = await newPhoto(ctx, user.id, inMunich);
      const config = await sut.getConfig({ withCache: false });
      vi.spyOn(sut, 'getConfig').mockResolvedValue({ ...config, reverseGeocoding: { enabled: false } });

      await expect(sut.handlePlaceNameBackfill()).resolves.toBe('skipped');
      await expect(linkOf(photo.id)).resolves.toBeUndefined();
    });
  });

  describe('responses', () => {
    const seed = async (ctx: MediumTestContext<any>, { install = true } = {}) => {
      const map = ctx.get(MapRepository);
      if (install) {
        await map.installPlaceNames({ url, sha256: sha256(pack) });
      }
      const owner = await newViewer(ctx, 'de');
      const munich = await newPhoto(ctx, owner.id, inMunich);
      const tokyo = await newPhoto(ctx, owner.id, inTokyo);
      await map.linkAssetGeonames({ limit: 100 });
      return { map, owner, munich, tokyo };
    };
    const setLanguage = (ctx: MediumTestContext<any>, userId: string, locale: string) =>
      ctx
        .get(UserRepository)
        .upsertMetadata(userId, { key: UserMetadataKey.Preferences, value: { notifications: { locale } } });

    it('shows a German-language person "München" for a Munich photo, beside the unchanged English names', async () => {
      const { sut, ctx } = assetService();
      const { owner, munich } = await seed(ctx);

      const { exifInfo } = await sut.get(factory.auth({ user: owner }), munich.id);

      expect(exifInfo).toMatchObject({
        city: 'Munich',
        state: 'Bavaria',
        country: 'Germany',
        placeNamesLocalized: { city: 'München', state: 'Bayern', country: 'Deutschland', lang: 'de' },
      });
    });

    it('leaves an English-language person’s response as it was', async () => {
      const { sut, ctx } = assetService();
      const { owner, munich } = await seed(ctx);
      await setLanguage(ctx, owner.id, 'en');

      const { exifInfo } = await sut.get(factory.auth({ user: owner }), munich.id);

      expect(exifInfo).toMatchObject({
        city: 'Munich',
        state: 'Bavaria',
        country: 'Germany',
        placeNamesLocalized: null,
      });
    });

    it('falls back to the stored English name where the pack has no translation', async () => {
      const { sut, ctx } = assetService();
      const { owner, munich, tokyo } = await seed(ctx);

      // German has "Tokio" but no other name for the region or for Japan
      await expect(sut.get(factory.auth({ user: owner }), tokyo.id)).resolves.toMatchObject({
        exifInfo: {
          city: 'Tokyo',
          placeNamesLocalized: { city: 'Tokio', state: 'Tokyo', country: 'Japan', lang: 'de' },
        },
      });

      // Norwegian (saved as nb-NO) has a city and a country name for Munich, none for Bavaria
      await setLanguage(ctx, owner.id, 'nb-NO');
      await expect(sut.get(factory.auth({ user: owner }), munich.id)).resolves.toMatchObject({
        exifInfo: { placeNamesLocalized: { city: 'München', state: 'Bavaria', country: 'Tyskland', lang: 'nb' } },
      });

      // Polish has nothing for Tokyo at all, and Japanese is not a language the pack carries
      for (const locale of ['pl', 'ja']) {
        await setLanguage(ctx, owner.id, locale);
        await expect(sut.get(factory.auth({ user: owner }), tokyo.id)).resolves.toMatchObject({
          exifInfo: { city: 'Tokyo', state: 'Tokyo', country: 'Japan', placeNamesLocalized: null },
        });
      }
    });

    it('keeps English names working without the pack, and after a download that fails', async () => {
      const { sut, ctx } = assetService();
      const { map, owner, munich } = await seed(ctx, { install: false });
      const english = { city: 'Munich', state: 'Bavaria', country: 'Germany', placeNamesLocalized: null };

      await expect(sut.get(factory.auth({ user: owner }), munich.id)).resolves.toMatchObject({ exifInfo: english });

      served = undefined;
      await expect(map.installPlaceNames({ url, sha256: sha256(pack) })).rejects.toThrow('404');
      await expect(sut.get(factory.auth({ user: owner }), munich.id)).resolves.toMatchObject({ exifInfo: english });
    });

    it('does not translate a name edited since the item was linked', async () => {
      const { sut, ctx } = assetService();
      const { owner, munich } = await seed(ctx);
      await db.updateTable('asset_exif').set({ city: 'Garching' }).where('assetId', '=', munich.id).execute();

      await expect(sut.get(factory.auth({ user: owner }), munich.id)).resolves.toMatchObject({
        exifInfo: {
          city: 'Garching',
          placeNamesLocalized: { city: 'Garching', state: 'Bayern', country: 'Deutschland', lang: 'de' },
        },
      });
    });

    it('adds nothing for a shared link’s visitor', async () => {
      const { sut, ctx } = assetService();
      const { owner, munich } = await seed(ctx);
      const sharedLink = await ctx.get(SharedLinkRepository).create({
        key: Buffer.from('fl987-shared-link'),
        userId: owner.id,
        type: SharedLinkType.Individual,
        allowUpload: false,
        showExif: true,
        assetIds: [munich.id],
      });

      const { exifInfo } = await sut.get(
        factory.auth({ user: owner, sharedLink: { id: sharedLink.id, showExif: true } }),
        munich.id,
      );

      expect(exifInfo).toMatchObject({ city: 'Munich', placeNamesLocalized: null });
    });

    it('names places the same way in Places, Explore, the place search and on the map', async () => {
      const search = newMediumService(SearchService, {
        database: db,
        real: [
          AccessRepository,
          AssetRepository,
          ConfigRepository,
          MapRepository,
          SearchRepository,
          SystemMetadataRepository,
          UserRepository,
        ],
        mock: [LoggingRepository],
      });
      withFixtureGeodata(search.ctx);
      const { owner, munich, tokyo } = await seed(search.ctx);
      const auth = factory.auth({ user: owner });

      const cities = await search.sut.getAssetsByCity(auth);
      expect(Object.fromEntries(cities.map(({ exifInfo }) => [exifInfo!.city, exifInfo!.placeNamesLocalized]))).toEqual(
        {
          Munich: { city: 'München', state: 'Bayern', country: 'Deutschland', lang: 'de' },
          Tokyo: { city: 'Tokio', state: 'Tokyo', country: 'Japan', lang: 'de' },
        },
      );

      const found = await search.sut.searchPlaces(auth, { name: 'Munich' });
      expect(found[0]).toMatchObject({
        name: 'Munich',
        admin1name: 'Bavaria',
        placeNamesLocalized: { city: 'München', state: 'Bayern', country: 'Deutschland', lang: 'de' },
      });

      const map = newMediumService(MapService, {
        database: db,
        real: [AlbumRepository, AssetRepository, MapRepository, UserRepository],
        mock: [LoggingRepository],
      });
      withFixtureGeodata(map.ctx);
      const markers = await map.sut.getMapMarkers(auth, {});
      expect(Object.fromEntries(markers.map((marker) => [marker.id, marker]))).toMatchObject({
        [munich.id]: {
          city: 'Munich',
          state: 'Bavaria',
          country: 'Germany',
          placeNamesLocalized: { city: 'München', state: 'Bayern', country: 'Deutschland', lang: 'de' },
        },
        [tokyo.id]: {
          city: 'Tokyo',
          placeNamesLocalized: { city: 'Tokio', state: 'Tokyo', country: 'Japan', lang: 'de' },
        },
      });

      await setLanguage(search.ctx, owner.id, 'en');
      for (const marker of await map.sut.getMapMarkers(auth, {})) {
        expect(marker).not.toHaveProperty('placeNamesLocalized');
      }
      for (const place of await search.sut.searchPlaces(auth, { name: 'Munich' })) {
        expect(place).not.toHaveProperty('placeNamesLocalized');
      }
    });
  });
});
