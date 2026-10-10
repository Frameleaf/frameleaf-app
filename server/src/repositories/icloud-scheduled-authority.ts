import { Transaction, sql } from 'kysely';
import { createHash } from 'node:crypto';
import type { AuditAuthority, ICloudAuditRow } from 'src/repositories/icloud-audit.repository.js';
import { AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { ICloudConnection, ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { BUDDY_CAPTURE_LOCK, lockChecksum, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { hiddenContentAssetIdExists } from 'src/utils/database.js';
import { identityRoleOf } from 'src/utils/icloud-identity.js';
import { ICloudRecord, resourcesForICloudAsset } from 'src/utils/icloud-records.js';
import { isLocked } from 'src/utils/locked.js';
import { getPreferences } from 'src/utils/preferences.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type ManualAuditAuthority = AuditAuthority & { purpose?: 'manual-session' };
export type ScheduledAuditAuthority = AuditAuthority & { purpose: 'scheduled-weekly' };
export type AuditExecutionAuthority = ManualAuditAuthority | ScheduledAuditAuthority;
export type ScheduledAuditResourceAuthority = { id: string; leaseToken: string };
type ScheduledRequest = Extract<ICloudAuditRow, { purpose: 'scheduled-weekly' }>;
type FrozenBindings = {
  receipt: {
    id: string;
    sourceResourceId: string;
    identityId: string;
    assetId: string;
    role: string;
    snapshot: Record<string, unknown>;
    [key: string]: unknown;
  };
  source: { resource: ICloudResource; assetRecord: ICloudRecord; masterRecord: ICloudRecord };
  identity: Record<string, unknown>;
  original: {
    id: string;
    updateId: string;
    originalPath: string;
    checksumHex: string;
    checksumAlgorithm: string | null;
    physicalId: string | null;
    [key: string]: unknown;
  };
};
type Member = {
  ordinal: string;
  auditRequestId: string | null;
  selected: boolean;
  outcome: string;
  technicalEligibility: string;
  expectedSha256: Buffer;
  grantId: string;
  grantGeneration: number;
  bindings: FrozenBindings;
};
type Grant = {
  id: string;
  generation: number;
  enabled: boolean;
  includeProtected: boolean;
  configFingerprint: string;
  privacyFingerprint: string;
  pinBinding: string | null;
};
export type GuardedScheduledAudit = {
  request: ScheduledRequest;
  source: ICloudResource;
  connection: ICloudConnection;
  private: boolean;
  grant: Grant;
  auditIds: string[];
  bindings: FrozenBindings;
};
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Metadata, then all managed paths, then asset rows: the latter order also governs storage moves. */
export async function lockScheduledAuditAssets(
  db: Transaction<DB>,
  originalId: string,
  candidateIds: string[] = [],
  managedPaths: string[] = [],
) {
  const group = async () =>
    (
      await sql<{ id: string }>`SELECT a.id FROM public.asset a
    WHERE a.id=${originalId}::uuid OR a."livePhotoVideoId"=${originalId}::uuid
      OR a.id IN (SELECT "livePhotoVideoId" FROM public.asset WHERE id=${originalId}::uuid)
      OR a."stackId" IN (SELECT "stackId" FROM public.asset WHERE id=${originalId}::uuid)
    ORDER BY a.id`.execute(db)
    ).rows.map(({ id }) => id);
  const related = await group();
  const ids = [...new Set([...related, originalId, ...candidateIds].map((id) => id.toLowerCase()))].sort();
  for (const id of ids) {
    await sql`SELECT pg_advisory_xact_lock(-1,hashtext(${id})::int)`.execute(db);
  }
  // A relationship discovered after metadata locking cannot cause a late metadata lock under an asset row.
  if (canonicalJson(await group()) !== canonicalJson(related)) {
    return false;
  }
  const { rows: hints } = await sql<{ id: string; originalPath: string }>`SELECT id,"originalPath"
    FROM public.asset WHERE id=ANY(${ids}::uuid[]) ORDER BY id`.execute(db);
  for (const path of [...new Set([...managedPaths, ...hints.map(({ originalPath }) => originalPath)])].sort()) {
    await lockFilePath(db, path);
  }
  const { rows: locked } = await sql<{ id: string; originalPath: string }>`SELECT id,"originalPath"
    FROM public.asset WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`.execute(db);
  // A move may finish while we wait for its old path. Never acquire its new path under an asset row lock.
  return canonicalJson(locked) === canonicalJson(hints) && canonicalJson(await group()) === canonicalJson(related);
}

/**
 * Repository admission only, not provider/byte authority or a proof writer. Always a real transaction;
 * no AuthDto, user session, PIN-session expiry, or operation snapshot can select this authority branch.
 */
export async function guardScheduledAudit(
  db: Transaction<DB>,
  authority: ScheduledAuditAuthority,
  ownerId: string,
  options: {
    requireClaim?: boolean;
    resource?: ScheduledAuditResourceAuthority;
    candidateAssetIds?: string[];
    managedPaths?: string[];
    recoveryChecksum?: Buffer;
  } = {},
): Promise<GuardedScheduledAudit | undefined> {
  if (!db.isTransaction || authority.purpose !== 'scheduled-weekly') {
    return;
  }
  const {
    rows: [hint],
  } = await sql<ScheduledRequest>`SELECT * FROM public.icloud_identity_audit
    WHERE id=${authority.auditRequestId}::uuid AND "ownerId"=${ownerId}::uuid AND purpose='scheduled-weekly'`.execute(
    db,
  );
  if (
    !hint ||
    hint.sessionId !== null ||
    hint.operationId !== authority.operationId ||
    !hint.grantId ||
    !hint.cohortId ||
    !['queued', 'running'].includes(hint.result)
  ) {
    return;
  }

  await sql`SELECT pg_advisory_xact_lock_shared(${BUDDY_CAPTURE_LOCK}::bigint)`.execute(db);
  const digests = new Map(
    [hint.expectedSha256, ...(options.recoveryChecksum ? [options.recoveryChecksum] : [])].map((digest) => [
      digest.toString('hex'),
      digest,
    ]),
  )
    .values()
    .toArray()
    .sort(Buffer.compare);
  for (const digest of digests) {
    await lockChecksum(db, digest);
  }
  const contentKeys = digests
    .map((digest) =>
      createHash('sha1')
        .update(`icloud-content:${ownerId}:${digest.toString('hex')}`)
        .digest()
        .readBigInt64BE(0),
    )
    .sort((a, b) => Number(a - b));
  for (const key of contentKeys) {
    await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(db);
  }
  // Content keys are already held; read owner authority under the same owner row lock.
  const owner = await db
    .selectFrom('user')
    .select(['pinCode', 'deletedAt'])
    .where('id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!owner || owner.deletedAt) {
    return;
  }
  // A missing preference row is materialized only as the ordinary empty preference, never as consent.
  await sql`INSERT INTO public.user_metadata ("userId",key,value) VALUES
    (${ownerId}::uuid,${UserMetadataKey.Preferences},'{}'::jsonb) ON CONFLICT ("userId",key) DO NOTHING`.execute(db);
  const metadata = await db
    .selectFrom('user_metadata')
    .selectAll()
    .where('userId', '=', ownerId)
    .where('key', '=', UserMetadataKey.Preferences)
    .forShare()
    .execute();
  const {
    rows: [connection],
  } = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
    WHERE id=${hint.connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected'
      AND "encryptedSession" IS NOT NULL AND "lastError" IS DISTINCT FROM 'owner_removed' FOR SHARE`.execute(db);
  if (!connection) {
    return;
  }
  const {
    rows: [grant],
  } = await sql<Grant>`SELECT * FROM public.icloud_weekly_grant
    WHERE id=${hint.grantId}::uuid AND "ownerId"=${ownerId}::uuid AND "connectionId"=${connection.id}::uuid FOR SHARE`.execute(
    db,
  );
  const privacy = (metadata[0]?.value as { privacy?: unknown } | undefined)?.privacy ?? {};
  if (
    !grant?.enabled ||
    grant.generation !== hint.grantGeneration ||
    grant.configFingerprint !== fingerprint(connection.config) ||
    grant.privacyFingerprint !== fingerprint(privacy) ||
    (grant.includeProtected && (!owner.pinCode || grant.pinBinding !== fingerprint(['weekly-pin-v1', owner.pinCode])))
  ) {
    return;
  }
  const {
    rows: [cohort],
  } = await sql<{ id: string }>`SELECT id FROM public.icloud_weekly_cohort
    WHERE id=${hint.cohortId}::uuid AND "ownerId"=${ownerId}::uuid AND "connectionId"=${connection.id}::uuid
      AND "grantId"=${grant.id}::uuid AND "grantGeneration"=${grant.generation}
      AND "configFingerprint"=${grant.configFingerprint} AND "privacyFingerprint"=${grant.privacyFingerprint}
      AND status='running' FOR UPDATE`.execute(db);
  if (!cohort) {
    return;
  }
  const { rows: members } = await sql<Member>`SELECT m.*,m.ordinal::text AS ordinal FROM public.icloud_weekly_member m
    WHERE "cohortId"=${cohort.id}::uuid AND "ownerId"=${ownerId}::uuid AND "connectionId"=${connection.id}::uuid
      AND selected AND "batchOrdinal"=${hint.batchOrdinal} ORDER BY m.ordinal FOR UPDATE`.execute(db);
  const member = members.find(({ ordinal }) => ordinal === String(hint.memberOrdinal));
  const auditIds = members.flatMap(({ auditRequestId }) => (auditRequestId ? [auditRequestId] : []));
  if (
    !member ||
    member.technicalEligibility !== 'current' ||
    member.outcome !== 'pending' ||
    member.auditRequestId !== hint.id ||
    members.length > 100 ||
    auditIds.length === 0 ||
    new Set(auditIds).size !== auditIds.length ||
    members.some(
      (row) =>
        row.grantId !== grant.id ||
        row.grantGeneration !== grant.generation ||
        (!row.auditRequestId && row.outcome === 'pending'),
    )
  ) {
    return;
  }
  const {
    rows: [operation],
  } = await sql<{ snapshot: Record<string, unknown>; totalUnits: number }>`SELECT snapshot,"totalUnits"
    FROM public.media_operation WHERE id=${authority.operationId}::uuid AND "ownerId"=${ownerId}::uuid AND kind='icloud_sync'
      AND "claimToken"=${authority.operationClaimToken}::uuid AND "claimExpiresAt">clock_timestamp()
      AND status IN ('preparing','rendering','validating') AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL
      FOR UPDATE`.execute(db);
  if (
    !operation ||
    operation.snapshot.task !== 'identity-audit-weekly' ||
    operation.snapshot.purpose !== 'scheduled-weekly' ||
    operation.snapshot.connectionId !== connection.id ||
    operation.snapshot.cohortId !== cohort.id ||
    operation.snapshot.grantId !== grant.id ||
    operation.snapshot.grantGeneration !== grant.generation ||
    operation.snapshot.batchOrdinal !== hint.batchOrdinal ||
    Number(operation.totalUnits) !== auditIds.length ||
    canonicalJson(operation.snapshot.auditIds) !== canonicalJson(auditIds)
  ) {
    return;
  }
  const { rows: batch } = await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit
    WHERE id=ANY(${auditIds}::uuid[]) ORDER BY id FOR SHARE`.execute(db);
  if (
    batch.length !== auditIds.length ||
    batch.some(
      (audit) =>
        audit.purpose !== 'scheduled-weekly' ||
        audit.sessionId !== null ||
        audit.ownerId !== ownerId ||
        audit.connectionId !== connection.id ||
        audit.operationId !== authority.operationId ||
        audit.cohortId !== cohort.id ||
        audit.grantId !== grant.id ||
        audit.grantGeneration !== grant.generation ||
        audit.batchOrdinal !== hint.batchOrdinal ||
        members.find((m) => m.ordinal === String(audit.memberOrdinal))?.auditRequestId !== audit.id,
    )
  ) {
    return;
  }
  const {
    rows: [request],
  } = await sql<ScheduledRequest>`SELECT * FROM public.icloud_identity_audit
    WHERE id=${hint.id}::uuid AND purpose='scheduled-weekly' AND result IN ('queued','running') FOR UPDATE`.execute(db);
  const frozen = member.bindings;
  if (
    !request ||
    request.operationId !== authority.operationId ||
    request.identityId !== frozen.receipt.identityId ||
    request.originalAssetId !== frozen.original.id ||
    request.originalAssetId !== frozen.receipt.assetId ||
    request.sourceResourceId !== frozen.receipt.sourceResourceId ||
    !request.expectedSha256.equals(member.expectedSha256) ||
    canonicalJson(request.snapshot) !==
      canonicalJson({
        ...frozen.receipt.snapshot,
        updateId: frozen.original.updateId,
        config: canonicalJson(connection.config),
      })
  ) {
    return;
  }
  const {
    rows: [receipt],
  } = await sql<{ row: unknown }>`SELECT to_jsonb(r) AS row FROM public.icloud_identity_reuse r
    WHERE id=${frozen.receipt.id}::uuid AND basis='exact-identity' AND "ownerId"=${ownerId}::uuid
      AND "connectionId"=${connection.id}::uuid AND "sourceResourceId"=${request.sourceResourceId}::uuid
      AND "identityId"=${request.identityId}::uuid AND "assetId"=${request.originalAssetId}::uuid
      AND "expectedSha256"=${request.expectedSha256} FOR SHARE`.execute(db);
  if (!receipt || canonicalJson(receipt.row) !== canonicalJson(frozen.receipt)) {
    return;
  }
  const {
    rows: [source],
  } = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
    FROM public.icloud_resource WHERE id=${request.sourceResourceId}::uuid AND "ownerId"=${ownerId}::uuid
      AND "connectionId"=${connection.id}::uuid AND "auditRequestId" IS NULL
      AND "assetId"=${request.originalAssetId}::uuid AND sha256=${request.expectedSha256}
      AND path=${frozen.original.originalPath} AND status IN ('committed','finalized','reused') FOR SHARE`.execute(db);
  const expected = frozen.source.resource;
  if (
    !source ||
    canonicalJson(source.library) !== canonicalJson(expected.library) ||
    source.libraryKey !== expected.libraryKey ||
    source.sourceAssetId !== expected.sourceAssetId ||
    source.recordId !== expected.recordId ||
    source.resourceKey !== expected.resourceKey ||
    source.role !== expected.role ||
    source.fingerprint !== expected.fingerprint ||
    source.expectedSize !== expected.expectedSize ||
    identityRoleOf[source.role] !== frozen.receipt.role ||
    (connection.config.libraries.length > 0 && !connection.config.libraries.includes(source.libraryKey))
  ) {
    return;
  }
  const { rows: records } = await sql<{
    recordName: string;
    recordType: string;
    recordChangeTag: string;
    fields: Record<string, unknown>;
  }>`
    SELECT "recordId" AS "recordName","recordType",revision AS "recordChangeTag",fields FROM public.icloud_record
    WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${source.libraryKey} AND NOT deleted
      AND "recordId" IN (${source.sourceAssetId},${String(source.source.sourceMasterId ?? '')}) ORDER BY "recordId" FOR SHARE`.execute(
    db,
  );
  const assetRecord = records.find((row) => row.recordName === source.sourceAssetId);
  const masterRecord = records.find((row) => row.recordName === source.source.sourceMasterId);
  if (
    !assetRecord ||
    !masterRecord ||
    canonicalJson(assetRecord) !== canonicalJson(frozen.source.assetRecord) ||
    canonicalJson(masterRecord) !== canonicalJson(frozen.source.masterRecord)
  ) {
    return;
  }
  const descriptor = resourcesForICloudAsset(assetRecord, masterRecord).find(
    (row) => row.recordId === source.recordId && row.resourceKey === source.resourceKey && row.role === source.role,
  );
  if (
    !descriptor ||
    descriptor.fingerprint !== source.fingerprint ||
    descriptor.expectedSize !== source.expectedSize ||
    descriptor.source.type !== expected.source.type ||
    descriptor.source.isHidden !== expected.source.isHidden ||
    source.source.isHidden !== expected.source.isHidden ||
    canonicalJson(descriptor.source.resource) !== canonicalJson(expected.source.resource) ||
    canonicalJson(source.source.resource) !== canonicalJson(expected.source.resource) ||
    (!connection.config.includeHidden && descriptor.source.isHidden === true)
  ) {
    return;
  }
  if (
    connection.config.albums.length > 0 &&
    (
      await sql`SELECT 1 FROM public.icloud_membership
    WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${source.libraryKey} AND "sourceAssetId"=${source.sourceAssetId}
      AND "sourcePresent" AND ("libraryKey"||':'||"sourceAlbumId")=ANY(${connection.config.albums}::text[]) FOR SHARE`.execute(
        db,
      )
    ).rows.length === 0
  ) {
    return;
  }
  if (
    options.requireClaim !== false &&
    (!request.itemClaimId ||
      (
        await sql`SELECT id FROM public.icloud_claim
    WHERE id=${request.itemClaimId}::uuid AND "ownerId"=${ownerId}::uuid AND "cplAssetRecordName"=upper(${source.sourceAssetId})
      AND holder=${`icloud-sync:audit:${authority.operationId}`} AND "expiresAt">clock_timestamp() FOR SHARE`.execute(
          db,
        )
      ).rows.length !== 1)
  ) {
    return;
  }
  const managedPaths = [...(options.managedPaths ?? [])];
  const candidateIds = [...(options.candidateAssetIds ?? [])];
  if (options.resource) {
    // Freeze staging/reservation paths before asset locks so repeated guards never discover them late.
    const {
      rows: [resource],
    } = await sql<Pick<ICloudResource, 'stagingPath' | 'promotedPath' | 'path' | 'expectedTarget'>>`SELECT
      "stagingPath","promotedPath",path,"expectedTarget" FROM public.icloud_resource WHERE id=${options.resource.id}::uuid
      AND "ownerId"=${ownerId}::uuid AND "connectionId"=${connection.id}::uuid AND "auditRequestId"=${request.id}::uuid
      AND "leaseToken"=${options.resource.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()
      AND library=${JSON.stringify(frozen.source.resource.library)}::text::jsonb AND "libraryKey"=${source.libraryKey} AND "sourceAssetId"=${source.sourceAssetId}
      AND "recordId"=${source.recordId} AND "resourceKey"=${source.resourceKey} AND role=${source.role}
      AND fingerprint=${source.fingerprint} AND "expectedSize"=${source.expectedSize} AND source=${JSON.stringify(source.source)}::text::jsonb
      AND status NOT IN ('removed','finalized') FOR UPDATE`.execute(db);
    if (!resource) {
      return;
    }
    managedPaths.push(
      ...[resource.stagingPath, resource.promotedPath, resource.path, resource.expectedTarget?.originalPath].filter(
        (path): path is string => typeof path === 'string',
      ),
    );
    // Recovery writers include any prior reservation target in their initial metadata/asset lock set.
    if (options.candidateAssetIds && typeof resource.expectedTarget?.assetId === 'string') {
      candidateIds.push(resource.expectedTarget.assetId);
    }
  }
  if (!(await lockScheduledAuditAssets(db, request.originalAssetId, candidateIds, managedPaths))) {
    return;
  }
  const structural = new IntegrityRepository(db)
    .getOwnedOriginalSafetyQuery(ownerId, [request.expectedSha256.toString('hex')])
    .where('asset.id', '=', request.originalAssetId)
    .where('asset.originalPath', '=', frozen.original.originalPath)
    .where('asset.updateId', '=', frozen.original.updateId)
    .where('asset.checksum', '=', Buffer.from(frozen.original.checksumHex, 'hex'))
    .where(
      sql<boolean>`asset."checksumAlgorithm"::text IS NOT DISTINCT FROM ${frozen.original.checksumAlgorithm}::text`,
    )
    .where('asset.isExternal', '=', false)
    .where('asset.isOffline', '=', false)
    .forShare('asset');
  if (!(await structural.executeTakeFirst())) {
    return;
  }
  const {
    rows: [identity],
  } = await sql<{ row: Record<string, unknown> }>`SELECT to_jsonb(i) AS row
    FROM public.icloud_source_identity i WHERE id=${request.identityId}::uuid AND "ownerId"=${ownerId}::uuid
      AND "assetId"=${request.originalAssetId}::uuid AND sha256=${request.expectedSha256} AND "editVersion"=''
      AND "cplAssetRecordName"=upper(${source.sourceAssetId}) AND role=${identityRoleOf[source.role]}
      AND "cplMasterRecordName"=${String(source.source.sourceMasterId ?? '')} FOR SHARE`.execute(db);
  if (
    !identity ||
    identity.row.cloudIdentifier !== frozen.identity.cloudIdentifier ||
    identity.row.deliveredBy !== frozen.identity.deliveredBy ||
    identity.row.libraryKey !== frozen.identity.libraryKey
  ) {
    return;
  }
  // The asset row is already locked; retain the canonical file row through publication too.
  await sql`SELECT id FROM public.physical_file
    WHERE id=(SELECT "physicalOriginalFileId" FROM public.asset WHERE id=${request.originalAssetId}::uuid)
    FOR SHARE`.execute(db);
  const {
    rows: [physical],
  } = await sql<{ physicalId: string | null; physicalPath: string | null }>`
    SELECT a."physicalOriginalFileId" AS "physicalId",p.path AS "physicalPath"
    FROM public.asset a LEFT JOIN public.physical_file p ON p.id=a."physicalOriginalFileId" WHERE a.id=${request.originalAssetId}::uuid`.execute(
    db,
  );
  if (
    !physical ||
    physical.physicalId !== frozen.original.physicalId ||
    (physical.physicalId !== null && physical.physicalPath !== frozen.original.originalPath)
  ) {
    return;
  }
  const suppression = getPreferences(metadata).privacy.suppression;
  const {
    rows: [classification],
  } = await sql<{ protected: boolean }>`SELECT (
    ${isLocked('a')} OR EXISTS (SELECT 1 FROM public.asset still JOIN public.asset_lock al ON al."assetId"=still.id
      WHERE still."livePhotoVideoId"=a.id AND a.visibility=${AssetVisibility.Hidden})
    OR (a.visibility=${AssetVisibility.Hidden} AND ${source.role !== 'motion'})
    OR ${hiddenContentAssetIdExists(sql.ref('a.id'), { userId: ownerId, includeNsfw: true, ...suppression })}) AS protected
    FROM public.asset a WHERE a.id=${request.originalAssetId}::uuid`.execute(db);
  if (!classification || (classification.protected && !grant.includeProtected)) {
    return;
  }
  // The resource is locked, but its lease can expire while a managed move holds a path.
  if (
    options.resource &&
    (
      await sql`SELECT id FROM public.icloud_resource WHERE id=${options.resource.id}::uuid
        AND "leaseToken"=${options.resource.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()`.execute(db)
    ).rows.length !== 1
  ) {
    return;
  }
  return {
    request,
    source,
    connection,
    grant,
    auditIds,
    bindings: frozen,
    private: classification.protected || descriptor.source.isHidden === true,
  };
}

/** Final SQL prerequisite only. No fresh-stream evidence means no scheduled proof writer exists yet. */
export function scheduledAuditFinalFence(
  authority: ScheduledAuditAuthority,
  guarded: GuardedScheduledAudit,
  resource: ScheduledAuditResourceAuthority,
) {
  const request = guarded.request;
  return sql<boolean>`EXISTS (
    SELECT 1 FROM public.icloud_identity_audit q
    JOIN public.icloud_weekly_member m ON m."cohortId"=q."cohortId" AND m.ordinal=q."memberOrdinal" AND m."auditRequestId"=q.id
    JOIN public.icloud_weekly_cohort c ON c.id=m."cohortId"
    JOIN public.icloud_weekly_grant g ON g.id=c."grantId" AND g."ownerId"=c."ownerId" AND g."connectionId"=c."connectionId"
    JOIN public.icloud_connection connection ON connection.id=c."connectionId" AND connection."ownerId"=c."ownerId"
    JOIN public.user owner ON owner.id=c."ownerId" AND owner."deletedAt" IS NULL
    JOIN public.media_operation operation ON operation.id=q."operationId" AND operation."ownerId"=q."ownerId"
    JOIN public.icloud_claim claim ON claim.id=q."itemClaimId" AND claim."ownerId"=q."ownerId"
    JOIN public.icloud_resource r ON r.id=${resource.id}::uuid AND r."auditRequestId"=q.id AND r."ownerId"=q."ownerId"
    JOIN public.icloud_source_identity i ON i.id=q."identityId" AND i."ownerId"=q."ownerId" AND i."assetId"=q."originalAssetId"
    JOIN public.asset original ON original.id=q."originalAssetId" AND original."ownerId"=q."ownerId"
    LEFT JOIN public.physical_file physical ON physical.id=original."physicalOriginalFileId"
    WHERE q.id=${authority.auditRequestId}::uuid AND q."ownerId"=${request.ownerId}::uuid
      AND q.purpose='scheduled-weekly' AND q."sessionId" IS NULL AND q.result IN ('queued','running')
      AND q."operationId"=${authority.operationId}::uuid AND q."cohortId"=${request.cohortId}::uuid
      AND q."memberOrdinal"=${request.memberOrdinal} AND q."batchOrdinal"=${request.batchOrdinal}
      AND q."identityId"=${request.identityId}::uuid AND q."originalAssetId"=${request.originalAssetId}::uuid
      AND q."sourceResourceId"=${request.sourceResourceId}::uuid AND q."expectedSha256"=${request.expectedSha256}
      AND q."itemClaimId"=${request.itemClaimId}::uuid
      AND q.snapshot=${JSON.stringify(request.snapshot)}::text::jsonb AND m.bindings=${JSON.stringify(guarded.bindings)}::text::jsonb
      AND q."grantId"=g.id AND q."grantGeneration"=g.generation
      AND m.selected AND m.outcome='pending' AND m."technicalEligibility"='current'
      AND m."ownerId"=q."ownerId" AND m."connectionId"=q."connectionId" AND m."batchOrdinal"=q."batchOrdinal"
      AND m."grantId"=g.id AND m."grantGeneration"=g.generation AND m."expectedSha256"=q."expectedSha256"
      AND c.status='running' AND c."ownerId"=q."ownerId" AND c."connectionId"=q."connectionId"
      AND g.enabled AND g.generation=${guarded.grant.generation} AND g.id=${guarded.grant.id}::uuid
      AND c."grantGeneration"=g.generation AND c."configFingerprint"=g."configFingerprint"
      AND c."privacyFingerprint"=g."privacyFingerprint"
      AND g."configFingerprint"=${guarded.grant.configFingerprint} AND g."privacyFingerprint"=${guarded.grant.privacyFingerprint}
      AND g."includeProtected"=${guarded.grant.includeProtected} AND g."pinBinding" IS NOT DISTINCT FROM ${guarded.grant.pinBinding}
      AND connection.config=${JSON.stringify(guarded.connection.config)}::text::jsonb
      AND EXISTS (SELECT 1 FROM public.icloud_identity_reuse receipt
        WHERE receipt.id=${guarded.bindings.receipt.id}::uuid AND to_jsonb(receipt)=${JSON.stringify(guarded.bindings.receipt)}::text::jsonb)
      AND EXISTS (SELECT 1 FROM public.icloud_resource source
        JOIN public.icloud_record ar ON ar."connectionId"=source."connectionId" AND ar."libraryKey"=source."libraryKey"
          AND ar."recordId"=source."sourceAssetId" AND NOT ar.deleted
        JOIN public.icloud_record mr ON mr."connectionId"=source."connectionId" AND mr."libraryKey"=source."libraryKey"
          AND mr."recordId"=${String(guarded.source.source.sourceMasterId ?? '')} AND NOT mr.deleted
        WHERE source.id=q."sourceResourceId" AND source."ownerId"=q."ownerId" AND source."connectionId"=q."connectionId"
          AND source."auditRequestId" IS NULL AND source."assetId"=q."originalAssetId" AND source.sha256=q."expectedSha256"
          AND source.path=${guarded.bindings.original.originalPath} AND source.status IN ('committed','finalized','reused')
          AND source.library=${JSON.stringify(guarded.bindings.source.resource.library)}::text::jsonb AND source."libraryKey"=${guarded.source.libraryKey} AND source."sourceAssetId"=${guarded.source.sourceAssetId}
          AND source."recordId"=${guarded.source.recordId} AND source."resourceKey"=${guarded.source.resourceKey}
          AND source.role=${guarded.source.role} AND source.fingerprint=${guarded.source.fingerprint}
          AND source."expectedSize"=${guarded.source.expectedSize} AND source.source=${JSON.stringify(guarded.source.source)}::text::jsonb
          AND jsonb_build_object('recordName',ar."recordId",'recordType',ar."recordType",'recordChangeTag',ar.revision,'fields',ar.fields)
            =${JSON.stringify(guarded.bindings.source.assetRecord)}::text::jsonb
          AND jsonb_build_object('recordName',mr."recordId",'recordType',mr."recordType",'recordChangeTag',mr.revision,'fields',mr.fields)
            =${JSON.stringify(guarded.bindings.source.masterRecord)}::text::jsonb)
      AND connection.state='connected' AND connection."encryptedSession" IS NOT NULL AND connection."lastError" IS DISTINCT FROM 'owner_removed'
      AND operation.kind='icloud_sync' AND operation.snapshot->>'task'='identity-audit-weekly'
      AND operation.snapshot->>'purpose'='scheduled-weekly' AND operation.snapshot->>'cohortId'=c.id::text
      AND operation.snapshot->>'connectionId'=connection.id::text AND operation.snapshot->>'grantId'=g.id::text
      AND operation.snapshot->>'grantGeneration'=g.generation::text AND operation.snapshot->>'batchOrdinal'=q."batchOrdinal"::text
      AND operation.snapshot->'auditIds'=${JSON.stringify(guarded.auditIds)}::text::jsonb
      AND operation.snapshot->'auditIds'=(SELECT jsonb_agg(b."auditRequestId" ORDER BY b.ordinal)
        FROM public.icloud_weekly_member b WHERE b."cohortId"=c.id AND b.selected
          AND b."batchOrdinal"=q."batchOrdinal" AND b."auditRequestId" IS NOT NULL)
      AND jsonb_array_length(CASE WHEN jsonb_typeof(operation.snapshot->'auditIds')='array'
        THEN operation.snapshot->'auditIds' ELSE '[]'::jsonb END) BETWEEN 1 AND 100
      AND operation."totalUnits"=jsonb_array_length(CASE WHEN jsonb_typeof(operation.snapshot->'auditIds')='array'
        THEN operation.snapshot->'auditIds' ELSE '[]'::jsonb END)
      AND NOT EXISTS (SELECT 1 FROM public.icloud_weekly_member b
        LEFT JOIN public.icloud_identity_audit audit ON audit.id=b."auditRequestId"
        WHERE b."cohortId"=c.id AND b.selected AND b."batchOrdinal"=q."batchOrdinal" AND (
          (b.outcome='pending' AND b."auditRequestId" IS NULL) OR b."ownerId"<>q."ownerId"
          OR b."connectionId"<>q."connectionId" OR b."grantId" IS DISTINCT FROM g.id
          OR b."grantGeneration" IS DISTINCT FROM g.generation OR (b."auditRequestId" IS NOT NULL AND (
            audit.id IS NULL OR audit.purpose<>'scheduled-weekly' OR audit."sessionId" IS NOT NULL
            OR audit."operationId"<>operation.id OR audit."ownerId"<>q."ownerId" OR audit."connectionId"<>q."connectionId"
            OR audit."cohortId"<>c.id OR audit."memberOrdinal"<>b.ordinal OR audit."batchOrdinal"<>q."batchOrdinal"
            OR audit."grantId" IS DISTINCT FROM g.id OR audit."grantGeneration" IS DISTINCT FROM g.generation))))
      AND operation."claimToken"=${authority.operationClaimToken}::uuid AND operation."claimExpiresAt">clock_timestamp()
      AND operation.status IN ('preparing','rendering','validating') AND operation."cancelRequestedAt" IS NULL AND operation."pauseRequestedAt" IS NULL
      AND claim.holder=${`icloud-sync:audit:${authority.operationId}`} AND claim."expiresAt">clock_timestamp()
      AND claim."cplAssetRecordName"=upper(${guarded.source.sourceAssetId})
      AND r."connectionId"=q."connectionId" AND r."leaseToken"=${resource.leaseToken}::uuid AND r."leaseExpiresAt">clock_timestamp()
      AND r.library=${JSON.stringify(guarded.bindings.source.resource.library)}::text::jsonb AND r."libraryKey"=${guarded.source.libraryKey} AND r."sourceAssetId"=${guarded.source.sourceAssetId}
      AND r."recordId"=${guarded.source.recordId} AND r."resourceKey"=${guarded.source.resourceKey} AND r.role=${guarded.source.role}
      AND r.fingerprint=${guarded.source.fingerprint} AND r."expectedSize"=${guarded.source.expectedSize}
      AND r.source=${JSON.stringify(guarded.source.source)}::text::jsonb
      AND r.status NOT IN ('removed','finalized') AND i.sha256=q."expectedSha256" AND i.sha256=${request.expectedSha256}
      AND i."editVersion"='' AND i."cplAssetRecordName"=upper(${guarded.source.sourceAssetId})
      AND i."cplMasterRecordName"=${String(guarded.source.source.sourceMasterId ?? '')}
      AND i.role=${identityRoleOf[guarded.source.role]} AND i."cloudIdentifier"=${String(guarded.bindings.identity.cloudIdentifier)}
      AND original."deletedAt" IS NULL AND original.status='active' AND NOT original."isExternal" AND NOT original."isOffline"
      AND (original."libraryId" IS NULL OR EXISTS (SELECT 1 FROM public.library library
        WHERE library.id=original."libraryId" AND library."deletedAt" IS NULL))
      AND original."originalPath"=${guarded.bindings.original.originalPath} AND original."updateId"=${guarded.bindings.original.updateId}::uuid
      AND original.checksum=${Buffer.from(guarded.bindings.original.checksumHex, 'hex')}
      AND original."checksumAlgorithm"::text IS NOT DISTINCT FROM ${guarded.bindings.original.checksumAlgorithm}::text
      AND original."physicalOriginalFileId" IS NOT DISTINCT FROM ${guarded.bindings.original.physicalId}::uuid
      AND (original."physicalOriginalFileId" IS NULL OR physical.path=original."originalPath")
  )`;
}
