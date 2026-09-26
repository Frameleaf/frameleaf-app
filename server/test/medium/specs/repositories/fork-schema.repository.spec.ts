import { Kysely, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { ChecksumAlgorithm } from 'src/enum.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(ForkSchemaRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(ForkSchemaRepository.name, () => {
  describe('hasAssetChecksum', () => {
    it('matches either recorded digest for only the owning user', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sha1 = randomBytes(20);
      const sha256 = randomBytes(32);
      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: 10,
        path: asset.originalPath,
        source: 'upload',
      });

      await expect(sut.hasAssetChecksum(user.id, sha1, randomBytes(32))).resolves.toBe(true);
      await expect(sut.hasAssetChecksum(user.id, randomBytes(20), sha256)).resolves.toBe(true);
      await expect(sut.hasAssetChecksum(other.id, sha1, sha256)).resolves.toBe(false);
    });
  });

  describe('getChecksumTranslations', () => {
    it('should return nothing for an empty digest list', async () => {
      const { sut } = setup();

      await expect(sut.getChecksumTranslations(randomBytes(16).toString('hex'), [])).resolves.toEqual([]);
    });

    it('should run against the database for digests with no match', async () => {
      // Guards the bytea[] binding: this query is mocked in the service specs,
      // so a malformed array parameter would only ever surface in e2e.
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      await expect(
        sut.getChecksumTranslations(user.id, [createHash('sha1').update('nothing').digest()]),
      ).resolves.toEqual([]);
    });

    it('should translate a recorded sha1 onto the stored sha256', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const contents = randomBytes(32);
      const sha1 = createHash('sha1').update(contents).digest();
      const sha256 = createHash('sha256').update(contents).digest();
      const { asset } = await ctx.newAsset({ ownerId: user.id, checksum: sha256 });

      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: contents.length,
        path: asset.originalPath,
        source: 'upload',
      });

      await expect(sut.getChecksumTranslations(user.id, [sha1])).resolves.toEqual([{ sha1, checksum: sha256 }]);
    });

    it('should not translate for a different owner', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const contents = randomBytes(32);
      const sha1 = createHash('sha1').update(contents).digest();
      const sha256 = createHash('sha256').update(contents).digest();
      const { asset } = await ctx.newAsset({ ownerId: user.id, checksum: sha256 });

      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: contents.length,
        path: asset.originalPath,
        source: 'upload',
      });

      await expect(sut.getChecksumTranslations(other.id, [sha1])).resolves.toEqual([]);
    });
  });

  describe('recordAssetChecksums', () => {
    it('should not overwrite an existing row', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sha1 = createHash('sha1').update('first').digest();
      const sha256 = createHash('sha256').update('first').digest();

      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: 5,
        path: asset.originalPath,
        source: 'upload',
      });
      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1: createHash('sha1').update('second').digest(),
        sha256: createHash('sha256').update('second').digest(),
        sizeInBytes: 6,
        path: asset.originalPath,
        source: 'integrity',
      });

      const row = await sql<{ sha1: Buffer; evidence: string }>`
        SELECT sha1, evidence::text FROM immich_fork.asset_checksum WHERE "assetId" = ${asset.id}::uuid
      `.execute(defaultDatabase);

      expect(row.rows[0]?.sha1).toEqual(sha1);
      expect(JSON.parse(row.rows[0]!.evidence)).toEqual({ source: 'upload' });
    });

    it('recovery replaces ambiguous historical digests with verified bytes', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const recoveredSha1 = createHash('sha1').update('recovered').digest();
      const recoveredSha256 = createHash('sha256').update('recovered').digest();

      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1: randomBytes(20),
        sha256: randomBytes(32),
        sizeInBytes: 1,
        path: '/old/path.jpg',
        source: 'upload',
      });
      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1: recoveredSha1,
        sha256: recoveredSha256,
        sizeInBytes: 9,
        path: '/recovered/path.jpg',
        source: 'recovery',
      });

      const row = await sql<{ sha1: Buffer; sha256: Buffer; evidence: string }>`
        SELECT sha1, sha256, evidence::text
        FROM immich_fork.asset_checksum
        WHERE "assetId" = ${asset.id}::uuid
      `.execute(defaultDatabase);

      expect(row.rows[0]).toMatchObject({ sha1: recoveredSha1, sha256: recoveredSha256 });
      expect(JSON.parse(row.rows[0]!.evidence)).toEqual({ source: 'recovery' });
    });
  });

  describe('recordExternalScanChecksums (FL-69)', () => {
    const external = async (ctx: ReturnType<typeof setup>['ctx']) => {
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        originalPath: '/external/photos/lake.png',
        isExternal: true,
      });
      return { user, asset };
    };
    const read = async (assetId: string) => {
      const row = await sql<{ sha1: Buffer; sizeInBytes: number; evidence: string; updatedAt: Date }>`
        SELECT sha1, "sizeInBytes"::int AS "sizeInBytes", evidence::text, "updatedAt"
        FROM immich_fork.asset_checksum WHERE "assetId" = ${assetId}::uuid
      `.execute(defaultDatabase);
      return row.rows[0];
    };

    it('records and refreshes the digests of a path-checksum original at its own path', async () => {
      const { ctx, sut } = setup();
      const { asset } = await external(ctx);
      const first = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: 5 };
      await sut.recordExternalScanChecksums({ assetId: asset.id, ...first, path: asset.originalPath });
      const recorded = await read(asset.id);
      expect(recorded).toMatchObject({ sha1: first.sha1, sizeInBytes: 5 });
      expect(JSON.parse(recorded!.evidence)).toEqual({ source: 'external-scan' });

      // the same bytes again rewrite nothing
      await sut.recordExternalScanChecksums({ assetId: asset.id, ...first, path: asset.originalPath });
      expect((await read(asset.id))?.updatedAt).toEqual(recorded?.updatedAt);

      // an original edited in place replaces them
      const edited = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: 6 };
      await sut.recordExternalScanChecksums({ assetId: asset.id, ...edited, path: asset.originalPath });
      expect(await read(asset.id)).toMatchObject({ sha1: edited.sha1, sizeInBytes: 6 });
    });

    it('records nothing once the asset has moved or has a file checksum', async () => {
      const { ctx, sut } = setup();
      const { asset } = await external(ctx);
      const digests = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: 5 };

      await sut.recordExternalScanChecksums({ assetId: asset.id, ...digests, path: '/external/photos/old.png' });
      expect(await read(asset.id)).toBeUndefined();

      const { user } = await ctx.newUser();
      const { asset: managed } = await ctx.newAsset({ ownerId: user.id });
      await sut.recordExternalScanChecksums({ assetId: managed.id, ...digests, path: managed.originalPath });
      expect(await read(managed.id)).toBeUndefined();
    });

    it('never answers a duplicate check or a sha1 translation', async () => {
      const { ctx, sut } = setup();
      const { user, asset } = await external(ctx);
      const sha1 = randomBytes(20);
      const sha256 = randomBytes(32);
      await sut.recordExternalScanChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: 5,
        path: asset.originalPath,
      });

      await expect(sut.hasAssetChecksum(user.id, sha1, sha256)).resolves.toBe(false);
      await expect(sut.getChecksumTranslations(user.id, [sha1])).resolves.toEqual([]);
    });
  });
});
