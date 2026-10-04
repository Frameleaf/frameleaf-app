import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import {
  GuardedScheduledAudit,
  ScheduledAuditAuthority,
  ScheduledAuditResourceAuthority,
  guardScheduledAudit,
  scheduledAuditFinalFence,
} from 'src/repositories/icloud-scheduled-authority.js';
import { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { DB } from 'src/schema/index.js';
import { lockPublicForkWrites } from 'src/repositories/fork-write-guard.js';
import type { MediaIntegrityIdentity } from 'src/services/media-integrity.service.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type ScheduledStagingInput = {
  authority: ScheduledAuditAuthority;
  ownerId: string;
  resource: ScheduledAuditResourceAuthority;
};
export const scheduledFreshBinding = (guarded: GuardedScheduledAudit, resourceId: string) => ({
  ownerId: guarded.request.ownerId,
  connectionId: guarded.request.connectionId,
  operationId: guarded.request.operationId,
  auditRequestId: guarded.request.id,
  cohortId: guarded.request.cohortId,
  memberOrdinal: String(guarded.request.memberOrdinal),
  batchOrdinal: guarded.request.batchOrdinal,
  grantId: guarded.grant.id,
  grantGeneration: guarded.grant.generation,
  configFingerprint: guarded.grant.configFingerprint,
  privacyFingerprint: guarded.grant.privacyFingerprint,
  sourceResourceId: guarded.request.sourceResourceId,
  identityId: guarded.request.identityId,
  libraryKey: guarded.source.libraryKey,
  sourceAssetId: guarded.source.sourceAssetId,
  library: guarded.bindings.source.resource.library,
  sourceRevision: guarded.request.snapshot.sourceRevision,
  masterRevision: guarded.request.snapshot.masterRevision,
  expectedSha256: guarded.request.expectedSha256.toString('hex'),
  originalAssetId: guarded.request.originalAssetId,
  originalUpdateId: guarded.bindings.original.updateId,
  originalPath: guarded.bindings.original.originalPath,
  physicalId: guarded.bindings.original.physicalId,
  forkPhysicalId: guarded.bindings.original.forkPhysicalId,
  recordId: guarded.source.recordId,
  resourceKey: guarded.source.resourceKey,
  role: guarded.source.role,
  fingerprint: guarded.source.fingerprint,
  resourceId,
  sizeInBytes: guarded.source.expectedSize,
});
export type ScheduledFreshPayload = {
  version: 1;
  basis: 'audit-fresh-download';
  binding: ReturnType<typeof scheduledFreshBinding>;
  path: string;
  identity: MediaIntegrityIdentity;
  sha1: string;
  sha256: string;
  appleFingerprint: string;
};
// Same encryption key, strictly different authenticated purpose from every provider session.
export const scheduledFreshReceiptScope = (payload: ScheduledFreshPayload) =>
  `icloud-audit-fresh-download:v1:${payload.binding.ownerId}:${payload.binding.connectionId}:${payload.binding.resourceId}`;
export type ScheduledFreshDownload = { payload: ScheduledFreshPayload; seal: string };
export type ScheduledDeepValidation = { payload: { version: 1; basis: 'audit-settled-decode'; fresh: ScheduledFreshDownload;
  path: string; identity: MediaIntegrityIdentity; sha1: string; sha256: string; sizeInBytes: number }; seal: string };
export const scheduledDeepReceiptScope = (proof: ScheduledDeepValidation['payload']) =>
  `icloud-audit-settled-decode:v1:${proof.fresh.payload.binding.ownerId}:${proof.fresh.payload.binding.connectionId}:${proof.fresh.payload.binding.resourceId}`;
export type ScheduledStagingAdmission = { guarded: GuardedScheduledAudit; resource: ICloudResource };

/** Short database-only transactions. No callback may perform transport, filesystem or decoder work. */
@Injectable()
export class ICloudScheduledStagingRepository {
  constructor(@InjectKysely() private db: Kysely<DB>, private transport: ICloudTransportRepository) {}

