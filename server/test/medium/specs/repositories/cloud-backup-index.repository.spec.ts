import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AlbumUserRole, AssetFileType, AssetStatus, AssetVisibility } from 'src/enum.js';
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
