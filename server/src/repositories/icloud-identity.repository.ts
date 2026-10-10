import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudEditBaselineDto, ICloudEditSuccessorDto } from 'src/dtos/icloud-identity.dto.js';
import { ICloudEditAuthorityRepository } from 'src/repositories/icloud-edit-authority.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { DB } from 'src/schema/index.js';
import {
  ICloudIdentityRole,
  ItemMetadata,
  MatchStrength,
  ParsedCloudIdentifier,
  matchStrength,
  metadataAgrees,
} from 'src/utils/icloud-identity.js';
import { decodedName } from 'src/utils/icloud-records.js';
/** FL-296: one identity on record, with the asset it names. */
export type ICloudIdentityRow = {
  id: string;
  assetId: string;
  libraryKey: string | null;
  cplAssetRecordName: string;
  cplMasterRecordName: string | null;
  role: ICloudIdentityRole;
  editVersion: string;
  sha256: Buffer;
  appleFingerprint: string | null;
  deliveredBy: string;
  deliveredAt: Date;
  lastVerifiedAt: Date | null;
  lastAuditResult: 'match' | 'mismatch' | null;
  matchStrength: MatchStrength | null;
};
/** FL-296: a lease on one logical Apple item (all its roles), held by a device or a sync run. */
export type ICloudClaimRow = {
  id: string;
  cplAssetRecordName: string;
  holder: string;
  expiresAt: Date;
  createdAt: Date;
};
/** Longest a claim lives, renewals included (a long video). */
export const ICLOUD_CLAIM_MAX_SEC = 4 * 3600;
/** FL-296: a connection as the coverage probe and lookup describe it. */
export type ICloudCoverageConnection = {
  id: string;
  label: string;
  state: string;
  lastError: string | null;
  accountHint: string | null;
  unhealthySince: Date | null;
  nextRunAt: Date | null;
  config: {
    libraries?: string[];
    albums?: string[];
    includeEdits?: boolean;
  };
  lastCompleteInventoryAt: Date | null;
};
/** FL-296: what the sync's inventory knows about one Apple item. */
export type ICloudInventoryItem = {
  connectionId: string;
  cplAssetRecordName: string;
  cplMasterRecordName: string | null;
  assetFields: Record<string, unknown>;
  masterFields: Record<string, unknown> | null;
  /** The sync currently selected it (it has current resources); otherwise it is outside its selection. */
  inScope: boolean;
  /**
   * The roles (as identity roles) the sync is still bringing: resources queued or in progress and
   * current. A failed, unsupported or superseded resource is not pending, so the device keeps it.
   */
  pendingRoles: ICloudIdentityRole[];
  /** Since when the oldest of those has waited. */
  pendingSince: Date | null;
};
/** The sync's resource role, as an identity role (`r` is an `icloud_resource`). */
const identityRoleSql = sql`CASE r.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion'
  WHEN 'raw' THEN 'raw-alternate' ELSE 'edit-render' END`;
/** A resource the sync will still import: the same rule as the worker's own `hasPending`. */
const pendingResourceSql = sql`r."auditRequestId" IS NULL AND r.status IN ('pending', 'retry', 'staging', 'validated', 'promoted', 'committed')
  AND (r.status = 'committed' OR coalesce((r.source->>'current')::boolean, true))`;
/**
 * The sync's resources, as identities: `icloud-sync:<connection>` delivered them, the record names
 * come from its own inventory (so the match is exact), and an edit render's version is the CPLAsset
 * adjustment time and the render's fingerprint.
 */
