import { Kysely, RawBuilder, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudRelationsService } from 'src/services/icloud-relations.service.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud source-owned Stack and Live Photo reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let service: ICloudRelationsService;
  const emit = vi.fn().mockResolvedValue(undefined);
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
      `CREATE TABLE asset(id uuid PRIMARY KEY,"ownerId" uuid,type text,visibility text DEFAULT 'timeline',"stackId" uuid,"livePhotoVideoId" uuid,"deletedAt" timestamptz,"originalPath" text DEFAULT '/original/immutable')`,
      `CREATE TABLE stack(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"ownerId" uuid,"primaryAssetId" uuid UNIQUE REFERENCES asset)`,
      'ALTER TABLE asset ADD FOREIGN KEY("stackId") REFERENCES stack',
      `CREATE TABLE asset_lock("assetId" uuid PRIMARY KEY REFERENCES asset ON DELETE CASCADE,reason text NOT NULL,"lockedAt" timestamptz NOT NULL DEFAULT now(),"lockedBy" uuid,"previousVisibility" text)`,
      'CREATE TABLE album_asset("albumId" uuid,"assetId" uuid REFERENCES asset,PRIMARY KEY("albumId","assetId"))',
    ]) {
      await sql.raw(statement).execute(db);
    }
    await migration.up(db);
    service = new ICloudRelationsService(new ICloudRelationsRepository(db), { emit } as unknown as EventRepository);
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(() => {
    emit.mockClear();
  });
  const rows = <T>(query: RawBuilder<T>) => query.execute(db).then((result) => result.rows);
  const first = <T>(query: RawBuilder<T>) => rows(query).then((result) => result[0]);
  async function context() {
    const connectionId = randomUUID(),
      ownerId = randomUUID();
    await sql`INSERT INTO immich_fork.icloud_connection(id,"ownerId",label,state) VALUES(${connectionId}::uuid,${ownerId}::uuid,'Photos','connected')`.execute(
      db,
    );
    return { connectionId, ownerId };
  }
  async function asset(ownerId: string, type = 'IMAGE') {
    const id = randomUUID();
    await sql`INSERT INTO asset(id,"ownerId",type) VALUES(${id}::uuid,${ownerId}::uuid,${type})`.execute(db);
    return id;
  }
  async function resource(
    ctx: { connectionId: string; ownerId: string },
    role: string,
    assetId: string,
    logical = 'logical',
  ) {
    const id = randomUUID();
    await sql`INSERT INTO immich_fork.icloud_resource(id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(${id}::uuid,${ctx.connectionId}::uuid,${ctx.ownerId}::uuid,'private','{}',${logical},${logical},${role},${role},${id},${{ current: true }}::jsonb,3,'finalized',${assetId}::uuid)`.execute(
      db,
    );
    return id;
  }
  async function finish(ctx: { connectionId: string; ownerId: string }) {
    for (let count = 0; count < 10; count++) {
      if (await service.reconcile(ctx.connectionId, ctx.ownerId)) {
        return;
      }
    }
    throw new Error('unbounded relations');
  }
  async function setup() {
    const ctx = await context(),
      original = await asset(ctx.ownerId),
      edited = await asset(ctx.ownerId);
    const originalResource = await resource(ctx, 'original', original);
    const editResource = await resource(ctx, 'edited-image', edited);
    return { ...ctx, original, edited, originalResource, editResource };
  }

  it('serves the current source edit through a real Stack, retains original and old edits, and handles revert', async () => {
    const ctx = await setup();
    await finish(ctx);
    const created = await first(
      sql<{
        id: string;
        primaryAssetId: string;
      }>`SELECT id,"primaryAssetId" FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`,
    );
    expect(created.primaryAssetId).toBe(ctx.edited);
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid`)).toHaveLength(2);
    const newer = await asset(ctx.ownerId);
    await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${ctx.editResource}::uuid`.execute(
      db,
    );
    const newerResource = await resource(ctx, 'edited-image', newer);
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${created.id}::uuid`)).toEqual({
      primaryAssetId: newer,
    });
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid`)).toHaveLength(3);
    await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${newerResource}::uuid`.execute(
      db,
    );
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${created.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
    expect(
      await rows(
        sql`SELECT id FROM asset WHERE "stackId"=${created.id}::uuid AND "originalPath"='/original/immutable'`,
      ),
    ).toHaveLength(3);
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
  });
  it('preserves local primary preferences while adding a new source rendition', async () => {
    const ctx = await setup();
    await finish(ctx);
    const stack = await first(sql<{ id: string }>`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`);
    await sql`UPDATE stack SET "primaryAssetId"=${ctx.original}::uuid WHERE id=${stack.id}::uuid`.execute(db);
    await sql`UPDATE immich_fork.icloud_resource SET source=jsonb_set(source,'{current}','false') WHERE id=${ctx.editResource}::uuid`.execute(
      db,
    );
    const newer = await asset(ctx.ownerId);
    await resource(ctx, 'edited-image', newer);
    await finish(ctx);
    expect(await first(sql`SELECT "primaryAssetId" FROM stack WHERE id=${stack.id}::uuid`)).toEqual({
      primaryAssetId: ctx.original,
    });
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${stack.id}::uuid`)).toHaveLength(3);
  });
  it('keeps distinct logical source provenance when original bytes share one destination asset', async () => {
    const ctx = await setup();
    const secondEdit = await asset(ctx.ownerId);
    await resource(ctx, 'original', ctx.original, 'second-logical');
    await resource(ctx, 'edited-image', secondEdit, 'second-logical');
    await finish(ctx);
    const stack = await first(sql<{ id: string }>`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`);
    expect(await rows(sql`SELECT id FROM asset WHERE "stackId"=${stack.id}::uuid`)).toHaveLength(3);
    expect(
      await rows(
        sql`SELECT DISTINCT "sourceAssetId" FROM immich_fork.icloud_resource WHERE "connectionId"=${ctx.connectionId}::uuid`,
      ),
    ).toHaveLength(2);
    expect(
      await rows(
        sql`SELECT id FROM immich_fork.icloud_resource WHERE "connectionId"=${ctx.connectionId}::uuid AND source#>>'{_sync,relations,stackId}'=${stack.id}`,
      ),
    ).toHaveLength(2);
  });
  it('links still/movie by source identity using the existing hook without replacing either asset', async () => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      motion = await asset(ctx.ownerId, 'VIDEO');
    await resource(ctx, 'original', still);
    await resource(ctx, 'motion', motion);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: motion,
    });
    expect(await first(sql`SELECT visibility FROM asset WHERE id=${motion}::uuid`)).toEqual({ visibility: 'hidden' });
    expect(emit).toHaveBeenCalledWith('AssetHide', { assetId: motion, userId: ctx.ownerId });
    expect(await rows(sql`SELECT id FROM asset WHERE id=ANY(${[still, motion]}::uuid[])`)).toHaveLength(2);
    await finish(ctx);
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('preserves manual stacks and manual motion memberships and records review diagnostics', async () => {
    const ctx = await setup(),
      manual = await first(
        sql<{
          id: string;
        }>`INSERT INTO stack("ownerId","primaryAssetId") VALUES(${ctx.ownerId}::uuid,${ctx.original}::uuid) RETURNING id`,
      );
    await sql`UPDATE asset SET "stackId"=${manual.id}::uuid WHERE id=${ctx.original}::uuid`.execute(db);
    const motion = await asset(ctx.ownerId, 'VIDEO');
    await resource(ctx, 'motion', motion);
    await sql`INSERT INTO album_asset VALUES(${randomUUID()}::uuid,${motion}::uuid)`.execute(db);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${ctx.original}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "assetId"=${motion}::uuid`)).toHaveLength(1);
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,status}' AS status FROM immich_fork.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ status: 'needs-review' });
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    expect(await first(sql`SELECT "stackId" FROM asset WHERE id=${ctx.edited}::uuid`)).toEqual({ stackId: null });
  });
  it('survives event dispatch failure without duplicating a committed stack', async () => {
    const ctx = await setup();
    emit.mockRejectedValueOnce(new Error('event temporarily unavailable'));
    await expect(service.reconcile(ctx.connectionId, ctx.ownerId)).rejects.toThrow('event temporarily unavailable');
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    await finish(ctx);
    expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    expect(
      await first(
        sql`SELECT source#>'{_sync,relations,events}' AS events FROM immich_fork.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
      ),
    ).toEqual({ events: [] });
  });
  it('rejects foreign targets and will not match a movie from another logical source', async () => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      foreign = await asset(randomUUID(), 'VIDEO');
    const originalResource = await resource(ctx, 'original', still);
    await resource(ctx, 'motion', foreign);
    await finish(ctx);
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM immich_fork.icloud_resource WHERE id=${originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'resource_owner_or_trash_changed' });
    await expect(service.reconcile(ctx.connectionId, randomUUID())).rejects.toThrow('icloud_connection_not_found');
  });
  it.each(['failed', 'unsupported', 'needs-review', 'preserve-trashed', 'pending', 'retry'])(
    'does not let a %s rendition starve other families',
    async (status) => {
      const ctx = await setup();
      await sql`UPDATE immich_fork.icloud_resource SET status=${status},"assetId"=NULL WHERE id=${ctx.editResource}::uuid`.execute(
        db,
      );
      const otherOriginal = await asset(ctx.ownerId),
        otherEdit = await asset(ctx.ownerId);
      await resource(ctx, 'original', otherOriginal, 'other');
      await resource(ctx, 'edited-image', otherEdit, 'other');
      await finish(ctx);
      const terminal = !['pending', 'retry'].includes(status);
      expect(
        await first(
          sql`SELECT source#>>'{_sync,relations,status}' AS status FROM immich_fork.icloud_resource WHERE id=${ctx.originalResource}::uuid`,
        ),
      ).toEqual({ status: terminal ? 'needs-review' : 'pending' });
      expect(await rows(sql`SELECT id FROM stack WHERE "ownerId"=${ctx.ownerId}::uuid`)).toHaveLength(1);
    },
  );
  it.each(['locked', 'archive'])('preserves existing %s motion visibility', async (visibility) => {
    const ctx = await context(),
      still = await asset(ctx.ownerId),
      motion = await asset(ctx.ownerId, 'VIDEO');
    const originalResource = await resource(ctx, 'original', still);
    await resource(ctx, 'motion', motion);
    await sql`UPDATE asset SET visibility=${visibility} WHERE id=${motion}::uuid`.execute(db);
    await finish(ctx);
    expect(await first(sql`SELECT visibility FROM asset WHERE id=${motion}::uuid`)).toEqual({ visibility });
    expect(await first(sql`SELECT "livePhotoVideoId" FROM asset WHERE id=${still}::uuid`)).toEqual({
      livePhotoVideoId: null,
    });
    expect(
      await first(
        sql`SELECT source#>>'{_sync,relations,reason}' AS reason FROM immich_fork.icloud_resource WHERE id=${originalResource}::uuid`,
      ),
    ).toEqual({ reason: 'motion_visibility_override' });
    expect(emit).not.toHaveBeenCalled();
  });
});
