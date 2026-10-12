import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

// A square park (about 640 m by 890 m) and a tower matched by radius alone.
const park = {
  id: 'Q181185',
  name: 'Disneyland Park',
  names: { ja: 'ディズニーランド' },
  kind: 'theme_park',
  lat: 33.8125,
  lon: -117.9198,
  radiusM: 700,
  rank: 78,
  areas: [
    [
      [-117.9246, 33.8091],
      [-117.9246, 33.816],
      [-117.915, 33.816],
      [-117.915, 33.8091],
      [-117.9246, 33.8091],
    ],
  ],
};
// The resort contains the park, so a photo in the park is at both.
const resort = { ...park, id: 'Q1516525', name: 'Disneyland Resort', radiusM: 2000, rank: 40, areas: undefined };
const tower = {
  id: 'Q243',
  name: 'Eiffel Tower',
  names: {},
  kind: 'tower',
  lat: 48.8584,
  lon: 2.2945,
  radiusM: 165,
  rank: 200,
};

const inPark = { latitude: 33.8121, longitude: -117.919 };
/** Within the park's radius, but east of its boundary. */
const besidePark = { latitude: 33.8121, longitude: -117.914 };
const atTower = { latitude: 48.859, longitude: 2.295 };
const nowhere = { latitude: 40, longitude: -100 };

let db: Kysely<DB>;

const writePack = (places: object[]) => {
  const directory = mkdtempSync(join(tmpdir(), 'landmarks-'));
  const landmarks = join(directory, 'landmarks.ndjson.gz');
  writeFileSync(landmarks, gzipSync(places.map((place) => JSON.stringify(place)).join('\n') + '\n'));
  return landmarks;
};

const setup = (landmarks: string, landmarkIcons = '/nonexistent/landmark-icons') => {
  const logger = { setContext: () => {}, log: () => {}, warn: () => {} };
  const config = { getEnv: () => ({ resourcePaths: { geodata: { landmarks, landmarkIcons } } }) };
  const sut = new MapRepository(config as never, undefined as never, logger as never, db as never);
  return {
    sut,
    importPack: () => (sut as unknown as { importLandmarks: () => Promise<boolean> }).importLandmarks(),
  };
};

const newAsset = async (location?: { latitude: number | null; longitude: number | null }) => {
  const user = await mediumFactory.userWithClusterGroup(db);
  await new UserRepository(db).create(user);
  const asset = mediumFactory.assetInsert({ ownerId: user.id });
  await new AssetRepository(db).create(asset);
  if (location) {
    await db
      .insertInto('asset_exif')
      .values({ assetId: asset.id, ...location })
      .execute();
  }
  return asset.id;
};

const move = (assetId: string, location: { latitude: number | null; longitude: number | null }) =>
  db.updateTable('asset_exif').set(location).where('assetId', '=', assetId).execute();

const landmarksOf = async (assetId: string) => {
  const rows = await db.selectFrom('asset_landmark').select('landmarkId').where('assetId', '=', assetId).execute();
  return rows.map(({ landmarkId }) => landmarkId).sort();
};

