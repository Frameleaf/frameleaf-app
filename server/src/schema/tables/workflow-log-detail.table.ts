import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@immich/sql-tools';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';

/**
 * What a workflow run log entry does not record (FL-82): which attempt it was and why it failed.
 * Mirrors migration 2100000000570-AddWorkflowDefinitions.
 *
 * Keyed by the `workflow_log` id without a foreign key, because the log table itself belongs to the
 * shared workflow schema; the owning workflow's cascade removes these rows with it.
 */
@Table('workflow_log_detail')
export class WorkflowLogDetailTable {
  @PrimaryColumn({ type: 'uuid' })
  logId!: string;

  @ForeignKeyColumn(() => WorkflowTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  workflowId!: string;

  /** 0 for the first run, 1 for the automatic retry, higher for manual retries. */
  @Column({ type: 'integer', default: 0 })
  attempt!: number;

  /** `WorkflowRunErrorCode`. */
  @Column({ nullable: true })
  errorCode!: string | null;

  /** The failure, shortened and with the step's stored credentials removed. */
  @Column({ nullable: true })
  error!: string | null;
}
