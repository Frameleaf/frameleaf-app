import { Transaction, sql } from 'kysely';
import {
  GuardedScheduledAudit,
  ScheduledAuditAuthority,
  scheduledAuditFinalFence,
} from 'src/repositories/icloud-scheduled-authority.js';
import {
  ScheduledDeepValidation,
  ScheduledFreshDownload,
  scheduledFreshBinding,
} from 'src/repositories/icloud-scheduled-staging.repository.js';
import { settleScheduledMember } from 'src/repositories/icloud-scheduled-worker.repository.js';
import { DB } from 'src/schema/index.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type ScheduledPublicationFiles = {
  receipt: ScheduledFreshDownload;
  validation: ScheduledDeepValidation;
  current: () => Promise<boolean>;
  paths: string[];
};

/** Authenticated fresh transport + actual settled decoder must precede this transaction-only writer. */
export async function publishScheduledAudit(
  db: Transaction<DB>,
  authority: ScheduledAuditAuthority,
  guarded: GuardedScheduledAudit,
  resource: { id: string; leaseToken: string },
  evidence: ScheduledPublicationFiles,
  result: 'match' | 'mismatch',
  assetId?: string,
) {
  if (canonicalJson(evidence.receipt.payload.binding) !== canonicalJson(scheduledFreshBinding(guarded, resource.id))) {
    throw new Error('scheduled_audit_fresh_receipt_invalid');
  }
  if (
    canonicalJson(evidence.validation.payload.fresh) !== canonicalJson(evidence.receipt) ||
    evidence.validation.payload.sha256 !== evidence.receipt.payload.sha256 ||
    !evidence.paths.includes(evidence.validation.payload.path)
  ) {
    throw new Error('scheduled_audit_deep_receipt_invalid');
  }
  const expectedMatch = evidence.receipt.payload.sha256 === guarded.request.expectedSha256.toString('hex');
  if (expectedMatch !== (result === 'match')) {
    throw new Error('scheduled_audit_result_invalid');
  }
  const receipt = await sql`SELECT id FROM public.icloud_resource WHERE id=${resource.id}::uuid
    AND verification->'auditFreshDownload'=${JSON.stringify(evidence.receipt)}::text::jsonb
    AND verification->'auditDeepValidation'=${JSON.stringify(evidence.validation)}::text::jsonb
    AND "stagingPath"=${evidence.receipt.payload.path} AND sha256=${Buffer.from(evidence.receipt.payload.sha256, 'hex')}
    AND sha1=${Buffer.from(evidence.receipt.payload.sha1, 'hex')} AND ${scheduledAuditFinalFence(authority, guarded, resource)}`.execute(
    db,
  );
  if (receipt.rows.length !== 1) {
    throw new Error('scheduled_audit_authority_expired');
  }
  if (result === 'mismatch') {
    const copy = await sql`SELECT a.id FROM public.asset a JOIN public.icloud_resource r ON r."assetId"=a.id
      WHERE r.id=${resource.id}::uuid AND a.id=${assetId ?? null}::uuid AND a.id<>${guarded.request.originalAssetId}::uuid
        AND a."ownerId"=${guarded.request.ownerId}::uuid AND a."deletedAt" IS NULL AND a.status='active'
        AND NOT a."isExternal" AND NOT a."isOffline" AND a."originalPath"=r."promotedPath"
        AND (${!guarded.private} OR EXISTS (SELECT 1 FROM public.asset_lock WHERE "assetId"=a.id))`.execute(db);
    if (copy.rows.length !== 1) {
      throw new Error('scheduled_audit_destination_invalid');
    }
  }
  // Only bounded readonly stat/path checks are awaited under managed physical/path locks.
  if (!(await evidence.current())) {
    throw new Error('scheduled_audit_file_changed');
  }
  const changed = await sql`UPDATE public.icloud_source_identity SET "lastAuditResult"=${result},
    "lastVerifiedAt"=CASE WHEN ${result}='match' THEN clock_timestamp() ELSE NULL END
    WHERE id=${guarded.request.identityId}::uuid AND sha256=${guarded.request.expectedSha256}
      AND ${scheduledAuditFinalFence(authority, guarded, resource)} RETURNING id`.execute(db);
  if (changed.rows.length !== 1) {
    throw new Error('scheduled_audit_authority_expired');
  }
  await sql`UPDATE public.icloud_identity_audit SET result=${result},"verifiedAt"=clock_timestamp(),
    "resultAssetId"=${assetId ?? null}::uuid WHERE id=${authority.auditRequestId}::uuid`.execute(db);
  await settleScheduledMember(db, guarded.request, result);
}
