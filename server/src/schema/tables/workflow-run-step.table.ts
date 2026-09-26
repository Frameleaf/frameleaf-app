import { Column, CreateDateColumn, ForeignKeyColumn, PrimaryColumn, Table } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';

/**
 * The steps one queued workflow run has completed (FL-179). Mirrors migration
 * 2100000000630-AddWorkflowRunStep.
 *
 * When a worker stops mid-run, the queue replays the job with the same data, from its first step. A
 * replay reads these rows by the job's `executionId` and skips the steps already done, so none of them
 * runs twice. Every newly queued run, including an automatic or manual retry, has its own
 * `executionId`, so a retry is never shortened by an earlier run. `stepId` has no foreign key: a row
 * outlives an edit of the workflow for as long as a replay could need it, and the nightly database
 * cleanup removes old rows.
 */
@Table('workflow_run_step')
export class WorkflowRunStepTable {
  @PrimaryColumn({ type: 'uuid' })
  executionId!: string;

  @PrimaryColumn({ type: 'uuid' })
  stepId!: string;

  @ForeignKeyColumn(() => WorkflowTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  workflowId!: string;

  /** The step asked the run to stop, so a replay stops there too. */
  @Column({ type: 'boolean', default: false })
  halted!: Generated<boolean>;

  /** Indexed for the nightly cleanup, which removes rows by age. */
  @CreateDateColumn({ index: true })
  createdAt!: Generated<Timestamp>;
}
