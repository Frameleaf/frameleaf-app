import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { VerifiedMedia } from 'src/repositories/media-recovery.repository.js';
import { ICloudAuditRow } from 'src/repositories/icloud-audit.repository.js';
import { ScheduledAuditAuthority, guardScheduledAudit } from 'src/repositories/icloud-scheduled-authority.js';
import { ScheduledPublicationFiles, publishScheduledAudit } from 'src/repositories/icloud-scheduled-publication.js';
import {
  ICloudScheduledStagingRepository,
  ScheduledStagingInput,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { canonicalJson } from 'src/utils/studio-project.js';

/** Member settlement is monotonic and counters are derived from a successful pending CAS only. */
export async function settleScheduledMember(
  db: Transaction<DB>,
  request: ICloudAuditRow,
  outcome: 'match' | 'mismatch' | 'unavailable' | 'cancelled',
) {
  if (request.purpose !== 'scheduled-weekly') {
    throw new Error('scheduled_audit_binding_invalid');
  }
  const changed = await sql`UPDATE public.icloud_weekly_member SET outcome=${outcome}
    WHERE "cohortId"=${request.cohortId}::uuid AND ordinal=${request.memberOrdinal}
      AND "ownerId"=${request.ownerId}::uuid AND "connectionId"=${request.connectionId}::uuid
      AND "auditRequestId"=${request.id}::uuid AND selected AND outcome='pending' RETURNING ordinal`.execute(db);
  if (changed.rows.length !== 1) {
    throw new Error('scheduled_audit_already_settled');
  }
  await sql`UPDATE public.icloud_weekly_cohort SET
    "performedCount"="performedCount"+${outcome === 'match' || outcome === 'mismatch' ? 1 : 0},
    "matchCount"="matchCount"+${outcome === 'match' ? 1 : 0},
    "mismatchCount"="mismatchCount"+${outcome === 'mismatch' ? 1 : 0},
    "unavailableCount"="unavailableCount"+${outcome === 'unavailable' ? 1 : 0},
    "cancelledCount"="cancelledCount"+${outcome === 'cancelled' ? 1 : 0},
    status=CASE WHEN "performedCount"+"unavailableCount"+"cancelledCount"+1="selectedCount" THEN 'settled' ELSE status END
    WHERE id=${request.cohortId}::uuid AND "ownerId"=${request.ownerId}::uuid`.execute(db);
}

@Injectable()
export class ICloudScheduledWorkerRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private staging: ICloudScheduledStagingRepository,
  ) {}

  /** Persisted full batch, never a caller-supplied subset or discriminator. */
  async dispatch(operation: MediaOperation, claimToken: string) {
    const { rows } = await sql<ICloudAuditRow>`SELECT q.* FROM public.icloud_identity_audit q
      JOIN public.media_operation o ON o.id=q."operationId" AND o."ownerId"=q."ownerId"
      JOIN public.icloud_weekly_member m ON m."auditRequestId"=q.id AND m."cohortId"=q."cohortId" AND m.ordinal=q."memberOrdinal"
      WHERE o.id=${operation.id}::uuid AND o."ownerId"=${operation.ownerId}::uuid AND o."claimToken"=${claimToken}::uuid
        AND o."claimExpiresAt">clock_timestamp() AND o.kind='icloud_sync' AND q.purpose='scheduled-weekly' AND q."sessionId" IS NULL
        AND o.snapshot=${JSON.stringify(operation.snapshot)}::text::jsonb AND o.snapshot->>'task'='identity-audit-weekly' AND o.snapshot->>'purpose'='scheduled-weekly'
        AND q."cohortId"::text=o.snapshot->>'cohortId' AND q."connectionId"::text=o.snapshot->>'connectionId'
        AND q."grantId"::text=o.snapshot->>'grantId' AND q."grantGeneration"::text=o.snapshot->>'grantGeneration'
        AND q."batchOrdinal"::text=o.snapshot->>'batchOrdinal' AND m.selected AND m."ownerId"=q."ownerId" AND m."connectionId"=q."connectionId"
        AND m."grantId"=q."grantId" AND m."grantGeneration"=q."grantGeneration" AND m."batchOrdinal"=q."batchOrdinal"
        AND NOT EXISTS (SELECT 1 FROM public.icloud_identity_audit foreign_q WHERE foreign_q."operationId"=o.id
          AND (foreign_q.purpose<>'scheduled-weekly' OR foreign_q."ownerId"<>o."ownerId"))
      ORDER BY m.ordinal`.execute(this.db);
    if (
      rows.length === 0 ||
      rows.length > 100 ||
      rows.length !== Number(operation.totalUnits) ||
      operation.snapshot.task !== 'identity-audit-weekly' ||
      operation.snapshot.purpose !== 'scheduled-weekly' ||
      canonicalJson(rows.map(({ id }) => id)) !== canonicalJson(operation.snapshot.auditIds)
    ) {
      return;
    }
    return rows;
  }

  async stopState(operationId: string, ownerId: string, claimToken: string) {
    const {
      rows: [row],
    } = await sql<{ cancelRequestedAt: Date | null; pauseRequestedAt: Date | null; live: boolean }>`SELECT
      "cancelRequestedAt","pauseRequestedAt",("claimToken"=${claimToken}::uuid AND "claimExpiresAt">clock_timestamp()) AS live
      FROM public.media_operation WHERE id=${operationId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(this.db);
    return row;
  }

  renewOperation(operationId: string, ownerId: string, claimToken: string) {
    return this.db.transaction().execute(async (db) => {
      const changed = await sql`UPDATE public.media_operation SET "heartbeatAt"=clock_timestamp(),
        "claimExpiresAt"=clock_timestamp()+interval '30 minutes' WHERE id=${operationId}::uuid AND "ownerId"=${ownerId}::uuid
        AND "claimToken"=${claimToken}::uuid AND "claimExpiresAt">clock_timestamp()
        AND status IN ('preparing','rendering','validating') AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL RETURNING id`.execute(
        db,
      );
      return changed.rows.length === 1;
    });
  }

  check(authority: ScheduledAuditAuthority, ownerId: string, requireClaim = true) {
    return this.db.transaction().execute((db) => guardScheduledAudit(db, authority, ownerId, { requireClaim }));
  }

  bindClaim(authority: ScheduledAuditAuthority, ownerId: string, claimId: string) {
    return this.db.transaction().execute(async (db) => {
      const guarded = await guardScheduledAudit(db, authority, ownerId, { requireClaim: false });
      if (!guarded) {
        return false;
      }
      const changed = await sql`UPDATE public.icloud_identity_audit SET "itemClaimId"=${claimId}::uuid
        WHERE id=${authority.auditRequestId}::uuid AND result IN ('queued','running')
          AND EXISTS (SELECT 1 FROM public.icloud_claim WHERE id=${claimId}::uuid AND "ownerId"=${ownerId}::uuid
            AND "cplAssetRecordName"=upper(${guarded.source.sourceAssetId})
            AND holder=${`icloud-sync:audit:${authority.operationId}`} AND "expiresAt">clock_timestamp()) RETURNING id`.execute(
        db,
      );
      return changed.rows.length === 1;
    });
  }
  async allocate(authority: ScheduledAuditAuthority, ownerId: string): Promise<ICloudResource | undefined> {
    return this.db.transaction().execute(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(db);
      const guarded = await guardScheduledAudit(db, authority, ownerId);
      if (!guarded || !guarded.request.itemClaimId) {
        return;
      }
      const { source, connection, request } = guarded;
      const existing =
        await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource
        WHERE "auditRequestId"=${request.id}::uuid FOR UPDATE`
          .execute(db)
          .then(({ rows }) => rows[0]);
      if (existing && ['committed', 'finalized', 'removed', 'failed', 'cancelled'].includes(existing.status)) {
        return;
      }
      const timing = existing
        ? (
            await sql<{ held: boolean; waiting: boolean }>`SELECT
        coalesce("leaseExpiresAt">clock_timestamp(),false) AS held,
        coalesce("nextAttemptAt">clock_timestamp(),false) AS waiting
        FROM public.icloud_resource WHERE id=${existing.id}::uuid`.execute(db)
          ).rows[0]
        : undefined;
      if (timing?.held) {
        return;
      }
      if (timing?.waiting) {
        return;
      }
      const {
        rows: [budget],
      } = await sql<{ used: number; active: number }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS used,
        count(*) FILTER (WHERE "leaseExpiresAt">clock_timestamp())::int AS active
        FROM public.icloud_resource WHERE "connectionId"=${connection.id}::uuid AND status NOT IN ('finalized','removed')`.execute(
        db,
      );
      const globalLimit = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES') ?? 100 * 1024 ** 3);
      const concurrency = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_CONCURRENCY') ?? 4);
      const {
        rows: [global],
      } = await sql<{ used: number; active: number }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS used,
        count(*) FILTER (WHERE "leaseExpiresAt">clock_timestamp())::int AS active
        FROM public.icloud_resource WHERE status NOT IN ('finalized','removed')`.execute(db);
      const bytes = existing?.reservedBytes ? 0 : source.expectedSize;
      if (
        !Number.isSafeInteger(source.expectedSize) ||
        source.expectedSize <= 0 ||
        !Number.isFinite(globalLimit) ||
        !Number.isSafeInteger(concurrency) ||
        concurrency < 1 ||
        budget.active >= connection.config.concurrency ||
        global.active >= concurrency ||
        budget.used + bytes > connection.config.stagingBytes ||
        global.used + bytes > globalLimit
      ) {
        return;
      }
      const lease = randomUUID();
      await sql`UPDATE public.icloud_identity_audit SET result='running' WHERE id=${request.id}::uuid`.execute(db);
      if (existing) {
        return sql<ICloudResource>`UPDATE public.icloud_resource SET "leaseToken"=${lease}::uuid,
          "leaseExpiresAt"=clock_timestamp()+interval '30 minutes' WHERE id=${existing.id}::uuid
          RETURNING *,"expectedSize"::float8 AS "expectedSize"`
          .execute(db)
          .then(({ rows }) => rows[0]);
      }
      return sql<ICloudResource>`INSERT INTO public.icloud_resource
        ("connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize","auditRequestId","reservedBytes","leaseToken","leaseExpiresAt")
        VALUES (${connection.id}::uuid,${ownerId}::uuid,${source.libraryKey},${JSON.stringify(source.library)}::text::jsonb,${source.sourceAssetId},${source.recordId},${source.resourceKey},
          ${source.role},${source.fingerprint},${JSON.stringify(source.source)}::text::jsonb,${source.expectedSize},${request.id}::uuid,${source.expectedSize},${lease}::uuid,clock_timestamp()+interval '30 minutes')
        RETURNING *,"expectedSize"::float8 AS "expectedSize"`
        .execute(db)
        .then(({ rows }) => rows[0]);
    });
  }

  async publishMatch(input: ScheduledStagingInput, evidence: ScheduledPublicationFiles, verified: VerifiedMedia) {
    if (
      !(await this.staging.authenticateDeepValidation(input, evidence.validation)) ||
      verified.sha256.toString('hex') !== evidence.receipt.payload.sha256 ||
      verified.sha1.toString('hex') !== evidence.receipt.payload.sha1 ||
      verified.sizeInBytes !== evidence.receipt.payload.binding.sizeInBytes
    ) {
      return false;
    }
    return this.db.transaction().execute(async (db) => {
      const guarded = await guardScheduledAudit(db, input.authority, input.ownerId, {
        resource: input.resource,
        managedPaths: evidence.paths,
      });
      if (
        !guarded ||
        !guarded.request.expectedSha256.equals(verified.sha256) ||
        canonicalJson([...evidence.paths].sort()) !==
          canonicalJson([evidence.receipt.payload.path, guarded.bindings.original.originalPath].sort())
      ) {
        return false;
      }
      await publishScheduledAudit(db, input.authority, guarded, input.resource, evidence, 'match');
      await sql`UPDATE public.icloud_resource SET status='committed',verification=verification || ${JSON.stringify({
        kind: 'audit-match-staging',
        resourceId: input.resource.id,
        requestId: input.authority.auditRequestId,
        ownerId: input.ownerId,
        stagingPath: evidence.receipt.payload.path,
        sha256: evidence.receipt.payload.sha256,
        sizeInBytes: verified.sizeInBytes,
      })}::text::jsonb,"pendingJobs"='[]'::jsonb WHERE id=${input.resource.id}::uuid`.execute(db);
      return true;
    });
  }

  cancelRemaining(authority: ScheduledAuditAuthority, ownerId: string) {
    return this.db.transaction().execute(async (db) => {
      await db.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirst();
      const {
        rows: [hint],
      } = await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit
        WHERE id=${authority.auditRequestId}::uuid AND "ownerId"=${ownerId}::uuid AND purpose='scheduled-weekly'`.execute(
        db,
      );
      if (!hint || hint.purpose !== 'scheduled-weekly' || hint.operationId !== authority.operationId) {
        return false;
      }
      const {
        rows: [cohort],
      } = await sql<{ id: string }>`SELECT id FROM public.icloud_weekly_cohort WHERE id=${hint.cohortId}::uuid
        AND "ownerId"=${ownerId}::uuid AND "grantId"=${hint.grantId}::uuid AND "grantGeneration"=${hint.grantGeneration} FOR UPDATE`.execute(
        db,
      );
      if (!cohort) {
        return false;
      }
      await sql`SELECT ordinal FROM public.icloud_weekly_member WHERE "cohortId"=${hint.cohortId}::uuid ORDER BY ordinal FOR UPDATE`.execute(
        db,
      );
      const cancel =
        await sql`SELECT id FROM public.media_operation WHERE id=${authority.operationId}::uuid AND "ownerId"=${ownerId}::uuid
        AND "claimToken"=${authority.operationClaimToken}::uuid AND "claimExpiresAt">clock_timestamp() AND "cancelRequestedAt" IS NOT NULL
        AND snapshot->>'task'='identity-audit-weekly' AND snapshot->>'purpose'='scheduled-weekly'
        AND snapshot->>'cohortId'=${hint.cohortId} AND snapshot->>'grantId'=${hint.grantId}
        AND snapshot->>'grantGeneration'=${String(hint.grantGeneration)} FOR UPDATE`.execute(db);
      if (cancel.rows.length !== 1) {
        return false;
      }
      const {
        rows: [changed],
      } = await sql<{ count: number }>`WITH changed AS (
        UPDATE public.icloud_weekly_member SET outcome='cancelled' WHERE "cohortId"=${hint.cohortId}::uuid
          AND selected AND outcome='pending' RETURNING ordinal)
        SELECT count(*)::int AS count FROM changed`.execute(db);
      await sql`UPDATE public.icloud_weekly_cohort SET "cancelledCount"="cancelledCount"+${changed.count},
        status=CASE WHEN "performedCount"+"unavailableCount"+"cancelledCount"+${changed.count}="selectedCount" THEN 'settled' ELSE status END
        WHERE id=${hint.cohortId}::uuid`.execute(db);
      await sql`UPDATE public.icloud_identity_audit q SET result='cancelled',"verifiedAt"=NULL
        FROM public.icloud_weekly_member m WHERE m."cohortId"=${hint.cohortId}::uuid AND m.outcome='cancelled'
          AND m."auditRequestId"=q.id AND q.purpose='scheduled-weekly' AND q.result IN ('queued','running')`.execute(
        db,
      );
      await sql`UPDATE public.icloud_resource r SET status='failed',"leaseToken"=NULL,"leaseExpiresAt"=NULL,"lastError"='scheduled_audit_cancelled'
        FROM public.icloud_identity_audit q WHERE q.id=r."auditRequestId" AND q."cohortId"=${hint.cohortId}::uuid
          AND q.result='cancelled' AND r.status NOT IN ('committed','finalized','removed')`.execute(db);
      return true;
    });
  }

  /** Refusal can retire an obligation after revocation, but never creates a proof or performed count. */
  settleUnavailable(authority: ScheduledAuditAuthority, ownerId: string, outcome: 'unavailable' | 'cancelled') {
    return this.db.transaction().execute(async (db) => {
      await db.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate().executeTakeFirst();
      const {
        rows: [hint],
      } = await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit
        WHERE id=${authority.auditRequestId}::uuid AND "ownerId"=${ownerId}::uuid AND purpose='scheduled-weekly'`.execute(
        db,
      );
      if (!hint || hint.purpose !== 'scheduled-weekly' || hint.operationId !== authority.operationId) {
        return false;
      }
      await sql`SELECT id FROM public.icloud_weekly_cohort WHERE id=${hint.cohortId}::uuid FOR UPDATE`.execute(db);
      await sql`SELECT ordinal FROM public.icloud_weekly_member WHERE "cohortId"=${hint.cohortId}::uuid ORDER BY ordinal FOR UPDATE`.execute(
        db,
      );
      const {
        rows: [request],
      } = await sql<ICloudAuditRow>`SELECT q.* FROM public.icloud_identity_audit q
        JOIN public.media_operation o ON o.id=q."operationId" AND o."ownerId"=q."ownerId"
        WHERE q.id=${hint.id}::uuid AND q.purpose='scheduled-weekly' AND q."sessionId" IS NULL AND q.result IN ('queued','running')
          AND o.id=${authority.operationId}::uuid AND o."claimToken"=${authority.operationClaimToken}::uuid
          AND o."claimExpiresAt">clock_timestamp() AND o.status IN ('preparing','rendering','validating','cancelling','cancelled')
          AND o.snapshot->>'task'='identity-audit-weekly' AND o.snapshot->>'purpose'='scheduled-weekly'
          AND o.snapshot->'auditIds'=(SELECT jsonb_agg(m."auditRequestId" ORDER BY m.ordinal)
            FROM public.icloud_weekly_member m WHERE m."cohortId"=q."cohortId" AND m.selected AND m."batchOrdinal"=q."batchOrdinal")
          AND q."grantId"::text=o.snapshot->>'grantId' AND q."grantGeneration"::text=o.snapshot->>'grantGeneration'
          AND q."cohortId"::text=o.snapshot->>'cohortId' AND q."connectionId"::text=o.snapshot->>'connectionId'
          AND q."batchOrdinal"::text=o.snapshot->>'batchOrdinal' FOR UPDATE OF q,o`.execute(db);
      if (!request) {
        return false;
      }
      await settleScheduledMember(db, request, outcome);
      await sql`UPDATE public.icloud_identity_audit SET result=${outcome === 'cancelled' ? 'cancelled' : 'failed'},
        "verifiedAt"=NULL WHERE id=${request.id}::uuid`.execute(db);
      await sql`UPDATE public.icloud_resource SET status='failed',"leaseToken"=NULL,"leaseExpiresAt"=NULL,
        "lastError"='scheduled_audit_unavailable' WHERE "auditRequestId"=${request.id}::uuid
        AND status NOT IN ('committed','finalized','removed')`.execute(db);
      return true;
    });
  }
}
