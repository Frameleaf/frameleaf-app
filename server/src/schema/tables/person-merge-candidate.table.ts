import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1384: pairs of an owner's people whose faces look alike, worked out overnight so the People page
 * does not compare every person with every other each time it opens. `personId` sorts before
 * `suggestionId`, as in `person_merge_verdict`.
 */
@Table('person_merge_candidate')
export class PersonMergeCandidateTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  personId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  suggestionId!: string;

  /** Cosine distance between the centres of the two people's faces. */
  @Column({ type: 'real' })
  distance!: number;
}
