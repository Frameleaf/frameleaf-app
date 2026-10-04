import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm, UserMetadataKey } from 'src/enum.js';
import { ICloudConnection, ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import {
  guardWeeklyIdentityAdoption,
  lockIdentityAdoptionMetadata,
  weeklyIdentityAdoptionActive,
  weeklyIdentityAdoptionFence,
} from 'src/repositories/icloud-weekly-adoption-authority.js';
import { BUDDY_CAPTURE_LOCK, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { MediaIntegrityIdentity } from 'src/services/media-integrity.service.js';
import { hiddenContentAssetIdExists, isMotionOfLockedStill } from 'src/utils/database.js';
import { identityRoleOf, isAppleFingerprint, parseCloudIdentifier } from 'src/utils/icloud-identity.js';
import { resourcesForICloudAsset } from 'src/utils/icloud-records.js';
import { isNotLocked } from 'src/utils/locked.js';
import { getPreferences } from 'src/utils/preferences.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type IdentityAdoptionAuthority = {
  ownerId: string;
  connectionId: string;
  config: string;
  operationId: string;
  operationClaimToken: string;
  resourceId: string;
  resourceLeaseToken: string;
};
export type IdentityAdoptionCandidate = {
  identityId: string;
  assetId: string;
  sha256: Buffer;
  originalPath: string;
  originalFileName: string;
  type: AssetType;
  checksum: Buffer;
  checksumAlgorithm: ChecksumAlgorithm;
  updateId: string;
  physicalId: string | null;
  cplMasterRecordName: string;
  cloudIdentifier: string;
  libraryKey: string | null;
};
export type IdentityAdoptionEvidence = {
  sha1: Buffer;
  sha256: Buffer;
  sizeInBytes: number;
  appleFingerprint: string;
  identity: MediaIntegrityIdentity;
  current: () => Promise<boolean>;
};
export type IdentityAdoptionResult = 'miss' | 'retry' | 'adopted';
type Source = {
  resource: ICloudResource;
  sourceRevision: string;
  masterRevision: string;
  itemClaimId: string;
};
class Retired extends Error {}
class WeeklyUnavailable extends Error {}

/** No public/authenticated endpoint: this producer accepts only the claimed local sync operation. */
@Injectable()
export class ICloudIdentityAdoptionRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  async adopt(
    authority: IdentityAdoptionAuthority,
    verify: (candidate: IdentityAdoptionCandidate) => Promise<IdentityAdoptionEvidence | 'miss' | undefined>,
  ): Promise<IdentityAdoptionResult> {
    try {
      return await this.db.transaction().execute(async (db) => {
        // Match the managed writer global-before-path ordering, before any asset/user row lock.
        // lockFilePath acquires this shared capture lock before its per-path lock as well.
        await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(db);
        // Hints determine only the lock key, never adoption. Final selection must still be the same
        // single identity under current source/destination guards after this digest-before-user prefix.
        const hints = await sql<{
          sha256: Buffer;
        }>`SELECT i.sha256 FROM public.icloud_source_identity i
          JOIN public.icloud_resource r ON r.id=${authority.resourceId}::uuid
            AND r."ownerId"=i."ownerId" AND i."cplAssetRecordName"=upper(r."sourceAssetId")
          WHERE r."connectionId"=${authority.connectionId}::uuid AND i."ownerId"=${authority.ownerId}::uuid
            AND i."deliveredBy" LIKE 'device:%' AND i."editVersion"=''
            AND i.role=CASE r.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion' WHEN 'raw' THEN 'raw-alternate' END
            AND i."cplMasterRecordName"=r.source->>'sourceMasterId' LIMIT 2`.execute(db);
        const digest = hints.rows.length === 1 ? hints.rows[0].sha256 : undefined;
        if (digest) {
          const key = createHash('sha1')
            .update(`icloud-content:${authority.ownerId}:${digest.toString('hex')}`)
            .digest()
            .readBigInt64BE(0);
          await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(db);
        }
        const owner = await db
          .selectFrom('user')
          .select('id')
          .where('id', '=', authority.ownerId)
          .where('deletedAt', 'is', null)
          .forUpdate()
          .executeTakeFirst();
        if (!owner) {
          throw new Retired();
        }
        const weekly = await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId);
        if (!weekly) {
          return 'miss';
        }
        const source = await this.source(db, authority);
        if (!['original', 'motion', 'raw'].includes(source.resource.role) || source.resource.source.isHidden === true) {
          return 'miss';
        }
        const { rows } = await sql<IdentityAdoptionCandidate>`
          SELECT i.id AS "identityId",i."assetId",i.sha256,i."cplMasterRecordName",i."cloudIdentifier",i."libraryKey",
            a."originalPath",a."originalFileName",a.type,a.checksum,a."checksumAlgorithm",a."updateId",
            a."physicalOriginalFileId" AS "physicalId"
          FROM public.icloud_source_identity i JOIN public.asset a ON a.id=i."assetId" AND a."ownerId"=i."ownerId"
          WHERE i."ownerId"=${authority.ownerId}::uuid AND i."cplAssetRecordName"=upper(${source.resource.sourceAssetId})
            AND i.role=${identityRoleOf[source.resource.role]} AND i."editVersion"=''
            AND i."cplMasterRecordName"=${String(source.resource.source.sourceMasterId ?? '')}
            AND (i."libraryKey" IS NULL OR i."libraryKey"=${source.resource.libraryKey})
            AND i."deliveredBy" LIKE 'device:%' AND i."lastAuditResult" IS DISTINCT FROM 'mismatch'
          ORDER BY i.id LIMIT 2`.execute(db);
        if (rows.length !== 1) {
          return 'miss';
        }
        const candidate = rows[0];
        if (!digest?.equals(candidate.sha256)) {
          return 'miss';
        }
        if (candidate.type !== source.resource.source.type) {
          return 'miss';
        }
        if (!candidate.libraryKey) {
          const inventories = await sql<{
            count: number;
          }>`SELECT count(DISTINCT a."connectionId")::int AS count
            FROM public.icloud_record a JOIN public.icloud_connection c ON c.id=a."connectionId"
            WHERE c."ownerId"=${authority.ownerId}::uuid AND c.state='connected' AND c."encryptedSession" IS NOT NULL
              AND a."recordType"='CPLAsset' AND NOT a.deleted AND upper(a."recordId")=upper(${source.resource.sourceAssetId})
              AND a."masterId"=${candidate.cplMasterRecordName}`.execute(db);
          if (inventories.rows[0]?.count !== 1) {
            return 'miss';
          }
        }
        const parsed = parseCloudIdentifier(candidate.cloudIdentifier ?? '');
        if (
          !parsed ||
          parsed.cplAssetRecordName !== source.resource.sourceAssetId.toUpperCase() ||
          parsed.cplMasterRecordName !== candidate.cplMasterRecordName
        ) {
          return 'miss';
        }
        const fingerprint = (source.resource.source.resource as Record<string, unknown> | undefined)?.fileChecksum;
        if (typeof fingerprint !== 'string' || !isAppleFingerprint(fingerprint)) {
          return 'miss';
        }
        // Classification can update privacy metadata independently of the asset row.
        // Match DatabaseRepository.withAssetMetadataLock BEFORE any asset row lock, and hold
        // its authority through every file await, mapping/receipt publication and replay.
        if (!(await lockIdentityAdoptionMetadata(db, candidate.assetId))) {
          return 'retry';
        }
        await lockFilePath(db, candidate.originalPath);
        if (!(await this.destination(db, authority.ownerId, candidate, source.resource.role))) {
          return 'miss';
        }
        let replay:
          | {
              snapshot: Record<string, unknown>;
            }
          | undefined;
        if (source.resource.assetId !== null) {
          // A prior hash mapping cannot be relabelled as adoption. Replays need this producer's receipt.
          const receipt = await sql<{
            snapshot: Record<string, unknown>;
          }>`SELECT snapshot FROM public.icloud_identity_reuse
            WHERE "sourceResourceId"=${source.resource.id}::uuid AND "ownerId"=${authority.ownerId}::uuid
              AND "connectionId"=${authority.connectionId}::uuid AND "identityId"=${candidate.identityId}::uuid
              AND "assetId"=${candidate.assetId}::uuid AND "expectedSha256"=${candidate.sha256}`.execute(db);
          if (
            source.resource.assetId !== candidate.assetId ||
            !source.resource.sha256?.equals(candidate.sha256) ||
            receipt.rows.length !== 1
          ) {
            return 'miss';
          }
          replay = receipt.rows[0];
        }
        // The captured owner/input/grant rows remain locked; activation can still stop new work.
        if (!weeklyIdentityAdoptionActive()) {
          throw new WeeklyUnavailable();
        }
        const evidence = await verify(candidate);
        if (!weeklyIdentityAdoptionActive()) {
          throw new WeeklyUnavailable();
        }
        if (evidence === 'miss') {
          return 'miss';
        }
        if (!evidence) {
          return 'retry';
        }
        if (
          !evidence.sha256.equals(candidate.sha256) ||
          evidence.appleFingerprint !== fingerprint ||
          evidence.sizeInBytes !== source.resource.expectedSize ||
          !(candidate.checksumAlgorithm === ChecksumAlgorithm.sha256File
            ? candidate.checksum.equals(evidence.sha256)
            : candidate.checksumAlgorithm === ChecksumAlgorithm.sha1File && candidate.checksum.equals(evidence.sha1))
        ) {
          return 'miss';
        }
        if (!(await evidence.current())) {
          if (!(await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId, weekly))) {
            throw new WeeklyUnavailable();
          }
          return 'retry';
        }
        const finalSource = await this.source(db, authority);
        if (
          canonicalJson(finalSource) !== canonicalJson(source) ||
          !(await this.destination(db, authority.ownerId, candidate, source.resource.role))
        ) {
          throw new Retired();
        }
        const identity = await sql`SELECT id FROM public.icloud_source_identity
          WHERE id=${candidate.identityId}::uuid AND "ownerId"=${authority.ownerId}::uuid
            AND "assetId"=${candidate.assetId}::uuid AND sha256=${evidence.sha256}
            AND "cplAssetRecordName"=upper(${source.resource.sourceAssetId})
            AND "cplMasterRecordName"=${candidate.cplMasterRecordName} AND role=${identityRoleOf[source.resource.role]}
            AND "cloudIdentifier"=${candidate.cloudIdentifier} AND "deliveredBy" LIKE 'device:%'
            AND ("libraryKey" IS NULL OR "libraryKey"=${source.resource.libraryKey})
            AND "editVersion"='' AND "lastAuditResult" IS DISTINCT FROM 'mismatch' FOR SHARE`.execute(db);
        if (identity.rows.length !== 1) {
          throw new Retired();
        }
        const snapshot = {
          config: authority.config,
          resourceKey: source.resource.resourceKey,
          fingerprint: source.resource.fingerprint,
          sourceRevision: source.sourceRevision,
          masterRevision: source.masterRevision,
          originalPath: candidate.originalPath,
          updateId: candidate.updateId,
          checksum: candidate.checksum.toString('hex'),
          algorithm: candidate.checksumAlgorithm,
          physicalId: candidate.physicalId,
          fileIdentity: evidence.identity,
          sourceChecksum: fingerprint,
        };
        // Keep the same handle and pathname evidence current after the final awaited row checks.
        if (!(await evidence.current())) {
          if (!(await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId, weekly))) {
            throw new WeeklyUnavailable();
          }
          return 'retry';
        }
        if (!(await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId, weekly))) {
          throw new WeeklyUnavailable();
        }
        if (replay) {
          const live = await sql`SELECT r.id FROM public.icloud_resource r
            JOIN public.media_operation o ON o.id=${authority.operationId}::uuid
            JOIN public.icloud_claim c ON c.id=${source.itemClaimId}::uuid
            WHERE r.id=${authority.resourceId}::uuid AND r."ownerId"=${authority.ownerId}::uuid
              AND r."leaseToken"=${authority.resourceLeaseToken}::uuid AND r."leaseExpiresAt">clock_timestamp()
              AND o."ownerId"=r."ownerId" AND o."claimToken"=${authority.operationClaimToken}::uuid
              AND o."claimExpiresAt">clock_timestamp() AND o.status IN ('preparing','rendering','validating')
              AND o."cancelRequestedAt" IS NULL AND o."pauseRequestedAt" IS NULL
              AND c."ownerId"=r."ownerId" AND c.holder=${`icloud-sync:${authority.connectionId}`}
              AND c."expiresAt">clock_timestamp() AND ${weeklyIdentityAdoptionFence(weekly)}`.execute(db);
          if (
            live.rows.length !== 1 &&
            !(await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId, weekly))
          ) {
            throw new WeeklyUnavailable();
          }
          return live.rows.length === 1 && canonicalJson(replay.snapshot) === canonicalJson(snapshot)
            ? 'adopted'
            : 'retry';
        }
        // Final SQL uses database time after every awaited file/privacy check. It cannot resurrect an expired claim.
        const mapped = await sql`UPDATE public.icloud_resource SET "assetId"=${candidate.assetId}::uuid,
          path=${candidate.originalPath},sha1=${evidence.sha1},sha256=${evidence.sha256},status='committed',
          verification=${{ outcome: 'reused', basis: 'exact-identity', identity: evidence.identity, sizeInBytes: evidence.sizeInBytes }}::jsonb,
          "lastError"=NULL,"updatedAt"=clock_timestamp()
          WHERE id=${authority.resourceId}::uuid AND "ownerId"=${authority.ownerId}::uuid AND "assetId" IS NULL
            AND "leaseToken"=${authority.resourceLeaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()
            AND EXISTS (SELECT 1 FROM public.media_operation WHERE id=${authority.operationId}::uuid
              AND "ownerId"=${authority.ownerId}::uuid AND "claimToken"=${authority.operationClaimToken}::uuid
              AND "claimExpiresAt">clock_timestamp() AND status IN ('preparing','rendering','validating')
              AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL)
            AND EXISTS (SELECT 1 FROM public.icloud_claim WHERE id=${source.itemClaimId}::uuid
              AND "ownerId"=${authority.ownerId}::uuid AND holder=${`icloud-sync:${authority.connectionId}`}
              AND "expiresAt">clock_timestamp()) AND ${weeklyIdentityAdoptionFence(weekly)} RETURNING id`.execute(db);
        if (mapped.rows.length !== 1) {
          if (!(await guardWeeklyIdentityAdoption(db, authority.ownerId, authority.connectionId, weekly))) {
            throw new WeeklyUnavailable();
          }
          throw new Retired();
        }
        const receipt = await sql`INSERT INTO public.icloud_identity_reuse
          ("ownerId","connectionId","sourceResourceId","identityId","assetId","operationId","itemClaimId",basis,
           "libraryKey","cplAssetRecordName","cplMasterRecordName",role,"expectedSha256","appleFingerprint",snapshot)
          SELECT ${authority.ownerId}::uuid,${authority.connectionId}::uuid,${authority.resourceId}::uuid,
            ${candidate.identityId}::uuid,${candidate.assetId}::uuid,${authority.operationId}::uuid,${source.itemClaimId}::uuid,
            'exact-identity',${source.resource.libraryKey},upper(${source.resource.sourceAssetId}),
            ${candidate.cplMasterRecordName},${identityRoleOf[source.resource.role]},${evidence.sha256},
            ${evidence.appleFingerprint},${JSON.stringify(snapshot)}::text::jsonb WHERE ${weeklyIdentityAdoptionFence(weekly)} RETURNING id`.execute(
          db,
        );
        if (receipt.rows.length !== 1) {
          throw new WeeklyUnavailable();
        }
        return 'adopted';
      });
    } catch (error) {
      if (error instanceof WeeklyUnavailable) {
        return 'miss';
      }
      return 'retry';
    }
  }
  private async source(db: Transaction<DB>, authority: IdentityAdoptionAuthority): Promise<Source> {
    const connection = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
      WHERE id=${authority.connectionId}::uuid AND "ownerId"=${authority.ownerId}::uuid AND state='connected'
        AND "encryptedSession" IS NOT NULL AND "lastError" IS DISTINCT FROM 'owner_removed' FOR SHARE`
      .execute(db)
      .then(({ rows }) => rows[0]);
    const operation = await sql`SELECT id FROM public.media_operation WHERE id=${authority.operationId}::uuid
      AND "ownerId"=${authority.ownerId}::uuid AND kind='icloud_sync'
      AND snapshot->>'connectionId'=${authority.connectionId} AND snapshot->>'task' IS NULL
      AND "claimToken"=${authority.operationClaimToken}::uuid AND "claimExpiresAt">clock_timestamp()
      AND status IN ('preparing','rendering','validating') AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL
      FOR SHARE`.execute(db);
    if (!connection || canonicalJson(connection.config) !== authority.config || operation.rows.length !== 1) {
      throw new Retired();
    }
    const resource = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
      FROM public.icloud_resource WHERE id=${authority.resourceId}::uuid AND "ownerId"=${authority.ownerId}::uuid
        AND "connectionId"=${authority.connectionId}::uuid AND "auditRequestId" IS NULL
        AND status IN ('pending','retry','staging','committed') AND coalesce((source->>'current')::boolean,true)
        AND "leaseToken"=${authority.resourceLeaseToken}::uuid AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`
      .execute(db)
      .then(({ rows }) => rows[0]);
    if (
      !resource ||
      (resource.source.isHidden === true && !connection.config.includeHidden) ||
      (resource.role.startsWith('edited-') && !connection.config.includeEdits) ||
      resource.stagingPath ||
      resource.expectedTarget ||
      (connection.config.libraries.length > 0 && !connection.config.libraries.includes(resource.libraryKey))
    ) {
      throw new Retired();
    }
    const records = await sql<{
      recordId: string;
      recordType: string;
      revision: string;
      fields: Record<string, unknown>;
    }>`
      SELECT "recordId","recordType",revision,fields FROM public.icloud_record
      WHERE "connectionId"=${authority.connectionId}::uuid AND "libraryKey"=${resource.libraryKey} AND NOT deleted
        AND "recordId" IN (${resource.sourceAssetId},${String(resource.source.sourceMasterId ?? '')}) FOR SHARE`.execute(
      db,
    );
    const asset = records.rows.find((row) => row.recordId === resource.sourceAssetId);
    const master = records.rows.find((row) => row.recordId === resource.source.sourceMasterId);
    if (!asset || !master) {
      throw new Retired();
    }
    const normalize = (r: NonNullable<typeof asset>) => ({
      recordName: r.recordId,
      recordType: r.recordType,
      recordChangeTag: r.revision,
      fields: r.fields,
    });
    if (
      resourcesForICloudAsset(normalize(asset), normalize(master)).every(
        (r) =>
          !(
            r.recordId === resource.recordId &&
            r.resourceKey === resource.resourceKey &&
            r.role === resource.role &&
            r.fingerprint === resource.fingerprint &&
            r.expectedSize === resource.expectedSize &&
            r.source.type === resource.source.type &&
            r.source.isHidden === resource.source.isHidden &&
            canonicalJson(r.source.resource) === canonicalJson(resource.source.resource)
          ),
      )
    ) {
      throw new Retired();
    }
    if (connection.config.albums.length > 0) {
      const member =
        await sql`SELECT 1 FROM public.icloud_membership WHERE "connectionId"=${authority.connectionId}::uuid
        AND "libraryKey"=${resource.libraryKey} AND "sourceAssetId"=${resource.sourceAssetId} AND "sourcePresent"
        AND ("libraryKey"||':'||"sourceAlbumId")=ANY(${connection.config.albums}::text[]) FOR SHARE`.execute(db);
      if (member.rows.length === 0) {
        throw new Retired();
      }
    }
    const claim = await sql<{
      id: string;
    }>`SELECT id FROM public.icloud_claim WHERE "ownerId"=${authority.ownerId}::uuid
      AND "cplAssetRecordName"=upper(${resource.sourceAssetId}) AND holder=${`icloud-sync:${authority.connectionId}`}
      AND "expiresAt">clock_timestamp() FOR SHARE`
      .execute(db)
      .then(({ rows }) => rows[0]);
    if (!claim) {
      throw new Retired();
    }
    return { resource, sourceRevision: asset.revision, masterRevision: master.revision, itemClaimId: claim.id };
  }
  private async destination(
    db: Transaction<DB>,
    ownerId: string,
    candidate: IdentityAdoptionCandidate,
    role: string,
  ): Promise<boolean> {
    const metadata = await db
      .selectFrom('user_metadata')
      .selectAll()
      .where('userId', '=', ownerId)
      .where('key', '=', UserMetadataKey.Preferences)
      .forShare()
      .execute();
    const suppression = getPreferences(metadata).privacy.suppression;
    const row = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', candidate.assetId)
      .where('ownerId', '=', ownerId)
      .where('deletedAt', 'is', null)
      .where('status', '=', AssetStatus.Active)
      .where('isExternal', '=', false)
      .where('isOffline', '=', false)
      .$if(role !== 'motion', (qb) => qb.where('visibility', '!=', AssetVisibility.Hidden))
      .where(isNotLocked('asset'))
      .where((eb) => eb.not(isMotionOfLockedStill(eb)))
      .where(
        sql<boolean>`NOT ${hiddenContentAssetIdExists(sql.ref('asset.id'), { userId: ownerId, includeNsfw: true, ...suppression })}`,
      )
      .forUpdate()
      .executeTakeFirst();
    if (
      !row ||
      row.originalPath !== candidate.originalPath ||
      row.updateId !== candidate.updateId ||
      row.type !== candidate.type ||
      row.originalFileName !== candidate.originalFileName ||
      row.checksumAlgorithm !== candidate.checksumAlgorithm ||
      !row.checksum.equals(candidate.checksum)
    ) {
      return false;
    }
    if (row.libraryId) {
      const library = await db
        .selectFrom('library')
        .select('id')
        .where('id', '=', row.libraryId)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!library) {
        return false;
      }
    }
    if (row.physicalOriginalFileId !== candidate.physicalId) {
      return false;
    }
    const unsafe = await sql`SELECT 1 FROM public.asset_health
          WHERE "assetId"=${candidate.assetId}::uuid AND category IN ('missing','corrupt')
            AND "resolvedAt" IS NULL AND status NOT IN ('resolved','relinked','trashed')`.execute(db);
    return unsafe.rows.length === 0;
  }
}
