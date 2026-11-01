import { Kysely, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { type OwnerBackupState, ownerBackupHistoryPage } from 'src/utils/cloud-backup-owner.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetChecksumRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetChecksumRepository.name, () => {
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
        SELECT sha1, evidence::text FROM public.asset_checksum WHERE "assetId" = ${asset.id}::uuid
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
        FROM public.asset_checksum
        WHERE "assetId" = ${asset.id}::uuid
      `.execute(defaultDatabase);

      expect(row.rows[0]).toMatchObject({ sha1: recoveredSha1, sha256: recoveredSha256 });
      expect(JSON.parse(row.rows[0]!.evidence)).toEqual({ source: 'recovery' });
    });
  });

  describe('promoteToSha256', () => {
    const digests = (text: string) => ({
      sha1: createHash('sha1').update(text).digest(),
      sha256: createHash('sha256').update(text).digest(),
    });
    const legacy = (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, checksum: Buffer) =>
      ctx.newAsset({ ownerId, checksum, checksumAlgorithm: ChecksumAlgorithm.sha1File });
    const read = async (assetId: string) => {
      const row = await sql<{ checksum: Buffer; checksumAlgorithm: string; updateId: string }>`
        SELECT checksum, "checksumAlgorithm"::text AS "checksumAlgorithm", "updateId"
        FROM public.asset WHERE id = ${assetId}::uuid
      `.execute(defaultDatabase);
      return row.rows[0];
    };

    it('moves a legacy upload to its sha256 with a new updateId, once', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { sha1, sha256 } = digests('legacy');
      const { asset } = await legacy(ctx, user.id, sha1);
      const before = await read(asset.id);

      await expect(sut.promoteToSha256({ assetId: asset.id, sha1, sha256 })).resolves.toBe(true);

      const after = await read(asset.id);
      expect(after).toMatchObject({ checksum: sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File });
      expect(after?.updateId).not.toEqual(before?.updateId);
      await expect(sut.promoteToSha256({ assetId: asset.id, sha1, sha256 })).resolves.toBe(false);
    });

    it('leaves an asset that no longer holds that sha1', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { sha1, sha256 } = digests('replaced');
      const other = randomBytes(20);
      const { asset } = await legacy(ctx, user.id, other);

      await expect(sut.promoteToSha256({ assetId: asset.id, sha1, sha256 })).resolves.toBe(false);
      expect(await read(asset.id)).toMatchObject({ checksum: other, checksumAlgorithm: ChecksumAlgorithm.sha1File });
    });

    it('never touches a path checksum or an external original', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { sha1, sha256 } = digests('external');
      const { asset: path } = await ctx.newAsset({
        ownerId: user.id,
        checksum: sha1,
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        originalPath: '/external/photos/lake.png',
        isExternal: true,
      });
      const { asset: external } = await ctx.newAsset({
        ownerId: user.id,
        checksum: digests('external file').sha1,
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        originalPath: '/external/photos/pier.png',
        isExternal: true,
      });

      await expect(sut.promoteToSha256({ assetId: path.id, sha1, sha256 })).resolves.toBe(false);
      await expect(sut.promoteToSha256({ assetId: external.id, ...digests('external file') })).resolves.toBe(false);
      expect(await read(path.id)).toMatchObject({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1Path });
      expect(await read(external.id)).toMatchObject({ checksumAlgorithm: ChecksumAlgorithm.sha1File });
    });

    it('keeps the sha1 when another upload of the owner holds that sha256, and does not throw', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { sha1, sha256 } = digests('duplicate');
      const { asset } = await legacy(ctx, user.id, sha1);
      await ctx.newAsset({ ownerId: user.id, checksum: sha256, checksumAlgorithm: ChecksumAlgorithm.sha256File });

      await expect(sut.promoteToSha256({ assetId: asset.id, sha1, sha256 })).resolves.toBe(false);
      expect(await read(asset.id)).toMatchObject({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1File });

      // the same content in someone else's library is no conflict
      const { asset: theirs } = await legacy(ctx, other.id, sha1);
      await expect(sut.promoteToSha256({ assetId: theirs.id, sha1, sha256 })).resolves.toBe(true);
    });

    it('lets a promoted upload deleted later come back from a plain Cloud Backup (FL-738)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const promoted = digests('promoted');
      const unpromoted = digests('unpromoted');
      const { asset: checked } = await legacy(ctx, user.id, promoted.sha1);
      const { asset: unchecked } = await legacy(ctx, user.id, unpromoted.sha1);
      await expect(sut.promoteToSha256({ assetId: checked.id, ...promoted })).resolves.toBe(true);
      await sql`DELETE FROM public.asset WHERE id IN (${checked.id}::uuid, ${unchecked.id}::uuid)`.execute(
        defaultDatabase,
      );

      const captured = await sql<NonNullable<OwnerBackupState['deletion']> & { assetId: string }>`
        SELECT * FROM public.asset_backup_deletion WHERE "assetId" IN (${checked.id}::uuid, ${unchecked.id}::uuid)
      `.execute(defaultDatabase);
      const states = new Map(captured.rows.map(({ assetId, ...deletion }) => [assetId, { deletion }]));
      // a plain backup records only the original's file SHA-256
      const record = (sha256: Buffer) => ({
        owner: user.id,
        details: { visibility: 'timeline' },
        originalFileName: 'lake.jpg',
        files: [{ role: 'original', sha256: sha256.toString('hex'), size: 4 }],
      });
      const manifest = {
        version: 2,
        createdAt: '2026-11-01T00:00:00Z',
        assets: { [checked.id]: record(promoted.sha256), [unchecked.id]: record(unpromoted.sha256) },
      } as unknown as CloudBackupManifest;
      const auth = { ...authStub.user1, user: { ...authStub.user1.user, id: user.id } };

      // deleted before the nightly check reached it, a legacy upload is captured with its SHA-1 and stays unlisted
      expect(
        ownerBackupHistoryPage(auth, manifest, states, { offset: 0, limit: 10 }).items.map((item) => item.assetId),
      ).toEqual([checked.id]);
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
        FROM public.asset_checksum WHERE "assetId" = ${assetId}::uuid
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

    it('leaves an upload row alone and refreshes a relink recovery row', async () => {
      const { ctx, sut } = setup();
      const uploaded = await external(ctx);
      const relinked = await external(ctx);
      const seeded = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: 5 };
      await sut.recordAssetChecksums({
        assetId: uploaded.asset.id,
        ...seeded,
        path: uploaded.asset.originalPath,
        source: 'upload',
      });
      await sut.recordAssetChecksums({
        assetId: relinked.asset.id,
        ...seeded,
        path: relinked.asset.originalPath,
        source: 'recovery',
      });

      const edited = { sha1: randomBytes(20), sha256: randomBytes(32), sizeInBytes: 6 };
      for (const { asset } of [uploaded, relinked]) {
        await sut.recordExternalScanChecksums({ assetId: asset.id, ...edited, path: asset.originalPath });
      }

      const upload = await read(uploaded.asset.id);
      expect(upload).toMatchObject({ sha1: seeded.sha1, sizeInBytes: 5 });
      expect(JSON.parse(upload!.evidence)).toEqual({ source: 'upload' });
      const refreshed = await read(relinked.asset.id);
      expect(refreshed).toMatchObject({ sha1: edited.sha1, sizeInBytes: 6 });
      expect(JSON.parse(refreshed!.evidence)).toEqual({ source: 'external-scan' });
    });

    it('ignores any recorded digest of a path-checksum asset, whoever wrote it', async () => {
      const { ctx, sut } = setup();
      const { user, asset } = await external(ctx);
      const sha1 = randomBytes(20);
      const sha256 = randomBytes(32);
      // what a Library Care relink wrote before FL-69 labelled it
      await sut.recordAssetChecksums({
        assetId: asset.id,
        sha1,
        sha256,
        sizeInBytes: 5,
        path: asset.originalPath,
        source: 'recovery',
      });

      await expect(sut.hasAssetChecksum(user.id, sha1, sha256)).resolves.toBe(false);
      await expect(sut.getChecksumTranslations(user.id, [sha1])).resolves.toEqual([]);
    });
  });
});
