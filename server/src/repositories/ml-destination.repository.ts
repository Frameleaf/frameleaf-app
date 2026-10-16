import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, SqlBool, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { MlEndpoint } from 'src/repositories/machine-learning.repository.js';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { MlDestinationHealth, MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { currentAuth } from 'src/repositories/icloud-audit.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import {
  MlCloudModelChoiceTable,
  MlDestinationTable,
  MlProbeHardware,
  MlWorkloadAccountingTable,
  MlWorkloadRouteTable,
} from 'src/schema/tables/ml-destination.table.js';
import {
  recoveryAuthorityDigest,
  recoveryMlAdmissionIdentity,
  recoveryMlBindingSchema,
  recoveryMlEndpointIdentity,
  recoveryMlRefusal,
  recoveryMlRegistrySchema,
} from 'src/utils/recovery-ml-authority.js';

export type MlDestinationRow = Selectable<MlDestinationTable>;
export type MlCloudModelChoiceRow = Selectable<MlCloudModelChoiceTable>;
export type MlWorkloadRouteRow = Selectable<MlWorkloadRouteTable>;
export type MlWorkloadAccountingRow = Selectable<MlWorkloadAccountingTable>;

export type MlDestinationInsert = {
  kind: MlDestinationKind;
  name: string;
  url: string | null;
  authToken: string | null;
  enabled: boolean;
  workloads: MlWorkload[];
  budgetLimitUsd: number | null;
  maxRuntimeMinutes: number | null;
  maxUploadBytes: number | null;
  /** FL-72: a restoration worker on the GPU library analysis uses. Defaults to false. */
  sharesLibraryHardware?: boolean;
  /** FL-159: the Frameleaf Cloud data region. */
  region?: string | null;
};

export type MlDestinationPatch = Partial<MlDestinationInsert> & {
  consentAcknowledgedAt?: Date | null;
  consentAcknowledgedBy?: string | null;
  /** FL-159: the Frameleaf Cloud consent version the administrator accepted. */
  consentVersion?: string | null;
};

export type MlProbeRecord = {
  health: MlDestinationHealth;
  summary: string | null;
  workloads: MlWorkload[] | null;
  probedAt: Date;
  /** FL-72: acceleration facts from the same check. Omitted leaves the stored value alone. */
  hardware?: MlProbeHardware | null;
  latencyMs?: number | null;
  /** FL-159: what a Frameleaf Cloud check learned. Omitted leaves the stored value alone. */
  cloud?: CloudProbeFacts | null;
};

export type MlAccountingInsert = {
  destinationId: string;
  destinationKind: MlDestinationKind;
  workload: MlWorkload;
  jobId: string | null;
  jobName: string | null;
  bytesSent: number;
  bytesReceived: number;
  durationMs: number;
  outcome: 'success' | 'failure';
  costUsd: number | null;
  startedAt: Date;
  finishedAt: Date;
  /** FL-159: the Frameleaf Cloud job this request created, so its settlement can find the row. */
  cloudJobId?: string | null;
};

/** FL-159: one Frameleaf Cloud settlement applied to the accounting row of its job. */
export type MlSettlement = { cloudJobId: string; costUsd: number; credits: number | null };

/** FL-71: the destination that last served a job, for the Job manager's Worker column. */
export type MlJobDestination = {
  jobId: string;
  jobName: string;
  destinationKind: MlDestinationKind;
  destinationName: string | null;
};

/** Measured throughput for one destination and workload, from the accounting rows. */
export type MlThroughputSample = {
  sampleCount: number;
  bytesSent: number;
  durationMs: number;
  spentUsd: number;
};

/** Through text: a parameter typed `jsonb` is JSON-encoded again by the driver, storing a JSON string. */
const toJson = (value: unknown) => sql`${JSON.stringify(value)}::text::jsonb`;

/**
 * Storage for machine-learning destinations, workload routes and per-request accounting
 * (FL-110). Selection and admission live in `src/utils/ml-destination.ts`; this class only
 * reads and writes rows.
 */
