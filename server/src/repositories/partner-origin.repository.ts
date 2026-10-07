import { ConflictException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { AlbumKind, AssetFileType, AssetLockReason, AssetOrder, AssetType } from 'src/enum.js';

import { lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { onStacksJoined } from 'src/utils/locked-stacks.js';
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
  /** Album, membership and origin commit together while the partnership is held FOR SHARE. */
  async createAlbumCopy(
    input: Omit<OriginInput, 'id'>,
    create: (trx: Transaction<DB>) => Promise<{ id: string }>,
  ): Promise<string | undefined> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPartnership(trx, input.partnerSharedById, input.ownerId))) {
        return;
      }
      // ponytail: serial album admission per library; lock by root album if contention matters.
      await lockLibraryContent(trx, input.ownerId, Buffer.from('partner-albums'));
      if (await this.hasAlbumCopyOfRoot(input.sourceId, input.ownerId, trx)) {
        return;
      }
      const copy = await create(trx);
      await this.createOrigin('album', { ...input, id: copy.id }, trx);
      return copy.id;
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
   * Favorites and trash stay the recipient's own. Photo edits are snapshots; stacks and duplicate
   * groups use recipient-owned records. Live Photo pairing is completed by the copy engine.
   *
   * Returns the copy's id, or undefined when the library already holds the content (or once received a
   * copy of this source), or the partnership it is made for has ended.
   */
  async insertAssetCopy(input: AssetCopyInput): Promise<string | undefined> {
    return this.db.transaction().execute(async (trx) => {
      if (!(await lockPartnership(trx, input.partnerSharedById, input.ownerId))) {
        return;
      }
      const source = await trx
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', input.sourceAssetId)
        .forShare()
        .executeTakeFirst();
      if (!source) {
        return;
      }
      const files = await trx
        .selectFrom('asset_file')
        .selectAll()
        .where('assetId', '=', source.id)
        .$if(source.type !== AssetType.Image, (qb) => qb.where('isEdited', '=', false))
        .where('type', 'in', GENERATED_FILE_TYPES)
        .execute();
      // Lock version rows and their paths too: a source prune cannot release a snapshot's files mid-copy.
      const revisions =
        source.type === AssetType.Image
          ? (
              await sql<{ id: string; masterPath: string | null; previewPath: string | null }>`
            SELECT id, "masterPath", "previewPath"
            FROM public.asset_develop_revision revision WHERE "assetId" = ${source.id}::uuid FOR SHARE
          `.execute(trx)
            ).rows
          : [];
      const artifacts =
        source.type === AssetType.Image
          ? (
              await sql<{ id: string; path: string }>`
            SELECT id, path FROM public.asset_develop_artifact artifact
            WHERE "assetId" = ${source.id}::uuid FOR SHARE
          `.execute(trx)
            ).rows
          : [];
      const paths = [
        input.original.path,
        ...files.map((file) => file.path),
        ...revisions.flatMap((revision) => [revision.masterPath, revision.previewPath]),
        ...artifacts.map((artifact) => artifact.path),
      ].filter((path): path is string => !!path);
      for (const path of [...new Set(paths)].toSorted()) {
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
              isEdited: file.isEdited,
              physicalFileId: file.physicalFileId,
              isProgressive: file.isProgressive,
              isTransparent: file.isTransparent,
            })),
          )
          .execute();
      }
      if (source.type === AssetType.Image) {
        await sql`INSERT INTO asset_edit ("assetId", action, parameters, sequence)
          SELECT ${copy.id}::uuid, action, parameters, sequence FROM asset_edit
          WHERE "assetId" = ${source.id}::uuid`.execute(trx);
        await sql`INSERT INTO public.asset_develop_revision
          SELECT (jsonb_populate_record(NULL::public.asset_develop_revision,
            to_jsonb(snapshot) || jsonb_build_object('id', gen_random_uuid(),
              'assetId', ${copy.id}::uuid, 'ownerId', ${input.ownerId}::uuid, 'exportId', NULL,
              'cancelRequested', false, 'attempts', 0, 'error', NULL,
              'status', CASE WHEN snapshot.status = 'rendered' THEN 'rendered' ELSE 'saved' END,
              'progress', CASE WHEN snapshot.status = 'rendered' THEN 100 ELSE 0 END))).*
          FROM public.asset_develop_revision snapshot
          WHERE snapshot.id = ANY(${revisions.map(({ id }) => id)}::uuid[])`.execute(trx);
        await sql`INSERT INTO public.asset_develop_artifact
          SELECT (jsonb_populate_record(NULL::public.asset_develop_artifact,
            to_jsonb(snapshot) || jsonb_build_object('assetId', ${copy.id}::uuid,
              'ownerId', ${input.ownerId}::uuid))).*
          FROM public.asset_develop_artifact snapshot
          WHERE snapshot."assetId" = ${source.id}::uuid AND snapshot.id = ANY(${artifacts.map(({ id }) => id)}::text[])`.execute(
          trx,
        );
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
      await this.copyGroups(trx, source.id, copy.id, input.ownerId);
      // spec §4.3: every library is charged the full size; copying never fails on quota
      await sql`
        UPDATE "user"
        SET "quotaUsageInBytes" = "quotaUsageInBytes" + coalesce(${exif?.fileSizeInByte ?? null}::bigint, 0)
          + (SELECT coalesce(sum(bytes), 0) FROM public.asset_develop_artifact WHERE "assetId" = ${copy.id}::uuid)
        WHERE id = ${input.ownerId}::uuid
      `.execute(trx);
      return copy.id;
    });
  }
  /** Only new copies join groups. Replays never regroup media the recipient already changed. */
  private async copyGroups(trx: Transaction<DB>, sourceId: string, copyId: string, ownerId: string) {
    // ponytail: serial group admission per library; use per-source group locks if contention matters.
    await lockLibraryContent(trx, ownerId, Buffer.from('partner-groups'));
    const source = await trx
      .selectFrom('asset')
      .select(['stackId', 'duplicateId'])
      .where('id', '=', sourceId)
      .executeTakeFirstOrThrow();
    if (source.stackId) {
      // The primary must arrive before a stack exists; its earlier copied members join then.
      const { rows } = await sql<{ id: string; stackId: string | null; isPrimary: boolean }>`
        SELECT copy.id, copy."stackId", source.id = stack."primaryAssetId" AS "isPrimary"
        FROM asset source JOIN stack ON stack.id = source."stackId"
        JOIN asset copy ON copy.checksum = source.checksum AND copy."ownerId" = ${ownerId}::uuid
        JOIN public.asset_origin origin ON origin."assetId" = copy.id AND origin.following
        WHERE source."stackId" = ${source.stackId}::uuid AND copy."deletedAt" IS NULL
      `.execute(trx);
      const primary = rows.find((row) => row.isPrimary);
      const existing = rows.find((row) => row.stackId)?.stackId;
      if (existing) {
        await trx.updateTable('asset').set({ stackId: existing }).where('id', '=', copyId).execute();
        await onStacksJoined(trx, [existing]);
      } else if (primary) {
        const stack = await trx
          .insertInto('stack')
          .values({ ownerId, primaryAssetId: primary.id })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .updateTable('asset')
          .set({ stackId: stack.id })
          .where(
            'id',
            'in',
            rows.map((row) => row.id),
          )
          .where('stackId', 'is', null)
          .execute();
        await onStacksJoined(trx, [stack.id]);
      }
    }
    if (source.duplicateId) {
      const { rows } = await sql<{ duplicateId: string }>`SELECT copy."duplicateId"
        FROM asset source JOIN asset copy ON copy.checksum = source.checksum AND copy."ownerId" = ${ownerId}::uuid
        JOIN public.asset_origin origin ON origin."assetId" = copy.id AND origin.following
        WHERE source."duplicateId" = ${source.duplicateId}::uuid AND copy."duplicateId" IS NOT NULL
        ORDER BY copy.id LIMIT 1`.execute(trx);
      await sql`UPDATE asset SET "duplicateId" = coalesce(${rows[0]?.duplicateId ?? null}::uuid, gen_random_uuid())
        WHERE id = ${copyId}::uuid`.execute(trx);
    }
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
  async hasAlbumCopyOfRoot(albumId: string, ownerId: string, kysely: Kysely<DB> = this.db): Promise<boolean> {
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
    `.execute(kysely);
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
      WITH RECURSIVE lineage(asset_id) AS (
        SELECT ${sourceAssetId}::uuid
        UNION
        SELECT CASE WHEN origin."assetId" = lineage.asset_id
          THEN origin."sourceAssetId" ELSE origin."assetId" END
        FROM lineage JOIN public.asset_origin origin
          ON origin."assetId" = lineage.asset_id OR origin."sourceAssetId" = lineage.asset_id
        WHERE origin."sourceAssetId" IS NOT NULL
      )
      SELECT DISTINCT origin."albumId" AS id
      FROM public.album_origin origin
      JOIN album copy ON copy.id = origin."albumId" AND copy."deletedAt" IS NULL
      JOIN album_asset membership ON membership."albumId" = origin."sourceAlbumId"
      JOIN lineage ON lineage.asset_id = membership."assetId"
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
