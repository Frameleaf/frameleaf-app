import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1789: each person's photo count and most recent photo, stored so that listing people never
 * aggregates faces. A count depends on who is reading, so each row belongs to one viewer variant:
 * `viewerKey` is a hash of everything that decides which photos count (`personViewerKey`). A session
 * without its PIN has a different key from an unlocked one and can never read a number that includes
 * Locked items. A person with no photo this variant may see has no row. When the rows were counted,
 * and how changes since are recognised, is kept once per variant in `person_summary_state`.
 */
@Table({ name: 'person_summary' })
export class PersonSummaryTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  viewerKey!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  personGroupId!: string;

  /** Photos and videos showing the person. */
  @Column({ type: 'integer' })
  assetCount!: number;

  /** Faces of the person in those: what the "minimum faces" preference and the default order count. */
  @Column({ type: 'integer' })
  faceCount!: number;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lastSeenAt!: Timestamp | null;
}
