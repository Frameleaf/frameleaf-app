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