const syncIdentities = (where: ReturnType<typeof sql>) => sql`
  INSERT INTO public.icloud_source_identity ("ownerId", "assetId", "libraryKey", library, "cplAssetRecordName",
    "cplMasterRecordName", role, "editVersion", sha256, "cloudChecksum", "deliveredBy", "matchStrength")
  SELECT r."ownerId", r."assetId", r."libraryKey", r.library, upper(r."sourceAssetId"), r.source->>'sourceMasterId',
    ${identityRoleSql},
    CASE WHEN r.role IN ('edited-image', 'edited-video')
      THEN coalesce(r.source->'assetFields'->'adjustmentTimestamp'->>'value', '') || ':' || r.fingerprint ELSE '' END,
    r.sha256, r.source->'resource'->>'fileChecksum', 'icloud-sync:' || r."connectionId", 'exact'
  FROM public.icloud_resource r
  WHERE r."auditRequestId" IS NULL AND r."assetId" IS NOT NULL AND r.sha256 IS NOT NULL AND r.status IN ('committed', 'finalized', 'reused')
    AND r.role IN ('original', 'motion', 'raw', 'edited-image', 'edited-video') AND ${where}
  ON CONFLICT ("ownerId", "cplAssetRecordName", role, "editVersion", "assetId") DO UPDATE
    SET sha256 = excluded.sha256, "libraryKey" = excluded."libraryKey", library = excluded.library,
      "cplMasterRecordName" = coalesce(excluded."cplMasterRecordName", icloud_source_identity."cplMasterRecordName"),
      "cloudChecksum" = coalesce(excluded."cloudChecksum", icloud_source_identity."cloudChecksum"),
      "lastVerifiedAt" = CASE WHEN icloud_source_identity.sha256 IS NOT DISTINCT FROM excluded.sha256
        THEN icloud_source_identity."lastVerifiedAt" END,
      "lastAuditResult" = CASE WHEN icloud_source_identity.sha256 IS NOT DISTINCT FROM excluded.sha256
        THEN icloud_source_identity."lastAuditResult" END,
      "appleFingerprint" = CASE WHEN icloud_source_identity.sha256 = excluded.sha256
        THEN icloud_source_identity."appleFingerprint" END
`;
/** The identity of one resource the sync just committed or reused (inside its transaction). */
export const recordSyncIdentity = async (db: Kysely<DB>, resourceId: string): Promise<void> => {
  await syncIdentities(sql`r.id = ${resourceId}::uuid`).execute(db);
};
/**
 * The sync finished one resource of an item: its claim on the item goes once none of the item's
 * resources in this connection are still open (inside the finalize transaction).
 */
