import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { ICloudConfig } from 'src/dtos/icloud-sync.dto.js';
import type { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { MediaOperationDestination, MediaOperationKind, NotificationLevel, NotificationType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { parseICloudAlbum, resourcesForICloudAsset, sanitizeICloudFields } from 'src/utils/icloud-records.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';

export type ICloudLibrary = {
  area: 'private' | 'shared';
  zoneID: { zoneName: string; ownerRecordName?: string; zoneType?: string };
};
export type ICloudConnection = {
  id: string;
  ownerId: string;
  label: string;
  state: string;
  config: ICloudConfig;
  encryptedSession: string | null;
  lastError: string | null;
  nextRunAt: Date | null;
};
export type ICloudResource = {
  id: string;
  connectionId: string;
  ownerId: string;
  libraryKey: string;
  library: ICloudLibrary;
  sourceAssetId: string;
  recordId: string;
  resourceKey: string;
  role: string;
  fingerprint: string;
  source: Record<string, unknown>;
  expectedSize: number;
  status: string;
  sha1: Buffer | null;
  sha256: Buffer | null;
  assetId: string | null;
  path: string | null;
  stagingPath: string | null;
  promotedPath: string | null;
  expectedTarget: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  pendingJobs: Array<{ name: string; data: { id: string; source?: string } }>;
  attempts: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  reservedBytes: number;
  lastError: string | null;
};
/** Why a run was queued (FL-68). Recorded on the run's snapshot, never used to authorize anything. */
export type ICloudRunTrigger = 'schedule' | 'manual' | 'authenticated' | 'retry' | 'rescan';

/**
 * What asking for a run did (FL-68).
 *
 * - `created`: a new durable run was queued.
 * - `existing`: the connection already had an unfinished run; that one is the answer.
 * - `busy`: a retry or rescan was asked for while a run is unfinished (`operation`). Both rewrite the
 *   checkpoints the running one is reading, so they wait for it to finish or be cancelled.
 * - `not-ready`: the connection is not signed in (or is waiting for verification).
 * - `not-due`: a scheduled run found the connection not due yet.
 * - `not-found`: no such connection for this owner, or it was disconnected.
 */
export type ICloudRunQueueResult =
  | { outcome: 'created' | 'existing' | 'busy'; operation: MediaOperation }
  | { outcome: 'not-ready' | 'not-due' | 'not-found' };

/** What removing a disconnected connection did (FL-68). */
export type ICloudRemoveResult = 'removed' | 'not-found' | 'still-connected' | 'busy' | 'in-flight';

/** One reconciliation finding a person may need to look at (FL-68). */
export type ICloudReviewItem = {
  resourceId: string;
  kind: 'review' | 'failed' | 'unsupported' | 'kept-trashed' | 'source-removed';
  reason: string | null;
  fileName: string | null;
  role: string;
  assetId: string | null;
};

/** Connection states a run may start from, by trigger. Anything else needs the account first. */
const RUNNABLE_STATES: Record<ICloudRunTrigger, readonly string[]> = {
  schedule: ['connected'],
  authenticated: ['connected'],
  // `paused` is where the Pause control of the first release left a connection, session intact.
  manual: ['connected', 'paused'],
  retry: ['connected', 'paused', 'error'],
  rescan: ['connected', 'paused', 'error'],
};

export type ICloudRecord = {
  recordName: string;
  recordType?: string;
  recordChangeTag?: string;
  fields?: Record<string, unknown>;
  deleted?: boolean;
};

@Injectable()
export class ICloudSyncRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  async active<T>(callback: (db: Kysely<DB>) => Promise<T>, transaction?: Kysely<DB>): Promise<T> {
    if (transaction) {
      return callback(transaction);
    }
    return this.db.transaction().execute(async (db) => {
      const state = await sql<{ phase: string }>`SELECT phase FROM immich_fork.state WHERE id = 1 FOR SHARE`.execute(
        db,
      );
      if (!state.rows[0] || state.rows[0].phase === 'inactive') {
        throw new Error('icloud_fork_inactive');
      }
      const handoff = await sql`SELECT 1 FROM immich_fork.migration_audit WHERE status = 'running'
        AND name IN ('official-handoff-preparation', 'fork-return-reconciliation') LIMIT 1`.execute(db);
      if (handoff.rows.length > 0) {
        throw new Error('icloud_fork_handoff');
      }
      return callback(db);
    });
  }

  async list(ownerId: string): Promise<ICloudConnection[]> {
    return await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection WHERE "ownerId" = ${ownerId}::uuid ORDER BY "createdAt"`
      .execute(this.db)
      .then((result) => result.rows);
  }

  async get(id: string, ownerId?: string): Promise<ICloudConnection | undefined> {
    return await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection WHERE id = ${id}::uuid
      ${ownerId ? sql`AND "ownerId" = ${ownerId}::uuid` : sql``}`
      .execute(this.db)
      .then((result) => result.rows[0]);
  }

  /**
   * Add a connection, or answer undefined when the owner already has `limit` (FL-68). The count and
   * the insert share one per-owner lock, so two requests at once cannot both take the last place.
   */
  async create(
    ownerId: string,
    label: string,
    config: ICloudConfig,
    limit: number = Number.MAX_SAFE_INTEGER,
  ): Promise<ICloudConnection | undefined> {
    return this.active(async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`icloud-connections:${ownerId}`}, 0))`.execute(db);
      const { rows } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM immich_fork.icloud_connection
        WHERE "ownerId" = ${ownerId}::uuid`.execute(db);
      if ((rows[0]?.count ?? 0) >= limit) {
        return;
      }
      return await sql<ICloudConnection>`INSERT INTO immich_fork.icloud_connection ("ownerId", label, config)
      VALUES (${ownerId}::uuid, ${label}, ${config}::jsonb) RETURNING *`
        .execute(db)
        .then((result) => result.rows[0]);
    });
  }

  async update(
    id: string,
    ownerId: string,
    update: Partial<
      Pick<ICloudConnection, 'label' | 'state' | 'config' | 'lastError' | 'nextRunAt' | 'encryptedSession'>
    >,
  ): Promise<void> {
    const entries = Object.entries(update).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      return;
    }
    await this.active(async (db) => {
      const { rows: changed } = await sql`UPDATE immich_fork.icloud_connection SET ${sql.join(
        entries.map(([key, value]) => sql`${sql.id(key)} = ${key === 'config' ? sql`${value}::jsonb` : sql`${value}`}`),
      )}, "updatedAt" = now()
        WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid AND "lastError" IS DISTINCT FROM 'owner_removed' RETURNING id`.execute(
        db,
      );
      if (changed.length === 0) {
        return;
      }
      if (update.config) {
        await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":false}'::jsonb,
          "leaseToken"=NULL,"leaseExpiresAt"=NULL WHERE "connectionId"=${id}::uuid AND "ownerId"=${ownerId}::uuid AND status<>'committed'`.execute(
          db,
        );
        await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${id}::uuid`.execute(db);
      }
    });
  }

  async withSession<T>(
    id: string,
    ownerId: string,
    callback: (
      connection: ICloudConnection,
      db: Kysely<DB>,
    ) => Promise<{ value: T; encryptedSession?: string; state?: string }>,
  ): Promise<T> {
    return this.active(async (db) => {
      const rows = await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection WHERE id = ${id}::uuid
        AND "ownerId" = ${ownerId}::uuid AND "lastError" IS DISTINCT FROM 'owner_removed' FOR UPDATE`.execute(db);
      const connection = rows.rows[0];
      if (!connection) {
        throw new Error('icloud_connection_not_found');
      }
      const result = await callback(connection, db);
      await sql`UPDATE immich_fork.icloud_connection SET "encryptedSession" = ${result.encryptedSession ?? connection.encryptedSession},
        state = ${result.state ?? connection.state}, "updatedAt" = now() WHERE id = ${id}::uuid`.execute(db);
      return result.value;
    });
  }

  async admitAuth(id: string, ownerId: string): Promise<boolean> {
    return this.active(
      async (db) =>
        (await sql`UPDATE immich_fork.icloud_connection
      SET "authAttempts" = CASE WHEN "authRetryAt" < now() THEN 1 ELSE "authAttempts" + 1 END,
        "authRetryAt" = CASE WHEN "authRetryAt" IS NULL OR "authRetryAt" < now() THEN now() + interval '15 minutes' ELSE "authRetryAt" END
      WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid
        AND ("authAttempts" < 5 OR "authRetryAt" < now()) RETURNING id`
          .execute(db)
          .then((result) => result.rows.length)) > 0,
    );
  }

  async disconnect(id: string, ownerId: string): Promise<void> {
    await this.active(async (db) => {
      await sql`UPDATE immich_fork.icloud_connection SET state = 'disconnected', "encryptedSession" = NULL, "nextRunAt" = NULL,
        "updatedAt" = now() WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid`.execute(db);
      await sql`UPDATE immich_fork.icloud_resource SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, "updatedAt" = now()
        WHERE "connectionId" = ${id}::uuid AND "ownerId" = ${ownerId}::uuid AND status NOT IN ('committed', 'finalized', 'removed')`.execute(
        db,
      );
    });
  }

  async startRun(connection: ICloudConnection): Promise<void> {
    await this.active(async (db) => {
      await sql`SELECT id FROM immich_fork.icloud_connection WHERE id = ${connection.id}::uuid FOR UPDATE`.execute(db);
      const created = await sql`INSERT INTO immich_fork.icloud_run ("connectionId", "ownerId", status)
        SELECT ${connection.id}::uuid, ${connection.ownerId}::uuid, 'running'
        WHERE NOT EXISTS (SELECT 1 FROM immich_fork.icloud_run WHERE "connectionId" = ${connection.id}::uuid AND status IN ('running','queued')) RETURNING id`.execute(
        db,
      );
      if (created.rows.length > 0) {
        await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${connection.id}::uuid AND scope NOT LIKE 'changes:%'`.execute(
          db,
        );
        await sql`UPDATE immich_fork.icloud_checkpoint SET complete=false WHERE "connectionId"=${connection.id}::uuid`.execute(
          db,
        );
        await sql`UPDATE immich_fork.icloud_resource SET status='pending',"expectedTarget"=NULL,"promotedPath"=NULL
          WHERE "connectionId"=${connection.id}::uuid AND status='finalized'`.execute(db);
      }
    });
  }

  async counts(connectionId: string): Promise<Record<string, number>> {
    const resources = await sql<{
      status: string;
      count: number;
    }>`SELECT status, count(*)::int AS count FROM immich_fork.icloud_resource
      WHERE "connectionId" = ${connectionId}::uuid GROUP BY status`.execute(this.db);
    const assets = await sql<{
      count: number;
    }>`SELECT count(DISTINCT ("libraryKey", "sourceAssetId"))::int AS count FROM immich_fork.icloud_resource
      WHERE "connectionId" = ${connectionId}::uuid`.execute(this.db);
    const { rows: outcomes } = await sql<{
      outcome: string;
      count: number;
    }>`SELECT verification->>'outcome' AS outcome,count(*)::int AS count
      FROM immich_fork.icloud_resource WHERE "connectionId"=${connectionId}::uuid AND verification->>'outcome' IS NOT NULL
      GROUP BY verification->>'outcome'`.execute(this.db);
    const { rows: discovered } = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM immich_fork.icloud_record
      WHERE "connectionId"=${connectionId}::uuid AND "recordType"='CPLAsset'`.execute(this.db);
    const { rows: staging } = await sql<{
      count: number;
      bytes: number;
      retainedBytes: number;
    }>`SELECT count(*) FILTER (WHERE "stagingPath" IS NOT NULL AND "reservedBytes">0)::int AS count,
      coalesce(sum("reservedBytes"),0)::float8 AS bytes,
      coalesce(sum("reservedBytes") FILTER (WHERE NOT coalesce((source->>'current')::boolean,true)),0)::float8 AS "retainedBytes"
      FROM immich_fork.icloud_resource WHERE "connectionId"=${connectionId}::uuid`.execute(this.db);
    const { rows: provenance } = await sql<{ metadata: number; review: number }>`SELECT
      count(DISTINCT "assetId") FILTER (WHERE source#>>'{_sync,metadata,status}'='applied')::int AS metadata,
      count(DISTINCT "assetId") FILTER (WHERE source#>>'{_sync,metadata,status}'='needs-review' OR source#>>'{_sync,relations,status}'='needs-review')::int AS review
      FROM immich_fork.icloud_resource WHERE "connectionId"=${connectionId}::uuid AND coalesce((source->>'current')::boolean,true)`.execute(
      this.db,
    );
    const { rows: albumCounts } = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM immich_fork.icloud_album WHERE "connectionId"=${connectionId}::uuid AND "libraryKey"<>'' AND "albumId" IS NOT NULL`.execute(
      this.db,
    );
    const { rows: sourceRemoved } = await sql<{
      count: number;
    }>`SELECT count(DISTINCT r."assetId")::int AS count FROM immich_fork.icloud_resource r JOIN asset a ON a.id=r."assetId"
      AND a."ownerId"=r."ownerId" AND a."deletedAt" IS NULL
      WHERE r."connectionId"=${connectionId}::uuid AND coalesce((r.source->>'sourceDisappeared')::boolean,false)`.execute(
      this.db,
    );
    const { rows: unsupported } = await sql<{
      count: number;
    }>`SELECT count(*)::int AS count FROM immich_fork.icloud_record
      WHERE "connectionId"=${connectionId}::uuid AND fields ? '__icloudUnsupported' AND NOT deleted`.execute(this.db);
    return {
      ...Object.fromEntries(resources.rows.map(({ status, count }) => [status, count])),
      ...Object.fromEntries(outcomes.map(({ outcome, count }) => [outcome, count])),
      logicalAssets: assets.rows[0]?.count ?? 0,
      discoveredLogicalAssets: discovered[0]?.count ?? 0,
      staged: staging[0]?.count ?? 0,
      stagingBytes: staging[0]?.bytes ?? 0,
      retainedStagingBytes: staging[0]?.retainedBytes ?? 0,
      metadata_updated: provenance[0]?.metadata ?? 0,
      album_updated: albumCounts[0]?.count ?? 0,
      // deleted in iCloud and kept here: a sync never removes local media (FL-68)
      source_removed: sourceRemoved[0]?.count ?? 0,
      'needs-review':
        (resources.rows.find(({ status }) => status === 'needs-review')?.count ?? 0) + (provenance[0]?.review ?? 0),
      unsupported:
        (resources.rows.find(({ status }) => status === 'unsupported')?.count ?? 0) + (unsupported[0]?.count ?? 0),
      resources: resources.rows.reduce((sum, row) => sum + row.count, 0),
    };
  }

  async checkpoint(
    connectionId: string,
    scope: string,
    transaction?: Kysely<DB>,
  ): Promise<{ cursor: unknown; complete: boolean; snapshotId: string } | undefined> {
    return await sql<{
      cursor: unknown;
      complete: boolean;
      snapshotId: string;
    }>`SELECT cursor, complete, "snapshotId" FROM immich_fork.icloud_checkpoint
      WHERE "connectionId" = ${connectionId}::uuid AND scope = ${scope}`
      .execute(transaction ?? this.db)
      .then((result) => result.rows[0]);
  }

  async savePage(
    connectionId: string,
    scope: string,
    libraryKey: string,
    records: ICloudRecord[],
    cursor: unknown,
    complete: boolean,
    transaction?: Kysely<DB>,
  ): Promise<void> {
    if (records.length > 1000) {
      throw new Error('icloud_page_too_large');
    }
    await this.active(async (db) => {
      const checkpoint = await this.checkpoint(connectionId, scope, db);
      const snapshotId = checkpoint?.snapshotId ?? randomUUID();
      for (const record of records) {
        if (!record.recordName || (!record.recordType && !record.deleted)) {
          throw new Error('icloud_record_invalid');
        }
        const master = record.fields?.masterRef as { value?: { recordName?: string } } | undefined;
        await sql`INSERT INTO immich_fork.icloud_record ("connectionId", "libraryKey", "recordId", "recordType", revision, "masterId", fields, deleted)
          VALUES (${connectionId}::uuid, ${libraryKey}, ${record.recordName}, ${record.recordType ?? 'CPLAsset'}, ${record.recordChangeTag ?? null},
            ${master?.value?.recordName ?? null}, ${sanitizeICloudFields({ ...record.fields, ...(scope.startsWith('assets:') && { __icloudSnapshot: snapshotId }) })}::jsonb, ${record.deleted ?? false})
          ON CONFLICT ("connectionId", "libraryKey", "recordId") DO UPDATE SET revision = excluded.revision, "masterId" = excluded."masterId",
            "recordType" = CASE WHEN excluded.deleted THEN immich_fork.icloud_record."recordType" ELSE excluded."recordType" END, fields = excluded.fields, deleted = excluded.deleted, "updatedAt" = now()`.execute(
          db,
        );
        if (record.deleted) {
          await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":false,"sourceDisappeared":true}'::jsonb
            WHERE "connectionId"=${connectionId}::uuid AND "libraryKey"=${libraryKey} AND "sourceAssetId"=${record.recordName}`.execute(
            db,
          );
        }
      }
      if (complete && scope.startsWith('assets:')) {
        await sql`UPDATE immich_fork.icloud_record SET deleted=true WHERE "connectionId"=${connectionId}::uuid AND "libraryKey"=${libraryKey}
          AND "recordType" IN ('CPLAsset','CPLMaster') AND fields->>'__icloudSnapshot' IS DISTINCT FROM ${snapshotId}`.execute(
          db,
        );
        await sql`UPDATE immich_fork.icloud_resource r SET source=r.source || '{"current":false,"sourceDisappeared":true}'::jsonb
          WHERE r."connectionId"=${connectionId}::uuid AND r."libraryKey"=${libraryKey}
            AND EXISTS (SELECT 1 FROM immich_fork.icloud_record a WHERE a."connectionId"=r."connectionId" AND a."libraryKey"=r."libraryKey"
              AND a."recordId"=r."sourceAssetId" AND a.deleted)`.execute(db);
      }
      await sql`INSERT INTO immich_fork.icloud_checkpoint ("connectionId", scope, cursor, complete, "snapshotId")
        VALUES (${connectionId}::uuid, ${scope}, ${cursor ?? null}::jsonb, ${complete}, ${snapshotId}::uuid)
        ON CONFLICT ("connectionId", scope) DO UPDATE SET cursor = excluded.cursor, complete = excluded.complete, "updatedAt" = now()`.execute(
        db,
      );
    }, transaction);
  }

  async resetInventory(connectionId: string, transaction?: Kysely<DB>): Promise<void> {
    await this.active(async (db) => {
      await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId" = ${connectionId}::uuid`.execute(db);
      await this.retryFailures(connectionId, db);
      await sql`UPDATE immich_fork.icloud_resource SET status = 'pending', "attempts" = 0, "nextAttemptAt" = NULL
        WHERE "connectionId" = ${connectionId}::uuid AND status IN ('retry','failed','finalized','reused')`.execute(db);
    }, transaction);
  }

  async claim(connectionId: string, maximumBytes: number): Promise<ICloudResource | undefined> {
    return this.active(async (db) => {
      // Admission and disk reservation share one lock across accounts and workers.
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('icloud-staging-reservations',0))`.execute(db);
      const connection =
        await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection WHERE id=${connectionId}::uuid FOR UPDATE`
          .execute(db)
          .then(({ rows }) => rows[0]);
      if (!connection || connection.state !== 'connected') {
        return;
      }
      let candidate: ICloudResource | undefined;
      for (let count = 0; count < 100; count++) {
        candidate =
          await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM immich_fork.icloud_resource
          WHERE "connectionId"=${connectionId}::uuid AND status IN ('pending','retry','staging','validated','promoted','committed')
          AND (status='committed' OR coalesce((source->>'current')::boolean,true))
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<now()) AND ("nextAttemptAt" IS NULL OR "nextAttemptAt"<=now())
          ORDER BY CASE WHEN status='committed' THEN 0 ELSE 1 END,"createdAt",id FOR UPDATE SKIP LOCKED LIMIT 1`
            .execute(db)
            .then(({ rows }) => rows[0]);
        if (!candidate || candidate.status === 'committed' || !candidate.role.startsWith('edited-')) {
          break;
        }
        const retained = await sql<{
          count: number;
          known: boolean;
        }>`SELECT count(DISTINCT r.fingerprint)::int AS count,
          coalesce(bool_or(r.fingerprint=${candidate.fingerprint}),false) AS known
          FROM immich_fork.icloud_resource r WHERE r."connectionId"=${connectionId}::uuid AND r."ownerId"=${connection.ownerId}::uuid
            AND r."libraryKey"=${candidate.libraryKey} AND r."sourceAssetId"=${candidate.sourceAssetId} AND r.role IN ('edited-image','edited-video')
            AND (EXISTS(SELECT 1 FROM asset a WHERE a.id=r."assetId" AND a."ownerId"=r."ownerId")
              OR (r.status NOT IN ('finalized','reused','removed')
                AND (r."assetId" IS NULL OR r.status IN ('staging','validated','promoted','committed') OR r."reservedBytes">0)
                AND (r."reservedBytes">0 OR r."stagingPath" IS NOT NULL OR r."promotedPath" IS NOT NULL OR r.sha256 IS NOT NULL
                  OR r.status IN ('staging','validated','promoted','committed'))))`
          .execute(db)
          .then(({ rows }) => rows[0]);
        if (retained.known || retained.count < 20) {
          break;
        }
        await sql`UPDATE immich_fork.icloud_resource SET status='needs-review',"lastError"='retained_edit_limit',"leaseToken"=NULL,"leaseExpiresAt"=NULL,"nextAttemptAt"=NULL,"updatedAt"=now()
          WHERE id=${candidate.id}::uuid`.execute(db);
        candidate = undefined;
      }
      if (!candidate) {
        return;
      }
      // Committed outbox/finalization only releases storage; reduced budgets must
      // never prevent its lease from being recovered after a crash.
      if (candidate.status === 'committed') {
        return sql<ICloudResource>`UPDATE immich_fork.icloud_resource SET "leaseToken"=${randomUUID()}::uuid,"leaseExpiresAt"=now()+interval '30 minutes',"updatedAt"=now()
          WHERE id=${candidate.id}::uuid RETURNING *,"expectedSize"::float8 AS "expectedSize"`
          .execute(db)
          .then(({ rows }) => rows[0]);
      }
      const maxConcurrency = Number(process.env.IMMICH_ICLOUD_MAX_CONCURRENCY ?? 4);
      const maxStagingBytes = Number(process.env.IMMICH_ICLOUD_MAX_STAGING_BYTES ?? 100 * 1024 ** 3);
      // Match service configuration validation: malformed administrator limits deny
      // new admission. Already committed cleanup above must remain recoverable.
      if (
        !Number.isSafeInteger(maxConcurrency) ||
        maxConcurrency <= 0 ||
        !Number.isSafeInteger(maxStagingBytes) ||
        maxStagingBytes <= 0
      ) {
        return;
      }
      const used = await sql<{
        bytes: number;
        active: number;
        retained: number;
      }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS bytes,
        count(*) FILTER(WHERE "leaseExpiresAt">now())::int AS active,
        coalesce(sum("reservedBytes") FILTER(WHERE NOT coalesce((source->>'current')::boolean,true)),0)::float8 AS retained
        FROM immich_fork.icloud_resource WHERE "connectionId"=${connectionId}::uuid AND status NOT IN ('finalized','removed')`
        .execute(db)
        .then(({ rows }) => rows[0]);
      const global = await sql<{
        bytes: number;
        active: number;
        retained: number;
      }>`SELECT coalesce(sum("reservedBytes"),0)::float8 AS bytes,
        count(*) FILTER(WHERE "leaseExpiresAt">now())::int AS active,
        coalesce(sum("reservedBytes") FILTER(WHERE NOT coalesce((source->>'current')::boolean,true)),0)::float8 AS retained
        FROM immich_fork.icloud_resource WHERE status NOT IN ('finalized','removed')`
        .execute(db)
        .then(({ rows }) => rows[0]);
      if (used.active >= connection.config.concurrency || global.active >= maxConcurrency) {
        return;
      }
      if (!Number.isSafeInteger(candidate.expectedSize) || candidate.expectedSize <= 0) {
        await sql`UPDATE immich_fork.icloud_resource SET status='failed',"lastError"='staging_resource_too_large' WHERE id=${candidate.id}::uuid`.execute(
          db,
        );
        return;
      }
      const additional = Math.max(0, candidate.expectedSize - Number(candidate.reservedBytes));
      const localBlocked = additional > 0 && used.bytes + additional > maximumBytes;
      const globalBlocked = additional > 0 && global.bytes + additional > maxStagingBytes;
      if (localBlocked || globalBlocked) {
        if ((localBlocked && used.retained > 0) || (globalBlocked && global.retained > 0)) {
          await sql`UPDATE immich_fork.icloud_connection SET state='error',"lastError"='staging_retained_capacity',"nextRunAt"=NULL WHERE id=${connectionId}::uuid`.execute(
            db,
          );
        } else if (additional > maximumBytes) {
          await sql`UPDATE immich_fork.icloud_resource SET status='failed',"lastError"='staging_resource_too_large' WHERE id=${candidate.id}::uuid`.execute(
            db,
          );
        }
        return;
      }
      return sql<ICloudResource>`UPDATE immich_fork.icloud_resource SET "leaseToken"=${randomUUID()}::uuid,
        "leaseExpiresAt"=now()+interval '30 minutes',"reservedBytes"=greatest("reservedBytes","expectedSize"),"updatedAt"=now()
        WHERE id=${candidate.id}::uuid RETURNING *,"expectedSize"::float8 AS "expectedSize"`
        .execute(db)
        .then(({ rows }) => rows[0]);
    });
  }

  async progress(
    resource: ICloudResource,
    values: Partial<
      Pick<ICloudResource, 'status' | 'path' | 'stagingPath' | 'verification' | 'lastError' | 'sha1' | 'sha256'>
    >,
  ): Promise<boolean> {
    return this.active(
      async (db) =>
        (await sql`UPDATE immich_fork.icloud_resource SET
      ${sql.join(Object.entries(values).map(([key, value]) => sql`${sql.id(key)} = ${key === 'verification' ? sql`${value}::jsonb` : sql`${value}`}`))},
      "leaseExpiresAt" = now() + interval '30 minutes', "updatedAt" = now()
      WHERE id = ${resource.id}::uuid AND "leaseToken" = ${resource.leaseToken}::uuid RETURNING id`
          .execute(db)
          .then((result) => result.rows.length)) > 0,
    );
  }

  async finish(resource: ICloudResource, status: string, error: string | null = null): Promise<void> {
    const committedFailure = status === 'committed' && error !== null;
    await this.active(async (db) => {
      if (committedFailure) {
        await sql`SELECT id FROM immich_fork.icloud_connection WHERE id=${resource.connectionId}::uuid FOR UPDATE`.execute(
          db,
        );
      }
      const { rows } = await sql<{
        attempts: number;
      }>`UPDATE immich_fork.icloud_resource SET status = CASE WHEN ${status}='retry' AND attempts >= 7 THEN 'failed' ELSE ${status} END, "lastError" = ${error}, "leaseToken" = NULL,
        "leaseExpiresAt" = NULL, "attempts" = "attempts" + CASE WHEN ${status} = 'retry' OR ${committedFailure} THEN 1 ELSE 0 END,
        "nextAttemptAt" = CASE WHEN ${status} = 'retry' OR (${status}='committed' AND ${error}::text IS NOT NULL)
          THEN now() + interval '1 minute' * least(1440, power(2, "attempts" + 1)) * (0.75 + random()*0.5) ELSE NULL END,
        "reservedBytes" = CASE WHEN ${status} = 'finalized' THEN 0 ELSE "reservedBytes" END, "updatedAt" = now()
        WHERE id = ${resource.id}::uuid AND "leaseToken" = ${resource.leaseToken}::uuid RETURNING attempts`.execute(db);
      if (committedFailure && (rows[0]?.attempts ?? 0) >= 8) {
        await sql`UPDATE immich_fork.icloud_connection SET state='error',"lastError"='icloud_finalization_failed',"nextRunAt"=NULL
          WHERE id=${resource.connectionId}::uuid AND "ownerId"=${resource.ownerId}::uuid AND state='connected'`.execute(
          db,
        );
      }
    });
  }

  /**
   * Connections a scheduled run is due for (FL-68): signed in, past any provider back-off, with no
   * unfinished run and none started or finished within the connection's interval. Counting from the
   * last run's end rather than from a stored time is what keeps a run cancelled from Activity, or one
   * that failed, from being queued again five minutes later. `queueOperation` checks all of it again
   * under the connection's lock.
   */
  async dueConnections(): Promise<Array<{ id: string; ownerId: string }>> {
    return sql<{ id: string; ownerId: string }>`SELECT c.id, c."ownerId" FROM immich_fork.icloud_connection c
      WHERE c.state = 'connected' AND c."encryptedSession" IS NOT NULL AND c."lastError" IS DISTINCT FROM 'owner_removed'
        AND (c."nextRunAt" IS NULL OR c."nextRunAt" <= now())
        AND NOT EXISTS (SELECT 1 FROM media_operation o WHERE o."ownerId" = c."ownerId"
          AND o.kind = ${MediaOperationKind.ICloudSync} AND o.snapshot->>'connectionId' = c.id::text
          AND (o.status = ANY(${[...ACTIVE_MEDIA_OPERATION_STATUSES]}::text[])
            OR coalesce(o."finishedAt", o."createdAt") > now() - make_interval(hours => coalesce((c.config->>'intervalHours')::int, 24))))
      ORDER BY c."nextRunAt" NULLS FIRST, c.id LIMIT 100`
      .execute(this.db)
      .then((result) => result.rows);
  }

  /** The connection's newest run, or its unfinished one when `activeOnly` (FL-68). Owner-scoped. */
  async latestOperation(
    connectionId: string,
    ownerId: string,
    options: { activeOnly?: boolean } = {},
    transaction?: Kysely<DB>,
  ): Promise<MediaOperation | undefined> {
    let query = (transaction ?? this.db)
      .selectFrom('media_operation')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('kind', '=', MediaOperationKind.ICloudSync)
      .where(sql<string>`snapshot->>'connectionId'`, '=', connectionId);
    if (options.activeOnly) {
      query = query.where('status', 'in', [...ACTIVE_MEDIA_OPERATION_STATUSES]);
    }
    const row = await query.orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
    return row as unknown as MediaOperation | undefined;
  }

  /**
   * The one way an iCloud run is queued (FL-68), for the schedule, the connection's controls and a
   * retry from Activity alike.
   *
   * Everything happens under the connection row's lock, so two requests (or a request and the
   * schedule) can never both find the connection idle and queue two runs: a connection has at most
   * one unfinished run. A retry clears the failure back-off first and a rescan forgets the inventory
   * checkpoints, both in the same transaction as the run they start.
   */
  async queueOperation(
    connectionId: string,
    ownerId: string,
    options: { trigger: ICloudRunTrigger; retryOfId?: string | null },
  ): Promise<ICloudRunQueueResult> {
    return this.active(async (db): Promise<ICloudRunQueueResult> => {
      const connection =
        await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection WHERE id = ${connectionId}::uuid
        AND "ownerId" = ${ownerId}::uuid AND "lastError" IS DISTINCT FROM 'owner_removed' FOR UPDATE`
          .execute(db)
          .then(({ rows }) => rows[0]);
      if (!connection || connection.state === 'disconnected') {
        return { outcome: 'not-found' };
      }

      const active = await this.latestOperation(connectionId, ownerId, { activeOnly: true }, db);
      if (active) {
        return options.trigger === 'retry' || options.trigger === 'rescan'
          ? { outcome: 'busy', operation: active }
          : { outcome: 'existing', operation: active };
      }

      if (!connection.encryptedSession || !RUNNABLE_STATES[options.trigger].includes(connection.state)) {
        return { outcome: 'not-ready' };
      }

      switch (options.trigger) {
        case 'schedule': {
          const recent = await sql`SELECT 1 FROM media_operation WHERE "ownerId" = ${ownerId}::uuid
          AND kind = ${MediaOperationKind.ICloudSync} AND snapshot->>'connectionId' = ${connectionId}
          AND coalesce("finishedAt", "createdAt") > now() - make_interval(hours => ${connection.config.intervalHours}::int)
          LIMIT 1`.execute(db);
          if (
            recent.rows.length > 0 ||
            (connection.nextRunAt && new Date(connection.nextRunAt).getTime() > Date.now())
          ) {
            return { outcome: 'not-due' };
          }

          break;
        }
        case 'retry': {
          await this.retryFailures(connectionId, db);

          break;
        }
        case 'rescan': {
          await this.resetInventory(connectionId, db);

          break;
        }
        // No default
      }
      if (connection.state !== 'connected' || options.trigger === 'retry' || options.trigger === 'rescan') {
        // Asked for by the owner: the provider back-off and the last failure no longer apply.
        await sql`UPDATE immich_fork.icloud_connection SET state = 'connected', "lastError" = NULL, "nextRunAt" = NULL,
          "updatedAt" = now() WHERE id = ${connectionId}::uuid`.execute(db);
      }

      const operation = await db
        .insertInto('media_operation')
        .values({
          ownerId,
          kind: MediaOperationKind.ICloudSync,
          // The transfers run on this server's own workers; there is no remote to choose.
          destination: MediaOperationDestination.Local,
          destinationDetail: null,
          label: connection.label,
          assetId: null,
          resultAssetId: null,
          retryOfId: options.retryOfId ?? null,
          projectId: null,
          revisionId: null,
          snapshot: { connectionId, trigger: options.trigger },
          settings: {},
          estimate: null,
          result: null,
          totalUnits: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { outcome: 'created', operation: operation as unknown as MediaOperation };
    });
  }

  /** Close the connection's open run record without counting it complete: a cancel or a failure (FL-68). */
  async endRun(connectionId: string, status: 'cancelled' | 'failed'): Promise<void> {
    await this.active(async (db) => {
      await sql`UPDATE immich_fork.icloud_run SET status = ${status}, "finishedAt" = now()
        WHERE "connectionId" = ${connectionId}::uuid AND status IN ('running', 'queued')`.execute(db);
    });
  }

  /**
   * Forget a disconnected connection (FL-68): its inventory, checkpoints, run records and provenance.
   *
   * Imported photos are ordinary assets and stay exactly where they are; nothing here touches the
   * asset table or a managed original. Only this connection's private staging copies are released,
   * through `cleanup`, inside the transaction that deletes the rows, so a failed cleanup keeps them.
   * A connection with work between staging and commit keeps its rows: that work may already be
   * writing into the library, and it finishes after reconnecting.
   */
  async remove(
    id: string,
    ownerId: string,
    cleanup: (resources: ICloudResource[]) => Promise<void>,
  ): Promise<ICloudRemoveResult> {
    return this.active(async (db): Promise<ICloudRemoveResult> => {
      const connection = await sql<ICloudConnection>`SELECT * FROM immich_fork.icloud_connection
        WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid FOR UPDATE`
        .execute(db)
        .then(({ rows }) => rows[0]);
      if (!connection) {
        return 'not-found';
      }
      if (connection.state !== 'disconnected') {
        return 'still-connected';
      }
      if (await this.latestOperation(id, ownerId, { activeOnly: true }, db)) {
        return 'busy';
      }
      const { rows: inFlight } = await sql`SELECT 1 FROM immich_fork.icloud_resource WHERE "connectionId" = ${id}::uuid
        AND (status IN ('validated', 'promoted', 'committed') OR "pendingJobs" <> '[]'::jsonb) LIMIT 1`.execute(db);
      if (inFlight.length > 0) {
        return 'in-flight';
      }
      const { rows: staged } = await sql<ICloudResource>`SELECT *, "expectedSize"::float8 AS "expectedSize"
        FROM immich_fork.icloud_resource WHERE "connectionId" = ${id}::uuid AND "stagingPath" IS NOT NULL
          AND status NOT IN ('finalized', 'removed')`.execute(db);
      await cleanup(staged);
      await sql`DELETE FROM immich_fork.icloud_connection WHERE id = ${id}::uuid AND "ownerId" = ${ownerId}::uuid`.execute(
        db,
      );
      return 'removed';
    });
  }

  /**
   * Reconciliation findings for the owner (FL-68), newest first: items that need review, failed or
   * are unsupported, items kept in the trash here although iCloud still has them, and items deleted
   * in iCloud that stayed here. Nothing is ever removed on the strength of these rows.
   *
   * A private item (hidden in iCloud, or Locked here) is left out unless `includePrivate`, which the
   * caller only passes for an unlocked session: its file name is itself private.
   */
  async reviewItems(connectionId: string, ownerId: string, includePrivate: boolean): Promise<ICloudReviewItem[]> {
    const { rows } = await sql<ICloudReviewItem>`SELECT r.id AS "resourceId", r.role,
        CASE WHEN r.status = 'preserve-trashed' THEN 'kept-trashed'
          WHEN NOT coalesce((r.source->>'current')::boolean, true) THEN 'source-removed'
          WHEN r.status = 'failed' THEN 'failed'
          WHEN r.status = 'unsupported' THEN 'unsupported'
          ELSE 'review' END AS kind,
        coalesce(r."lastError", r.source#>>'{_sync,relations,reason}', r.source#>>'{_sync,metadata,reason}') AS reason,
        CASE WHEN a.id IS NOT NULL THEN a."originalFileName" ELSE r.source->>'originalFileName' END AS "fileName",
        CASE WHEN a.id IS NOT NULL AND a."deletedAt" IS NULL THEN a.id END AS "assetId"
      FROM immich_fork.icloud_resource r
        LEFT JOIN asset a ON a.id = r."assetId" AND a."ownerId" = r."ownerId"
      WHERE r."connectionId" = ${connectionId}::uuid AND r."ownerId" = ${ownerId}::uuid AND r.role <> 'motion'
        AND (
          (coalesce((r.source->>'current')::boolean, true) AND (r.status IN ('needs-review', 'failed', 'unsupported', 'preserve-trashed')
            OR r.source#>>'{_sync,metadata,status}' = 'needs-review' OR r.source#>>'{_sync,relations,status}' = 'needs-review'))
          OR (coalesce((r.source->>'sourceDisappeared')::boolean, false) AND a.id IS NOT NULL AND a."deletedAt" IS NULL)
        )
        AND (${includePrivate}::boolean OR (NOT coalesce((r.source->>'isHidden')::boolean, false)
          AND NOT EXISTS (SELECT 1 FROM asset_lock l WHERE l."assetId" = r."assetId")))
      ORDER BY r."updatedAt" DESC, r.id LIMIT 50`.execute(this.db);
    return rows;
  }

  /** One notification for the owner (FL-68). Plain wording; never a file name or a path. */
  async notify(ownerId: string, level: NotificationLevel, title: string, description: string): Promise<void> {
    await this.db
      .insertInto('notification')
      .values({ userId: ownerId, type: NotificationType.Custom, level, title, description })
      .execute();
  }

  async inventory(connectionId: string, transaction?: Kysely<DB>) {
    const libraries = await sql<{ id: string; fields: ICloudLibrary }>`SELECT "recordId" AS id, fields
      FROM immich_fork.icloud_record WHERE "connectionId" = ${connectionId}::uuid AND "recordType" = 'Library' AND NOT deleted
      ORDER BY "recordId" LIMIT 101`
      .execute(transaction ?? this.db)
      .then((result) => result.rows);
    const albums = await sql<{ id: string; libraryId: string; name: string; parentId: string | null }>`
      SELECT ("libraryKey" || ':' || "sourceId") AS id, "libraryKey" AS "libraryId", name, CASE WHEN "parentSourceId" IS NULL THEN NULL ELSE "libraryKey" || ':' || "parentSourceId" END AS "parentId"
      FROM immich_fork.icloud_album WHERE "connectionId" = ${connectionId}::uuid AND NOT deleted AND "libraryKey" <> ''
      ORDER BY "libraryKey", "sourceId" LIMIT 10001`
      .execute(transaction ?? this.db)
      .then((result) => result.rows);
    if (libraries.length > 100 || albums.length > 10_000) {
      throw new Error('icloud_inventory_limit_exceeded');
    }
    return { libraries, albums };
  }

  /** Keyset join: masters and logical assets may have arrived on different pages. */
  async materialize(
    connection: ICloudConnection,
    libraryKey: string,
    library: ICloudLibrary,
    transaction?: Kysely<DB>,
  ): Promise<boolean> {
    return this.active(async (db) => {
      const scope = `materialize:${libraryKey}`;
      const checkpoint = await sql<{
        cursor: string;
        complete: boolean;
      }>`SELECT cursor, complete FROM immich_fork.icloud_checkpoint
        WHERE "connectionId" = ${connection.id}::uuid AND scope = ${scope} FOR UPDATE`
        .execute(db)
        .then((result) => result.rows[0]);
      if (checkpoint?.complete) {
        return true;
      }
      const { rows } = await sql<{
        recordName: string;
        recordType: string;
        recordChangeTag: string;
        fields: Record<string, unknown>;
        master: {
          recordName: string;
          recordType: string;
          recordChangeTag: string;
          fields: Record<string, unknown>;
        } | null;
      }>`
        SELECT a."recordId" AS "recordName", a."recordType", a.revision AS "recordChangeTag", a.fields,
          CASE WHEN m."recordId" IS NULL THEN NULL ELSE jsonb_build_object('recordName',m."recordId",'recordType',m."recordType",'recordChangeTag',m.revision,'fields',m.fields) END AS master
        FROM immich_fork.icloud_record a LEFT JOIN immich_fork.icloud_record m ON m."connectionId" = a."connectionId"
          AND m."libraryKey" = a."libraryKey" AND m."recordId" = a."masterId" AND NOT m.deleted
        WHERE a."connectionId" = ${connection.id}::uuid AND a."libraryKey" = ${libraryKey} AND a."recordType" = 'CPLAsset'
          AND NOT a.deleted AND a."recordId" > ${checkpoint?.cursor ?? ''}
        ORDER BY a."recordId" LIMIT 100`.execute(db);
      for (const row of rows) {
        await sql`UPDATE immich_fork.icloud_resource SET source=source || '{"current":false}'::jsonb
          WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${libraryKey} AND "sourceAssetId"=${row.recordName}`.execute(
          db,
        );
        const normalized = resourcesForICloudAsset(row, row.master ?? undefined);
        if (normalized.length === 0) {
          await sql`UPDATE immich_fork.icloud_record SET fields=fields || '{"__icloudUnsupported":"no_original_or_render_descriptor"}'::jsonb
            WHERE "connectionId"=${connection.id}::uuid AND "libraryKey"=${libraryKey} AND "recordId"=${row.recordName}`.execute(
            db,
          );
        }
        for (const resource of normalized) {
          if (
            (!connection.config.includeHidden && resource.source.isHidden) ||
            (!connection.config.includeEdits && resource.role.startsWith('edited-'))
          ) {
            continue;
          }
          if (connection.config.albums.length > 0) {
            const member =
              await sql`SELECT 1 FROM immich_fork.icloud_membership WHERE "connectionId" = ${connection.id}::uuid
              AND "libraryKey" = ${libraryKey} AND "sourceAssetId" = ${row.recordName} AND "sourcePresent"
              AND ("libraryKey" || ':' || "sourceAlbumId") = ANY(${connection.config.albums}::text[]) LIMIT 1`.execute(
                db,
              );
            if (member.rows.length === 0) {
              continue;
            }
          }
          await sql`INSERT INTO immich_fork.icloud_resource ("connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,fingerprint,source,"expectedSize")
            VALUES (${connection.id}::uuid,${connection.ownerId}::uuid,${libraryKey},${library}::jsonb,
              ${resource.sourceAssetId},${resource.recordId},${resource.resourceKey},${resource.role},${resource.fingerprint},${{ ...resource.source, current: true }}::jsonb,${resource.expectedSize})
            ON CONFLICT ("connectionId","libraryKey","sourceAssetId","resourceKey",fingerprint)
            DO UPDATE SET source = excluded.source || CASE WHEN immich_fork.icloud_resource.source ? '_sync' THEN jsonb_build_object('_sync',immich_fork.icloud_resource.source->'_sync') ELSE '{}'::jsonb END, "updatedAt" = now()`.execute(
            db,
          );
        }
      }
      const complete = rows.length < 100;
      await sql`INSERT INTO immich_fork.icloud_checkpoint ("connectionId",scope,cursor,complete,"snapshotId")
        VALUES (${connection.id}::uuid,${scope},to_jsonb(${rows.at(-1)?.recordName ?? ''}::text),${complete},gen_random_uuid())
        ON CONFLICT ("connectionId",scope) DO UPDATE SET cursor=excluded.cursor,complete=excluded.complete,"updatedAt"=now()`.execute(
        db,
      );
      return complete;
    }, transaction);
  }

  async saveAlbums(
    connectionId: string,
    libraryKey: string,
    records: ICloudRecord[],
    transaction?: Kysely<DB>,
  ): Promise<void> {
    await this.active(async (db) => {
      for (const row of records) {
        const album = parseICloudAlbum({ ...row, fields: row.fields ?? {} });
        if (!album) {
          continue;
        }
        await sql`INSERT INTO immich_fork.icloud_album ("connectionId","libraryKey","sourceId","parentSourceId",name,deleted,source)
          VALUES (${connectionId}::uuid,${libraryKey},${album.sourceId},${album.parentSourceId},${album.name},${album.deleted},${album.source}::jsonb)
          ON CONFLICT ("connectionId","libraryKey","sourceId") DO UPDATE SET "parentSourceId"=excluded."parentSourceId",name=excluded.name,deleted=excluded.deleted,
            source=excluded.source || CASE WHEN immich_fork.icloud_album.source ? '_sync' THEN jsonb_build_object('_sync',immich_fork.icloud_album.source->'_sync') ELSE '{}'::jsonb END`.execute(
          db,
        );
      }
    }, transaction);
  }

  async saveMembershipPage(
    connectionId: string,
    libraryKey: string,
    albumId: string,
    records: ICloudRecord[],
    snapshotId: string,
    complete: boolean,
    transaction?: Kysely<DB>,
  ) {
    await this.active(async (db) => {
      for (const record of records) {
        if (record.recordType !== 'CPLAsset' || record.deleted) {
          continue;
        }
        await sql`INSERT INTO immich_fork.icloud_membership ("connectionId","libraryKey","sourceAlbumId","sourceAssetId","snapshotId","sourcePresent")
          VALUES (${connectionId}::uuid,${libraryKey},${albumId},${record.recordName},${snapshotId}::uuid,true)
          ON CONFLICT ("connectionId","libraryKey","sourceAlbumId","sourceAssetId") DO UPDATE SET "snapshotId"=excluded."snapshotId","sourcePresent"=true`.execute(
          db,
        );
      }
      if (complete) {
        await sql`UPDATE immich_fork.icloud_membership SET "sourcePresent"=false WHERE "connectionId"=${connectionId}::uuid
          AND "libraryKey"=${libraryKey} AND "sourceAlbumId"=${albumId} AND "snapshotId" <> ${snapshotId}::uuid`.execute(
          db,
        );
      }
    }, transaction);
  }

  async resource(id: string): Promise<ICloudResource | undefined> {
    return await sql<ICloudResource>`SELECT *,"expectedSize"::float8 AS "expectedSize" FROM immich_fork.icloud_resource WHERE id=${id}::uuid`
      .execute(this.db)
      .then((result) => result.rows[0]);
  }

  async receipts(connectionId: string, ownerId: string) {
    const { rows } = await sql<{
      assetId: string;
      resourceId: string;
      outcome: string;
      fileName: string;
    }>`SELECT r."assetId",r.id AS "resourceId",r.verification->>'outcome' AS outcome,a."originalFileName" AS "fileName"
      FROM immich_fork.icloud_resource r JOIN public.asset a ON a.id=r."assetId" AND a."ownerId"=r."ownerId"
      WHERE r."connectionId"=${connectionId}::uuid AND r."ownerId"=${ownerId}::uuid AND a.visibility <> 'hidden'
        AND NOT EXISTS (SELECT 1 FROM asset_lock l WHERE l."assetId"=a.id)
        AND a."deletedAt" IS NULL AND r.verification->>'outcome' IS NOT NULL AND r.status IN ('committed','finalized')
      ORDER BY r."updatedAt" DESC,r.id LIMIT 100`.execute(this.db);
    return rows;
  }

  async initializeCheckpoint(
    connectionId: string,
    scope: string,
    snapshotId: string,
    transaction?: Kysely<DB>,
  ): Promise<void> {
    await this.active(async (db) => {
      await sql`INSERT INTO immich_fork.icloud_checkpoint ("connectionId",scope,"snapshotId")
      VALUES (${connectionId}::uuid,${scope},${snapshotId}::uuid) ON CONFLICT DO NOTHING`.execute(db);
    }, transaction);
  }

  async hasPending(connectionId: string): Promise<boolean> {
    return (
      (await sql`SELECT 1 FROM immich_fork.icloud_resource WHERE "connectionId"=${connectionId}::uuid
      AND status IN ('pending','retry','staging','validated','promoted','committed')
      AND (status='committed' OR coalesce((source->>'current')::boolean,true)) LIMIT 1`
        .execute(this.db)
        .then((result) => result.rows.length)) > 0
    );
  }

  async retryFailures(connectionId: string, transaction?: Kysely<DB>): Promise<void> {
    await this.active(async (db) => {
      await sql`UPDATE immich_fork.icloud_run SET counts=counts-'transportAttempts'-'cursorResets' WHERE "connectionId"=${connectionId}::uuid AND status='running'`.execute(
        db,
      );
      await sql`UPDATE immich_fork.icloud_resource SET source=source #- '{_sync,relations,signature}'
        WHERE "connectionId"=${connectionId}::uuid AND source#>>'{_sync,relations,status}'='needs-review'`.execute(db);
      await sql`UPDATE immich_fork.icloud_resource SET status=CASE WHEN status='committed' THEN 'committed' ELSE 'pending' END,attempts=0,"nextAttemptAt"=NULL
      WHERE "connectionId"=${connectionId}::uuid AND status IN ('failed','retry','needs-review','unsupported','committed') AND "leaseToken" IS NULL`.execute(
        db,
      );
    }, transaction);
  }

  async clearOutbox(resource: ICloudResource): Promise<void> {
    await this.active(async (db) => {
      await sql`UPDATE immich_fork.icloud_resource SET "pendingJobs"='[]'::jsonb
      WHERE id=${resource.id}::uuid AND "leaseToken"=${resource.leaseToken}::uuid AND status='committed'`.execute(db);
    });
  }

  async finalize(resource: ICloudResource, cleanup: () => Promise<void>): Promise<boolean> {
    return this.active(async (db) => {
      const { rows } = await sql`SELECT id FROM immich_fork.icloud_resource WHERE id=${resource.id}::uuid
        AND "leaseToken"=${resource.leaseToken}::uuid AND "leaseExpiresAt">now() AND status='committed'
        AND "pendingJobs"='[]'::jsonb FOR UPDATE`.execute(db);
      if (rows.length === 0) {
        return false;
      }
      await cleanup();
      await sql`UPDATE immich_fork.icloud_resource SET status='finalized',"reservedBytes"=0,"leaseToken"=NULL,
        "leaseExpiresAt"=NULL,"lastError"=NULL,"updatedAt"=now() WHERE id=${resource.id}::uuid`.execute(db);
      return true;
    });
  }

  async defer(connectionId: string, ownerId: string, reason: string): Promise<void> {
    await this.active(async (db) => {
      const { rows } = await sql<{
        attempts: number;
      }>`UPDATE immich_fork.icloud_run SET counts=jsonb_set(counts,'{transportAttempts}',to_jsonb(coalesce((counts->>'transportAttempts')::int,0)+1))
        WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND status='running'
        RETURNING (counts->>'transportAttempts')::int AS attempts`.execute(db);
      const attempts = rows[0]?.attempts ?? 8;
      await sql`UPDATE immich_fork.icloud_connection SET state=CASE WHEN ${attempts}<8 AND "encryptedSession" IS NOT NULL THEN 'connected' ELSE 'error' END,
        "lastError"=${reason},"nextRunAt"=now()+interval '1 minute'*least(1440,power(2,${attempts}))*(0.75+random()*0.5)
        WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state NOT IN ('paused','disconnected')`.execute(
        db,
      );
    });
  }

  async refreshResource(resource: ICloudResource): Promise<void> {
    await this.active(async (db) => {
      const { rows } = await sql`SELECT id FROM immich_fork.icloud_connection WHERE id=${resource.connectionId}::uuid
        AND "ownerId"=${resource.ownerId}::uuid AND state='connected' FOR UPDATE`.execute(db);
      if (rows.length === 0) {
        return;
      }
      // Keep the old rendition and its staging reservation; a refreshed manifest decides its successor.
      await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${resource.connectionId}::uuid
        AND scope IN (${`assets:${resource.libraryKey}`},${`changes:${resource.libraryKey}`},${`materialize:${resource.libraryKey}`},'inventory-complete')`.execute(
        db,
      );
      await sql`UPDATE immich_fork.icloud_connection SET "lastError"='resource_changed',"nextRunAt"=now()+interval '5 minutes'
        WHERE id=${resource.connectionId}::uuid`.execute(db);
    });
  }

  async invalidateCursor(connectionId: string, ownerId: string): Promise<void> {
    await this.active(async (db) => {
      const { rows } = await sql<{
        attempts: number;
      }>`UPDATE immich_fork.icloud_run SET counts=jsonb_set(counts,'{cursorResets}',to_jsonb(coalesce((counts->>'cursorResets')::int,0)+1))
        WHERE "connectionId"=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND status='running'
        RETURNING (counts->>'cursorResets')::int AS attempts`.execute(db);
      const attempts = rows[0]?.attempts ?? 3;
      if (attempts <= 2) {
        await sql`DELETE FROM immich_fork.icloud_checkpoint WHERE "connectionId"=${connectionId}::uuid`.execute(db);
      }
      await sql`UPDATE immich_fork.icloud_connection SET state=${attempts <= 2 ? 'connected' : 'error'},"lastError"='invalid_change_token',
        "nextRunAt"=now()+interval '5 minutes' WHERE id=${connectionId}::uuid AND "ownerId"=${ownerId}::uuid AND state='connected'`.execute(
        db,
      );
    });
  }

  async block(connectionId: string, ownerId: string, state: string, reason: string): Promise<void> {
    await this.active(async (db) => {
      const { rows } = await sql<{
        state: string;
      }>`SELECT state FROM immich_fork.icloud_connection WHERE id=${connectionId}::uuid
        AND "ownerId"=${ownerId}::uuid FOR UPDATE`.execute(db);
      if (!rows[0] || ['paused', 'disconnected'].includes(rows[0].state)) {
        return;
      }
      await sql`UPDATE immich_fork.icloud_connection SET state=${state},"lastError"=${reason},"nextRunAt"=NULL WHERE id=${connectionId}::uuid`.execute(
        db,
      );
      if (rows[0].state !== state) {
        await db
          .insertInto('notification')
          .values({
            userId: ownerId,
            type: NotificationType.Custom,
            level: NotificationLevel.Warning,
            title: 'iCloud Photos Sync needs attention',
            description: 'Open Utilities → iCloud Photos Sync to review the connection and continue synchronization.',
          })
          .execute();
      }
    });
  }

  async completeRun(connection: ICloudConnection): Promise<void> {
    const counts = await this.counts(connection.id);
    await this.active(async (db) => {
      const partial = ['failed', 'needs-review', 'unsupported', 'retry'].some((key) => (counts[key] ?? 0) > 0);
      await sql`UPDATE immich_fork.icloud_run SET status=${partial ? 'partial' : 'complete'},counts=${counts}::jsonb,"finishedAt"=now()
        WHERE "connectionId"=${connection.id}::uuid AND status='running'`.execute(db);
      await sql`UPDATE immich_fork.icloud_connection SET "nextRunAt"=now()+${connection.config.intervalHours}*interval '1 hour'
        WHERE id=${connection.id}::uuid AND state='connected'`.execute(db);
    });
  }
}
