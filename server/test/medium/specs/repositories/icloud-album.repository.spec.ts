import { Kysely, RawBuilder, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import * as migration from 'src/fork-schema/migrations/0000000000090-ICloudSync.js';
import { ICloudAlbumRepository, mergeICloudAlbum } from 'src/repositories/icloud-album.repository.js';
import { DB } from 'src/schema/index.js';
import { ICloudAlbumService } from 'src/services/icloud-album.service.js';
import { getKyselyDB } from 'test/utils.js';

describe('iCloud album owner and provenance reconciliation (PostgreSQL)', () => {
  let db: Kysely<DB>;
  let service: ICloudAlbumService;
  beforeAll(async () => {
    db = await getKyselyDB();
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`DROP SCHEMA IF EXISTS immich_fork CASCADE`.execute(db);
    for (const statement of [
      'CREATE SCHEMA public',
      'CREATE SCHEMA immich_fork',
      'CREATE TABLE public.migration_overrides (name text)',
      'CREATE TABLE immich_fork.state (id integer PRIMARY KEY, phase text)',
      "INSERT INTO immich_fork.state VALUES (1,'dual-write')",
      'CREATE TABLE immich_fork.migration_audit(name text,status text)',
      `CREATE TABLE album (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"albumName" text,"parentId" uuid REFERENCES album,
        icon text,"sortOrder" double precision,"deletedAt" timestamptz,kind text NOT NULL DEFAULT 'album')`,
      'CREATE TABLE album_user ("albumId" uuid REFERENCES album,"userId" uuid,role text, PRIMARY KEY("albumId","userId"))',
      'CREATE TABLE album_closure (id_ancestor uuid REFERENCES album,id_descendant uuid REFERENCES album,PRIMARY KEY(id_ancestor,id_descendant))',
      `CREATE TABLE immich_fork.album_metadata ("albumId" uuid PRIMARY KEY,"parentId" uuid,icon text,"sortOrder" double precision,"updatedAt" timestamptz,kind text NOT NULL DEFAULT 'album')`,
      'CREATE TABLE immich_fork.album_closure ("ancestorId" uuid,"descendantId" uuid,PRIMARY KEY("ancestorId","descendantId"))',
      'CREATE TABLE asset (id uuid PRIMARY KEY,"ownerId" uuid,"deletedAt" timestamptz)',
      'CREATE TABLE album_asset ("albumId" uuid REFERENCES album,"assetId" uuid REFERENCES asset,PRIMARY KEY("albumId","assetId"))',
      `CREATE FUNCTION album_parent_cycle_check() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."parentId"=NEW.id OR EXISTS(SELECT 1 FROM album_closure WHERE id_ancestor=NEW.id AND id_descendant=NEW."parentId" AND id_ancestor<>id_descendant)
        THEN RAISE EXCEPTION 'album cycle'; END IF; RETURN NEW; END $$`,
      'CREATE TRIGGER album_parent_cycle_check_trigger BEFORE INSERT OR UPDATE ON album FOR EACH ROW EXECUTE FUNCTION album_parent_cycle_check()',
    ]) {
      await sql.raw(statement).execute(db);
    }
    await migration.up(db);
    service = new ICloudAlbumService(new ICloudAlbumRepository(db));
  });
  afterAll(async () => {
    await db?.destroy();
  });
  beforeEach(async () => {
    await sql`UPDATE immich_fork.state SET phase='dual-write'`.execute(db);
  });

  async function arrange() {
    const connectionId = randomUUID(),
      ownerId = randomUUID();
    await sql`INSERT INTO immich_fork.icloud_connection(id,"ownerId",label,state,config)
      VALUES(${connectionId}::uuid,${ownerId}::uuid,'Family','connected',${ICloudConfigSchema.parse({})}::jsonb)`.execute(
      db,
    );
    return { connectionId, ownerId };
  }
  async function source(connectionId: string, sourceId: string, parentSourceId: string | null = null, folder = false) {
    await sql`INSERT INTO immich_fork.icloud_album("connectionId","libraryKey","sourceId","parentSourceId",name,source)
      VALUES(${connectionId}::uuid,'private',${sourceId},${parentSourceId},${sourceId},${{ isFolder: folder }}::jsonb)`.execute(
      db,
    );
  }
  async function finish(context: { connectionId: string; ownerId: string }) {
    for (let i = 0; i < 10; i++) {
      if (await service.reconcile(context.connectionId, context.ownerId)) {
        return;
      }
    }
    throw new Error('unbounded reconciliation');
  }
  const rows = <T>(query: RawBuilder<T>) => query.execute(db).then((result) => result.rows);
  const first = <T>(query: RawBuilder<T>) => rows(query).then((result) => result[0]);
  const mapped = (connectionId: string, sourceId: string) =>
    first(
      sql<{
        albumId: string;
      }>`SELECT "albumId" FROM immich_fork.icloud_album WHERE "connectionId"=${connectionId}::uuid AND "sourceId"=${sourceId}`,
    ).then((row) => row.albumId);
  async function membership(
    context: { connectionId: string; ownerId: string },
    sourceAssetId: string,
    assetId = randomUUID(),
  ) {
    await sql`INSERT INTO asset(id,"ownerId") VALUES(${assetId}::uuid,${context.ownerId}::uuid) ON CONFLICT DO NOTHING`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_resource("connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize",status,"assetId")
      VALUES(${context.connectionId}::uuid,${context.ownerId}::uuid,'private','{}',${sourceAssetId},'master','resOriginalRes','original','v1','{}',3,'finalized',${assetId}::uuid)`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_membership("connectionId","libraryKey","sourceAlbumId","sourceAssetId","snapshotId")
      VALUES(${context.connectionId}::uuid,'private','album',${sourceAssetId},${randomUUID()}::uuid)`.execute(db);
    return assetId;
  }
  it.each(['dual-write', 'ready', 'active'])(
    'maps and reparents nested IDs with phase-aware closure in %s',
    async (phase) => {
      await sql`UPDATE immich_fork.state SET phase=${phase}`.execute(db);
      const context = await arrange();
      await source(context.connectionId, 'folder', null, true);
      await source(context.connectionId, 'other', null, true);
      await source(context.connectionId, 'child', 'folder');
      await finish(context);
      const child = await mapped(context.connectionId, 'child'),
        parent = await mapped(context.connectionId, 'folder'),
        other = await mapped(context.connectionId, 'other');
      expect(await first(sql`SELECT "parentId" FROM album WHERE id=${child}::uuid`)).toEqual({ parentId: parent });
      await sql`UPDATE immich_fork.icloud_album SET name='Renamed',"parentSourceId"='other' WHERE "connectionId"=${context.connectionId}::uuid AND "sourceId"='child'`.execute(
        db,
      );
      await finish(context);
      expect(await mapped(context.connectionId, 'child')).toBe(child);
      expect(await first(sql`SELECT "albumName","parentId" FROM album WHERE id=${child}::uuid`)).toEqual({
        albumName: 'Renamed',
        parentId: other,
      });
      expect(
        await rows(sql`SELECT 1 FROM album_closure WHERE id_ancestor=${parent}::uuid AND id_descendant=${child}::uuid`),
      ).toHaveLength(0);
      expect(
        await rows(
          sql`SELECT 1 FROM immich_fork.album_closure WHERE "ancestorId"=${other}::uuid AND "descendantId"=${child}::uuid`,
        ),
      ).toHaveLength(1);
      expect(
        await first(
          sql`SELECT source FROM immich_fork.icloud_album WHERE "connectionId"=${context.connectionId}::uuid AND "sourceId"='child'`,
        ),
      ).toMatchObject({ source: { _sync: { appliedName: 'Renamed' } } });
    },
  );
  it('preserves manual rename/move and source deletion', async () => {
    const context = await arrange();
    await source(context.connectionId, 'album');
    await finish(context);
    const id = await mapped(context.connectionId, 'album');
    await sql`UPDATE album SET "albumName"='My name',"parentId"=NULL WHERE id=${id}::uuid`.execute(db);
    await sql`UPDATE immich_fork.icloud_album SET name='Source changed' WHERE "connectionId"=${context.connectionId}::uuid AND "sourceId"='album'`.execute(
      db,
    );
    await finish(context);
    expect(await first(sql`SELECT "albumName","parentId" FROM album WHERE id=${id}::uuid`)).toEqual({
      albumName: 'My name',
      parentId: null,
    });
    await sql`UPDATE immich_fork.icloud_album SET deleted=true WHERE "connectionId"=${context.connectionId}::uuid`.execute(
      db,
    );
    await finish(context);
    expect(await rows(sql`SELECT id FROM album WHERE id=${id}::uuid`)).toHaveLength(1);
  });
  it('deduplicates original memberships and requires complete snapshot for removal', async () => {
    const context = await arrange();
    await source(context.connectionId, 'album');
    await finish(context);
    const albumId = await mapped(context.connectionId, 'album');
    const assetId = await membership(context, 'logical-a');
    await membership(context, 'logical-b', assetId);
    await finish(context);
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toHaveLength(1);
    await sql`UPDATE immich_fork.icloud_membership SET "sourcePresent"=false WHERE "connectionId"=${context.connectionId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_checkpoint("connectionId",scope,complete,"snapshotId") VALUES(${context.connectionId}::uuid,'memberships:private:album',false,${randomUUID()}::uuid)`.execute(
      db,
    );
    await finish(context);
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toHaveLength(1);
    await sql`UPDATE immich_fork.icloud_checkpoint SET complete=true WHERE "connectionId"=${context.connectionId}::uuid`.execute(
      db,
    );
    await finish(context);
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toHaveLength(0);
  });
  it('leaves manual collision provenance false and preserves manual membership', async () => {
    const context = await arrange();
    await source(context.connectionId, 'album');
    await finish(context);
    const albumId = await mapped(context.connectionId, 'album');
    const assetId = await membership(context, 'logical');
    await sql`INSERT INTO album_asset VALUES(${albumId}::uuid,${assetId}::uuid)`.execute(db);
    await finish(context);
    expect(
      await first(
        sql`SELECT "addedBySync" FROM immich_fork.icloud_membership WHERE "connectionId"=${context.connectionId}::uuid`,
      ),
    ).toEqual({ addedBySync: false });
    await sql`UPDATE immich_fork.icloud_membership SET "sourcePresent"=false WHERE "connectionId"=${context.connectionId}::uuid`.execute(
      db,
    );
    await sql`INSERT INTO immich_fork.icloud_checkpoint("connectionId",scope,complete,"snapshotId") VALUES(${context.connectionId}::uuid,'memberships:private:album',true,${randomUUID()}::uuid)`.execute(
      db,
    );
    await finish(context);
    expect(await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toHaveLength(1);
  });
  it('rejects foreign ownership, cyclic source hierarchy and inactive phase atomically', async () => {
    const context = await arrange();
    await source(context.connectionId, 'a', 'b', true);
    await source(context.connectionId, 'b', 'a', true);
    await expect(service.reconcile(context.connectionId, randomUUID())).rejects.toThrow('icloud_connection_not_found');
    await expect(service.reconcile(context.connectionId, context.ownerId)).rejects.toThrow(
      'icloud_album_parent_unresolved',
    );
    expect(
      await rows(
        sql`SELECT 1 FROM immich_fork.icloud_album WHERE "connectionId"=${context.connectionId}::uuid AND "albumId" IS NOT NULL`,
      ),
    ).toHaveLength(0);
    await sql`UPDATE immich_fork.state SET phase='inactive'`.execute(db);
    await expect(service.reconcile(context.connectionId, context.ownerId)).rejects.toThrow('icloud_fork_inactive');
  });
  it('bounds each page including container creation to 100 logical album changes', async () => {
    const context = await arrange();
    await sql`INSERT INTO immich_fork.icloud_album("connectionId","libraryKey","sourceId",name)
      SELECT ${context.connectionId}::uuid,'private','album-'||n,'Album '||n FROM generate_series(1,205)n`.execute(db);
    expect(await service.reconcile(context.connectionId, context.ownerId)).toBe(false);
    expect(
      await first(
        sql`SELECT count(*)::int AS count FROM immich_fork.icloud_album WHERE "connectionId"=${context.connectionId}::uuid AND "albumId" IS NOT NULL`,
      ),
    ).toEqual({ count: 100 });
    await finish(context);
    expect(
      await first(
        sql`SELECT count(*)::int AS count FROM immich_fork.icloud_album WHERE "connectionId"=${context.connectionId}::uuid AND "albumId" IS NOT NULL`,
      ),
    ).toEqual({ count: 206 });
  });
  it('does not adopt a manual override as a new sync baseline', () => {
    expect(
      mergeICloudAlbum(
        { albumName: 'local', parentId: 'local-parent' },
        { name: 'new', parentId: 'new-parent', parentSourceId: 'new' },
        { appliedName: 'old', appliedParentId: 'old-parent' },
      ),
    ).toMatchObject({
      albumName: 'local',
      parentId: 'local-parent',
      state: { sourceName: 'new', appliedName: 'old', appliedParentId: 'old-parent' },
    });
  });
  it.each(['library', 'album', 'noncurrent'])(
    'does not attach a queued membership after %s selection is revoked',
    async (revoked) => {
      const context = await arrange();
      await source(context.connectionId, 'album');
      await finish(context);
      const albumId = await mapped(context.connectionId, 'album');
      const existing = await membership(context, 'existing');
      await finish(context);
      const queued = await membership(context, 'queued');
      if (revoked === 'noncurrent') {
        await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":false}'::jsonb
        WHERE "connectionId"=${context.connectionId}::uuid AND "sourceAssetId"='queued'`.execute(db);
      } else {
        const config = ICloudConfigSchema.parse(
          revoked === 'library' ? { libraries: ['different'] } : { albums: ['private:different'] },
        );
        await sql`UPDATE immich_fork.icloud_connection SET config=${config}::jsonb WHERE id=${context.connectionId}::uuid`.execute(
          db,
        );
      }
      await finish(context);
      expect(await rows(sql`SELECT "assetId" FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toEqual([
        { assetId: existing },
      ]);
      expect(
        await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid AND "assetId"=${queued}::uuid`),
      ).toHaveLength(0);
      await sql`UPDATE immich_fork.icloud_connection SET config=${ICloudConfigSchema.parse({})}::jsonb WHERE id=${context.connectionId}::uuid`.execute(
        db,
      );
      await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":true}'::jsonb WHERE "connectionId"=${context.connectionId}::uuid`.execute(
        db,
      );
      await finish(context);
      expect(await rows(sql`SELECT 1 FROM album_asset WHERE "albumId"=${albumId}::uuid`)).toHaveLength(2);
    },
  );
  it('does not recreate a container suppressed during official handoff', async () => {
    const context = await arrange();
    await finish(context);
    await sql`UPDATE immich_fork.icloud_album SET "albumId"=NULL,source=jsonb_set(source,'{_sync,suppressed}','true')
      WHERE "connectionId"=${context.connectionId}::uuid AND "sourceId"='__icloud_container__'`.execute(db);
    await expect(service.reconcile(context.connectionId, context.ownerId)).rejects.toThrow('icloud_container_removed');
    expect(await rows(sql`SELECT 1 FROM album_user WHERE "userId"=${context.ownerId}::uuid`)).toHaveLength(1);
  });
});