describe('landmark matching', () => {
  beforeEach(async () => {
    db = await getKyselyDB();
    await setup(writePack([park, resort, tower])).importPack();
  });

  it('imports places and their boundaries', async () => {
    const places = await db.selectFrom('landmark').select(['id', 'names']).orderBy('id').execute();
    expect(places).toEqual([
      { id: 'Q1516525', names: park.names },
      { id: 'Q181185', names: park.names },
      { id: 'Q243', names: {} },
    ]);
    await expect(db.selectFrom('landmark_area').select('landmarkId').execute()).resolves.toEqual([
      { landmarkId: 'Q181185' },
    ]);
  });

  it('matches a new asset to every place that contains it', async () => {
    await expect(landmarksOf(await newAsset(inPark))).resolves.toEqual(['Q1516525', 'Q181185']);
    await expect(landmarksOf(await newAsset(atTower))).resolves.toEqual(['Q243']);
  });

  it('does not match outside a boundary, outside a radius, or without a location', async () => {
    await expect(landmarksOf(await newAsset(besidePark))).resolves.toEqual(['Q1516525']);
    await expect(landmarksOf(await newAsset(nowhere))).resolves.toEqual([]);
    await expect(landmarksOf(await newAsset({ latitude: null, longitude: null }))).resolves.toEqual([]);
  });

  it('follows the asset when its location is set, moved or cleared', async () => {
    const assetId = await newAsset({ latitude: null, longitude: null });

    await move(assetId, inPark);
    await expect(landmarksOf(assetId)).resolves.toEqual(['Q1516525', 'Q181185']);

    await move(assetId, atTower);
    await expect(landmarksOf(assetId)).resolves.toEqual(['Q243']);

    await move(assetId, { latitude: null, longitude: null });
    await expect(landmarksOf(assetId)).resolves.toEqual([]);
  });

  it('removes the matches with the asset', async () => {
    const assetId = await newAsset(inPark);
    await db.deleteFrom('asset').where('id', '=', assetId).execute();
    await expect(landmarksOf(assetId)).resolves.toEqual([]);
  });

  it('keeps matches across a pack import and repairs them on a full re-match', async () => {
    const assetId = await newAsset(inPark);
    const towerAssetId = await newAsset(atTower);

    // The next pack drops the tower and widens nothing else.
    const { sut, importPack } = setup(writePack([park, resort]));
    await importPack();
    await expect(landmarksOf(assetId)).resolves.toEqual(['Q1516525', 'Q181185']);
    await expect(landmarksOf(towerAssetId)).resolves.toEqual(['Q243']);

    await sut.matchAllLandmarks();
    await expect(landmarksOf(assetId)).resolves.toEqual(['Q1516525', 'Q181185']);
    await expect(landmarksOf(towerAssetId)).resolves.toEqual([]);

    // Assets that predate a place are picked up, and a second run changes nothing.
    await setup(writePack([park, resort, tower])).importPack();
    await sut.matchAllLandmarks();
    await sut.matchAllLandmarks();
    await expect(landmarksOf(towerAssetId)).resolves.toEqual(['Q243']);
  });

  it('puts the places back after a restore, which brings the tables without their rows', async () => {
    const assetId = await newAsset(inPark);
    const landmarks = writePack([park, resort, tower]);
    const dateFile = join(mkdtempSync(join(tmpdir(), 'geodata-date-')), 'geodata-date.txt');
    writeFileSync(dateFile, '2026-10-01');
    const logger = { setContext: () => {}, log: () => {}, warn: () => {} };
    // The geodata of this date is already in, as it is in a database that has just been restored.
    const metadata = { get: () => Promise.resolve({ lastUpdate: '2026-10-01' }) };
    const withPack = (pack: string) =>
      new MapRepository(
        { getEnv: () => ({ resourcePaths: { geodata: { dateFile, landmarks: pack } } }) } as never,
        metadata as never,
        logger as never,
        db as never,
      );

    await expect(withPack(landmarks).init()).resolves.toBe(false);

    await db.deleteFrom('landmark_area').execute();
    await db.deleteFrom('landmark').execute();
    await expect(withPack('/nonexistent/landmarks.ndjson.gz').init()).resolves.toBe(false);
    await expect(withPack(landmarks).init()).resolves.toBe(true);

    await expect(db.selectFrom('landmark').select('id').orderBy('id').execute()).resolves.toEqual([
      { id: 'Q1516525' },
      { id: 'Q181185' },
      { id: 'Q243' },
    ]);
    await expect(db.selectFrom('landmark_area').select('landmarkId').execute()).resolves.toEqual([
      { landmarkId: 'Q181185' },
    ]);
    // The item's own matches came back with the backup and are still its matches.
    await expect(landmarksOf(assetId)).resolves.toEqual(['Q1516525', 'Q181185']);
  });

  it('knows which landmarks have a brand icon, and none without the icon pack', () => {
    const directory = mkdtempSync(join(tmpdir(), 'landmark-icons-'));
    writeFileSync(join(directory, 'icons.json'), JSON.stringify({ Q243: { background: '#102030', tile: true } }));

    const { sut } = setup('/nonexistent/landmarks.ndjson.gz', directory);
    expect(sut.getLandmarkIcons().get('Q243')).toEqual({ background: '#102030', tile: true });
    expect(sut.getLandmarkIconPath('Q243')).toBe(join(directory, 'Q243.png'));
    expect(sut.getLandmarkIconPath('Q181185')).toBeUndefined();

    const { sut: bare } = setup('/nonexistent/landmarks.ndjson.gz');
    expect(bare.getLandmarkIcons().size).toBe(0);
    expect(bare.getLandmarkIconPath('Q243')).toBeUndefined();
  });

  // FL-355: the pack a server downloads for itself, whole and checked, into a hidden folder beside the thumbnails
  describe('the downloaded icon pack', () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const line = (id: string) =>
      JSON.stringify({ id, background: '#102030', tile: id === 'Q243', png: png.toString('base64') });
    const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
    const good = gzipSync([line('Q243'), line('Q181185')].join('\n') + '\n');
    let served = good;
    let requests = 0;
    let server: Server;
    let url: string;
    let media: string;

    beforeAll(async () => {
      server = createServer((request, response) => {
        requests++;
        response.end(served);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/landmark-icons.ndjson.gz`;
    });
    afterAll(() => server.close());
    beforeEach(() => {
      media = mkdtempSync(join(tmpdir(), 'landmark-media-'));
      StorageCore.setMediaLocation(media);
      served = good;
      requests = 0;
    });
    afterEach(() => StorageCore.reset());

    it('is fetched once, unpacked, and read in place of a bundled pack', async () => {
      const { sut } = setup('/nonexistent/landmarks.ndjson.gz');
      const folder = join(media, 'thumbs', '.landmark-icons', sha256(good));

      await expect(sut.installLandmarkIcons({ url, sha256: sha256(good) })).resolves.toBe(true);

      expect(sut.getLandmarkIcons()).toEqual(
        new Map([
          ['Q243', { background: '#102030', tile: true }],
          ['Q181185', { background: '#102030', tile: false }],
        ]),
      );
      expect(sut.getLandmarkIconPath('Q243')).toBe(join(folder, 'Q243.png'));
      expect(readFileSync(join(folder, 'Q181185.png'))).toEqual(png);
      expect(readdirSync(join(media, 'thumbs'))).toEqual(['.landmark-icons']);

      // the same pack again asks nothing of the network
      await expect(sut.installLandmarkIcons({ url, sha256: sha256(good) })).resolves.toBe(false);
      expect(requests).toBe(1);
    });

    it('keeps what it has when the file is not the one that was pinned, or names a file it should not', async () => {
      const { sut } = setup('/nonexistent/landmarks.ndjson.gz');
      await sut.installLandmarkIcons({ url, sha256: sha256(good) });

      await expect(sut.installLandmarkIcons({ url, sha256: 'f'.repeat(64) })).rejects.toThrow('checksum');
      served = gzipSync(line('../../escape') + '\n');
      await expect(sut.installLandmarkIcons({ url, sha256: sha256(served) })).rejects.toThrow('malformed');

      expect(sut.getLandmarkIcons().size).toBe(2);
      expect(readdirSync(join(media, 'thumbs'))).toEqual(['.landmark-icons']);
      expect(existsSync(join(media, 'escape.png'))).toBe(false);
    });
  });

  it('lists the landmarks of story candidates, and the ones an owner is at often (FL-356)', async () => {
    const user = await mediumFactory.userWithClusterGroup(db);
    await new UserRepository(db).create(user);
    const assets = new AssetRepository(db);
    const visits = [
      { day: '2026-06-01', location: inPark },
      { day: '2026-06-02', location: inPark },
      { day: '2026-06-03', location: atTower },
    ];
    for (const { day, location } of visits) {
      const asset = mediumFactory.assetInsert({ ownerId: user.id, localDateTime: new Date(`${day}T10:00:00.000Z`) });
      await assets.create(asset);
      await db
        .insertInto('asset_job_status')
        .values(mediumFactory.assetJobStatusInsert({ assetId: asset.id }))
        .execute();
      await db
        .insertInto('asset_file')
        .values({ assetId: asset.id, type: AssetFileType.Preview, path: `/preview/${asset.id}`, physicalFileId: null })
        .execute();
      await db
        .insertInto('asset_exif')
        .values({ assetId: asset.id, ...location })
        .execute();
    }
    const [from, to] = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-12-31T00:00:00.000Z')];

    const candidates = await assets.getEventStoryCandidates(user.id, from, to);
    expect(candidates.map(({ landmarks }) => landmarks.map(({ id }) => id).sort())).toEqual([
      ['Q1516525', 'Q181185'],
      ['Q1516525', 'Q181185'],
      ['Q243'],
    ]);
    expect(candidates[2].landmarks).toEqual([
      { id: 'Q243', name: 'Eiffel Tower', kind: 'tower', rank: 200, radiusM: 165 },
    ]);

    const often = await assets.getFrequentLandmarkIds(user.id, from, to, 1);
    expect(often.sort()).toEqual(['Q1516525', 'Q181185']);
    await expect(assets.getFrequentLandmarkIds(user.id, from, to, 2)).resolves.toEqual([]);
  });

  it('skips a missing pack without failing', async () => {
    await expect(setup('/nonexistent/landmarks.ndjson.gz').importPack()).resolves.toBe(false);
    await expect(db.selectFrom('landmark').select('id').execute()).resolves.toHaveLength(3);
  });
});
