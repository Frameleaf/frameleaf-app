import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Int8, Timestamp } from '@immich/sql-tools';
import type { CloudProbeFacts } from 'src/utils/frameleaf-cloud.js';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The hardware facts a health check keeps (FL-72). `gpus` is filled only by a restoration
 * worker, which reports each GPU's memory; the `/predict` container reports providers only.
 */
export type MlProbeHardware = {
  preferredAcceleration: string | null;
  providers: string[];
  cudaDeviceCount: number;
  gpus: Array<{ name: string; memoryTotalBytes: number }>;
};

/**
 * One place machine-learning work may run (FL-110). Mirrors migrations
 * 2100000000140-CreateMlDestinations, 2100000000490-SeparateRestorationWorkers (FL-72) and
 * 2100000000620-FrameleafCloudMlDestination (FL-159).
 *
 * `authToken` is a bearer credential for LAN workers and is never returned by the API; the
 * Frameleaf Cloud destination carries no URL or token (its requests use short-lived tokens minted
 * from this server's key) and `authToken` stays null for it. `workloads` is the admin's allow-list;
 * `lastProbeWorkloads` is what the worker itself reported, and admission requires both.
 */
@Table('ml_destination')
// Mirrors the CHECK set by migration 2100000000620; the comparer strips parens.
@Check({
  name: 'ml_destination_kind_check',
  expression: `kind = ANY (ARRAY['local'::text, 'lan'::text, 'frameleaf-cloud'::text])`,
})
export class MlDestinationTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'text' })
  kind!: MlDestinationKind;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  url!: string | null;

  @Column({ type: 'text', nullable: true })
  authToken!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: Generated<boolean>;

  /** Allowed workloads, stored as a JSON array of `MlWorkload` values. */
  @Column({ type: 'jsonb', default: '[]' })
  workloads!: Generated<MlWorkload[]>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  consentAcknowledgedAt!: Timestamp | null;

  @ForeignKeyColumn(() => UserTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  consentAcknowledgedBy!: string | null;

  @Column({ type: 'double precision', nullable: true })
  budgetLimitUsd!: number | null;

  @Column({ type: 'integer', nullable: true })
  maxRuntimeMinutes!: number | null;

  @Column({ type: 'bigint', nullable: true })
  maxUploadBytes!: Int8 | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastProbeAt!: Timestamp | null;

  @Column({ type: 'text', default: MlDestinationHealth.Unknown })
  lastProbeHealth!: Generated<MlDestinationHealth>;

  @Column({ type: 'text', nullable: true })
  lastProbeSummary!: string | null;

  /** Workloads the worker reported on its last probe, or null when it never answered. */
  @Column({ type: 'jsonb', nullable: true })
  lastProbeWorkloads!: MlWorkload[] | null;

  /** What the last check learned about acceleration (`MlProbeHardware`), or null when it never answered. */
  @Column({ type: 'jsonb', nullable: true })
  lastProbeHardware!: MlProbeHardware | null;

  @Column({ type: 'integer', nullable: true })
  lastProbeLatencyMs!: number | null;

  /**
   * A restoration worker on the same GPU as library analysis (FL-72). Full restorations bound
   * to it are not started while library analysis has work waiting.
   */
  @Column({ type: 'boolean', default: false })
  sharesLibraryHardware!: Generated<boolean>;

  /** FL-159: the Frameleaf Cloud data region the destination was created for (`eu`, `na`). */
  @Column({ type: 'text', nullable: true })
  region!: string | null;

  /** FL-159: the consent version the administrator accepted for Frameleaf Cloud. */
  @Column({ type: 'text', nullable: true })
  consentVersion!: string | null;

  /** FL-159: what the last Frameleaf Cloud check learned (`CloudProbeFacts`); null for other kinds. */
  @Column({ type: 'jsonb', nullable: true })
  lastProbeCloud!: CloudProbeFacts | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * The explicit destination for each library workload. The admin sets a route; a job whose
 * workload has no route is refused rather than sent anywhere.
 */
@Table('ml_workload_route')
export class MlWorkloadRouteTable {
  @PrimaryColumn({ type: 'text' })
  workload!: MlWorkload;

  @ForeignKeyColumn(() => MlDestinationTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  destinationId!: string;

  /**
   * FL-159: the Frameleaf Cloud catalogue model chosen for this workload. No longer read or written
   * since FL-186 (`ml_cloud_model_choice` holds the choice); kept so the column is not dropped.
   */
  @Column({ type: 'text', nullable: true })
  modelId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * The Frameleaf Cloud model an administrator chose for each model group (FL-186, migration
 * 2100000000650-AddMlCloudModelChoice): `descriptions`, `upscale`, `restoration-faithful`,
 * `restoration-creative`, `interpolation`, `transcription` and `tts`, keyed as the catalogue keys its
 * defaults. A cloud job reads its group's row whatever its workload's route points at; a group without
 * a row uses the catalogue's default.
 */
@Table('ml_cloud_model_choice')
export class MlCloudModelChoiceTable {
  @PrimaryColumn({ type: 'text' })
  modelGroup!: string;

  /** The catalogue model SKU (`ms_…`). */
  @Column({ type: 'text' })
  modelId!: string;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * One record per request sent to a destination: job identity, destination, bytes and
 * duration. This is the accounting FL-115 reads for measured estimates and billing limits.
 */
@Index({ columns: ['destinationId', 'startedAt'] })
// FL-71: the Job manager's Worker lookup (fork migration 0000000000170-MlWorkloadAccountingJobIndex).
@Index({
  name: 'ml_workload_accounting_jobId_jobName_startedAt_idx',
  expression: '"jobId", "jobName", "startedAt" DESC',
  where: '("jobId" IS NOT NULL)',
  // Created by the fork migration, not the schema generator (as media-operation.table.ts does).
  synchronize: false,
})
// FL-159: settled Frameleaf Cloud charges are matched by cloud job id
// (fork migration 0000000000201-MlWorkloadAccountingCloudJobIndex).
@Index({
  name: 'ml_workload_accounting_cloudJobId_idx',
  columns: ['cloudJobId'],
  where: '("cloudJobId" IS NOT NULL)',
  synchronize: false,
})
@Table('ml_workload_accounting')
export class MlWorkloadAccountingTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => MlDestinationTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  destinationId!: string | null;

  @Column({ type: 'text' })
  destinationKind!: MlDestinationKind;

  @Column({ type: 'text' })
  workload!: MlWorkload;

  @Column({ type: 'text', nullable: true })
  jobId!: string | null;

  @Column({ type: 'text', nullable: true })
  jobName!: string | null;

  @Column({ type: 'bigint', default: 0 })
  bytesSent!: Generated<Int8>;

  @Column({ type: 'bigint', default: 0 })
  bytesReceived!: Generated<Int8>;

  @Column({ type: 'integer', default: 0 })
  durationMs!: Generated<number>;

  @Column({ type: 'text' })
  outcome!: 'success' | 'failure';

  /** Settled cost of this request in USD (Frameleaf Cloud settlements), or null when nothing was charged or it is not settled yet. */
  @Column({ type: 'double precision', nullable: true })
  costUsd!: number | null;

  /** FL-159: AI Wallet credits the settlement reported, when it reported any. */
  @Column({ type: 'double precision', nullable: true })
  credits!: number | null;

  /** FL-159: the Frameleaf Cloud job this row settles, so a settlement finds its row. */
  @Column({ type: 'text', nullable: true })
  cloudJobId!: string | null;

  @Column({ type: 'timestamp with time zone' })
  startedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone' })
  finishedAt!: Timestamp;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
