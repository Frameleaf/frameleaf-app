import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
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
