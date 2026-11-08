import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { ChunkedArray, DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { AlbumChangeRunKind, AlbumChangeRunStatus } from 'src/schema/tables/album-change-run.table.js';

/** One change to record; `kind` names the reverser that undoes it. */
export interface AlbumChangeInput {
  kind: string;
  albumId?: string | null;
  assetId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** One recorded change, as a reverser receives it. */
export interface AlbumChangeRow {
  runId: string;
  seq: number;
  kind: string;
  albumId: string | null;
  assetId: string | null;
  before: unknown;
  after: unknown;
}

/** What undoing a group of changes did. */
export interface AlbumChangeReversal {
  /** Changes actually taken back. */
  reversed: number;
  /** What was left alone because the person changed it after the run: names, shown to them as they are. */
  skipped: string[];
  /** Albums whose photos changed, for the partners and members following them. */
  membershipAlbumIds?: string[];
}

export interface AlbumChangeRunRow {
  id: string;
  userId: string;
  kind: AlbumChangeRunKind;
  status: AlbumChangeRunStatus;
  createdAt: Date;
  undoneAt: Date | null;
  summary: Record<string, unknown>;
}

/** The change kind that soft-deletes an album. The nightly purge looks for it. */
export const ALBUM_CHANGE_SOFT_DELETED = 'album.soft_deleted';

const jsonb = (value: unknown) => (value === undefined ? sql<unknown>`null` : sql<unknown>`${value}::jsonb`);

/** FL-1298: the run record behind Undo for merges, cleanups and date healing. */
@Injectable()
export class AlbumChangeRunRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** A write spanning a run and the changes it makes, committed together. */
  transaction<T>(fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(fn);
  }

  async createRun(
    tx: Kysely<DB>,
    { userId, kind, summary = {} }: { userId: string; kind: AlbumChangeRunKind; summary?: Record<string, unknown> },
  ): Promise<string> {
    const { id } = await tx
      .insertInto('album_change_run')
      .values({ userId, kind, summary: jsonb(summary) as never })
      .returning('id')
      .executeTakeFirstOrThrow();
    return id;
  }

  async finishRun(
    tx: Kysely<DB>,
    id: string,
    status: AlbumChangeRunStatus,
    summary?: Record<string, unknown>,
  ): Promise<void> {
    await tx
      .updateTable('album_change_run')
      .set({ status, ...(summary && { summary: jsonb(summary) as never }) })
      .where('id', '=', id)
      .execute();
  }

  /** Appends one change. The run row is held so that a run's sequence never collides. */
  async recordChange(tx: Kysely<DB>, runId: string, change: AlbumChangeInput): Promise<number> {
    await tx.selectFrom('album_change_run').select('id').where('id', '=', runId).forNoKeyUpdate().execute();
    const { rows } = await sql<{ seq: number }>`
      INSERT INTO album_change ("runId", seq, kind, "albumId", "assetId", before, after)
      SELECT ${runId}::uuid, coalesce(max(seq), 0) + 1, ${change.kind}, ${change.albumId ?? null}::uuid,
        ${change.assetId ?? null}::uuid, ${jsonb(change.before)}, ${jsonb(change.after)}
      FROM album_change WHERE "runId" = ${runId}::uuid
      RETURNING seq
    `.execute(tx);
    return rows[0].seq;
  }

  /** A person's newest run they have not undone, while it can still be undone. */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  getLatest(userId: string, since: Date): Promise<AlbumChangeRunRow | undefined> {
    return this.latest(this.db, userId, since).executeTakeFirst();
  }

  getLatestForUpdate(tx: Kysely<DB>, userId: string, since: Date): Promise<AlbumChangeRunRow | undefined> {
    return this.latest(tx, userId, since).forUpdate().executeTakeFirst();
  }

  private latest(db: Kysely<DB>, userId: string, since: Date) {
    return db
      .selectFrom('album_change_run')
      .selectAll()
      .where('userId', '=', userId)
      .where('undoneAt', 'is', null)
      .where('status', '!=', AlbumChangeRunStatus.Undone)
      .where('createdAt', '>=', since)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .$castTo<AlbumChangeRunRow>();
  }

  /** The changes before `beforeSeq`, newest first, one page at a time. */
  @GenerateSql({ params: [DummyValue.UUID, 1000, 5000] })
  getChanges(runId: string, beforeSeq: number | undefined, limit: number, tx: Kysely<DB> = this.db) {
    return tx
      .selectFrom('album_change')
      .selectAll()
      .where('runId', '=', runId)
      .$if(beforeSeq !== undefined, (qb) => qb.where('seq', '<', beforeSeq!))
      .orderBy('seq', 'desc')
      .limit(limit)
      .$castTo<AlbumChangeRow>()
      .execute();
  }

  async markUndone(tx: Kysely<DB>, id: string): Promise<void> {
    await tx
      .updateTable('album_change_run')
      .set({ status: AlbumChangeRunStatus.Undone, undoneAt: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Who should hear that these albums changed; albums deleted since have no members left to tell. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedArray()
  async getAlbumMembers(albumIds: string[]): Promise<{ albumId: string; userId: string }[]> {
    if (albumIds.length === 0) {
      return [];
    }
    return this.db.selectFrom('album_user').select(['albumId', 'userId']).where('albumId', 'in', albumIds).execute();
  }

  /** Albums a run older than the Undo window soft-deleted, which can now go for good. */
  @GenerateSql({ params: [DummyValue.DATE] })
  async getPurgeableAlbumIds(before: Date): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_change')
      .innerJoin('album_change_run', 'album_change_run.id', 'album_change.runId')
      .innerJoin('album', 'album.id', 'album_change.albumId')
      .where('album_change.kind', '=', ALBUM_CHANGE_SOFT_DELETED)
      .where('album_change_run.createdAt', '<', before)
      .where('album_change_run.status', '!=', AlbumChangeRunStatus.Undone)
      .where('album.deletedAt', 'is not', null)
      // FL-1300: a removed album that a phone or a Takeout folder still names stays as the marker that keeps it gone.
      .where(
        sql<boolean>`not exists (select 1 from album_source_link link where link."albumId" = album.id and link."stayRemoved")`,
      )
      .where(sql<boolean>`not exists (select 1 from takeout_album mapping where mapping."albumId" = album.id)`)
      .select('album.id')
      .distinct()
      .execute();
    return rows.map(({ id }) => id);
  }

  /** Forgets runs past the Undo window, with their changes. */
  @GenerateSql({ params: [DummyValue.DATE] })
  async deleteRunsBefore(before: Date): Promise<number> {
    const { numDeletedRows } = await this.db
      .deleteFrom('album_change_run')
      .where('createdAt', '<', before)
      .executeTakeFirst();
    return Number(numDeletedRows);
  }
}
