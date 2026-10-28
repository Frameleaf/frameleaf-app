import { Kysely } from 'kysely';
import {
  AlbumUserRole,
  AssetFileType,
  AssetType,
  AssetVisibility,
  ClassificationMediaType,
  LibraryScope,
  PetObservationState,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { BestPhotosRepository } from 'src/repositories/best-photos.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { searchAssetBuilder } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const setup = () => newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;

describe('library scope persistence and personal defaults', () => {
  it('keeps old uploads personal with their original identity and album membership', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    await db.insertInto('album_asset').values({ albumId: album.id, assetId: asset.id }).execute();
    const row = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirstOrThrow();
    expect(row.libraryScope).toBe(LibraryScope.Personal);
    expect(row.originalPath).toBe(asset.originalPath);
    expect(
      (await db.selectFrom('album').selectAll().where('id', '=', album.id).executeTakeFirstOrThrow()).libraryScope,
    ).toBe(LibraryScope.Personal);
    expect(await db.selectFrom('album_asset').selectAll().where('assetId', '=', asset.id).execute()).toEqual([
      expect.objectContaining({ albumId: album.id }),
    ]);
  });

  it('shows both once in each view and all authorized explicit album members', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const ids = new Map<LibraryScope, string>();
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope });
      ids.set(libraryScope, asset.id);
      await db.insertInto('album_asset').values({ albumId: album.id, assetId: asset.id }).execute();
    }
    for (const libraryScope of [LibraryScope.Personal, LibraryScope.Design] as const) {
      const rows = await searchAssetBuilder(db, { userIds: [user.id], libraryScope })
        .select('asset.id')
        .execute();
      expect(rows.map(({ id }) => id).sort()).toEqual(
        [ids.get(libraryScope)!, ids.get(LibraryScope.Both)!].sort((a, b) => a.localeCompare(b)),
      );
    }
    const rows = await searchAssetBuilder(
      db,
      { filter: { albumIds: { any: [album.id] } } },
      { userIds: [user.id], lockedOwnerId: user.id },
    )
      .select('asset.id')
      .execute();
    expect(rows).toHaveLength(3);
  });

  it('keeps personal timeline counts, ordered pages and map pins in the same universe', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const expected: string[] = [];
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        libraryScope,
        localDateTime: new Date('2026-10-01T12:00:00Z'),
      });
      await ctx.newExif({ assetId: asset.id, latitude: 45, longitude: -73 });
      if (libraryScope !== LibraryScope.Design) expected.push(asset.id);
    }
    const assets = ctx.get(AssetRepository);
    const buckets = await assets.getTimeBuckets({ userIds: [user.id] });
    expect(buckets.reduce((total, bucket) => total + bucket.count, 0)).toBe(2);
    expect((await assets.getStatistics(user.id, {})).IMAGE).toBe(2);
    const pins = await ctx.get(MapRepository).getMapMarkers(user.id, [user.id], []);
    expect(pins.map(({ id }) => id).sort()).toEqual(expected.sort());
    const design = await assets.getTimeBuckets({ userIds: [user.id], libraryScope: LibraryScope.Design });
    expect(design.reduce((total, bucket) => total + bucket.count, 0)).toBe(2);
  });

  it('withholds an existing memory after its last personal item moves to design', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { memory } = await ctx.newMemory({ ownerId: user.id });
    await ctx.newMemoryAsset({ memoryId: memory.id, assetId: asset.id });
    expect((await ctx.get(MemoryRepository).get(memory.id))?.assets).toHaveLength(1);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
    expect(await ctx.get(MemoryRepository).get(memory.id)).toBeUndefined();
  });

  it('excludes designer references from anniversary and story candidates', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const expected: string[] = [];
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        libraryScope,
        localDateTime: new Date('2025-10-01T12:00:00Z'),
      });
      await ctx.newExif({ assetId: asset.id, description: 'test image' });
      await db
        .insertInto('asset_job_status')
        .values({ assetId: asset.id })
        .onConflict((oc) => oc.column('assetId').doNothing())
        .execute();
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `${asset.id}.jpg` });
      if (libraryScope !== LibraryScope.Design) expected.push(asset.id);
    }
    const assets = ctx.get(AssetRepository);
    const anniversary = await assets.getByDayOfYear([user.id], { year: 2026, month: 10, day: 1 });
    expect(anniversary.flatMap(({ assets }) => assets.map(({ id }) => id)).sort()).toEqual(expected.sort());
    expect((await assets.getYearInReviewCandidates(user.id, 2025, 20, 20)).map(({ id }) => id).sort()).toEqual(
      expected.sort(),
    );
    expect(
      (await assets.getEventStoryCandidates(user.id, new Date('2025-10-01'), new Date('2025-10-02')))
        .map(({ id }) => id)
        .sort(),
    ).toEqual(expected.sort());
  });

  it('leaves design assets out of personal automatic rules and face reprocessing', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id });
    const rules = ctx.get(ClassificationRepository);
    expect(
      await rules.findMatches(
        {
          ownerId: user.id,
          personIds: [],
          tagIds: [],
          takenAfter: null,
          takenBefore: null,
          mediaType: ClassificationMediaType.Any,
          visualQueries: [],
          threshold: 0.5,
        },
        [],
      ),
    ).toEqual([]);
    const people = ctx.get(PersonRepository);
    expect(await people.selectionForFaces({ assetId: asset.id }).execute()).toEqual([]);
    expect(await people.getFaceForFacialRecognitionJob(face.id)).toBeUndefined();
  });

  it('revalidates Best Photos admission, publication and existing scores after a scope move', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });
    const scores = new BestPhotosRepository(db);
    const score = { assetId: asset.id, ownerId: user.id, score: 0.8, scoreVersion: 1, computedAt: new Date() };
    await scores.upsertScore(score);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
    const jobs = ctx.get(AssetJobRepository);
    expect(await jobs.getForBestPhotoScoring(asset.id)).toBeUndefined();
    expect(
      (await jobs.selectionForBestPhotosScoring({ force: true, scoreVersion: 1 }).execute()).some(
        ({ id }) => id === asset.id,
      ),
    ).toBe(false);
    expect((await scores.getBestPhotos({ ownerId: user.id, limit: 20, page: 1 })).total).toBe(0);
    await scores.upsertScore({ ...score, score: 0.9 });
    expect((await scores.getScore(asset.id))?.score).toBe(0.8);
  });

  it('excludes design-only pet recognition candidates, worker inputs and similarity neighbours', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const ids = new Map<LibraryScope, string>();
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope });
      ids.set(libraryScope, asset.id);
      await db
        .insertInto('smart_search')
        .values({ assetId: asset.id, embedding: JSON.stringify(Array.from({ length: 768 }, () => 0.125)) })
        .execute();
    }
    const pets = new PetRepository(db, ctx.getMock(LoggingRepository));
    expect(await pets.getRecognitionAsset(ids.get(LibraryScope.Design)!)).toBeUndefined();
    expect((await pets.getRecognizableAssetIds(user.id)).sort()).toEqual(
      [ids.get(LibraryScope.Personal)!, ids.get(LibraryScope.Both)!].sort((a, b) => a.localeCompare(b)),
    );
    expect(await pets.getNearestAssetIds(user.id, ids.get(LibraryScope.Personal)!, 10)).toEqual([
      ids.get(LibraryScope.Both),
    ]);
    expect(await pets.getNearestAssetIds(user.id, ids.get(LibraryScope.Design)!, 10)).toEqual([]);
  });

  it('keeps people discovery and thumbnails tied to personal media after a scope move', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Designer Person' });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    await db
      .updateTable('person')
      .set({ faceAssetId: assetFace.id })
      .where('personGroupId', '=', person.personGroupId)
      .where('ownerId', '=', user.id)
      .execute();
    const people = ctx.get(PersonRepository);
    expect((await people.getAllForUser({ take: 20 }, user.id)).items).toHaveLength(1);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
    expect((await people.getAllForUser({ take: 20 }, user.id)).items).toHaveLength(0);
    expect(await people.getByName(user.id, 'Designer Person', { withHidden: false })).toEqual([]);
    expect(
      await ctx
        .get(MemoryRepository)
        .getRecapSubjects(user.id, { from: new Date('1900-01-01'), to: new Date('2100-01-01') }, 1, 20),
    ).toEqual([]);
    expect(await people.selectionForThumbnails(true, user.id).execute()).toEqual([]);
    expect(await people.getRandomFace(person.personGroupId)).toBeUndefined();
    expect(
      await people.getDataForThumbnailGenerationJob({ ownerId: user.id, personGroupId: person.personGroupId }),
    ).toBeUndefined();
  });

  it('does not count designer references as pet photos, while preserving the owner identity', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const pets = new PetRepository(db, ctx.getMock(LoggingRepository));
    const pet = await db
      .insertInto('pet')
      .values({ ownerId: user.id, name: 'Milo' })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('pet_observation')
      .values({ petId: pet.id, assetId: asset.id, state: PetObservationState.Confirmed })
      .execute();
    expect((await pets.getAll(user.id, { withHidden: false }))[0].assetCount).toBe(1);
    await db.updateTable('asset').set({ libraryScope: LibraryScope.Design }).where('id', '=', asset.id).execute();
    expect((await pets.getAll(user.id, { withHidden: false }))[0].assetCount).toBe(0);
    expect((await pets.getById(user.id, pet.id))?.assetCount).toBe(0);
    expect(await ctx.get(SearchRepository).searchPetsByName(user.id, 'Milo')).toEqual([]);
  });

  it('charges every original to storage across both workspaces', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 100 });
    }
    await ctx.get(UserRepository).syncUsage(user.id);
    expect(
      (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', user.id).executeTakeFirstOrThrow())
        .quotaUsageInBytes,
    ).toBe(300);
    expect((await ctx.get(UserRepository).getUserStats()).find((row) => row.userId === user.id)?.usage).toBe(300);
  });

  it('keeps personal Explore covers, place counts and metadata suggestions in the same scope', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const expected: string[] = [];
    for (const libraryScope of Object.values(LibraryScope)) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope });
      const value = libraryScope === LibraryScope.Design ? 'Design' : 'Personal';
      await ctx.newExif({
        assetId: asset.id,
        city: value,
        state: value,
        country: value,
        make: value,
        model: value,
        lensModel: value,
      });
      if (libraryScope !== LibraryScope.Design) expected.push(asset.id);
    }
    const search = ctx.get(SearchRepository);
    const assets = ctx.get(AssetRepository);
    expect(await search.getCities([user.id], {})).toEqual(['Personal']);
    expect(await search.getCountries([user.id])).toEqual(['Personal']);
    expect(await search.getStates([user.id], {})).toEqual(['Personal']);
    expect(
      (await search.getCityAssetCounts([user.id])).map((row) => ({ city: row.city, count: Number(row.count) })),
    ).toEqual([{ city: 'Personal', count: 2 }]);
    expect((await search.getAssetsByCity([user.id])).every((row) => expected.includes(row.id))).toBe(true);
    expect(
      (await assets.getAssetIdByCity(user.id, { minAssetsPerField: 1, maxFields: 10 })).items.map((row) => row.value),
    ).toEqual(['Personal']);
    expect(
      (await assets.getRecentlyCreatedAssetIds(user.id, { minAssetsPerField: 1, maxFields: 10 })).items
        .map((row) => row.data)
        .sort(),
    ).toEqual(expected.sort());
  });

  it('moves a Live Photo scope atomically without changing unrelated media', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: motion } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
    });
    const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
    const { asset: unrelated } = await ctx.newAsset({ ownerId: user.id });
    const assets = ctx.get(AssetRepository);
    await assets.setLibraryScope([still.id], user.id, LibraryScope.Design);
    const rows = await assets.getByIds([still.id, motion.id, unrelated.id]);
    expect(
      rows
        .filter((row) => row.libraryScope === LibraryScope.Design)
        .map((row) => row.id)
        .sort(),
    ).toEqual([still.id, motion.id].sort());
    await expect(assets.setLibraryScope([still.id], other.id, LibraryScope.Personal)).rejects.toThrow();
    expect(
      (await assets.getByIds([still.id, motion.id])).every((row) => row.libraryScope === LibraryScope.Design),
    ).toBe(true);
    const { asset: second } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: motion.id });
    await assets.setLibraryScope([second.id], user.id, LibraryScope.Personal);
    expect((await assets.getById(motion.id))?.libraryScope).toBe(LibraryScope.Both);
  });

  it('filters owned album scopes while keeping explicit incoming shared albums discoverable', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { album: personal } = await ctx.newAlbum({ ownerId: user.id });
    const { album: design } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
    const { album: shared } = await ctx.newAlbum({ ownerId: other.id, libraryScope: LibraryScope.Design });
    await ctx.newAlbumUser({ albumId: shared.id, userId: user.id, role: AlbumUserRole.Viewer });
    const albums = ctx.get(AlbumRepository);
    expect((await albums.getAll(user.id, { libraryScope: LibraryScope.Personal })).map(({ id }) => id).sort()).toEqual(
      [personal.id, shared.id].sort(),
    );
    expect((await albums.getAll(user.id, { libraryScope: LibraryScope.Design })).map(({ id }) => id).sort()).toEqual(
      [design.id, shared.id].sort(),
    );
  });

  it('excludes design-only originals at face worker revalidation but keeps preview work', async () => {
    const ctx = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    await ctx.newExif({ assetId: asset.id, description: 'test image' });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `${asset.id}.jpg` });
    await expect(ctx.get(AssetJobRepository).getForDetectFacesJob(asset.id)).resolves.toBeUndefined();
    await expect(ctx.get(AssetJobRepository).getForGenerateThumbnailJob(asset.id)).resolves.toBeDefined();
    await ctx.get(AssetRepository).update({ id: asset.id, libraryScope: LibraryScope.Both });
    await expect(ctx.get(AssetJobRepository).getForDetectFacesJob(asset.id)).resolves.toBeDefined();
  });
});
