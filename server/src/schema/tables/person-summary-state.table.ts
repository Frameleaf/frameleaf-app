import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1789: for each viewer variant of an owner's `person_summary` rows, when they were counted and the
 * digest of the changes seen since `checkedFrom` (see `PersonRepository.syncSummaries`). A variant with
 * no state row has no usable summaries.
 */
@Table({ name: 'person_summary_state' })
export class PersonSummaryStateTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  viewerKey!: string;

  /** When the rows were counted; taken before the count. */
  @Column({ type: 'timestamp with time zone' })
  computedAt!: Timestamp;

  /** Where the change digest starts: a while before the count, to catch changes committed late. */
  @Column({ type: 'timestamp with time zone' })
  checkedFrom!: Timestamp;

  /** The digest of the changes from `checkedFrom`, or null when there were too many to compare. */
  @Column({ type: 'text', nullable: true })
  changeToken!: string | null;
}
