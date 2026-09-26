import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetFileType, AssetStatus, AssetVisibility } from 'src/enum.js';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import * as cloudBackupMigration from 'src/schema/migrations/2100000000670-AddCloudBackupTables.js';
import { BaseService } from 'src/services/base.service.js';
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

const isBackupTable = (entry: { identity: string }) =>
  ['cloud_backup_object', 'cloud_backup_manifest', 'cloud_backup_manifest_entry'].some(
    (table) => entry.identity === `public.${table}` || entry.identity.startsWith(`public.${table}.`),
  );

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(CloudBackupIndexRepository.name, () => {
  it('matches the catalog, and the migration rolls back and applies again', async () => {
    const evidence = async () => {
      const catalog = await getCatalogEvidence(defaultDatabase);
      return {
        tables: catalog.tables.filter((entry) => isBackupTable(entry)),
        columns: catalog.columns.filter((entry) => isBackupTable(entry)),
        constraints: catalog.constraints.filter((entry) => isBackupTable(entry)),
        indexes: catalog.indexes.filter((entry) => isBackupTable(entry)),
      };
    };
    const expected = {
      tables: manifest.tables.filter((entry) => isBackupTable(entry)),
      columns: manifest.columns.filter((entry) => isBackupTable(entry)),
      constraints: manifest.constraints.filter((entry) => isBackupTable(entry)),
      indexes: manifest.indexes.filter((entry) => isBackupTable(entry)),
    };
    expect(expected.tables).toHaveLength(3);
    expect(await evidence()).toEqual(expected);

    await cloudBackupMigration.down(defaultDatabase);
    expect((await evidence()).tables).toEqual([]);
    await cloudBackupMigration.up(defaultDatabase);
    expect(await evidence()).toEqual(expected);
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

  it('names the dump of the newest complete manifest', async () => {
    const { sut } = setup();
    const bucket = `https://s3.example.test/${randomUUID()}`;
    await expect(sut.getLatestManifestDatabaseKey(bucket)).resolves.toBeNull();

    const older = await sut.createManifest({ bucket, key: 'm/1.json.gz', operationId: randomUUID() });
    await sut.setManifestDatabase(older.id, 'db/one.sql.gz');
    await sut.finishManifest(older.id, { status: 'complete' });
    const newer = await sut.createManifest({ bucket, key: 'm/2.json.gz', operationId: randomUUID() });
    await sut.setManifestDatabase(newer.id, 'db/two.sql.gz');
    await sut.finishManifest(newer.id, { status: 'complete' });
    const running = await sut.createManifest({ bucket, key: 'm/3.json.gz', operationId: randomUUID() });
    await sut.setManifestDatabase(running.id, 'db/three.sql.gz');

    await expect(sut.getLatestManifestDatabaseKey(bucket)).resolves.toBe('db/two.sql.gz');
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
    await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount")
      VALUES (${plain.id}::uuid, ${Buffer.alloc(20, 1)}, ${Buffer.from(sha('plain'), 'hex')}, 100, ${[plain.originalPath]}, 1)`.execute(
      defaultDatabase,
    );
    // verified at another path (the file moved since): the checksum is not vouched for at this one
    await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount")
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
});
