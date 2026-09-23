import { Kysely, RawBuilder, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud source metadata reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let repository: ICloudMetadataRepository;
  let service: ICloudMetadataService;
  // the lock follow-up (FL-34) runs in AssetService on this event
  const events = { emit: vi.fn() };
  beforeAll(async () => {
    db = await getKyselyDB();
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    for (const statement of [
      'CREATE SCHEMA public',
      'CREATE SCHEMA immich_fork',
      'CREATE TABLE migration_overrides(name text)',
      'CREATE TABLE immich_fork.state(id integer PRIMARY KEY,phase text)',
      "INSERT INTO immich_fork.state VALUES(1,'active')",
      'CREATE TABLE immich_fork.migration_audit(name text,status text)',
      `CREATE TABLE asset(id uuid PRIMARY KEY,"ownerId" uuid,"isFavorite" boolean DEFAULT false,visibility text DEFAULT 'timeline',"fileCreatedAt" timestamptz DEFAULT '2000-01-01Z',"localDateTime" timestamptz DEFAULT '2000-01-01Z',"deletedAt" timestamptz)`,
      `CREATE TABLE asset_exif("assetId" uuid PRIMARY KEY REFERENCES asset,"dateTimeOriginal" timestamptz,"timeZone" text,"lockedProperties" text[] DEFAULT '{}',description text DEFAULT '',latitude double precision,longitude double precision)`,
      'CREATE TABLE asset_job_status("assetId" uuid PRIMARY KEY REFERENCES asset,"metadataExtractedAt" timestamptz)',
      'CREATE TABLE album(id uuid PRIMARY KEY,"albumThumbnailAssetId" uuid REFERENCES asset)',
      'CREATE TABLE album_asset("albumId" uuid REFERENCES album,"assetId" uuid REFERENCES asset,PRIMARY KEY("albumId","assetId"))',
      // the other covers a Locked photo releases (FL-53), and what choosing their replacements reads
      'ALTER TABLE asset ADD COLUMN is_nsfw boolean NOT NULL DEFAULT false',
      'CREATE TABLE immich_fork.asset_privacy("assetId" uuid PRIMARY KEY,"isNsfw" boolean NOT NULL)',
      `CREATE TABLE asset_face(id uuid PRIMARY KEY,"assetId" uuid REFERENCES asset,"personGroupId" uuid,"deletedAt" timestamptz,"isVisible" boolean DEFAULT true)`,
      `CREATE TABLE person("ownerId" uuid,"personGroupId" uuid,"faceAssetId" uuid REFERENCES asset_face,"thumbnailPath" text DEFAULT '',PRIMARY KEY("ownerId","personGroupId"))`,
      'CREATE TABLE shared_space_person(id uuid PRIMARY KEY,"albumId" uuid REFERENCES album,"personGroupId" uuid,"coverAssetId" uuid REFERENCES asset)',
      'CREATE TABLE pet(id uuid PRIMARY KEY,"featuredAssetId" uuid REFERENCES asset,"updatedAt" timestamptz)',
      // whole stacks move into the Locked folder, and what choosing a replacement reads besides (FL-53)
      'ALTER TABLE asset ADD COLUMN "stackId" uuid',
      `ALTER TABLE album ADD COLUMN kind text NOT NULL DEFAULT 'album'`,
      'CREATE TABLE album_user("albumId" uuid REFERENCES album,"userId" uuid,role text)',
      'CREATE TABLE shared_space_album("albumId" uuid REFERENCES album,"linkedAlbumId" uuid REFERENCES album)',
      'CREATE TABLE shared_link(id uuid PRIMARY KEY,"albumId" uuid REFERENCES album)',
      'CREATE TABLE immich_fork.asset_best_photo_score("assetId" uuid PRIMARY KEY REFERENCES asset,score double precision)',
      'ALTER TABLE pet ADD COLUMN "ownerId" uuid',
      `CREATE TABLE pet_observation(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"petId" uuid REFERENCES pet,"assetId" uuid REFERENCES asset,state text NOT NULL DEFAULT 'confirmed')`,
      // Locked is a lock record (FL-34); locking touches the asset and takes live-photo parts along
      `CREATE TABLE asset_lock("assetId" uuid PRIMARY KEY REFERENCES asset ON DELETE CASCADE,reason text NOT NULL,"lockedAt" timestamptz NOT NULL DEFAULT now(),"lockedBy" uuid,"previousVisibility" text)`,
      'ALTER TABLE asset ADD COLUMN "livePhotoVideoId" uuid',
      'ALTER TABLE asset ADD COLUMN "updatedAt" timestamptz',
    ]) {
      await sql.raw(statement).execute(db);
    }
    await migration.up(db);
    repository = new ICloudMetadataRepository(db);
    service = new ICloudMetadataService(repository, events as never);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  const first = <T>(query: RawBuilder<T>) => query.execute(db).then(({ rows }) => rows[0]);
  async function setup(source?: Record<string, unknown>) {
    source ??= { isFavorite: true, isHidden: true, fileCreatedAt: '2020-03-04T12:34:56.000Z' };
    const connectionId = randomUUID(),
      ownerId = randomUUID(),
      assetId = randomUUID(),
      resourceId = randomUUID();
    await sql`INSERT INTO immich_fork.icloud_connection(id,"ownerId",label,state) VALUES(${connectionId}::uuid,${ownerId}::uuid,'Photos','connected')`.execute(
      db,
    );
    await sql`INSERT INTO asset(id,"ownerId") VALUES(${assetId}::uuid,${ownerId}::uuid)`.execute(db);
    await sql`INSERT INTO asset_exif("assetId",description,latitude,longitude) VALUES(${assetId}::uuid,'local caption',51,-114)`.execute(
      db,
    );
    await sql`INSERT INTO asset_job_status VALUES(${assetId}::uuid,now())`.execute(db);
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(${resourceId}::uuid,${connectionId}::uuid,${ownerId}::uuid,'private','{}','logical','master','resOriginalRes','original',${resourceId},${source}::jsonb,3,'finalized',${assetId}::uuid)`.execute(
      db,
    );
    return { connectionId, ownerId, assetId, resourceId };
  }
  const target = (assetId: string) =>
    first(
      sql<{
        isFavorite: boolean;
        visibility: string;
        fileCreatedAt: Date;
      }>`SELECT "isFavorite",
        CASE WHEN EXISTS (SELECT 1 FROM asset_lock l WHERE l."assetId"=asset.id) THEN 'locked' ELSE visibility END AS visibility,
        "fileCreatedAt" FROM asset WHERE id=${assetId}::uuid`,
    );
  const baseline = (id: string) =>
    first(
      sql<{
        metadata: { source: object; applied: object; overridden: string[]; status: string; reason?: string };
      }>`SELECT source#>'{_sync,metadata}' metadata FROM immich_fork.icloud_resource WHERE id=${id}::uuid`,
    ).then(({ metadata }) => metadata);
  async function sourceUpdate(id: string, source: object) {
    await sql`UPDATE immich_fork.icloud_resource SET source=source || ${source}::jsonb WHERE id=${id}::uuid`.execute(
      db,
    );
  }

  it('uses native unlocked EXIF updates after extraction and does not invent caption/location/timezone', async () => {
    const ctx = await setup();
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
    expect(await target(ctx.assetId)).toEqual({
      isFavorite: true,
      visibility: 'locked',
      fileCreatedAt: new Date('2020-03-04T12:34:56Z'),
    });
    // the lock's follow-up (new face thumbnails, replaced profile pictures) runs once it commits (FL-34)
    expect(events.emit).toHaveBeenCalledWith('AssetLockAll', { assetIds: [ctx.assetId], userId: ctx.ownerId });
    expect(
      await first(
        sql`SELECT "dateTimeOriginal","lockedProperties",description,latitude,longitude,"timeZone" FROM asset_exif WHERE "assetId"=${ctx.assetId}::uuid`,
      ),
    ).toEqual({
      dateTimeOriginal: new Date('2020-03-04T12:34:56Z'),
      lockedProperties: [],
      description: 'local caption',
      latitude: 51,
      longitude: -114,
      timeZone: null,
    });
    expect(await baseline(ctx.resourceId)).toMatchObject({
      status: 'applied',
      applied: { isFavorite: true, visibility: 'locked', fileCreatedAt: '2020-03-04T12:34:56.000Z' },
    });
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
  });

  it('removes a photo it moves into the Locked folder as the cover of every album (FL-53)', async () => {
    const ctx = await setup();
    const otherAssetId = randomUUID();
    const [ownAlbumId, otherAlbumId] = [randomUUID(), randomUUID()];
    await sql`INSERT INTO asset(id,"ownerId") VALUES(${otherAssetId}::uuid,${ctx.ownerId}::uuid)`.execute(db);
    await sql`INSERT INTO album VALUES(${ownAlbumId}::uuid,${ctx.assetId}::uuid),(${otherAlbumId}::uuid,${ctx.assetId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO album_asset VALUES(${ownAlbumId}::uuid,${ctx.assetId}::uuid),(${ownAlbumId}::uuid,${otherAssetId}::uuid),(${otherAlbumId}::uuid,${ctx.assetId}::uuid)`.execute(
      db,
    );

    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);

    expect(await target(ctx.assetId)).toMatchObject({ visibility: 'locked' });
    const covers = await sql<{ id: string; albumThumbnailAssetId: string | null }>`
      SELECT id,"albumThumbnailAssetId" FROM album WHERE id IN (${ownAlbumId}::uuid,${otherAlbumId}::uuid)`.execute(db);
    expect(Object.fromEntries(covers.rows.map((row) => [row.id, row.albumThumbnailAssetId]))).toEqual({
      [ownAlbumId]: otherAssetId,
      [otherAlbumId]: null,
    });
  });

  it('releases every other cover, featured photo and face thumbnail the photo it locks was (FL-53)', async () => {
    const ctx = await setup();
    const otherAssetId = randomUUID();
    const [spaceId, personGroupId, lockedFaceId, otherFaceId, linkId, petId] = Array.from({ length: 6 }, () =>
      randomUUID(),
    );
    await sql`INSERT INTO asset(id,"ownerId") VALUES(${otherAssetId}::uuid,${ctx.ownerId}::uuid)`.execute(db);
    // the fork phase is active, so an asset counts as not sensitive only with a privacy row saying so
    await sql`INSERT INTO immich_fork.asset_privacy VALUES(${ctx.assetId}::uuid,false),(${otherAssetId}::uuid,false)`.execute(
      db,
    );
    await sql`INSERT INTO album VALUES(${spaceId}::uuid,NULL)`.execute(db);
    await sql`INSERT INTO album_asset VALUES(${spaceId}::uuid,${ctx.assetId}::uuid),(${spaceId}::uuid,${otherAssetId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO asset_face(id,"assetId","personGroupId") VALUES(${lockedFaceId}::uuid,${ctx.assetId}::uuid,${personGroupId}::uuid),(${otherFaceId}::uuid,${otherAssetId}::uuid,${personGroupId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO person VALUES(${ctx.ownerId}::uuid,${personGroupId}::uuid,${lockedFaceId}::uuid,'/thumbs/person.jpeg')`.execute(
      db,
    );
    await sql`INSERT INTO shared_space_person VALUES(${linkId}::uuid,${spaceId}::uuid,${personGroupId}::uuid,${ctx.assetId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO pet VALUES(${petId}::uuid,${ctx.assetId}::uuid,now())`.execute(db);

    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);

    expect(await target(ctx.assetId)).toMatchObject({ visibility: 'locked' });
    expect(
      await first(sql`SELECT "faceAssetId","thumbnailPath" FROM person WHERE "personGroupId"=${personGroupId}::uuid`),
    ).toEqual({ faceAssetId: otherFaceId, thumbnailPath: '' });
    expect(await first(sql`SELECT "coverAssetId" FROM shared_space_person WHERE id=${linkId}::uuid`)).toEqual({
      coverAssetId: otherAssetId,
    });
    expect(await first(sql`SELECT "featuredAssetId" FROM pet WHERE id=${petId}::uuid`)).toEqual({
      featuredAssetId: null,
    });
  });

  it('locks the rest of the stack of a photo it locks and releases their covers too (FL-53)', async () => {
    const ctx = await setup();
    const [siblingId, otherAssetId, stackId, albumId] = Array.from({ length: 4 }, () => randomUUID());
    await sql`INSERT INTO asset(id,"ownerId","stackId") VALUES(${siblingId}::uuid,${ctx.ownerId}::uuid,${stackId}::uuid),(${otherAssetId}::uuid,${ctx.ownerId}::uuid,NULL)`.execute(
      db,
    );
    await sql`UPDATE asset SET "stackId"=${stackId}::uuid WHERE id=${ctx.assetId}::uuid`.execute(db);
    await sql`INSERT INTO album VALUES(${albumId}::uuid,${siblingId}::uuid)`.execute(db);
    await sql`INSERT INTO album_asset VALUES(${albumId}::uuid,${siblingId}::uuid),(${albumId}::uuid,${otherAssetId}::uuid)`.execute(
      db,
    );

    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);

    expect(await target(ctx.assetId)).toMatchObject({ visibility: 'locked' });
    expect(await target(siblingId)).toMatchObject({ visibility: 'locked' });
    expect(await target(otherAssetId)).toMatchObject({ visibility: 'timeline' });
    expect(await first(sql`SELECT "albumThumbnailAssetId" FROM album WHERE id=${albumId}::uuid`)).toEqual({
      albumThumbnailAssetId: otherAssetId,
    });
  });

  it('gives a pet the photo of another confirmed observation, a Best Photo first (FL-53)', async () => {
    const ctx = await setup();
    const [newerId, bestId, rejectedId, petId] = Array.from({ length: 4 }, () => randomUUID());
    await sql`INSERT INTO asset(id,"ownerId","fileCreatedAt") VALUES
      (${newerId}::uuid,${ctx.ownerId}::uuid,'2024-06-01Z'),
      (${bestId}::uuid,${ctx.ownerId}::uuid,'2020-01-01Z'),
      (${rejectedId}::uuid,${ctx.ownerId}::uuid,'2025-01-01Z')`.execute(db);
    // active phase: a photo counts as not sensitive only with a privacy row saying so
    await sql`INSERT INTO immich_fork.asset_privacy VALUES(${newerId}::uuid,false),(${bestId}::uuid,false),(${rejectedId}::uuid,false)`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.asset_best_photo_score VALUES(${bestId}::uuid,0.95)`.execute(db);
    await sql`INSERT INTO pet(id,"featuredAssetId","updatedAt","ownerId") VALUES(${petId}::uuid,${ctx.assetId}::uuid,now(),${ctx.ownerId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO pet_observation("petId","assetId",state) VALUES
      (${petId}::uuid,${ctx.assetId}::uuid,'confirmed'),
      (${petId}::uuid,${newerId}::uuid,'confirmed'),
      (${petId}::uuid,${bestId}::uuid,'confirmed'),
      (${petId}::uuid,${rejectedId}::uuid,'rejected')`.execute(db);

    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);

    expect(await first(sql`SELECT "featuredAssetId" FROM pet WHERE id=${petId}::uuid`)).toEqual({
      featuredAssetId: bestId,
    });

    // without a Best Photo, the newest confirmed photo
    await sql`DELETE FROM immich_fork.asset_best_photo_score WHERE "assetId"=${bestId}::uuid`.execute(db);
    await sql`UPDATE pet SET "featuredAssetId"=${ctx.assetId}::uuid WHERE id=${petId}::uuid`.execute(db);
    await releaseLockedCoverReferences(db, [ctx.assetId]);
    expect(await first(sql`SELECT "featuredAssetId" FROM pet WHERE id=${petId}::uuid`)).toEqual({
      featuredAssetId: newerId,
    });
  });

  it('uses source baselines for favorite changes and preserves local edits and all privacy choices', async () => {
    const ctx = await setup();
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    await sourceUpdate(ctx.resourceId, { isFavorite: false, isHidden: false });
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false, visibility: 'locked' });
    // the owner unlocked it into the archive (FL-34: the lock record goes, the visibility is stored)
    await sql`UPDATE asset SET "isFavorite"=true,visibility='archive' WHERE id=${ctx.assetId}::uuid`.execute(db);
    await sql`DELETE FROM asset_lock WHERE "assetId"=${ctx.assetId}::uuid`.execute(db);
    await sourceUpdate(ctx.resourceId, { isHidden: true });
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: true, visibility: 'archive' });
    expect(await baseline(ctx.resourceId)).toMatchObject({ overridden: expect.arrayContaining(['isFavorite']) });
  });

  it('preserves native date locks and local timezone, and preserves initial existing favorites', async () => {
    const ctx = await setup({ isFavorite: false, isHidden: false, fileCreatedAt: '2020-03-04T12:34:56.000Z' });
    await sql`UPDATE asset SET "isFavorite"=true,visibility='hidden' WHERE id=${ctx.assetId}::uuid`.execute(db);
    await sql`UPDATE asset_exif SET "lockedProperties"=ARRAY['dateTimeOriginal','description'],"timeZone"='America/Edmonton',"dateTimeOriginal"='2000-01-01Z' WHERE "assetId"=${ctx.assetId}::uuid`.execute(
      db,
    );
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toEqual({
      isFavorite: true,
      visibility: 'hidden',
      fileCreatedAt: new Date('2000-01-01Z'),
    });
    expect(await baseline(ctx.resourceId)).toMatchObject({ overridden: ['isFavorite', 'fileCreatedAt'] });
    expect(
      await first(sql`SELECT "lockedProperties","timeZone" FROM asset_exif WHERE "assetId"=${ctx.assetId}::uuid`),
    ).toEqual({ lockedProperties: ['dateTimeOriginal', 'description'], timeZone: 'America/Edmonton' });
  });

  it('reapplies source date after extraction and defers initial reconciliation until extraction finishes', async () => {
    const ctx = await setup();
    await sql`UPDATE asset_job_status SET "metadataExtractedAt"=NULL WHERE "assetId"=${ctx.assetId}::uuid`.execute(db);
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    await sql`UPDATE asset_job_status SET "metadataExtractedAt"=now() WHERE "assetId"=${ctx.assetId}::uuid`.execute(db);
    await service.onAssetMetadataExtracted({ assetId: ctx.assetId, userId: ctx.ownerId });
    await sql`UPDATE asset SET "fileCreatedAt"='2001-01-01Z' WHERE id=${ctx.assetId}::uuid`.execute(db);
    await sql`UPDATE asset_job_status SET "metadataExtractedAt"=now() + interval '1 second' WHERE "assetId"=${ctx.assetId}::uuid`.execute(
      db,
    );
    await service.onAssetMetadataExtracted({ assetId: ctx.assetId, userId: ctx.ownerId });
    expect(await target(ctx.assetId)).toMatchObject({ fileCreatedAt: new Date('2020-03-04T12:34:56Z') });
  });

  it('does not erase absent metadata, mutate motion companions, foreign owners, inactive phases, or handoffs', async () => {
    const ctx = await setup({});
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toEqual({
      isFavorite: false,
      visibility: 'timeline',
      fileCreatedAt: new Date('2000-01-01Z'),
    });
    await sourceUpdate(ctx.resourceId, { isFavorite: true });
    await service.reconcile(ctx.connectionId, randomUUID());
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    await sql`UPDATE immich_fork.state SET phase='inactive'`.execute(db);
    await service.onAssetMetadataExtracted({ assetId: ctx.assetId, userId: ctx.ownerId });
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    await sql`UPDATE immich_fork.state SET phase='active'`.execute(db);
    await sql`INSERT INTO immich_fork.migration_audit VALUES('official-handoff-preparation','running')`.execute(db);
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    await sql`DELETE FROM immich_fork.migration_audit`.execute(db);
    await sql`UPDATE immich_fork.icloud_resource SET role='motion' WHERE id=${ctx.resourceId}::uuid`.execute(db);
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
  });

  it('flags conflicting source logical identities sharing bytes instead of oscillating metadata', async () => {
    const ctx = await setup({ isFavorite: true });
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','logical-2','master','resOriginalRes','original','different','{"isFavorite":false}',3,'finalized',${ctx.assetId}::uuid)`.execute(
      db,
    );
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    const result = await first(
      sql<{
        state: { status: string; reason: string };
      }>`SELECT source#>'{_sync,metadata}' state FROM immich_fork.icloud_resource WHERE "assetId"=${ctx.assetId}::uuid AND source#>'{_sync,metadata}' IS NOT NULL`,
    );
    expect(result.state).toMatchObject({ status: 'needs-review', reason: 'source_metadata_conflict' });
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
  });
  it('deduplicates conflict overrides across repeated extraction and reconciliation', async () => {
    const ctx = await setup({ isFavorite: true });
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','logical-2','master','resOriginalRes','original','different','{"isFavorite":false}',3,'finalized',${ctx.assetId}::uuid)`.execute(
      db,
    );
    for (let index = 0; index < 4; index++) {
      await sql`UPDATE asset_job_status SET "metadataExtractedAt"=now()+${index}*interval '1 second' WHERE "assetId"=${ctx.assetId}::uuid`.execute(
        db,
      );
      await service.reconcile(ctx.connectionId, ctx.ownerId);
      const rows = await sql<{
        overridden: string[];
      }>`SELECT source#>'{_sync,metadata,overridden}' AS overridden FROM immich_fork.icloud_resource WHERE "assetId"=${ctx.assetId}::uuid AND source#>'{_sync,metadata}' IS NOT NULL`.execute(
        db,
      );
      expect(rows.rows[0].overridden).toEqual(['isFavorite']);
    }
  });
  it('continues one destination at a time and carries baselines across superseded resource versions', async () => {
    const ctx = await setup({ isFavorite: true });
    const second = randomUUID();
    await sql`INSERT INTO asset(id,"ownerId") VALUES(${second}::uuid,${ctx.ownerId}::uuid)`.execute(db);
    await sql`INSERT INTO asset_job_status VALUES(${second}::uuid,now())`.execute(db);
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','second','master-2','resOriginalRes','original','second','{"isFavorite":true}',3,'committed',${second}::uuid)`.execute(
      db,
    );
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(false);
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
    await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":false}'::jsonb WHERE id=${ctx.resourceId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','logical','master','resOriginalRes','original','new-version','{"isFavorite":false,"current":true}',3,'finalized',${ctx.assetId}::uuid)`.execute(
      db,
    );
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    expect(await target(second)).toMatchObject({ isFavorite: true });
  });

  it('preserves timezone interpretation while changing an unlocked capture instant', async () => {
    const ctx = await setup({ fileCreatedAt: '2020-03-04T12:34:56.000Z' });
    await sql`UPDATE asset_exif SET "timeZone"='America/Edmonton',"lockedProperties"=ARRAY['timeZone'] WHERE "assetId"=${ctx.assetId}::uuid`.execute(
      db,
    );
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await first(sql`SELECT "localDateTime" FROM asset WHERE id=${ctx.assetId}::uuid`)).toEqual({
      localDateTime: new Date('2020-03-04T05:34:56Z'),
    });
    expect(
      await first(sql`SELECT "timeZone","lockedProperties" FROM asset_exif WHERE "assetId"=${ctx.assetId}::uuid`),
    ).toEqual({ timeZone: 'America/Edmonton', lockedProperties: ['timeZone'] });
  });
});
