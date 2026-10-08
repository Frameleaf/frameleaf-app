import { Injectable, Optional } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AuditExecutionAuthority } from 'src/repositories/icloud-scheduled-authority.js';
import type { MediaIntegrityIdentity, MediaIntegrityResult } from 'src/services/media-integrity.service.js';
import {
  AssetLockReason,
  AssetStatus,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  MediaHealthStatus,
  PhysicalFileType,
  UserMetadataKey,
} from 'src/enum.js';
import { guardAudit, guardAuditAuthority, publishAudit } from 'src/repositories/icloud-audit.repository.js';
import {
  ICloudEditAuthorityRepository,
  editAuthorityReviewReason,
} from 'src/repositories/icloud-edit-authority.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { withICloudPublicationTransaction } from 'src/repositories/icloud-edit-transaction.js';
import { guardScheduledAudit } from 'src/repositories/icloud-scheduled-authority.js';
import { ScheduledPublicationFiles, publishScheduledAudit } from 'src/repositories/icloud-scheduled-publication.js';
import { ICloudScheduledStagingRepository } from 'src/repositories/icloud-scheduled-staging.repository.js';
import {
  WeeklyIdentityAdoptionContext,
  guardWeeklyIdentityAdoption,
  lockIdentityAdoptionMetadata,
  weeklyIdentityAdoptionFence,
} from 'src/repositories/icloud-weekly-adoption-authority.js';
import { BUDDY_CAPTURE_LOCK, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { hiddenContentAssetIdExists } from 'src/utils/database.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type VerifiedMedia = Extract<
  MediaIntegrityResult,
  {
    status: 'healthy';
  }
>;
export type RecoveryOutcome =
  | 'imported'
  | 'reused'
  | 'repaired-missing'
  | 'repaired-corrupt'
  | 'preserve-trashed'
  | 'needs-review'
  | 'retry'
  | 'failed';
export type RecoveryResult = {
  outcome: RecoveryOutcome;
  assetId?: string;
  reason?: string;
};
export type RecoveryResource = {
  id: string;
  ownerId: string;
  connectionId: string;
  assetId: string | null;
  status: string;
  stagingPath: string | null;
  promotedPath: string | null;
  expectedSize: number | null;
  expectedTarget: RecoveryTarget | null;
  sha1: Buffer | null;
  sha256: Buffer | null;
  verification: Record<string, unknown> | null;
};
export type RecoveryCandidate = {
  id: string;
  ownerId: string;
  updateId: string;
  originalPath: string;
  checksum: Buffer;
  checksumAlgorithm: ChecksumAlgorithm;
  originalFileName: string;
  type: AssetType;
  isExternal: boolean;
  libraryId: string | null;
  deletedAt: Date | null;
  status: AssetStatus;
  isOffline: boolean;
  hidden: boolean;
  physicalOriginalFileId: string | null;
  sizeInBytes: number | null;
  damaged: boolean;
  matchesContent: boolean;
  identityConflict: boolean;
  /** Why the asset is Locked, when it is (FL-34) */
  lockReason: AssetLockReason | null;
};
export type RecoveryTarget = {
  assetId: string;
  updateId: string | null;
  originalPath: string | null;
  checksumHex: string | null;
  checksumAlgorithm: ChecksumAlgorithm | null;
  isExternal: boolean;
  libraryId: string | null;
  physicalOriginalFileId: string | null;
  outcome: 'imported' | 'reused' | 'repaired-missing' | 'repaired-corrupt';
  /**
   * FL-69: an external original with the same content, recorded as evidence only. Recovery never modifies
   * it and never reuses it: the item is imported as a new managed asset beside it (owner decision).
   */
  matchedExternalAssetId?: string;
};
export type RecoveryAuthority = {
  resourceId: string;
  leaseToken: string;
  ownerId: string;
  includeHidden: boolean;
  audit?: AuditExecutionAuthority;
  scheduled?: ScheduledPublicationFiles;
  /** Captured internally before decoding a genuine 0217 mapped reuse; never scheduled/session authority. */
  weeklyReuse?: WeeklyIdentityAdoptionContext;
};
export type RecoveryReservation = {
  target: RecoveryTarget;
  promotedPath: string;
};
@Injectable()
export class MediaRecoveryRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    @Optional() private scheduledStaging?: ICloudScheduledStagingRepository,
  ) {}

  async identityReuseAuthority(
    input: RecoveryAuthority,
    db?: Transaction<DB>,
  ): Promise<{
    required: boolean;
    context?: WeeklyIdentityAdoptionContext;
    fileIdentity?: MediaIntegrityIdentity;
  }> {
    if (input.audit) {
      return { required: false };
    }
    if (!db) {
      return this.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(trx);
        return this.identityReuseAuthority(input, trx);
      });
    }
    // A real immutable receipt selects this branch; a verification JSON label cannot create consent authority.
    const { rows } = await sql<{
      connectionId: string;
      valid: boolean;
      fileIdentity: MediaIntegrityIdentity;
      config: string;
    }>`SELECT r."connectionId",
      reuse.snapshot->'fileIdentity' AS "fileIdentity",reuse.snapshot->>'config' AS config,
      (r."assetId"=reuse."assetId" AND r.sha256=reuse."expectedSha256" AND i."assetId"=reuse."assetId"
        AND r."libraryKey" IS NOT DISTINCT FROM reuse."libraryKey" AND upper(r."sourceAssetId")=reuse."cplAssetRecordName"
        AND r.source->>'sourceMasterId'=reuse."cplMasterRecordName"
        AND reuse.role=CASE r.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion' WHEN 'raw' THEN 'raw-alternate' END
        AND i.sha256=reuse."expectedSha256" AND i."deliveredBy" LIKE 'device:%' AND i."editVersion"=''
        AND i."lastAuditResult" IS DISTINCT FROM 'mismatch' AND i.role=reuse.role
        AND i."cplAssetRecordName"=reuse."cplAssetRecordName" AND i."cplMasterRecordName"=reuse."cplMasterRecordName"
        AND r."resourceKey"=reuse.snapshot->>'resourceKey' AND r.fingerprint=reuse.snapshot->>'fingerprint'
        AND asset.revision=reuse.snapshot->>'sourceRevision' AND master.revision=reuse.snapshot->>'masterRevision'
        AND NOT asset.deleted AND NOT master.deleted AND a."originalPath"=reuse.snapshot->>'originalPath'
        AND a."updateId"::text=reuse.snapshot->>'updateId' AND encode(a.checksum,'hex')=reuse.snapshot->>'checksum'
        AND a."checksumAlgorithm"::text=reuse.snapshot->>'algorithm'
        AND (to_jsonb(a)->>'physicalOriginalFileId') IS NOT DISTINCT FROM reuse.snapshot->>'physicalId'
        AND (a."physicalOriginalFileId" IS NULL OR p.path=a."originalPath")) AS valid
      FROM public.icloud_identity_reuse reuse
      JOIN public.icloud_resource r ON r.id=reuse."sourceResourceId" AND r."ownerId"=reuse."ownerId"
        AND r."connectionId"=reuse."connectionId"
      LEFT JOIN public.icloud_source_identity i ON i.id=reuse."identityId" AND i."ownerId"=reuse."ownerId"
      LEFT JOIN public.asset a ON a.id=reuse."assetId" AND a."ownerId"=reuse."ownerId"
      LEFT JOIN public.physical_file p ON p.id=a."physicalOriginalFileId"
      LEFT JOIN public.icloud_record asset ON asset."connectionId"=r."connectionId" AND asset."libraryKey"=r."libraryKey"
        AND asset."recordId"=r."sourceAssetId"
      LEFT JOIN public.icloud_record master ON master."connectionId"=r."connectionId" AND master."libraryKey"=r."libraryKey"
        AND master."recordId"=r.source->>'sourceMasterId'
      WHERE reuse."sourceResourceId"=${input.resourceId}::uuid AND reuse."ownerId"=${input.ownerId}::uuid`.execute(db);
    if (rows.length === 0) {
      return { required: !!input.weeklyReuse };
    }
    if (rows.length !== 1 || !rows[0].valid) {
      return { required: true };
    }
    const context = await guardWeeklyIdentityAdoption(db, input.ownerId, rows[0].connectionId, input.weeklyReuse);
    if (!context || canonicalJson(context.config) !== rows[0].config) {
      return { required: true };
    }
    const hidden = await this.hiddenFilter(db, input.ownerId);
    const eligible = await sql`SELECT 1 FROM public.asset a
      JOIN public.icloud_identity_reuse reuse ON reuse."assetId"=a.id AND reuse."ownerId"=a."ownerId"
      WHERE reuse."sourceResourceId"=${input.resourceId}::uuid AND a."ownerId"=${input.ownerId}::uuid
        AND a."deletedAt" IS NULL AND a.status=${AssetStatus.Active} AND NOT a."isExternal" AND NOT a."isOffline"
        AND (reuse.role='live-motion' OR a.visibility<>${AssetVisibility.Hidden}) AND NOT ${hidden}
        AND NOT EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId"=a.id)
        AND NOT EXISTS (SELECT 1 FROM public.asset still JOIN public.asset_lock l ON l."assetId"=still.id
          WHERE still."livePhotoVideoId"=a.id)`.execute(db);
    if (eligible.rows.length !== 1) {
      return { required: true };
    }
    return { required: true, context, fileIdentity: rows[0].fileIdentity };
  }

  async getResource(input: RecoveryAuthority): Promise<RecoveryResource | undefined> {
    if (input.audit?.purpose === 'scheduled-weekly') {
      return this.db.transaction().execute(async (db) => {
        if (
          !(await guardAuditAuthority(db, input.audit!, input.ownerId, true, {
            id: input.resourceId,
            leaseToken: input.leaseToken,
          }))
        ) {
          return;
        }
        // Read admission only; every recovery mutator still refuses scheduled execution.
        return (
          await sql<RecoveryResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
          FROM public.icloud_resource WHERE id=${input.resourceId}::uuid AND "ownerId"=${input.ownerId}::uuid
            AND "auditRequestId"=${input.audit!.auditRequestId}::uuid AND "leaseToken"=${input.leaseToken}::uuid
            AND "leaseExpiresAt">clock_timestamp() AND status NOT IN ('removed','finalized')`.execute(db)
        ).rows[0];
      });
    }
    if (input.audit && !(await guardAudit(this.db, input.audit, input.ownerId))) {
      return;
    }
    const result = await sql<RecoveryResource>`
      SELECT r.*, r."expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource r
      JOIN public.icloud_connection c ON c.id = r."connectionId" AND c."ownerId" = r."ownerId"
      WHERE r.id = ${input.resourceId}::uuid AND r."ownerId" = ${input.ownerId}::uuid
        AND r."leaseToken" = ${input.leaseToken}::uuid AND r."leaseExpiresAt" > now()
        AND r.status <> 'removed' AND c.state = 'connected'
        AND r."auditRequestId" IS NOT DISTINCT FROM ${input.audit?.auditRequestId ?? null}::uuid
    `.execute(this.db);
    return result.rows[0];
  }
  async findCandidates(
    ownerId: string,
    verified: Pick<VerifiedMedia, 'sha1' | 'sha256'>,
    mappedId?: string | null,
  ): Promise<RecoveryCandidate[]> {
    return this.candidates(this.db, ownerId, verified, mappedId);
  }
  private async candidates(
    db: Kysely<DB>,
    ownerId: string,
    verified: Pick<VerifiedMedia, 'sha1' | 'sha256'>,
    mappedId?: string | null,
  ) {
    const hidden = await this.hiddenFilter(db, ownerId);
    const rows = await sql<RecoveryCandidate>`
      SELECT a.id, a."ownerId", a."updateId", a."originalPath", a.checksum, a."checksumAlgorithm",
        a."originalFileName", a.type, a."isExternal", a."libraryId", a."deletedAt", a.status, a."isOffline",
        CASE a."checksumAlgorithm"
          WHEN ${ChecksumAlgorithm.sha1File} THEN a.checksum <> ${verified.sha1}
          WHEN ${ChecksumAlgorithm.sha256File} THEN a.checksum <> ${verified.sha256}
          ELSE (s.sha1 IS NOT NULL AND s.sha1 <> ${verified.sha1}) OR (s.sha256 IS NOT NULL AND s.sha256 <> ${verified.sha256})
        END AS "identityConflict",
        CASE a."checksumAlgorithm"
          WHEN ${ChecksumAlgorithm.sha1File} THEN a.checksum = ${verified.sha1}
          WHEN ${ChecksumAlgorithm.sha256File} THEN a.checksum = ${verified.sha256}
          ELSE COALESCE(s.sha1 = ${verified.sha1} AND s.sha256 = ${verified.sha256}, false)
        END AS "matchesContent",
        a."physicalOriginalFileId", e."fileSizeInByte"::float8 AS "sizeInBytes",
        (EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId" = a.id) OR ${hidden}) AS hidden,
        (SELECT l.reason FROM public.asset_lock l WHERE l."assetId" = a.id) AS "lockReason",
        EXISTS (SELECT 1 FROM ${sql.id('public', 'asset_health')} h
          WHERE h."assetId" = a.id AND h.category IN ('missing', 'corrupt') AND h."resolvedAt" IS NULL
          AND h.status NOT IN ('resolved', 'relinked', 'trashed')) AS damaged
      FROM public.asset a LEFT JOIN public.asset_exif e ON e."assetId" = a.id
      LEFT JOIN public.asset_checksum s ON s."assetId" = a.id
      WHERE a."ownerId" = ${ownerId}::uuid AND a.id IN (
        ${this.contentMatchIds(ownerId, verified)}
        UNION SELECT ${mappedId ?? null}::uuid)
      ORDER BY (a.id = ${mappedId ?? null}::uuid) DESC NULLS LAST, a."isExternal", a.id LIMIT 33
    `.execute(db);
    return rows.rows;
  }
  async commitVerifiedReuse(
    input: RecoveryAuthority & {
      candidate: RecoveryCandidate;
      verified: VerifiedMedia;
      verifyFinal: () => Promise<MediaIntegrityResult>;
    },
  ): Promise<RecoveryResult> {
    if (input.audit?.purpose === 'scheduled-weekly') {
      return { outcome: 'retry', reason: 'mapping_changed' };
    }
    return withICloudPublicationTransaction(this.db, input.ownerId, [{channel:'icloud-sync',id:input.resourceId}], async (trx) => {
      const editAuthority = new ICloudEditAuthorityRepository(trx);
      const editItem = await editAuthority.itemHint(trx, input.ownerId, 'icloud-sync', input.resourceId);
      await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
      const reuse = await this.identityReuseAuthority(input, trx as Transaction<DB>);
      if (reuse.required && (!input.weeklyReuse || !reuse.context)) {
        return { outcome: 'retry', reason: 'identity_adoption_unavailable' };
      }
      // The real classification writer's metadata protocol precedes lockTarget's asset row lock.
      if (reuse.required && !(await lockIdentityAdoptionMetadata(trx as Transaction<DB>, input.candidate.id))) {
        return { outcome: 'retry', reason: 'identity_adoption_unavailable' };
      }
      const resource = await this.lockResource(trx, input);
      if (
        !resource ||
        resource.assetId !== input.candidate.id ||
        !resource.sha256?.equals(input.verified.sha256) ||
        !resource.sha1?.equals(input.verified.sha1)
      ) {
        return { outcome: 'retry', reason: 'mapping_changed' };
      }
      let edit;
      try {
        edit =
          editItem && !['committed', 'finalized'].includes(resource.status)
            ? await editAuthority.publication(trx, input.ownerId, 'icloud-sync', input.resourceId)
            : undefined;
      } catch (error) {
        const reason = editAuthorityReviewReason(error);
        if (reason) {
          return { outcome: 'needs-review', reason };
        }
        throw error;
      }
      if (edit && edit.existingAssetId !== input.candidate.id) {
        return { outcome: 'needs-review', reason: 'edit_bound_asset_required' };
      }
      const target: RecoveryTarget = {
        assetId: input.candidate.id,
        updateId: input.candidate.updateId,
        originalPath: input.candidate.originalPath,
        checksumHex: input.candidate.checksum.toString('hex'),
        checksumAlgorithm: input.candidate.checksumAlgorithm,
        isExternal: input.candidate.isExternal,
        libraryId: input.candidate.libraryId,
        physicalOriginalFileId: input.candidate.physicalOriginalFileId,
        outcome: 'reused',
      };
      const candidate = await this.lockTarget(trx, input, target, input.verified);
      if (!candidate || candidate.damaged || candidate.isOffline) {
        return { outcome: 'retry', reason: 'target_changed' };
      }
      if (
        reuse.required &&
        (candidate.hidden || canonicalJson(input.verified.identity) !== canonicalJson(reuse.fileIdentity))
      ) {
        return { outcome: 'retry', reason: 'identity_adoption_unavailable' };
      }
      const final = await input.verifyFinal();
      if (
        final.status !== 'healthy' ||
        !final.sha256.equals(input.verified.sha256) ||
        final.sizeInBytes !== input.verified.sizeInBytes
      ) {
        return { outcome: 'retry', reason: 'final_verification_failed' };
      }
      if (!(await this.lockResource(trx, input))) {
        return { outcome: 'retry', reason: 'lease_expired' };
      }
      const finalReuse = await this.identityReuseAuthority(input, trx as Transaction<DB>);
      if (
        finalReuse.required !== reuse.required ||
        (finalReuse.required &&
          (!finalReuse.context || canonicalJson(final.identity) !== canonicalJson(finalReuse.fileIdentity)))
      ) {
        return { outcome: 'retry', reason: 'identity_adoption_unavailable' };
      }
      const updated = await sql`UPDATE public.icloud_resource SET
        status = 'committed',
        path = ${candidate.originalPath}, verification = (CASE WHEN ${reuse.required} THEN coalesce(verification,'{}'::jsonb)
          ELSE '{}'::jsonb END) || ${JSON.stringify({ outcome: 'reused', identity: final.identity, sizeInBytes: final.sizeInBytes })}::text::jsonb,
        "lastError" = NULL, "updatedAt" = now() WHERE id = ${input.resourceId}::uuid
          AND ${finalReuse.context ? weeklyIdentityAdoptionFence(finalReuse.context) : sql<boolean>`true`}
          AND (NOT ${reuse.required} OR ("leaseToken"=${input.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()))
          RETURNING id`.execute(trx);
      if (updated.rows.length !== 1) {
        return { outcome: 'retry', reason: 'identity_adoption_unavailable' };
      }
      if (edit) {
        await editAuthority.published(trx, input.ownerId, edit, candidate.id, false);
      }
      return { outcome: 'reused', assetId: candidate.id };
    });
  }
  async reserve(
    input: RecoveryAuthority & {
      verified: VerifiedMedia;
      candidate?: RecoveryCandidate;
      outcome: RecoveryTarget['outcome'];
      proposedPath: string;
      matchedExternalAssetId?: string;
    },
  ): Promise<RecoveryReservation | undefined> {
    return this.db.transaction().execute(async (trx) => {
      const editAuthority = new ICloudEditAuthorityRepository(trx);
      const editItem = await editAuthority.itemHint(trx, input.ownerId, 'icloud-sync', input.resourceId);
      if (editItem) {
        await lockICloudItemClaims(trx, input.ownerId, [editItem]);
      }
      if (input.audit?.purpose === 'scheduled-weekly' && input.outcome !== 'reused') {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(trx);
      }
      if (
        input.audit?.purpose === 'scheduled-weekly' &&
        !(await guardScheduledAudit(trx as Transaction<DB>, input.audit, input.ownerId, {
          resource: { id: input.resourceId, leaseToken: input.leaseToken },
          candidateAssetIds: input.candidate ? [input.candidate.id] : [],
          managedPaths: [input.proposedPath, ...(input.candidate ? [input.candidate.originalPath] : [])],
          recoveryChecksum: input.verified.sha256,
        }))
      ) {
        return;
      }
      await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
      const resource = await this.lockResource(trx, input);
      if (!resource || ['committed', 'finalized'].includes(resource.status)) {
        return;
      }
      if (input.audit) {
        const audit = await guardAuditAuthority(trx, input.audit, input.ownerId, true, {
          id: input.resourceId,
          leaseToken: input.leaseToken,
        });
        if (!audit || audit.request.expectedSha256.equals(input.verified.sha256)) {
          return;
        }
      }
      const matchedExternalAssetId = input.candidate ? undefined : input.matchedExternalAssetId;
      const target: RecoveryTarget = resource.expectedTarget ?? {
        assetId: input.candidate?.id ?? randomUUID(),
        updateId: input.candidate?.updateId ?? null,
        originalPath: input.candidate?.originalPath ?? null,
        checksumHex: input.candidate?.checksum.toString('hex') ?? null,
        checksumAlgorithm: input.candidate?.checksumAlgorithm ?? null,
        isExternal: input.candidate?.isExternal ?? false,
        libraryId: input.candidate?.libraryId ?? null,
        physicalOriginalFileId: input.candidate?.physicalOriginalFileId ?? null,
        outcome: input.outcome,
        ...(matchedExternalAssetId && { matchedExternalAssetId }),
      };
      if (resource.sha256 && !resource.sha256.equals(input.verified.sha256)) {
        return;
      }
      if (target.updateId) {
        // Retry unrelated asset edits against a fresh generation, preserving the reserved bytes and identity.
        const refreshed = input.candidate;
        if (
          refreshed &&
          refreshed.id === target.assetId &&
          refreshed.originalPath === target.originalPath &&
          refreshed.checksum.toString('hex') === target.checksumHex &&
          refreshed.checksumAlgorithm === target.checksumAlgorithm &&
          refreshed.isExternal === target.isExternal &&
          refreshed.libraryId === target.libraryId &&
          refreshed.physicalOriginalFileId === target.physicalOriginalFileId
        ) {
          target.updateId = refreshed.updateId;
        }
        if (!(await this.lockTarget(trx, input, target, input.verified))) {
          return;
        }
      } else if (await this.hasManagedMatch(trx, input.ownerId, input.verified)) {
        return;
      }
      const promotedPath = resource.promotedPath ?? input.proposedPath;
      await this.lockPath(trx, promotedPath);
      await sql`UPDATE public.icloud_resource SET "expectedTarget" = ${target}::jsonb,
        "promotedPath" = ${promotedPath}, sha1 = ${input.verified.sha1}, sha256 = ${input.verified.sha256},
        "updatedAt" = now() WHERE id = ${input.resourceId}::uuid`.execute(trx);
      if (
        input.audit?.purpose === 'scheduled-weekly' &&
        target.outcome !== 'reused' &&
        (!this.scheduledStaging ||
          !(await this.scheduledStaging.planPrivateCopy(
            trx as Transaction<DB>,
            {
              authority: input.audit,
              ownerId: input.ownerId,
              resource: { id: input.resourceId, leaseToken: input.leaseToken },
            },
            promotedPath,
          )))
      ) {
        throw new Error('scheduled_private_copy_reservation_unavailable');
      }
      return { target, promotedPath };
    });
  }
  async commit(
    input: RecoveryAuthority & {
      reservation: RecoveryReservation;
      verified: VerifiedMedia;
      originalFileName: string;
      type: AssetType;
      sourceCreatedAt?: Date;
      sourceHidden?: boolean;
      verifyFinal: () => Promise<MediaIntegrityResult>;
    },
  ): Promise<RecoveryResult> {
    const scheduledAuthority = input.audit?.purpose === 'scheduled-weekly' ? input.audit : undefined;
    let scheduledFinal: MediaIntegrityResult | undefined;
    if (scheduledAuthority) {
      if (
        !input.scheduled ||
        !this.scheduledStaging ||
        !(await this.scheduledStaging.authenticateReceipt(
          {
            authority: scheduledAuthority,
            ownerId: input.ownerId,
            resource: { id: input.resourceId, leaseToken: input.leaseToken },
          },
          input.scheduled.receipt,
        ))
      ) {
        return { outcome: 'retry', reason: 'scheduled_fresh_receipt_invalid' };
      }
      scheduledFinal = await input.verifyFinal(); // Copy/hash/decode and true settlement, outside all DB locks.
      if (
        !(await this.scheduledStaging.authenticateDeepValidation(
          {
            authority: scheduledAuthority,
            ownerId: input.ownerId,
            resource: { id: input.resourceId, leaseToken: input.leaseToken },
          },
          input.scheduled.validation,
        ))
      ) {
        return { outcome: 'retry', reason: 'scheduled_deep_receipt_invalid' };
      }
      if (scheduledFinal.status !== 'healthy') {
        return { outcome: 'retry', reason: 'final_verification_failed' };
      }
    }
    return withICloudPublicationTransaction(this.db, input.ownerId, [{channel:'icloud-sync',id:input.resourceId}], async (trx) => {
      const editAuthority = new ICloudEditAuthorityRepository(trx);
      const editItem = await editAuthority.itemHint(trx, input.ownerId, 'icloud-sync', input.resourceId);
      if (
        scheduledAuthority &&
        !(await guardScheduledAudit(trx as Transaction<DB>, scheduledAuthority, input.ownerId, {
          resource: { id: input.resourceId, leaseToken: input.leaseToken },
          candidateAssetIds: [input.reservation.target.assetId],
          managedPaths: [
            input.reservation.promotedPath,
            ...(input.reservation.target.originalPath ? [input.reservation.target.originalPath] : []),
            ...(input.scheduled?.paths ?? []),
          ],
          recoveryChecksum: input.verified.sha256,
        }))
      ) {
        return { outcome: 'retry', reason: 'scheduled_authority_changed' };
      }
      await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
      const resource = await this.lockResource(trx, input);
      const { target, promotedPath } = input.reservation;
      if (!resource) {
        return { outcome: 'retry', reason: 'lease_changed' };
      }
      if (['committed', 'finalized'].includes(resource.status)) {
        const current = resource.assetId
          ? await trx
              .selectFrom('asset')
              .selectAll()
              .where('id', '=', resource.assetId)
              .where('ownerId', '=', input.ownerId)
              .forUpdate()
              .executeTakeFirst()
          : undefined;
        if (!current) {
          return { outcome: 'needs-review', reason: 'mapped_asset_identity_changed' };
        }
        if (current.deletedAt || current.status !== AssetStatus.Active) {
          return { outcome: 'preserve-trashed', assetId: current.id, reason: 'destination_not_active' };
        }
        const matches = await this.candidates(trx, input.ownerId, input.verified, current.id);
        const candidate = matches.find(({ id }) => id === current.id);
        if (!candidate?.matchesContent || candidate.identityConflict || (candidate.hidden && !input.includeHidden)) {
          return { outcome: 'needs-review', reason: 'mapped_asset_identity_changed' };
        }
        if (candidate.damaged || current.isOffline || current.originalPath !== promotedPath) {
          return { outcome: 'retry', reason: 'target_changed' };
        }
        const final = scheduledFinal ?? (await input.verifyFinal());
        if (
          final.status !== 'healthy' ||
          !final.sha256.equals(input.verified.sha256) ||
          !final.sha1.equals(input.verified.sha1) ||
          final.sizeInBytes !== input.verified.sizeInBytes
        ) {
          return { outcome: 'retry', reason: 'final_verification_failed' };
        }
        return { outcome: 'reused', assetId: current.id, reason: 'already_committed' };
      }
      let edit;
      try {
        edit = editItem
          ? await editAuthority.publication(trx, input.ownerId, 'icloud-sync', input.resourceId)
          : undefined;
      } catch (error) {
        const reason = editAuthorityReviewReason(error);
        if (reason) {
          return { outcome: 'needs-review', reason };
        }
        throw error;
      }
      if (
        edit &&
        (target.updateId || target.outcome === 'reused' || edit.existingAssetId) &&
        edit.existingAssetId !== target.assetId
      ) {
        return { outcome: 'needs-review', reason: 'edit_bound_asset_required' };
      }
      if (
        resource.promotedPath !== promotedPath ||
        !isDeepStrictEqual(resource.expectedTarget, target) ||
        !resource.sha256?.equals(input.verified.sha256)
      ) {
        return { outcome: 'retry', reason: 'reservation_changed' };
      }
      await this.lockPath(trx, promotedPath);
      const candidate = target.updateId ? await this.lockTarget(trx, input, target, input.verified) : undefined;
      if (target.updateId && !candidate) {
        return { outcome: 'retry', reason: 'target_changed' };
      }
      if (!target.updateId && (await this.hasManagedMatch(trx, input.ownerId, input.verified))) {
        return { outcome: 'retry', reason: 'matching_asset_created' };
      }
      const final = scheduledFinal ?? (await input.verifyFinal());
      if (
        final.status !== 'healthy' ||
        !final.sha256.equals(input.verified.sha256) ||
        !final.sha1.equals(input.verified.sha1) ||
        final.sizeInBytes !== input.verified.sizeInBytes
      ) {
        return { outcome: 'retry', reason: 'final_verification_failed' };
      }
      // A lease can expire while the complete file is hashed under the target lock.
      if (!(await this.lockResource(trx, input))) {
        return { outcome: 'retry', reason: 'lease_expired' };
      }
      const assetId = target.assetId;
      const reused = target.outcome === 'reused';
      const previousSize = candidate && !candidate.isExternal ? candidate.sizeInBytes : 0;
      if (!reused) {
        if (previousSize === null) {
          return { outcome: 'needs-review', reason: 'previous_size_unknown' };
        }
        const delta = final.sizeInBytes - previousSize;
        const quota = await trx
          .updateTable('user')
          .set({ quotaUsageInBytes: sql`"quotaUsageInBytes" + ${delta}` })
          .where('id', '=', input.ownerId)
          .where(sql<boolean>`("quotaSizeInBytes" IS NULL OR "quotaUsageInBytes" + ${delta} <= "quotaSizeInBytes")`)
          .returning('id')
          .executeTakeFirst();
        if (!quota) {
          return { outcome: 'needs-review', reason: 'quota_exceeded' };
        }
        if (!candidate) {
          const createdAt = input.sourceCreatedAt ?? new Date();
          const inherited = target.matchedExternalAssetId
            ? await this.inheritedProtection(trx, input.ownerId, target.matchedExternalAssetId)
            : undefined;
          // The worker's preliminary sourceHidden is not publication authority. Tags,
          // suppression and elevation may have changed before this transaction began.
          const audit = input.audit
            ? await guardAuditAuthority(trx, input.audit, input.ownerId, true, {
                id: input.resourceId,
                leaseToken: input.leaseToken,
              })
            : undefined;
          if (input.audit && !audit) {
            throw new Error('audit_authority_changed');
          }
          await trx
            .insertInto('asset')
            .values({
              id: assetId,
              ownerId: input.ownerId,
              originalPath: promotedPath,
              originalFileName: input.originalFileName,
              type: input.type,
              checksum: final.sha256,
              checksumAlgorithm: ChecksumAlgorithm.sha256File,
              fileCreatedAt: createdAt,
              fileModifiedAt: createdAt,
              localDateTime: createdAt,
              // a hidden source arrives locked (FL-34): a lock record, never a stored `locked` visibility
              visibility: AssetVisibility.Timeline,
              status: AssetStatus.Active,
            })
            .execute();
          if ((audit ? audit.private : input.sourceHidden) || inherited) {
            await trx
              .insertInto('asset_lock')
              .values({ assetId, reason: inherited ?? AssetLockReason.Marked, lockedBy: null })
              .onConflict((oc) => oc.column('assetId').doNothing())
              .execute();
          }
        }
        const physicalId = randomUUID();
        {
          await trx
            .withSchema('public')
            .insertInto('physical_file')
            .values({
              id: physicalId,
              canonicalAssetId: assetId,
              checksum: final.sha256,
              path: promotedPath,
              sizeInBytes: final.sizeInBytes,
              type: PhysicalFileType.Original,
            })
            .execute();
        }
        await trx
          .withSchema('public')
          .updateTable('asset')
          .set({
            originalPath: promotedPath,
            checksum: final.sha256,
            checksumAlgorithm: ChecksumAlgorithm.sha256File,
            isOffline: false,
            isExternal: false,
            libraryId: null,
            physicalOriginalFileId: physicalId,
          })
          .where('id', '=', assetId)
          .execute();
        if (target.physicalOriginalFileId) {
          await sql`UPDATE public.physical_file SET "canonicalAssetId" = (
            SELECT id FROM public.asset WHERE "physicalOriginalFileId" = ${target.physicalOriginalFileId}::uuid ORDER BY id LIMIT 1)
            WHERE id = ${target.physicalOriginalFileId}::uuid AND "canonicalAssetId" = ${assetId}::uuid`.execute(trx);
        }
        await trx
          .withSchema('public')
          .insertInto('asset_exif')
          .values({ assetId, fileSizeInByte: final.sizeInBytes })
          .onConflict((oc) => oc.column('assetId').doUpdateSet({ fileSizeInByte: final.sizeInBytes }))
          .execute();
      }
      // Every committed asset is managed (FL-69: an external original is never the recovered asset), so
      // these are a managed copy's digests
      await sql`INSERT INTO public.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${assetId}::uuid, ${final.sha1}, ${final.sha256}, ${final.sizeInBytes}, ARRAY[${promotedPath}]::text[], 1,
          ${{ source: 'icloud-recovery', resourceId: input.resourceId, identity: final.identity }}::jsonb, now(), now())
        ON CONFLICT ("assetId") DO UPDATE SET sha1 = EXCLUDED.sha1, sha256 = EXCLUDED.sha256, "sizeInBytes" = EXCLUDED."sizeInBytes",
          "verifiedPaths" = EXCLUDED."verifiedPaths", evidence = EXCLUDED.evidence, "verifiedAt" = now(), "updatedAt" = now()`.execute(
        trx,
      );
      await sql`UPDATE public.asset_health SET status = ${MediaHealthStatus.Resolved}, severity = 'info',
          "resolvedAt" = now(), "checkedAt" = now(), "dismissedAt" = NULL,
          resolution = resolution || jsonb_build_object('recoveredBy', 'icloud', 'resourceId', ${input.resourceId}::text,
            'previousPath', "originalPath", 'previousEvidence', evidence,
            'recoveryHistory', COALESCE(resolution->'recoveryHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
              'resourceId', ${input.resourceId}::text, 'previousPath', "originalPath", 'evidence', evidence, 'status', status,
              'dismissedAt', "dismissedAt", 'recoveredAt', clock_timestamp()))), "originalPath" = ${promotedPath}
          WHERE "assetId" = ${assetId}::uuid AND category IN ('missing', 'corrupt') AND "resolvedAt" IS NULL`.execute(
        trx,
      );
      await sql`UPDATE public.asset_health_candidate c SET status = 'candidate',
          resolution = c.resolution || '{"autoRelinkable":false,"invalidatedBy":"icloud-recovery"}'::jsonb
          FROM public.asset_health h WHERE c."healthId" = h.id AND h."assetId" = ${assetId}::uuid
            AND h.category IN ('missing', 'corrupt')`.execute(trx);
      if (edit) {
        await editAuthority.published(trx, input.ownerId, edit, assetId, !target.updateId);
      }
      const pendingJobs = reused
        ? []
        : [
            { name: JobName.AssetExtractMetadata, data: { id: assetId, source: 'upload' } },
            { name: JobName.AssetGenerateThumbnails, data: { id: assetId, source: 'upload' } },
          ];
      await sql`UPDATE public.icloud_resource SET status = 'committed', "assetId" = ${assetId}::uuid,
        path = ${promotedPath}, verification = ${JSON.stringify(scheduledAuthority ? { ...resource.verification, auditFreshDownload: input.scheduled!.receipt } : {})}::text::jsonb || ${JSON.stringify(
          {
            outcome: target.outcome,
            identity: final.identity,
            sizeInBytes: final.sizeInBytes,
            ...(input.audit && {
              auditStaging: {
                resourceId: input.resourceId,
                requestId: input.audit.auditRequestId,
                ownerId: input.ownerId,
                stagingPath: resource.stagingPath,
                sha256: final.sha256.toString('hex'),
                sizeInBytes: final.sizeInBytes,
              },
            }),
            ...(target.matchedExternalAssetId && { matchedExternalAssetId: target.matchedExternalAssetId }),
          },
        )}::text::jsonb,
        "pendingJobs" = ${JSON.stringify(pendingJobs)}::text::jsonb, "lastError" = NULL, "updatedAt" = now()
        WHERE id = ${input.resourceId}::uuid`.execute(trx);
      if (scheduledAuthority) {
        const guarded = await guardScheduledAudit(trx as Transaction<DB>, scheduledAuthority, input.ownerId, {
          resource: { id: input.resourceId, leaseToken: input.leaseToken },
          candidateAssetIds: [assetId],
          managedPaths: input.scheduled?.paths,
          recoveryChecksum: input.verified.sha256,
        });
        if (!guarded || !input.scheduled || !input.scheduled.paths.includes(promotedPath)) {
          throw new Error('scheduled_audit_authority_changed');
        }
        await publishScheduledAudit(
          trx as Transaction<DB>,
          scheduledAuthority,
          guarded,
          { id: input.resourceId, leaseToken: input.leaseToken },
          input.scheduled,
          'mismatch',
          assetId,
        );
      } else if (input.audit) {
        await publishAudit(
          trx,
          input.audit,
          input.ownerId,
          'mismatch',
          { id: input.resourceId, leaseToken: input.leaseToken },
          assetId,
        );
      }
      return { outcome: target.outcome, assetId };
    });
  }
  /**
   * Whether an asset other than an external original already holds these bytes. An external match is
   * evidence only (FL-69), so it never stands in the way of importing the managed copy.
   */
  private async hasManagedMatch(trx: Kysely<DB>, ownerId: string, verified: Pick<VerifiedMedia, 'sha1' | 'sha256'>) {
    // its own query: the candidate list is capped, and many external copies must not push a managed match out
    const { rows } = await sql`SELECT 1 FROM public.asset a
      WHERE a."ownerId" = ${ownerId}::uuid AND NOT a."isExternal" AND a.id IN (${this.contentMatchIds(ownerId, verified)})
      LIMIT 1`.execute(trx);
    return rows.length > 0;
  }
  /** The owner's assets whose own content checksum, or a recorded digest, is one of these digests. */
  private contentMatchIds(ownerId: string, verified: Pick<VerifiedMedia, 'sha1' | 'sha256'>) {
    return sql`SELECT id FROM public.asset WHERE "ownerId" = ${ownerId}::uuid AND checksum IN (${verified.sha1}, ${verified.sha256})
          AND "checksumAlgorithm" IN (${ChecksumAlgorithm.sha1File}, ${ChecksumAlgorithm.sha256File})
        UNION SELECT "assetId" FROM public.asset_checksum WHERE sha1 = ${verified.sha1} OR sha256 = ${verified.sha256}`;
  }
  /** Besides a lock, what hides an owner's asset from a session that is not unlocked: nsfw or suppression. */
  private async hiddenFilter(db: Kysely<DB>, ownerId: string) {
    const preference = await db
      .selectFrom('user_metadata')
      .select('value')
      .where('userId', '=', ownerId)
      .where('key', '=', UserMetadataKey.Preferences)
      .forShare()
      .executeTakeFirst();
    const preferences = preference?.value as
      | {
          privacy?: {
            suppression?: {
              tagIds?: string[];
              personIds?: string[];
              petIds?: string[];
            };
          };
        }
      | undefined;
    const suppression = preferences?.privacy?.suppression;
    return hiddenContentAssetIdExists(sql`a.id`, {
      userId: ownerId,
      scope: 'owned',
      includeNsfw: true,
      tagIds: suppression?.tagIds ?? [],
      personIds: suppression?.personIds ?? [],
      petIds: suppression?.petIds ?? [],
    });
  }
  /**
   * FL-69: the protection a managed copy takes from the hidden external original it matches, so a copy
   * never shows what the original hides. A Locked original passes on its lock reason. One hidden by
   * sensitive content or suppression is locked as marked, since those come from the original's own
   * detections, tags and people, which a new copy does not have yet. Undefined when the original is
   * visible or gone.
   */
  private async inheritedProtection(
    trx: Kysely<DB>,
    ownerId: string,
    externalAssetId: string,
  ): Promise<AssetLockReason | undefined> {
    const hidden = await this.hiddenFilter(trx, ownerId);
    const { rows } = await sql<{
      lockReason: AssetLockReason | null;
      hidden: boolean;
    }>`
      SELECT (SELECT l.reason FROM public.asset_lock l WHERE l."assetId" = a.id) AS "lockReason", ${hidden} AS hidden
      FROM public.asset a WHERE a.id = ${externalAssetId}::uuid AND a."ownerId" = ${ownerId}::uuid FOR SHARE OF a`.execute(
      trx,
    );
    const row = rows[0];
    return row?.lockReason ?? (row?.hidden ? AssetLockReason.Marked : undefined);
  }
  private async lockAuthority(trx: Kysely<DB>, ownerId: string, checksum: Buffer): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(trx);
    await this.lockPath(trx, `icloud-content:${ownerId}:${checksum.toString('hex')}`);
    await trx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
  }
  private async lockResource(trx: Kysely<DB>, input: RecoveryAuthority): Promise<RecoveryResource | undefined> {
    if (
      input.audit &&
      !(await guardAuditAuthority(trx, input.audit, input.ownerId, true, {
        id: input.resourceId,
        leaseToken: input.leaseToken,
      }))
    ) {
      return;
    }
    const result = await sql<RecoveryResource>`SELECT r.*, r."expectedSize"::float8 AS "expectedSize"
      FROM public.icloud_resource r JOIN public.icloud_connection c ON c.id = r."connectionId" AND c."ownerId" = r."ownerId"
      WHERE r.id = ${input.resourceId}::uuid AND r."ownerId" = ${input.ownerId}::uuid
        AND r."leaseToken" = ${input.leaseToken}::uuid AND r."leaseExpiresAt" > clock_timestamp()
        AND r.status <> 'removed' AND c.state = 'connected'
        AND r."auditRequestId" IS NOT DISTINCT FROM ${input.audit?.auditRequestId ?? null}::uuid
        FOR UPDATE OF r FOR SHARE OF c`.execute(trx);
    return result.rows[0];
  }
  private async lockTarget(
    trx: Kysely<DB>,
    input: RecoveryAuthority,
    target: RecoveryTarget,
    verified: VerifiedMedia,
  ): Promise<RecoveryCandidate | undefined> {
    await this.lockPath(trx, target.originalPath!);
    const row = await trx
      .withSchema('public')
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', target.assetId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !row ||
      row.ownerId !== input.ownerId ||
      row.updateId !== target.updateId ||
      row.originalPath !== target.originalPath ||
      row.checksum.toString('hex') !== target.checksumHex ||
      row.checksumAlgorithm !== target.checksumAlgorithm ||
      row.isExternal !== target.isExternal ||
      row.libraryId !== target.libraryId ||
      (row.physicalOriginalFileId ?? null) !== target.physicalOriginalFileId ||
      row.deletedAt ||
      row.status !== AssetStatus.Active ||
      // FL-69 (owner decision): an external original is never reused, repaired or converted by recovery;
      // a match with one is evidence only, and the item is imported as a new managed asset
      row.isExternal
    ) {
      return;
    }
    const candidates = await this.candidates(trx, input.ownerId, verified);
    const candidate = candidates.find(({ id }) => id === row.id);
    if (!candidate?.matchesContent || candidate.identityConflict || (candidate.hidden && !input.includeHidden)) {
      return;
    }
    if (input.audit) {
      const audit = await guardAuditAuthority(trx, input.audit, input.ownerId, true, {
        id: input.resourceId,
        leaseToken: input.leaseToken,
      });
      if (!audit || (audit.private && !candidate.hidden)) {
        return;
      }
    }
    return candidate;
  }
  private async lockPath(trx: Kysely<DB>, path: string): Promise<void> {
    await lockFilePath(trx, path);
  }
}