export const releaseSyncClaim = async (db: Kysely<DB>, resourceId: string): Promise<void> => {
  await sql`
    DELETE FROM public.icloud_claim c
    USING public.icloud_resource r
    WHERE r.id = ${resourceId}::uuid AND r."auditRequestId" IS NULL AND c."ownerId" = r."ownerId" AND c."cplAssetRecordName" = upper(r."sourceAssetId")
      AND c.holder = 'icloud-sync:' || r."connectionId"
      AND NOT EXISTS (
        SELECT 1 FROM public.icloud_resource o
        WHERE o."auditRequestId" IS NULL AND o."connectionId" = r."connectionId" AND o."libraryKey" = r."libraryKey"
          AND o."sourceAssetId" = r."sourceAssetId" AND o.id <> r.id
          AND o.status IN ('pending', 'retry', 'staging', 'validated', 'promoted', 'committed')
          AND coalesce((o.source->>'current')::boolean, true)
      )
  `.execute(db);
};
/** How long the sync's claim on an item lives; every resource it transfers renews it. */
export const ICLOUD_SYNC_CLAIM_SEC = 1800;
@Injectable()
export class ICloudIdentityRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  /** Every past sync import, so the identities cover what was imported before they existed. */
  async backfill(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      const result = await syncIdentities(
        // per asset and Apple item: one asset reused by two Apple items (duplicates in iCloud) needs both
        sql`NOT EXISTS (SELECT 1 FROM public.icloud_source_identity i
          WHERE i."assetId" = r."assetId" AND i."cplAssetRecordName" = upper(r."sourceAssetId"))`,
      ).execute(tx);
      return Number(result.numAffectedRows ?? 0);
    });
  }
  /** The identities of these Apple items, for this owner, with assets that still exist. */
  async identities(ownerId: string, names: string[]): Promise<ICloudIdentityRow[]> {
    if (names.length === 0) {
      return [];
    }
    const { rows } = await sql<ICloudIdentityRow>`
      SELECT i.id, i."assetId", i."libraryKey", i."cplAssetRecordName", i."cplMasterRecordName", i.role,
        i."editVersion", i.sha256, i."appleFingerprint", i."deliveredBy", i."deliveredAt", i."lastVerifiedAt",
        i."lastAuditResult", i."matchStrength"
      FROM public.icloud_source_identity i
      JOIN public.asset a ON a.id = i."assetId" AND a."ownerId" = i."ownerId" AND a."deletedAt" IS NULL
      WHERE i."ownerId" = ${ownerId}::uuid AND i."cplAssetRecordName" = ANY(${names}::text[])
      ORDER BY i."deliveredAt"
    `.execute(this.db);
    return rows;
  }
  /** The owner's connections, with what the coverage probe reports about each. */
  async connections(ownerId: string): Promise<ICloudCoverageConnection[]> {
    const { rows } = await sql<ICloudCoverageConnection>`
      SELECT c.id, c.label, c.state, c."lastError", c."accountHint", c."unhealthySince", c."nextRunAt", c.config,
        (SELECT k."updatedAt" FROM public.icloud_checkpoint k
          WHERE k."connectionId" = c.id AND k.scope = 'inventory-complete' AND k.complete) AS "lastCompleteInventoryAt"
      FROM public.icloud_connection c
      WHERE c."ownerId" = ${ownerId}::uuid AND c.state <> 'disconnected'
      ORDER BY c."createdAt"
    `.execute(this.db);
    return rows;
  }
  /** What the owner's sync inventories know about these Apple items (every record in scope or not). */
  async inventory(ownerId: string, names: string[]): Promise<ICloudInventoryItem[]> {
    if (names.length === 0) {
      return [];
    }
    const { rows } = await sql<ICloudInventoryItem>`
      SELECT a."connectionId", upper(a."recordId") AS "cplAssetRecordName", a."masterId" AS "cplMasterRecordName",
        a.fields AS "assetFields", m.fields AS "masterFields",
        EXISTS (SELECT 1 FROM public.icloud_resource r WHERE r."auditRequestId" IS NULL AND r."connectionId" = a."connectionId"
          AND r."libraryKey" = a."libraryKey" AND r."sourceAssetId" = a."recordId"
          AND coalesce((r.source->>'current')::boolean, true)) AS "inScope",
        coalesce((SELECT array_agg(DISTINCT ${identityRoleSql}) FROM public.icloud_resource r
          WHERE r."connectionId" = a."connectionId" AND r."libraryKey" = a."libraryKey"
            AND r."sourceAssetId" = a."recordId" AND ${pendingResourceSql}), '{}') AS "pendingRoles",
        (SELECT min(r."createdAt") FROM public.icloud_resource r WHERE r."connectionId" = a."connectionId"
          AND r."libraryKey" = a."libraryKey" AND r."sourceAssetId" = a."recordId"
          AND ${pendingResourceSql}) AS "pendingSince"
      FROM public.icloud_record a
      JOIN public.icloud_connection c ON c.id = a."connectionId" AND c."ownerId" = ${ownerId}::uuid
        AND c.state <> 'disconnected'
      LEFT JOIN public.icloud_record m ON m."connectionId" = a."connectionId" AND m."libraryKey" = a."libraryKey"
        AND m."recordId" = a."masterId" AND NOT m.deleted
      WHERE a."recordType" = 'CPLAsset' AND NOT a.deleted AND upper(a."recordId") = ANY(${names}::text[])
    `.execute(this.db);
    return rows;
  }
  /**
   * Claim these items for `holder` for `ttlSec`: granted where nobody else holds a live claim (a
   * holder's own claim is extended, keeping its id). Answers every item's current claim.
   */
  async claim(ownerId: string, names: string[], holder: string, ttlSec: number): Promise<ICloudClaimRow[]> {
    if (names.length === 0) {
      return [];
    }
    return this.db.transaction().execute(async (tx) => {
      const canonical = await lockICloudItemClaims(tx, ownerId, names);
      await sql`
        INSERT INTO public.icloud_claim ("ownerId", "cplAssetRecordName", holder, "expiresAt")
        SELECT ${ownerId}::uuid, name, ${holder}, clock_timestamp() + make_interval(secs => ${ttlSec})
        FROM unnest(${canonical}::text[]) AS name
        -- one lock order for every caller: two devices claiming overlapping items cannot deadlock
        ORDER BY name
        ON CONFLICT ("ownerId", "cplAssetRecordName") DO UPDATE
          SET holder = excluded.holder,
            "expiresAt" = least(
              CASE WHEN icloud_claim.holder = excluded.holder AND icloud_claim."expiresAt" > clock_timestamp()
                THEN icloud_claim."createdAt" ELSE clock_timestamp() END + interval '4 hours',
              excluded."expiresAt"),
            id = CASE WHEN icloud_claim.holder = excluded.holder AND icloud_claim."expiresAt" > clock_timestamp()
              THEN icloud_claim.id ELSE gen_random_uuid() END,
            "createdAt" = CASE WHEN icloud_claim.holder = excluded.holder AND icloud_claim."expiresAt" > clock_timestamp()
              THEN icloud_claim."createdAt" ELSE clock_timestamp() END
          WHERE icloud_claim."expiresAt" <= clock_timestamp() OR icloud_claim.holder = excluded.holder
      `.execute(tx);
      const { rows } = await sql<ICloudClaimRow>`
        SELECT id, "cplAssetRecordName", holder, "expiresAt", "createdAt" FROM public.icloud_claim
        WHERE "ownerId" = ${ownerId}::uuid AND "cplAssetRecordName" = ANY(${canonical}::text[])
      `.execute(tx);
      return rows;
    });
  }
  /**
   * The sync's claim on the item a resource belongs to, before it downloads anything: null when it
   * holds the claim, else when the device holding it lets go at the latest.
   */
  async claimForSync(ownerId: string, sourceAssetId: string, connectionId: string): Promise<Date | null> {
    const holder = `icloud-sync:${connectionId}`;
    const [claim] = await this.claim(ownerId, [sourceAssetId.toUpperCase()], holder, ICLOUD_SYNC_CLAIM_SEC);
    return !claim || claim.holder === holder ? null : new Date(claim.expiresAt);
  }
  /** Extend live claims of `holder`, never past four hours from when each was taken. */
  async renew(ownerId: string, ids: string[], holder: string, ttlSec: number): Promise<ICloudClaimRow[]> {
    return this.db.transaction().execute(async (tx) => {
      const hints = await sql<{ item: string }>`SELECT "cplAssetRecordName" AS item FROM public.icloud_claim
        WHERE "ownerId"=${ownerId}::uuid AND id=ANY(${ids}::uuid[]) AND holder=${holder}`.execute(tx);
      await lockICloudItemClaims(
        tx,
        ownerId,
        hints.rows.map((row) => row.item),
      );
      const { rows } = await sql<ICloudClaimRow>`
        UPDATE public.icloud_claim
        SET "expiresAt" = least("createdAt" + interval '4 hours', clock_timestamp() + make_interval(secs => ${ttlSec}))
        WHERE "ownerId" = ${ownerId}::uuid AND id = ANY(${ids}::uuid[]) AND holder = ${holder}
          AND "expiresAt" > clock_timestamp()
        RETURNING id, "cplAssetRecordName", holder, "expiresAt", "createdAt"
      `.execute(tx);
      return rows;
    });
  }
  /** Give up claims of `holder`; answers the ids released. */
  async release(ownerId: string, ids: string[], holder: string): Promise<string[]> {
    return this.db.transaction().execute(async (tx) => {
      const hints = await sql<{ item: string }>`SELECT "cplAssetRecordName" AS item FROM public.icloud_claim
        WHERE "ownerId"=${ownerId}::uuid AND id=ANY(${ids}::uuid[]) AND holder=${holder}`.execute(tx);
      await lockICloudItemClaims(
        tx,
        ownerId,
        hints.rows.map((row) => row.item),
      );
      const { rows } = await sql<{
        id: string;
      }>`
        DELETE FROM public.icloud_claim
        WHERE "ownerId" = ${ownerId}::uuid AND id = ANY(${ids}::uuid[]) AND holder = ${holder}
        RETURNING id
      `.execute(tx);
      return rows.map(({ id }) => id);
    });
  }
  /** Live claims on these items. */
  async claims(ownerId: string, names: string[]): Promise<ICloudClaimRow[]> {
    if (names.length === 0) {
      return [];
    }
    const { rows } = await sql<ICloudClaimRow>`
      SELECT id, "cplAssetRecordName", holder, "expiresAt", "createdAt" FROM public.icloud_claim
      WHERE "ownerId" = ${ownerId}::uuid AND "cplAssetRecordName" = ANY(${names}::text[])
        AND "expiresAt" > clock_timestamp()
    `.execute(this.db);
    return rows;
  }
  /**
   * A device uploaded this iCloud item and its digest checked out: record which item the asset is,
   * delivered by the claim's holder (or the device), with how well the device's identifier matches
   * what the sync knows. Idempotent.
   */
  async recordDevice(input: {
    ownerId: string;
    assetId: string;
    parsed: ParsedCloudIdentifier;
    cloudIdentifier: string;
    role: ICloudIdentityRole;
    editVersion: string;
    sha256: Buffer;
    claimId: string | null;
    deviceKey: string | null;
    metadata: ItemMetadata;
  }): Promise<void> {
    const name = input.parsed.cplAssetRecordName;
    const known = (await this.identities(input.ownerId, [name])).find(
      ({ role, deliveredBy }) => role === input.role && deliveredBy.startsWith('icloud-sync:'),
    );
    const record = (await this.inventory(input.ownerId, [name])).find(({ inScope }) => inScope);
    const agrees = !!record && metadataAgrees(input.metadata, record.assetFields, record.masterFields, decodedName);
    const strength = matchStrength({
      known: known ?? {
        cplAssetRecordName: name,
        cplMasterRecordName: record?.cplMasterRecordName ?? null,
        appleFingerprint: null,
        sha256: Buffer.alloc(0),
      },
      reported: { ...input.parsed, sha256: input.sha256 },
      metadataAgrees: agrees,
    });
    const write = async (tx: Transaction<DB>) => {
      // the claim stays: it covers the whole item (its other roles may still be on the way), and the
      // device releases it, or it runs out, when the item is done
      const { rows } = input.claimId
        ? await sql<{
            holder: string;
          }>`
            SELECT holder FROM public.icloud_claim
            WHERE id = ${input.claimId}::uuid AND "ownerId" = ${input.ownerId}::uuid AND "cplAssetRecordName" = ${name}
          `.execute(tx)
        : { rows: [] };
      const deliveredBy = rows[0]?.holder ?? `device:${input.deviceKey ?? 'unknown'}`;
      await sql`
        INSERT INTO public.icloud_source_identity ("ownerId", "assetId", "libraryKey", "cplAssetRecordName",
          "cplMasterRecordName", role, "editVersion", sha256, "deliveredBy", "cloudIdentifier", "matchStrength")
        VALUES (${input.ownerId}::uuid, ${input.assetId}::uuid, ${known?.libraryKey ?? null}, ${name},
          ${input.parsed.cplMasterRecordName}, ${input.role}, ${input.editVersion}, ${input.sha256}, ${deliveredBy},
          ${input.cloudIdentifier}, ${strength})
        ON CONFLICT ("ownerId", "cplAssetRecordName", role, "editVersion", "assetId") DO NOTHING
      `.execute(tx);
    };
    if (this.db.isTransaction) {
      await write(this.db as Transaction<DB>);
    } else {
      await this.db.transaction().execute(write);
    }
  }
  /** Validate and hold the current owned original until its identity has been recorded. */
  async attachDevice(auth: AuthDto, input: Parameters<ICloudIdentityRepository['recordDevice']>[0]): Promise<boolean> {
    return this.db.transaction().execute(async (tx) => {
      const asset = await new IntegrityRepository(tx)
        .getSafetyQuery(auth, [input.sha256.toString('hex')])
        .where('asset.id', '=', input.assetId)
        .where('asset.ownerId', '=', input.ownerId)
        .forShare('asset')
        .executeTakeFirst();
      if (!asset) {
        return false;
      }
      await new ICloudIdentityRepository(tx).recordDevice(input);
      // A repeated key keeps its existing proof; changed originals cannot claim that proof as attached.
      const { rows } = await sql<{
        sha256: Buffer;
      }>`
        SELECT sha256 FROM public.icloud_source_identity
        WHERE "ownerId" = ${input.ownerId}::uuid AND "assetId" = ${input.assetId}::uuid
          AND "cplAssetRecordName" = ${input.parsed.cplAssetRecordName}
          AND role = ${input.role} AND "editVersion" = ${input.editVersion}
        FOR SHARE
      `.execute(tx);
      return rows[0]?.sha256.equals(input.sha256) ?? false;
    });
  }
  discoverEditEvidence(auth: AuthDto, assetId: string) {
    return new ICloudEditAuthorityRepository(this.db).discover(auth, assetId);
  }
  acceptEditBaseline(auth: AuthDto, dto: ICloudEditBaselineDto) {
    return new ICloudEditAuthorityRepository(this.db).baseline(auth, dto);
  }
  acceptEditSuccessor(auth: AuthDto, dto: ICloudEditSuccessorDto) {
    return new ICloudEditAuthorityRepository(this.db).successor(auth, dto);
  }
  /** Whether `deviceKey` is one of the owner's registered backup devices. */
  async ownsDevice(ownerId: string, deviceKey: string): Promise<boolean> {
    const { rows } = await sql`
      SELECT 1 FROM public.backup_device
      WHERE "ownerId" = ${ownerId}::uuid AND "deviceKey" = ${deviceKey}::uuid AND "deletedAt" IS NULL
    `.execute(this.db);
    return rows.length > 0;
  }
  /** Identities whose asset is gone (deleted for good); the nightly cleanup removes them. */
  async removeOrphans(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      const result = await sql`
        DELETE FROM public.icloud_source_identity i
        WHERE NOT EXISTS (SELECT 1 FROM public.asset a WHERE a.id = i."assetId" AND a."ownerId" = i."ownerId")
      `.execute(tx);
      return Number(result.numAffectedRows ?? 0);
    });
  }
}
