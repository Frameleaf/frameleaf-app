import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { ICloudConfig } from 'src/dtos/icloud-sync.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { AlbumRepository, lockAlbumHierarchy } from 'src/repositories/album.repository.js';
import { DB } from 'src/schema/index.js';

export type AlbumSyncState = {
  sourceName?: string;
  sourceParentId?: string | null;
  appliedName?: string;
  appliedParentId?: string | null;
  suppressed?: boolean;
};
type SourceAlbum = {
  connectionId: string;
  libraryKey: string;
  sourceId: string;
  parentSourceId: string | null;
  name: string;
  albumId: string | null;
  source: Record<string, unknown> & {
    _sync?: AlbumSyncState;
  };
};
type DestinationAlbum = {
  id: string;
  albumName: string;
  parentId: string | null;
  icon: string | null;
  sortOrder: number | null;
  kind: string;
};
type Membership = {
  libraryKey: string;
  sourceAlbumId: string;
  sourceAssetId: string;
  albumId: string | null;
  assetId: string | null;
  addedBySync: boolean;
  sourcePresent: boolean;
  targetAlbumId: string | null;
  targetAssetId: string | null;
};
/** A local change wins until the local value again matches our previous applied value. */
export function mergeICloudAlbum(
  current: {
    albumName: string;
    parentId: string | null;
  },
  incoming: {
    name: string;
    parentId: string | null;
    parentSourceId: string | null;
  },
  previous: AlbumSyncState,
) {
  const albumName = current.albumName === previous.appliedName ? incoming.name : current.albumName;
  const parentId = current.parentId === previous.appliedParentId ? incoming.parentId : current.parentId;
  return {
    albumName,
    parentId,
    state: {
      sourceName: incoming.name,
      sourceParentId: incoming.parentSourceId,
      appliedName: current.albumName === previous.appliedName ? albumName : previous.appliedName,
      appliedParentId: current.parentId === previous.appliedParentId ? parentId : previous.appliedParentId,
    } satisfies AlbumSyncState,
  };
}
@Injectable()
export class ICloudAlbumRepository {
  constructor(
    @InjectKysely()
    private readonly db: Kysely<DB>,
  ) {}
  async reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      await lockAlbumHierarchy(db);
      const connection = await sql<{
        label: string;
        config: ICloudConfig;
      }>`SELECT label,config FROM public.icloud_connection
        WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected' FOR UPDATE`
        .execute(db)
        .then(({ rows }) => rows[0]);
      if (!connection) {
        throw new Error('icloud_connection_not_found');
      }
      const containerResult = await this.container(db, connectionId, ownerId, connection.label);
      const container = containerResult.id;
      const budget = containerResult.created ? 99 : 100;
      const { rows } = await this.pendingAlbums(db, connectionId, ownerId, connection.config, budget);
      for (const row of rows) {
        const parent = row.parentSourceId
          ? await sql<{
              albumId: string | null;
              suppressed: boolean;
            }>`SELECT "albumId",coalesce((source->'_sync'->>'suppressed')::boolean,false) AS suppressed
          FROM public.icloud_album WHERE "connectionId"=${connectionId}::uuid AND "libraryKey"=${row.libraryKey}
          AND "sourceId"=${row.parentSourceId} AND NOT deleted`
              .execute(db)
              .then(({ rows }) => rows[0])
          : undefined;
        const parentId = parent?.albumId && !parent.suppressed ? parent.albumId : container;
        if (parentId !== container && !(await this.ownedAlbum(db, parentId, ownerId))) {
          throw new Error('icloud_album_parent_not_owned');
        }
        if (!row.albumId) {
          row.albumId = await this.createAlbum(db, row.name, parentId, ownerId);
          await this.saveState(db, row, {
            sourceName: row.name,
            sourceParentId: row.parentSourceId,
            appliedName: row.name,
            appliedParentId: parentId,
          });
          continue;
        }
        const current = await this.ownedAlbum(db, row.albumId, ownerId);
        if (!current) {
          // A user removed/transferred this mapping. Do not silently recreate it or touch its new owner.
          row.albumId = null;
          await this.saveState(db, row, { ...row.source._sync, suppressed: true });
          continue;
        }
        const merged = mergeICloudAlbum(
          current,
          { name: row.name, parentId, parentSourceId: row.parentSourceId },
          row.source._sync ?? {},
        );
        if (merged.albumName !== current.albumName) {
          await sql`UPDATE album SET "albumName"=${merged.albumName} WHERE id=${row.albumId}::uuid`.execute(db);
        }
        if (merged.parentId !== current.parentId) {
          await new AlbumRepository(db).reparentIn(db, row.albumId, merged.parentId);
          if (merged.parentId) await this.promoteToCollection(db, merged.parentId);
        }
        await this.saveState(db, row, merged.state);
      }
      if (rows.length === budget) {
        return false;
      }
      const remaining = await this.pendingAlbums(db, connectionId, ownerId, connection.config, 1);
      if (remaining.rows.length > 0) {
        return false;
      }
      const unresolved = await sql`SELECT 1 FROM public.icloud_album s WHERE s."connectionId"=${connectionId}::uuid
        AND s."libraryKey"<>'' AND NOT s.deleted AND s."albumId" IS NULL AND NOT coalesce((s.source->'_sync'->>'suppressed')::boolean,false)
        AND ${this.selected(connection.config)} LIMIT 1`.execute(db);
      if (unresolved.rows.length > 0) {
        throw new Error('icloud_album_parent_unresolved');
      }
      return this.memberships(db, connectionId, ownerId, budget - rows.length, connection.config);
    });
  }
  private selected(config: ICloudConfig) {
    return sql`(${config.libraries.length === 0} OR s."libraryKey"=ANY(${config.libraries}::text[]))
      AND (${config.albums.length === 0} OR (s."libraryKey" || ':' || s."sourceId")=ANY(${config.albums}::text[])
        OR coalesce((s.source->>'isFolder')::boolean,false))`;
  }
  private pendingAlbums(db: Kysely<DB>, connectionId: string, ownerId: string, config: ICloudConfig, limit: number) {
    return sql<SourceAlbum>`SELECT s.* FROM public.icloud_album s
      LEFT JOIN public.icloud_album p ON p."connectionId"=s."connectionId" AND p."libraryKey"=s."libraryKey"
        AND p."sourceId"=s."parentSourceId" AND NOT p.deleted
      WHERE s."connectionId"=${connectionId}::uuid AND s."libraryKey"<>'' AND NOT s.deleted
        AND NOT coalesce((s.source->'_sync'->>'suppressed')::boolean,false) AND ${this.selected(config)}
        AND (p."sourceId" IS NULL OR p."albumId" IS NOT NULL OR coalesce((p.source->'_sync'->>'suppressed')::boolean,false))
        AND (s."albumId" IS NULL OR s.source->'_sync'->>'sourceName' IS DISTINCT FROM s.name
          OR s.source->'_sync'->>'sourceParentId' IS DISTINCT FROM s."parentSourceId"
          OR NOT EXISTS(SELECT 1 FROM album a JOIN album_user u ON u."albumId"=a.id
            WHERE a.id=s."albumId" AND a."deletedAt" IS NULL AND u."userId"=${ownerId}::uuid AND u.role='owner'))
      ORDER BY s."libraryKey",s."sourceId" LIMIT ${limit}`.execute(db);
  }
  private async ownedAlbum(db: Kysely<DB>, id: string, ownerId: string) {
    const { rows } =
      await sql<DestinationAlbum>`SELECT a.id,a."albumName",a."parentId",a.icon,a."sortOrder",a.kind FROM album a
      JOIN album_user u ON u."albumId"=a.id WHERE a.id=${id}::uuid AND a."deletedAt" IS NULL
        AND u."userId"=${ownerId}::uuid AND u.role='owner' FOR UPDATE OF a`.execute(db);
    return rows[0];
  }
  private async container(db: Kysely<DB>, connectionId: string, ownerId: string, label: string) {
    await sql`INSERT INTO public.icloud_album ("connectionId","libraryKey","sourceId",name)
      VALUES (${connectionId}::uuid,'','__icloud_container__',${`iCloud (${label})`}) ON CONFLICT DO NOTHING`.execute(
      db,
    );
    const row = await sql<SourceAlbum>`SELECT * FROM public.icloud_album WHERE "connectionId"=${connectionId}::uuid
      AND "libraryKey"='' AND "sourceId"='__icloud_container__'`
      .execute(db)
      .then(({ rows }) => rows[0]);
    if (row.source._sync?.suppressed) {
      throw new Error('icloud_container_removed');
    }
    if (row.albumId) {
      if (!(await this.ownedAlbum(db, row.albumId, ownerId))) {
        throw new Error('icloud_container_removed');
      }
      return { id: row.albumId, created: false };
    }
    row.albumId = await this.createAlbum(db, row.name, null, ownerId, 'collection');
    await this.saveState(db, row, {
      sourceName: row.name,
      sourceParentId: null,
      appliedName: row.name,
      appliedParentId: null,
    });
    return { id: row.albumId, created: true };
  }
  private async createAlbum(
    db: Kysely<DB>,
    name: string,
    parentId: string | null,
    ownerId: string,
    kind: 'album' | 'collection' = 'album',
  ) {
    const { id } = await new AlbumRepository(db).create(
      { albumName: name, parentId, kind: kind as AlbumKind },
      [],
      [{ userId: ownerId, role: AlbumUserRole.Owner }],
      ownerId,
    );
    if (parentId) await this.promoteToCollection(db, parentId);
    return id;
  }
  /** An album that holds albums is a collection; mirrored iCloud folders become collections the first time they get a child. */
  private async promoteToCollection(db: Kysely<DB>, id: string) {
    await sql`UPDATE album SET kind='collection' WHERE id=${id}::uuid AND kind='album'`.execute(db);
  }
  private async saveState(db: Kysely<DB>, row: SourceAlbum, state: AlbumSyncState) {
    await sql`UPDATE public.icloud_album SET "albumId"=${row.albumId}::uuid,
      source=jsonb_set(source,'{_sync}',${state}::jsonb,true) WHERE "connectionId"=${row.connectionId}::uuid
      AND "libraryKey"=${row.libraryKey} AND "sourceId"=${row.sourceId}`.execute(db);
  }
  private async memberships(
    db: Kysely<DB>,
    connectionId: string,
    ownerId: string,
    limit: number,
    config: ICloudConfig,
  ): Promise<boolean> {
    const selection = sql<Membership>`SELECT m.*,s."albumId" AS "targetAlbumId",r."assetId" AS "targetAssetId"
      FROM public.icloud_membership m JOIN public.icloud_album s
        ON s."connectionId"=m."connectionId" AND s."libraryKey"=m."libraryKey" AND s."sourceId"=m."sourceAlbumId" AND NOT s.deleted
      LEFT JOIN LATERAL (SELECT r."assetId" FROM public.icloud_resource r JOIN asset a ON a.id=r."assetId"
        WHERE r."auditRequestId" IS NULL AND r."connectionId"=m."connectionId" AND r."libraryKey"=m."libraryKey" AND r."sourceAssetId"=m."sourceAssetId"
          AND r."ownerId"=${ownerId}::uuid AND a."ownerId"=${ownerId}::uuid AND a."deletedAt" IS NULL
          AND coalesce((r.source->>'current')::boolean,true)
          AND r.role='original' AND r.status IN ('committed','finalized','reused') ORDER BY r."updatedAt" DESC,r.id LIMIT 1) r ON true
      WHERE m."connectionId"=${connectionId}::uuid
        AND (${config.libraries.length === 0} OR m."libraryKey"=ANY(${config.libraries}::text[]))
        AND (${config.albums.length === 0} OR (m."libraryKey" || ':' || m."sourceAlbumId")=ANY(${config.albums}::text[]))
        AND NOT coalesce((s.source#>>'{_sync,suppressed}')::boolean,false)
        AND EXISTS(SELECT 1 FROM album a JOIN album_user u ON u."albumId"=a.id WHERE a.id=s."albumId" AND a."deletedAt" IS NULL
          AND u."userId"=${ownerId}::uuid AND u.role='owner')
        AND ((m."sourcePresent" AND r."assetId" IS NOT NULL AND (m."albumId" IS DISTINCT FROM s."albumId" OR m."assetId" IS DISTINCT FROM r."assetId"))
          OR (NOT m."sourcePresent" AND m."addedBySync" AND m."albumId" IS NOT NULL AND m."assetId" IS NOT NULL
            AND EXISTS(SELECT 1 FROM public.icloud_checkpoint c WHERE c."connectionId"=m."connectionId"
              AND c.scope='memberships:' || m."libraryKey" || ':' || m."sourceAlbumId" AND c.complete)))
      ORDER BY m."libraryKey",m."sourceAlbumId",m."sourceAssetId" LIMIT ${limit}`;
    const candidates = (await selection.execute(db)).rows;
    if (candidates.length === 0) return candidates.length < limit;
    const albumIds = new Set(
      candidates.flatMap(({ albumId, targetAlbumId }) => [albumId, targetAlbumId]).filter((id): id is string => !!id),
    );
    return new AlbumRepository(db).withMembershipWrite([...albumIds], async () => {
      // A manual removal ends source ownership; reread it after that writer releases the album.
      const { rows } = await selection.execute(db);
      if (rows.some(({ albumId, targetAlbumId }) => [albumId, targetAlbumId].some((id) => id && !albumIds.has(id)))) {
        throw new ConflictException('icloud_album_membership_changed');
      }
      for (const row of rows) {
        if (row.addedBySync && row.albumId && row.assetId) {
          await sql`DELETE FROM album_asset aa WHERE aa."albumId"=${row.albumId}::uuid AND aa."assetId"=${row.assetId}::uuid
          AND EXISTS(SELECT 1 FROM album_user u WHERE u."albumId"=aa."albumId" AND u."userId"=${ownerId}::uuid AND u.role='owner')
          AND EXISTS(SELECT 1 FROM asset a WHERE a.id=aa."assetId" AND a."ownerId"=${ownerId}::uuid)
          AND NOT EXISTS(SELECT 1 FROM public.icloud_membership other WHERE other."albumId"=aa."albumId" AND other."assetId"=aa."assetId"
            AND (other."sourcePresent" OR NOT other."addedBySync")
            AND (other."connectionId",other."libraryKey",other."sourceAlbumId",other."sourceAssetId") IS DISTINCT FROM
              (${connectionId}::uuid,${row.libraryKey},${row.sourceAlbumId},${row.sourceAssetId}))`.execute(db);
        }
        let inserted = false;
        if (row.sourcePresent && row.targetAlbumId && row.targetAssetId) {
          inserted =
            (await sql`INSERT INTO album_asset ("albumId","assetId") VALUES (${row.targetAlbumId}::uuid,${row.targetAssetId}::uuid)
          ON CONFLICT DO NOTHING RETURNING "assetId"`
              .execute(db)
              .then(({ rows }) => rows.length)) > 0;
          if (!inserted) {
            inserted =
              (await sql`SELECT 1 FROM public.icloud_membership WHERE "albumId"=${row.targetAlbumId}::uuid
            AND "assetId"=${row.targetAssetId}::uuid AND "addedBySync" AND "sourcePresent" LIMIT 1`
                .execute(db)
                .then(({ rows }) => rows.length)) > 0;
          }
        }
        await sql`UPDATE public.icloud_membership SET "albumId"=${row.sourcePresent ? row.targetAlbumId : null}::uuid,
        "assetId"=${row.sourcePresent ? row.targetAssetId : null}::uuid,"addedBySync"=${inserted}
        WHERE "connectionId"=${connectionId}::uuid AND "libraryKey"=${row.libraryKey} AND "sourceAlbumId"=${row.sourceAlbumId}
          AND "sourceAssetId"=${row.sourceAssetId}`.execute(db);
      }
      return rows.length < limit;
    });
  }
}
