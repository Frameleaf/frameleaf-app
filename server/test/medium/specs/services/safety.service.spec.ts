import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetLockReason,
  AssetVisibility,
  ChecksumAlgorithm,
  MediaOperationStatus,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { SafetyService } from 'src/services/safety.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const bucket = 'https://private-bucket.test/owner';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const index = new CloudBackupIndexRepository(db);
  const integrity = new IntegrityRepository(db);
  const cloud = {
    getSafetyAvailability: () => Promise.resolve({ state: 'ready', bucket, readOnly: false, readOnlyReason: null }),
  } as unknown as CloudBackupService;
  return { ctx, index, integrity, sut: new SafetyService(integrity, index, cloud) };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const operation = async (ownerId: string, task: 'backup' | 'verify', depth = 'sample') => {
  const { rows } = await sql<{ id: string }>`INSERT INTO media_operation
    ("ownerId", kind, destination, label, snapshot, settings, status, result, "finishedAt")
    VALUES (${ownerId}::uuid, 'cloud_backup', 'local', 'Safety test',
      ${{ bucketRef: bucket, task, depth }}::jsonb, '{}'::jsonb, 'completed',
      ${task === 'backup' ? { phase: 'done' } : { task, depth, done: true }}::jsonb, clock_timestamp()) RETURNING id`.execute(
    db,
  );
  return rows[0].id;
};

/** Fixture proof rows use real SQL; completion and verification remain distinct facts. */
const recordSafetyProof = async (
  index: CloudBackupIndexRepository,
  assetId: string,
  ownerId: string,
  sha256: string,
  completedAt: Date,
) => {
  const backup = await operation(ownerId, 'backup');
  await db
    .updateTable('media_operation')
    .set({
      createdAt: new Date(completedAt.getTime() - 2000),
      startedAt: new Date(completedAt.getTime() - 1000),
      finishedAt: completedAt,
    })
    .where('id', '=', backup)
    .execute();
  const manifest = await index.createManifest({ bucket, key: `${assetId}.json`, operationId: backup });
  await index.record(bucket, [{ sha256, size: 10, etag: null }]);
  await db
    .updateTable('cloud_backup_object')
    .set({ uploadedAt: completedAt })
    .where('sha256', '=', sha256)
    .where('bucket', '=', bucket)
    .execute();
  await db.insertInto('cloud_backup_manifest_original').values({ manifestId: manifest.id, assetId, sha256 }).execute();
  await db
    .updateTable('cloud_backup_manifest')
    .set({ status: 'complete', createdAt: new Date(completedAt.getTime() - 1000), finishedAt: completedAt })
    .where('id', '=', manifest.id)
    .execute();
  const verify = await operation(ownerId, 'verify');
  await db
    .updateTable('media_operation')
    .set({
      createdAt: new Date(completedAt.getTime() + 1000),
      startedAt: new Date(completedAt.getTime() + 1000),
      finishedAt: new Date(completedAt.getTime() + 2000),
    })
    .where('id', '=', verify)
    .execute();
  await db
    .insertInto('cloud_backup_object_verification')
    .values({
      bucket,
      sha256,
      operationId: verify,
      method: 'sha256-get',
      result: 'passed',
      checkedAt: new Date(completedAt.getTime() + 1000),
    })
    .execute();
};

