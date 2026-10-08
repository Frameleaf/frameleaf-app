import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, randomUUID } from 'node:crypto';
import type { VerifiedMedia } from 'src/repositories/media-recovery.repository.js';
import type { MediaIntegrityResult } from 'src/services/media-integrity.service.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudVerifyDto, ICloudVerifyResponseDto } from 'src/dtos/icloud-identity.dto.js';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus, UserMetadataKey } from 'src/enum.js';
import { AuditExecutionAuthority, guardScheduledAudit } from 'src/repositories/icloud-scheduled-authority.js';
import { ICloudConnection, ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { readAliasedEnv } from 'src/utils/env-aliases.js';
import { identityRoleOf, parseCloudIdentifier } from 'src/utils/icloud-identity.js';
import { resourcesForICloudAsset } from 'src/utils/icloud-records.js';
import { getPreferences } from 'src/utils/preferences.js';
import { canonicalJson } from 'src/utils/studio-project.js';

export type AuditAuthority = {
  auditRequestId: string;
  operationId: string;
  operationClaimToken: string;
};
/** Private ownership discriminator; never a replacement for any operation/session/publication fence. */
export function manualAuditClaimHolder(
  ownerId: string,
  authority: Pick<AuditAuthority, 'operationId' | 'operationClaimToken'>,
) {
  const digest = createHash('sha256')
    .update('frameleaf:manual-identity-audit:item-claim:v1\0')
    .update(canonicalJson([ownerId, authority.operationId, authority.operationClaimToken]))
    .digest('hex');
  return `icloud-sync:audit:${authority.operationId}:v1:${digest}`;
}
type AuditSnapshot = {
  sourceRevision: string;
  masterRevision: string;
  config: string;
  originalPath: string;
  checksum: string;
  algorithm: string | null;
  updateId: string;
};
type AuditRowFields = {
  id: string;
  ownerId: string;
  connectionId: string;
  operationId: string;
  identityId: string;
  originalAssetId: string;
  sourceResourceId: string;
  expectedSha256: Buffer;
  snapshot: AuditSnapshot;
  itemClaimId: string | null;
  result: string;
  resultAssetId: string | null;
};
export type ICloudAuditRow = AuditRowFields &
  (
    | {
        purpose: 'manual-session';
        sessionId: string;
        grantId: null;
        grantGeneration: null;
        cohortId: null;
        memberOrdinal: null;
        batchOrdinal: null;
      }
    | {
        purpose: 'scheduled-weekly';
        sessionId: null;
        grantId: string;
        grantGeneration: number;
        cohortId: string;
        memberOrdinal: number;
        batchOrdinal: number;
      }
  );
type Outcome = {
  id: string;
  state: 'queued' | 'unavailable';
};
class Replay extends Error {
  constructor(readonly response: ICloudVerifyResponseDto) {
    super('audit_replay');
  }
}
/** The recovery prefix is shared by match publication, audit allocation and housekeeping. */
export async function lockAuditOwner(db: Transaction<DB>, ownerId: string, digest?: Buffer, receiptCleanup = false) {
  if (digest) {
    const key = createHash('sha1')
      .update(`icloud-content:${ownerId}:${digest.toString('hex')}`)
      .digest()
      .readBigInt64BE(0);
    await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(db);
  }
  let owner = db.selectFrom('user').select('id').where('id', '=', ownerId).forUpdate();
  if (!receiptCleanup) {
    owner = owner.where('deletedAt', 'is', null);
  }
  const row = await owner.executeTakeFirst();
  if (!row && !receiptCleanup) {
    throw new Error('audit_owner_unavailable');
  }
}

/** Persisted purpose selects admission. Scheduled admission is transaction-only and never executes bytes. */
export async function guardAuditAuthority(
  db: Kysely<DB>,
  authority: AuditExecutionAuthority,
  ownerId: string,
  requireClaim = true,
  resource?: { id: string; leaseToken: string },
) {
  const {
    rows: [row],
  } = await sql<{ purpose: string }>`SELECT purpose FROM public.icloud_identity_audit
    WHERE id=${authority.auditRequestId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(db);
  if (row?.purpose === 'scheduled-weekly') {
    if (authority.purpose !== 'scheduled-weekly' || !db.isTransaction) {
      return;
    }
    return guardScheduledAudit(db as Transaction<DB>, authority, ownerId, { requireClaim, resource });
  }
  if (row?.purpose === 'manual-session' && authority.purpose !== 'scheduled-weekly') {
    return guardAudit(db, authority, ownerId, db.isTransaction, requireClaim);
  }
}

/** No credentials or serialized elevation survive a worker restart. */
export async function currentAuth(
  db: Kysely<DB>,
  ownerId: string,
  sessionId: string,
  lock: boolean,
): Promise<AuthDto | undefined> {
  let query = db
    .selectFrom('session')
    .selectAll()
    .where('id', '=', sessionId)
    .where('userId', '=', ownerId)
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', sql<Date>`clock_timestamp()`)]));
  if (lock) {
    query = query.forShare();
  }
  const session = await query.executeTakeFirst();
  const user = await db
    .selectFrom('user')
    .selectAll()
    .where('id', '=', ownerId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!session || !user) {
    return;
  }
  let preferences = db
    .selectFrom('user_metadata')
    .selectAll()
    .where('userId', '=', ownerId)
    .where('key', '=', UserMetadataKey.Preferences);
  if (lock) {
    preferences = preferences.forShare();
  }
  const metadata = await preferences.execute();
  const suppression = getPreferences(metadata).privacy.suppression;
  // Preferences/asset locks can wait after the first session read. Database time, not a
  // serialized session or worker clock, decides whether elevation still exists.
  const live = await sql<{
    elevated: boolean;
  }>`SELECT ("pinExpiresAt">clock_timestamp()) IS TRUE AS elevated
    FROM public.session WHERE id=${sessionId}::uuid AND "userId"=${ownerId}::uuid
      AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())`.execute(db);
  if (live.rows.length === 0) {
    return;
  }
  const elevated = live.rows[0].elevated;
  return {
    user: user as AuthDto['user'],
    session: { ...session, hasElevatedPermission: elevated } as NonNullable<AuthDto['session']>,
    ...(!elevated && { hiddenContent: { userId: ownerId, includeNsfw: false, ...suppression } }),
  };
}
export type GuardedAudit = {
  request: Extract<
    ICloudAuditRow,
    {
      purpose: 'manual-session';
    }
  >;
  source: ICloudResource;
  connection: ICloudConnection;
  private: boolean;
  requiresElevation: boolean;
};
/** Called inside the recovery transaction AFTER its fork/digest/user prefix, before the audit resource. */
export async function guardAudit(
  db: Kysely<DB>,
  authority: AuditAuthority,
  ownerId: string,
  lock = false,
  requireClaim = true,
): Promise<GuardedAudit | undefined> {
  const request = await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit
    WHERE id=${authority.auditRequestId}::uuid AND "ownerId"=${ownerId}::uuid`
    .execute(db)
    .then(({ rows }) => rows[0]);
  if (
    !request ||
    request.purpose !== 'manual-session' ||
    request.operationId !== authority.operationId ||
    !['queued', 'running'].includes(request.result)
  ) {
    return;
  }
  const connection = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
    WHERE id=${request.connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected'
      AND "encryptedSession" IS NOT NULL AND "lastError" IS DISTINCT FROM 'owner_removed'
    ${lock ? sql`FOR SHARE` : sql``}`
    .execute(db)
    .then(({ rows }) => rows[0]);
  if (!connection || canonicalJson(connection.config) !== request.snapshot.config) {
    return;
  }
  const operation = await sql`SELECT id FROM public.media_operation WHERE id=${authority.operationId}::uuid
    AND "ownerId"=${ownerId}::uuid AND kind='icloud_sync' AND snapshot->>'task'='identity-audit'
    AND snapshot->'auditIds' ? ${request.id} AND "claimToken"=${authority.operationClaimToken}::uuid
    AND "claimExpiresAt">clock_timestamp() AND status IN ('preparing','rendering','validating')
    AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(db);
  if (operation.rows.length === 0) {
    return;
  }
  const current = await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit
    WHERE id=${request.id}::uuid AND purpose='manual-session' AND result IN ('queued','running') ${lock ? sql`FOR UPDATE` : sql``}`.execute(
    db,
  );
  const currentRequest = current.rows[0];
  if (!currentRequest || currentRequest.purpose !== 'manual-session') {
    return;
  }
  const source = await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize"
    FROM public.icloud_resource WHERE id=${request.sourceResourceId}::uuid AND "auditRequestId" IS NULL
      AND "connectionId"=${connection.id}::uuid AND "ownerId"=${ownerId}::uuid
      AND coalesce((source->>'current')::boolean,true)
      ${lock ? sql`FOR SHARE` : sql``}`
    .execute(db)
    .then(({ rows }) => rows[0]);
  if (
    !source ||
    (connection.config.libraries.length > 0 && !connection.config.libraries.includes(source.libraryKey)) ||
    (!connection.config.includeHidden && source.source.isHidden === true) ||
    (!connection.config.includeEdits && source.role.startsWith('edited-'))
  ) {
    return;
  }
  const records = await sql<{
    recordId: string;
    revision: string;
    fields: Record<string, unknown>;
    masterId: string | null;
    recordType: string;
  }>`
    SELECT "recordId", revision, fields, "masterId", "recordType" FROM public.icloud_record
    WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${source.libraryKey} AND NOT deleted
      AND "recordId" IN (${source.sourceAssetId}, ${String(source.source.sourceMasterId ?? '')})
    ORDER BY "recordId" ${lock ? sql`FOR SHARE` : sql``}`
    .execute(db)
    .then(({ rows }) => rows);
  const assetRecord = records.find(({ recordId }) => recordId === source.sourceAssetId);
  const master = records.find(({ recordId }) => recordId === source.source.sourceMasterId);
  if (
    !assetRecord ||
    !master ||
    assetRecord.revision !== request.snapshot.sourceRevision ||
    master.revision !== request.snapshot.masterRevision
  ) {
    return;
  }
  const normalize = (row: NonNullable<typeof assetRecord>) => ({
    recordName: row.recordId,
    recordType: row.recordType,
    recordChangeTag: row.revision,
    fields: row.fields,
  });
  const normalized = resourcesForICloudAsset(normalize(assetRecord), normalize(master));
  if (
    normalized.every(
      (r) =>
        !(
          r.recordId === source.recordId &&
          r.resourceKey === source.resourceKey &&
          r.fingerprint === source.fingerprint &&
          r.expectedSize === source.expectedSize &&
          r.role === source.role
        ),
    )
  ) {
    return;
  }
  if (connection.config.albums.length > 0) {
    const members = await sql`SELECT 1 FROM public.icloud_membership WHERE "connectionId"=${connection.id}::uuid
      AND "libraryKey"=${source.libraryKey} AND "sourceAssetId"=${source.sourceAssetId} AND "sourcePresent"
      AND ("libraryKey"||':'||"sourceAlbumId")=ANY(${connection.config.albums}::text[])
      ${lock ? sql`FOR SHARE` : sql``}`.execute(db);
    if (members.rows.length === 0) {
      return;
    }
  }
  const identity = await sql`SELECT id FROM public.icloud_source_identity WHERE id=${request.identityId}::uuid
    AND "ownerId"=${ownerId}::uuid AND "assetId"=${request.originalAssetId}::uuid AND sha256=${request.expectedSha256}
    AND "cplAssetRecordName"=upper(${source.sourceAssetId}) AND role=${identityRoleOf[source.role] ?? ''}
    AND "editVersion"=CASE WHEN ${source.role.startsWith('edited-')}
      THEN coalesce(${source.source}::jsonb->'assetFields'->'adjustmentTimestamp'->>'value','')||':'||${source.fingerprint} ELSE '' END
    ${lock ? sql`FOR UPDATE` : sql``}`.execute(db);
  if (identity.rows.length === 0) {
    return;
  }
  if (requireClaim && !request.itemClaimId) {
    return;
  }
  if (requireClaim && request.itemClaimId) {
    const claimed = await sql`SELECT 1 FROM public.icloud_claim WHERE id=${request.itemClaimId}::uuid
      AND "ownerId"=${ownerId}::uuid AND "cplAssetRecordName"=upper(${source.sourceAssetId})
      AND holder=${manualAuditClaimHolder(ownerId, authority)} AND "expiresAt">clock_timestamp()
      ${lock ? sql`FOR SHARE` : sql``}`.execute(db);
    if (claimed.rows.length === 0) {
      return;
    }
  }
  const auth = await currentAuth(db, ownerId, request.sessionId, lock);
  if (!auth) {
    return;
  }
  let safe = new IntegrityRepository(db)
    .getSafetyQuery(auth, [request.expectedSha256.toString('hex')])
    .where('asset.id', '=', request.originalAssetId)
    .where('asset.originalPath', '=', request.snapshot.originalPath)
    .where('asset.checksum', '=', Buffer.from(request.snapshot.checksum, 'hex'))
    .where(sql<boolean>`asset."checksumAlgorithm"::text IS NOT DISTINCT FROM ${request.snapshot.algorithm}::text`)
    .where('asset.updateId', '=', request.snapshot.updateId);
  if (lock) {
    safe = safe.forShare('asset');
  }
  if (!(await safe.executeTakeFirst())) {
    return;
  }
  // Conservatively protect a separate source copy when an elevated owner sees any Locked/suppressed item.
  const ordinaryAuth = {
    ...auth,
    session: { ...auth.session!, hasElevatedPermission: false },
    hiddenContent: {
      userId: ownerId,
      includeNsfw: false,
      ...getPreferences(await db.selectFrom('user_metadata').selectAll().where('userId', '=', ownerId).execute())
        .privacy.suppression,
    },
  };
  const visible = await new IntegrityRepository(db)
    .getSafetyQuery(ordinaryAuth)
    .where('asset.id', '=', request.originalAssetId)
    .executeTakeFirst();
  return {
    request: currentRequest,
    source,
    connection,
    private: !visible || source.source.isHidden === true,
    requiresElevation: !visible,
  };
}
@Injectable()
export class ICloudAuditRepository {
  constructor(
    @InjectKysely()
    private db: Kysely<DB>,
  ) {}
  async submit(
    auth: AuthDto,
    dto: ICloudVerifyDto,
    operations: MediaOperationRepository,
  ): Promise<ICloudVerifyResponseDto> {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new ForbiddenException('icloud_audit_session_required');
    }
    const requestKey = dto.requestKey.toLowerCase(),
      connectionId = dto.connectionId.toLowerCase();
    const input = [...dto.items]
      .map((item) => ({
        ...item,
        assetId: item.assetId.toLowerCase(),
        cloudIdentifier: parseCloudIdentifier(item.cloudIdentifier.trim())
          ? item.cloudIdentifier.trim().replace(/^[^:]+/, (name) => name.toUpperCase())
          : item.cloudIdentifier.trim(),
        editVersion: item.editVersion ?? '',
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    try {
      const { operation, value } = await operations.createWithin(
        async (db) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`icloud-audit:${auth.user.id}:${requestKey}`},0))`.execute(
            db,
          );
          const previous = await db
            .selectFrom('media_operation')
            .selectAll()
            .where('ownerId', '=', auth.user.id)
            .where('kind', '=', MediaOperationKind.ICloudSync)
            .where(sql<boolean>`snapshot->>'task'='identity-audit'`)
            .where(sql<string>`snapshot->>'requestKey'`, '=', requestKey)
            .executeTakeFirst();
          if (previous) {
            const snapshot = previous.snapshot as Record<string, unknown>;
            if (snapshot.connectionId !== connectionId || canonicalJson(snapshot.input) !== canonicalJson(input)) {
              throw new ConflictException('icloud_audit_request_key_conflict');
            }
            throw new Replay({
              operationId: previous.id,
              items: (
                previous.result as {
                  items: Outcome[];
                }
              ).items,
            });
          }
          await lockAuditOwner(db, auth.user.id);
          const submitting = await currentAuth(db, auth.user.id, auth.session!.id, true);
          if (!submitting) {
            throw new ForbiddenException('icloud_audit_session_required');
          }
          const connection = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
          WHERE id=${connectionId}::uuid AND "ownerId"=${auth.user.id}::uuid AND state='connected'
            AND "encryptedSession" IS NOT NULL FOR SHARE`
            .execute(db)
            .then(({ rows }) => rows[0]);
          const outcomes: Outcome[] = [],
            auditIds: string[] = [];
          for (const item of input) {
            const parsed = parseCloudIdentifier(item.cloudIdentifier);
            const safe =
              connection &&
              parsed &&
              (await new IntegrityRepository(db)
                .getSafetyQuery(submitting)
                .where('asset.id', '=', item.assetId)
                .forShare('asset')
                .executeTakeFirst());
            if (!safe?.sha256 || !connection || !parsed) {
              outcomes.push({ id: item.id, state: 'unavailable' });
              continue;
            }
            const identities = await sql<{
              id: string;
              sha256: Buffer;
            }>`SELECT id,sha256 FROM public.icloud_source_identity
            WHERE "ownerId"=${auth.user.id}::uuid AND "assetId"=${item.assetId}::uuid
              AND "cplAssetRecordName"=${parsed.cplAssetRecordName} AND role=${item.role} AND "editVersion"=${item.editVersion}
              AND sha256=${Buffer.from(safe.sha256, 'hex')} FOR SHARE`.execute(db);
            const sourceRows = await sql<
              ICloudResource & {
                sourceRevision: string;
                masterRevision: string;
              }
            >`SELECT r.*,r."expectedSize"::float8 AS "expectedSize",
              a.revision AS "sourceRevision",m.revision AS "masterRevision"
            FROM public.icloud_resource r JOIN public.icloud_record a
              ON a."connectionId"=r."connectionId" AND a."libraryKey"=r."libraryKey" AND a."recordId"=r."sourceAssetId" AND NOT a.deleted
            JOIN public.icloud_record m ON m."connectionId"=a."connectionId" AND m."libraryKey"=a."libraryKey" AND m."recordId"=a."masterId" AND NOT m.deleted
            WHERE r."connectionId"=${connection.id}::uuid AND r."ownerId"=${auth.user.id}::uuid AND r."auditRequestId" IS NULL
              AND upper(r."sourceAssetId")=${parsed.cplAssetRecordName} AND coalesce((r.source->>'current')::boolean,true)
              AND (CASE r.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion' WHEN 'raw' THEN 'raw-alternate' ELSE 'edit-render' END)=${item.role}
              AND (${parsed.cplMasterRecordName === null} OR m."recordId"=${parsed.cplMasterRecordName})
              AND (${item.role !== 'edit-render'} OR coalesce(r.source->'assetFields'->'adjustmentTimestamp'->>'value','')||':'||r.fingerprint=${item.editVersion})`.execute(
              db,
            );
            const source = sourceRows.rows[0];
            if (
              identities.rows.length !== 1 ||
              sourceRows.rows.length !== 1 ||
              !source?.sourceRevision ||
              !source.masterRevision ||
              identityRoleOf[source.role] !== item.role
            ) {
              outcomes.push({ id: item.id, state: 'unavailable' });
              continue;
            }
            const config = connection.config;
            const member =
              config.albums.length === 0 ||
              (
                await sql`SELECT 1 FROM public.icloud_membership
            WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${source.libraryKey}
              AND "sourceAssetId"=${source.sourceAssetId} AND "sourcePresent"
              AND ("libraryKey"||':'||"sourceAlbumId")=ANY(${config.albums}::text[])`.execute(db)
              ).rows.length > 0;
            if (
              (config.libraries.length > 0 && !config.libraries.includes(source.libraryKey)) ||
              !member ||
              (!config.includeHidden && source.source.isHidden === true) ||
              (!config.includeEdits && source.role.startsWith('edited-'))
            ) {
              outcomes.push({ id: item.id, state: 'unavailable' });
              continue;
            }
            const original = await db
              .selectFrom('asset')
              .selectAll()
              .where('id', '=', item.assetId)
              .executeTakeFirstOrThrow();
            const id = randomUUID();
            await sql`INSERT INTO public.icloud_identity_audit
            (id,"ownerId","connectionId","sessionId","identityId","originalAssetId","sourceResourceId","expectedSha256",snapshot)
            VALUES (${id}::uuid,${auth.user.id}::uuid,${connection.id}::uuid,${auth.session!.id}::uuid,${identities.rows[0].id}::uuid,
              ${item.assetId}::uuid,${source.id}::uuid,${identities.rows[0].sha256},${{
                sourceRevision: source.sourceRevision,
                masterRevision: source.masterRevision,
                config: canonicalJson(connection.config),
                originalPath: original.originalPath,
                checksum: original.checksum.toString('hex'),
                algorithm: original.checksumAlgorithm,
                updateId: original.updateId,
              }}::jsonb)`.execute(db);
            auditIds.push(id);
            outcomes.push({ id: item.id, state: 'queued' });
          }
          return {
            value: outcomes,
            operation: {
              ownerId: auth.user.id,
              kind: MediaOperationKind.ICloudSync,
              destination: MediaOperationDestination.Local,
              destinationDetail: null,
              label: 'Verify iCloud originals',
              assetId: null,
              resultAssetId: null,
              retryOfId: null,
              projectId: null,
              revisionId: null,
              snapshot: { task: 'identity-audit', connectionId, requestKey, input, auditIds },
              settings: {},
              estimate: null,
              result: { items: outcomes },
              totalUnits: auditIds.length,
            },
          };
        },
        async (db, created) => {
          await sql`UPDATE public.icloud_identity_audit SET "operationId"=${created.id}::uuid
          WHERE id=ANY(${created.snapshot.auditIds as string[]}::uuid[])`.execute(db);
          if ((created.snapshot.auditIds as string[]).length === 0) {
            await db
              .updateTable('media_operation')
              .set({ status: MediaOperationStatus.Completed, finishedAt: new Date(), progress: 100 })
              .where('id', '=', created.id)
              .execute();
          }
        },
      );
      return { operationId: operation.id, items: value };
    } catch (error) {
      if (error instanceof Replay) {
        return error.response;
      }
      throw error;
    }
  }
  async get(id: string, ownerId: string): Promise<ICloudAuditRow | undefined> {
    return sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid`
      .execute(this.db)
      .then(({ rows }) => rows[0]);
  }

  async operationPurpose(operationId: string, ownerId: string) {
    const { rows } = await sql<{ purpose: string }>`SELECT DISTINCT purpose FROM public.icloud_identity_audit
      WHERE "operationId"=${operationId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(this.db);
    return rows.length === 1 ? rows[0].purpose : rows.length > 0 ? 'invalid' : undefined;
  }

  /** A stop observation is never authority to publish; settlement still checks the live token at its write. */
  async stopState(operationId: string, ownerId: string, claimToken: string) {
    const { rows } = await sql<{ cancelRequestedAt: Date | null; pauseRequestedAt: Date | null; live: boolean }>`
      SELECT "cancelRequestedAt", "pauseRequestedAt",
        ("claimToken"=${claimToken}::uuid AND "claimExpiresAt">clock_timestamp()) AS live
      FROM public.media_operation WHERE id=${operationId}::uuid AND "ownerId"=${ownerId}::uuid
        AND kind='icloud_sync' AND snapshot->>'task'='identity-audit'`.execute(this.db);
    return rows[0];
  }

  async check(authority: AuditAuthority, ownerId: string, requireClaim = true) {
    return guardAudit(this.db, authority, ownerId, false, requireClaim);
  }
  async setItemClaim(id: string, ownerId: string, claimId: string) {
    await this.db.transaction().execute(async (db) => {
      await sql`UPDATE public.icloud_identity_audit SET "itemClaimId"=${claimId}::uuid
        WHERE id=${id}::uuid AND "ownerId"=${ownerId}::uuid AND result IN ('queued','running')`.execute(db);
    });
  }
  async allocate(authority: AuditAuthority, ownerId: string): Promise<ICloudResource | undefined> {
    return this.db.transaction().execute(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(db);
      await lockAuditOwner(db, ownerId);
      const guarded = await guardAudit(db, authority, ownerId, true);
      if (!guarded || !guarded.request.itemClaimId) {
        return;
      }
      const { source, connection, request } = guarded;
      const existing =
        await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource
        WHERE "auditRequestId"=${request.id}::uuid FOR UPDATE`
          .execute(db)
          .then(({ rows }) => rows[0]);
      if (existing?.leaseExpiresAt && new Date(existing.leaseExpiresAt) > new Date()) {
        return;
      }
      if (existing?.nextAttemptAt && new Date(existing.nextAttemptAt) > new Date()) {
        return;
      }
      const {
        rows: [budget],
      } = await sql<{
        used: number;
        active: number;
      }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS used,
        count(*) FILTER (WHERE "leaseExpiresAt">clock_timestamp())::int AS active
        FROM public.icloud_resource WHERE "connectionId"=${connection.id}::uuid AND status NOT IN ('finalized','removed')`.execute(
        db,
      );
      const globalLimit = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_STAGING_BYTES') ?? 100 * 1024 ** 3);
      const concurrency = Number(readAliasedEnv('FRAMELEAF_ICLOUD_MAX_CONCURRENCY') ?? 4);
      const {
        rows: [global],
      } = await sql<{
        used: number;
        active: number;
      }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS used,
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
        VALUES (${connection.id}::uuid,${ownerId}::uuid,${source.libraryKey},${source.library}::jsonb,${source.sourceAssetId},${source.recordId},${source.resourceKey},
          ${source.role},${source.fingerprint},${{ ...source.source, _sync: undefined }}::jsonb,${source.expectedSize},${request.id}::uuid,${source.expectedSize},${lease}::uuid,clock_timestamp()+interval '30 minutes')
        RETURNING *,"expectedSize"::float8 AS "expectedSize"`
        .execute(db)
        .then(({ rows }) => rows[0]);
    });
  }
  async publishMatch(
    authority: AuditAuthority,
    resource: ICloudResource,
    verified: VerifiedMedia,
    validate: () => Promise<MediaIntegrityResult>,
  ): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      await lockAuditOwner(db, resource.ownerId, verified.sha256);
      const guarded = await guardAudit(db, authority, resource.ownerId, true);
      if (!guarded || !guarded.request.expectedSha256.equals(verified.sha256)) {
        return false;
      }
      const held = await sql`SELECT 1 FROM public.icloud_resource WHERE id=${resource.id}::uuid
        AND "auditRequestId"=${authority.auditRequestId}::uuid AND "leaseToken"=${resource.leaseToken}::uuid
        AND "stagingPath"=${resource.stagingPath}
        AND "leaseExpiresAt">clock_timestamp() AND status NOT IN ('committed','finalized','removed') FOR UPDATE`.execute(
        db,
      );
      if (held.rows.length === 0) {
        return false;
      }
      const final = await validate();
      if (
        final.status !== 'healthy' ||
        !final.sha256.equals(verified.sha256) ||
        !final.sha1.equals(verified.sha1) ||
        final.sizeInBytes !== verified.sizeInBytes ||
        !(await guardAudit(db, authority, resource.ownerId, true))
      ) {
        return false;
      }
      const stillHeld = await sql`SELECT 1 FROM public.icloud_resource WHERE id=${resource.id}::uuid
        AND "leaseToken"=${resource.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()
        AND "auditRequestId"=${authority.auditRequestId}::uuid AND "stagingPath"=${resource.stagingPath}`.execute(db);
      if (stillHeld.rows.length === 0) {
        return false;
      }
      await publishAudit(db, authority, resource.ownerId, 'match', {
        id: resource.id,
        leaseToken: resource.leaseToken!,
      });
      await sql`UPDATE public.icloud_resource SET status='committed',sha256=${verified.sha256},sha1=${verified.sha1},
        verification=${{
          kind: 'audit-match-staging',
          resourceId: resource.id,
          requestId: authority.auditRequestId,
          ownerId: resource.ownerId,
          stagingPath: resource.stagingPath,
          sha256: verified.sha256.toString('hex'),
          sizeInBytes: verified.sizeInBytes,
        }}::jsonb,
        "pendingJobs"='[]'::jsonb WHERE id=${resource.id}::uuid`.execute(db);
      return true;
    });
  }
  /** Credential-independent receipt cleanup; no original/source/session access or proof writes. */
  async housekeeping(process: (resource: ICloudResource, db: Kysely<DB>) => Promise<void>): Promise<void> {
    const candidates = await sql<{
      id: string;
      ownerId: string;
    }>`SELECT r.id,r."ownerId" FROM public.icloud_resource r
      JOIN public.icloud_identity_audit q ON q.id=r."auditRequestId" AND q."ownerId"=r."ownerId"
      WHERE r.status='committed' AND q.result IN ('match','mismatch')
        AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt"<=clock_timestamp())
      ORDER BY r.id LIMIT 10`.execute(this.db);
    for (const candidate of candidates.rows) {
      await this.db.transaction().execute(async (db) => {
        await lockAuditOwner(db, candidate.ownerId, undefined, true);
        const binding = await sql<{
          connectionId: string;
          auditRequestId: string;
        }>`SELECT "connectionId","auditRequestId"
          FROM public.icloud_resource WHERE id=${candidate.id}::uuid AND "ownerId"=${candidate.ownerId}::uuid`
          .execute(db)
          .then(({ rows }) => rows[0]);
        if (!binding) {
          return;
        }
        await sql`SELECT id FROM public.icloud_connection WHERE id=${binding.connectionId}::uuid AND "ownerId"=${candidate.ownerId}::uuid FOR SHARE`.execute(
          db,
        );
        const request =
          await sql<ICloudAuditRow>`SELECT * FROM public.icloud_identity_audit WHERE id=${binding.auditRequestId}::uuid
          AND "ownerId"=${candidate.ownerId}::uuid AND result IN ('match','mismatch') FOR UPDATE`
            .execute(db)
            .then(({ rows }) => rows[0]);
        const resource =
          await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM public.icloud_resource
          WHERE id=${candidate.id}::uuid AND "ownerId"=${candidate.ownerId}::uuid AND status='committed'
          FOR UPDATE SKIP LOCKED`
            .execute(db)
            .then(({ rows }) => rows[0]);
        if (
          !request ||
          !resource ||
          request.connectionId !== binding.connectionId ||
          resource.auditRequestId !== request.id ||
          !resource.sha256 ||
          !resource.stagingPath
        ) {
          return;
        }
        if (
          request.result === 'match' &&
          (resource.verification?.kind !== 'audit-match-staging' ||
            resource.verification.sha256 !== resource.sha256.toString('hex') ||
            resource.verification.sizeInBytes !== resource.expectedSize ||
            resource.verification.stagingPath !== resource.stagingPath ||
            resource.verification.resourceId !== resource.id ||
            resource.verification.requestId !== request.id ||
            resource.verification.ownerId !== candidate.ownerId ||
            resource.pendingJobs.length > 0 ||
            resource.assetId ||
            resource.promotedPath)
        ) {
          return;
        }
        if (
          request.result === 'mismatch' &&
          (!request.resultAssetId ||
            request.resultAssetId !== resource.assetId ||
            resource.expectedTarget?.assetId !== resource.assetId)
        ) {
          return;
        }
        if (request.result === 'mismatch') {
          const receipt = resource.verification?.auditStaging as Record<string, unknown> | undefined;
          if (
            !receipt ||
            receipt.resourceId !== resource.id ||
            receipt.requestId !== request.id ||
            receipt.ownerId !== candidate.ownerId ||
            receipt.stagingPath !== resource.stagingPath ||
            receipt.sha256 !== resource.sha256.toString('hex') ||
            receipt.sizeInBytes !== resource.expectedSize
          ) {
            return;
          }
        }
        try {
          await process(resource, db);
          await sql`UPDATE public.icloud_resource SET status='finalized',"reservedBytes"=0,"pendingJobs"='[]'::jsonb,
            "leaseToken"=NULL,"leaseExpiresAt"=NULL,"lastError"=NULL,"nextAttemptAt"=NULL WHERE id=${resource.id}::uuid`.execute(
            db,
          );
        } catch {
          await sql`UPDATE public.icloud_resource SET "lastError"='audit_cleanup_retry',"nextAttemptAt"=clock_timestamp()+interval '5 minutes'
            WHERE id=${resource.id}::uuid`.execute(db);
        }
      });
    }
  }
}
/** Called only inside guarded publication, never by housekeeping. */
export async function publishAudit(
  db: Kysely<DB>,
  authority: AuditExecutionAuthority,
  ownerId: string,
  result: 'match' | 'mismatch',
  resource: {
    id: string;
    leaseToken: string;
  },
  assetId?: string,
) {
  // A DB admission/final fence cannot replace independently verified fresh-stream evidence.
  if (authority.purpose === 'scheduled-weekly') {
    throw new Error('scheduled_audit_execution_unavailable');
  }
  const guarded = await guardAudit(db, authority, ownerId, true);
  if (!guarded) {
    throw new Error('audit_authority_changed');
  }
  if (result === 'mismatch') {
    const copy =
      await sql`SELECT id FROM public.icloud_resource WHERE "auditRequestId"=${authority.auditRequestId}::uuid
      AND "ownerId"=${ownerId}::uuid AND status='committed' AND "assetId"=${assetId ?? null}::uuid
      AND "assetId"<>${guarded.request.originalAssetId}::uuid AND sha256 IS NOT NULL AND sha256<>${guarded.request.expectedSha256}`.execute(
        db,
      );
    if (copy.rows.length === 0) {
      throw new Error('audit_mismatch_receipt_invalid');
    }
    // Reuse must never make private source bytes available through an ordinary copy.
    // A new audit copy receives this durable lock from the final transactional guard.
    if (guarded.private) {
      const protectedCopy = await sql`SELECT 1 FROM public.asset_lock WHERE "assetId"=${assetId ?? null}::uuid`.execute(
        db,
      );
      if (protectedCopy.rows.length === 0) {
        throw new Error('audit_private_destination_unprotected');
      }
    }
  }
  // All row locks, privacy reads, file validation and mismatch destination writes precede
  // this statement. Locks serialize mutations but cannot stop time-based expiry.
  const published = await sql`UPDATE public.icloud_source_identity SET "lastAuditResult"=${result},
    "lastVerifiedAt"=CASE WHEN ${result}='match' THEN clock_timestamp() ELSE NULL END
    WHERE id=${guarded.request.identityId}::uuid AND sha256=${guarded.request.expectedSha256}
      AND EXISTS (SELECT 1 FROM public.session WHERE id=${guarded.request.sessionId}::uuid AND "userId"=${ownerId}::uuid
        AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
        AND (${!guarded.requiresElevation} OR "pinExpiresAt">clock_timestamp()))
      AND EXISTS (SELECT 1 FROM public.media_operation WHERE id=${authority.operationId}::uuid AND "ownerId"=${ownerId}::uuid
        AND "claimToken"=${authority.operationClaimToken}::uuid AND "claimExpiresAt">clock_timestamp()
        AND status IN ('preparing','rendering','validating') AND "cancelRequestedAt" IS NULL AND "pauseRequestedAt" IS NULL)
      AND EXISTS (SELECT 1 FROM public.icloud_claim WHERE id=${guarded.request.itemClaimId}::uuid
        AND "ownerId"=${ownerId}::uuid AND holder=${manualAuditClaimHolder(ownerId, authority)}
        AND "expiresAt">clock_timestamp())
      AND EXISTS (SELECT 1 FROM public.icloud_resource WHERE id=${resource.id}::uuid
        AND "ownerId"=${ownerId}::uuid AND "auditRequestId"=${authority.auditRequestId}::uuid
        AND "leaseToken"=${resource.leaseToken}::uuid AND "leaseExpiresAt">clock_timestamp()
        AND status NOT IN ('removed','finalized')) RETURNING id`.execute(db);
  if (published.rows.length === 0) {
    throw new Error('audit_authority_expired');
  }
  await sql`UPDATE public.icloud_identity_audit SET result=${result},"verifiedAt"=clock_timestamp(),"resultAssetId"=${assetId ?? null}::uuid
    WHERE id=${authority.auditRequestId}::uuid`.execute(db);
}