  private async admitted<T>(
    input: ScheduledStagingInput,
    action: (db: Transaction<DB>, admission: ScheduledStagingAdmission) => Promise<T>,
  ): Promise<T | undefined> {
    return this.db.transaction().execute(async (db) => {
      const guarded = await guardScheduledAudit(db, input.authority, input.ownerId, { resource: input.resource });
      if (!guarded) {
        return;
      }
      const { rows: [resource] } = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
        FROM immich_fork.icloud_resource WHERE id=${input.resource.id}::uuid
          AND "ownerId"=${input.ownerId}::uuid AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(db);
      // Both the request's Cloud zone and the source zone must remain the frozen owned source.
      if (!resource || ['committed', 'finalized', 'removed', 'failed', 'cancelled'].includes(resource.status) ||
        canonicalJson(resource.library) !== canonicalJson(guarded.bindings.source.resource.library) ||
        canonicalJson(guarded.source.library) !== canonicalJson(guarded.bindings.source.resource.library)) {
        return;
      }
      return action(db, { guarded, resource });
    });
  }

  read(input: ScheduledStagingInput) {
    return this.admitted(input, async (_db, admission) => admission);
  }

  /** Terminal cleanup is independent of owner/provider credentials and cannot stamp proof. */
  async refusedResource(input: ScheduledStagingInput) {
    return (await sql<ICloudResource>`SELECT r.*,r."expectedSize"::float8 AS "expectedSize"
      FROM immich_fork.icloud_resource r JOIN immich_fork.icloud_identity_audit q ON q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
      WHERE r.id=${input.resource.id}::uuid AND r."ownerId"=${input.ownerId}::uuid AND q.id=${input.authority.auditRequestId}::uuid
        AND q.purpose='scheduled-weekly' AND q.result IN ('failed','stale','cancelled') AND r.status='failed'
        AND r."pendingJobs"='[]'::jsonb AND r."assetId" IS NULL AND r."promotedPath" IS NULL`.execute(this.db)).rows[0];
  }

  releaseRefusedBytes(input: ScheduledStagingInput) {
    return this.db.transaction().execute(async (db) => {
      await lockPublicForkWrites(db);
      await sql`UPDATE immich_fork.icloud_resource r SET status='removed',"reservedBytes"=0,"updatedAt"=clock_timestamp()
        WHERE r.id=${input.resource.id}::uuid AND r."ownerId"=${input.ownerId}::uuid AND r."auditRequestId"=${input.authority.auditRequestId}::uuid
          AND r.status='failed' AND r."assetId" IS NULL AND r."promotedPath" IS NULL AND r."pendingJobs"='[]'::jsonb
          AND EXISTS (SELECT 1 FROM immich_fork.icloud_identity_audit q WHERE q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
            AND q.purpose='scheduled-weekly' AND q.result IN ('failed','stale','cancelled'))`.execute(db);
    });
  }

  heartbeat(input: ScheduledStagingInput, path: string) {
    return this.admitted(input, async (db, { guarded }) => {
      const { rows } = await sql`UPDATE immich_fork.icloud_resource SET status='staging',"stagingPath"=${path},
        "leaseExpiresAt"=clock_timestamp()+interval '30 minutes',"updatedAt"=clock_timestamp()
        WHERE id=${input.resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)}
        RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }

  saveSession(input: ScheduledStagingInput, expected: string, refreshed: string) {
    return this.admitted(input, async (db, { guarded }) => {
      const { rows } = await sql`UPDATE immich_fork.icloud_connection SET "encryptedSession"=${refreshed},"updatedAt"=clock_timestamp()
        WHERE id=${guarded.connection.id}::uuid AND "ownerId"=${input.ownerId}::uuid AND "encryptedSession"=${expected}
          AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)} RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }

