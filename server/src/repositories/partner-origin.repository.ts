import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { AlbumKind, AssetFileType, AssetLockReason, AssetOrder } from 'src/enum.js';

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
export type OriginInput = Omit<OriginRow, 'overriddenFields' | 'following'> & {
  sourceId: string;
};
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
export type PersonCopyInput = Omit<PersonOriginInput, 'personGroupId'> & {
  name: string;
  birthDate: Date | null;
  isHidden: boolean;
};
export type PersonCopyUndo = { correctionId: string; personGroupId: string; faceIds: string[] };
export type PersonCopyResult = { personGroupId: string } | { conflict: 'already-undone' | 'person-gone' };
/** What a partner copy of one asset is made from (spec §4.3). */
export type AssetCopyInput = {
  sourceAssetId: string;
  ownerId: string;
  rootOwnerId: string;
  partnerSharedById: string;
  /** The source's original `physical_file`; the copy links to it, nothing on disk is written. */
  original: {
    id: string;
    path: string;
  };
  /**
   * Spec §4.9: the lock the copy carries from the moment it exists (the source's lock reason, or `marked`
   * for an item the sharer's Locked rules hide), inserted in the same transaction as the copy.
   */
  lockReason?: AssetLockReason;
};
/** Why a source may not be copied yet (Task 13 lifts the Locked and sensitive skip). */
export type AssetCopyBlockers = {
  locked: boolean;
  sensitive: boolean;
};
const GENERATED_FILE_TYPES = [
  AssetFileType.Thumbnail,
  AssetFileType.Preview,
  AssetFileType.FullSize,
  AssetFileType.EncodedVideo,
];
/** Copies form chains (A→B→C…); lineage walks stop here, far beyond any real chain, as a guard. */
const MAX_LINEAGE_DEPTH = 64;
/**
 * Whether `sharedById` still shares with `sharedWithId`, holding the partner row FOR SHARE until the
 * caller's transaction ends: `PartnerService.remove` deletes that row before it stops following, so a copy
 * either commits first (and then stops following with the rest) or sees no partnership and is not made.
 */
const lockPartnership = async (trx: Transaction<DB>, sharedById: string, sharedWithId: string) => {
  const { rows } = await sql<{
    present: number;
  }>`
    SELECT 1 AS present FROM partner
    WHERE "sharedById" = ${sharedById}::uuid AND "sharedWithId" = ${sharedWithId}::uuid
    FOR SHARE
  `.execute(trx);
  return rows.length > 0;
};
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
const TABLES: Record<
  OriginKind,
  {
    table: string;
    key: string;
    source: string;
    copy: string;
  }
> = {
  asset: { table: 'public.asset_origin', key: 'assetId', source: 'sourceAssetId', copy: 'asset' },
  album: { table: 'public.album_origin', key: 'albumId', source: 'sourceAlbumId', copy: 'album' },
};
const selectOrigin = (kind: OriginKind) => {
  const { key, source } = TABLES[kind];
  return sql`origin.${sql.id(key)} AS id, origin.${sql.id(source)} AS "sourceId", origin."ownerId",
    origin."rootOwnerId", origin."partnerSharedById", origin."overriddenFields", origin.following`;
};
/**
 * Where a partner's copy came from (FL-326, spec §4.2), in the public origin tables,
 * and the resumable backfill of each partnership. The copy engine
 * (`PartnerCopyService`) decides what to copy; this only stores and reads the lineage.
 *
 * A copy whose row is gone is never returned: every read joins the live copy row.
 */
