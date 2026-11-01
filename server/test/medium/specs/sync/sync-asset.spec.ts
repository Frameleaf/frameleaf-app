import { Kysely, sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { ChecksumAlgorithm, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { up as restreamOwnAssets } from 'src/schema/migrations/2100000003040-Sha256SyncChecksums.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

const fileOf = (contents = randomBytes(64)) => ({
  contents,
  sha1: createHash('sha1').update(contents).digest(),
  sha256: createHash('sha256').update(contents).digest(),
});

/** The digests an upload or the nightly checksum check records for an asset's file. */
const record = (
  ctx: SyncTestContext,
  asset: { id: string; originalPath: string },
  file: ReturnType<typeof fileOf>,
  source: 'upload' | 'integrity',
) =>
  ctx.get(AssetChecksumRepository).recordAssetChecksums({
    assetId: asset.id,
    sha1: file.sha1,
    sha256: file.sha256,
    sizeInBytes: file.contents.length,
    path: asset.originalPath,
    source,
  });

const streamedChecksum = (response: Array<{ type: string; data: any }>, type: SyncEntityType, id: string) =>
  response.find((item) => item.type === type && item.data.id === id)?.data.checksum;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.AssetV2, () => {
  it('should detect and sync the first asset', async () => {
    const originalFileName = 'firstAsset';
    const checksum = '1115vHcVkZzNp3Q9G+FEA0nu6zUbGb4Tj4UOXkN0wRA=';
    const thumbhash = '2225vHcVkZzNp3Q9G+FEA0nu6zUbGb4Tj4UOXkN0wRA=';
    const date = new Date().toISOString();

    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({
      originalFileName,
      ownerId: auth.user.id,
      checksum: Buffer.from(checksum, 'base64'),
      thumbhash: Buffer.from(thumbhash, 'base64'),
      fileCreatedAt: date,
      fileModifiedAt: date,
      localDateTime: date,
      createdAt: date,
      deletedAt: null,
      duration: 600_000,
      libraryId: null,
      width: 1920,
      height: 1080,
    });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          id: asset.id,
          originalFileName,
          ownerId: asset.ownerId,
          thumbhash,
          checksum,
          deletedAt: asset.deletedAt,
          fileCreatedAt: asset.fileCreatedAt,
          fileModifiedAt: asset.fileModifiedAt,
          createdAt: asset.createdAt,
          isFavorite: asset.isFavorite,
          localDateTime: asset.localDateTime,
          type: asset.type,
          visibility: asset.visibility,
          duration: asset.duration,
          stackId: null,
          livePhotoVideoId: null,
          libraryId: asset.libraryId,
          width: asset.width,
          height: asset.height,
          isEdited: asset.isEdited,
        },
        type: 'AssetV2',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('never sends a recorded digest of an asset with a path checksum (FL-69)', async () => {
    const { auth, ctx } = await setup();
    const pathChecksum = randomBytes(20);
    const { asset } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: pathChecksum,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      originalPath: '/external/photos/lake.png',
    });
    // what a Library Care relink of an external original records: bytes on an external mount, not a managed copy
    await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
      VALUES (${asset.id}::uuid, ${randomBytes(20)}, ${randomBytes(32)}, 5, ARRAY[${asset.originalPath}]::text[], 1,
        '{"source":"recovery"}'::jsonb, now(), now())`.execute(defaultDatabase);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AssetV2,
        data: expect.objectContaining({ id: asset.id, checksum: pathChecksum.toString('base64') }),
      }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('sends the SHA-256 an upload recorded, not the SHA-1 kept beside it', async () => {
    const { auth, ctx } = await setup();
    const file = fileOf();
    const { asset } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: file.sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await record(ctx, asset, file, 'upload');

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetV2 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    expect(streamedChecksum(response, SyncEntityType.AssetV2, asset.id)).toBe(file.sha256.toString('base64'));
  });

  it('sends a legacy asset the SHA-256 the checksum check recorded, and its SHA-1 while none is', async () => {
    const { auth, ctx } = await setup();
    const verified = fileOf();
    const unverified = fileOf();
    const { asset: checked } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: verified.sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    const { asset: unchecked } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: unverified.sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    await record(ctx, checked, verified, 'integrity');

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(streamedChecksum(response, SyncEntityType.AssetV2, checked.id)).toBe(verified.sha256.toString('base64'));
    expect(streamedChecksum(response, SyncEntityType.AssetV2, unchecked.id)).toBe(unverified.sha1.toString('base64'));
  });

  it('sends a legacy asset again, with its SHA-256, once the checksum check moves it', async () => {
    const { auth, ctx } = await setup();
    const file = fileOf();
    const { asset } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: file.sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });

    const first = await ctx.syncStream(auth, [SyncRequestType.AssetsV2, SyncRequestType.AssetsV3]);
    expect(streamedChecksum(first, SyncEntityType.AssetV2, asset.id)).toBe(file.sha1.toString('base64'));
    expect(streamedChecksum(first, SyncEntityType.AssetV3, asset.id)).toBe(file.sha1.toString('base64'));
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2, SyncRequestType.AssetsV3]);

    // what IntegrityService does once the file verifies
    await record(ctx, asset, file, 'integrity');
    await expect(
      ctx.get(AssetChecksumRepository).promoteToSha256({ assetId: asset.id, sha1: file.sha1, sha256: file.sha256 }),
    ).resolves.toBe(true);

    const second = await ctx.syncStream(auth, [SyncRequestType.AssetsV2, SyncRequestType.AssetsV3]);
    expect(second.filter((item) => item.type !== SyncEntityType.SyncCompleteV1)).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetV2, data: expect.objectContaining({ id: asset.id }) }),
      expect.objectContaining({ type: SyncEntityType.AssetV3, data: expect.objectContaining({ id: asset.id }) }),
    ]);
    expect(streamedChecksum(second, SyncEntityType.AssetV2, asset.id)).toBe(file.sha256.toString('base64'));
    expect(streamedChecksum(second, SyncEntityType.AssetV3, asset.id)).toBe(file.sha256.toString('base64'));
    await ctx.syncAckAll(auth, second);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2, SyncRequestType.AssetsV3]);
  });

  it('sends every own asset again once, with its SHA-256, after the re-stream migration', async () => {
    const { auth, ctx } = await setup();
    const file = fileOf();
    const { asset } = await ctx.newAsset({
      ownerId: auth.user.id,
      checksum: file.sha1,
      checksumAlgorithm: ChecksumAlgorithm.sha1File,
    });
    const { asset: gone } = await ctx.newAsset({ ownerId: auth.user.id });
    await ctx.get(AssetRepository).remove(gone);
    const types = [SyncRequestType.AssetsV2, SyncRequestType.AssetsV3];

    // a device that synced while sync sent SHA-1, and only then had the SHA-256 recorded
    const first = await ctx.syncStream(auth, types);
    await ctx.syncAckAll(auth, first);
    await record(ctx, asset, file, 'integrity');
    await ctx.assertSyncIsComplete(auth, types);

    await restreamOwnAssets(defaultDatabase);

    const second = await ctx.syncStream(auth, types);
    expect(streamedChecksum(second, SyncEntityType.AssetV2, asset.id)).toBe(file.sha256.toString('base64'));
    expect(streamedChecksum(second, SyncEntityType.AssetV3, asset.id)).toBe(file.sha256.toString('base64'));
    // deletes carry on from where they were
    expect(second.filter((item) => item.data?.assetId === gone.id)).toEqual([]);
    await ctx.syncAckAll(auth, second);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('should detect and sync a deleted asset', async () => {
    const { auth, ctx } = await setup();
    const assetRepo = ctx.get(AssetRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    await assetRepo.remove(asset);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetsV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetId: asset.id,
        },
        type: 'AssetDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });

  it('should not sync an asset or asset delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const assetRepo = ctx.get(AssetRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetsV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetV2 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);

    await assetRepo.remove(asset);
    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetsV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetsV2]);
  });
});