  /** Configuration/cryptography reads happen before the final database transaction. */
  async authenticateReceipt(input: ScheduledStagingInput, receipt: ScheduledFreshDownload) {
    const admission = await this.read(input);
    if (!admission || canonicalJson(admission.resource.verification?.auditFreshDownload) !== canonicalJson(receipt) ||
      canonicalJson(receipt.payload.binding) !== canonicalJson(scheduledFreshBinding(admission.guarded, admission.resource.id))) {
      return false;
    }
    try {
      const decoded = await this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal);
      return canonicalJson(decoded) === canonicalJson(receipt.payload) && !!(await this.read(input));
    } catch { return false; }
  }

  async authenticateDeepValidation(input: ScheduledStagingInput, proof: ScheduledDeepValidation) {
    if (!proof?.payload || proof.payload.version !== 1 || proof.payload.basis !== 'audit-settled-decode' ||
      !(await this.authenticateReceipt(input, proof.payload.fresh))) { return false; }
    try {
      const decoded = await this.transport.decodeSession(scheduledDeepReceiptScope(proof.payload), proof.seal);
      const current = await this.read(input);
      return canonicalJson(decoded) === canonicalJson(proof.payload) &&
        canonicalJson(current?.resource.verification?.auditDeepValidation) === canonicalJson(proof);
    } catch { return false; }
  }

  async storeDeepValidation(input: ScheduledStagingInput, proof: ScheduledDeepValidation) {
    if (!(await this.authenticateReceipt(input, proof.payload.fresh))) { return false; }
    try {
      if (canonicalJson(await this.transport.decodeSession(scheduledDeepReceiptScope(proof.payload), proof.seal)) !== canonicalJson(proof.payload)) { return false; }
    } catch { return false; }
    return this.admitted(input, async (db, { guarded, resource }) => {
      const payload = proof.payload;
      if (payload.version !== 1 || payload.basis !== 'audit-settled-decode' ||
        canonicalJson(resource.verification?.auditFreshDownload) !== canonicalJson(payload.fresh) ||
        payload.sha1 !== payload.fresh.payload.sha1 || payload.sha256 !== payload.fresh.payload.sha256 ||
        payload.sizeInBytes !== resource.expectedSize) { return false; }
      const changed = await sql`UPDATE immich_fork.icloud_resource SET verification=verification || jsonb_build_object('auditDeepValidation',${proof}::jsonb)
        WHERE id=${resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)} RETURNING id`.execute(db);
      return changed.rows.length === 1;
    });
  }

  /** Private resource evidence only: this never stamps an identity/integrity proof or settles a member. */
  async storeFreshDownload(input: ScheduledStagingInput, receipt: ScheduledFreshDownload) {
    // Authenticate outside any transaction: configuration reads are filesystem awaits.
    if (!(await this.read(input))) { return false; }
    try {
      const decoded = await this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal);
      if (canonicalJson(decoded) !== canonicalJson(receipt.payload)) { return false; }
    } catch { return false; }
    return this.admitted(input, async (db, { guarded, resource }) => {
      const payload = receipt.payload;
      if (payload.version !== 1 || payload.basis !== 'audit-fresh-download' || !receipt.seal ||
        canonicalJson(payload.binding) !== canonicalJson(scheduledFreshBinding(guarded, resource.id)) ||
        resource.stagingPath !== payload.path || !/^[\da-f]{40}$/.test(payload.sha1) || !/^[\da-f]{64}$/.test(payload.sha256)) {
        return false;
      }
      const { rows } = await sql`UPDATE immich_fork.icloud_resource SET
        verification=jsonb_build_object('auditFreshDownload',${receipt}::jsonb),
        sha1=${Buffer.from(payload.sha1, 'hex')},sha256=${Buffer.from(payload.sha256, 'hex')},"updatedAt"=clock_timestamp()
        WHERE id=${resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)}
        RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }
}
