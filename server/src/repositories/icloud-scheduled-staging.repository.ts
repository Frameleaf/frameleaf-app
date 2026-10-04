import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { MediaIntegrityIdentity } from 'src/services/media-integrity.service.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import {
  GuardedScheduledAudit,
  ScheduledAuditAuthority,
  ScheduledAuditResourceAuthority,
  guardScheduledAudit,
  scheduledAuditFinalFence,
} from 'src/repositories/icloud-scheduled-authority.js';
import { ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';
import { countPathReferences, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import {
  ScheduledPrivateCopyRecord,
  ScheduledPrivateWorkRecord,
  privateCopyScope,
  privateWorkScope,
  unlinkOwnedPrivateCopy,
  validPrivateCopy,
  validPrivateWork,
} from 'src/utils/icloud-private-copy.js';
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
export type ScheduledDeepValidation = {
  payload: {
    version: 1;
    basis: 'audit-settled-decode';
    fresh: ScheduledFreshDownload;
    path: string;
    identity: MediaIntegrityIdentity;
    sha1: string;
    sha256: string;
    sizeInBytes: number;
  };
  seal: string;
};
export const scheduledDeepReceiptScope = (proof: ScheduledDeepValidation['payload']) =>
  `icloud-audit-settled-decode:v1:${proof.fresh.payload.binding.ownerId}:${proof.fresh.payload.binding.connectionId}:${proof.fresh.payload.binding.resourceId}`;
export type ScheduledStagingAdmission = { guarded: GuardedScheduledAudit; resource: ICloudResource };

/** Caller holds the managed path lock. Unpublished rows and destination reservations own paths too. */
export async function scheduledPrivatePathReferences(db: Transaction<DB>, path: string, resourceId: string) {
  if (await countPathReferences(db, path)) {
    return true;
  }
  const references = await sql`SELECT 1 FROM public.physical_file WHERE path=${path}
    UNION ALL SELECT 1 FROM public.icloud_resource WHERE id<>${resourceId}::uuid
      AND (${path} IN (path,"stagingPath","promotedPath") OR ("pendingJobs"<>'[]'::jsonb AND "expectedTarget"->>'originalPath'=${path}))`.execute(
    db,
  );
  return references.rows.length > 0;
}

/** Short database-only transactions. No callback may perform transport, filesystem or decoder work. */
@Injectable()
export class ICloudScheduledStagingRepository {
  constructor(
    @InjectKysely() private db: Kysely<DB>,
    private transport: ICloudTransportRepository,
  ) {}

  private async admitted<T>(
    input: ScheduledStagingInput,
    action: (db: Transaction<DB>, admission: ScheduledStagingAdmission) => Promise<T>,
    managedPaths: string[] = [],
  ): Promise<T | undefined> {
    return this.db.transaction().execute(async (db) => {
      const guarded = await guardScheduledAudit(db, input.authority, input.ownerId, {
        resource: input.resource,
        managedPaths,
      });
      if (!guarded) {
        return;
      }
      const {
        rows: [resource],
      } = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
        FROM public.icloud_resource WHERE id=${input.resource.id}::uuid
          AND "ownerId"=${input.ownerId}::uuid AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(
        db,
      );
      // Both the request's Cloud zone and the source zone must remain the frozen owned source.
      if (
        !resource ||
        ['committed', 'finalized', 'removed', 'failed', 'cancelled'].includes(resource.status) ||
        canonicalJson(resource.library) !== canonicalJson(guarded.bindings.source.resource.library) ||
        canonicalJson(guarded.source.library) !== canonicalJson(guarded.bindings.source.resource.library)
      ) {
        return;
      }
      return action(db, { guarded, resource });
    });
  }

  read(input: ScheduledStagingInput) {
    return this.admitted(input, (_db, admission) => Promise.resolve(admission));
  }

  /** Called only by recovery.reserve while the existing global staging-budget lock is held. */
  async planPrivateCopy(db: Transaction<DB>, input: ScheduledStagingInput, promotedPath: string) {
    const guarded = await guardScheduledAudit(db, input.authority, input.ownerId, { resource: input.resource });
    if (!guarded?.request.itemClaimId) {
      return false;
    }
    const resource = (
      await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize","reservedBytes"::float8 AS "reservedBytes"
      FROM public.icloud_resource WHERE id=${input.resource.id}::uuid FOR UPDATE`.execute(db)
    ).rows[0];
    if (
      !resource?.stagingPath ||
      resource.assetId ||
      resource.path ||
      resource.pendingJobs.length > 0 ||
      resource.expectedTarget?.outcome !== 'imported' ||
      resource.promotedPath !== promotedPath ||
      resource.verification?.auditPrivateCopy !== undefined ||
      !Number.isSafeInteger(resource.expectedSize) ||
      resource.expectedSize <= 0
    ) {
      return false;
    }
    const budget = (
      await sql<{ global: number; connection: number }>`SELECT
      coalesce(sum("reservedBytes"),0)::float8 AS global,
      coalesce(sum("reservedBytes") FILTER (WHERE "connectionId"=${resource.connectionId}::uuid),0)::float8 AS connection
      FROM public.icloud_resource WHERE status NOT IN ('finalized','removed')`.execute(db)
    ).rows[0];
    const limit = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES') ?? 100 * 1024 ** 3);
    if (
      !budget ||
      [limit, budget.global, budget.connection, guarded.connection.config.stagingBytes, resource.reservedBytes].some(
        (value) => !(Number.isSafeInteger(value) && value >= 0),
      ) ||
      !Number.isSafeInteger(resource.reservedBytes + resource.expectedSize) ||
      budget.global + resource.expectedSize > limit ||
      budget.connection + resource.expectedSize > guarded.connection.config.stagingBytes
    ) {
      return false;
    }
    const generation = randomUUID();
    const record: ScheduledPrivateCopyRecord = {
      payload: {
        version: 1,
        purpose: 'scheduled-weekly-private-copy',
        generation,
        ownerId: input.ownerId,
        connectionId: resource.connectionId,
        resourceId: resource.id,
        auditRequestId: input.authority.auditRequestId,
        operationId: input.authority.operationId!,
        operationClaimToken: input.authority.operationClaimToken!,
        resourceLeaseToken: input.resource.leaseToken,
        itemClaimId: guarded.request.itemClaimId,
        sourceAssetId: resource.sourceAssetId,
        stagingPath: resource.stagingPath,
        temporaryPath: `${promotedPath}.${generation}.partial`,
        promotedPath,
        reservedCopyBytes: resource.expectedSize,
        identity: null,
        promoted: false,
        settled: false,
        disposed: false,
      },
      seal: null,
      pending: [],
    };
    if (!validPrivateCopy(record)) {
      return false;
    }
    await sql`UPDATE public.icloud_resource SET "reservedBytes"="reservedBytes"+${resource.expectedSize},
      verification=coalesce(verification,'{}'::jsonb)||jsonb_build_object('auditPrivateCopy',${JSON.stringify(record)}::text::jsonb)
      WHERE id=${resource.id}::uuid`.execute(db);
    return true;
  }

  async privateCopy(input: ScheduledStagingInput) {
    const resource = (
      await sql<ICloudResource>`SELECT * FROM public.icloud_resource
      WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid
        AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(this.db)
    ).rows[0];
    const record = resource?.verification?.auditPrivateCopy;
    return validPrivateCopy(record) &&
      record.payload.ownerId === input.ownerId &&
      record.payload.resourceId === input.resource.id &&
      record.payload.auditRequestId === input.authority.auditRequestId &&
      record.payload.resourceLeaseToken === input.resource.leaseToken &&
      record.payload.operationId === input.authority.operationId &&
      record.payload.operationClaimToken === input.authority.operationClaimToken
      ? record
      : undefined;
  }

  async unlinkPrivateTemporary(input: ScheduledStagingInput) {
    const record = await this.privateCopy(input);
    if (!record?.seal || !record.payload.promoted || !record.payload.identity) {
      throw new Error('scheduled_private_copy_unowned');
    }
    if (
      canonicalJson(await this.transport.decodeSession(privateCopyScope(record.payload), record.seal)) !==
      canonicalJson(record.payload)
    ) {
      throw new Error('scheduled_private_copy_unowned');
    }
    const result = await this.admitted(
      input,
      async (db, { resource }) => {
        if (canonicalJson(resource.verification?.auditPrivateCopy) !== canonicalJson(record)) {
          return false;
        }
        if (await scheduledPrivatePathReferences(db, record.payload.temporaryPath, input.resource.id)) {
          return false;
        }
        await unlinkOwnedPrivateCopy(record.payload.temporaryPath, record.payload.identity!);
        return true; // The promoted inode still exists: no byte charge is released here.
      },
      [record.payload.temporaryPath],
    );
    if (!result) {
      throw new Error('scheduled_private_copy_changed');
    }
  }

  async retiredPrivateCopies() {
    return (
      await sql<ICloudResource>`SELECT r.* FROM public.icloud_resource r
      JOIN public.icloud_identity_audit q ON q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
      WHERE q.purpose='scheduled-weekly' AND q.result IN ('failed','stale','cancelled') AND r.status='failed'
        AND r."assetId" IS NULL AND (r."promotedPath" IS NOT NULL OR r.verification ? 'auditPrivateCopy') AND r."pendingJobs"='[]'::jsonb
      ORDER BY r."updatedAt",r.id LIMIT 10`.execute(this.db)
    ).rows;
  }

  async retainPrivateCopy(resource: ICloudResource, reason: 'unproven' | 'pending-settlement' | 'fence-or-unlink') {
    await this.db.transaction().execute(async (db) => {
      await sql`UPDATE public.icloud_resource SET "lastError"=${`scheduled_private_copy_retained_${reason}`},"updatedAt"=clock_timestamp()
        WHERE id=${resource.id}::uuid AND "ownerId"=${resource.ownerId}::uuid AND status='failed'
          AND "assetId" IS NULL AND ("promotedPath" IS NOT NULL OR verification ? 'auditPrivateCopy') AND "pendingJobs"='[]'::jsonb`.execute(
        db,
      );
    });
  }

  /** Server producer CAS; never takes a payload from a DTO, operation snapshot or content hash. */
  async storePrivateCopy(
    input: ScheduledStagingInput,
    expected: ScheduledPrivateCopyRecord,
    record: ScheduledPrivateCopyRecord,
  ) {
    if (
      !validPrivateCopy(expected) ||
      !validPrivateCopy(record) ||
      record.payload.generation !== expected.payload.generation ||
      canonicalJson({ ...record.payload, identity: null, promoted: false, settled: false }) !==
        canonicalJson({ ...expected.payload, identity: null, promoted: false, settled: false })
    ) {
      return false;
    }
    if (record.seal) {
      try {
        if (
          canonicalJson(await this.transport.decodeSession(privateCopyScope(record.payload), record.seal)) !==
          canonicalJson(record.payload)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return this.db.transaction().execute(async (db) => {
      const changed = await sql`UPDATE public.icloud_resource SET
        verification=verification||jsonb_build_object('auditPrivateCopy',${JSON.stringify(record)}::text::jsonb)
        WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid
          AND "auditRequestId"=${input.authority.auditRequestId}::uuid AND status NOT IN ('finalized','removed')
          AND verification->'auditPrivateCopy'=${JSON.stringify(expected)}::text::jsonb RETURNING id`.execute(db);
      return changed.rows.length === 1;
    });
  }

  async beginPrivateWork(input: ScheduledStagingInput) {
    const token = randomUUID();
    const created = await this.admitted(input, async (db, { guarded, resource }) => {
      if (!guarded.request.itemClaimId) {
        return false;
      }
      const existing = resource.verification?.auditOwnedWork;
      if (
        existing !== undefined &&
        (!validPrivateWork(existing) ||
          existing.payload.resourceLeaseToken !== input.resource.leaseToken ||
          existing.payload.operationClaimToken !== input.authority.operationClaimToken ||
          existing.payload.itemClaimId !== guarded.request.itemClaimId)
      ) {
        return false;
      }
      if (
        validPrivateWork(existing) &&
        (!existing.seal ||
          canonicalJson(await this.transport.decodeSession(privateWorkScope(existing.payload), existing.seal)) !==
            canonicalJson(existing.payload))
      ) {
        return false;
      }
      const copy = resource.verification?.auditPrivateCopy;
      const copyGeneration = validPrivateCopy(copy) ? copy.payload.generation : null;
      if (
        validPrivateWork(existing) &&
        existing.payload.pending.length > 0 &&
        existing.payload.copyGeneration !== copyGeneration
      ) {
        return false;
      }
      const record: ScheduledPrivateWorkRecord = validPrivateWork(existing)
        ? existing
        : {
            payload: {
              version: 1,
              purpose: 'scheduled-weekly-private-work',
              generation: randomUUID(),
              ownerId: input.ownerId,
              resourceId: resource.id,
              auditRequestId: input.authority.auditRequestId,
              operationId: input.authority.operationId!,
              operationClaimToken: input.authority.operationClaimToken!,
              resourceLeaseToken: input.resource.leaseToken,
              itemClaimId: guarded.request.itemClaimId,
              copyGeneration,
              pending: [],
              settled: false,
            },
            seal: null,
          };
      const workPayload = {
        ...record.payload,
        copyGeneration,
        pending: [...record.payload.pending, token],
        settled: false,
      };
      const work = {
        payload: workPayload,
        seal: await this.transport.encodeSession(privateWorkScope(workPayload), workPayload),
      };
      if (
        validPrivateCopy(copy) &&
        copy.payload.identity &&
        (!copy.seal ||
          canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) !==
            canonicalJson(copy.payload))
      ) {
        return false;
      }
      const copyPayload = validPrivateCopy(copy) ? { ...copy.payload, settled: false } : undefined;
      const fields = {
        auditOwnedWork: work,
        ...(copyPayload && {
          auditPrivateCopy: {
            payload: copyPayload,
            seal: copyPayload.identity
              ? await this.transport.encodeSession(privateCopyScope(copyPayload), copyPayload)
              : null,
            pending: work.payload.pending,
          },
        }),
      };
      await sql`UPDATE public.icloud_resource SET verification=coalesce(verification,'{}'::jsonb)||${JSON.stringify(fields)}::text::jsonb
        WHERE id=${resource.id}::uuid`.execute(db);
      return true;
    });
    if (!created) {
      throw new Error('scheduled_private_work_changed');
    }
    return token;
  }

  /** Called only after actual copy/decoder/readonly work and its owned handle cleanup settle. */
  async finishPrivateWork(input: ScheduledStagingInput, token?: string) {
    if (!token) {
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const resource = (
        await sql<ICloudResource>`SELECT * FROM public.icloud_resource WHERE id=${input.resource.id}::uuid
        AND "ownerId"=${input.ownerId}::uuid AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(
          this.db,
        )
      ).rows[0];
      const record = resource?.verification?.auditOwnedWork;
      if (
        !validPrivateWork(record) ||
        !record.payload.pending.includes(token) ||
        record.payload.resourceLeaseToken !== input.resource.leaseToken ||
        record.payload.operationClaimToken !== input.authority.operationClaimToken
      ) {
        return;
      }
      try {
        if (
          !record.seal ||
          canonicalJson(await this.transport.decodeSession(privateWorkScope(record.payload), record.seal)) !==
            canonicalJson(record.payload)
        ) {
          return;
        }
      } catch {
        return;
      }
      const pending = record.payload.pending.filter((value) => value !== token);
      const payload = { ...record.payload, pending, settled: pending.length === 0 };
      const fields: Record<string, unknown> = {
        auditOwnedWork: { payload, seal: await this.transport.encodeSession(privateWorkScope(payload), payload) },
      };
      const copy = resource!.verification?.auditPrivateCopy;
      if (validPrivateCopy(copy)) {
        if (
          record.payload.copyGeneration !== copy.payload.generation ||
          copy.payload.resourceLeaseToken !== input.resource.leaseToken ||
          copy.payload.operationClaimToken !== input.authority.operationClaimToken ||
          copy.payload.ownerId !== input.ownerId ||
          copy.payload.resourceId !== input.resource.id ||
          copy.payload.itemClaimId !== record.payload.itemClaimId
        ) {
          return;
        }
        try {
          if (
            copy.payload.identity &&
            (!copy.seal ||
              canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) !==
                canonicalJson(copy.payload))
          ) {
            return;
          }
        } catch {
          return;
        }
        const copyPayload = { ...copy.payload, settled: pending.length === 0 && copy.payload.identity !== null };
        fields.auditPrivateCopy = {
          payload: copyPayload,
          pending,
          seal: copyPayload.identity
            ? await this.transport.encodeSession(privateCopyScope(copyPayload), copyPayload)
            : null,
        };
      }
      const changed = await this.db.transaction().execute(async (db) => {
        return (
          (
            await sql`UPDATE public.icloud_resource SET verification=verification||${JSON.stringify(fields)}::text::jsonb
          WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid AND status NOT IN ('removed','finalized')
            AND verification=${JSON.stringify(resource!.verification)}::text::jsonb RETURNING id`.execute(db)
          ).rows.length === 1
        );
      });
      if (changed) {
        return;
      }
    }
    // A lost CAS conservatively retains a pending generation; it never fabricates settlement.
  }

  /** Credential-independent terminal disposition, not proof publication or physical-original trash. */
  async disposePrivateCopy(input: ScheduledStagingInput) {
    const record = await this.privateCopy(input);
    if (
      !record?.seal ||
      !record.payload.identity ||
      !record.payload.settled ||
      record.payload.disposed ||
      record.pending.length > 0
    ) {
      return false;
    }
    try {
      if (
        canonicalJson(await this.transport.decodeSession(privateCopyScope(record.payload), record.seal)) !==
        canonicalJson(record.payload)
      ) {
        return false;
      }
    } catch {
      return false;
    }
    const copy = record.payload;
    return this.db.transaction().execute(async (db) => {
      await lockICloudItemClaims(db, copy.ownerId, [copy.sourceAssetId]);
      await db.selectFrom('user').select('id').where('id', '=', input.ownerId).forUpdate().executeTakeFirst();
      const request = (
        await sql<{
          itemClaimId: string;
          operationId: string;
          connectionId: string;
        }>`SELECT "itemClaimId","operationId","connectionId"
        FROM public.icloud_identity_audit WHERE id=${copy.auditRequestId}::uuid AND "ownerId"=${copy.ownerId}::uuid
          AND purpose='scheduled-weekly' AND "sessionId" IS NULL AND result IN ('failed','stale','cancelled') FOR UPDATE`.execute(
          db,
        )
      ).rows[0];
      const operation = (
        await sql<{ claimToken: string | null }>`SELECT "claimToken" FROM public.media_operation
        WHERE id=${copy.operationId}::uuid AND "ownerId"=${copy.ownerId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];
      const resource = (
        await sql<ICloudResource>`SELECT *,"reservedBytes"::float8 AS "reservedBytes" FROM public.icloud_resource
        WHERE id=${copy.resourceId}::uuid AND "ownerId"=${copy.ownerId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];
      if (
        !request ||
        request.operationId !== copy.operationId ||
        request.itemClaimId !== copy.itemClaimId ||
        request.connectionId !== copy.connectionId ||
        !operation ||
        (operation.claimToken !== null && operation.claimToken !== copy.operationClaimToken) ||
        !resource ||
        resource.status !== 'failed' ||
        resource.assetId ||
        resource.path ||
        resource.pendingJobs.length > 0 ||
        resource.leaseToken ||
        resource.leaseExpiresAt ||
        resource.connectionId !== copy.connectionId ||
        resource.sourceAssetId !== copy.sourceAssetId ||
        resource.promotedPath !== copy.promotedPath ||
        resource.stagingPath !== copy.stagingPath ||
        resource.expectedTarget?.outcome !== 'imported' ||
        canonicalJson(resource.verification?.auditPrivateCopy) !== canonicalJson(record) ||
        Number(resource.reservedBytes) < copy.reservedCopyBytes
      ) {
        return false;
      }
      // Lock even the expired original row. The shared item fence also excludes inserts when absent.
      const claims = await sql<{ id: string; live: boolean }>`SELECT id,"expiresAt">clock_timestamp() AS live
        FROM public.icloud_claim WHERE "ownerId"=${copy.ownerId}::uuid
          AND "cplAssetRecordName"=upper(${copy.sourceAssetId}) FOR UPDATE`.execute(db);
      if (claims.rows.some((claim) => claim.live && claim.id !== copy.itemClaimId)) {
        return false;
      }
      for (const path of [copy.temporaryPath, copy.promotedPath].sort()) {
        await lockFilePath(db, path);
        if (await scheduledPrivatePathReferences(db, path, copy.resourceId)) {
          return false;
        }
      }
      // Managed-writer fences stay held during bounded NOFOLLOW/unlink operations. A rollback after
      // unlink leaves charged evidence; ENOENT under this same sealed generation supports a retry.
      await unlinkOwnedPrivateCopy(copy.temporaryPath, copy.identity!);
      if (copy.promoted) {
        await unlinkOwnedPrivateCopy(copy.promotedPath, copy.identity!);
      }
      const disposedPayload = { ...copy, disposed: true };
      const disposed = {
        ...record,
        payload: disposedPayload,
        seal: await this.transport.encodeSession(privateCopyScope(disposedPayload), disposedPayload),
      };
      const changed =
        await sql`UPDATE public.icloud_resource SET "reservedBytes"="reservedBytes"-${copy.reservedCopyBytes},
        "promotedPath"=NULL,"expectedTarget"=NULL,
        verification=verification||jsonb_build_object('auditPrivateCopy',${JSON.stringify(disposed)}::text::jsonb),
        "lastError"='scheduled_private_copy_disposed',"updatedAt"=clock_timestamp()
        WHERE id=${copy.resourceId}::uuid AND verification->'auditPrivateCopy'=${JSON.stringify(record)}::text::jsonb RETURNING id`.execute(
          db,
        );
      if (changed.rows.length !== 1) {
        throw new Error('scheduled_private_copy_generation_changed');
      }
      return true;
    });
  }

  /** After generation-fenced copy disposal, delete only the sealed fresh source inode. */
  async disposeRefusedStaging(input: ScheduledStagingInput) {
    const resource = await this.refusedResource(input);
    const receipt = resource?.verification?.auditFreshDownload as ScheduledFreshDownload | undefined;
    const work = resource?.verification?.auditOwnedWork;
    const copy = resource?.verification?.auditPrivateCopy;
    if (
      copy !== undefined &&
      (!validPrivateCopy(copy) ||
        !copy.payload.disposed ||
        !copy.seal ||
        copy.payload.ownerId !== input.ownerId ||
        copy.payload.resourceId !== input.resource.id ||
        copy.payload.resourceLeaseToken !== input.resource.leaseToken ||
        copy.payload.operationClaimToken !== input.authority.operationClaimToken)
    ) {
      return false;
    }
    if (
      !validPrivateWork(work) ||
      !work.seal ||
      !work.payload.settled ||
      work.payload.pending.length > 0 ||
      work.payload.ownerId !== input.ownerId ||
      work.payload.resourceId !== input.resource.id ||
      work.payload.auditRequestId !== input.authority.auditRequestId ||
      work.payload.operationId !== input.authority.operationId ||
      work.payload.resourceLeaseToken !== input.resource.leaseToken ||
      work.payload.operationClaimToken !== input.authority.operationClaimToken
    ) {
      return false;
    }
    if (validPrivateCopy(copy) && work.payload.copyGeneration !== copy.payload.generation) {
      return false;
    }
    if (
      !resource?.stagingPath ||
      !receipt?.payload?.identity ||
      receipt.payload.path !== resource.stagingPath ||
      receipt.payload.binding.resourceId !== resource.id ||
      receipt.payload.binding.ownerId !== input.ownerId ||
      receipt.payload.binding.connectionId !== resource.connectionId ||
      receipt.payload.binding.sourceAssetId !== resource.sourceAssetId ||
      receipt.payload.binding.auditRequestId !== input.authority.auditRequestId ||
      receipt.payload.binding.operationId !== input.authority.operationId ||
      receipt.payload.sha256 !== resource.sha256?.toString('hex')
    ) {
      return false;
    }
    const stagingPath = resource.stagingPath;
    try {
      if (
        canonicalJson(await this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal)) !==
          canonicalJson(receipt.payload) ||
        canonicalJson(await this.transport.decodeSession(privateWorkScope(work.payload), work.seal)) !==
          canonicalJson(work.payload)
      ) {
        return false;
      }
      if (
        validPrivateCopy(copy) &&
        canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal!)) !==
          canonicalJson(copy.payload)
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return this.db.transaction().execute(async (db) => {
      await lockICloudItemClaims(db, input.ownerId, [resource.sourceAssetId]);
      await db.selectFrom('user').select('id').where('id', '=', input.ownerId).forUpdate().executeTakeFirst();
      const current = (
        await sql<ICloudResource>`SELECT * FROM public.icloud_resource
        WHERE id=${resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid AND status='failed'
          AND "auditRequestId"=${input.authority.auditRequestId}::uuid AND "assetId" IS NULL AND path IS NULL
          AND "promotedPath" IS NULL AND "pendingJobs"='[]'::jsonb AND "leaseToken" IS NULL AND "leaseExpiresAt" IS NULL
        FOR UPDATE`.execute(db)
      ).rows[0];
      if (
        !current ||
        current.stagingPath !== stagingPath ||
        canonicalJson(current.verification) !== canonicalJson(resource.verification)
      ) {
        return false;
      }
      const operation = (
        await sql<{ claimToken: string | null }>`SELECT "claimToken" FROM public.media_operation
        WHERE id=${input.authority.operationId}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];
      const request = (
        await sql<{ itemClaimId: string }>`SELECT "itemClaimId" FROM public.icloud_identity_audit
        WHERE id=${input.authority.auditRequestId}::uuid AND "ownerId"=${input.ownerId}::uuid AND purpose='scheduled-weekly'
          AND result IN ('failed','stale','cancelled') FOR UPDATE`.execute(db)
      ).rows[0];
      if (
        !operation ||
        (operation.claimToken !== null && operation.claimToken !== input.authority.operationClaimToken) ||
        !request ||
        request.itemClaimId !== work.payload.itemClaimId
      ) {
        return false;
      }
      const claims = await sql<{ id: string; live: boolean }>`SELECT id,"expiresAt">clock_timestamp() AS live
        FROM public.icloud_claim WHERE "ownerId"=${input.ownerId}::uuid
          AND "cplAssetRecordName"=upper(${current.sourceAssetId}) FOR UPDATE`.execute(db);
      if (claims.rows.some((claim) => claim.live && claim.id !== request.itemClaimId)) {
        return false;
      }
      await lockFilePath(db, stagingPath);
      if (await scheduledPrivatePathReferences(db, stagingPath, resource.id)) {
        return false;
      }
      if (!process.getuid) {
        return false;
      }
      await unlinkOwnedPrivateCopy(stagingPath, {
        dev: receipt.payload.identity.dev,
        ino: receipt.payload.identity.ino,
        size: receipt.payload.identity.size,
        uid: process.getuid(),
      });
      const changed = await sql`UPDATE public.icloud_resource SET status='removed',"reservedBytes"=0,"stagingPath"=NULL,
        "lastError"=NULL,"updatedAt"=clock_timestamp() WHERE id=${resource.id}::uuid
          AND verification=${JSON.stringify(resource.verification)}::text::jsonb RETURNING id`.execute(db);
      if (changed.rows.length !== 1) {
        throw new Error('scheduled_staging_generation_changed');
      }
      return true;
    });
  }

  /** Terminal cleanup is independent of owner/provider credentials and cannot stamp proof. */
  async refusedResource(input: ScheduledStagingInput) {
    return (
      await sql<ICloudResource>`SELECT r.*,r."expectedSize"::float8 AS "expectedSize"
      FROM public.icloud_resource r JOIN public.icloud_identity_audit q ON q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
      WHERE r.id=${input.resource.id}::uuid AND r."ownerId"=${input.ownerId}::uuid AND q.id=${input.authority.auditRequestId}::uuid
        AND q.purpose='scheduled-weekly' AND q.result IN ('failed','stale','cancelled') AND r.status='failed'
        AND r."pendingJobs"='[]'::jsonb AND r."assetId" IS NULL AND r."promotedPath" IS NULL`.execute(this.db)
    ).rows[0];
  }

  releaseRefusedBytes(input: ScheduledStagingInput) {
    return this.db.transaction().execute(async (db) => {
      await sql`UPDATE public.icloud_resource r SET status='removed',"reservedBytes"=0,"updatedAt"=clock_timestamp()
        WHERE r.id=${input.resource.id}::uuid AND r."ownerId"=${input.ownerId}::uuid AND r."auditRequestId"=${input.authority.auditRequestId}::uuid
          AND r.status='failed' AND r."assetId" IS NULL AND r."promotedPath" IS NULL AND r."pendingJobs"='[]'::jsonb
          AND EXISTS (SELECT 1 FROM public.icloud_identity_audit q WHERE q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
            AND q.purpose='scheduled-weekly' AND q.result IN ('failed','stale','cancelled'))`.execute(db);
    });
  }

  heartbeat(input: ScheduledStagingInput, path: string) {
    return this.admitted(input, async (db, { guarded }) => {
      const { rows } = await sql`UPDATE public.icloud_resource SET status='staging',"stagingPath"=${path},
        "leaseExpiresAt"=clock_timestamp()+interval '30 minutes',"updatedAt"=clock_timestamp()
        WHERE id=${input.resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)}
        RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }

  saveSession(input: ScheduledStagingInput, expected: string, refreshed: string) {
    return this.admitted(input, async (db, { guarded }) => {
      const { rows } =
        await sql`UPDATE public.icloud_connection SET "encryptedSession"=${refreshed},"updatedAt"=clock_timestamp()
        WHERE id=${guarded.connection.id}::uuid AND "ownerId"=${input.ownerId}::uuid AND "encryptedSession"=${expected}
          AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)} RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }

  /** Configuration/cryptography reads happen before the final database transaction. */
  async authenticateReceipt(input: ScheduledStagingInput, receipt: ScheduledFreshDownload) {
    const admission = await this.read(input);
    if (
      !admission ||
      canonicalJson(admission.resource.verification?.auditFreshDownload) !== canonicalJson(receipt) ||
      canonicalJson(receipt.payload.binding) !==
        canonicalJson(scheduledFreshBinding(admission.guarded, admission.resource.id))
    ) {
      return false;
    }
    try {
      const decoded = await this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal);
      return canonicalJson(decoded) === canonicalJson(receipt.payload) && !!(await this.read(input));
    } catch {
      return false;
    }
  }

  async authenticateDeepValidation(input: ScheduledStagingInput, proof: ScheduledDeepValidation) {
    if (
      !proof?.payload ||
      proof.payload.version !== 1 ||
      proof.payload.basis !== 'audit-settled-decode' ||
      !(await this.authenticateReceipt(input, proof.payload.fresh))
    ) {
      return false;
    }
    try {
      const decoded = await this.transport.decodeSession(scheduledDeepReceiptScope(proof.payload), proof.seal);
      const current = await this.read(input);
      return (
        canonicalJson(decoded) === canonicalJson(proof.payload) &&
        canonicalJson(current?.resource.verification?.auditDeepValidation) === canonicalJson(proof)
      );
    } catch {
      return false;
    }
  }

  async storeDeepValidation(input: ScheduledStagingInput, proof: ScheduledDeepValidation) {
    if (!(await this.authenticateReceipt(input, proof.payload.fresh))) {
      return false;
    }
    try {
      if (
        canonicalJson(await this.transport.decodeSession(scheduledDeepReceiptScope(proof.payload), proof.seal)) !==
        canonicalJson(proof.payload)
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return this.admitted(input, async (db, { guarded, resource }) => {
      const payload = proof.payload;
      if (
        payload.version !== 1 ||
        payload.basis !== 'audit-settled-decode' ||
        canonicalJson(resource.verification?.auditFreshDownload) !== canonicalJson(payload.fresh) ||
        payload.sha1 !== payload.fresh.payload.sha1 ||
        payload.sha256 !== payload.fresh.payload.sha256 ||
        payload.sizeInBytes !== resource.expectedSize
      ) {
        return false;
      }
      const changed =
        await sql`UPDATE public.icloud_resource SET verification=verification || jsonb_build_object('auditDeepValidation',${JSON.stringify(proof)}::text::jsonb)
        WHERE id=${resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)} RETURNING id`.execute(
          db,
        );
      return changed.rows.length === 1;
    });
  }

  /** Private resource evidence only: this never stamps an identity/integrity proof or settles a member. */
  async storeFreshDownload(input: ScheduledStagingInput, receipt: ScheduledFreshDownload) {
    // Authenticate outside any transaction: configuration reads are filesystem awaits.
    if (!(await this.read(input))) {
      return false;
    }
    try {
      const decoded = await this.transport.decodeSession(scheduledFreshReceiptScope(receipt.payload), receipt.seal);
      if (canonicalJson(decoded) !== canonicalJson(receipt.payload)) {
        return false;
      }
    } catch {
      return false;
    }
    return this.admitted(input, async (db, { guarded, resource }) => {
      const payload = receipt.payload;
      if (
        payload.version !== 1 ||
        payload.basis !== 'audit-fresh-download' ||
        !receipt.seal ||
        canonicalJson(payload.binding) !== canonicalJson(scheduledFreshBinding(guarded, resource.id)) ||
        resource.stagingPath !== payload.path ||
        !/^[\da-f]{40}$/.test(payload.sha1) ||
        !/^[\da-f]{64}$/.test(payload.sha256)
      ) {
        return false;
      }
      const { rows } = await sql`UPDATE public.icloud_resource SET
        verification=jsonb_build_object('auditFreshDownload',${JSON.stringify(receipt)}::text::jsonb),
        sha1=${Buffer.from(payload.sha1, 'hex')},sha256=${Buffer.from(payload.sha256, 'hex')},"updatedAt"=clock_timestamp()
        WHERE id=${resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)}
        RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }
}
