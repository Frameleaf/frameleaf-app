import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ForkSchemaPhase } from 'src/repositories/fork-schema.repository.js';
import type { MediaIntegrityResult } from 'src/services/media-integrity.service.js';
import { EXTERNAL_SCAN_CHECKSUM } from 'src/constants.js';
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
import {
  getForkSchemaPhase,
  readsForkSidecar,
  writesForkSidecar,
  writesLegacy,
} from 'src/repositories/fork-derived-results.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { DB } from 'src/schema/index.js';
import { hiddenContentAssetIdExists } from 'src/utils/database.js';

export type VerifiedMedia = Extract<MediaIntegrityResult, { status: 'healthy' }>;
export type RecoveryOutcome =
  | 'imported'
  | 'reused'
  | 'repaired-missing'
  | 'repaired-corrupt'
  | 'preserve-trashed'
  | 'needs-review'
  | 'retry'
  | 'failed';
export type RecoveryResult = { outcome: RecoveryOutcome; assetId?: string; reason?: string };
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
  forkPhysicalFileId: string | null;
  sizeInBytes: number | null;
  damaged: boolean;
  matchesContent: boolean;
  identityConflict: boolean;
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
  forkPhysicalFileId: string | null;
  outcome: 'imported' | 'reused' | 'repaired-missing' | 'repaired-corrupt';
};
export type RecoveryAuthority = {
  resourceId: string;
  leaseToken: string;
  ownerId: string;
  includeHidden: boolean;
  recoverExternalAsManaged: boolean;
};
export type RecoveryReservation = { target: RecoveryTarget; promotedPath: string };