@Injectable()
export class PartnerOriginRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  async createOrigin(kind: OriginKind, input: OriginInput, kysely: Kysely<DB> = this.db): Promise<void> {
    const { table, key, source } = TABLES[kind];
    await sql`
      INSERT INTO ${sql.raw(table)} (${sql.id(key)}, ${sql.id(source)}, "ownerId", "rootOwnerId", "partnerSharedById")
      VALUES (${input.id}::uuid, ${input.sourceId}::uuid, ${input.ownerId}::uuid, ${input.rootOwnerId}::uuid,
        ${input.partnerSharedById}::uuid)
      ON CONFLICT (${sql.id(key)}) DO NOTHING
    `.execute(kysely);
  }
  /**
   * Record an album copy's origin, only while its partnership still exists (held FOR SHARE, see
   * `lockPartnership`). Returns false when the partnership has ended: the caller removes the album copy.
   */
  async createAlbumOriginIfPartnered(input: OriginInput): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPartnership(trx, input.partnerSharedById, input.ownerId))) {
        return false;
      }
      await this.createOrigin('album', input, trx);
      return true;
    });
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
    const { rows } = await sql<{
      id: string;
    }>`
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
    const { rows } = await sql<{
      id: string;
    }>`
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
    for (const table of [...Object.values(TABLES).map(({ table }) => table), 'public.person_origin']) {
      await sql`
        UPDATE ${sql.raw(table)}
        SET following = false
        WHERE "partnerSharedById" = ${partnerSharedById}::uuid AND "ownerId" = ${ownerId}::uuid AND following
      `.execute(this.db);
    }
  }
  /** One live recipient identity per source; allocation, lineage, mapping and undo share this connection. */
  async createPersonCopy(input: PersonCopyInput, undo?: PersonCopyUndo): Promise<PersonCopyResult> {
    return this.db.transaction().execute(async (tx) => {
      const key = createHash('sha1')
        .update('partner-person-copy\0')
        .update(input.ownerId)
        .update(input.sourcePersonGroupId)
        .digest()
        .readBigInt64BE(0);
      await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(tx);
      if (undo) {
        const {
          rows: [correction],
        } = await sql<{ undoneAt: Date | null }>`
          SELECT "undoneAt" FROM public.face_correction
          WHERE id = ${undo.correctionId}::uuid AND "ownerId" = ${input.ownerId}::uuid
            AND action = 'partner-merge' FOR UPDATE
        `.execute(tx);
        if (!correction || correction.undoneAt) return { conflict: 'already-undone' };
        const { rows } = await sql`
          SELECT 1 FROM public.partner_person_link link
          JOIN person ON person."ownerId" = link."ownerId" AND person."personGroupId" = link."personGroupId"
          WHERE link."ownerId" = ${input.ownerId}::uuid AND link."sourcePersonGroupId" = ${input.sourcePersonGroupId}::uuid
            AND link."personGroupId" = ${undo.personGroupId}::uuid AND link."correctionId" = ${undo.correctionId}::uuid
        `.execute(tx);
        if (rows.length === 0) return { conflict: 'person-gone' };
      } else {
        const { rows } = await sql<{ personGroupId: string }>`
          SELECT link."personGroupId" FROM public.partner_person_link link
          JOIN person ON person."ownerId" = link."ownerId" AND person."personGroupId" = link."personGroupId"
          WHERE link."ownerId" = ${input.ownerId}::uuid AND link."sourcePersonGroupId" = ${input.sourcePersonGroupId}::uuid
        `.execute(tx);
        if (rows[0]) return rows[0];
      }
      const { rows } = await sql<{ personGroupId: string }>`
        SELECT origin."personGroupId" FROM public.person_origin origin
        JOIN person ON person."ownerId" = origin."ownerId" AND person."personGroupId" = origin."personGroupId"
        WHERE origin."ownerId" = ${input.ownerId}::uuid AND origin."sourcePersonGroupId" = ${input.sourcePersonGroupId}::uuid
      `.execute(tx);
      let personGroupId = rows[0]?.personGroupId;
      if (!personGroupId) {
        // A deleted recipient person is no longer a mapping, but its source unique key can remain.
        await sql`
          DELETE FROM public.person_origin origin
          WHERE origin."ownerId" = ${input.ownerId}::uuid AND origin."sourcePersonGroupId" = ${input.sourcePersonGroupId}::uuid
            AND NOT EXISTS (SELECT 1 FROM person WHERE person."ownerId" = origin."ownerId" AND person."personGroupId" = origin."personGroupId")
        `.execute(tx);
        const group = await tx
          .insertInto('person_group')
          .columns(['clusterGroupId'])
          .expression((eb) => eb.selectFrom('user').select('clusterGroupId').where('id', '=', input.ownerId))
          .returning('id')
          .executeTakeFirstOrThrow();
        personGroupId = group.id;
        await tx
          .insertInto('person')
          .values({
            ownerId: input.ownerId,
            personGroupId,
            name: input.name,
            birthDate: input.birthDate,
            isHidden: input.isHidden,
          })
          .execute();
        await this.createPersonOrigin({ ...input, personGroupId }, tx);
      }
      if (undo) {
        await sql`
          UPDATE public.face_correction SET "undoneAt" = clock_timestamp()
          WHERE id = ${undo.correctionId}::uuid AND "ownerId" = ${input.ownerId}::uuid
        `.execute(tx);
        if (undo.faceIds.length > 0) {
          await tx
            .updateTable('asset_face')
            .set({ personGroupId, correctedAt: sql`clock_timestamp()` })
            .where('id', 'in', undo.faceIds)
            .where('personGroupId', '=', undo.personGroupId)
            .where('assetId', 'in', (eb) => eb.selectFrom('asset').select('id').where('ownerId', '=', input.ownerId))
            .execute();
        }
      }
      await sql`
        INSERT INTO public.partner_person_link ("ownerId", "sourcePersonGroupId", "personGroupId", kind, "partnerSharedById", "correctionId")
        VALUES (${input.ownerId}::uuid, ${input.sourcePersonGroupId}::uuid, ${personGroupId}::uuid, 'created', ${input.partnerSharedById}::uuid, NULL)
        ON CONFLICT ("ownerId", "sourcePersonGroupId") DO UPDATE
        SET "personGroupId" = excluded."personGroupId", kind = excluded.kind,
          "partnerSharedById" = excluded."partnerSharedById", "correctionId" = excluded."correctionId"
      `.execute(tx);
      return { personGroupId };
    });
  }
  async createPersonOrigin(input: PersonOriginInput, kysely: Kysely<DB> = this.db): Promise<void> {
    await sql`
      INSERT INTO public.person_origin
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
      FROM public.person_origin origin
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
      FROM public.person_origin origin
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
      UPDATE public.person_origin origin
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
    const { rows } = await sql<{
      present: boolean;
    }>`
      SELECT EXISTS (
        SELECT 1 FROM asset WHERE "ownerId" = ${ownerId}::uuid AND checksum = ${checksum}
      ) AS present
    `.execute(this.db);
    return rows[0]?.present ?? false;
  }
  /**
   * Whether `ownerId`'s library ever received a copy of `sourceAssetId`, even one its owner has since
   * permanently deleted: the origin row has no foreign key to the copy and outlives it.
   * A copy a library once had is never made again (a re-read of the source's
   * metadata, a retried job or a re-run backfill must not undo the recipient's delete).
   */
  async hasEverCopied(sourceAssetId: string, ownerId: string, kysely: Kysely<DB> = this.db): Promise<boolean> {
    const { rows } = await sql<{
      present: boolean;
    }>`
      SELECT EXISTS (
        SELECT 1 FROM public.asset_origin
        WHERE "sourceAssetId" = ${sourceAssetId}::uuid AND "ownerId" = ${ownerId}::uuid
      ) AS present
    `.execute(kysely);
    return rows[0]?.present ?? false;
  }
  /** Locked or sensitive evidence on a source, from either store (positive evidence anywhere counts). */
  async getCopyBlockers(assetId: string): Promise<AssetCopyBlockers> {
    const { rows } = await sql<AssetCopyBlockers>`
      SELECT
        (asset.visibility = 'locked' OR EXISTS (SELECT 1 FROM asset_lock WHERE asset_lock."assetId" = asset.id)) AS locked,
        (asset.is_nsfw OR asset.is_nsfw) AS sensitive
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
   * Returns the copy's id, or undefined when the library already holds the content (or once received a
   * copy of this source), or the partnership it is made for has ended.
   */
  async insertAssetCopy(input: AssetCopyInput): Promise<string | undefined> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPartnership(trx, input.partnerSharedById, input.ownerId))) {
        return;
      }
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
      if (existing || (await this.hasEverCopied(source.id, input.ownerId, trx))) {
        return;
      }
      const {
        id: _id,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        updateId: _updateId,
        ...columns
      } = source as typeof source & {
        createId?: string;
      };
      delete (
        columns as {
          createId?: string;
        }
      ).createId;
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
      // the stored checksum evidence names the same file, so the copy carries it too
      await sql`
        INSERT INTO public.asset_checksum
        SELECT (jsonb_populate_record(NULL::public.asset_checksum,
          to_jsonb(checksum) || jsonb_build_object('assetId', ${copy.id}::uuid))).*
        FROM public.asset_checksum checksum
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
    const { rows } = await sql<{
      id: string;
    }>`
      SELECT id FROM asset
      WHERE "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
        ${cursor ? sql`AND id > ${cursor}::uuid` : sql``}
      ORDER BY id
      LIMIT ${limit}
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }
  async countOwnerAssets(ownerId: string): Promise<number> {
    const { rows } = await sql<{
      count: number;
    }>`
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
    const { rows } = await sql<{
      id: string;
    }>`
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
    const { rows } = await sql<{
      present: boolean;
    }>`
      SELECT EXISTS (
        SELECT 1 FROM album_user WHERE "albumId" = ${albumId}::uuid AND "userId" = ${userId}::uuid
      ) AS present
    `.execute(this.db);
    return rows[0]?.present ?? false;
  }
  /**
   * `ownerId`'s copies of the items in `sourceAlbumId`. An item counts as copied when the library holds a
   * copy of it or of anything it was itself copied from: with A→B, A→C and B→C, C's copy of A's photo is
   * the one that belongs in C's copy of B's album (the one-copy rule never gave C a copy of B's copy).
   */
  async getAlbumAssetCopyIds(sourceAlbumId: string, ownerId: string): Promise<string[]> {
    const { rows } = await sql<{
      id: string;
    }>`
      WITH RECURSIVE lineage(id, depth) AS (
        SELECT album_asset."assetId", 0 FROM album_asset WHERE album_asset."albumId" = ${sourceAlbumId}::uuid
        UNION
        SELECT up."sourceAssetId", lineage.depth + 1
        FROM lineage
        JOIN public.asset_origin up ON up."assetId" = lineage.id
        WHERE up."sourceAssetId" IS NOT NULL AND lineage.depth < ${MAX_LINEAGE_DEPTH}
      )
      SELECT DISTINCT origin."assetId" AS id
      FROM lineage
      JOIN public.asset_origin origin ON origin."sourceAssetId" = lineage.id
        AND origin."ownerId" = ${ownerId}::uuid
      JOIN asset copy ON copy.id = origin."assetId" AND copy."deletedAt" IS NULL
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }
  /**
   * Whether `ownerId` already holds a copy of this album or of any album it descends from or that
   * descends from the same original (the root album): one copy per library per root album, however many
   * partners pass it on (A→B, A→C, B→C must not give C two).
   */
  async hasAlbumCopyOfRoot(albumId: string, ownerId: string): Promise<boolean> {
    const { rows } = await sql<{
      present: boolean;
    }>`
      WITH RECURSIVE source_lineage(id, depth) AS (
        SELECT ${albumId}::uuid, 0
        UNION
        SELECT up."sourceAlbumId", source_lineage.depth + 1
        FROM source_lineage
        JOIN public.album_origin up ON up."albumId" = source_lineage.id
        WHERE up."sourceAlbumId" IS NOT NULL AND source_lineage.depth < ${MAX_LINEAGE_DEPTH}
      ),
      root AS (SELECT id FROM source_lineage ORDER BY depth DESC LIMIT 1),
      copy_lineage(id, depth) AS (
        SELECT origin."sourceAlbumId", 1
        FROM public.album_origin origin
        JOIN album copy ON copy.id = origin."albumId"
        WHERE origin."ownerId" = ${ownerId}::uuid AND origin."sourceAlbumId" IS NOT NULL
        UNION
        SELECT up."sourceAlbumId", copy_lineage.depth + 1
        FROM copy_lineage
        JOIN public.album_origin up ON up."albumId" = copy_lineage.id
        WHERE up."sourceAlbumId" IS NOT NULL AND copy_lineage.depth < ${MAX_LINEAGE_DEPTH}
      )
      SELECT EXISTS (SELECT 1 FROM copy_lineage WHERE id IN (SELECT id FROM root)) AS present
    `.execute(this.db);
    return rows[0]?.present ?? false;
  }
  /** The items in an album. */
  async getAlbumAssetIds(albumId: string): Promise<string[]> {
    const { rows } = await sql<{
      id: string;
    }>`
      SELECT "assetId" AS id FROM album_asset WHERE "albumId" = ${albumId}::uuid
    `.execute(this.db);
    return rows.map(({ id }) => id);
  }
  /**
   * `ownerId`'s album copies whose membership still follows a source album holding `sourceAssetId`: a
   * new copy of that item belongs in them (spec §4.4).
   */
  async getFollowingAlbumCopiesHolding(sourceAssetId: string, ownerId: string): Promise<string[]> {
    const { rows } = await sql<{
      id: string;
    }>`
      SELECT origin."albumId" AS id
      FROM public.album_origin origin
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
      FROM public.partner_backfill
      WHERE "sharedById" = ${sharedById}::uuid AND "sharedWithId" = ${sharedWithId}::uuid
    `.execute(this.db);
    return rows[0];
  }
  /** Start (or restart from the beginning) a partnership's backfill. */
  async startBackfill(sharedById: string, sharedWithId: string, total: number): Promise<void> {
    await sql`
      INSERT INTO public.partner_backfill ("sharedById", "sharedWithId", state, cursor, total, done)
      VALUES (${sharedById}::uuid, ${sharedWithId}::uuid, ${PartnerBackfillState.Pending}, NULL, ${total}, 0)
      ON CONFLICT ("sharedById", "sharedWithId") DO UPDATE
      SET state = excluded.state, cursor = NULL, total = excluded.total, done = 0, "updatedAt" = clock_timestamp()
    `.execute(this.db);
  }
  /** Record a finished batch: the cursor only moves forward and `done` never shrinks. */
  async advanceBackfill(
    sharedById: string,
    sharedWithId: string,
    update: {
      cursor: string | null;
      processed: number;
      state: PartnerBackfillState;
    },
  ): Promise<void> {
    await sql`
      UPDATE public.partner_backfill
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
      UPDATE public.partner_backfill
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
  ): Promise<
    Map<
      string,
      {
        rootOwnerId: string;
        rootOwnerName: string;
      }
    >
  > {
    if (ids.length === 0) {
      return new Map();
    }
    const { table, key } = TABLES[kind];
    const { rows } = await sql<{
      id: string;
      rootOwnerId: string;
      rootOwnerName: string;
    }>`
      SELECT origin.${sql.id(key)} AS id, origin."rootOwnerId", root.name AS "rootOwnerName"
      FROM ${sql.raw(table)} origin
      JOIN public."user" root ON root.id = origin."rootOwnerId"
      WHERE origin.${sql.id(key)} = ANY(${ids}::uuid[]) AND origin."ownerId" = ${ownerId}::uuid
    `.execute(this.db);
    return new Map(rows.map(({ id, rootOwnerId, rootOwnerName }) => [id, { rootOwnerId, rootOwnerName }]));
  }
}
