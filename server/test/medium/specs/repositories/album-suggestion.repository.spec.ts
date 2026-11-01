import { Kysely } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { AlbumSuggestionRepository } from 'src/repositories/album-suggestion.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let sut: AlbumSuggestionRepository;
let ownerId: string;
let albumId: string;

const LAKE = { latitude: 51.4254, longitude: -116.1773 };
const modelKey = `clip:${'b'.repeat(64)}`;
const vector = (lean = 0) => JSON.stringify([1, lean, ...Array.from({ length: 766 }, () => 0)]);

const makeAsset = async (
  options: {
    day?: number;
    owner?: string;
    located?: boolean;
    name?: string;
    camera?: boolean;
    embedding?: string;
    visibility?: AssetVisibility;
  } = {},
) => {
  const asset = mediumFactory.assetInsert({
    ownerId: options.owner ?? ownerId,
    fileCreatedAt: new Date(Date.UTC(2026, 7, options.day ?? 13, 18)),
    localDateTime: new Date(Date.UTC(2026, 7, options.day ?? 13, 12)),
    originalFileName: options.name ?? 'IMG_0001.HEIC',
    visibility: options.visibility ?? AssetVisibility.Timeline,
  });
  await new AssetRepository(db).create(asset);
  await db
    .insertInto('asset_exif')
    .values({
      assetId: asset.id,
      ...(options.camera === false ? {} : { make: 'Apple', model: 'iPhone 16 Pro', timeZone: 'America/Edmonton' }),
      ...(options.located === false ? {} : { ...LAKE, city: 'Lake Louise' }),
    })
    .execute();
  if (options.embedding) {
    await db
      .insertInto('smart_search')
      .values({ assetId: asset.id, embedding: options.embedding, producerModelKey: modelKey })
      .execute();
  }
  return asset.id;
};

describe('album suggestions (FL-1092, FL-1093)', () => {
  beforeEach(async () => {
    db = await getActiveForkKyselyDB();
    const user = await mediumFactory.userWithClusterGroup(db);
    await new UserRepository(db).create(user);
    ownerId = user.id;
    const album = mediumFactory.albumInsert({});
    await db.insertInto('album').values(album).execute();
    albumId = album.id;
    sut = new AlbumSuggestionRepository(db);
  });
  afterEach(async () => {
    await db?.destroy();
  });

  const inAlbum = async (assetId: string) => db.insertInto('album_asset').values({ albumId, assetId }).execute();

  it('describes the trip and finds photos taken during it that are not in the album', async () => {
    const tripIds: string[] = [];
    for (const day of [11, 12, 13]) tripIds.push(await makeAsset({ day, embedding: vector() }));
    for (const id of tripIds) await inAlbum(id);
    const located = await makeAsset({ day: 12 });
    const unlocated = await makeAsset({ day: 12, located: false, embedding: vector(0.05) });
    const dismissed = await makeAsset({ day: 12 });
    const locked = await makeAsset({ day: 12 });
    await db.insertInto('asset_lock').values({ assetId: locked, reason: AssetLockReason.Marked }).execute();
    const archived = await makeAsset({ day: 12, visibility: AssetVisibility.Archive });
    const other = await mediumFactory.userWithClusterGroup(db);
    await new UserRepository(db).create(other);
    const someoneElses = await makeAsset({ day: 12, owner: other.id });
    await sut.dismiss(albumId, [dismissed]);

    const photos = await sut.getTripPhotos(albumId);
    expect(photos.map(({ id }) => id)).toEqual(tripIds);
    expect(photos[0]).toMatchObject({ ...LAKE, place: 'Lake Louise', make: 'Apple' });

    const window = [{ from: new Date(Date.UTC(2026, 7, 11)), to: new Date(Date.UTC(2026, 7, 14)) }];
    const candidates = await sut.getTripCandidates(ownerId, albumId, window);
    expect(candidates.map(({ id }) => id).sort()).toEqual([located, unlocated].sort());
    // Locked, archived, someone else's and dismissed photos are never suggested.
    for (const id of [locked, archived, someoneElses, dismissed])
      expect(candidates.map((row) => row.id)).not.toContain(id);
    expect(candidates.find(({ id }) => id === unlocated)).toMatchObject({
      latitude: null,
      longitude: null,
      place: null,
      hasCameraDetails: true,
    });

    const distances = await sut.getVisualDistances([unlocated], tripIds);
    expect(distances.get(unlocated)).toBeCloseTo(1 - 1 / Math.sqrt(1.0025), 4);
  });

  it('finds saved and undated photos that look like album photos', async () => {
    const tripIds: string[] = [];
    for (const day of [11, 12, 13]) tripIds.push(await makeAsset({ day, embedding: vector() }));
    for (const id of tripIds) await inAlbum(id);
    const facebook = await makeAsset({
      day: 30,
      name: 'FB_IMG_1788540812000.jpg',
      camera: false,
      located: false,
      embedding: vector(0.01),
    });
    const camera = await makeAsset({ day: 30, located: false, embedding: vector(0.01) });
    const unlike = await makeAsset({ day: 30, camera: false, located: false, embedding: vector(5) });

    const found = await sut.getUndatedNeighbours(ownerId, albumId, tripIds);
    const ids = new Set(found.map(({ assetId }) => assetId));
    expect(ids.has(facebook)).toBe(true);
    expect(ids.has(camera)).toBe(false);
    expect(ids.has(unlike)).toBe(false);
    expect(found.every(({ referenceId }) => tripIds.includes(referenceId))).toBe(true);
  });

  it('names the people in photos and remembers auto-add per person', async () => {
    const photo = await makeAsset();
    const { clusterGroupId } = await db
      .selectFrom('user')
      .select('clusterGroupId')
      .where('id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const group = await db
      .insertInto('person_group')
      .values({ clusterGroupId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('asset_face')
      .values(mediumFactory.assetFaceInsert({ assetId: photo, personGroupId: group.id }))
      .execute();
    await db
      .insertInto('person')
      .values(mediumFactory.personInsert({ ownerId, personGroupId: group.id, name: 'Emma' }))
      .execute();
    await expect(sut.getPeople(ownerId, [photo])).resolves.toEqual(
      new Map([[photo, [{ id: group.id, name: 'Emma' }]]]),
    );

    await expect(sut.isAutoAdd(albumId, ownerId)).resolves.toBe(false);
    await sut.setAutoAdd(albumId, ownerId, true);
    await sut.setAutoAdd(albumId, ownerId, true);
    await expect(sut.getAutoAddAlbumIds(ownerId)).resolves.toEqual([albumId]);
    await sut.setAutoAdd(albumId, ownerId, false);
    await expect(sut.isAutoAdd(albumId, ownerId)).resolves.toBe(false);
  });
});
