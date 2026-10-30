import { Kysely, sql } from 'kysely';
import { AssetType } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DuplicateRepository } from 'src/repositories/duplicate.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

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

  describe('video fingerprints (FL-651)', () => {
    const hashes = (...values: Array<bigint | null>) =>
      values.map((value) => (value === null ? null : value.toString()));

    it('stores, replaces and cascades a fingerprint, keeping full 64-bit hashes', async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const asset = await createAsset(assetRepository, user.id);

      await sut.upsertVideoFingerprint({ assetId: asset.id, durationMs: 1000, hashes: hashes(-1n, null) });
      await sut.upsertVideoFingerprint({
        assetId: asset.id,
        durationMs: 2000,
        hashes: hashes(-(2n ** 63n), 2n ** 63n - 1n, null),
      });
      await expect(sut.getVideoFingerprints([asset.id])).resolves.toEqual([
        { assetId: asset.id, durationMs: 2000, hashes: hashes(-(2n ** 63n), 2n ** 63n - 1n, null) },
      ]);

      await database.deleteFrom('asset').where('id', '=', asset.id).execute();
      await expect(sut.getVideoFingerprints([asset.id])).resolves.toEqual([]);
    });

    it("lists the other members of an asset's group", async () => {
      const { assetRepository, database, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const [a, b, c, alone] = [
        await createAsset(assetRepository, user.id),
        await createAsset(assetRepository, user.id),
        await createAsset(assetRepository, user.id),
        await createAsset(assetRepository, user.id),
      ];
      await database.updateTable('asset').set({ duplicateId: a.id }).where('id', 'in', [a.id, b.id, c.id]).execute();

      await expect(sut.getGroupMateIds(a.id).then((ids) => ids.toSorted())).resolves.toEqual([b.id, c.id].toSorted());
      await expect(sut.getGroupMateIds(alone.id)).resolves.toEqual([]);
    });

    it("finds the owner's videos with a frame within the bit distance", async () => {
      const { assetRepository, sut, userRepository } = setup();
      const user = await createUser(userRepository);
      const other = await createUser(userRepository);
      const source = await createAsset(assetRepository, user.id);
      const near = await createAsset(assetRepository, user.id);
      const far = await createAsset(assetRepository, user.id);
      const elsewhere = await createAsset(assetRepository, other.id);
      const picture = 0x0f_0f_0f_0f_0f_0f_0f_0fn;

      await sut.upsertVideoFingerprint({ assetId: source.id, durationMs: 1000, hashes: hashes(picture) });
      await sut.upsertVideoFingerprint({ assetId: near.id, durationMs: 1000, hashes: hashes(null, picture ^ 0b111n) });
      await sut.upsertVideoFingerprint({ assetId: far.id, durationMs: 1000, hashes: hashes(~picture) });
      await sut.upsertVideoFingerprint({ assetId: elsewhere.id, durationMs: 1000, hashes: hashes(picture) });

      await expect(
        sut.searchVideoFingerprints({
          assetId: source.id,
          hashes: hashes(picture) as string[],
          maxBits: 3,
          userIds: [user.id],
        }),
      ).resolves.toEqual([{ assetId: near.id, duplicateId: null, distance: 0 }]);
    });
  });
});
