import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, Transaction, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudIdentityReuseAuthorityDto, ICloudIdentityReuseAuthorityStatusDto } from 'src/dtos/icloud-sync.dto.js';
import {
  AssetStatus,
  AssetVisibility,
  MediaOperationDestination,
  MediaOperationKind,
  UserMetadataKey,
} from 'src/enum.js';
import { lockAuditOwner } from 'src/repositories/icloud-audit.repository.js';
import { ICloudConnection, ICloudResource } from 'src/repositories/icloud-sync.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { hiddenContentAssetIdExists } from 'src/utils/database.js';
import { parseCloudIdentifier } from 'src/utils/icloud-identity.js';
import { ICloudRecord, resourcesForICloudAsset } from 'src/utils/icloud-records.js';
import { isLocked } from 'src/utils/locked.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';
import { getPreferences } from 'src/utils/preferences.js';
import { canonicalJson } from 'src/utils/studio-project.js';

type Grant = {
  id: string;
  generation: number;
  enabled: boolean;
  includeProtected: boolean;
  configFingerprint: string;
  privacyFingerprint: string;
  pinBinding: string | null;
  requestKey: string;
  inputFingerprint: string;
  requestHistory: Record<string, string>;
};
const fingerprint = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const pinBinding = (pin: string | null) => (pin === null ? null : fingerprint(['weekly-pin-v1', pin]));

export type ICloudWeeklyCohort = {
  id: string;
  ownerId: string;
  connectionId: string;
  weekStart: string;
  grantId: string | null;
  grantGeneration: number | null;
  configFingerprint: string;
  privacyFingerprint: string;
  seed: Buffer;
  manifestDigest: Buffer;
  populationCount: string;
  staleCount: string;
  selectedCount: string;
  performedCount: string;
  matchCount: string;
  mismatchCount: string;
  unavailableCount: string;
  cancelledCount: string;
  nextBatch: number;
  status: 'frozen' | 'running' | 'settled';
};
type WeeklyContext = {
  connection: ICloudConnection;
  grant?: Grant;
  configFingerprint: string;
  privacyFingerprint: string;
  available: boolean;
  suppression: ReturnType<typeof getPreferences>['privacy']['suppression'];
};
type WeeklyReceipt = Record<string, unknown> & {
  identityId: string;
  assetId: string;
  sourceResourceId: string;
  snapshot: Record<string, unknown>;
};
type WeeklyPopulationRow = {
  id: string;
  sourceResourceId: string;
  role: string;
  expectedSha256: Buffer;
  receipt: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  source: ICloudResource | null;
  identity: Record<string, unknown> | null;
  original: Record<string, unknown> | null;
  assetRecord: ICloudRecord | null;
  masterRecord: ICloudRecord | null;
  current: boolean;
  executable: boolean;
};
type WeeklyBatchMember = {
  ordinal: string;
  outcome: string;
  auditRequestId: string | null;
  grantId: string | null;
  grantGeneration: number | null;
  expectedSha256: Buffer;
  bindings: { receipt: WeeklyReceipt; original: { updateId: string } };
  batchOrdinal: number;
};
class WeeklyNoBatch extends Error {
  constructor(readonly retired: boolean) {
    super('weekly_no_batch');
  }
}