@Injectable()
export class MediaRecoveryRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private forkPrivacy: ForkPrivacyRepository,
    private forkEnrichment: ForkEnrichmentRepository,
  ) {}

  async getResource(input: RecoveryAuthority): Promise<RecoveryResource | undefined> {
    const result = await sql<RecoveryResource>`
      SELECT r.*, r."expectedSize"::float8 AS "expectedSize" FROM immich_fork.icloud_resource r
      JOIN immich_fork.icloud_connection c ON c.id = r."connectionId" AND c."ownerId" = r."ownerId"
      WHERE r.id = ${input.resourceId}::uuid AND r."ownerId" = ${input.ownerId}::uuid
        AND r."leaseToken" = ${input.leaseToken}::uuid AND r."leaseExpiresAt" > now()
        AND r.status <> 'removed' AND c.state = 'connected'
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
    const phase = await getForkSchemaPhase(db);
    const preference = await db
      .selectFrom('user_metadata')
      .select('value')
      .where('userId', '=', ownerId)
      .where('key', '=', UserMetadataKey.Preferences)
      .forShare()
      .executeTakeFirst();
    const preferences = preference?.value as
      { privacy?: { suppression?: { tagIds?: string[]; personIds?: string[]; petIds?: string[] } } } | undefined;
    const suppression = preferences?.privacy?.suppression;
    const hidden = hiddenContentAssetIdExists(sql`a.id`, {
      userId: ownerId,
      scope: 'owned',
      includeNsfw: true,
      tagIds: suppression?.tagIds ?? [],
      personIds: suppression?.personIds ?? [],
      petIds: suppression?.petIds ?? [],
    });
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
        (to_jsonb(a)->>'physicalOriginalFileId') AS "physicalOriginalFileId", p."physicalFileId" AS "forkPhysicalFileId", e."fileSizeInByte"::float8 AS "sizeInBytes",
        (EXISTS (SELECT 1 FROM public.asset_lock l WHERE l."assetId" = a.id) OR ${hidden}) AS hidden,
        EXISTS (SELECT 1 FROM ${sql.id(readsForkSidecar(phase) ? 'immich_fork' : 'public', 'asset_health')} h
          WHERE h."assetId" = a.id AND h.category IN ('missing', 'corrupt') AND h."resolvedAt" IS NULL
          AND h.status NOT IN ('resolved', 'relinked', 'trashed')) AS damaged
      FROM public.asset a LEFT JOIN public.asset_exif e ON e."assetId" = a.id
      LEFT JOIN immich_fork.asset_checksum s ON s."assetId" = a.id
        AND s.evidence ->> 'source' IS DISTINCT FROM ${EXTERNAL_SCAN_CHECKSUM}
      LEFT JOIN immich_fork.asset_physical_file p ON p."assetId" = a.id
      WHERE a."ownerId" = ${ownerId}::uuid AND a.id IN (
        SELECT id FROM public.asset WHERE "ownerId" = ${ownerId}::uuid AND checksum IN (${verified.sha1}, ${verified.sha256})
          AND "checksumAlgorithm" IN (${ChecksumAlgorithm.sha1File}, ${ChecksumAlgorithm.sha256File})
        UNION SELECT "assetId" FROM immich_fork.asset_checksum WHERE (sha1 = ${verified.sha1} OR sha256 = ${verified.sha256})
          AND evidence ->> 'source' IS DISTINCT FROM ${EXTERNAL_SCAN_CHECKSUM}
        UNION SELECT ${mappedId ?? null}::uuid)
      ORDER BY (a.id = ${mappedId ?? null}::uuid) DESC NULLS LAST, a.id LIMIT 33
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
    return this.db.transaction().execute(async (trx) => {
      await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
      const resource = await this.lockResource(trx, input);
      if (
        !resource ||
        resource.assetId !== input.candidate.id ||
        !resource.sha256?.equals(input.verified.sha256) ||
        !resource.sha1?.equals(input.verified.sha1)
      ) {
        return { outcome: 'retry', reason: 'mapping_changed' };
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
        forkPhysicalFileId: input.candidate.forkPhysicalFileId,
        outcome: 'reused',
      };
      const candidate = await this.lockTarget(trx, input, target, input.verified);
      if (!candidate || candidate.damaged || candidate.isOffline) {
        return { outcome: 'retry', reason: 'target_changed' };
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
      await sql`UPDATE immich_fork.icloud_resource SET
        status = 'committed',
        path = ${candidate.originalPath}, verification = ${{ outcome: 'reused', identity: final.identity, sizeInBytes: final.sizeInBytes }}::jsonb,
        "lastError" = NULL, "updatedAt" = now() WHERE id = ${input.resourceId}::uuid`.execute(trx);
      return { outcome: 'reused', assetId: candidate.id };
    });
  }

  async reserve(
    input: RecoveryAuthority & {
      verified: VerifiedMedia;
      candidate?: RecoveryCandidate;
      outcome: RecoveryTarget['outcome'];
      proposedPath: string;
    },
  ): Promise<RecoveryReservation | undefined> {
    return this.db.transaction().execute(async (trx) => {
      await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
      const resource = await this.lockResource(trx, input);
      if (!resource || ['committed', 'finalized'].includes(resource.status)) {
        return;
      }
      const target: RecoveryTarget = resource.expectedTarget ?? {
        assetId: input.candidate?.id ?? randomUUID(),
        updateId: input.candidate?.updateId ?? null,
        originalPath: input.candidate?.originalPath ?? null,
        checksumHex: input.candidate?.checksum.toString('hex') ?? null,
        checksumAlgorithm: input.candidate?.checksumAlgorithm ?? null,
        isExternal: input.candidate?.isExternal ?? false,
        libraryId: input.candidate?.libraryId ?? null,
        physicalOriginalFileId: input.candidate?.physicalOriginalFileId ?? null,
        forkPhysicalFileId: input.candidate?.forkPhysicalFileId ?? null,
        outcome: input.outcome,
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
          refreshed.physicalOriginalFileId === target.physicalOriginalFileId &&
          refreshed.forkPhysicalFileId === target.forkPhysicalFileId
        ) {
          target.updateId = refreshed.updateId;
        }
        if (!(await this.lockTarget(trx, input, target, input.verified))) {
          return;
        }
      } else {
        const matches = await this.candidates(trx, input.ownerId, input.verified);
        if (matches.length > 0) {
          return;
        }
      }
      const promotedPath = resource.promotedPath ?? input.proposedPath;
      await this.lockPath(trx, promotedPath);
      await sql`UPDATE immich_fork.icloud_resource SET "expectedTarget" = ${target}::jsonb,
        "promotedPath" = ${promotedPath}, sha1 = ${input.verified.sha1}, sha256 = ${input.verified.sha256},
        "updatedAt" = now() WHERE id = ${input.resourceId}::uuid`.execute(trx);
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
    return this.db.transaction().execute(async (trx) => {
      const phase = await this.lockAuthority(trx, input.ownerId, input.verified.sha256);
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
        const final = await input.verifyFinal();
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
      if (!target.updateId) {
        const matches = await this.candidates(trx, input.ownerId, input.verified);
        if (matches.length > 0) {
          return { outcome: 'retry', reason: 'matching_asset_created' };
        }
      }
      const final = await input.verifyFinal();
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
          if (input.sourceHidden) {
            await trx
              .insertInto('asset_lock')
              .values({ assetId, reason: AssetLockReason.Marked, lockedBy: null })
              .onConflict((oc) => oc.column('assetId').doNothing())
              .execute();
          }
          await this.forkPrivacy.mirrorFromLegacy(assetId, trx);
          await this.forkEnrichment.initialize([assetId], trx);
        }
        const physicalId = randomUUID();
        if (writesLegacy(phase)) {
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
        if (writesForkSidecar(phase)) {
          await sql`INSERT INTO immich_fork.physical_file (id, "canonicalAssetId", type, checksum, "sizeInBytes", "canonicalPath", "createdAt", "updatedAt")
            VALUES (${physicalId}::uuid, ${assetId}::uuid, 'original', ${final.sha256}, ${final.sizeInBytes}, ${promotedPath}, now(), now())`.execute(
            trx,
          );
          await sql`INSERT INTO immich_fork.asset_physical_file ("assetId", "physicalFileId", "upstreamPath", "verifiedAt", "updatedAt")
            VALUES (${assetId}::uuid, ${physicalId}::uuid, ${promotedPath}, now(), now())
            ON CONFLICT ("assetId") DO UPDATE SET "physicalFileId" = EXCLUDED."physicalFileId", "upstreamPath" = EXCLUDED."upstreamPath",
              "verifiedAt" = now(), "updatedAt" = now()`.execute(trx);
        }
        const legacyColumn = await sql<{ present: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_attribute WHERE attrelid = 'public.asset'::regclass
            AND attname = 'physicalOriginalFileId' AND NOT attisdropped) AS present`.execute(trx);
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
            ...(legacyColumn.rows[0]?.present && { physicalOriginalFileId: writesLegacy(phase) ? physicalId : null }),
          })
          .where('id', '=', assetId)
          .execute();
        if (writesLegacy(phase) && target.physicalOriginalFileId) {
          await sql`UPDATE public.physical_file SET "canonicalAssetId" = (
            SELECT id FROM public.asset WHERE "physicalOriginalFileId" = ${target.physicalOriginalFileId}::uuid ORDER BY id LIMIT 1)
            WHERE id = ${target.physicalOriginalFileId}::uuid AND "canonicalAssetId" = ${assetId}::uuid`.execute(trx);
        }
        if (writesForkSidecar(phase) && target.forkPhysicalFileId) {
          await sql`UPDATE immich_fork.physical_file SET "canonicalAssetId" = (
            SELECT "assetId" FROM immich_fork.asset_physical_file WHERE "physicalFileId" = ${target.forkPhysicalFileId}::uuid ORDER BY "assetId" LIMIT 1)
            WHERE id = ${target.forkPhysicalFileId}::uuid AND "canonicalAssetId" = ${assetId}::uuid`.execute(trx);
        }
        await trx
          .withSchema('public')
          .insertInto('asset_exif')
          .values({ assetId, fileSizeInByte: final.sizeInBytes })
          .onConflict((oc) => oc.column('assetId').doUpdateSet({ fileSizeInByte: final.sizeInBytes }))
          .execute();
      }
      await sql`INSERT INTO immich_fork.asset_checksum ("assetId", sha1, sha256, "sizeInBytes", "verifiedPaths", "linkCount", evidence, "verifiedAt", "updatedAt")
        VALUES (${assetId}::uuid, ${final.sha1}, ${final.sha256}, ${final.sizeInBytes}, ARRAY[${promotedPath}]::text[], 1,
          ${{ source: 'icloud-recovery', resourceId: input.resourceId, identity: final.identity }}::jsonb, now(), now())
        ON CONFLICT ("assetId") DO UPDATE SET sha1 = EXCLUDED.sha1, sha256 = EXCLUDED.sha256, "sizeInBytes" = EXCLUDED."sizeInBytes",
          "verifiedPaths" = EXCLUDED."verifiedPaths", evidence = EXCLUDED.evidence, "verifiedAt" = now(), "updatedAt" = now()`.execute(
        trx,
      );
      for (const schema of [
        ...(writesLegacy(phase) ? ['public'] : []),
        ...(writesForkSidecar(phase) ? ['immich_fork'] : []),
      ]) {
        await sql`UPDATE ${sql.id(schema, 'asset_health')} SET status = ${MediaHealthStatus.Resolved}, severity = 'info',
          "resolvedAt" = now(), "checkedAt" = now(), "dismissedAt" = NULL,
          resolution = resolution || jsonb_build_object('recoveredBy', 'icloud', 'resourceId', ${input.resourceId}::text,
            'previousPath', "originalPath", 'previousEvidence', evidence,
            'recoveryHistory', COALESCE(resolution->'recoveryHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
              'resourceId', ${input.resourceId}::text, 'previousPath', "originalPath", 'evidence', evidence, 'status', status,
              'dismissedAt', "dismissedAt", 'recoveredAt', clock_timestamp()))), "originalPath" = ${promotedPath}
          WHERE "assetId" = ${assetId}::uuid AND category IN ('missing', 'corrupt') AND "resolvedAt" IS NULL`.execute(
          trx,
        );
        await sql`UPDATE ${sql.id(schema, 'asset_health_candidate')} c SET status = 'candidate',
          resolution = c.resolution || '{"autoRelinkable":false,"invalidatedBy":"icloud-recovery"}'::jsonb
          FROM ${sql.id(schema, 'asset_health')} h WHERE c."healthId" = h.id AND h."assetId" = ${assetId}::uuid
            AND h.category IN ('missing', 'corrupt')`.execute(trx);
      }
      const pendingJobs = reused
        ? []
        : [
            { name: JobName.AssetExtractMetadata, data: { id: assetId, source: 'upload' } },
            { name: JobName.AssetGenerateThumbnails, data: { id: assetId, source: 'upload' } },
          ];
      await sql`UPDATE immich_fork.icloud_resource SET status = 'committed', "assetId" = ${assetId}::uuid,
        path = ${promotedPath}, verification = ${{ outcome: target.outcome, identity: final.identity, sizeInBytes: final.sizeInBytes }}::jsonb,
        "pendingJobs" = ${pendingJobs}::jsonb, "lastError" = NULL, "updatedAt" = now()
        WHERE id = ${input.resourceId}::uuid`.execute(trx);
      return { outcome: target.outcome, assetId };
    });
  }

  private async lockAuthority(trx: Kysely<DB>, ownerId: string, checksum: Buffer): Promise<ForkSchemaPhase> {
    const { rows } = await sql<{
      phase: ForkSchemaPhase;
    }>`SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE`.execute(trx);
    const phase = rows[0]?.phase;
    if (!phase || !['dual-write', 'ready', 'active'].includes(phase)) {
      throw new Error('recovery_phase_unavailable');
    }
    const migrating = await sql`SELECT 1 FROM immich_fork.migration_audit
      WHERE status = 'running' AND name IN ('fork-return-reconciliation', 'official-handoff-preparation') LIMIT 1`.execute(
      trx,
    );
    if (migrating.rows.length > 0) {
      throw new Error('recovery_migration_running');
    }
    await this.lockPath(trx, `icloud-content:${ownerId}:${checksum.toString('hex')}`);
    await trx.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirstOrThrow();
    return phase;
  }

  private async lockResource(trx: Kysely<DB>, input: RecoveryAuthority): Promise<RecoveryResource | undefined> {
    const result = await sql<RecoveryResource>`SELECT r.*, r."expectedSize"::float8 AS "expectedSize"
      FROM immich_fork.icloud_resource r JOIN immich_fork.icloud_connection c ON c.id = r."connectionId" AND c."ownerId" = r."ownerId"
      WHERE r.id = ${input.resourceId}::uuid AND r."ownerId" = ${input.ownerId}::uuid
        AND r."leaseToken" = ${input.leaseToken}::uuid AND r."leaseExpiresAt" > clock_timestamp()
        AND r.status <> 'removed' AND c.state = 'connected' FOR UPDATE OF r FOR SHARE OF c`.execute(trx);
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
      (row.isExternal && target.outcome !== 'reused' && !input.recoverExternalAsManaged)
    ) {
      return;
    }
    const mapping = await sql<{
      physicalFileId: string | null;
    }>`SELECT "physicalFileId" FROM immich_fork.asset_physical_file WHERE "assetId" = ${row.id}::uuid FOR UPDATE`.execute(
      trx,
    );
    if ((mapping.rows[0]?.physicalFileId ?? null) !== target.forkPhysicalFileId) {
      return;
    }
    const reservation =
      await sql`SELECT 1 FROM immich_fork.asset_storage_reservation WHERE "assetId" = ${row.id}::uuid AND status = 'reserved'`.execute(
        trx,
      );
    if (reservation.rows.length > 0) {
      return;
    }
    const candidates = await this.candidates(trx, input.ownerId, verified);
    const candidate = candidates.find(({ id }) => id === row.id);
    if (!candidate?.matchesContent || candidate.identityConflict || (candidate.hidden && !input.includeHidden)) {
      return;
    }
    return candidate;
  }

  private async lockPath(trx: Kysely<DB>, path: string): Promise<void> {
    const key = createHash('sha1').update(path).digest().readBigInt64BE(0);
    await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
  }
}
