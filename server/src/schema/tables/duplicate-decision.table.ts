import { Column, CreateDateColumn, ForeignKeyColumn, Index, Table, Unique } from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { PrimaryGeneratedUuidV7Column } from 'src/decorators.js';
import { DuplicateDecisionKind } from 'src/enum.js';
import { MediaOperationTable } from 'src/schema/tables/media-operation.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * One duplicate review decision (FL-61). Mirrors migration 2100000000390-AddDuplicateDecision.
 *
 * The row is what makes a decision reversible after the page that made it is gone: the complete
 * group as it was decided, what was kept, what was trashed, the stack that was made, and the keepers'
 * state before their group's metadata was merged into them. It is written by the durable job that
 * applies the decision (`operationId`) before anything changes, and completed (`appliedAt`) after; an
 * undo is another durable job (`undoOperationId`) that reverses it only while nothing has changed.
 *
 * Only the owner of every photo in the group ever decides it, and only they read these rows.
 * Originals are never touched: a decision trashes, stacks or dismisses, and emptying the trash is
 * separate.
 */
@Index({ columns: ['ownerId', 'createdAt'] })
@Index({ columns: ['ownerId', 'duplicateId'] })
@Unique({ columns: ['operationId', 'duplicateId'] })
@Table('duplicate_decision')
export class DuplicateDecisionTable {
  @PrimaryGeneratedUuidV7Column()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  /** The group as it was when the decision was made. A group is an id on its members, not a row. */
  @Column({ type: 'uuid' })
  duplicateId!: string;

  /** The job that applied the decision. */
  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  operationId!: string | null;

  /** `DuplicateDecisionKind`. */
  @Column()
  decision!: DuplicateDecisionKind;

  /** Every photo of the group, as the owner reviewed it. */
  @Column({ type: 'jsonb' })
  memberIds!: string[];

  @Column({ type: 'jsonb' })
  keepAssetIds!: string[];

  @Column({ type: 'jsonb' })
  trashAssetIds!: string[];

  /** The stack a `stack` decision made. */
  @Column({ type: 'uuid', nullable: true })
  stackId!: string | null;

  /** The keepers' state before the decision and after it, so an undo never overwrites a newer edit. */
  @Column({ type: 'jsonb', default: '{}' })
  state!: Generated<Record<string, unknown>>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  /** Null while the decision is being applied. */
  @Column({ type: 'timestamp with time zone', nullable: true })
  appliedAt!: Timestamp | null;

  /** The job reversing the decision, from the moment it starts. */
  @ForeignKeyColumn(() => MediaOperationTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  undoOperationId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;
}
