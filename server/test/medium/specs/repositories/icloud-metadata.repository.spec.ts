import { Kysely, RawBuilder, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudMetadataService } from 'src/services/icloud-metadata.service.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud source metadata reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let repository: ICloudMetadataRepository;
  let service: ICloudMetadataService;
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
    ]) {
      await sql.raw(statement).execute(db);
    }
    await migration.up(db);
    repository = new ICloudMetadataRepository(db);
    service = new ICloudMetadataService(repository);
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
      }>`SELECT "isFavorite",visibility,"fileCreatedAt" FROM asset WHERE id=${assetId}::uuid`,
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

  it('uses source baselines for favorite changes and preserves local edits and all privacy choices', async () => {
    const ctx = await setup();
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    await sourceUpdate(ctx.resourceId, { isFavorite: false, isHidden: false });
    await service.reconcile(ctx.connectionId, ctx.ownerId);
    expect(await target(ctx.assetId)).toMatchObject({ isFavorite: false, visibility: 'locked' });
    await sql`UPDATE asset SET "isFavorite"=true,visibility='archive' WHERE id=${ctx.assetId}::uuid`.execute(db);
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
