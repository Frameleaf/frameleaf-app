import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Timestamp } from '@frameleaf/sql-tools';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1385: a person who may hold the faces of two different people, worked out overnight. `faceIds`
 * are the smaller group, the faces that may be someone else.
 */
@Table('person_split_candidate')
export class PersonSplitCandidateTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  personId!: string;

  @Column({ type: 'uuid', array: true })
  faceIds!: string[];

  /** Cosine distance between the centres of the two groups of faces. */
  @Column({ type: 'real' })
  distance!: number;

  /** The owner's answer: not asked again before this time ("same person" is forever). */
  @Column({ type: 'timestamp with time zone', nullable: true })
  dismissedUntil!: Timestamp | null;
}