/** Private consent and frozen producer. No scheduler or byte authority is registered here. */
@Injectable()
export class ICloudWeeklyRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Discovery is not authority: frozen obligations survive retirement and week rollover. */
  async scheduleCandidates(): Promise<{ ownerId: string; connectionId: string; cohortId: string | null }[]> {
    const { rows } = await sql<{ ownerId: string; connectionId: string; cohortId: string | null }>`
      SELECT "ownerId","connectionId","cohortId" FROM (
        SELECT "ownerId","connectionId",id AS "cohortId","weekStart"
        FROM public.icloud_weekly_cohort WHERE status IN ('frozen','running')
        UNION ALL
        SELECT c."ownerId",c.id,NULL::uuid,date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date
        FROM public.icloud_connection c
        JOIN public.icloud_weekly_grant g ON g."connectionId"=c.id AND g."ownerId"=c."ownerId" AND g.enabled
        JOIN public."user" u ON u.id=c."ownerId" AND u."deletedAt" IS NULL
        WHERE c.state='connected' AND c."encryptedSession" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM public.icloud_weekly_cohort existing
            WHERE existing."ownerId"=c."ownerId" AND existing."connectionId"=c.id
              AND existing."weekStart"=date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date)
      ) candidates ORDER BY "weekStart","ownerId","connectionId","cohortId" NULLS LAST`.execute(this.db);
    return rows;
  }

  /** Freeze every actual 0217 receipt once, using the database's current UTC week. */
  async freezeCohort(ownerId: string, connectionId: string, requireAuthority = false): Promise<ICloudWeeklyCohort> {
    ownerId = ownerId.toLowerCase();
    connectionId = connectionId.toLowerCase();
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (db) => {
        const context = await this.lockContext(db, ownerId, connectionId);
        // A consent/configuration race must not consume the automatic freeze for this UTC week.
        if (requireAuthority && !context.available) {
          throw new ConflictException('Weekly authority unavailable');
        }
        const {
          rows: [clock],
        } = await sql<{ weekStart: string }>`SELECT
        date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date::text AS "weekStart"`.execute(db);
        const {
          rows: [existing],
        } = await sql<ICloudWeeklyCohort>`SELECT *,"weekStart"::text AS "weekStart" FROM public.icloud_weekly_cohort
        WHERE "ownerId"=${ownerId}::uuid AND "connectionId"=${connectionId}::uuid
          AND "weekStart"=${clock.weekStart}::date FOR UPDATE`.execute(db);
        if (existing) {
          return existing;
        }
        const seed = randomBytes(32);
        const manifest = createHash('sha256');
        manifest.update(canonicalJson(['icloud-weekly-manifest-v1', ownerId, connectionId, clock.weekStart]) + '\n');
        // Transaction-local staging bounds JS memory without truncating the population or sample.
        // TEMP privilege is a genuine deployment gate; failure rolls back the whole freeze.
        await sql`CREATE TEMPORARY TABLE icloud_weekly_freeze (
        "receiptId" uuid PRIMARY KEY,"resourceRoleKey" text NOT NULL UNIQUE,ordinal bigint NOT NULL UNIQUE,
        rank bytea NOT NULL,"expectedSha256" bytea NOT NULL,bindings jsonb NOT NULL,
        current boolean NOT NULL,executable boolean NOT NULL) ON COMMIT DROP`.execute(db);
        let cursor: string | null = null;
        let count = 0;
        let population = 0;
        for (;;) {
          const { rows } = await sql<WeeklyPopulationRow>`SELECT r.id,r."sourceResourceId",r.role,r."expectedSha256",
          to_jsonb(r)-'snapshot' AS receipt,r.snapshot,
          CASE WHEN s.id IS NULL THEN NULL ELSE to_jsonb(s)||jsonb_build_object('expectedSize',s."expectedSize"::float8) END AS source,
          to_jsonb(i) AS identity,
          CASE WHEN a.id IS NULL THEN NULL ELSE to_jsonb(a)||jsonb_build_object('checksumHex',encode(a.checksum,'hex'),
            'physicalId',a."physicalOriginalFileId") END AS original,
          CASE WHEN ar."recordId" IS NULL THEN NULL ELSE jsonb_build_object('recordName',ar."recordId",
            'recordType',ar."recordType",'recordChangeTag',ar.revision,'fields',ar.fields) END AS "assetRecord",
          CASE WHEN mr."recordId" IS NULL THEN NULL ELSE jsonb_build_object('recordName',mr."recordId",
            'recordType',mr."recordType",'recordChangeTag',mr.revision,'fields',mr.fields) END AS "masterRecord",
          coalesce(${context.available}
            AND (${context.connection.config.libraries.length === 0} OR r."libraryKey"=ANY(${context.connection.config.libraries}::text[]))
            AND (${context.connection.config.albums.length === 0} OR EXISTS (SELECT 1 FROM public.icloud_membership am
              WHERE am."connectionId"=r."connectionId" AND am."libraryKey"=r."libraryKey"
                AND am."sourceAssetId"=s."sourceAssetId" AND am."sourcePresent"
                AND (am."libraryKey"||':'||am."sourceAlbumId")=ANY(${context.connection.config.albums}::text[])))
            AND (${context.connection.config.includeHidden} OR s.source->>'isHidden' IS DISTINCT FROM 'true')
            AND (${!!context.grant?.includeProtected} OR (
              NOT ${isLocked('a')}
              AND NOT EXISTS (SELECT 1 FROM public.asset still JOIN public.asset_lock al ON al."assetId"=still.id
                WHERE still."livePhotoVideoId"=a.id AND a.visibility=${AssetVisibility.Hidden})
              AND (a.visibility<>${AssetVisibility.Hidden} OR r.role='live-motion')
              AND NOT ${hiddenContentAssetIdExists(sql.ref('a.id'), { userId: ownerId, includeNsfw: true, ...context.suppression })}
            )),false) AS executable,
          coalesce(r.basis='exact-identity' AND r."editVersion"=''
            AND s."ownerId"=r."ownerId" AND s."connectionId"=r."connectionId" AND s."auditRequestId" IS NULL
            AND s."assetId"=r."assetId" AND s.path=r.snapshot->>'originalPath'
            AND s.sha256=r."expectedSha256" AND s.status IN ('committed','finalized','reused')
            AND s."libraryKey"=r."libraryKey" AND upper(s."sourceAssetId")=r."cplAssetRecordName"
            AND s."resourceKey"=r.snapshot->>'resourceKey'
            AND s.source->'resource'->>'fileChecksum'=r."appleFingerprint"
            AND s.source->'resource'->>'fileChecksum'=r.snapshot->>'sourceChecksum'
            AND s.fingerprint=r.snapshot->>'fingerprint'
            AND s.source->>'sourceMasterId'=r."cplMasterRecordName"
            AND (CASE s.role WHEN 'original' THEN 'original' WHEN 'motion' THEN 'live-motion' WHEN 'raw' THEN 'raw-alternate' END)=r.role
            AND ar.revision=r.snapshot->>'sourceRevision' AND mr.revision=r.snapshot->>'masterRevision'
            AND i."ownerId"=r."ownerId" AND i."assetId"=r."assetId" AND i.sha256=r."expectedSha256"
            AND i."cplAssetRecordName"=r."cplAssetRecordName" AND i."cplMasterRecordName"=r."cplMasterRecordName"
            AND i.role=r.role AND i."editVersion"='' AND i."deliveredBy" LIKE 'device:%'
            AND (i."libraryKey" IS NULL OR i."libraryKey"=r."libraryKey")
            AND i."lastAuditResult" IS DISTINCT FROM 'mismatch'
            AND a."ownerId"=r."ownerId" AND a."deletedAt" IS NULL AND a.status=${AssetStatus.Active}
            AND a.type::text=s.source->>'type'
            AND NOT a."isExternal" AND NOT a."isOffline" AND (a."libraryId" IS NULL OR l.id IS NOT NULL)
            AND a."originalPath"=r.snapshot->>'originalPath'
            AND encode(a.checksum,'hex')=r.snapshot->>'checksum'
            AND a."checksumAlgorithm"::text IS NOT DISTINCT FROM r.snapshot->>'algorithm'
            AND (to_jsonb(a)->>'physicalOriginalFileId') IS NOT DISTINCT FROM r.snapshot->>'physicalId'
            AND (a."physicalOriginalFileId" IS NULL OR p.path=a."originalPath"),false) AS current
        FROM public.icloud_identity_reuse r
        LEFT JOIN public.icloud_resource s ON s.id=r."sourceResourceId"
        LEFT JOIN public.icloud_record ar ON ar."connectionId"=r."connectionId" AND ar."libraryKey"=r."libraryKey"
          AND ar."recordId"=s."sourceAssetId" AND NOT ar.deleted
        LEFT JOIN public.icloud_record mr ON mr."connectionId"=r."connectionId" AND mr."libraryKey"=r."libraryKey"
          AND mr."recordId"=r."cplMasterRecordName" AND NOT mr.deleted
        LEFT JOIN public.icloud_source_identity i ON i.id=r."identityId"
        LEFT JOIN public.asset a ON a.id=r."assetId"
        LEFT JOIN public.library l ON l.id=a."libraryId" AND l."deletedAt" IS NULL
        LEFT JOIN public.physical_file p ON p.id=a."physicalOriginalFileId"
        WHERE r."ownerId"=${ownerId}::uuid AND r."connectionId"=${connectionId}::uuid
          AND (${cursor}::uuid IS NULL OR r.id>${cursor}::uuid) ORDER BY r.id LIMIT 256`.execute(db);
          if (rows.length === 0) {
            break;
          }
          const staged = rows.map((row) => {
            const source = row.source;
            const cloud = parseCloudIdentifier(String(row.identity?.cloudIdentifier ?? ''));
            const current =
              row.current &&
              !!cloud &&
              cloud.cplAssetRecordName === row.receipt.cplAssetRecordName &&
              cloud.cplMasterRecordName === row.receipt.cplMasterRecordName &&
              !!source &&
              !!row.assetRecord &&
              !!row.masterRecord &&
              resourcesForICloudAsset(row.assetRecord, row.masterRecord).some(
                (descriptor) =>
                  descriptor.recordId === source.recordId &&
                  descriptor.resourceKey === source.resourceKey &&
                  descriptor.role === source.role &&
                  descriptor.fingerprint === source.fingerprint &&
                  descriptor.expectedSize === source.expectedSize &&
                  descriptor.source.type === source.source.type &&
                  descriptor.source.isHidden === source.source.isHidden &&
                  canonicalJson(descriptor.source.resource) === canonicalJson(source.source.resource),
              );
            // Classification changes updateId without replacing the original. Freeze the current
            // updateId in original; keep the adoption-time path/checksum/file evidence in receipt.
            const bindings = {
              receipt: { ...row.receipt, snapshot: row.snapshot },
              source: { resource: source, assetRecord: row.assetRecord, masterRecord: row.masterRecord },
              identity: row.identity,
              original: row.original,
            };
            const resourceRoleKey = canonicalJson([row.sourceResourceId, row.role]);
            const rank = createHmac('sha256', seed)
              .update(
                canonicalJson([
                  'icloud-weekly-resource-v1',
                  ownerId,
                  connectionId,
                  clock.weekStart,
                  row.id,
                  row.sourceResourceId,
                  row.role,
                ]),
              )
              .digest();
            const ordinal = count++;
            population += Number(current);
            manifest.update(canonicalJson([ordinal, row.id, resourceRoleKey, current, bindings]) + '\n');
            return {
              receiptId: row.id,
              resourceRoleKey,
              ordinal,
              rank: rank.toString('hex'),
              expectedSha256: row.expectedSha256.toString('hex'),
              bindings,
              current,
              executable: row.executable,
            };
          });
          await sql`INSERT INTO pg_temp.icloud_weekly_freeze
          SELECT "receiptId"::uuid,"resourceRoleKey",ordinal,decode(rank,'hex'),decode("expectedSha256",'hex'),bindings,current,executable
          FROM jsonb_to_recordset(${JSON.stringify(staged)}::text::jsonb) AS x("receiptId" text,"resourceRoleKey" text,ordinal bigint,
            rank text,"expectedSha256" text,bindings jsonb,current boolean,executable boolean)`.execute(db);
          cursor = rows.at(-1)!.id;
        }
        const {
          rows: [totals],
        } = await sql<{ count: string; population: string }>`SELECT count(*)::text AS count,
        count(*) FILTER (WHERE current)::text AS population FROM pg_temp.icloud_weekly_freeze`.execute(db);
        if (BigInt(totals.count) !== BigInt(count) || BigInt(totals.population) !== BigInt(population)) {
          throw new Error('weekly_population_inconsistent');
        }
        const selectedCount = Math.ceil(population / 100);
        const {
          rows: [selection],
        } = await sql<{ unavailable: string }>`SELECT count(*) FILTER (WHERE NOT executable)::text AS unavailable
        FROM (SELECT executable FROM pg_temp.icloud_weekly_freeze WHERE current ORDER BY rank,"receiptId" LIMIT ${selectedCount}) s`.execute(
          db,
        );
        const unavailableCount = Number(selection.unavailable);
        const {
          rows: [cohort],
        } = await sql<ICloudWeeklyCohort>`INSERT INTO public.icloud_weekly_cohort
        ("ownerId","connectionId","weekStart","grantId","grantGeneration","configFingerprint","privacyFingerprint",
          seed,"manifestDigest","populationCount","staleCount","selectedCount","unavailableCount",status)
        VALUES (${ownerId}::uuid,${connectionId}::uuid,${clock.weekStart}::date,${context.grant?.id ?? null}::uuid,
          ${context.grant?.generation ?? null},${context.configFingerprint},${context.privacyFingerprint},${seed},
          ${manifest.digest()},${population},${count - population},${selectedCount},${unavailableCount},
          ${selectedCount === unavailableCount ? 'settled' : 'frozen'}) RETURNING *,"weekStart"::text AS "weekStart"`.execute(
          db,
        );
        await sql`WITH chosen AS (SELECT "receiptId",(row_number() OVER (ORDER BY rank,"receiptId")-1)/100 AS batch
          FROM pg_temp.icloud_weekly_freeze WHERE current ORDER BY rank,"receiptId" LIMIT ${selectedCount})
        INSERT INTO public.icloud_weekly_member
          ("cohortId","ownerId","connectionId","receiptId","resourceRoleKey",ordinal,rank,selected,"batchOrdinal",
            "grantId","grantGeneration","expectedSha256",bindings,"technicalEligibility",outcome)
        SELECT ${cohort.id}::uuid,${ownerId}::uuid,${connectionId}::uuid,s."receiptId",s."resourceRoleKey",s.ordinal,s.rank,
          c."receiptId" IS NOT NULL,c.batch,${context.grant?.id ?? null}::uuid,${context.grant?.generation ?? null},
          s."expectedSha256",s.bindings,CASE WHEN s.current THEN 'current' ELSE 'stale' END,
          CASE WHEN c."receiptId" IS NOT NULL AND NOT s.executable THEN 'unavailable' ELSE 'pending' END
        FROM pg_temp.icloud_weekly_freeze s LEFT JOIN chosen c USING ("receiptId")`.execute(db);
        return cohort;
      });
  }

  /** Durable outbox row, audits, member bindings and cursor either all commit or all roll back. */
  async createNextBatch(cohortId: string, operations: MediaOperationRepository): Promise<MediaOperation | null> {
    try {
      const { operation } = await operations.createWithin(
        async (db) => {
          const { cohort, context } = await this.lockCohort(db, cohortId);
          if (!this.sameAuthority(cohort, context)) {
            throw new WeeklyNoBatch(true);
          }
          // The existing owner/connection locks serialize this check with another producer or run admission.
          const { rows: active } = await sql`SELECT 1 FROM public.media_operation
            WHERE "ownerId"=${cohort.ownerId}::uuid AND kind=${MediaOperationKind.ICloudSync}
              AND snapshot->>'connectionId'=${cohort.connectionId}
              AND status=ANY(${[...ACTIVE_MEDIA_OPERATION_STATUSES]}::text[]) LIMIT 1`.execute(db);
          if (active.length > 0) {
            throw new WeeklyNoBatch(false);
          }
          const { rows: members } = await sql<WeeklyBatchMember>`SELECT * FROM public.icloud_weekly_member
          WHERE "cohortId"=${cohortId}::uuid AND selected AND outcome='pending' AND "auditRequestId" IS NULL AND "batchOrdinal"=(
            SELECT min("batchOrdinal") FROM public.icloud_weekly_member WHERE "cohortId"=${cohortId}::uuid
              AND selected AND outcome='pending' AND "auditRequestId" IS NULL AND "batchOrdinal">=${cohort.nextBatch})
          ORDER BY ordinal FOR UPDATE`.execute(db);
          if (cohort.status === 'settled' || members.length === 0) {
            throw new WeeklyNoBatch(false);
          }
          if (
            members.length > 100 ||
            members.some((member) => member.outcome !== 'pending' || member.auditRequestId !== null)
          ) {
            throw new Error('weekly_batch_inconsistent');
          }
          const batchOrdinal = members[0].batchOrdinal;
          const auditIds: string[] = [];
          for (const member of members) {
            const receipt = member.bindings.receipt;
            const snapshot = receipt.snapshot;
            if (member.grantId !== cohort.grantId || member.grantGeneration !== cohort.grantGeneration) {
              throw new Error('weekly_member_authority_inconsistent');
            }
            const id = randomUUID();
            await sql`INSERT INTO public.icloud_identity_audit
            (id,"ownerId","connectionId","sessionId",purpose,"identityId","originalAssetId","sourceResourceId",
              "expectedSha256",snapshot,"grantId","grantGeneration","cohortId","memberOrdinal","batchOrdinal")
            VALUES (${id}::uuid,${cohort.ownerId}::uuid,${cohort.connectionId}::uuid,NULL,'scheduled-weekly',
              ${receipt.identityId}::uuid,${receipt.assetId}::uuid,${receipt.sourceResourceId}::uuid,${member.expectedSha256},
              ${JSON.stringify({ ...snapshot, updateId: member.bindings.original.updateId, config: canonicalJson(context.connection.config) })}::text::jsonb,${cohort.grantId}::uuid,
              ${cohort.grantGeneration},${cohortId}::uuid,${member.ordinal},${batchOrdinal})`.execute(db);
            auditIds.push(id);
          }
          return {
            value: { cohort, members, auditIds, batchOrdinal },
            operation: {
              ownerId: cohort.ownerId,
              kind: MediaOperationKind.ICloudSync,
              destination: MediaOperationDestination.Local,
              destinationDetail: null,
              label: 'Verify iCloud originals',
              assetId: null,
              resultAssetId: null,
              retryOfId: null,
              projectId: null,
              revisionId: null,
              snapshot: {
                task: 'identity-audit-weekly',
                purpose: 'scheduled-weekly',
                connectionId: cohort.connectionId,
                cohortId,
                grantId: cohort.grantId,
                grantGeneration: cohort.grantGeneration,
                batchOrdinal,
                auditIds,
              },
              settings: {},
              estimate: null,
              result: {},
              totalUnits: auditIds.length,
            },
          };
        },
        async (db, created, { cohort, members, auditIds, batchOrdinal }) => {
          const audits = await sql`UPDATE public.icloud_identity_audit SET "operationId"=${created.id}::uuid
          WHERE id=ANY(${auditIds}::uuid[]) AND "cohortId"=${cohortId}::uuid AND "operationId" IS NULL
          RETURNING id`.execute(db);
          if (audits.rows.length !== members.length) {
            throw new Error('weekly_audit_binding_inconsistent');
          }
          for (const [index, member] of members.entries()) {
            const bound = await sql`UPDATE public.icloud_weekly_member SET "auditRequestId"=${auditIds[index]}::uuid
            WHERE "cohortId"=${cohortId}::uuid AND ordinal=${member.ordinal} AND outcome='pending'
              AND "auditRequestId" IS NULL RETURNING ordinal`.execute(db);
            if (bound.rows.length !== 1) {
              throw new Error('weekly_member_binding_inconsistent');
            }
          }
          const advanced =
            await sql`UPDATE public.icloud_weekly_cohort SET "nextBatch"=${batchOrdinal + 1},status='running'
          WHERE id=${cohortId}::uuid AND "nextBatch"=${cohort.nextBatch} AND status IN ('frozen','running') RETURNING id`.execute(
              db,
            );
          if (advanced.rows.length !== 1) {
            throw new Error('weekly_cursor_inconsistent');
          }
        },
      );
      return operation;
    } catch (error) {
      if (!(error instanceof WeeklyNoBatch)) {
        throw error;
      }
      if (error.retired) {
        await this.settleUnavailable(cohortId);
      }
      return null;
    }
  }

  /** Retirement settles pending obligations without changing their frozen generation or audit binding. */
  async settleUnavailable(cohortId: string): Promise<void> {
    await this.db.transaction().execute(async (db) => {
      const { cohort, context } = await this.lockCohort(db, cohortId);
      if (this.sameAuthority(cohort, context)) {
        return;
      }
      await sql`SELECT ordinal FROM public.icloud_weekly_member WHERE "cohortId"=${cohortId}::uuid
        AND selected AND outcome='pending' ORDER BY ordinal FOR UPDATE`.execute(db);
      // Bound queued/running audits cannot acquire comparison authority after retirement. This
      // terminal result is not a verification stamp, and no actual operation binding is erased.
      await sql`UPDATE public.icloud_identity_audit a SET result='stale',"lastError"='weekly_authority_unavailable'
        FROM public.icloud_weekly_member m
        WHERE m."cohortId"=${cohortId}::uuid AND m.selected AND m.outcome='pending' AND m."auditRequestId"=a.id
          AND a.purpose='scheduled-weekly' AND a."cohortId"=m."cohortId" AND a."memberOrdinal"=m.ordinal
          AND a."grantId"=m."grantId" AND a."grantGeneration"=m."grantGeneration"
          AND a.result IN ('queued','running')`.execute(db);
      const { rows } = await sql`UPDATE public.icloud_weekly_member SET outcome='unavailable'
        WHERE "cohortId"=${cohortId}::uuid AND selected AND outcome='pending'
        RETURNING ordinal`.execute(db);
      await sql`UPDATE public.icloud_weekly_cohort SET "unavailableCount"="unavailableCount"+${rows.length},
        status=CASE WHEN "performedCount"+"unavailableCount"+${rows.length}+"cancelledCount"="selectedCount"
          THEN 'settled' ELSE status END WHERE id=${cohort.id}::uuid`.execute(db);
    });
  }

  private sameAuthority(cohort: ICloudWeeklyCohort, context: WeeklyContext): boolean {
    return (
      context.available &&
      cohort.grantId === context.grant?.id &&
      cohort.grantGeneration === context.grant?.generation &&
      cohort.configFingerprint === context.configFingerprint &&
      cohort.privacyFingerprint === context.privacyFingerprint
    );
  }

  private async lockCohort(db: Transaction<DB>, cohortId: string) {
    // Hints identify the owner prefix only. The authoritative row is reselected after that prefix.
    const {
      rows: [hint],
    } = await sql<{ ownerId: string; connectionId: string }>`SELECT "ownerId","connectionId"
      FROM public.icloud_weekly_cohort WHERE id=${cohortId}::uuid`.execute(db);
    if (!hint) {
      throw new NotFoundException();
    }
    const context = await this.lockContext(db, hint.ownerId, hint.connectionId, true);
    const {
      rows: [cohort],
    } = await sql<ICloudWeeklyCohort>`SELECT *,"weekStart"::text AS "weekStart" FROM public.icloud_weekly_cohort
      WHERE id=${cohortId}::uuid AND "ownerId"=${hint.ownerId}::uuid AND "connectionId"=${hint.connectionId}::uuid
      FOR UPDATE`.execute(db);
    if (!cohort) {
      throw new NotFoundException();
    }
    return { cohort, context };
  }

  private async lockContext(
    db: Transaction<DB>,
    ownerId: string,
    connectionId: string,
    allowRemoved = false,
  ): Promise<WeeklyContext> {
    await lockAuditOwner(db, ownerId, undefined, allowRemoved);
    const owner = await db
      .selectFrom('user')
      .select(['pinCode', 'deletedAt'])
      .where('id', '=', ownerId)
      .executeTakeFirst();
    if (owner) {
      await sql`INSERT INTO public.user_metadata ("userId",key,value)
      VALUES (${ownerId}::uuid,${UserMetadataKey.Preferences},'{}'::jsonb) ON CONFLICT ("userId",key) DO NOTHING`.execute(
        db,
      );
    }
    const {
      rows: [metadata],
    } = await sql<{ privacy: unknown }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
      FROM public.user_metadata WHERE "userId"=${ownerId}::uuid AND key=${UserMetadataKey.Preferences} FOR SHARE`.execute(
      db,
    );
    const {
      rows: [connection],
    } = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
      WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid FOR SHARE`.execute(db);
    if (!connection) {
      throw new NotFoundException();
    }
    const {
      rows: [grant],
    } = await sql<Grant>`SELECT * FROM public.icloud_weekly_grant
      WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid FOR SHARE`.execute(db);
    const configFingerprint = fingerprint(connection.config);
    const privacyFingerprint = fingerprint(metadata?.privacy ?? {});
    const available =
      !!owner &&
      !owner.deletedAt &&
      !!grant?.enabled &&
      connection.state === 'connected' &&
      !!connection.encryptedSession &&
      connection.lastError !== 'owner_removed' &&
      grant.configFingerprint === configFingerprint &&
      grant.privacyFingerprint === privacyFingerprint &&
      (!grant.includeProtected || (!!owner.pinCode && grant.pinBinding === pinBinding(owner.pinCode)));
    const preferences = await db
      .selectFrom('user_metadata')
      .selectAll()
      .where('userId', '=', ownerId)
      .where('key', '=', UserMetadataKey.Preferences)
      .execute();
    return {
      connection,
      grant,
      configFingerprint,
      privacyFingerprint,
      available,
      suppression: getPreferences(preferences).privacy.suppression,
    };
  }

  async status(connectionId: string, ownerId: string, db = this.db): Promise<ICloudIdentityReuseAuthorityStatusDto> {
    const connection = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
      WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(db);
    const owner = await db
      .selectFrom('user')
      .select(['pinCode', 'deletedAt'])
      .where('id', '=', ownerId)
      .executeTakeFirst();
    const {
      rows: [metadata],
    } = await sql<{
      privacy: unknown;
    }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
      FROM public.user_metadata WHERE "userId"=${ownerId}::uuid AND key=${UserMetadataKey.Preferences}`.execute(db);
    const grant = await sql<Grant>`SELECT * FROM public.icloud_weekly_grant
      WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid`.execute(db);
    const current = grant.rows[0];
    const connected = connection.rows[0];
    const privacy = metadata?.privacy ?? {};
    const available =
      !!current?.enabled &&
      !!owner &&
      !owner.deletedAt &&
      !!connected &&
      connected.state === 'connected' &&
      !!connected.encryptedSession &&
      connected.lastError !== 'owner_removed' &&
      current.configFingerprint === fingerprint(connected.config) &&
      current.privacyFingerprint === fingerprint(privacy) &&
      (!current.includeProtected || (!!owner.pinCode && current.pinBinding === pinBinding(owner.pinCode)));
    return {
      enabled: !!current?.enabled,
      includeProtected: !!current?.includeProtected,
      available,
      regrantRequired: !!current && !available,
      executionAvailable: false,
    };
  }
  async setAuthority(
    auth: AuthDto,
    connectionId: string,
    input: ICloudIdentityReuseAuthorityDto,
  ): Promise<ICloudIdentityReuseAuthorityStatusDto> {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new ForbiddenException('A current owner session is required');
    }
    // UUID equality is case-insensitive in PostgreSQL; the private replay ledger uses that identity.
    const requestKey = input.requestKey.toLowerCase();
    return this.db.transaction().execute(async (db) => {
      // Every input row precedes grant. Retirement triggers take only the affected grant rows,
      // never an earlier input lock; rollback restores both changed input and retirement.
      await lockAuditOwner(db, auth.user.id);
      await db
        .selectFrom('session')
        .select('id')
        .where('id', '=', auth.session!.id)
        .where('userId', '=', auth.user.id)
        .forShare()
        .executeTakeFirst();
      const owner = await db
        .selectFrom('user')
        .select('pinCode')
        .where('id', '=', auth.user.id)
        .executeTakeFirstOrThrow();
      // Materialize the ordinary empty preference row if absent, so INSERT/DELETE races
      // cannot pass through a missing-row lock gap. Existing preferences are never overwritten.
      await sql`INSERT INTO public.user_metadata ("userId",key,value)
        VALUES (${auth.user.id}::uuid,${UserMetadataKey.Preferences},'{}'::jsonb)
        ON CONFLICT ("userId",key) DO NOTHING`.execute(db);
      const {
        rows: [metadata],
      } = await sql<{
        privacy: unknown;
      }>`SELECT coalesce(value->'privacy','{}'::jsonb) AS privacy
        FROM public.user_metadata WHERE "userId"=${auth.user.id}::uuid AND key=${UserMetadataKey.Preferences} FOR SHARE`.execute(
        db,
      );
      const {
        rows: [connection],
      } = await sql<ICloudConnection>`SELECT * FROM public.icloud_connection
        WHERE id=${connectionId}::uuid AND "ownerId"=${auth.user.id}::uuid FOR UPDATE`.execute(db);
      if (!connection) {
        throw new NotFoundException();
      }
      if (
        input.enabled &&
        (connection.state !== 'connected' || !connection.encryptedSession || connection.lastError === 'owner_removed')
      ) {
        throw new ConflictException('Connect this account before granting consent');
      }
      const configFingerprint = fingerprint(connection.config);
      const privacyFingerprint = fingerprint(metadata.privacy);
      const binding = input.includeProtected ? pinBinding(owner.pinCode) : null;
      const inputFingerprint = fingerprint({
        enabled: input.enabled,
        includeProtected: input.includeProtected,
        configFingerprint,
        privacyFingerprint,
        binding,
      });
      const {
        rows: [grant],
      } = await sql<Grant>`SELECT * FROM public.icloud_weekly_grant
        WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${auth.user.id}::uuid FOR UPDATE`.execute(db);
      const { rows: live } = await sql`SELECT id FROM public.session WHERE id=${auth.session!.id}::uuid
        AND "userId"=${auth.user.id}::uuid AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
        AND (${!input.includeProtected} OR (${owner.pinCode !== null} AND "pinExpiresAt">clock_timestamp()))`.execute(
        db,
      );
      if (live.length !== 1) {
        throw new ForbiddenException('Current session and PIN authority are required');
      }
      if (grant?.requestHistory[requestKey]) {
        const status = await this.status(connectionId, auth.user.id, db);
        if (
          grant.requestKey !== requestKey ||
          grant.inputFingerprint !== inputFingerprint ||
          grant.enabled !== input.enabled ||
          (input.enabled && !status.available)
        ) {
          throw new ConflictException('Consent changed; submit a new explicit choice');
        }
        // Replay does not mint authority, but still requires a live session at its final admission.
        const replay = await sql`SELECT id FROM public.session WHERE id=${auth.session!.id}::uuid
          AND "userId"=${auth.user.id}::uuid AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp())
          AND (${!input.includeProtected} OR (${owner.pinCode !== null} AND "pinExpiresAt">clock_timestamp()))`.execute(
          db,
        );
        if (replay.rows.length !== 1) {
          throw new ForbiddenException('Current session and PIN authority are required');
        }
        return status;
      }
      const history = { ...grant?.requestHistory, [requestKey]: inputFingerprint };
      const result = await sql`INSERT INTO public.icloud_weekly_grant
        ("ownerId","connectionId",generation,enabled,"includeProtected","configFingerprint","privacyFingerprint",
          "pinBinding","requestKey","inputFingerprint","requestHistory","revokedAt")
        SELECT ${auth.user.id}::uuid,${connectionId}::uuid,1,${input.enabled},${input.includeProtected},${configFingerprint},
          ${privacyFingerprint},${binding},${requestKey}::uuid,${inputFingerprint},${history}::jsonb,
          CASE WHEN ${input.enabled} THEN NULL ELSE clock_timestamp() END
        FROM public.session s JOIN public.user u ON u.id=s."userId"
        WHERE s.id=${auth.session!.id}::uuid AND u.id=${auth.user.id}::uuid AND u."deletedAt" IS NULL
          AND (s."expiresAt" IS NULL OR s."expiresAt">clock_timestamp())
          AND (${!input.includeProtected} OR (u."pinCode" IS NOT NULL AND s."pinExpiresAt">clock_timestamp()))
        ON CONFLICT("connectionId","ownerId") DO UPDATE SET generation=public.icloud_weekly_grant.generation+1,
          enabled=excluded.enabled,"includeProtected"=excluded."includeProtected","configFingerprint"=excluded."configFingerprint",
          "privacyFingerprint"=excluded."privacyFingerprint","pinBinding"=excluded."pinBinding","requestKey"=excluded."requestKey",
          "inputFingerprint"=excluded."inputFingerprint","requestHistory"=excluded."requestHistory","revokedAt"=excluded."revokedAt"
        RETURNING id`.execute(db);
      if (result.rows.length !== 1) {
        throw new ForbiddenException('Consent authority expired');
      }
      return this.status(connectionId, auth.user.id, db);
    });
  }
}
