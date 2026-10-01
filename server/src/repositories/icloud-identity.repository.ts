import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { lockForkWrites } from 'src/repositories/fork-write-guard.js';
import { DB } from 'src/schema/index.js';
import { ICloudIdentityRole, MatchStrength } from 'src/utils/icloud-identity.js';

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

/** FL-296: a connection as the coverage probe and lookup describe it. */
export type ICloudCoverageConnection = {
  id: string;
  label: string;
  state: string;
  lastError: string | null;
  accountHint: string | null;
  unhealthySince: Date | null;
  nextRunAt: Date | null;
  config: { libraries?: string[]; albums?: string[]; includeEdits?: boolean };
  lastCompleteInventoryAt: Date | null;
};

/** FL-296: what the sync's inventory knows about one Apple item. */
export type ICloudInventoryItem = {
  connectionId: string;
  cplAssetRecordName: string;
  cplMasterRecordName: string | null;
  assetFields: Record<string, unknown>;
  masterFields: Record<string, unknown> | null;
  /** The sync selected it (it has resources); otherwise it is outside the connection's selection. */
  inScope: boolean;
  /** Its resources not yet imported, and since when. */
  pending: boolean;
  pendingSince: Date | null;
};

/**
 * The sync's resources, as identities: `icloud-sync:<connection>` delivered them, the record names
 * come from its own inventory (so the match is exact), and an edit render's version is the CPLAsset
 * adjustment time and the render's fingerprint.
 */
const syncIdentities = (where: ReturnType<typeof sql>) => sql`
  INSERT INTO immich_fork.icloud_source_identity ("ownerId", "assetId", "libraryKey", library, "cplAssetRecordName",
    "cplMasterRecordName", role, "editVersion", sha256, "cloudChecksum", "deliveredBy", "matchStrength")
  SELECT r."ownerId", r."assetId", r."libraryKey", r.library, upper(r."sourceAssetId"), r.source->>'sourceMasterId',
    CASE r.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion' WHEN 'raw' THEN 'raw-alternate'
      ELSE 'edit-render' END,
    CASE WHEN r.role IN ('edited-image', 'edited-video')
      THEN coalesce(r.source->'assetFields'->'adjustmentTimestamp'->>'value', '') || ':' || r.fingerprint ELSE '' END,
    r.sha256, r.source->'resource'->>'fileChecksum', 'icloud-sync:' || r."connectionId", 'exact'
  FROM immich_fork.icloud_resource r
  WHERE r."assetId" IS NOT NULL AND r.sha256 IS NOT NULL AND r.status IN ('committed', 'finalized')
    AND r.role IN ('original', 'motion', 'raw', 'edited-image', 'edited-video') AND ${where}
  ON CONFLICT ("ownerId", "cplAssetRecordName", role, "editVersion", "assetId") DO UPDATE
    SET sha256 = excluded.sha256, "libraryKey" = excluded."libraryKey", library = excluded.library,
      "cplMasterRecordName" = coalesce(excluded."cplMasterRecordName", icloud_source_identity."cplMasterRecordName"),
      "cloudChecksum" = coalesce(excluded."cloudChecksum", icloud_source_identity."cloudChecksum"),
      "appleFingerprint" = CASE WHEN icloud_source_identity.sha256 = excluded.sha256
        THEN icloud_source_identity."appleFingerprint" END
`;

/** The identity of one resource the sync just committed or reused (inside its transaction). */
export const recordSyncIdentity = async (db: Kysely<DB>, resourceId: string): Promise<void> => {
  await syncIdentities(sql`r.id = ${resourceId}::uuid`).execute(db);
};

@Injectable()
export class ICloudIdentityRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Every past sync import, so the identities cover what was imported before they existed. */
  async backfill(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'iCloud identities cannot be recorded while the server is being handed over');
      const result = await syncIdentities(
        sql`NOT EXISTS (SELECT 1 FROM immich_fork.icloud_source_identity i WHERE i."assetId" = r."assetId")`,
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
      FROM immich_fork.icloud_source_identity i
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
        (SELECT k."updatedAt" FROM immich_fork.icloud_checkpoint k
          WHERE k."connectionId" = c.id AND k.scope = 'inventory-complete' AND k.complete) AS "lastCompleteInventoryAt"
      FROM immich_fork.icloud_connection c
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
        EXISTS (SELECT 1 FROM immich_fork.icloud_resource r WHERE r."connectionId" = a."connectionId"
          AND r."libraryKey" = a."libraryKey" AND r."sourceAssetId" = a."recordId") AS "inScope",
        EXISTS (SELECT 1 FROM immich_fork.icloud_resource r WHERE r."connectionId" = a."connectionId"
          AND r."libraryKey" = a."libraryKey" AND r."sourceAssetId" = a."recordId"
          AND r.status NOT IN ('committed', 'finalized', 'removed', 'unsupported')) AS pending,
        (SELECT min(r."createdAt") FROM immich_fork.icloud_resource r WHERE r."connectionId" = a."connectionId"
          AND r."libraryKey" = a."libraryKey" AND r."sourceAssetId" = a."recordId"
          AND r.status NOT IN ('committed', 'finalized', 'removed', 'unsupported')) AS "pendingSince"
      FROM immich_fork.icloud_record a
      JOIN immich_fork.icloud_connection c ON c.id = a."connectionId" AND c."ownerId" = ${ownerId}::uuid
        AND c.state <> 'disconnected'
      LEFT JOIN immich_fork.icloud_record m ON m."connectionId" = a."connectionId" AND m."libraryKey" = a."libraryKey"
        AND m."recordId" = a."masterId" AND NOT m.deleted
      WHERE a."recordType" = 'CPLAsset' AND NOT a.deleted AND upper(a."recordId") = ANY(${names}::text[])
    `.execute(this.db);
    return rows;
  }

  /** Identities whose asset is gone (deleted for good); the nightly cleanup removes them. */
  async removeOrphans(): Promise<number> {
    return this.db.transaction().execute(async (tx) => {
      await lockForkWrites(tx, 'iCloud identities cannot be cleaned up while the server is being handed over');
      const result = await sql`
        DELETE FROM immich_fork.icloud_source_identity i
        WHERE NOT EXISTS (SELECT 1 FROM public.asset a WHERE a.id = i."assetId" AND a."ownerId" = i."ownerId")
      `.execute(tx);
      return Number(result.numAffectedRows ?? 0);
    });
  }
}