@Injectable()
export class MlDestinationRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** Common consumer fence; disabled state and cached probes cannot grant replacement authority. */
  async assertRecoveryAuthority(expected: MlDestinationRow): Promise<void> {
    const metadata = new SystemMetadataRepository(this.db);
    const input = await metadata.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
    const epoch = await metadata.getEffectiveConfigEpoch();
    if (!input && !epoch?.recoveryMlBinding) return;
    const registry = recoveryMlRegistrySchema.safeParse(input);
    if (!registry.success) throw recoveryMlRefusal();
    const binding = epoch?.recoveryMlBinding;
    if (binding && !recoveryMlBindingSchema.safeParse(binding).success) throw recoveryMlRefusal();
    if (
      binding &&
      (binding.recoveryId !== registry.data.recoveryId ||
        binding.preparedPlanDigest !== registry.data.preparedPlanDigest ||
        binding.replacementIdentity !== registry.data.replacementIdentity)
    )
      throw recoveryMlRefusal();
    if (registry.data.quarantine[expected.id]) throw recoveryMlRefusal();
    const current = await this.getById(expected.id);
    if (!current || recoveryMlAdmissionIdentity(current) !== recoveryMlAdmissionIdentity(expected))
      throw recoveryMlRefusal();
  }

  /** Direct endpoint callers also pass this fence; a token must match an admitted current row. */
  async assertEndpointAuthority(endpoint: MlEndpoint): Promise<string> {
    const metadata = new SystemMetadataRepository(this.db);
    const input = await metadata.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
    const epoch = await metadata.getEffectiveConfigEpoch();
    const rows = await this.getAll();
    const matches = rows.filter((row) =>
      endpoint.cloud
        ? row.kind === MlDestinationKind.FrameleafCloud
        : row.url === endpoint.url && (row.authToken ?? null) === (endpoint.authToken ?? null),
    );
    const parsed = input || epoch?.recoveryMlBinding ? recoveryMlRegistrySchema.safeParse(input) : null;
    if (parsed && !parsed.success) throw recoveryMlRefusal();
    const registry = parsed?.data ?? null;
    const admitted = matches.filter((row) => row.enabled && !registry?.quarantine[row.id]);
    if (registry) {
      if (admitted.length === 0) throw recoveryMlRefusal();
      for (const row of admitted) await this.assertRecoveryAuthority(row);
    }
    // Probe receipts belong to the current policy and recovery binding, not just URL/token.
    return recoveryAuthorityDigest({
      epoch,
      registry,
      admitted: admitted.map((row) => recoveryMlAdmissionIdentity(row)).sort(),
    });
  }

  async recoveryRegistry() {
    const input = await new SystemMetadataRepository(this.db).get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
    if (!input) return null;
    const parsed = recoveryMlRegistrySchema.safeParse(input);
    if (!parsed.success) throw recoveryMlRefusal();
    return parsed.data;
  }

  /** Only explicit admin update clears quarantine, after waits and under C1-before-row order. */
  async updateRecoveryBinding(auth: AuthDto, expected: MlDestinationRow, patch: MlDestinationPatch) {
    if (
      !auth?.session ||
      !auth.user.isAdmin ||
      auth.apiKey ||
      auth.sharedLink ||
      patch.enabled !== true ||
      (!!expected.authToken && patch.authToken === undefined) ||
      (expected.kind !== MlDestinationKind.FrameleafCloud && typeof patch.url !== 'string')
    )
      throw recoveryMlRefusal();
    return new SystemMetadataRepository(this.db).withConfigTransaction(async (metadata, tx) => {
      if (!(await currentAuth(tx, auth.user.id, auth.session!.id, true))) throw recoveryMlRefusal();
      const actor = await tx
        .selectFrom('user')
        .select('isAdmin')
        .where('id', '=', auth.user.id)
        .where('deletedAt', 'is', null)
        .forShare()
        .executeTakeFirst();
      if (!actor?.isAdmin) throw recoveryMlRefusal();
      const current = await tx
        .selectFrom('ml_destination')
        .selectAll()
        .where('id', '=', expected.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current || recoveryMlEndpointIdentity(current) !== recoveryMlEndpointIdentity(expected))
        throw recoveryMlRefusal();
      const registry = recoveryMlRegistrySchema.safeParse(
        await metadata.get(SystemMetadataKey.FrameleafRecoveryMlAuthority),
      );
      if (
        !registry.success ||
        !registry.data.quarantine[current.id] ||
        registry.data.quarantine[current.id] !== recoveryMlEndpointIdentity(current)
      )
        throw recoveryMlRefusal();
      const repository = new MlDestinationRepository(tx);
      const row = await repository.update(current.id, { ...patch });
      await tx
        .updateTable('ml_destination')
        .set({ consentAcknowledgedAt: null, consentAcknowledgedBy: null, consentVersion: null })
        .where('id', '=', row.id)
        .execute();
      await repository.recordProbe(current.id, {
        health: MlDestinationHealth.Unknown,
        summary: null,
        workloads: null,
        probedAt: new Date(),
        hardware: null,
        latencyMs: null,
        cloud: null,
      });
      delete registry.data.quarantine[current.id];
      await metadata.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, registry.data);
      if (!(await currentAuth(tx, auth.user.id, auth.session!.id, true))) throw recoveryMlRefusal();
      return (await repository.getById(row.id))!;
    });
  }

  @GenerateSql()
  getAll(): Promise<MlDestinationRow[]> {
    return this.db.selectFrom('ml_destination').selectAll().orderBy('kind', 'asc').orderBy('name', 'asc').execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getById(id: string): Promise<MlDestinationRow | undefined> {
    return this.db.selectFrom('ml_destination').selectAll().where('id', '=', id).executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.STRING] })
  getByUrl(kind: MlDestinationKind, url: string): Promise<MlDestinationRow | undefined> {
    return this.db
      .selectFrom('ml_destination')
      .selectAll()
      .where('kind', '=', kind)
      .where('url', '=', url)
      .executeTakeFirst();
  }

  async create(destination: MlDestinationInsert): Promise<MlDestinationRow> {
    const values: Insertable<MlDestinationTable> = {
      ...destination,
      workloads: toJson(destination.workloads) as unknown as MlWorkload[],
    };
    return this.db.insertInto('ml_destination').values(values).returningAll().executeTakeFirstOrThrow();
  }

  async update(id: string, patch: MlDestinationPatch): Promise<MlDestinationRow> {
    const values: Updateable<MlDestinationTable> = {
      ...patch,
      workloads: patch.workloads === undefined ? undefined : (toJson(patch.workloads) as unknown as MlWorkload[]),
      updatedAt: new Date(),
    };
    return this.db
      .updateTable('ml_destination')
      .set(values)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('ml_destination').where('id', '=', id).execute();
  }

  async recordProbe(id: string, probe: MlProbeRecord, expected?: MlDestinationRow): Promise<void> {
    if (expected) await this.assertRecoveryAuthority(expected);
    const diagnostics = {
      ...(probe.hardware !== undefined && {
        lastProbeHardware: probe.hardware === null ? null : (toJson(probe.hardware) as unknown as MlProbeHardware),
      }),
      ...(probe.latencyMs !== undefined && { lastProbeLatencyMs: probe.latencyMs }),
      ...(probe.cloud !== undefined && {
        lastProbeCloud: probe.cloud === null ? null : (toJson(probe.cloud) as unknown as CloudProbeFacts),
      }),
    };
    await this.db
      .updateTable('ml_destination')
      .set({
        lastProbeAt: probe.probedAt,
        lastProbeHealth: probe.health,
        lastProbeSummary: probe.summary,
        lastProbeWorkloads: probe.workloads === null ? null : (toJson(probe.workloads) as unknown as MlWorkload[]),
        ...diagnostics,
      })
      .where('id', '=', id)
      .$if(!!expected, (query) =>
        query
          .where('kind', '=', expected!.kind)
          .where('enabled', '=', expected!.enabled)
          .where('updatedAt', '=', expected!.updatedAt)
          .where(sql<boolean>`url IS NOT DISTINCT FROM ${expected!.url}`)
          .where(sql<boolean>`"authToken" IS NOT DISTINCT FROM ${expected!.authToken}`),
      )
      // Concurrent admissions may have read the row before this observation was persisted.
      .where((eb) =>
        eb.or([
          eb('lastProbeAt', 'is', null),
          eb('lastProbeAt', '<', probe.probedAt),
          // Admission can cache/persist the observation while a manual probe is still gathering GPU
          // inventory. Let that same observation add diagnostics without rewriting identical records.
          eb.and([
            eb('lastProbeAt', '=', probe.probedAt),
            eb.or(
              Object.entries(diagnostics).map(
                ([column, value]) => sql<SqlBool>`${sql.ref(column)} is distinct from ${value}`,
              ),
            ),
          ]),
        ]),
      )
      .execute();
  }

  @GenerateSql()
  getRoutes(): Promise<MlWorkloadRouteRow[]> {
    return this.db.selectFrom('ml_workload_route').selectAll().orderBy('workload', 'asc').execute();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  getRoute(workload: MlWorkload): Promise<MlWorkloadRouteRow | undefined> {
    return this.db.selectFrom('ml_workload_route').selectAll().where('workload', '=', workload).executeTakeFirst();
  }

  private lockRoute(db: Kysely<DB>, workload: MlWorkload) {
    return sql`SELECT pg_advisory_xact_lock(hashtextextended('frameleaf:ml-route:' || ${workload}::text, 0))`.execute(
      db,
    );
  }

  private writeRouteOrigin(
    db: Kysely<DB>,
    workload: MlWorkload,
    destinationId: string | null,
    origin: 'default' | 'pinned',
  ) {
    const values = { workload, destinationId, origin, revisionId: randomUUID(), updatedAt: new Date() };
    return db
      .insertInto('ml_workload_route_origin')
      .values(values)
      .onConflict((oc) =>
        origin === 'default' ? oc.column('workload').doNothing() : oc.column('workload').doUpdateSet(values),
      )
      .returning(['workload', 'revisionId'])
      .executeTakeFirst();
  }

  /**
   * Route a workload to a destination. FL-186: the route no longer carries the Frameleaf Cloud model
   * (`ml_cloud_model_choice` does), so `modelId` is left untouched and is no longer read.
   */
  async setRoute(workload: MlWorkload, destinationId: string): Promise<void> {
    await this.db.transaction().execute(async (db) => {
      await this.lockRoute(db, workload);
      await db
        .insertInto('ml_workload_route')
        .values({ workload, destinationId, updatedAt: new Date() })
        .onConflict((oc) => oc.column('workload').doUpdateSet({ destinationId, updatedAt: new Date() }))
        .execute();
      await this.writeRouteOrigin(db, workload, destinationId, 'pinned');
    });
  }

  async setDefaultRoute(workload: MlWorkload, destinationId: string): Promise<boolean> {
    return this.db.transaction().execute(async (db) => {
      await this.lockRoute(db, workload);
      const route = await db
        .selectFrom('ml_workload_route')
        .select('workload')
        .where('workload', '=', workload)
        .executeTakeFirst();
      const intent = await db
        .selectFrom('ml_workload_route_origin')
        .select('workload')
        .where('workload', '=', workload)
        .executeTakeFirst();
      if (route || intent) return false;
      const recorded = await this.writeRouteOrigin(db, workload, destinationId, 'default');
      if (!recorded) return false;
      const inserted = await db
        .insertInto('ml_workload_route')
        .values({ workload, destinationId, updatedAt: new Date() })
        .onConflict((oc) => oc.column('workload').doNothing())
        .returning('workload')
        .executeTakeFirst();
      if (!inserted) {
        await db
          .deleteFrom('ml_workload_route_origin')
          .where('workload', '=', workload)
          .where('revisionId', '=', recorded.revisionId)
          .execute();
        return false;
      }
      return true;
    });
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  async clearRoute(workload: MlWorkload): Promise<void> {
    await this.db.transaction().execute(async (db) => {
      await this.lockRoute(db, workload);
      await db.deleteFrom('ml_workload_route').where('workload', '=', workload).execute();
      await this.writeRouteOrigin(db, workload, null, 'pinned');
    });
  }

  @GenerateSql()
  getRouteStates() {
    const current = sql<SqlBool>`(origin.origin='pinned' AND origin."destinationId" IS NULL AND route.workload IS NULL)
      OR (route."destinationId"=origin."destinationId")`;
    return this.db
      .selectFrom('ml_workload_route as route')
      .fullJoin('ml_workload_route_origin as origin', 'origin.workload', 'route.workload')
      .select([
        sql<MlWorkload>`COALESCE(route.workload, origin.workload)`.as('workload'),
        'route.destinationId',
        sql<'default' | 'pinned' | 'legacy'>`CASE WHEN ${current} THEN origin.origin ELSE 'legacy' END`.as('origin'),
        sql<string | null>`CASE WHEN ${current} THEN origin."revisionId" ELSE NULL END`.as('revisionId'),
      ])
      .orderBy('workload', 'asc')
      .execute();
  }

  /** FL-186: the Frameleaf Cloud model an administrator chose per model group. */
  @GenerateSql()
  getCloudModelChoices(): Promise<MlCloudModelChoiceRow[]> {
    return this.db.selectFrom('ml_cloud_model_choice').selectAll().orderBy('modelGroup', 'asc').execute();
  }

  /** FL-186: the chosen Frameleaf Cloud model SKU of one model group, or null for the catalogue default. */
  @GenerateSql({ params: [DummyValue.STRING] })
  async getCloudModelChoice(group: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('ml_cloud_model_choice')
      .select('modelId')
      .where('modelGroup', '=', group)
      .executeTakeFirst();
    return row?.modelId ?? null;
  }

  async setCloudModelChoice(group: string, modelId: string): Promise<void> {
    await this.db
      .insertInto('ml_cloud_model_choice')
      .values({ modelGroup: group, modelId, updatedAt: new Date() })
      .onConflict((oc) => oc.column('modelGroup').doUpdateSet({ modelId, updatedAt: new Date() }))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  async clearCloudModelChoice(group: string): Promise<void> {
    await this.db.deleteFrom('ml_cloud_model_choice').where('modelGroup', '=', group).execute();
  }

  async recordAccounting(entry: MlAccountingInsert): Promise<void> {
    await this.db.insertInto('ml_workload_accounting').values(entry).execute();
  }

  /**
   * FL-163: record a Frameleaf Cloud job once. A job adopted again after a replayed submission (same
   * idempotency key) already has its row, which its settlement fills; a second row would count it twice.
   */
  async recordCloudJobAccounting(entry: MlAccountingInsert & { cloudJobId: string }): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${entry.cloudJobId}))`.execute(trx);
      const existing = await trx
        .selectFrom('ml_workload_accounting')
        .select('id')
        .where('cloudJobId', '=', entry.cloudJobId)
        .executeTakeFirst();
      if (existing) {
        return false;
      }
      await trx.insertInto('ml_workload_accounting').values(entry).execute();
      return true;
    });
  }

  /**
   * FL-159: apply Frameleaf Cloud settlements to the accounting rows of their jobs. Returns how many
   * rows changed; a settlement for a job this server never recorded changes nothing.
   */
  async applySettlements(settlements: MlSettlement[]): Promise<number> {
    // A job reported twice counts once, with its last report: Postgres would otherwise apply one of
    // the duplicate rows arbitrarily.
    const unique = new Map(settlements.map((settlement) => [settlement.cloudJobId, settlement])).values().toArray();
    if (unique.length === 0) {
      return 0;
    }
    // One statement per reconcile, matched through the cloud job id index (fork migration 201); a
    // row already carrying the settled figures is left alone.
    const result = await sql<{ id: string }>`
      UPDATE public.ml_workload_accounting AS a
      SET "costUsd" = s."costUsd", credits = s.credits
      FROM jsonb_to_recordset(${JSON.stringify(unique)}::text::jsonb)
        AS s("cloudJobId" text, "costUsd" double precision, credits double precision)
      WHERE a."cloudJobId" = s."cloudJobId"
        AND (a."costUsd" IS DISTINCT FROM s."costUsd" OR a.credits IS DISTINCT FROM s.credits)
      RETURNING a.id
    `.execute(this.db);
    return result.rows.length;
  }

  /**
   * FL-159: the destination's settled Frameleaf Cloud charges, newest first. Only requests the cloud
   * has settled (a cost on a row with a cloud job id) are listed; nothing about the media is read.
   */
  @GenerateSql({ params: [DummyValue.UUID, 50] })
  getSettlements(destinationId: string, limit: number) {
    return this.db
      .selectFrom('ml_workload_accounting')
      .select(['cloudJobId', 'workload', 'jobName', 'outcome', 'costUsd', 'credits', 'startedAt', 'finishedAt'])
      .where('destinationId', '=', destinationId)
      .where('cloudJobId', 'is not', null)
      .where('costUsd', 'is not', null)
      .orderBy('finishedAt', 'desc')
      .limit(limit)
      .execute();
  }

  /**
   * Successful requests since `since` for one destination, optionally one workload. Bytes
   * and duration are summed so callers can derive a measured throughput, and cost is summed
   * for budget checks.
   */
  async getThroughput(destinationId: string, since: Date, workload?: MlWorkload): Promise<MlThroughputSample> {
    let query = this.db
      .selectFrom('ml_workload_accounting')
      .select((eb) => [
        eb.fn.countAll<number>().as('sampleCount'),
        eb.fn.coalesce(eb.fn.sum<number>('bytesSent'), sql<number>`0`).as('bytesSent'),
        eb.fn.coalesce(eb.fn.sum<number>('durationMs'), sql<number>`0`).as('durationMs'),
        eb.fn.coalesce(eb.fn.sum<number>('costUsd'), sql<number>`0`).as('spentUsd'),
      ])
      .where('destinationId', '=', destinationId)
      .where('outcome', '=', 'success')
      .where('startedAt', '>=', since);
    if (workload) {
      query = query.where('workload', '=', workload);
    }
    const row = await query.executeTakeFirstOrThrow();
    return {
      sampleCount: Number(row.sampleCount),
      bytesSent: Number(row.bytesSent),
      durationMs: Number(row.durationMs),
      spentUsd: Number(row.spentUsd),
    };
  }

  /** Total attributed spend for a destination since `since`, across every outcome. */
  async getSpend(destinationId: string, since: Date): Promise<number> {
    const row = await this.db
      .selectFrom('ml_workload_accounting')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('costUsd'), sql<number>`0`).as('spentUsd'))
      .where('destinationId', '=', destinationId)
      .where('startedAt', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(row.spentUsd);
  }

  /**
   * FL-71: for each job subject (the `jobId` a handler records, usually the asset id), the
   * destination of its most recent accounted request under one of `jobNames`. A destination
   * removed since keeps its kind with no name.
   */
  async getLatestJobDestinations(jobIds: string[], jobNames: string[]): Promise<MlJobDestination[]> {
    if (jobIds.length === 0 || jobNames.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('ml_workload_accounting')
      .leftJoin('ml_destination', 'ml_destination.id', 'ml_workload_accounting.destinationId')
      .distinctOn(['ml_workload_accounting.jobId', 'ml_workload_accounting.jobName'])
      .select([
        'ml_workload_accounting.jobId',
        'ml_workload_accounting.jobName',
        'ml_workload_accounting.destinationKind',
        'ml_destination.name as destinationName',
      ])
      .where('ml_workload_accounting.jobId', 'in', jobIds)
      .where('ml_workload_accounting.jobName', 'in', jobNames)
      .orderBy('ml_workload_accounting.jobId')
      .orderBy('ml_workload_accounting.jobName')
      .orderBy('ml_workload_accounting.startedAt', 'desc')
      .orderBy('ml_workload_accounting.id', 'desc')
      .execute();
    return rows.flatMap(({ jobId, jobName, destinationKind, destinationName }) =>
      jobId && jobName ? [{ jobId, jobName, destinationKind, destinationName }] : [],
    );
  }
}
