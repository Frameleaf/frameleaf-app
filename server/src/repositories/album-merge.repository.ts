import { BadRequestException, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import {
  ALBUM_CHANGE_SOFT_DELETED,
  type AlbumChangeInput,
  type AlbumChangeReversal,
  type AlbumChangeRow,
} from 'src/repositories/album-change-run.repository.js';
import { DB } from 'src/schema/index.js';

/** The kinds of change a merge records, in the order a merge makes them. Undo walks them backwards. */
export const AlbumChangeKind = {
  ParentChanged: 'album.parent_changed',
  AssetAdded: 'album.asset_added',
  BookmarkAdded: 'album.bookmark_added',
  ActivityMoved: 'album.activity_moved',
  SourceLinkMoved: 'album.source_link_moved',
  ICloudAlbumMoved: 'album.icloud_album_moved',
  TakeoutFolderMoved: 'album.takeout_folder_moved',
  ChoiceMoved: 'album.choice_moved',
  LockChanged: 'album.lock_changed',
  SoftDeleted: ALBUM_CHANGE_SOFT_DELETED,
} as const;

export interface MergeAlbumRow {
  id: string;
  albumName: string;
  createdAt: Date;
  parentId: string | null;
  isLocked: boolean;
  kind: string;
}

/** Lists a person picks albums for: what they chose must not silently drop out when an album goes. */
type ChoiceTable = 'cloud_backup_selection' | 'speech_settings';
const CHOICE_TABLES: ChoiceTable[] = ['cloud_backup_selection', 'speech_settings'];

const choiceOwner = (table: ChoiceTable, ownerId: string) =>
  table === 'cloud_backup_selection'
    ? sql`"userId" = ${ownerId}::uuid AND destination = 'cloud'`
    : sql`"ownerId" = ${ownerId}::uuid`;

/**
 * FL-1298: the writes of a merge and their undoing. Each step records what it did so Undo can take back
 * exactly that, and each reversal leaves alone anything the person changed since. Always built on the
 * transaction that also writes the run record.
 */
@Injectable()
export class AlbumMergeRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Both albums, fenced in id order, as long as this person still owns both and neither is deleted. */
  async lockPair(firstId: string, secondId: string, ownerId: string): Promise<MergeAlbumRow[]> {
    const rows = await this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join
          .onRef('album_user.albumId', '=', 'album.id')
          .on('album_user.userId', '=', ownerId)
          .on('album_user.role', '=', AlbumUserRole.Owner),
      )
      .select(['album.id', 'album.albumName', 'album.createdAt', 'album.parentId', 'album.isLocked', 'album.kind'])
      .where('album.id', 'in', [firstId, secondId])
      .where('album.deletedAt', 'is', null)
      .orderBy('album.id')
      .forUpdate('album')
      .$castTo<MergeAlbumRow>()
      .execute();
    if (rows.length !== 2) {
      throw new BadRequestException('Both albums must be yours and still exist');
    }
    if (rows.some(({ kind }) => kind !== AlbumKind.Album)) {
      throw new BadRequestException('Only albums can be merged');
    }
    return rows;
  }

  /** True when `albumId` sits anywhere below `ancestorId`. */
  async isInside(ancestorId: string, albumId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('album_closure')
      .select('id_descendant')
      .where('id_ancestor', '=', ancestorId)
      .where('id_descendant', '=', albumId)
      .where('id_ancestor', '!=', albumId)
      .executeTakeFirst();
    return !!row;
  }

  async getChildIds(parentId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('album').select('id').where('parentId', '=', parentId).execute();
    return rows.map(({ id }) => id);
  }

  /** Copies the loser's photos into the winner. Records exactly the rows it added, with each one's generation. */
  async copyMemberships(runId: string, loserId: string, winnerId: string): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      WITH added AS (
        INSERT INTO album_asset ("albumId", "assetId")
        SELECT ${winnerId}::uuid, "assetId" FROM album_asset WHERE "albumId" = ${loserId}::uuid
        ON CONFLICT DO NOTHING
        RETURNING "assetId", "updateId"
      ), base AS (
        SELECT coalesce(max(seq), 0) AS seq FROM album_change WHERE "runId" = ${runId}::uuid
      ), recorded AS (
        INSERT INTO album_change ("runId", seq, kind, "albumId", "assetId", after)
        SELECT ${runId}::uuid, base.seq + row_number() OVER (), ${AlbumChangeKind.AssetAdded}, ${winnerId}::uuid, added."assetId",
          jsonb_build_object('updateId', added."updateId")
        FROM added CROSS JOIN base
        RETURNING 1
      )
      SELECT count(*)::int AS count FROM recorded
    `.execute(this.db);
    return rows[0].count;
  }

  /** Unions the loser's links into the winner, recording the rows it added. */
  async copyBookmarks(runId: string, loserId: string, winnerId: string): Promise<void> {
    await sql`
      WITH added AS (
        INSERT INTO album_bookmark ("albumId", "bookmarkId")
        SELECT ${winnerId}::uuid, "bookmarkId" FROM album_bookmark WHERE "albumId" = ${loserId}::uuid
        ON CONFLICT DO NOTHING
        RETURNING "bookmarkId", "createdAt"
      ), base AS (
        SELECT coalesce(max(seq), 0) AS seq FROM album_change WHERE "runId" = ${runId}::uuid
      )
      INSERT INTO album_change ("runId", seq, kind, "albumId", after)
      SELECT ${runId}::uuid, base.seq + row_number() OVER (), ${AlbumChangeKind.BookmarkAdded}, ${winnerId}::uuid,
        jsonb_build_object('bookmarkId', added."bookmarkId", 'createdAt', added."createdAt")
      FROM added CROSS JOIN base
    `.execute(this.db);
  }

  /** Moves comments and likes. A like the winner already holds stays behind, as the duplicate it would be. */
  async moveActivity(runId: string, loserId: string, winnerId: string): Promise<void> {
    await sql`
      WITH moved AS (
        UPDATE activity a SET "albumId" = ${winnerId}::uuid
        WHERE a."albumId" = ${loserId}::uuid
          AND NOT (a."isLiked" AND EXISTS (
            SELECT 1 FROM activity o WHERE o."albumId" = ${winnerId}::uuid AND o."isLiked"
              AND o."userId" = a."userId" AND o."assetId" IS NOT DISTINCT FROM a."assetId"))
        RETURNING a.id
      ), base AS (
        SELECT coalesce(max(seq), 0) AS seq FROM album_change WHERE "runId" = ${runId}::uuid
      )
      INSERT INTO album_change ("runId", seq, kind, "albumId", before, after)
      SELECT ${runId}::uuid, base.seq + row_number() OVER (), ${AlbumChangeKind.ActivityMoved}, ${winnerId}::uuid,
        jsonb_build_object('albumId', ${loserId}::uuid),
        jsonb_build_object('activityId', moved.id)
      FROM moved CROSS JOIN base
    `.execute(this.db);
  }

  async getICloudAlbums(loserId: string): Promise<{ connectionId: string; libraryKey: string; sourceId: string }[]> {
    const { rows } = await sql<{ connectionId: string; libraryKey: string; sourceId: string }>`
      SELECT "connectionId", "libraryKey", "sourceId" FROM public.icloud_album
      WHERE "albumId" = ${loserId}::uuid
      ORDER BY "connectionId", "libraryKey", "sourceId"
    `.execute(this.db);
    return rows;
  }

  /**
   * Points an iCloud album and its memberships at the winner, so the next sync neither stops following it
   * nor recreates it. A photo the winner already held by hand stops being the sync's to remove.
   */
  async moveICloudAlbum(
    runId: string,
    source: { connectionId: string; libraryKey: string; sourceId: string },
    loserId: string,
    winnerId: string,
  ): Promise<{ syncAddedAssetIds: string[] }> {
    const key = sql`"connectionId" = ${source.connectionId}::uuid AND "libraryKey" = ${source.libraryKey}`;
    await sql`UPDATE public.icloud_album SET "albumId" = ${winnerId}::uuid WHERE ${key} AND "sourceId" = ${source.sourceId}`.execute(
      this.db,
    );
    const { rows } = await sql<{ assetId: string }>`
      SELECT m."assetId" FROM public.icloud_membership m
      WHERE ${key} AND m."sourceAlbumId" = ${source.sourceId} AND m."albumId" = ${loserId}::uuid AND m."addedBySync"
        AND m."assetId" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM album_change c
          WHERE c."runId" = ${runId}::uuid AND c.kind = ${AlbumChangeKind.AssetAdded}
            AND c."albumId" = ${winnerId}::uuid AND c."assetId" = m."assetId")
    `.execute(this.db);
    const inWinnerAlready = rows.map(({ assetId }) => assetId);
    await sql`
      UPDATE public.icloud_membership
      SET "albumId" = ${winnerId}::uuid,
        "addedBySync" = "addedBySync" AND NOT coalesce("assetId" = ANY(${inWinnerAlready}::uuid[]), false)
      WHERE ${key} AND "sourceAlbumId" = ${source.sourceId} AND "albumId" = ${loserId}::uuid
    `.execute(this.db);
    return { syncAddedAssetIds: inWinnerAlready };
  }

  /** Keeps a later Google Takeout import of the folder adding to the merged album. */
  async moveTakeoutFolders(loserId: string, winnerId: string): Promise<{ id: string; folder: string }[]> {
    const { rows } = await sql<{ id: string; folder: string }>`
      UPDATE takeout_album SET "albumId" = ${winnerId}::uuid WHERE "albumId" = ${loserId}::uuid RETURNING id, folder
    `.execute(this.db);
    return rows;
  }

  /** What the person chose albums for: a loser that was chosen becomes the winner, so nothing drops out. */
  async moveChoices(loserId: string, winnerId: string, ownerId: string): Promise<AlbumChangeInput[]> {
    const changes: AlbumChangeInput[] = [];
    for (const table of CHOICE_TABLES) {
      const owned = choiceOwner(table, ownerId);
      const { rows } = await sql<{ albumIds: string[] }>`
        SELECT "albumIds" FROM ${sql.table(table)}
        WHERE ${owned} AND ${loserId}::uuid = ANY("albumIds")
        FOR UPDATE
      `.execute(this.db);
      for (const { albumIds } of rows) {
        const next = albumIds.includes(winnerId)
          ? albumIds.filter((id) => id !== loserId)
          : albumIds.map((id) => (id === loserId ? winnerId : id));
        await sql`UPDATE ${sql.table(table)} SET "albumIds" = ${next}::uuid[] WHERE ${owned}`.execute(this.db);
        changes.push({
          kind: AlbumChangeKind.ChoiceMoved,
          albumId: winnerId,
          before: { table, ownerId, albumIds },
          after: { albumIds: next },
        });
      }
    }
    return changes;
  }

  /** Drops the Locked flag on a winner that was locked when the other album was not. */
  async setLocked(albumId: string, isLocked: boolean): Promise<void> {
    await this.db.updateTable('album').set({ isLocked }).where('id', '=', albumId).execute();
  }

  async softDelete(albumId: string): Promise<Date> {
    const { deletedAt } = await this.db
      .updateTable('album')
      .set({ deletedAt: new Date() })
      .where('id', '=', albumId)
      .returning('deletedAt')
      .executeTakeFirstOrThrow();
    return deletedAt as Date;
  }

  /** The name to report a skipped album by; an album gone meanwhile is not worth reporting. */
  private async nameOf(albumId: string | null): Promise<string | undefined> {
    if (!albumId) {
      return undefined;
    }
    const row = await this.db.selectFrom('album').select('albumName').where('id', '=', albumId).executeTakeFirst();
    return row?.albumName;
  }

  /** Removes copies the merge added, unless they were re-added or commented on since. */
  async reverseMemberships(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    const rows = changes.filter((change) => change.albumId && change.assetId);
    if (rows.length === 0) {
      return { reversed: 0, skipped: [] };
    }
    const albumIds = rows.map(({ albumId }) => albumId!);
    const assetIds = rows.map(({ assetId }) => assetId!);
    const updateIds = rows.map(({ after }) => (after as { updateId: string }).updateId);
    const { rows: removed } = await sql<{ albumId: string; assetId: string }>`
      DELETE FROM album_asset aa
      USING unnest(${albumIds}::uuid[], ${assetIds}::uuid[], ${updateIds}::uuid[]) AS c("albumId", "assetId", "updateId")
      WHERE aa."albumId" = c."albumId" AND aa."assetId" = c."assetId" AND aa."updateId" = c."updateId"
        AND NOT EXISTS (SELECT 1 FROM activity a WHERE a."albumId" = aa."albumId" AND a."assetId" = aa."assetId")
      RETURNING aa."albumId", aa."assetId"
    `.execute(this.db);
    const gone = new Set(removed.map(({ albumId, assetId }) => `${albumId}:${assetId}`));
    const remaining = rows.filter(({ albumId, assetId }) => !gone.has(`${albumId}:${assetId}`));
    const { rows: kept } = await sql<{ albumId: string }>`
      SELECT DISTINCT aa."albumId" FROM album_asset aa
      JOIN unnest(${remaining.map(({ albumId }) => albumId!)}::uuid[], ${remaining.map(({ assetId }) => assetId!)}::uuid[])
        AS c("albumId", "assetId")
      ON aa."albumId" = c."albumId" AND aa."assetId" = c."assetId"
    `.execute(this.db);
    const skipped: string[] = [];
    for (const { albumId } of kept) {
      const name = await this.nameOf(albumId);
      if (name !== undefined) {
        skipped.push(name);
      }
    }
    return { reversed: removed.length, skipped };
  }

  /** Removes links the merge added, unless one was removed and added again since. */
  async reverseBookmarks(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const { bookmarkId, createdAt } = change.after as { bookmarkId: string; createdAt: string };
      const { numAffectedRows } = await sql`
        DELETE FROM album_bookmark
        WHERE "albumId" = ${change.albumId}::uuid AND "bookmarkId" = ${bookmarkId}::uuid AND "createdAt" = ${createdAt}::timestamptz
      `.execute(this.db);
      reversed += Number(numAffectedRows ?? 0);
    }
    return { reversed, skipped: [] };
  }

  /** Moves comments and likes back. A comment deleted since is simply gone. */
  async reverseActivity(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const { activityId } = change.after as { activityId: string };
      const { albumId: originalAlbumId } = change.before as { albumId: string };
      const { numAffectedRows } = await sql`
        UPDATE activity SET "albumId" = ${originalAlbumId}::uuid
        WHERE id = ${activityId}::uuid AND "albumId" = ${change.albumId}::uuid
      `.execute(this.db);
      reversed += Number(numAffectedRows ?? 0);
    }
    return { reversed, skipped: [] };
  }

  async reverseICloudAlbums(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      const before = change.before as {
        connectionId: string;
        libraryKey: string;
        sourceId: string;
        albumId: string;
        syncAddedAssetIds: string[];
      };
      const winnerId = change.albumId;
      const key = sql`"connectionId" = ${before.connectionId}::uuid AND "libraryKey" = ${before.libraryKey}`;
      const { numAffectedRows } = await sql`
        UPDATE public.icloud_album SET "albumId" = ${before.albumId}::uuid
        WHERE ${key} AND "sourceId" = ${before.sourceId} AND "albumId" = ${winnerId}::uuid
      `.execute(this.db);
      if (Number(numAffectedRows ?? 0) === 0) {
        const name = await this.nameOf(before.albumId);
        if (name !== undefined) {
          skipped.push(name);
        }
        continue;
      }
      await sql`
        UPDATE public.icloud_membership
        SET "albumId" = ${before.albumId}::uuid,
          "addedBySync" = "addedBySync" OR coalesce("assetId" = ANY(${before.syncAddedAssetIds}::uuid[]), false)
        WHERE ${key} AND "sourceAlbumId" = ${before.sourceId} AND "albumId" = ${winnerId}::uuid
      `.execute(this.db);
      reversed += 1;
    }
    return { reversed, skipped };
  }

  async reverseTakeoutFolders(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      const { albumId } = change.before as { albumId: string };
      const { id, folder } = change.after as { id: string; folder: string };
      const { numAffectedRows } = await sql`
        UPDATE takeout_album SET "albumId" = ${albumId}::uuid
        WHERE id = ${id}::uuid AND "albumId" = ${change.albumId}::uuid
      `.execute(this.db);
      if (Number(numAffectedRows ?? 0) === 0) {
        skipped.push(folder);
      } else {
        reversed += 1;
      }
    }
    return { reversed, skipped };
  }

  async reverseChoices(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      const before = change.before as { table: ChoiceTable; ownerId: string; albumIds: string[] };
      const { albumIds: expected } = change.after as { albumIds: string[] };
      const { numAffectedRows } = await sql`
        UPDATE ${sql.table(before.table)} SET "albumIds" = ${before.albumIds}::uuid[]
        WHERE ${choiceOwner(before.table, before.ownerId)} AND "albumIds" = ${expected}::uuid[]
      `.execute(this.db);
      if (Number(numAffectedRows ?? 0) === 0) {
        const name = await this.nameOf(change.albumId);
        if (name !== undefined) {
          skipped.push(name);
        }
      } else {
        reversed += 1;
      }
    }
    return { reversed, skipped };
  }

  /** Puts a Locked flag back only if the person hasn't changed it since. */
  async reverseLock(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    const skipped: string[] = [];
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const { isLocked } = change.before as { isLocked: boolean };
      const result = await this.db
        .updateTable('album')
        .set({ isLocked })
        .where('id', '=', change.albumId)
        .where('isLocked', '=', (change.after as { isLocked: boolean }).isLocked)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        const name = await this.nameOf(change.albumId);
        if (name !== undefined) {
          skipped.push(name);
        }
      } else {
        reversed += 1;
      }
    }
    return { reversed, skipped };
  }

  /**
   * Restores merged-away albums. The album and its rows were never touched, but phones forgot them when
   * they saw it deleted, so each member is treated as newly added and gets the album's photos again.
   */
  async reverseSoftDelete(changes: AlbumChangeRow[]): Promise<AlbumChangeReversal> {
    let reversed = 0;
    for (const change of changes) {
      if (!change.albumId) {
        continue;
      }
      const result = await this.db
        .updateTable('album')
        .set({ deletedAt: null })
        .where('id', '=', change.albumId)
        .where('deletedAt', 'is not', null)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        continue;
      }
      await sql`UPDATE album_user SET "createId" = immich_uuid_v7() WHERE "albumId" = ${change.albumId}::uuid`.execute(
        this.db,
      );
      reversed += 1;
    }
    return { reversed, skipped: [] };
  }
}
