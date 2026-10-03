import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { AlbumKind, AssetFileType, AssetLockReason, AssetOrder } from 'src/enum.js';
import { lockPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';

/** What kind of copy an origin row describes (FL-326, spec §4.2). */
export type OriginKind = 'asset' | 'album';

/**
 * Fields a copy follows from its source until its owner changes them. `isFavorite` and trash are never
 * here: they are always the copy owner's own (spec §4.2).
 */
export enum AssetOriginField {
  Description = 'description',
  Location = 'location',
  DateTimeOriginal = 'dateTimeOriginal',
  Rating = 'rating',
  Tags = 'tags',
  Faces = 'faces',
  Visibility = 'visibility',
  Sensitive = 'sensitive',
}

export enum AlbumOriginField {
  Title = 'title',
  Description = 'description',
  Membership = 'membership',
  Cover = 'cover',
}

export type OriginRow = {
  /** The copy: `assetId` or `albumId`. */
  id: string;
  /** The row it was copied from, null once that is gone. */
  sourceId: string | null;
  ownerId: string;
  rootOwnerId: string;
  partnerSharedById: string;
  overriddenFields: string[];
  following: boolean;
};

export type OriginInput = Omit<OriginRow, 'overriddenFields' | 'following'> & { sourceId: string };

/** A person copy, keyed as a person is (owner + person group). */
export type PersonOriginRow = {
  ownerId: string;
  personGroupId: string;
  sourceOwnerId: string;
  sourcePersonGroupId: string;
  rootOwnerId: string;
  partnerSharedById: string;
  overriddenFields: string[];
  following: boolean;
};

export type PersonOriginInput = Omit<PersonOriginRow, 'overriddenFields' | 'following'>;

/** What a partner copy of one asset is made from (spec §4.3). */
export type AssetCopyInput = {
  sourceAssetId: string;
  ownerId: string;
  rootOwnerId: string;
  partnerSharedById: string;
  /** The source's original `physical_file`; the copy links to it, nothing on disk is written. */
  original: { id: string; path: string };
  /**
   * Spec §4.9: the lock the copy carries from the moment it exists (the source's lock reason, or `marked`
   * for an item the sharer's Locked rules hide), inserted in the same transaction as the copy.
   */
  lockReason?: AssetLockReason;
};

/** Why a source may not be copied yet (Task 13 lifts the Locked and sensitive skip). */
export type AssetCopyBlockers = { locked: boolean; sensitive: boolean };

const GENERATED_FILE_TYPES = [
  AssetFileType.Thumbnail,
  AssetFileType.Preview,
  AssetFileType.FullSize,
  AssetFileType.EncodedVideo,
];

const COPY_REFUSAL = 'Partner sharing is unavailable during database handoff';

/** Serializes copies of the same content into the same library (the one-copy rule under concurrency). */
const lockLibraryContent = async (trx: Transaction<DB>, ownerId: string, checksum: Buffer) => {
  const key = createHash('sha1').update(ownerId).update(checksum).digest().readBigInt64BE(0);
  await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
};

export type AlbumForCopy = {
  id: string;
  ownerId: string;
  albumName: string;
  description: string | null;
  order: AssetOrder;
  kind: AlbumKind;
  albumThumbnailAssetId: string | null;
  deletedAt: Date | null;
};

export enum PartnerBackfillState {
  Pending = 'pending',
  Running = 'running',
  Done = 'done',
  Stopped = 'stopped',
}

export type PartnerBackfillRow = {
  sharedById: string;
  sharedWithId: string;
  state: PartnerBackfillState;
  cursor: string | null;
  total: number;
  done: number;
};

const TABLES: Record<OriginKind, { table: string; key: string; source: string; copy: string }> = {
  asset: { table: 'immich_fork.asset_origin', key: 'assetId', source: 'sourceAssetId', copy: 'asset' },
  album: { table: 'immich_fork.album_origin', key: 'albumId', source: 'sourceAlbumId', copy: 'album' },
};

const selectOrigin = (kind: OriginKind) => {
  const { key, source } = TABLES[kind];
  return sql`origin.${sql.id(key)} AS id, origin.${sql.id(source)} AS "sourceId", origin."ownerId",
    origin."rootOwnerId", origin."partnerSharedById", origin."overriddenFields", origin.following`;
};

/**
 * Where a partner's copy came from (FL-326, spec §4.2), in the `immich_fork` origin tables of fork
 * migration 0000000000220, and the resumable backfill of each partnership. The copy engine
 * (`PartnerCopyService`) decides what to copy; this only stores and reads the lineage.
 *
 * A copy whose row is gone is never returned: every read joins the live copy row.
 */
@Injectable()
export class PartnerOriginRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async createOrigin(kind: OriginKind, input: OriginInput, kysely: Kysely<DB> = this.db): Promise<void> {
    const { table, key, source } = TABLES[kind];
    await sql`
      INSERT INTO ${sql.raw(table)} (${sql.id(key)}, ${sql.id(source)}, "ownerId", "rootOwnerId", "partnerSharedById")
      VALUES (${input.id}::uuid, ${input.sourceId}::uuid, ${input.ownerId}::uuid, ${input.rootOwnerId}::uuid,
        ${input.partnerSharedById}::uuid)
      ON CONFLICT (${sql.id(key)}) DO NOTHING
    `.execute(kysely);
  }

  createAssetOrigin(input: OriginInput, kysely: Kysely<DB> = this.db): Promise<void> {
    return this.createOrigin('asset', input, kysely);
  }

  async getOrigin(kind: OriginKind, id: string): Promise<OriginRow | undefined> {
    const { table, key } = TABLES[kind];
    const { rows } = await sql<OriginRow>`
      SELECT ${selectOrigin(kind)} FROM ${sql.raw(table)} origin WHERE origin.${sql.id(key)} = ${id}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /** Every live copy that still follows `sourceId`. */
  async getFollowers(kind: OriginKind, sourceId: string): Promise<OriginRow[]> {
    const { table, key, source, copy } = TABLES[kind];
    const { rows } = await sql<OriginRow>`
      SELECT ${selectOrigin(kind)}
      FROM ${sql.raw(table)} origin
      JOIN ${sql.raw(copy)} copy ON copy.id = origin.${sql.id(key)}
      WHERE origin.${sql.id(source)} = ${sourceId}::uuid AND origin.following
      ORDER BY origin.${sql.id(key)}
    `.execute(this.db);
    return rows;
  }

  /** Of `ids`, those that have at least one live copy following them. */
  async getIdsWithFollowers(kind: OriginKind, ids: string[]): Promise<string[]> {
    const list = [...new Set(ids)];
    if (list.length === 0) {
      return [];
    }
    const { table, key, source, copy } = TABLES[kind];
    const { rows } = await sql<{ id: string }>`
      SELECT DISTINCT origin.${sql.id(source)} AS id
      FROM ${sql.raw(table)} origin
      JOIN ${sql.raw(copy)} copy ON copy.id = origin.${sql.id(key)}
      WHERE origin.${sql.id(source)} = ANY(${list}::uuid[]) AND origin.following
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /**
   * Write the source's current values of these followed fields onto one copy (spec §4.6). Tags and
   * faces are written by the copy engine; favorites and trash are never touched.
   */
  async applyAssetFields(sourceAssetId: string, copyAssetId: string, fields: string[]): Promise<void> {
    const exifColumns = [
      ...(fields.includes(AssetOriginField.Description) ? ['description'] : []),
      ...(fields.includes(AssetOriginField.Location) ? ['latitude', 'longitude', 'city', 'state', 'country'] : []),
      ...(fields.includes(AssetOriginField.DateTimeOriginal) ? ['dateTimeOriginal', 'timeZone'] : []),
      ...(fields.includes(AssetOriginField.Rating) ? ['rating'] : []),
    ];
    const assetColumns = [
      ...(fields.includes(AssetOriginField.DateTimeOriginal) ? ['fileCreatedAt', 'localDateTime'] : []),
      ...(fields.includes(AssetOriginField.Visibility) ? ['visibility'] : []),
    ];
    if (exifColumns.length === 0 && assetColumns.length === 0) {
      return;
    }
    const assignments = (columns: string[]) =>
      sql.join(
        columns.map((column) => sql`${sql.id(column)} = source.${sql.id(column)}`),
        sql`, `,
      );
    await this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, COPY_REFUSAL);
      if (exifColumns.length > 0) {
        await sql`
          UPDATE asset_exif copy SET ${assignments(exifColumns)}
          FROM asset_exif source
          WHERE source."assetId" = ${sourceAssetId}::uuid AND copy."assetId" = ${copyAssetId}::uuid
        `.execute(trx);
      }
      if (assetColumns.length > 0) {
        await sql`
          UPDATE asset copy SET ${assignments(assetColumns)}
          FROM asset source
          WHERE source.id = ${sourceAssetId}::uuid AND copy.id = ${copyAssetId}::uuid
            AND source.visibility <> 'hidden'
        `.execute(trx);
      }
    });
  }

  /** The copy `ownerId` holds of `sourceId`, if any (followed or not). */
  async getCopyId(kind: OriginKind, sourceId: string, ownerId: string): Promise<string | undefined> {
    const { table, key, source, copy } = TABLES[kind];
    const { rows } = await sql<{ id: string }>`
      SELECT origin.${sql.id(key)} AS id
      FROM ${sql.raw(table)} origin
      JOIN ${sql.raw(copy)} copy ON copy.id = origin.${sql.id(key)}
      WHERE origin.${sql.id(source)} = ${sourceId}::uuid AND origin."ownerId" = ${ownerId}::uuid
      LIMIT 1
    `.execute(this.db);
    return rows[0]?.id;
  }

  /**
   * The copy's owner changed these fields: from now on they are theirs (spec §4.6). Only rows that
   * are copies are touched, so callers can pass any ids the user edited. `ownerId` restricts the change
   * to copies that user owns.
   */
  async markOverridden(
    kind: OriginKind,
    ids: string | string[],
    fields: string[],
    ownerId?: string,
    kysely: Kysely<DB> = this.db,
  ): Promise<void> {
    const list = [...new Set(Array.isArray(ids) ? ids : [ids])];
    if (list.length === 0 || fields.length === 0) {
      return;
    }
    const { table, key } = TABLES[kind];
    await sql`
      UPDATE ${sql.raw(table)} origin
      SET "overriddenFields" = ARRAY(
        SELECT DISTINCT field FROM unnest(origin."overriddenFields" || ${fields}::text[]) AS field ORDER BY field
      )
      WHERE origin.${sql.id(key)} = ANY(${list}::uuid[])
        AND NOT (origin."overriddenFields" @> ${fields}::text[])
        ${ownerId ? sql`AND origin."ownerId" = ${ownerId}::uuid` : sql``}
    `.execute(kysely);
  }

  /**
   * A partnership ended (spec §4.7): every copy `ownerId` received through `partnerSharedById` stops
   * following. The copies stay.
   */
  async stopFollowing(partnerSharedById: string, ownerId: string): Promise<void> {
    for (const table of [...Object.values(TABLES).map(({ table }) => table), 'immich_fork.person_origin']) {
      await sql`
        UPDATE ${sql.raw(table)}
        SET following = false
        WHERE "partnerSharedById" = ${partnerSharedById}::uuid AND "ownerId" = ${ownerId}::uuid AND following
      `.execute(this.db);
    }
  }

  async createPersonOrigin(input: PersonOriginInput, kysely: Kysely<DB> = this.db): Promise<void> {
    await sql`
      INSERT INTO immich_fork.person_origin
        ("ownerId", "personGroupId", "sourceOwnerId", "sourcePersonGroupId", "rootOwnerId", "partnerSharedById")
      VALUES (${input.ownerId}::uuid, ${input.personGroupId}::uuid, ${input.sourceOwnerId}::uuid,
        ${input.sourcePersonGroupId}::uuid, ${input.rootOwnerId}::uuid, ${input.partnerSharedById}::uuid)
      ON CONFLICT ("ownerId", "personGroupId") DO NOTHING
    `.execute(kysely);
  }

  /** The person `targetOwnerId` holds as a copy of `sourcePersonGroupId`, if any. */
  async getPersonMapping(targetOwnerId: string, sourcePersonGroupId: string): Promise<PersonOriginRow | undefined> {
    const { rows } = await sql<PersonOriginRow>`
      SELECT origin."ownerId", origin."personGroupId", origin."sourceOwnerId", origin."sourcePersonGroupId",
        origin."rootOwnerId", origin."partnerSharedById", origin."overriddenFields", origin.following
      FROM immich_fork.person_origin origin
      JOIN person ON person."ownerId" = origin."ownerId" AND person."personGroupId" = origin."personGroupId"
      WHERE origin."ownerId" = ${targetOwnerId}::uuid AND origin."sourcePersonGroupId" = ${sourcePersonGroupId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /** Every live person copy that still follows the source person. */
  async getPersonFollowers(sourceOwnerId: string, sourcePersonGroupId: string): Promise<PersonOriginRow[]> {
    const { rows } = await sql<PersonOriginRow>`
      SELECT origin."ownerId", origin."personGroupId", origin."sourceOwnerId", origin."sourcePersonGroupId",
        origin."rootOwnerId", origin."partnerSharedById", origin."overriddenFields", origin.following
      FROM immich_fork.person_origin origin
      JOIN person ON person."ownerId" = origin."ownerId" AND person."personGroupId" = origin."personGroupId"
      WHERE origin."sourceOwnerId" = ${sourceOwnerId}::uuid
        AND origin."sourcePersonGroupId" = ${sourcePersonGroupId}::uuid AND origin.following
      ORDER BY origin."ownerId"
    `.execute(this.db);
    return rows;
  }

  async markPersonOverridden(ownerId: string, personGroupIds: string[], fields: string[]): Promise<void> {
    if (personGroupIds.length === 0 || fields.length === 0) {
      return;
    }
    await sql`
      UPDATE immich_fork.person_origin origin
      SET "overriddenFields" = ARRAY(
        SELECT DISTINCT field FROM unnest(origin."overriddenFields" || ${fields}::text[]) AS field ORDER BY field
      )
      WHERE origin."ownerId" = ${ownerId}::uuid AND origin."personGroupId" = ANY(${personGroupIds}::uuid[])
        AND NOT (origin."overriddenFields" @> ${fields}::text[])
    `.execute(this.db);
  }

  /**
   * The one-copy rule (spec §4.3): whether `ownerId`'s library already holds this content, live or in
   * their trash.
   */
  async libraryHasChecksum(ownerId: string, checksum: Buffer): Promise<boolean> {
    const { rows } = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM asset WHERE "ownerId" = ${ownerId}::uuid AND checksum = ${checksum}
      ) AS present
    `.execute(this.db);
    return rows[0]?.present ?? false;
  }

  /** Locked or sensitive evidence on a source, from either store (positive evidence anywhere counts). */
  async getCopyBlockers(assetId: string): Promise<AssetCopyBlockers> {
    const { rows } = await sql<AssetCopyBlockers>`
      SELECT
        (asset.visibility = 'locked' OR EXISTS (SELECT 1 FROM asset_lock WHERE asset_lock."assetId" = asset.id)) AS locked,
        (asset.is_nsfw OR EXISTS (
          SELECT 1 FROM immich_fork.asset_privacy privacy WHERE privacy."assetId" = asset.id AND privacy."isNsfw"
        )) AS sensitive
      FROM asset
      WHERE asset.id = ${assetId}::uuid
    `.execute(this.db);
    return rows[0] ?? { locked: false, sensitive: false };
  }

  /**
   * Create `ownerId`'s copy of one asset (spec §4.3): a new asset row of theirs linked to the source's
   * original and generated files, with the source's exif, smart-search embedding, OCR and job status
   * (so no machine learning runs again), and its `asset_origin` row. All in one transaction that holds
   * the file paths' locks (so a concurrent FileDelete cannot count a path unreferenced in between) and
   * a per-library content lock, re-checking the one-copy rule under it.
   *
   * Favorites, trash, stacks, duplicates, edits and the Live Photo pairing are never copied: the copy
   * starts as the owner's own unedited, unfavorited item. The library is charged the full file size.
   *
   * Returns the copy's id, or undefined when the library already holds the content.
   */
  async insertAssetCopy(input: AssetCopyInput): Promise<string | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await lockPublicForkWrites(trx, COPY_REFUSAL);
      const source = await trx.selectFrom('asset').selectAll().where('id', '=', input.sourceAssetId).executeTakeFirst();
      if (!source) {
        return;
      }

      const files = await trx
        .selectFrom('asset_file')
        .selectAll()
        .where('assetId', '=', source.id)
        .where('isEdited', '=', false)
        .where('type', 'in', GENERATED_FILE_TYPES)
        .execute();
      for (const path of [...new Set([input.original.path, ...files.map((file) => file.path)])].toSorted()) {
        await lockFilePath(trx, path);
      }

      const physical = await trx
        .selectFrom('physical_file')
        .select('id')
        .where('id', '=', input.original.id)
        .where('path', '=', input.original.path)
        .executeTakeFirst();
      if (!physical) {
        throw new ConflictException('Partner copy source file changed');
      }

      await lockLibraryContent(trx, input.ownerId, source.checksum);
      const existing = await trx
        .selectFrom('asset')
        .select('id')
        .where('ownerId', '=', input.ownerId)
        .where('checksum', '=', source.checksum)
        .executeTakeFirst();
      if (existing) {
        return;
      }

      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        updateId: _updateId,
        ...columns
      } = source as typeof source & { createId?: string };
      delete (columns as { createId?: string }).createId;
      const copy = await trx
        .insertInto('asset')
        .values({
          ...columns,
          ownerId: input.ownerId,
          originalPath: input.original.path,
          physicalOriginalFileId: input.original.id,
          libraryId: null,
          isExternal: false,
          isOffline: false,
          isFavorite: false,
          isEdited: false,
          deletedAt: null,
          stackId: null,
          duplicateId: null,
          livePhotoVideoId: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (input.lockReason) {
        // a brand-new row with no stack or Live Photo pairing yet: the lock record alone locks it
        await trx
          .insertInto('asset_lock')
          .values({ assetId: copy.id, reason: input.lockReason, lockedBy: null })
          .execute();
      }

      const exif = await trx.selectFrom('asset_exif').selectAll().where('assetId', '=', source.id).executeTakeFirst();
      if (exif) {
        const { updatedAt: _exifUpdatedAt, updateId: _exifUpdateId, ...exifColumns } = exif;
        await trx
          .insertInto('asset_exif')
          .values({ ...exifColumns, assetId: copy.id })
          .execute();
      }

      if (files.length > 0) {
        await trx
          .insertInto('asset_file')
          .values(
            files.map((file) => ({
              assetId: copy.id,
              type: file.type,
              path: file.path,
              physicalFileId: file.physicalFileId,
              isProgressive: file.isProgressive,
              isTransparent: file.isTransparent,
            })),
          )
          .execute();
      }

      await sql`
        INSERT INTO smart_search ("assetId", embedding)
        SELECT ${copy.id}::uuid, embedding FROM smart_search WHERE "assetId" = ${source.id}::uuid
      `.execute(trx);
      const ocr = await trx.selectFrom('asset_ocr').selectAll().where('assetId', '=', source.id).execute();
      if (ocr.length > 0) {
        await trx
          .insertInto('asset_ocr')
          .values(
            ocr.map(({ id: _ocrId, updatedAt: _ocrUpdatedAt, updateId: _ocrUpdateId, ...row }) => ({
              ...row,
              assetId: copy.id,
            })),
          )
          .execute();
      }
      await sql`
        INSERT INTO ocr_search ("assetId", text)
        SELECT ${copy.id}::uuid, text FROM ocr_search WHERE "assetId" = ${source.id}::uuid
      `.execute(trx);
      const jobStatus = await trx
        .selectFrom('asset_job_status')
        .selectAll()
        .where('assetId', '=', source.id)
        .executeTakeFirst();
      await trx
        .insertInto('asset_job_status')
        .values({ ...jobStatus, assetId: copy.id })
        .onConflict((oc) => oc.column('assetId').doNothing())
        .execute();
      // the fork's checksum evidence names the same file, so the copy carries it too
      await sql`
        INSERT INTO immich_fork.asset_checksum
        SELECT (jsonb_populate_record(NULL::immich_fork.asset_checksum,
          to_jsonb(checksum) || jsonb_build_object('assetId', ${copy.id}::uuid))).*
        FROM immich_fork.asset_checksum checksum
        WHERE checksum."assetId" = ${source.id}::uuid
        ON CONFLICT DO NOTHING
      `.execute(trx);

      await this.createAssetOrigin(
        {
          id: copy.id,
          sourceId: source.id,
          ownerId: input.ownerId,
          rootOwnerId: input.rootOwnerId,
          partnerSharedById: input.partnerSharedById,
        },
        trx,
      );

      // spec §4.3: every library is charged the full size; copying never fails on quota
      await sql`
        UPDATE "user"
        SET "quotaUsageInBytes" = "quotaUsageInBytes" + coalesce(${exif?.fileSizeInByte ?? null}::bigint, 0)
        WHERE id = ${input.ownerId}::uuid
      `.execute(trx);

      return copy.id;
    });
  }

  /** One page of `ownerId`'s assets after `cursor`, in id order, for the backfill. */
  async getOwnerAssetIdsAfter(ownerId: string, cursor: string | null, limit: number): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT id FROM asset
      WHERE "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
        ${cursor ? sql`AND id > ${cursor}::uuid` : sql``}
      ORDER BY id
      LIMIT ${limit}
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  async countOwnerAssets(ownerId: string): Promise<number> {
    const { rows } = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM asset WHERE "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
    `.execute(this.db);
    return rows[0]?.count ?? 0;
  }

  /** An album as the copy engine needs it, with its owner (spec §4.4). */
  async getAlbumForCopy(albumId: string): Promise<AlbumForCopy | undefined> {
    const { rows } = await sql<AlbumForCopy>`
      SELECT album.id, owner."userId" AS "ownerId", album."albumName", album.description, album."order",
        album.kind, album."albumThumbnailAssetId", album."deletedAt"
      FROM album
      JOIN album_user owner ON owner."albumId" = album.id AND owner.role = 'owner'
      WHERE album.id = ${albumId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /** The plain albums `ownerId` owns, for the backfill. Collections and shared spaces are not copied. */
  async getOwnedAlbumIds(ownerId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT album.id
      FROM album
      JOIN album_user owner ON owner."albumId" = album.id AND owner.role = 'owner'
      WHERE owner."userId" = ${ownerId}::uuid AND album."deletedAt" IS NULL AND album.kind = 'album'
      ORDER BY album.id
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /** Whether `userId` already sees this album (any membership, owners included). */
  async isAlbumMember(albumId: string, userId: string): Promise<boolean> {
    const { rows } = await sql<{ present: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM album_user WHERE "albumId" = ${albumId}::uuid AND "userId" = ${userId}::uuid
      ) AS present
    `.execute(this.db);
    return rows[0]?.present ?? false;
  }

  /** `ownerId`'s copies of the items in `sourceAlbumId`, in the source album's order of addition. */
  async getAlbumAssetCopyIds(sourceAlbumId: string, ownerId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT DISTINCT origin."assetId" AS id
      FROM album_asset
      JOIN immich_fork.asset_origin origin ON origin."sourceAssetId" = album_asset."assetId"
        AND origin."ownerId" = ${ownerId}::uuid
      JOIN asset copy ON copy.id = origin."assetId" AND copy."deletedAt" IS NULL
      WHERE album_asset."albumId" = ${sourceAlbumId}::uuid
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /** The items in an album. */
  async getAlbumAssetIds(albumId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT "assetId" AS id FROM album_asset WHERE "albumId" = ${albumId}::uuid
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  /**
   * `ownerId`'s album copies whose membership still follows a source album holding `sourceAssetId`: a
   * new copy of that item belongs in them (spec §4.4).
   */
  async getFollowingAlbumCopiesHolding(sourceAssetId: string, ownerId: string): Promise<string[]> {
    const { rows } = await sql<{ id: string }>`
      SELECT origin."albumId" AS id
      FROM immich_fork.album_origin origin
      JOIN album copy ON copy.id = origin."albumId" AND copy."deletedAt" IS NULL
      JOIN album_asset ON album_asset."albumId" = origin."sourceAlbumId"
        AND album_asset."assetId" = ${sourceAssetId}::uuid
      WHERE origin."ownerId" = ${ownerId}::uuid AND origin.following
        AND NOT (${AlbumOriginField.Membership} = ANY(origin."overriddenFields"))
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }

  async getBackfill(sharedById: string, sharedWithId: string): Promise<PartnerBackfillRow | undefined> {
    const { rows } = await sql<PartnerBackfillRow>`
      SELECT "sharedById", "sharedWithId", state, cursor, total, done
      FROM immich_fork.partner_backfill
      WHERE "sharedById" = ${sharedById}::uuid AND "sharedWithId" = ${sharedWithId}::uuid
    `.execute(this.db);
    return rows[0];
  }

  /** Start (or restart from the beginning) a partnership's backfill. */
  async startBackfill(sharedById: string, sharedWithId: string, total: number): Promise<void> {
    await sql`
      INSERT INTO immich_fork.partner_backfill ("sharedById", "sharedWithId", state, cursor, total, done)
      VALUES (${sharedById}::uuid, ${sharedWithId}::uuid, ${PartnerBackfillState.Pending}, NULL, ${total}, 0)
      ON CONFLICT ("sharedById", "sharedWithId") DO UPDATE
      SET state = excluded.state, cursor = NULL, total = excluded.total, done = 0, "updatedAt" = clock_timestamp()
    `.execute(this.db);
  }

  /** Record a finished batch: the cursor only moves forward and `done` never shrinks. */
  async advanceBackfill(
    sharedById: string,
    sharedWithId: string,
    update: { cursor: string | null; processed: number; state: PartnerBackfillState },
  ): Promise<void> {
    await sql`
      UPDATE immich_fork.partner_backfill
      SET cursor = coalesce(${update.cursor}::uuid, cursor),
        done = done + ${update.processed},
        total = GREATEST(total, done + ${update.processed}),
        state = ${update.state},
        "updatedAt" = clock_timestamp()
      WHERE "sharedById" = ${sharedById}::uuid AND "sharedWithId" = ${sharedWithId}::uuid
        AND state <> ${PartnerBackfillState.Stopped}
        AND (cursor IS NULL OR ${update.cursor}::uuid IS NULL OR ${update.cursor}::uuid > cursor)
    `.execute(this.db);
  }

  async stopBackfill(sharedById: string, sharedWithId: string): Promise<void> {
    await sql`
      UPDATE immich_fork.partner_backfill
      SET state = ${PartnerBackfillState.Stopped}, "updatedAt" = clock_timestamp()
      WHERE "sharedById" = ${sharedById}::uuid AND "sharedWithId" = ${sharedWithId}::uuid
    `.execute(this.db);
  }

  /**
   * FL-326 (spec §5.2, partner-people-locked): the "From {owner}'s library" label of `ownerId`'s own copies
   * among `ids`: the original uploader's id and current name. Copies of other owners are never labelled.
   */
  async getOriginLabels(
    kind: OriginKind,
    ids: string[],
    ownerId: string,
  ): Promise<Map<string, { rootOwnerId: string; rootOwnerName: string }>> {
    if (ids.length === 0) {
      return new Map();
    }
    const { table, key } = TABLES[kind];
    const { rows } = await sql<{ id: string; rootOwnerId: string; rootOwnerName: string }>`
      SELECT origin.${sql.id(key)} AS id, origin."rootOwnerId", root.name AS "rootOwnerName"
      FROM ${sql.raw(table)} origin
      JOIN public."user" root ON root.id = origin."rootOwnerId"
      WHERE origin.${sql.id(key)} = ANY(${ids}::uuid[]) AND origin."ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    return new Map(rows.map(({ id, rootOwnerId, rootOwnerName }) => [id, { rootOwnerId, rootOwnerName }]));
  }

  /** Partnerships that have never been backfilled (existing ones at upgrade, spec §4.7). */
  async getPartnershipsWithoutBackfill(): Promise<{ sharedById: string; sharedWithId: string }[]> {
    const { rows } = await sql<{ sharedById: string; sharedWithId: string }>`
      SELECT partner."sharedById", partner."sharedWithId"
      FROM partner
      WHERE partner."sharedById" <> partner."sharedWithId"
        AND NOT EXISTS (
          SELECT 1 FROM immich_fork.partner_backfill backfill
          WHERE backfill."sharedById" = partner."sharedById" AND backfill."sharedWithId" = partner."sharedWithId"
        )
      ORDER BY partner."sharedById", partner."sharedWithId"
    `.execute(this.db);
    return rows;
  }
}
