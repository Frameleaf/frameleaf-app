import { Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  PrivateCopyIdentity,
  ScheduledPrivateCopyRecord,
  ScheduledPrivateWorkRecord,
  ValidationInputEnvelope,
  ValidationInputKey,
  ValidationInputPayload,
  ValidationInputStage,
  nextValidationInputSequence,
  privateCopyScope,
  privateWorkScope,
  unlinkOwnedPrivateCopy,
  unlinkOwnedValidationInput,
  validPrivateCopy,
  validPrivateWork,
  validValidationInputs,
  validationInputScope,
  validationInputsDisposed,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { scheduledAuditClaimHolder } from 'src/utils/icloud-weekly.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type ScheduledStagingInput = {
  authority: ScheduledAuditAuthority;
  ownerId: string;
  resource: ScheduledAuditResourceAuthority;
};
export type ValidationInputPlan = {
  expected: ValidationInputEnvelope | null;
  pathNonce: string;
  stage: ValidationInputStage;
  fresh: ScheduledFreshDownload;
  validationPath: string;
  sourceIdentity: PrivateCopyIdentity;
  stagingDirectory: string;
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
export async function scheduledPrivatePathReferences(
  db: Transaction<DB>,
  path: string,
  resourceId: string,
  transport: ICloudTransportRepository,
  self?: ValidationInputKey,
) {
  if (await countPathReferences(db, path)) return true;
  const references = await sql`SELECT 1 FROM public.physical_file WHERE path=${path}
    UNION ALL SELECT 1 FROM public.icloud_resource WHERE (id<>${resourceId}::uuid OR ${self !== undefined})
      AND (${path} IN (path,"stagingPath","promotedPath") OR ((${self !== undefined} OR "pendingJobs"<>'[]'::jsonb) AND "expectedTarget"->>'originalPath'=${path}))`.execute(
    db,
  );
  if (references.rows.length > 0) return true;
  const inputs = (
    await sql<{
      id: string;
      ownerId: string;
      inputs: unknown;
    }>`SELECT id,"ownerId",verification->'auditValidationInputs' AS inputs
    FROM public.icloud_resource r WHERE EXISTS (SELECT 1 FROM (VALUES
      (r.verification->'auditValidationInputs'->'payload'->'current'->'payload'),
      (r.verification->'auditValidationInputs'->'payload'->'previousDisposed'->'payload')
    ) AS records(payload) WHERE ${path} IN (records.payload->>'inputPath',records.payload->>'directoryPath',records.payload->>'validationPath'))`.execute(
      db,
    )
  ).rows;
  for (const row of inputs) {
    const value = row.inputs as ValidationInputEnvelope;
    for (const record of [value?.payload?.current, value?.payload?.previousDisposed]) {
      const payload = record?.payload;
      if (!payload || ![payload.inputPath, payload.directoryPath, payload.validationPath].includes(path)) continue;
      if (
        row.id === self?.resourceId &&
        payload.resourceId === self.resourceId &&
        payload.sequence === self.sequence &&
        payload.pathNonce === self.pathNonce
      )
        continue;
      if (
        payload.state === 'disposed' &&
        path !== payload.directoryPath &&
        validValidationInputs(value) &&
        value.payload.resourceId === row.id &&
        value.payload.ownerId === row.ownerId
      ) {
        try {
          if (
            canonicalJson(await transport.decodeSession(validationInputsScope(value.payload), value.seal)) ===
              canonicalJson(value.payload) &&
            canonicalJson(await transport.decodeSession(validationInputScope(payload), record!.seal)) ===
              canonicalJson(payload)
          )
            continue;
        } catch {
          /* Unknown evidence remains a reference. */
        }
      }
      return true;
    }
  }
  return false;
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

  private async authenticateValidationInputs(
    resource: ICloudResource,
    value: unknown = resource.verification?.auditValidationInputs,
    operationId?: string,
  ) {
    if (value === undefined) return;
    if (
      !validValidationInputs(value) ||
      value.payload.ownerId !== resource.ownerId ||
      value.payload.resourceId !== resource.id
    ) {
      throw new Error('validation_inputs_invalid');
    }
    for (const record of [
      value.payload.current,
      ...(value.payload.previousDisposed ? [value.payload.previousDisposed] : []),
    ]) {
      const payload = record.payload;
      if (
        (operationId !== undefined && payload.operationId !== operationId) ||
        payload.connectionId !== resource.connectionId ||
        payload.auditRequestId !== resource.auditRequestId ||
        payload.sourceAssetId !== resource.sourceAssetId ||
        canonicalJson(await this.transport.decodeSession(validationInputScope(payload), record.seal)) !==
          canonicalJson(payload)
      ) {
        throw new Error('validation_inputs_invalid');
      }
    }
    if (
      canonicalJson(await this.transport.decodeSession(validationInputsScope(value.payload), value.seal)) !==
      canonicalJson(value.payload)
    ) {
      throw new Error('validation_inputs_invalid');
    }
    return value;
  }

  /** Custody authentication only: no live grant, provider session or new generation authority. */
  async validationInputs(input: ScheduledStagingInput): Promise<ValidationInputEnvelope | undefined> {
    const resource = (
      await sql<ICloudResource>`SELECT * FROM public.icloud_resource
      WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid
        AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(this.db)
    ).rows[0];
    if (!resource) return;
    const envelope = await this.authenticateValidationInputs(resource);
    if (
      envelope &&
      [envelope.payload.current, envelope.payload.previousDisposed].some(
        (record) => record && record.payload.operationId !== input.authority.operationId,
      )
    ) {
      throw new Error('validation_inputs_invalid');
    }
    return envelope;
  }

  private async sealValidationInputs(payload: ValidationInputEnvelope['payload']) {
    if (!validValidationInputs({ payload, seal: 'pending' })) throw new Error('validation_inputs_invalid');
    const current = {
      payload: payload.current.payload,
      seal: await this.transport.encodeSession(validationInputScope(payload.current.payload), payload.current.payload),
    };
    const next = { ...payload, current };
    return { payload: next, seal: await this.transport.encodeSession(validationInputsScope(next), next) };
  }

  /** Reserve before beginPrivateWork; old/unknown pending work never authorizes the first input. */
  async planValidationInput(
    input: ScheduledStagingInput,
    plan: ValidationInputPlan,
  ): Promise<ValidationInputEnvelope | undefined> {
    const admission = await this.read(input);
    if (!admission?.guarded.request.itemClaimId) return;
    const { resource, guarded } = admission;
    const itemClaimId = guarded.request.itemClaimId;
    if (!itemClaimId) return;
    let current: ValidationInputEnvelope | undefined;
    let expected: ValidationInputEnvelope | undefined;
    const copy = resource.verification?.auditPrivateCopy;
    const work = resource.verification?.auditOwnedWork;
    try {
      current = await this.authenticateValidationInputs(resource, undefined, input.authority.operationId ?? undefined);
      expected =
        plan.expected === null
          ? undefined
          : await this.authenticateValidationInputs(resource, plan.expected, input.authority.operationId ?? undefined);
      if (
        canonicalJson(resource.verification?.auditFreshDownload) !== canonicalJson(plan.fresh) ||
        canonicalJson(plan.fresh.payload.binding) !== canonicalJson(scheduledFreshBinding(guarded, resource.id)) ||
        canonicalJson(
          await this.transport.decodeSession(scheduledFreshReceiptScope(plan.fresh.payload), plan.fresh.seal),
        ) !== canonicalJson(plan.fresh.payload)
      )
        return;
      if (
        copy !== undefined &&
        (!validPrivateCopy(copy) ||
          !copy.seal ||
          !copy.payload.identity ||
          canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) !==
            canonicalJson(copy.payload))
      )
        return;
      if (
        !validPrivateWork(work) ||
        !work.seal ||
        canonicalJson(await this.transport.decodeSession(privateWorkScope(work.payload), work.seal)) !==
          canonicalJson(work.payload)
      )
        return;
    } catch {
      return;
    }
    if (!validPrivateWork(work)) return;
    const prior = current?.payload.current.payload;
    const settledPredecessor = prior?.state === 'disposed' ? prior : current?.payload.previousDisposed?.payload;
    const copyBytes = validPrivateCopy(copy) && !copy.payload.disposed ? copy.payload.reservedCopyBytes : 0;
    const inputBytes = prior && prior.state !== 'disposed' ? prior.reservedInputBytes : 0;
    const aggregate = resource.expectedSize + copyBytes + inputBytes;
    if (
      !Number.isSafeInteger(resource.expectedSize) ||
      resource.expectedSize <= 0 ||
      !Number.isSafeInteger(aggregate) ||
      Number(resource.reservedBytes) !== aggregate ||
      resource.stagingPath !== plan.fresh.payload.path ||
      plan.stagingDirectory !== dirname(plan.fresh.payload.path) ||
      work.payload.ownerId !== input.ownerId ||
      work.payload.resourceId !== resource.id ||
      work.payload.auditRequestId !== input.authority.auditRequestId ||
      work.payload.operationId !== input.authority.operationId ||
      work.payload.copyGeneration !== (validPrivateCopy(copy) ? copy.payload.generation : null) ||
      !(
        (work.payload.resourceLeaseToken === input.resource.leaseToken &&
          work.payload.operationClaimToken === input.authority.operationClaimToken &&
          work.payload.itemClaimId === guarded.request.itemClaimId) ||
        (settledPredecessor &&
          work.payload.settled &&
          work.payload.pending.length === 0 &&
          work.payload.resourceLeaseToken === settledPredecessor.resourceLeaseToken &&
          work.payload.operationClaimToken === settledPredecessor.operationClaimToken &&
          work.payload.itemClaimId === settledPredecessor.itemClaimId)
      )
    )
      return;
    if (
      validPrivateCopy(copy) &&
      (copy.payload.ownerId !== input.ownerId ||
        copy.payload.resourceId !== resource.id ||
        copy.payload.connectionId !== resource.connectionId ||
        copy.payload.auditRequestId !== input.authority.auditRequestId ||
        copy.payload.operationId !== input.authority.operationId ||
        copy.payload.sourceAssetId !== resource.sourceAssetId ||
        copy.payload.stagingPath !== resource.stagingPath ||
        copy.payload.reservedCopyBytes !== resource.expectedSize ||
        (!copy.payload.disposed &&
          (copy.payload.resourceLeaseToken !== input.resource.leaseToken ||
            copy.payload.operationClaimToken !== input.authority.operationClaimToken ||
            copy.payload.itemClaimId !== guarded.request.itemClaimId)))
    )
      return;
    // An existing reuse candidate is an already-managed original with no durable identity of its own here;
    // its observed identity is bound into the input and re-read by the decoder. It never stands in for an
    // undisposed recovery copy, which must validate as its own generation-bound destination.
    const ownedCopyLive = validPrivateCopy(copy) && !copy.payload.disposed;
    const sourceIdentity =
      plan.stage === 'source'
        ? plan.fresh.payload.identity
        : plan.stage === 'existing-destination'
          ? ownedCopyLive
            ? undefined
            : plan.sourceIdentity
          : validPrivateCopy(copy)
            ? copy.payload.identity
            : undefined;
    if (
      !sourceIdentity ||
      ['dev', 'ino', 'size'].some(
        (key) =>
          plan.sourceIdentity[key as keyof PrivateCopyIdentity] !== sourceIdentity[key as keyof typeof sourceIdentity],
      ) ||
      (process.getuid && plan.sourceIdentity.uid !== process.getuid()) ||
      (plan.stage === 'recovery-destination' &&
        (!validPrivateCopy(copy) ||
          copy.payload.disposed ||
          !copy.payload.promoted ||
          plan.validationPath !== copy.payload.promotedPath ||
          canonicalJson(copy.payload.identity) !== canonicalJson(plan.sourceIdentity)))
    )
      return;
    const replay = prior?.pathNonce === plan.pathNonce;
    const sequence = replay ? prior!.sequence : nextValidationInputSequence(expected?.payload.highWater ?? '0');
    const payload: ValidationInputPayload = {
      version: 1,
      purpose: 'scheduled-weekly-validation-input',
      ownerId: input.ownerId,
      connectionId: resource.connectionId,
      resourceId: resource.id,
      auditRequestId: input.authority.auditRequestId,
      operationId: input.authority.operationId!,
      operationClaimToken: input.authority.operationClaimToken!,
      resourceLeaseToken: input.resource.leaseToken,
      itemClaimId,
      sourceAssetId: resource.sourceAssetId,
      sequence,
      pathNonce: plan.pathNonce,
      stage: plan.stage,
      fresh: plan.fresh,
      validationPath: plan.validationPath,
      sourceIdentity: plan.sourceIdentity,
      copyGeneration: plan.stage === 'recovery-destination' && validPrivateCopy(copy) ? copy.payload.generation : null,
      stagingDirectory: plan.stagingDirectory,
      directoryPath: `${plan.stagingDirectory}/.validation-${plan.pathNonce}`,
      inputPath: `${plan.stagingDirectory}/.validation-${plan.pathNonce}/input`,
      directoryIdentity: null,
      inputIdentity: null,
      reservedInputBytes: resource.expectedSize,
      state: 'reserved',
      pending: [],
    };
    let next: ValidationInputEnvelope;
    if (replay && current) {
      if (
        canonicalJson({ ...prior, state: 'reserved', pending: [], directoryIdentity: null, inputIdentity: null }) !==
        canonicalJson(payload)
      )
        return;
      const sameGeneration =
        expected &&
        expected.payload.highWater === current.payload.highWater &&
        expected.payload.current.payload.pathNonce === prior!.pathNonce;
      const predecessor = expected
        ? expected.payload.current.payload.state === 'disposed' &&
          canonicalJson(current.payload.previousDisposed) === canonicalJson(expected.payload.current) &&
          current.payload.highWater === nextValidationInputSequence(expected.payload.highWater)
        : current.payload.highWater === '1' && !current.payload.previousDisposed;
      if (!sameGeneration && !predecessor) return;
      next = current;
    } else {
      if (
        canonicalJson(current ?? null) !== canonicalJson(expected ?? null) ||
        (prior && prior.state !== 'disposed') ||
        current?.payload.previousDisposed?.payload.pathNonce === plan.pathNonce ||
        !work.payload.settled ||
        work.payload.pending.length > 0 ||
        (validPrivateCopy(copy) && (!copy.payload.settled || copy.pending.length > 0))
      )
        return;
      const envelope: ValidationInputEnvelope['payload'] = {
        version: 1,
        purpose: 'scheduled-weekly-validation-inputs',
        ownerId: input.ownerId,
        resourceId: resource.id,
        highWater: sequence,
        current: { payload, seal: 'pending' },
        previousDisposed: current?.payload.current ?? null,
      };
      if (!validValidationInputs({ payload: envelope, seal: 'pending' })) return;
      next = await this.sealValidationInputs(envelope);
    }
    // All transport/configuration awaits precede locks. The locked full snapshot revalidates them.
    return this.db.transaction().execute(async (db) => {
      await lockICloudItemClaims(db, input.ownerId, [resource.sourceAssetId]);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(db);
      const live = await guardScheduledAudit(db, input.authority, input.ownerId, {
        resource: input.resource,
        managedPaths: [payload.validationPath, payload.stagingDirectory, payload.directoryPath, payload.inputPath],
      });
      const locked = (
        await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize","reservedBytes"::float8 AS "reservedBytes"
        FROM public.icloud_resource WHERE id=${resource.id}::uuid FOR UPDATE`.execute(db)
      ).rows[0];
      if (
        !live ||
        live.source.sourceAssetId !== resource.sourceAssetId ||
        !locked ||
        canonicalJson(locked.verification) !== canonicalJson(resource.verification) ||
        Number(locked.reservedBytes) !== aggregate ||
        canonicalJson(scheduledFreshBinding(live, resource.id)) !== canonicalJson(plan.fresh.payload.binding)
      )
        return;
      if (replay) return next;
      const budget = (
        await sql<{ global: number; connection: number; invalid: boolean }>`SELECT
        coalesce(sum("reservedBytes"),0)::float8 AS global,
        coalesce(sum("reservedBytes") FILTER (WHERE "connectionId"=${resource.connectionId}::uuid),0)::float8 AS connection,
        coalesce(bool_or("reservedBytes"<0),false) AS invalid
        FROM public.icloud_resource WHERE status NOT IN ('finalized','removed')`.execute(db)
      ).rows[0];
      const limit = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES') ?? 100 * 1024 ** 3);
      if (
        !budget ||
        budget.invalid ||
        [
          budget.global,
          budget.connection,
          limit,
          live.connection.config.stagingBytes,
          aggregate + resource.expectedSize,
          budget.global + resource.expectedSize,
          budget.connection + resource.expectedSize,
        ].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        budget.global < aggregate ||
        budget.connection < aggregate ||
        budget.global < budget.connection ||
        budget.global + resource.expectedSize > limit ||
        budget.connection + resource.expectedSize > live.connection.config.stagingBytes
      )
        return;
      const changed =
        await sql`UPDATE public.icloud_resource SET "reservedBytes"="reservedBytes"+${resource.expectedSize},
        verification=coalesce(verification,'{}'::jsonb)||jsonb_build_object('auditValidationInputs',${JSON.stringify(next)}::text::jsonb),"updatedAt"=clock_timestamp()
        WHERE id=${resource.id}::uuid AND verification IS NOT DISTINCT FROM ${JSON.stringify(resource.verification)}::text::jsonb
          AND "reservedBytes"=${aggregate} RETURNING id`.execute(db);
      return changed.rows.length === 1 ? next : undefined;
    });
  }

  /** Settlement needs original local custody, not a still-enabled grant or provider session. */
  private async lockValidationSettlement(
    db: Transaction<DB>,
    input: ScheduledStagingInput,
    payload: ValidationInputPayload,
  ) {
    await db.selectFrom('user').select('id').where('id', '=', input.ownerId).forUpdate().executeTakeFirst();
    const operation = (
      await sql<{ claimToken: string | null }>`SELECT "claimToken" FROM public.media_operation
      WHERE id=${payload.operationId}::uuid AND "ownerId"=${payload.ownerId}::uuid FOR UPDATE`.execute(db)
    ).rows[0];
    const request = (
      await sql<{
        operationId: string;
        connectionId: string;
        itemClaimId: string;
      }>`SELECT "operationId","connectionId","itemClaimId"
      FROM public.icloud_identity_audit WHERE id=${payload.auditRequestId}::uuid AND "ownerId"=${payload.ownerId}::uuid
        AND purpose='scheduled-weekly' AND "sessionId" IS NULL FOR UPDATE`.execute(db)
    ).rows[0];
    const claims = (
      await sql<{ id: string; holder: string; live: boolean }>`SELECT id,holder,"expiresAt">clock_timestamp() AS live
      FROM public.icloud_claim WHERE "ownerId"=${payload.ownerId}::uuid AND "cplAssetRecordName"=upper(${payload.sourceAssetId}) FOR UPDATE`.execute(
        db,
      )
    ).rows;
    const resource = (
      await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource WHERE id=${payload.resourceId}::uuid
      AND "ownerId"=${payload.ownerId}::uuid FOR UPDATE`.execute(db)
    ).rows[0];
    return (
      !!operation &&
      (operation.claimToken === payload.operationClaimToken || operation.claimToken === null) &&
      !!request &&
      request.operationId === payload.operationId &&
      request.connectionId === payload.connectionId &&
      request.itemClaimId === payload.itemClaimId &&
      claims.every(
        (claim) =>
          !(
            claim.live &&
            (claim.id !== payload.itemClaimId || claim.holder !== scheduledAuditClaimHolder(payload.ownerId, payload))
          ),
      ) &&
      !!resource &&
      resource.auditRequestId === payload.auditRequestId &&
      resource.connectionId === payload.connectionId &&
      resource.sourceAssetId === payload.sourceAssetId &&
      resource.expectedSize === payload.reservedInputBytes &&
      !['removed', 'finalized'].includes(resource.status) &&
      (resource.leaseToken === payload.resourceLeaseToken || (!resource.leaseToken && !resource.leaseExpiresAt))
    );
  }

  /** Expected state/tokens and immutable inode custody are one CAS; this never disposes or refunds. */
  async storeValidationInput(
    input: ScheduledStagingInput,
    expected: ValidationInputEnvelope,
    next: ValidationInputPayload,
  ): Promise<ValidationInputEnvelope | undefined> {
    const resource = (
      await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource
      WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(
        this.db,
      )
    ).rows[0];
    if (!resource) return;
    try {
      if (
        canonicalJson(
          await this.authenticateValidationInputs(resource, undefined, input.authority.operationId ?? undefined),
        ) !== canonicalJson(expected)
      )
        return;
    } catch {
      return;
    }
    const current = expected.payload.current.payload;
    const immutable = (payload: ValidationInputPayload) => ({
      ...payload,
      state: 'reserved',
      pending: [],
      directoryIdentity: null,
      inputIdentity: null,
    });
    const sameInode = (a: PrivateCopyIdentity | null, b: PrivateCopyIdentity | null) =>
      !a || (!!b && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && b.size >= a.size);
    if (
      current.operationId !== input.authority.operationId ||
      current.operationClaimToken !== input.authority.operationClaimToken ||
      current.resourceLeaseToken !== input.resource.leaseToken ||
      canonicalJson(immutable(current)) !== canonicalJson(immutable(next)) ||
      !sameInode(current.directoryIdentity, next.directoryIdentity) ||
      !sameInode(current.inputIdentity, next.inputIdentity) ||
      (next.directoryIdentity !== null && next.directoryIdentity.uid !== current.sourceIdentity.uid) ||
      (next.inputIdentity !== null && next.inputIdentity.uid !== current.sourceIdentity.uid) ||
      !(
        {
          reserved: ['preparing'],
          preparing: ['preparing', 'running', 'settled'],
          running: ['running', 'settled'],
          settled: [],
          disposed: [],
        }[current.state] as string[]
      ).includes(next.state) ||
      (current.state === 'reserved' &&
        (!next.directoryIdentity || !next.inputIdentity || next.inputIdentity.size > 0)) ||
      (current.state !== 'reserved' && next.pending.some((token) => !current.pending.includes(token))) ||
      (next.state !== 'settled' &&
        current.state !== 'reserved' &&
        canonicalJson(next.pending) !== canonicalJson(current.pending))
    )
      return;
    const work = resource.verification?.auditOwnedWork;
    try {
      if (
        !validPrivateWork(work) ||
        !work.seal ||
        work.payload.ownerId !== input.ownerId ||
        work.payload.resourceId !== resource.id ||
        work.payload.auditRequestId !== current.auditRequestId ||
        work.payload.operationId !== current.operationId ||
        work.payload.operationClaimToken !== current.operationClaimToken ||
        work.payload.resourceLeaseToken !== current.resourceLeaseToken ||
        work.payload.itemClaimId !== current.itemClaimId ||
        [...current.pending, ...next.pending].some((token) => !work.payload.pending.includes(token)) ||
        (next.state !== 'settled' && next.pending.length === 0) ||
        canonicalJson(await this.transport.decodeSession(privateWorkScope(work.payload), work.seal)) !==
          canonicalJson(work.payload)
      )
        return;
    } catch {
      return;
    }
    let sealed: ValidationInputEnvelope;
    try {
      sealed = await this.sealValidationInputs({ ...expected.payload, current: { payload: next, seal: 'pending' } });
    } catch {
      return;
    }
    return this.db.transaction().execute(async (db) => {
      await lockICloudItemClaims(db, input.ownerId, [current.sourceAssetId]);
      if (next.state === 'settled') {
        if (!(await this.lockValidationSettlement(db, input, current))) return;
      } else {
        const live = await guardScheduledAudit(db, input.authority, input.ownerId, {
          resource: input.resource,
          managedPaths: [next.validationPath, next.directoryPath, next.inputPath],
        });
        if (
          !live ||
          live.request.itemClaimId !== current.itemClaimId ||
          live.source.sourceAssetId !== current.sourceAssetId
        )
          return;
      }
      const changed =
        await sql`UPDATE public.icloud_resource SET verification=verification||jsonb_build_object('auditValidationInputs',${JSON.stringify(sealed)}::text::jsonb),
        "updatedAt"=clock_timestamp() WHERE id=${resource.id}::uuid AND verification=${JSON.stringify(resource.verification)}::text::jsonb
          AND status NOT IN ('finalized','removed') RETURNING id`.execute(db);
      return changed.rows.length === 1 ? sealed : undefined;
    });
  }

  /** Existing release transactions use this instance helper; it never nests or changes a budget. */
  async authenticateDisposedValidationInputs(db: Transaction<DB>, resource: ICloudResource): Promise<boolean> {
    try {
      const envelope = await this.authenticateValidationInputs(resource);
      if (envelope) return validationInputsDisposed(envelope);
      if (!resource.auditRequestId) return true;
      const request = (
        await sql<{
          purpose: string;
          sessionId: string | null;
          operationId: string;
          itemClaimId: string | null;
        }>`SELECT purpose,"sessionId","operationId","itemClaimId"
        FROM public.icloud_identity_audit WHERE id=${resource.auditRequestId}::uuid AND "ownerId"=${resource.ownerId}::uuid
          AND "connectionId"=${resource.connectionId}::uuid`.execute(db)
      ).rows[0];
      if (request?.purpose === 'manual-session') return true;
      if (request?.purpose !== 'scheduled-weekly' || request.sessionId !== null) return false;
      const work = resource.verification?.auditOwnedWork;
      if (
        !validPrivateWork(work) ||
        !work.seal ||
        !work.payload.settled ||
        work.payload.pending.length > 0 ||
        work.payload.ownerId !== resource.ownerId ||
        work.payload.resourceId !== resource.id ||
        work.payload.auditRequestId !== resource.auditRequestId ||
        (resource.leaseToken !== null && work.payload.resourceLeaseToken !== resource.leaseToken) ||
        canonicalJson(await this.transport.decodeSession(privateWorkScope(work.payload), work.seal)) !==
          canonicalJson(work.payload)
      )
        return false;
      if (request.operationId !== work.payload.operationId || request.itemClaimId !== work.payload.itemClaimId)
        return false;
      const copy = resource.verification?.auditPrivateCopy;
      if (copy === undefined) return work.payload.copyGeneration === null;
      return (
        validPrivateCopy(copy) &&
        !!copy.seal &&
        !!copy.payload.identity &&
        copy.payload.settled &&
        copy.pending.length === 0 &&
        copy.payload.ownerId === resource.ownerId &&
        copy.payload.resourceId === resource.id &&
        copy.payload.connectionId === resource.connectionId &&
        copy.payload.auditRequestId === resource.auditRequestId &&
        copy.payload.sourceAssetId === resource.sourceAssetId &&
        copy.payload.operationId === work.payload.operationId &&
        copy.payload.operationClaimToken === work.payload.operationClaimToken &&
        copy.payload.resourceLeaseToken === work.payload.resourceLeaseToken &&
        copy.payload.itemClaimId === work.payload.itemClaimId &&
        copy.payload.generation === work.payload.copyGeneration &&
        canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) ===
          canonicalJson(copy.payload)
      );
    } catch {
      return false;
    }
  }

  /** Authenticated input-only refund; provider/grant admission is deliberately absent. */
  async disposeValidationInput(input: ScheduledStagingInput, expected: ValidationInputEnvelope): Promise<boolean> {
    const resource = (
      await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize","reservedBytes"::float8 AS "reservedBytes"
      FROM public.icloud_resource WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid
        AND "auditRequestId"=${input.authority.auditRequestId}::uuid`.execute(this.db)
    ).rows[0];
    if (!resource) return false;
    let envelope: ValidationInputEnvelope | undefined;
    try {
      envelope = await this.authenticateValidationInputs(resource, undefined, input.authority.operationId ?? undefined);
      await this.authenticateValidationInputs(resource, expected, input.authority.operationId ?? undefined);
    } catch {
      return false;
    }
    if (!envelope) return false;
    const payload = expected.payload.current.payload;
    if (
      payload.operationClaimToken !== input.authority.operationClaimToken ||
      payload.resourceLeaseToken !== input.resource.leaseToken ||
      !['settled', 'disposed'].includes(payload.state) ||
      payload.pending.length > 0
    )
      return false;
    const disposedPayload = { ...payload, state: 'disposed' as const };
    for (const record of [envelope.payload.current, envelope.payload.previousDisposed]) {
      if (record?.payload.state === 'disposed' && canonicalJson(record.payload) === canonicalJson(disposedPayload))
        return true;
    }
    if (payload.state !== 'settled' || canonicalJson(envelope) !== canonicalJson(expected)) return false;
    const copy = resource.verification?.auditPrivateCopy;
    let copyBytes = 0;
    if (copy !== undefined) {
      try {
        if (
          !validPrivateCopy(copy) ||
          !copy.seal ||
          !copy.payload.identity ||
          copy.payload.ownerId !== payload.ownerId ||
          copy.payload.resourceId !== payload.resourceId ||
          copy.payload.connectionId !== payload.connectionId ||
          copy.payload.auditRequestId !== payload.auditRequestId ||
          copy.payload.sourceAssetId !== payload.sourceAssetId ||
          copy.payload.operationId !== payload.operationId ||
          copy.payload.reservedCopyBytes !== resource.expectedSize ||
          canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) !==
            canonicalJson(copy.payload)
        )
          return false;
        copyBytes = copy.payload.disposed ? 0 : copy.payload.reservedCopyBytes;
      } catch {
        return false;
      }
    }
    const aggregate = resource.expectedSize + copyBytes + payload.reservedInputBytes;
    if (
      !Number.isSafeInteger(aggregate) ||
      Number(resource.reservedBytes) !== aggregate ||
      !Number.isSafeInteger(resource.expectedSize) ||
      resource.expectedSize <= 0
    )
      return false;
    const disposed = await this.db.transaction().execute(async (db) => {
      await lockICloudItemClaims(db, payload.ownerId, [payload.sourceAssetId]);
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(db);
      if (!(await this.lockValidationSettlement(db, input, payload))) return false;
      const locked = (
        await sql<ICloudResource>`SELECT * FROM public.icloud_resource WHERE id=${payload.resourceId}::uuid FOR UPDATE`.execute(
          db,
        )
      ).rows[0];
      if (
        !locked ||
        canonicalJson(locked.verification) !== canonicalJson(resource.verification) ||
        Number(locked.reservedBytes) !== aggregate
      )
        return false;
      for (const path of [payload.directoryPath, payload.inputPath].sort()) {
        await lockFilePath(db, path);
        if (await scheduledPrivatePathReferences(db, path, payload.resourceId, this.transport, payload)) return false;
      }
      await unlinkOwnedValidationInput(payload);
      const sealed = await this.sealValidationInputs({
        ...envelope!.payload,
        current: { payload: disposedPayload, seal: 'pending' },
      });
      const changed =
        await sql`UPDATE public.icloud_resource SET "reservedBytes"="reservedBytes"-${payload.reservedInputBytes},
        verification=verification||jsonb_build_object('auditValidationInputs',${JSON.stringify(sealed)}::text::jsonb),"updatedAt"=clock_timestamp()
        WHERE id=${payload.resourceId}::uuid AND verification=${JSON.stringify(resource.verification)}::text::jsonb
          AND "reservedBytes"=${aggregate} RETURNING id`.execute(db);
      if (changed.rows.length !== 1) throw new Error('validation_input_generation_changed');
      return true;
    });
    if (disposed) {
      // Empty-parent removal is housekeeping after commit, never refund authority or recursive cleanup.
      try {
        const parent = await lstat(payload.directoryPath);
        const owned = payload.directoryIdentity!;
        if (
          parent.isDirectory() &&
          (parent.mode & 0o077) === 0 &&
          parent.dev === owned.dev &&
          parent.ino === owned.ino &&
          parent.uid === owned.uid &&
          (await realpath(payload.directoryPath)) === payload.directoryPath
        )
          await rmdir(payload.directoryPath);
      } catch {
        /* A changed/nonempty parent remains retained. */
      }
    }
    return disposed;
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
        if (await scheduledPrivatePathReferences(db, record.payload.temporaryPath, input.resource.id, this.transport)) {
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

  /** Advance a successful restart sweep only after current disposed custody authenticates. */
  async deferDisposedValidationInput(input: ScheduledStagingInput): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      const resource = (
        await sql<ICloudResource>`SELECT * FROM public.icloud_resource
        WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid
          AND "auditRequestId"=${input.authority.auditRequestId}::uuid
          AND status NOT IN ('finalized','removed') FOR UPDATE`.execute(db)
      ).rows[0];
      if (!resource) return false;
      try {
        const envelope = await this.authenticateValidationInputs(
          resource,
          undefined,
          input.authority.operationId ?? undefined,
        );
        if (!envelope || !validationInputsDisposed(envelope)) return false;
        const current = envelope.payload.current.payload;
        if (
          current.resourceLeaseToken !== input.resource.leaseToken ||
          current.operationClaimToken !== input.authority.operationClaimToken
        )
          return false;
        await sql`UPDATE public.icloud_resource SET "nextAttemptAt"=clock_timestamp()+interval '5 minutes',
          "updatedAt"=clock_timestamp() WHERE id=${resource.id}::uuid
            AND verification=${JSON.stringify(resource.verification)}::text::jsonb`.execute(db);
        return true;
      } catch {
        return false;
      }
    });
  }

  async retainedValidationInputs(): Promise<ICloudResource[]> {
    return (
      await sql<ICloudResource>`SELECT * FROM public.icloud_resource
      WHERE verification ? 'auditValidationInputs' AND status NOT IN ('finalized','removed')
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=clock_timestamp())
      ORDER BY "updatedAt",id LIMIT 10`.execute(this.db)
    ).rows;
  }

  async retainValidationInput(
    resource: ICloudResource,
    reason: 'unproven' | 'pending-settlement' | 'fence-or-unlink',
  ): Promise<void> {
    await sql`UPDATE public.icloud_resource SET "lastError"=${`scheduled_validation_input_retained_${reason}`},
      "nextAttemptAt"=clock_timestamp()+interval '5 minutes',"updatedAt"=clock_timestamp()
      WHERE id=${resource.id}::uuid AND "ownerId"=${resource.ownerId}::uuid
        AND status NOT IN ('finalized','removed') AND verification=${JSON.stringify(resource.verification)}::text::jsonb`.execute(
      this.db,
    );
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

  /** A disposed recovery receipt remains historical custody, never current-executor work. */
  private async disposedCopyForWork(resource: ICloudResource, work: ScheduledPrivateWorkRecord['payload']) {
    const copy = resource.verification?.auditPrivateCopy;
    if (copy === undefined) return work.copyGeneration === null;
    if (
      !validPrivateCopy(copy) ||
      !copy.payload.disposed ||
      !copy.payload.settled ||
      copy.pending.length > 0 ||
      !copy.payload.identity ||
      !copy.seal ||
      copy.payload.generation !== work.copyGeneration ||
      copy.payload.ownerId !== resource.ownerId ||
      copy.payload.resourceId !== resource.id ||
      copy.payload.connectionId !== resource.connectionId ||
      copy.payload.auditRequestId !== resource.auditRequestId ||
      copy.payload.operationId !== work.operationId ||
      copy.payload.sourceAssetId !== resource.sourceAssetId ||
      copy.payload.stagingPath !== resource.stagingPath ||
      !Number.isSafeInteger(Number(resource.expectedSize)) ||
      copy.payload.reservedCopyBytes !== Number(resource.expectedSize)
    )
      return false;
    return (
      canonicalJson(await this.transport.decodeSession(privateCopyScope(copy.payload), copy.seal)) ===
      canonicalJson(copy.payload)
    );
  }

  async beginPrivateWork(input: ScheduledStagingInput) {
    const token = randomUUID();
    const created = await this.admitted(input, async (db, { guarded, resource }) => {
      if (!guarded.request.itemClaimId) {
        return false;
      }
      const existing = resource.verification?.auditOwnedWork;
      if (existing !== undefined && !validPrivateWork(existing)) return false;
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
      const renewed =
        validPrivateWork(existing) &&
        (existing.payload.resourceLeaseToken !== input.resource.leaseToken ||
          existing.payload.operationClaimToken !== input.authority.operationClaimToken ||
          existing.payload.itemClaimId !== guarded.request.itemClaimId);
      if (renewed && validPrivateWork(existing)) {
        const prior = existing.payload;
        if (
          !prior.settled ||
          prior.pending.length > 0 ||
          prior.ownerId !== input.ownerId ||
          prior.resourceId !== resource.id ||
          prior.auditRequestId !== input.authority.auditRequestId ||
          prior.operationId !== input.authority.operationId ||
          !(await this.disposedCopyForWork(resource, prior))
        )
          return false;
        const inputs = await this.authenticateValidationInputs(
          resource,
          undefined,
          input.authority.operationId ?? undefined,
        );
        if (inputs) {
          const predecessor = inputs.payload.current.payload;
          if (
            !validationInputsDisposed(inputs) ||
            predecessor.resourceLeaseToken !== prior.resourceLeaseToken ||
            predecessor.operationClaimToken !== prior.operationClaimToken ||
            predecessor.itemClaimId !== prior.itemClaimId
          )
            return false;
        }
      }
      if (
        validPrivateWork(existing) &&
        existing.payload.pending.length > 0 &&
        existing.payload.copyGeneration !== copyGeneration
      ) {
        return false;
      }
      const record: ScheduledPrivateWorkRecord =
        validPrivateWork(existing) && !renewed
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
      const copyPayload =
        validPrivateCopy(copy) && !copy.payload.disposed ? { ...copy.payload, settled: false } : undefined;
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
      if (validPrivateCopy(copy) && copy.payload.disposed) {
        try {
          if (!(await this.disposedCopyForWork(resource!, record.payload))) return;
        } catch {
          return;
        }
      } else if (validPrivateCopy(copy)) {
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
        if (await scheduledPrivatePathReferences(db, path, copy.resourceId, this.transport)) {
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
      if (!(await this.authenticateDisposedValidationInputs(db, resource))) return false;
      if (await scheduledPrivatePathReferences(db, stagingPath, resource.id, this.transport)) {
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
      const resource = (
        await sql<ICloudResource>`SELECT * FROM public.icloud_resource
        WHERE id=${input.resource.id}::uuid AND "ownerId"=${input.ownerId}::uuid FOR UPDATE`.execute(db)
      ).rows[0];
      if (!resource || !(await this.authenticateDisposedValidationInputs(db, resource))) return;
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
        verification=coalesce(verification,'{}'::jsonb)||jsonb_build_object('auditFreshDownload',${JSON.stringify(receipt)}::text::jsonb),
        sha1=${Buffer.from(payload.sha1, 'hex')},sha256=${Buffer.from(payload.sha256, 'hex')},"updatedAt"=clock_timestamp()
        WHERE id=${resource.id}::uuid AND ${scheduledAuditFinalFence(input.authority, guarded, input.resource)}
        RETURNING id`.execute(db);
      return rows.length === 1;
    });
  }
}
