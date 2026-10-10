import { Kysely } from 'kysely';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
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

const setup = (landmarks: string) => {
  const logger = { setContext: () => {}, log: () => {}, warn: () => {} };
  const config = { getEnv: () => ({ resourcePaths: { geodata: { landmarks } } }) };
  const sut = new MapRepository(config as never, undefined as never, logger as never, db as never);
  return {
    sut,
    importPack: () => (sut as unknown as { importLandmarks: () => Promise<void> }).importLandmarks(),
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

  it('skips a missing pack without failing', async () => {
    await expect(setup('/nonexistent/landmarks.ndjson.gz').importPack()).resolves.toBeUndefined();
    await expect(db.selectFrom('landmark').select('id').execute()).resolves.toHaveLength(3);
  });
});
