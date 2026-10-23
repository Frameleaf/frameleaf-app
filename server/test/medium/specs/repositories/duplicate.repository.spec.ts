import { Kysely, sql } from 'kysely';
import { AssetType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const vector = (axis: number) => `[${Array.from({ length: 512 }, (_, index) => (index === axis ? 1 : 0)).join(',')}]`;

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  return {
    assetRepository: new AssetRepository(database),
    database,
    sut: new DuplicateRepository(database),
    userRepository: new UserRepository(database),
  };
};

const createUser = async (userRepository: UserRepository) => {
  const user = await mediumFactory.userWithClusterGroup(defaultDatabase);
  await userRepository.create(user);
  return user;
};

const createAsset = async (assetRepository: AssetRepository, ownerId: string) => {
  const asset = mediumFactory.assetInsert({ ownerId, type: AssetType.Video });
  await assetRepository.create(asset);
  return asset;
};

describe(DuplicateRepository.name, () => {
  beforeEach(async () => {
    defaultDatabase = await getKyselyDB();
  });

  describe('look-alike estimate (FL-520)', () => {
    it('reads the nearest photo in the same library and counts what can be compared', async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const near = (axis: number, wobble: number) =>
        `[${Array.from({ length: 768 }, (_, index) => (index === axis ? 1 : index === axis + 1 ? wobble : 0)).join(',')}]`;
      const photos = [near(0, 0), near(0, 0.01), near(5, 0)];
      const ids: string[] = [];
      for (const embedding of photos) {
        const asset = mediumFactory.assetInsert({ ownerId: user.id, type: AssetType.Image });
        await assetRepository.create(asset);
        await sql`insert into "smart_search" ("assetId", "embedding") values (${asset.id}, ${embedding})`.execute(
          database,
        );
        ids.push(asset.id);
      }
      await database.updateTable('asset').set({ duplicateId: ids[0] }).where('id', 'in', ids.slice(0, 2)).execute();

      const distances = await sut.sampleNearestDistances(10);
      expect(distances).toHaveLength(3);
      expect(distances.filter((distance) => distance < 0.001)).toHaveLength(2);

      await expect(sut.countComparable()).resolves.toEqual(expect.objectContaining({ groups: 1, grouped: 2 }));
      const { comparable } = await sut.countComparable();
      expect(comparable).toBeGreaterThanOrEqual(3);
    });
  });

  describe('asset_video_duplicate_frame', () => {
    it('should have the expected table shape', async () => {
      const { rows } = await sql<{ columnName: string; dataType: string }>`
        select "column_name" as "columnName", "data_type" as "dataType"
        from information_schema.columns
        where "table_name" = 'asset_video_duplicate_frame'
      `.execute(defaultDatabase);

      expect(rows).toEqual(
        expect.arrayContaining([
          { columnName: 'assetId', dataType: 'uuid' },
          { columnName: 'frameIndex', dataType: 'integer' },
          { columnName: 'timestampMs', dataType: 'integer' },
          { columnName: 'path', dataType: 'character varying' },
          { columnName: 'embedding', dataType: 'USER-DEFINED' },
          { columnName: 'createdAt', dataType: 'timestamp with time zone' },
          { columnName: 'updatedAt', dataType: 'timestamp with time zone' },
        ]),
      );
    });

    it('should enforce uniqueness by asset and frame index', async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const asset = await createAsset(assetRepository, user.id);

      await sut.replaceVideoDuplicateFrames(asset.id, [
        { assetId: asset.id, frameIndex: 0, timestampMs: 1000, path: 'frame-0.jpeg', embedding: vector(0) },
      ]);

      const { rows } = await sql<{ assetId: string }>`
        insert into "asset_video_duplicate_frame" ("assetId", "frameIndex", "timestampMs", "path", "embedding")
        values (${asset.id}, 0, 2000, 'dupe.jpeg', ${vector(1)})
        on conflict ("assetId", "frameIndex") do nothing
        returning "assetId"
      `.execute(database);

      expect(rows).toEqual([]);
    });

    it('should cascade frame records when an asset is deleted', async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const asset = await createAsset(assetRepository, user.id);

      await sut.replaceVideoDuplicateFrames(asset.id, [
        { assetId: asset.id, frameIndex: 0, timestampMs: 1000, path: 'frame-0.jpeg', embedding: vector(0) },
      ]);
      await database.deleteFrom('asset').where('id', '=', asset.id).execute();

      await expect(sut.getVideoDuplicateFrames([asset.id])).resolves.toEqual([]);
    });
  });

  describe('replaceVideoDuplicateFrames', () => {
    it('replaces duplicate frame vectors with their exact producer identity and clears legacy provenance', async () => {
      const { assetRepository, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const asset = await createAsset(assetRepository, user.id);
      const modelKey = `clip:${'a'.repeat(64)}`;
      const frame = { assetId: asset.id, frameIndex: 0, timestampMs: 1000, path: 'fixture.jpeg' };
      const bound = { embedding: vector(0), modelKey };
      const publishing = sut.replaceVideoDuplicateFrames(asset.id, [{ ...frame, embedding: bound }]);
      bound.modelKey = `clip:${'b'.repeat(64)}`;
      bound.embedding = vector(1);
      await publishing;
      expect(await sut.getVideoDuplicateFrames([asset.id])).toEqual([
        expect.objectContaining({ embedding: vector(0), producerModelKey: modelKey }),
      ]);
      await expect(
        sut.replaceVideoDuplicateFrames(asset.id, [
          { ...frame, embedding: { embedding: vector(1), modelKey: 'unknown' } } as never,
        ]),
      ).rejects.toThrow();
      expect(await sut.getVideoDuplicateFrames([asset.id])).toEqual([
        expect.objectContaining({ embedding: vector(0), producerModelKey: modelKey }),
      ]);
      await sut.replaceVideoDuplicateFrames(asset.id, [{ ...frame, embedding: vector(1) }]);
      expect(await sut.getVideoDuplicateFrames([asset.id])).toEqual([
        expect.objectContaining({ embedding: vector(1), producerModelKey: null }),
      ]);
    });
    it('should replace rows and return stale file paths', async () => {
      const { assetRepository, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const asset = await createAsset(assetRepository, user.id);

      await sut.replaceVideoDuplicateFrames(asset.id, [
        { assetId: asset.id, frameIndex: 0, timestampMs: 1000, path: 'kept.jpeg', embedding: vector(0) },
        { assetId: asset.id, frameIndex: 1, timestampMs: 2000, path: 'stale.jpeg', embedding: vector(1) },
      ]);

      await expect(
        sut.replaceVideoDuplicateFrames(asset.id, [
          { assetId: asset.id, frameIndex: 0, timestampMs: 3000, path: 'kept.jpeg', embedding: vector(2) },
        ]),
      ).resolves.toEqual(['stale.jpeg']);

      await expect(sut.getVideoDuplicateFrames([asset.id])).resolves.toEqual([
        expect.objectContaining({ assetId: asset.id, frameIndex: 0, timestampMs: 3000, path: 'kept.jpeg' }),
      ]);
    });
  });

  describe('getVideoDuplicateFrameMatches', () => {
    it('should return candidates with enough aligned frame matches', async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const source = await createAsset(assetRepository, user.id);
      const matching = await createAsset(assetRepository, user.id);
      const partial = await createAsset(assetRepository, user.id);
      const different = await createAsset(assetRepository, user.id);

      await database
        .insertInto('asset_video_duplicate_frame')
        .values([
          { assetId: source.id, frameIndex: 0, timestampMs: 1000, path: 'source-0.jpeg', embedding: vector(0) },
          { assetId: source.id, frameIndex: 1, timestampMs: 2000, path: 'source-1.jpeg', embedding: vector(1) },
          { assetId: source.id, frameIndex: 2, timestampMs: 3000, path: 'source-2.jpeg', embedding: vector(2) },
          { assetId: matching.id, frameIndex: 0, timestampMs: 1000, path: 'matching-0.jpeg', embedding: vector(0) },
          { assetId: matching.id, frameIndex: 1, timestampMs: 2000, path: 'matching-1.jpeg', embedding: vector(1) },
          { assetId: matching.id, frameIndex: 2, timestampMs: 3000, path: 'matching-2.jpeg', embedding: vector(2) },
          { assetId: partial.id, frameIndex: 0, timestampMs: 1000, path: 'partial-0.jpeg', embedding: vector(0) },
          { assetId: partial.id, frameIndex: 1, timestampMs: 2000, path: 'partial-1.jpeg', embedding: vector(3) },
          { assetId: partial.id, frameIndex: 2, timestampMs: 3000, path: 'partial-2.jpeg', embedding: vector(4) },
          { assetId: different.id, frameIndex: 0, timestampMs: 1000, path: 'different-0.jpeg', embedding: vector(5) },
          { assetId: different.id, frameIndex: 1, timestampMs: 2000, path: 'different-1.jpeg', embedding: vector(6) },
          { assetId: different.id, frameIndex: 2, timestampMs: 3000, path: 'different-2.jpeg', embedding: vector(7) },
        ])
        .execute();

      await expect(
        sut.getVideoDuplicateFrameMatches({
          assetId: source.id,
          candidateAssetIds: [matching.id, partial.id, different.id],
          maxDistance: 0.01,
          minMatchingFrames: 2,
        }),
      ).resolves.toEqual([matching.id]);
    });
  });
});
