import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AlbumUserRole, AssetFileType, AssetStatus, AssetVisibility, MediaOperationStatus } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * The cloud backup index, manifests and manifest entries (FL-160, migration 2100000000670), and the
 * library reads a run makes: every owner's assets with their recorded SHA-256, Locked and trashed ones
 * included (backup is backend work), with sidecars always and thumbnails or transcoded videos only when
 * asked for.
 */

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new CloudBackupIndexRepository(defaultDatabase) };
};

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(CloudBackupIndexRepository.name, () => {
  const liveVerification = async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const bucket = `https://s3.test/${randomUUID()}`;
    const claimToken = randomUUID();
    const { rows } = await sql<{ id: string }>`INSERT INTO media_operation
      ("ownerId", kind, destination, label, snapshot, settings, status, "claimToken", "claimExpiresAt")
      VALUES (${user.id}::uuid, 'cloud_backup', 'local', 'Verify',
        ${{ bucketRef: bucket, task: 'verify', depth: 'sample' }}::jsonb, '{}'::jsonb,
        'rendering', ${claimToken}::uuid, clock_timestamp() + interval '1 hour') RETURNING id`.execute(defaultDatabase);
    return {
      sut,
      proof: {
        bucket,
        sha256: sha('verified'),
        operationId: rows[0].id,
        claimToken,
        method: 'sha256-get' as const,
        result: 'passed' as const,
      },
    };
  };

  it.each([
    ['expired', { claimExpiresAt: new Date(0) }],
    ['cancel requested', { cancelRequestedAt: new Date() }],
    ['pause requested', { pauseRequestedAt: new Date() }],
    ['paused', { status: MediaOperationStatus.Paused }],
    ['queued', { status: MediaOperationStatus.Queued }],
  ] as const)('refuses verification proof from a %s worker', async (_reason, patch) => {
    const { sut, proof } = await liveVerification();
    await defaultDatabase.updateTable('media_operation').set(patch).where('id', '=', proof.operationId).execute();
    await sut.recordObjectVerification(proof);
    expect(
      await defaultDatabase
        .selectFrom('cloud_backup_object_verification')
        .selectAll()
        .where('operationId', '=', proof.operationId)
        .execute(),
    ).toEqual([]);
  });

  it('rechecks lease expiry after waiting for an operation row lock', async () => {
    const { sut, proof } = await liveVerification();
    const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
    const { promise: held, resolve: release } = Promise.withResolvers<void>();
    let blockerPid = 0;
    await sql`UPDATE media_operation SET "claimExpiresAt" = clock_timestamp() + interval '2 seconds'
      WHERE id = ${proof.operationId}::uuid`.execute(defaultDatabase);
    const locking = defaultDatabase.transaction().execute(async (trx) => {
      blockerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0].pid;
      await trx
        .selectFrom('media_operation')
        .select('id')
        .where('id', '=', proof.operationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      signalEntered();
      await held;
    });
    let writing: Promise<void> | undefined;
    try {
      await Promise.race([entered, locking]);
      writing = sut.recordObjectVerification(proof);
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname=current_database() AND ${blockerPid}=ANY(pg_blocking_pids(pid))`.execute(defaultDatabase);
          expect(rows[0].waiting).toBeGreaterThan(0);
        },
        { timeout: 5000 },
      );
      const { rows } = await sql<{
        remaining: number;
      }>`SELECT extract(epoch FROM ("claimExpiresAt" - clock_timestamp()))::float8 AS remaining
        FROM media_operation WHERE id = ${proof.operationId}::uuid`.execute(defaultDatabase);
      expect(rows[0].remaining).toBeGreaterThan(0);
      await sql`SELECT pg_sleep(${rows[0].remaining + 0.01})`.execute(defaultDatabase);
      release();
      await locking;
      await writing;
      expect(
        await defaultDatabase
          .selectFrom('cloud_backup_object_verification')
          .selectAll()
          .where('operationId', '=', proof.operationId)
          .execute(),
      ).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([locking, ...(writing ? [writing] : [])]);
    }
  });

  it('persists unknown expired receipts as pruned and never adopts them as retained again', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const expired = {
      key: 'm/20261012T030000Z.json.gz',
      createdAt: new Date('2026-10-12T03:00:00.000Z'),
      databaseKey: null,
      assetCount: 0,
      fileCount: 0,
      bytes: 0,
    };
    await expect(sut.adoptManifests(bucket, [expired], 'pruned')).resolves.toBe(1);
    await expect(sut.getManifestKeys(bucket, [expired.key])).resolves.toEqual(new Set([expired.key]));
    await expect(sut.getManifestKeys(bucket, [expired.key], 'pruned')).resolves.toEqual(new Set([expired.key]));
    await expect(sut.listKeptManifests(bucket)).resolves.toEqual([]);
    await expect(sut.adoptManifests(bucket, [expired])).resolves.toBe(0);
    await sut.markManifests(bucket, [expired.key], 'degraded');
    await expect(sut.listKeptManifests(bucket)).resolves.toEqual([]);
  });

  it('expires a signed snapshot whose index was left running without letting verification revive it', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const key = 'm/20261012T030000Z.json.gz';
    await sut.createManifest({ bucket, key, operationId: randomUUID() });
    await expect(sut.getManifestKeys(bucket, [key], 'pruned')).resolves.toEqual(new Set());
    await expect(sut.markManifests(bucket, [key], 'pruned')).resolves.toBe(1);
    await expect(sut.getManifestKeys(bucket, [key], 'pruned')).resolves.toEqual(new Set([key]));
    await sut.markManifests(bucket, [key], 'degraded');
    await expect(sut.listKeptManifests(bucket)).resolves.toEqual([]);
  });

  it('installs feature tables in the real canonical baseline', async () => {
    await expectCanonicalTables(defaultDatabase, [
      'cloud_backup_object',
      'cloud_backup_manifest',
      'cloud_backup_manifest_entry',
    ]);
  });

  it('records each hash once per bucket, answers which are there and counts the usage', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;

    await sut.record(bucket, [
      { sha256: sha('a'), size: 100, etag: '"a"' },
      { sha256: sha('a'), size: 100, etag: '"a"' },
      { sha256: sha('b'), size: 50, etag: null },
    ]);
    await sut.record(bucket, [{ sha256: sha('b'), size: 50, etag: '"b"' }]);
    await sut.touch(bucket, [sha('a')]);

    await expect(sut.getExisting(bucket, [sha('a'), sha('c')])).resolves.toEqual(new Set([sha('a')]));
    // another bucket starts from an empty index
    await expect(sut.getExisting(`${bucket}-other`, [sha('a')])).resolves.toEqual(new Set());
    await expect(sut.getUsage(bucket)).resolves.toEqual({ objects: 2, bytes: 150 });
  });

  it("keeps a running manifest's files, replacing a file recorded twice, until they are deleted", async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const created = await sut.createManifest({ bucket, key: 'm/20260926T030000Z.json.gz', operationId: randomUUID() });
    expect(created).toMatchObject({ bucket, key: 'm/20260926T030000Z.json.gz', status: 'running' });

    const entry = {
      fileKey: `${randomUUID()}:original`,
      assetId: randomUUID(),
      ownerId: randomUUID(),
      role: 'original',
      path: '/data/library/a.jpg',
      sha256: sha('a'),
      size: 100,
      mtime: new Date('2026-09-01T00:00:00.000Z'),
    };
    await sut.upsertEntries(created.id, [entry]);
    await sut.upsertEntries(created.id, [{ ...entry, sha256: sha('b') }]);

    await expect(sut.getEntriesPage(created.id, null, 100)).resolves.toEqual([{ ...entry, sha256: sha('b') }]);
    await expect(sut.getEntriesPage(created.id, entry.fileKey, 100)).resolves.toEqual([]);

    await sut.finishManifest(created.id, { status: 'complete', assetCount: 1, fileCount: 1, bytes: 100 });
    await sut.deleteEntries(created.id);
    await expect(sut.getEntriesPage(created.id, null, 100)).resolves.toEqual([]);
    await expect(sut.getManifest(created.id)).resolves.toMatchObject({ status: 'complete' });
  });

  it('forgets a bucket, and drops rows its listing did not touch since a point in time', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    await sut.record(bucket, [
      { sha256: sha('gone'), size: 1, etag: null },
      { sha256: sha('kept'), size: 2, etag: null },
    ]);

    const since = await sut.currentTime();
    await sut.record(bucket, [{ sha256: sha('kept'), size: 2, etag: '"k"' }]);
    await expect(sut.pruneUnseen(bucket, since)).resolves.toBe(1);
    await expect(sut.getExisting(bucket, [sha('gone'), sha('kept')])).resolves.toEqual(new Set([sha('kept')]));

    await sut.deleteBucket(bucket);
    await expect(sut.getUsage(bucket)).resolves.toEqual({ objects: 0, bytes: 0 });
  });

  it('keeps client upload receipts apart from the bucket, and forgets them with it', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const receipts = `${bucket}#client-v1`;
    await sut.record(receipts, [
      { sha256: sha('bad'), size: 1, etag: '"b"' },
      { sha256: sha('good'), size: 2, etag: '"g"' },
    ]);
    await expect(sut.getUsage(bucket)).resolves.toEqual({ objects: 0, bytes: 0 });
    await expect(sut.getRecorded(receipts, [sha('good'), sha('none')])).resolves.toEqual(
      new Map([[sha('good'), { size: 2, etag: '"g"' }]]),
    );

    await sut.forget(bucket, [sha('bad')]);
    await expect(sut.getRecorded(receipts, [sha('bad'), sha('good')])).resolves.toEqual(
      new Map([[sha('good'), { size: 2, etag: '"g"' }]]),
    );
    await sut.deleteBucket(bucket);
    await expect(sut.getRecorded(receipts, [sha('good')])).resolves.toEqual(new Map());
  });

  it('forgets a bucket’s manifests too, so a fresh claim keeps no backup the bucket no longer holds', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const other = `https://s3.example.test/${randomUUID()}`;
    const old = await sut.createManifest({ bucket, key: 'm/20260920T030000Z.json.gz', operationId: randomUUID() });
    await sut.finishManifest(old.id, { status: 'complete' });
    const kept = await sut.createManifest({ bucket: other, key: 'm/20260920T030000Z.json.gz', operationId: randomUUID() });
    await sut.finishManifest(kept.id, { status: 'complete' });

    await sut.deleteBucket(bucket);

    await expect(sut.listKeptManifests(bucket)).resolves.toEqual([]);
    await expect(sut.listKeptManifests(other)).resolves.toHaveLength(1);
  });

  it('names the kept manifests that can hold an owner’s trashed item, or that recorded no originals', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const { asset: active } = await ctx.newAsset({ ownerId: user.id });
    const { asset: trashed } = await ctx.newAsset({
      ownerId: user.id,
      status: AssetStatus.Trashed,
      deletedAt: new Date(),
    });
    const complete = async (key: string, assetId?: string) => {
      const manifest = await sut.createManifest({ bucket, key, operationId: randomUUID() });
      if (assetId) {
        await sut.upsertEntries(manifest.id, [
          {
            fileKey: `${assetId}:original`,
            assetId,
            ownerId: user.id,
            role: 'original',
            path: `/data/${assetId}.jpg`,
            sha256: sha(assetId),
            size: 1,
            mtime: null,
          },
        ]);
      }
      await sut.finishManifest(manifest.id, { status: 'complete' });
    };
    await complete('m/20260920T030000Z.json.gz', active.id);
    await complete('m/20260921T030000Z.json.gz', trashed.id);
    await complete('m/20260922T030000Z.json.gz');

    await expect(sut.getOwnerBackupCandidates(bucket, user.id)).resolves.toEqual(
      new Set(['m/20260921T030000Z.json.gz', 'm/20260922T030000Z.json.gz']),
    );
  });

  it('finds and clears the transfer receipts of ended operations, and names the ones still going', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const transfer = { kind: 'download', partial: '/data/.frameleaf-part-x' };
    const insert = async (status: string) => {
      const { rows } = await sql<{ id: string }>`INSERT INTO media_operation
        ("ownerId", kind, destination, label, snapshot, settings, status, result)
        VALUES (${user.id}::uuid, 'cloud_restore', 'local', 'Restore', '{}'::jsonb, '{}'::jsonb, ${status},
          ${{ task: 'restore', backupTransfer: transfer }}::jsonb) RETURNING id`.execute(defaultDatabase);
      return rows[0].id;
    };
    const ended = await insert('cancelled');
    const queued = await insert('queued');

    const found = (await sut.getEndedTransfers()).filter(({ id }) => id === ended || id === queued);
    expect(found).toEqual([{ id: ended, transfer }]);
    await expect(sut.getUnfinishedOperationIds([ended, queued, randomUUID()])).resolves.toEqual(new Set([queued]));

    await sut.clearEndedTransfer(ended);
    await sut.clearEndedTransfer(queued);
    expect((await sut.getEndedTransfers()).some(({ id }) => id === ended)).toBe(false);
    const { rows } = await sql<{ id: string; result: Record<string, unknown> }>`SELECT id, result FROM media_operation
      WHERE id = any(${[ended, queued]}::uuid[])`.execute(defaultDatabase);
    expect(Object.fromEntries(rows.map(({ id, result }) => [id, result]))).toEqual({
      [ended]: { task: 'restore' },
      [queued]: { task: 'restore', backupTransfer: transfer },
    });
  });

  it('names the paths another asset holds now, as its original or one of its files', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const folder = `/data/library/${randomUUID()}`;
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: `${folder}/IMG_1.jpg` });
    await ctx.newAssetFile({ assetId: asset.id, path: `${folder}/IMG_1.jpg.xmp`, type: AssetFileType.Sidecar });
    const paths = [`${folder}/IMG_1.jpg`, `${folder}/IMG_1.jpg.xmp`, `${folder}/IMG_2.jpg`];

    await expect(sut.getTakenPaths(paths, [randomUUID()])).resolves.toEqual(new Set(paths.slice(0, 2)));
    await expect(sut.getTakenPaths(paths, [asset.id])).resolves.toEqual(new Set());
  });

  it('records manifests found in the bucket once, and never over one it already knows (FL-164)', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const pruned = await sut.createManifest({ bucket, key: 'm/20260920T030000Z.json.gz', operationId: randomUUID() });
    await sut.finishManifest(pruned.id, { status: 'complete' });
    await sut.markManifests(bucket, ['m/20260920T030000Z.json.gz'], 'pruned');
    const found = (key: string) => ({
      key,
      createdAt: new Date('2026-09-21T03:00:00.000Z'),
      databaseKey: 'db/21.sql.gz',
      assetCount: 3,
      fileCount: 4,
      bytes: 50,
    });

    await expect(
      sut.adoptManifests(bucket, [found('m/20260920T030000Z.json.gz'), found('m/20260921T030000Z.json.gz')]),
    ).resolves.toBe(1);
    await expect(sut.adoptManifests(bucket, [found('m/20260921T030000Z.json.gz')])).resolves.toBe(0);

    await expect(sut.listKeptManifests(bucket)).resolves.toEqual([
      expect.objectContaining({ key: 'm/20260921T030000Z.json.gz', status: 'complete', databaseKey: 'db/21.sql.gz' }),
    ]);
    await expect(
      sut.getManifestKeys(bucket, ['m/20260920T030000Z.json.gz', 'm/20260922T030000Z.json.gz']),
    ).resolves.toEqual(new Set(['m/20260920T030000Z.json.gz']));
  });

  it('ends the running manifests whose run is over or gone, with their files, and keeps the others', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const operation = async (status: string) => {
      const { rows } = await sql<{ id: string }>`
        INSERT INTO media_operation ("ownerId", kind, destination, label, snapshot, settings, status)
        VALUES (${user.id}::uuid, 'cloud_backup', 'local', 'Cloud backup', '{}'::jsonb, '{}'::jsonb, ${status})
        RETURNING id
      `.execute(defaultDatabase);
      return rows[0].id;
    };
    const bucket = `https://s3.example.test/${randomUUID()}`;
    const active = await sut.createManifest({ bucket, key: 'm/a.json.gz', operationId: await operation('rendering') });
    const paused = await sut.createManifest({ bucket, key: 'm/p.json.gz', operationId: await operation('paused') });
    const failed = await sut.createManifest({ bucket, key: 'm/f.json.gz', operationId: await operation('failed') });
    const gone = await sut.createManifest({ bucket, key: 'm/g.json.gz', operationId: randomUUID() });
    const file = {
      fileKey: 'x:original',
      assetId: null,
      ownerId: null,
      role: 'original',
      path: '/x',
      sha256: sha('x'),
      size: 1,
      mtime: null,
    };
    for (const manifest of [active, failed]) {
      await sut.upsertEntries(manifest.id, [file]);
    }

    await expect(sut.endAbandonedManifests()).resolves.toBeGreaterThanOrEqual(2);

    await expect(sut.getManifest(active.id)).resolves.toMatchObject({ status: 'running' });
    await expect(sut.getManifest(paused.id)).resolves.toMatchObject({ status: 'running' });
    await expect(sut.getManifest(failed.id)).resolves.toMatchObject({ status: 'failed' });
    await expect(sut.getManifest(gone.id)).resolves.toMatchObject({ status: 'failed' });
    await expect(sut.getEntriesPage(failed.id, null, 10)).resolves.toEqual([]);
    await expect(sut.getEntriesPage(active.id, null, 10)).resolves.toHaveLength(1);
  });

  it('lists every asset with its checksum, Locked and trashed ones included, never deleted ones', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
    const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    const { asset: trashed } = await ctx.newAsset({
      ownerId: user.id,
      status: AssetStatus.Trashed,
      deletedAt: new Date(),
    });
    const { asset: deleted } = await ctx.newAsset({
      ownerId: user.id,
      status: AssetStatus.Deleted,
      deletedAt: new Date(),
    });
    await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount")
      VALUES (${plain.id}::uuid, ${Buffer.alloc(20, 1)}, ${Buffer.from(sha('plain'), 'hex')}, 100, ${[plain.originalPath]}, 1)`.execute(
      defaultDatabase,
    );
    // verified at another path (the file moved since): the checksum is not vouched for at this one
    await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount")
      VALUES (${trashed.id}::uuid, ${Buffer.alloc(20, 2)}, ${Buffer.from(sha('moved'), 'hex')}, 100, ${['/data/elsewhere.jpg']}, 1)`.execute(
      defaultDatabase,
    );
    await ctx.newAssetFile({ assetId: plain.id, type: AssetFileType.Sidecar, path: '/data/library/plain.xmp' });
    await ctx.newAssetFile({ assetId: plain.id, type: AssetFileType.Thumbnail, path: '/data/thumbs/plain.webp' });

    const mine = async (includeThumbs: boolean) =>
      (await sut.listAssets({ afterId: null, limit: 10_000, includeThumbs, includeEncodedVideo: false })).filter(
        ({ ownerId }) => ownerId === user.id,
      );

    const listed = await mine(false);
    expect(listed.map(({ id }) => id).toSorted()).toEqual([plain.id, locked.id, trashed.id].toSorted());
    expect(listed.map(({ id }) => id)).not.toContain(deleted.id);
    const plainRow = listed.find(({ id }) => id === plain.id)!;
    expect(plainRow).toMatchObject({ sha256: sha('plain'), checksumSize: 100, checksumPathVerified: true });
    expect(listed.find(({ id }) => id === trashed.id)).toMatchObject({
      sha256: sha('moved'),
      checksumPathVerified: false,
    });
    expect(plainRow.files).toEqual([{ type: AssetFileType.Sidecar, path: '/data/library/plain.xmp' }]);
    expect(listed.find(({ id }) => id === locked.id)).toMatchObject({
      sha256: null,
      checksumPathVerified: false,
      files: [],
    });

    const withThumbs = (await mine(true)).find(({ id }) => id === plain.id)!;
    expect(withThumbs.files.map(({ type }) => type).toSorted()).toEqual(
      [AssetFileType.Sidecar, AssetFileType.Thumbnail].toSorted(),
    );

    // the cursor carries on after the last asset listed
    const [first] = listed.map(({ id }) => id).toSorted();
    const after = await sut.listAssets({
      afterId: first,
      limit: 10_000,
      includeThumbs: false,
      includeEncodedVideo: false,
    });
    expect(after.map(({ id }) => id)).not.toContain(first);
    await expect(sut.countAssets()).resolves.toBeGreaterThanOrEqual(3);
  });

  describe('FL-164', () => {
    it('keeps the dump of every kept manifest, lists the kept ones newest first, and never revives a pruned one', async () => {
      const { sut } = setup();
      const bucket = `https://s3.example.test/${randomUUID()}`;
      const manifest = async (key: string, databaseKey: string, status: 'complete' | 'failed' | null) => {
        const row = await sut.createManifest({ bucket, key, operationId: randomUUID() });
        await sut.setManifestDatabase(row.id, databaseKey);
        if (status) {
          await sut.finishManifest(row.id, { status, assetCount: 1, fileCount: 2, bytes: 30 });
        }
        return row;
      };
      await manifest('m/20260924T030000Z.json.gz', 'db/24.sql.gz', 'complete');
      await manifest('m/20260925T030000Z.json.gz', 'db/25.sql.gz', 'complete');
      await manifest('m/20260926T030000Z.json.gz', 'db/26.sql.gz', 'failed');
      await manifest('m/20260927T030000Z.json.gz', 'db/27.sql.gz', null);

      await expect(sut.getKeptDatabaseKeys(bucket)).resolves.toEqual(new Set(['db/24.sql.gz', 'db/25.sql.gz']));

      await expect(sut.markManifests(bucket, ['m/20260925T030000Z.json.gz'], 'degraded')).resolves.toBe(1);
      await expect(sut.markManifests(bucket, ['m/20260924T030000Z.json.gz'], 'pruned')).resolves.toBe(1);
      // a pruned manifest stays pruned, and a failed one is never kept
      await expect(
        sut.markManifests(bucket, ['m/20260924T030000Z.json.gz', 'm/20260926T030000Z.json.gz'], 'degraded'),
      ).resolves.toBe(0);

      const kept = await sut.listKeptManifests(bucket);
      expect(kept).toEqual([
        expect.objectContaining({
          key: 'm/20260925T030000Z.json.gz',
          status: 'degraded',
          databaseKey: 'db/25.sql.gz',
          assetCount: 1,
          fileCount: 2,
          bytes: 30,
        }),
      ]);
      await expect(sut.getKeptDatabaseKeys(bucket)).resolves.toEqual(new Set(['db/25.sql.gz']));
    });

    it('forgets objects of one bucket only', async () => {
      const { sut } = setup();
      const bucket = `https://s3.example.test/${randomUUID()}`;
      const other = `https://s3.example.test/${randomUUID()}`;
      for (const name of [bucket, other]) {
        await sut.record(name, [
          { sha256: sha('a'), size: 1, etag: null },
          { sha256: sha('b'), size: 1, etag: null },
        ]);
      }

      await sut.forget(bucket, [sha('a')]);

      await expect(sut.getExisting(bucket, [sha('a'), sha('b')])).resolves.toEqual(new Set([sha('b')]));
      await expect(sut.getExisting(other, [sha('a'), sha('b')])).resolves.toEqual(new Set([sha('a'), sha('b')]));
    });

    it('tells which assets the library still has, in the trash or not, and names their owners', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: active } = await ctx.newAsset({ ownerId: user.id });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: user.id,
        status: AssetStatus.Trashed,
        deletedAt: new Date(),
      });
      const { asset: deleted } = await ctx.newAsset({
        ownerId: user.id,
        status: AssetStatus.Deleted,
        deletedAt: new Date(),
      });

      const state = await sut.getLibraryState([active.id, trashed.id, deleted.id, randomUUID()]);

      expect(state.get(active.id)).toMatchObject({
        status: 'active',
        ownerId: user.id,
        isExternal: false,
        locked: false,
      });
      expect(state.get(trashed.id)).toMatchObject({ status: 'trashed' });
      expect(state.has(deleted.id)).toBe(false);
      expect(state.size).toBe(2);
      await expect(sut.getOwnerNames([user.id])).resolves.toEqual(new Map([[user.id, user.name]]));
    });

    it('reads each item’s record and details, its albums and the people its faces name (manifest v2)', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: friend } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        isFavorite: true,
        visibility: AssetVisibility.Archive,
        originalFileName: 'IMG_1.jpg',
      });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newExif({
        assetId: asset.id,
        description: 'Lake morning',
        rating: 4,
        dateTimeOriginal: new Date('2026-08-14T09:12:00.000Z'),
        latitude: 46.5,
        longitude: 7.9,
      });
      const { tag } = await ctx.newTag({ userId: user.id, value: 'Trips' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
      const { album } = await ctx.newAlbum(
        { ownerId: user.id, albumName: 'Lake house', albumThumbnailAssetId: second.id },
        [asset.id, second.id],
      );
      await ctx.newAlbumUser({ albumId: album.id, userId: friend.id, role: AlbumUserRole.Viewer });
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Jamie' });
      await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        boundingBoxX1: 1,
        boundingBoxY1: 2,
        boundingBoxX2: 30,
        boundingBoxY2: 40,
        imageWidth: 100,
        imageHeight: 80,
      });
      await ctx.newStack({ ownerId: user.id }, [asset.id, second.id]);
      await ctx.newEdits(asset.id, {
        edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 50, height: 40 } }],
      } as never);

      const details = await sut.getAssetDetails([asset.id, second.id, locked.id, randomUUID()]);

      expect(details.size).toBe(3);
      expect(details.get(asset.id)).toEqual({
        record: {
          type: asset.type,
          originalFileName: 'IMG_1.jpg',
          fileCreatedAt: expect.any(String),
          fileModifiedAt: expect.any(String),
          localDateTime: expect.any(String),
          duration: null,
        },
        details: {
          isFavorite: true,
          visibility: 'archive',
          rating: 4,
          description: 'Lake morning',
          dateTimeOriginal: '2026-08-14T09:12:00.000Z',
          timeZone: null,
          latitude: 46.5,
          longitude: 7.9,
          tags: ['Trips'],
          albums: [{ id: album.id, name: 'Lake house' }],
          faces: [
            { personId: person.personGroupId, box: [1, 2, 30, 40], imageWidth: 100, imageHeight: 80, isHidden: false },
          ],
          stack: { id: expect.any(String), isPrimary: true },
          edits: [{ action: 'crop', parameters: { x: 0, y: 0, width: 50, height: 40 } }],
        },
      });
      expect(details.get(second.id)?.details).toMatchObject({
        isFavorite: false,
        rating: null,
        description: '',
        tags: [],
        faces: [],
        stack: { isPrimary: false },
        edits: [],
      });
      expect(details.get(locked.id)?.details.visibility).toBe('locked');

      await expect(sut.getAlbumRecords([album.id, randomUUID()])).resolves.toEqual(
        new Map([
          [
            album.id,
            {
              name: 'Lake house',
              description: '',
              ownerId: user.id,
              coverAssetId: second.id,
              order: 'desc',
              sharedUsers: [{ userId: friend.id, role: 'viewer' }],
            },
          ],
        ]),
      );
      await expect(sut.getPersonRecords([{ ownerId: user.id, personId: person.personGroupId! }])).resolves.toEqual(
        new Map([
          [
            person.personGroupId,
            { ownerId: user.id, name: 'Jamie', birthDate: null, isHidden: false, isFavorite: false },
          ],
        ]),
      );
    });

    it('tells which items each album holds now, leaving out an album that is gone', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
      const { album: empty } = await ctx.newAlbum({ ownerId: user.id }, []);

      await expect(sut.getAlbumMembers([album.id, empty.id, randomUUID()])).resolves.toEqual(
        new Map([
          [album.id, new Set([asset.id])],
          [empty.id, new Set()],
        ]),
      );
    });
  });
});