describe('own safety API PostgreSQL authorization and proof qualification', () => {
  it('reports current-original delivery once, excluding stale, foreign and Locked identities', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const hashes = ['sync', 'device', 'stale', 'unknown', 'foreign'].map((value) => hash(`delivery-${value}`));
    const assets = await Promise.all(
      hashes.map((sha, index) =>
        ctx.newAsset({
          ownerId: index === 4 ? foreign.id : user.id,
          checksum: Buffer.from(sha, 'hex'),
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
        }),
      ),
    );
    const connection = randomUUID();
    const device = randomUUID();
    const delivery = `icloud-sync:${connection}`;
    const fromDevice = `device:${device}`;
    for (const [index, ownerId, sha, deliveredBy, at] of [
      [0, user.id, hashes[0], delivery, '2026-09-01'],
      [0, user.id, hashes[0], fromDevice, '2026-09-02'],
      [1, user.id, hashes[1], fromDevice, '2026-09-01'],
      [1, user.id, hashes[1], delivery, '2026-09-02'],
      [2, user.id, hash('old-original'), delivery, '2026-09-01'],
      [3, foreign.id, hashes[3], delivery, '2026-09-01'],
      [4, foreign.id, hashes[4], delivery, '2026-09-01'],
    ] as const) {
      await sql`INSERT INTO public.icloud_source_identity
        ("ownerId", "assetId", "cplAssetRecordName", role, sha256, "deliveredBy", "deliveredAt")
        VALUES (${ownerId}::uuid, ${assets[index].asset.id}::uuid, ${randomUUID()}, 'original',
          ${Buffer.from(sha, 'hex')}, ${deliveredBy}, ${at}::timestamptz)`.execute(db);
    }
    const auth = factory.auth({ user });
    const lookup = await sut.lookup(auth, { hashes });
    expect(new Map(lookup.assets.map(({ id, deliveredBy }) => [id, deliveredBy]))).toEqual(
      new Map([
        [assets[0].asset.id, delivery],
        [assets[1].asset.id, fromDevice],
        [assets[2].asset.id, null],
        [assets[3].asset.id, null],
      ]),
    );
    expect(await sut.summary(auth)).toMatchObject({ total: 4, onServer: 4, fromICloudSync: 1 });
    await db
      .insertInto('asset_lock')
      .values({ assetId: assets[0].asset.id, reason: AssetLockReason.Marked, lockedBy: null })
      .execute();
    expect((await sut.lookup(auth, { hashes: [hashes[0]] })).assets).toEqual([]);
    expect(await sut.summary(auth)).toMatchObject({ total: 3, fromICloudSync: 0 });
    const unlocked = factory.auth({ user, session: { hasElevatedPermission: true } });
    expect(await sut.summary(unlocked)).toMatchObject({ total: 4, fromICloudSync: 1 });
    const replacement = hash('delivery-replacement');
    await db
      .updateTable('asset')
      .set({ checksum: Buffer.from(replacement, 'hex') })
      .where('id', '=', assets[0].asset.id)
      .execute();
    expect((await sut.lookup(unlocked, { hashes: [replacement] })).assets[0].deliveredBy).toBeNull();
    expect(await sut.summary(unlocked)).toMatchObject({ total: 4, fromICloudSync: 0 });
  });

  it('returns 1000 matching own assets in one bulk query with matching summary counts', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const hashes = Array.from({ length: 1000 }, (_, i) => hash(`positive-${i}`));
    const assets = hashes.map((sha) =>
      mediumFactory.assetInsert({
        ownerId: user.id,
        checksum: Buffer.from(sha, 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      }),
    );
    await db.insertInto('asset').values(assets).execute();
    const result = await sut.lookup(factory.auth({ user }), { hashes });
    expect(new Set(result.assets.map(({ id }) => id))).toEqual(new Set(assets.map(({ id }) => id)));
    expect(result.assets).toHaveLength(1000);
    expect(await sut.summary(factory.auth({ user }))).toMatchObject({
      total: 1000,
      onServer: 1000,
      onServerPercent: 100,
      backedUp: 0,
      backedUpPercent: 0,
    });
  });

  it('handles 1000 hashes and never reveals foreign assets despite partner/album/admin access', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const sha = hash('owner-only');
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      checksum: Buffer.from(sha, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });
    const hashes = [sha, ...Array.from({ length: 999 }, (_, i) => hash(`missing-${i}`))];
    expect((await sut.lookup(factory.auth({ user: owner }), { hashes })).assets.map(({ id }) => id)).toEqual([
      asset.id,
    ]);
    for (const user of [partner, viewer, admin]) {
      expect((await sut.lookup(factory.auth({ user }), { hashes })).assets).toEqual([]);
      expect(await sut.summary(factory.auth({ user }))).toMatchObject({
        total: 0,
        backedUp: 0,
        lastCompletedRunAt: null,
        lastVerifiedRunAt: null,
      });
    }
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null })
      .execute();
    expect((await sut.lookup(factory.auth({ user: owner }), { hashes })).assets).toEqual([]);
    expect((await sut.summary(factory.auth({ user: owner }))).total).toBe(0);
    const unlocked = factory.auth({ user: owner, session: { hasElevatedPermission: true } });
    expect((await sut.lookup(unlocked, { hashes })).assets).toHaveLength(1);
    expect((await sut.summary(unlocked)).total).toBe(1);
  });

  it('never reveals foreign safety facts to an accepted shared-space viewer who can read the source asset', async () => {
    const { ctx, sut, index } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const sha = hash('shared-space-foreign');
    const { asset } = await ctx.newAsset({
      ownerId: owner.id,
      checksum: Buffer.from(sha, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const { album: space } = await ctx.newAlbum({ ownerId: owner.id, kind: AlbumKind.Space }, [asset.id]);
    await ctx.newAlbumUser({ albumId: space.id, userId: viewer.id, role: AlbumUserRole.Viewer });
    expect(await new AccessRepository(db).asset.checkAlbumAccess(viewer.id, new Set([asset.id]))).toEqual(
      new Set([asset.id]),
    );
    await recordSafetyProof(index, asset.id, owner.id, sha, new Date('2026-09-20T12:00:00Z'));
    const auth = factory.auth({ user: viewer });
    expect(await sut.lookup(auth, { hashes: [sha] })).toEqual({
      cloudAvailability: 'ready',
      cloudReadOnly: false,
      cloudReadOnlyReason: null,
      assets: [],
    });
    expect(await sut.summary(auth)).toEqual({
      cloudAvailability: 'ready',
      cloudReadOnly: false,
      cloudReadOnlyReason: null,
      total: 0,
      onServer: 0,
      fromICloudSync: 0,
      onServerPercent: 0,
      backedUp: 0,
      backedUpPercent: 0,
      lastCompletedRunAt: null,
      lastVerifiedRunAt: null,
    });
  });

  it('aggregates positive mixed-library backup counts and dates without borrowing newer foreign proof', async () => {
    const { ctx, sut, index } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: foreign } = await ctx.newUser();
    const ownHash = hash('summary-own-backed');
    const otherHash = hash('summary-own-not-backed');
    const foreignHash = hash('summary-foreign-backed');
    const { asset: backed } = await ctx.newAsset({
      ownerId: owner.id,
      checksum: Buffer.from(ownHash, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await ctx.newAsset({
      ownerId: owner.id,
      checksum: Buffer.from(otherHash, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const { asset: other } = await ctx.newAsset({
      ownerId: foreign.id,
      checksum: Buffer.from(foreignHash, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const completedAt = new Date('2026-09-20T12:00:00Z');
    await recordSafetyProof(index, backed.id, owner.id, ownHash, completedAt);
    await recordSafetyProof(index, other.id, foreign.id, foreignHash, new Date('2026-09-25T12:00:00Z'));
    expect(await sut.summary(factory.auth({ user: owner }))).toEqual({
      cloudAvailability: 'ready',
      cloudReadOnly: false,
      cloudReadOnlyReason: null,
      total: 2,
      onServer: 2,
      fromICloudSync: 0,
      onServerPercent: 100,
      backedUp: 1,
      backedUpPercent: 50,
      lastCompletedRunAt: completedAt.toISOString(),
      lastVerifiedRunAt: new Date(completedAt.getTime() + 2000).toISOString(),
    });
    expect((await sut.summary(factory.auth({ user: foreign }))).lastCompletedRunAt).toBe('2026-09-25T12:00:00.000Z');
  });

  it('requires current retained completion/object presence; HEAD, cancelled checks and deleted assets cannot invent verification', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const sha = hash('backed-current');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(sha, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const auth = factory.auth({ user });
    const lookup = async () => (await sut.lookup(auth, { hashes: [sha] })).assets[0];
    const backupOperation = await operation(user.id, 'backup');
    const manifest = await index.createManifest({ bucket, key: `${asset.id}.json`, operationId: backupOperation });
    await index.record(bucket, [{ sha256: sha, size: 10, etag: null }]);
    await db
      .insertInto('cloud_backup_manifest_original')
      .values({ manifestId: manifest.id, assetId: asset.id, sha256: sha })
      .execute();
    await db
      .updateTable('cloud_backup_manifest')
      .set({ status: 'complete', finishedAt: new Date() })
      .where('id', '=', manifest.id)
      .execute();
    expect((await lookup()).cloudBackup).toMatchObject({ state: 'completed', lastVerifiedRunAt: null });
    await db.updateTable('media_operation').set({ finishedAt: null }).where('id', '=', backupOperation).execute();
    expect((await lookup()).cloudBackup.state).toBe('not-backed-up');
    await db.updateTable('media_operation').set({ finishedAt: new Date() }).where('id', '=', backupOperation).execute();
    const head = await operation(user.id, 'verify', 'full');
    await db
      .insertInto('cloud_backup_object_verification')
      .values({ bucket, sha256: sha, operationId: head, method: 'size-head', result: 'passed' })
      .execute();
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).toBeNull();
    const get = await operation(user.id, 'verify');
    await db
      .insertInto('cloud_backup_object_verification')
      .values({ bucket, sha256: sha, operationId: get, method: 'sha256-get', result: 'passed' })
      .execute();
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).not.toBeNull();
    await db
      .updateTable('media_operation')
      .set({ result: { task: 'verify', depth: 'sample', done: false } })
      .where('id', '=', get)
      .execute();
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).toBeNull();
    await db
      .updateTable('media_operation')
      .set({ result: { task: 'verify', depth: 'sample', done: true } })
      .where('id', '=', get)
      .execute();
    const failedGet = await operation(user.id, 'verify');
    await db
      .insertInto('cloud_backup_object_verification')
      .values({ bucket, sha256: sha, operationId: failedGet, method: 'sha256-get', result: 'mismatched' })
      .execute();
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).toBeNull();
    await db.deleteFrom('media_operation').where('id', '=', failedGet).execute();
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Cancelled })
      .where('id', '=', get)
      .execute();
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).toBeNull();
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Completed })
      .where('id', '=', get)
      .execute();
    for (const status of [
      MediaOperationStatus.Failed,
      MediaOperationStatus.Cancelled,
      MediaOperationStatus.Preparing,
    ]) {
      await db.updateTable('media_operation').set({ status }).where('id', '=', backupOperation).execute();
      expect((await lookup()).cloudBackup.state).toBe('not-backed-up');
    }
    await db
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Completed })
      .where('id', '=', backupOperation)
      .execute();
    for (const status of ['degraded', 'pruned']) {
      await db.updateTable('cloud_backup_manifest').set({ status }).where('id', '=', manifest.id).execute();
      expect((await lookup()).cloudBackup.state).toBe('not-backed-up');
    }
    await db.updateTable('cloud_backup_manifest').set({ status: 'complete' }).where('id', '=', manifest.id).execute();
    await db.updateTable('cloud_backup_manifest').set({ operationId: null }).where('id', '=', manifest.id).execute();
    expect((await lookup()).cloudBackup.state).toBe('not-backed-up');
    await db
      .updateTable('cloud_backup_manifest')
      .set({ operationId: backupOperation })
      .where('id', '=', manifest.id)
      .execute();
    await index.forget(bucket, [sha]);
    expect((await lookup()).cloudBackup.state).toBe('not-backed-up');
    await index.record(bucket, [{ sha256: sha, size: 10, etag: null }]);
    expect((await lookup()).cloudBackup.lastVerifiedRunAt).toBeNull();
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
    expect(await sut.summary(auth)).toMatchObject({
      total: 0,
      backedUp: 0,
      lastCompletedRunAt: null,
      lastVerifiedRunAt: null,
    });
    expect(
      await db.selectFrom('cloud_backup_manifest_original').select('assetId').where('assetId', '=', asset.id).execute(),
    ).toHaveLength(1);
  });

  it('filters suppressed tags, motion of Locked stills and deleted libraries in lookup and counts', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { tag } = await ctx.newTag({ userId: user.id, value: 'private', color: null, parentId: null });
    const sha = hash('suppressed');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(sha, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await ctx.newTagAsset({ assetIds: [asset.id], tagIds: [tag.id] });
    const auth = factory.auth({ user });
    auth.hiddenContent = {
      userId: user.id,
      tagIds: [tag.id],
      personIds: [],
      petIds: [],
      scope: 'owned',
      includeNsfw: false,
    };
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
    expect((await sut.summary(auth)).total).toBe(0);
    delete auth.hiddenContent;
    await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', asset.id).execute();
    const { asset: still } = await ctx.newAsset({ ownerId: user.id, livePhotoVideoId: asset.id });
    await db
      .insertInto('asset_lock')
      .values({ assetId: still.id, reason: AssetLockReason.Marked, lockedBy: null })
      .execute();
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
    await db.deleteFrom('asset').where('id', '=', still.id).execute();
    const library = await db
      .insertInto('library')
      .values({ ownerId: user.id, name: 'Deleted', importPaths: [], exclusionPatterns: [], deletedAt: new Date() })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.updateTable('asset').set({ libraryId: library.id }).where('id', '=', asset.id).execute();
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
    expect((await sut.summary(auth)).total).toBe(0);
  });

  it('reports refreshed failure without replacing checksum baseline and invalidates path identity/legacy mapping', async () => {
    const { ctx, sut, integrity } = setup();
    const { user } = await ctx.newUser();
    const sha = hash('integrity-current');
    const checksum = Buffer.from(sha, 'hex');
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const auth = factory.auth({ user });
    const lookup = async () => (await sut.lookup(auth, { hashes: [sha] })).assets[0];
    const input = {
      assetId: asset.id,
      originalPath: asset.originalPath,
      expectedChecksum: checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      actualSha256: sha,
      result: 'passed' as const,
    };
    await integrity.recordVerification(input);
    expect((await lookup()).integrityResult).toBe('passed');
    await integrity.recordVerification({ ...input, actualSha256: null, result: 'missing' });
    expect((await lookup()).integrityResult).toBe('missing');
    expect(await sut.summary(auth)).toMatchObject({ total: 1, onServer: 0, onServerPercent: 0 });
    expect(
      (await db.selectFrom('asset').select('checksum').where('id', '=', asset.id).executeTakeFirstOrThrow()).checksum,
    ).toEqual(checksum);
    await db.updateTable('asset').set({ originalPath: '/replacement' }).where('id', '=', asset.id).execute();
    expect(await lookup()).toMatchObject({ integrityResult: 'unknown', lastIntegrityAt: null });
    const sha1 = createHash('sha1').update('legacy').digest();
    await db
      .updateTable('asset')
      .set({ checksum: sha1, checksumAlgorithm: ChecksumAlgorithm.sha1File })
      .where('id', '=', asset.id)
      .execute();
    await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt") VALUES (${asset.id}::uuid, ${sha1}, ${checksum}, 10, ARRAY['/replacement']::text[], 1, '{}'::jsonb, now(), now())`.execute(
      db,
    );
    expect((await lookup()).id).toBe(asset.id);
    await db.updateTable('asset').set({ originalPath: '/unverified' }).where('id', '=', asset.id).execute();
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
    await db
      .updateTable('asset')
      .set({
        checksum: createHash('sha1').update('/unverified').digest(),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      })
      .where('id', '=', asset.id)
      .execute();
    await sql`UPDATE public.asset_checksum SET "verifiedPaths" = ARRAY['/unverified']::text[], evidence = jsonb_build_object('source', ${EXTERNAL_SCAN_CHECKSUM}::text) WHERE "assetId" = ${asset.id}::uuid`.execute(
      db,
    );
    expect((await lookup()).id).toBe(asset.id);
    await sql`UPDATE public.asset_checksum SET evidence = '{}'::jsonb WHERE "assetId" = ${asset.id}::uuid`.execute(db);
    expect((await sut.lookup(auth, { hashes: [sha] })).assets).toEqual([]);
  });
});
