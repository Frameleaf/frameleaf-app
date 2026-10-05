import { Kysely, RawBuilder, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AlbumKind } from 'src/enum.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { releaseLockedCoverReferences } from 'src/utils/cover-references.js';
import {
  canonicalTestContext,
  seedCanonicalAlbum,
  seedCanonicalAsset,
  seedCanonicalUser,
} from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud source metadata reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let repository: ICloudMetadataRepository;
  let service: ICloudMetadataService;
  // the lock follow-up (FL-34) runs in AssetService on this event
  const events = { emit: vi.fn() };
  beforeAll(async () => {
    db = await getKyselyDB();

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
    await seedCanonicalUser(db, { id: ownerId });
    await sql`INSERT INTO public.icloud_connection(id,"ownerId",label,state) VALUES(${connectionId}::uuid,${ownerId}::uuid,'Photos','connected')`.execute(
      db,
    );
    await seedCanonicalAsset(db, {
      id: assetId,
      ownerId,
      originalPath: '/original/immutable',
      fileCreatedAt: new Date('2000-01-01T00:00:00Z'),
    });
    await sql`INSERT INTO asset_exif("assetId",description,latitude,longitude) VALUES(${assetId}::uuid,'local caption',51,-114)`.execute(
      db,
    );
    await sql`INSERT INTO asset_job_status("assetId","metadataExtractedAt") VALUES(${assetId}::uuid,now())`.execute(db);
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
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
      }>`SELECT source#>'{_sync,metadata}' metadata FROM public.icloud_resource WHERE id=${id}::uuid`,
    ).then(({ metadata }) => metadata);
  async function sourceUpdate(id: string, source: object) {
    await sql`UPDATE public.icloud_resource SET source=source || ${source}::jsonb WHERE id=${id}::uuid`.execute(db);
  }

  it.each([{ lockedProperties: null }, { lockedProperties: [] }])(
    'uses native unlocked EXIF updates without inventing caption/location/timezone (locks=$lockedProperties)',
    async ({ lockedProperties }) => {
      const ctx = await setup();
      // Both canonical representations mean unlocked; reconciliation must preserve the stored value.
      await db.updateTable('asset_exif').set({ lockedProperties }).where('assetId', '=', ctx.assetId).execute();
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
        lockedProperties,
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
    },
  );

  it('removes a photo it moves into the Locked folder as the cover of every album (FL-53)', async () => {
    const ctx = await setup();
    const otherAssetId = randomUUID();
    const [ownAlbumId, otherAlbumId] = [randomUUID(), randomUUID()];
    await seedCanonicalAsset(db, {
      id: otherAssetId,
      ownerId: ctx.ownerId,
      originalPath: '/original/immutable',
      fileCreatedAt: new Date('2000-01-01T00:00:00Z'),
    });
    await seedCanonicalAlbum(db, { id: ownAlbumId, ownerId: ctx.ownerId, albumThumbnailAssetId: ctx.assetId });
    await seedCanonicalAlbum(db, { id: otherAlbumId, ownerId: ctx.ownerId, albumThumbnailAssetId: ctx.assetId });
    await sql`INSERT INTO album_asset("albumId","assetId") VALUES(${ownAlbumId}::uuid,${ctx.assetId}::uuid),(${ownAlbumId}::uuid,${otherAssetId}::uuid),(${otherAlbumId}::uuid,${ctx.assetId}::uuid)`.execute(
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
    await seedCanonicalAsset(db, {
      id: otherAssetId,
      ownerId: ctx.ownerId,
      originalPath: '/original/immutable',
      fileCreatedAt: new Date('2000-01-01T00:00:00Z'),
    });

    await seedCanonicalAlbum(db, { id: spaceId, ownerId: ctx.ownerId, kind: AlbumKind.Space });
    const groupOwner = await db
      .selectFrom('user')
      .select('clusterGroupId')
      .where('id', '=', ctx.ownerId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('person_group')
      .values({ id: personGroupId, clusterGroupId: groupOwner.clusterGroupId })
      .execute();
    await sql`INSERT INTO album_asset("albumId","assetId") VALUES(${spaceId}::uuid,${ctx.assetId}::uuid),(${spaceId}::uuid,${otherAssetId}::uuid)`.execute(
      db,
    );
    await canonicalTestContext(db).newAssetFace({ id: lockedFaceId, assetId: ctx.assetId, personGroupId });
    await canonicalTestContext(db).newAssetFace({ id: otherFaceId, assetId: otherAssetId, personGroupId });
    await canonicalTestContext(db).newPerson({
      ownerId: ctx.ownerId,
      personGroupId,
      faceAssetId: lockedFaceId,
      thumbnailPath: '/thumbs/person.jpeg',
    });
    await sql`INSERT INTO shared_space_person(id,"albumId","personOwnerId","personGroupId","coverAssetId") VALUES(${linkId}::uuid,${spaceId}::uuid,${ctx.ownerId}::uuid,${personGroupId}::uuid,${ctx.assetId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO pet(id,"ownerId","featuredAssetId") VALUES(${petId}::uuid,${ctx.ownerId}::uuid,${ctx.assetId}::uuid)`.execute(
      db,
    );

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
    await seedCanonicalAsset(db, { id: siblingId, ownerId: ctx.ownerId });
    await seedCanonicalAsset(db, { id: otherAssetId, ownerId: ctx.ownerId });
    await canonicalTestContext(db).newStack({ id: stackId, ownerId: ctx.ownerId }, [ctx.assetId, siblingId]);
    await seedCanonicalAlbum(db, { id: albumId, ownerId: ctx.ownerId, albumThumbnailAssetId: siblingId });
    await sql`INSERT INTO album_asset("albumId","assetId") VALUES(${albumId}::uuid,${siblingId}::uuid),(${albumId}::uuid,${otherAssetId}::uuid)`.execute(
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
    await seedCanonicalAsset(db, {
      id: newerId,
      ownerId: ctx.ownerId,
      fileCreatedAt: new Date('2024-06-01T00:00:00Z'),
    });
    await seedCanonicalAsset(db, { id: bestId, ownerId: ctx.ownerId, fileCreatedAt: new Date('2020-01-01T00:00:00Z') });
    await seedCanonicalAsset(db, {
      id: rejectedId,
      ownerId: ctx.ownerId,
      fileCreatedAt: new Date('2025-01-01T00:00:00Z'),
    });

    await sql`INSERT INTO public.asset_best_photo_score("assetId","ownerId",score,"scoreVersion","computedAt") VALUES(${bestId}::uuid,${ctx.ownerId}::uuid,0.95,1,now())`.execute(
      db,
    );
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
    await sql`DELETE FROM public.asset_best_photo_score WHERE "assetId"=${bestId}::uuid`.execute(db);
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

  it('does not erase absent metadata, mutate motion companions, foreign owners', async () => {
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

    await sql`UPDATE public.icloud_resource SET role='motion' WHERE id=${ctx.resourceId}::uuid`.execute(db);
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
  });

  it('flags conflicting source logical identities sharing bytes instead of oscillating metadata', async () => {
    const ctx = await setup({ isFavorite: true });
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','logical-2','master','resOriginalRes','original','different','{"isFavorite":false}',3,'finalized',${ctx.assetId}::uuid)`.execute(
      db,
    );
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false });
    const result = await first(
      sql<{
        state: { status: string; reason: string };
      }>`SELECT source#>'{_sync,metadata}' state FROM public.icloud_resource WHERE "assetId"=${ctx.assetId}::uuid AND source#>'{_sync,metadata}' IS NOT NULL`,
    );
    expect(result.state).toMatchObject({ status: 'needs-review', reason: 'source_metadata_conflict' });
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
  });
  it('deduplicates conflict overrides across repeated extraction and reconciliation', async () => {
    const ctx = await setup({ isFavorite: true });
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
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
      }>`SELECT source#>'{_sync,metadata,overridden}' AS overridden FROM public.icloud_resource WHERE "assetId"=${ctx.assetId}::uuid AND source#>'{_sync,metadata}' IS NOT NULL`.execute(
        db,
      );
      expect(rows.rows[0].overridden).toEqual(['isFavorite']);
    }
  });
  it('continues one destination at a time and carries baselines across superseded resource versions', async () => {
    const ctx = await setup({ isFavorite: true });
    const second = randomUUID();
    await seedCanonicalAsset(db, {
      id: second,
      ownerId: ctx.ownerId,
      originalPath: '/original/immutable',
      fileCreatedAt: new Date('2000-01-01T00:00:00Z'),
    });
    await sql`INSERT INTO asset_job_status("assetId","metadataExtractedAt") VALUES(${second}::uuid,now())`.execute(db);
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(gen_random_uuid(),${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}','second','master-2','resOriginalRes','original','second','{"isFavorite":true}',3,'committed',${second}::uuid)`.execute(
      db,
    );
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(false);
    expect(await service.reconcile(ctx.connectionId, ctx.ownerId)).toBe(true);
    await sql`UPDATE public.icloud_resource SET source=source || '{"current":false}'::jsonb WHERE id=${ctx.resourceId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO public.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
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
