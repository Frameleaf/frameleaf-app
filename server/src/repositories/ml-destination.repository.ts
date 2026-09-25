import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import {
  MlDestinationTable,
  MlProbeHardware,
  MlWorkloadAccountingTable,
  MlWorkloadRouteTable,
} from 'src/schema/tables/ml-destination.table.js';

export type MlDestinationRow = Selectable<MlDestinationTable>;
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

  async recordProbe(id: string, probe: MlProbeRecord): Promise<void> {
    await this.db
      .updateTable('ml_destination')
      .set({
        lastProbeAt: probe.probedAt,
        lastProbeHealth: probe.health,
        lastProbeSummary: probe.summary,
        lastProbeWorkloads: probe.workloads === null ? null : (toJson(probe.workloads) as unknown as MlWorkload[]),
        ...(probe.hardware !== undefined && {
          lastProbeHardware: probe.hardware === null ? null : (toJson(probe.hardware) as unknown as MlProbeHardware),
        }),
        ...(probe.latencyMs !== undefined && { lastProbeLatencyMs: probe.latencyMs }),
        ...(probe.cloud !== undefined && {
          lastProbeCloud: probe.cloud === null ? null : (toJson(probe.cloud) as unknown as CloudProbeFacts),
        }),
      })
      .where('id', '=', id)
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

  async setRoute(workload: MlWorkload, destinationId: string, modelId: string | null = null): Promise<void> {
    await this.db
      .insertInto('ml_workload_route')
      .values({ workload, destinationId, modelId, updatedAt: new Date() })
      .onConflict((oc) => oc.column('workload').doUpdateSet({ destinationId, modelId, updatedAt: new Date() }))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  async clearRoute(workload: MlWorkload): Promise<void> {
    await this.db.deleteFrom('ml_workload_route').where('workload', '=', workload).execute();
  }

  async recordAccounting(entry: MlAccountingInsert): Promise<void> {
    await this.db.insertInto('ml_workload_accounting').values(entry).execute();
  }

  /**
   * FL-159: apply Frameleaf Cloud settlements to the accounting rows of their jobs. Returns how many
   * rows changed; a settlement for a job this server never recorded changes nothing.
   */
  async applySettlements(settlements: MlSettlement[]): Promise<number> {
    if (settlements.length === 0) {
      return 0;
    }
    // One statement per reconcile, matched through the cloud job id index (fork migration 201); a
    // row already carrying the settled figures is left alone.
    const result = await sql<{ id: string }>`
      UPDATE public.ml_workload_accounting AS a
      SET "costUsd" = s."costUsd", credits = s.credits
      FROM jsonb_to_recordset(${JSON.stringify(settlements)}::text::jsonb)
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
