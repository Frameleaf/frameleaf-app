import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, ChecksumAlgorithm } from 'src/enum.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const checksum = Buffer.alloc(32, 1);
  const { asset } = await ctx.newAsset({ ownerId: user.id, checksum, checksumAlgorithm: ChecksumAlgorithm.sha256File });
  const name = randomUUID().toUpperCase();
  const input = {
    ownerId: user.id,
    assetId: asset.id,
    parsed: { cplAssetRecordName: name, cplMasterRecordName: null },
    cloudIdentifier: name,
    role: 'original' as const,
    editVersion: '',
    sha256: checksum,
    claimId: null,
    deviceKey: randomUUID(),
    metadata: {},
  };
  return { ctx, user, asset, input, sut: new ICloudIdentityRepository(db), auth: factory.auth({ user }) };
};

describe('owner and byte-validated iCloud identity attachment', () => {
  it('records an owned original idempotently without upgrading opaque names to verified evidence', async () => {
    const { sut, auth, input } = await setup();
    expect(await sut.attachDevice(auth, input)).toBe(true);
    expect(await sut.attachDevice(auth, input)).toBe(true);
    const rows = await sut.identities(input.ownerId, [input.parsed.cplAssetRecordName]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetId: input.assetId,
      sha256: input.sha256,
      deliveredBy: `device:${input.deviceKey}`,
      matchStrength: 'hint',
      lastVerifiedAt: null,
      lastAuditResult: null,
    });
  });

  it('refuses a replacement digest when the same identity still describes earlier bytes', async () => {
    const { sut, auth, input, asset } = await setup();
    expect(await sut.attachDevice(auth, input)).toBe(true);
    await sql`
      UPDATE public.icloud_source_identity SET "lastVerifiedAt" = now(), "lastAuditResult" = 'match'
      WHERE "assetId" = ${asset.id}::uuid
    `.execute(db);
    const before = await sut.identities(input.ownerId, [input.parsed.cplAssetRecordName]);
    const replacement = Buffer.alloc(32, 2);
    await db.updateTable('asset').set({ checksum: replacement }).where('id', '=', asset.id).execute();
    expect(await sut.attachDevice(auth, { ...input, sha256: replacement })).toBe(false);
    expect(await sut.identities(input.ownerId, [input.parsed.cplAssetRecordName])).toEqual(before);
  });

  it('rejects another owner and mismatched or unknown digests without writing identities', async () => {
    const { ctx, sut, auth, input, asset } = await setup();
    const { user: other } = await ctx.newUser();
    expect(await sut.attachDevice(factory.auth({ user: other }), { ...input, ownerId: other.id })).toBe(false);
    expect(await sut.attachDevice(auth, { ...input, sha256: Buffer.alloc(32, 2) })).toBe(false);
    await db
      .updateTable('asset')
      .set({ checksumAlgorithm: ChecksumAlgorithm.sha1File, checksum: Buffer.alloc(20) })
      .where('id', '=', asset.id)
      .execute();
    expect(await sut.attachDevice(auth, input)).toBe(false);
    expect(await sut.identities(input.ownerId, [input.parsed.cplAssetRecordName])).toEqual([]);
  });

  it('requires elevation for Locked originals and rejects deleted originals', async () => {
    const { sut, auth, user, input, asset } = await setup();
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null })
      .execute();
    expect(await sut.attachDevice(auth, input)).toBe(false);
    expect(await sut.attachDevice(factory.auth({ user, session: { hasElevatedPermission: true } }), input)).toBe(true);
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    expect(
      await sut.attachDevice(auth, {
        ...input,
        parsed: { ...input.parsed, cplAssetRecordName: randomUUID().toUpperCase() },
      }),
    ).toBe(false);
  });

  it('uses the current digest after a concurrent original replacement', async () => {
    const { sut, auth, input, asset } = await setup();
    // Hold a concurrent original change until it commits; attachment must not trust the old digest.
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const { promise: ready, resolve: locked } = Promise.withResolvers<number>();
    const replacement = db.transaction().execute(async (tx) => {
      await tx
        .updateTable('asset')
        .set({ checksum: Buffer.alloc(32, 2) })
        .where('id', '=', asset.id)
        .execute();
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
      locked(rows[0].pid);
      await released;
    });
    const blockerPid = await Promise.race([
      ready,
      replacement.then(() => {
        throw new Error('Replacement did not pause');
      }),
    ]);
    const attachment = sut.attachDevice(auth, input);
    void attachment.catch(() => {});
    try {
      await expect
        .poll(
          async () => {
            const { rows } = await sql`
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND pg_blocking_pids(pid) @> ARRAY[${blockerPid}]::integer[]
            `.execute(db);
            return rows.length > 0;
          },
          { timeout: 1000 },
        )
        .toBe(true);
    } finally {
      release();
      await Promise.allSettled([replacement, attachment]);
    }
    await replacement;
    expect(await attachment).toBe(false);
    expect(
      await sql`SELECT id FROM public.icloud_source_identity WHERE "assetId" = ${asset.id}::uuid`.execute(db),
    ).toMatchObject({ rows: [] });
  });
});
