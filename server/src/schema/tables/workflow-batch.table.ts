import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Table,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { WorkflowDefinitionDocument } from 'src/schema/tables/workflow-definition.table.js';
import type { WorkflowSource } from 'src/utils/workflow-source.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import { WorkflowTable } from 'src/schema/tables/workflow.table.js';

@Table('workflow_batch')
@Check({
  name: 'workflow_batch_status_check',
  expression: "status IN ('pending','running','completed','cancelled','failed')",
})
@Check({ name: 'workflow_batch_reason_check', expression: "reason IN ('manual','schedule')" })
@Index({
  name: 'workflow_batch_active',
  columns: ['workflowId'],
  unique: true,
  where: "status IN ('pending','running')",
})
export class WorkflowBatchTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => WorkflowTable, { onDelete: 'CASCADE', index: false }) workflowId!: string;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', index: false }) ownerId!: string;
  @Column({ type: 'text', default: 'pending' }) status!: Generated<string>;
  @Column({ type: 'text' }) reason!: string;
  @Column({ type: 'jsonb' }) definition!: WorkflowDefinitionDocument;
  @Column({ type: 'jsonb' }) source!: WorkflowSource;
  @Column({ type: 'text', nullable: true }) embedding!: string | null;
  @Column({ type: 'text', nullable: true }) embeddingKey!: string | null;
  @Column({ type: 'text' }) definitionSha256!: string;
  @CreateDateColumn() snapshotAt!: Generated<Timestamp>;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
  @CreateDateColumn() updatedAt!: Generated<Timestamp>;
  @Column({ type: 'timestamp with time zone', nullable: true }) finishedAt!: Timestamp | null;
  @Column({ type: 'integer', default: 0 }) total!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) completed!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) skipped!: Generated<number>;
  @Column({ type: 'integer', default: 0 }) failed!: Generated<number>;
  @Column({ type: 'text', nullable: true }) error!: string | null;
}
@Table('workflow_batch_item')
@Check({ name: 'workflow_batch_item_status_check', expression: "status IN ('pending','completed','skipped','failed')" })
@Index({ columns: ['batchId', 'assetId'], unique: true })
@Index({ name: 'workflow_batch_item_pending', columns: ['batchId', 'id'], where: "status='pending'" })
export class WorkflowBatchItemTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => WorkflowBatchTable, { onDelete: 'CASCADE', index: false }) batchId!: string;
  @Column({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'text', default: 'pending' }) status!: Generated<string>;
  @Column({ type: 'integer', default: 0 }) attempt!: Generated<number>;
  @Column({ type: 'uuid', nullable: true }) fromStepId!: string | null;
}
@Table('workflow_schedule')
export class WorkflowScheduleTable {
  @ForeignKeyColumn(() => WorkflowTable, { primary: true, onDelete: 'CASCADE', index: false }) workflowId!: string;
  @Column({ type: 'text' }) definitionSha256!: string;
  @Column({ type: 'timestamp with time zone' }) nextAt!: Timestamp;
  @Column({ type: 'timestamp with time zone', nullable: true }) lastAt!: Timestamp | null;
}

@Table('workflow_causation')
export class WorkflowCausationTable {
  @PrimaryColumn({ type: 'uuid' }) chainId!: string;
  @ForeignKeyColumn(() => WorkflowTable, { primary: true, onDelete: 'CASCADE', index: false }) workflowId!: string;
  @PrimaryColumn({ type: 'uuid' }) assetId!: string;
  @Column({ type: 'uuid' }) runId!: string;
  @CreateDateColumn() createdAt!: Generated<Timestamp>;
}
