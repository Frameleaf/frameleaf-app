import { Column, ForeignKeyColumn, Table, UpdateDateColumn } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';

/** One ordered step of a stored workflow definition (FL-82). */
export type WorkflowDefinitionStep = {
  /** Stable step id. A step whose method is installed runs as the `workflow_step` row with this id. */
  id: string;
  /** `plugin#method`, kept exactly as written even when no installed plugin provides it. */
  method: string;
  config: Record<string, unknown> | null;
  enabled: boolean;
  /** Fields of the imported step this server does not use, returned unchanged on export. */
  extra: Record<string, unknown>;
};

export type WorkflowDefinitionDocument = {
  version: 1;
  /** The trigger as written, including one this server does not offer. */
  trigger: string;
  /** Top-level fields of the imported definition this server does not use. */
  extra: Record<string, unknown>;
  steps: WorkflowDefinitionStep[];
};

/**
 * The complete workflow definition as its owner wrote or imported it (FL-82). Mirrors migration
 * 2100000000570-AddWorkflowDefinitions.
 *
 * `workflow_step` only holds steps an installed plugin can run, and a plugin upgrade that drops a
 * method deletes that method's steps with it. This row keeps every step — unknown methods, their
 * parameters and any additional fields — so nothing is lost on import, export or a plugin change,
 * and execution compares the two to refuse a workflow whose definition it cannot run completely.
 */
@Table('workflow_definition')
export class WorkflowDefinitionTable {
  @ForeignKeyColumn(() => WorkflowTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  workflowId!: string;

  @Column({ type: 'jsonb' })
  definition!: WorkflowDefinitionDocument;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
