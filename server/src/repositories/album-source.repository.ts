import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AlbumSourceKind, type AlbumSourceLink } from 'src/dtos/album-source.dto.js';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import { DB } from 'src/schema/index.js';

type Db = Kysely<DB> | Transaction<DB> | null;

/** A stored link, with its album when that album still exists, is not deleted and is still the owner's. */
export type StoredAlbumSourceLink = Omit<AlbumSourceLink, 'albumName'> & { albumName: string | null };

const LINK_COLUMNS = sql`link.id, link."userId", link."albumId", link."sourceKind", link."sourceId", link."deviceKey",
  link."lastSourceName", link."createdAt", link."updatedAt"`;

/** The album is live and owned by the link's user. */
const LIVE_ALBUM = sql`
  album.id = link."albumId" AND album."deletedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM public.album_user owner
    WHERE owner."albumId" = album.id AND owner."userId" = link."userId" AND owner.role = ${AlbumUserRole.Owner}
  )`;

/**
 * FL-331 (NAPI-015): album source links and the memberships their sync added (`public.album_source_link`,
 * `public.album_source_asset`) in the canonical Frameleaf database.
 */
@Injectable()
export class AlbumSourceRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Runs `fn` in one transaction holding the given advisory locks (taken in sorted
   * order so two callers never deadlock), so two devices resolving the same source, or two sources with the
   * same name, are serialized.
   */
  withLocks<T>(keys: string[], fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      for (const key of [...new Set(keys)].toSorted()) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
      }
      return fn(tx);
    });
  }

  /** A write in its own transaction. */
  write<T>(fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      return fn(tx);
    });
  }

  async getBySource(
    db: Db,
    userId: string,
    source: { kind: AlbumSourceKind; sourceId: string; deviceKey: string | null },
  ): Promise<StoredAlbumSourceLink | undefined> {
    const { rows } = await sql<StoredAlbumSourceLink>`
      SELECT ${LINK_COLUMNS}, album."albumName"
      FROM public.album_source_link link
      LEFT JOIN public.album album ON ${LIVE_ALBUM}
      WHERE link."userId" = ${userId}::uuid AND link."sourceKind" = ${source.kind} AND link."sourceId" = ${source.sourceId}
        AND COALESCE(link."deviceKey", '') = ${source.deviceKey ?? ''}
    `.execute(db ?? this.db);
    return rows[0];
  }

  async get(db: Db, userId: string, id: string): Promise<StoredAlbumSourceLink | undefined> {
    const { rows } = await sql<StoredAlbumSourceLink>`
      SELECT ${LINK_COLUMNS}, album."albumName"
      FROM public.album_source_link link
      LEFT JOIN public.album album ON ${LIVE_ALBUM}
      WHERE link.id = ${id}::uuid AND link."userId" = ${userId}::uuid
    `.execute(db ?? this.db);
    return rows[0];
  }

  /** The user's links whose album is live, oldest first. */
  async getAll(db: Db, userId: string): Promise<AlbumSourceLink[]> {
    const { rows } = await sql<AlbumSourceLink>`
      SELECT ${LINK_COLUMNS}, album."albumName"
      FROM public.album_source_link link
      JOIN public.album album ON ${LIVE_ALBUM}
      WHERE link."userId" = ${userId}::uuid
      ORDER BY link."createdAt", link.id
    `.execute(db ?? this.db);
    return rows;
  }

  /**
   * The user's oldest live plain album whose trimmed, case-insensitive name equals `name`. Partner copies
   * (`album_origin`) follow their source and are never merged into.
   */
  async findOwnedAlbumByName(db: Db, userId: string, name: string): Promise<{ id: string } | undefined> {
    const { rows } = await sql<{ id: string }>`
      SELECT album.id
      FROM public.album album
      JOIN public.album_user owner ON owner."albumId" = album.id AND owner."userId" = ${userId}::uuid
        AND owner.role = ${AlbumUserRole.Owner}
      WHERE album."deletedAt" IS NULL AND album.kind = ${AlbumKind.Album}
        AND lower(btrim(album."albumName")) = lower(btrim(${name}))
        AND NOT EXISTS (SELECT 1 FROM public.album_origin origin WHERE origin."albumId" = album.id)
      ORDER BY album."createdAt", album.id
      LIMIT 1
    `.execute(db ?? this.db);
    return rows[0];
  }

  async create(
    db: Db,
    link: {
      userId: string;
      albumId: string;
      kind: AlbumSourceKind;
      sourceId: string;
      deviceKey: string | null;
      name: string;
    },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.album_source_link ("userId", "albumId", "sourceKind", "sourceId", "deviceKey", "lastSourceName")
      VALUES (${link.userId}::uuid, ${link.albumId}::uuid, ${link.kind}, ${link.sourceId}, ${link.deviceKey}, ${link.name})
      RETURNING id
    `.execute(db ?? this.db);
    return rows[0].id;
  }

  async update(db: Db, id: string, values: { lastSourceName: string; sourceId?: string }): Promise<void> {
    await sql`
      UPDATE public.album_source_link
      SET "lastSourceName" = ${values.lastSourceName}, "sourceId" = COALESCE(${values.sourceId ?? null}, "sourceId"),
        "updatedAt" = clock_timestamp()
      WHERE id = ${id}::uuid
    `.execute(db ?? this.db);
  }

  /** Deletes the link and, by cascade, the memberships its sync recorded. */
  async delete(db: Db, id: string): Promise<void> {
    await sql`DELETE FROM public.album_source_link WHERE id = ${id}::uuid`.execute(db ?? this.db);
  }

  /** Which of `assetIds` are memberships of `albumId` that any of the user's links recorded. */
  async getRecordedAssetIds(db: Db, albumId: string, assetIds: string[], linkId?: string): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }
    const { rows } = await sql<{ assetId: string }>`
      SELECT provenance."assetId"
      FROM public.album_source_asset provenance
      JOIN public.album_source_link link ON link.id = provenance."linkId"
      JOIN public.album_asset member ON member."albumId" = link."albumId"
        AND member."assetId" = provenance."assetId" AND member."updateId" = provenance."membershipUpdateId"
      WHERE link."albumId" = ${albumId}::uuid AND provenance."assetId" = ANY(${assetIds}::uuid[])
        ${linkId ? sql`AND provenance."linkId" = ${linkId}::uuid` : sql``}
      ORDER BY member."assetId"
      FOR UPDATE OF member
    `.execute(db ?? this.db);
    return new Set(rows.map(({ assetId }) => assetId));
  }

  async record(db: Db, linkId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      INSERT INTO public.album_source_asset ("linkId", "assetId", "membershipUpdateId")
      SELECT link.id, member."assetId", member."updateId"
      FROM public.album_source_link link
      JOIN public.album_asset member ON member."albumId" = link."albumId"
      WHERE link.id = ${linkId}::uuid AND member."assetId" = ANY(${assetIds}::uuid[])
      ORDER BY member."assetId"
      FOR UPDATE OF member
      ON CONFLICT ("linkId", "assetId") DO UPDATE
        SET "membershipUpdateId" = excluded."membershipUpdateId", "addedAt" = clock_timestamp()
    `.execute(db ?? this.db);
  }

  async unrecord(db: Db, linkId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }
    await sql`
      DELETE FROM public.album_source_asset
      WHERE "linkId" = ${linkId}::uuid AND "assetId" = ANY(${assetIds}::uuid[])
    `.execute(db ?? this.db);
  }
}
