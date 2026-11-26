import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyConstraint,
  Index,
  PrimaryGeneratedColumn,
  Table,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PersonTable } from 'src/schema/tables/person.table.js';

/**
 * FL-842: how two of an owner's people are related. A person is named the way `person` names it (the owner plus
 * the API's person id, `person_group.id`), and both ends are composite references, so a relationship always joins
 * two people of the same owner and goes with either of them (and so with the account) when they are deleted.
 *
 * One row per pair, whichever way round it is asked for:
 * - `parent`: `personGroupId` is the parent of `relatedPersonGroupId`; "child" is the same row read from the other
 *   end. `parentRole` says which parent (mother, father or parent).
 * - `partner` and `sibling` have no direction: the smaller id is stored first.
 */
@Table('person_relationship')
@Index({
  name: 'person_relationship_pair_uq',
  expression: `"ownerId", LEAST("personGroupId", "relatedPersonGroupId"), GREATEST("personGroupId", "relatedPersonGroupId")`,
  unique: true,
})
@Index({
  name: 'person_relationship_ownerId_relatedPersonGroupId_idx',
  columns: ['ownerId', 'relatedPersonGroupId'],
})
@ForeignKeyConstraint({
  name: 'person_relationship_ownerId_personGroupId_fkey',
  columns: ['ownerId', 'personGroupId'],
  referenceTable: () => PersonTable,
  referenceColumns: ['ownerId', 'personGroupId'],
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
  index: false,
})
@ForeignKeyConstraint({
  name: 'person_relationship_ownerId_relatedPersonGroupId_fkey',
  columns: ['ownerId', 'relatedPersonGroupId'],
  referenceTable: () => PersonTable,
  referenceColumns: ['ownerId', 'personGroupId'],
  onDelete: 'CASCADE',
  onUpdate: 'CASCADE',
  index: false,
})
@Check({ name: 'person_relationship_kind_chk', expression: `"kind" IN ('parent', 'partner', 'sibling')` })
@Check({ name: 'person_relationship_not_self_chk', expression: `"personGroupId" <> "relatedPersonGroupId"` })
@Check({
  name: 'person_relationship_parentRole_chk',
  expression: `("kind" = 'parent' AND "parentRole" IN ('mother', 'father', 'parent')) OR ("kind" <> 'parent' AND "parentRole" IS NULL)`,
})
@Check({
  name: 'person_relationship_order_chk',
  expression: `"kind" = 'parent' OR "personGroupId" < "relatedPersonGroupId"`,
})
export class PersonRelationshipTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'uuid' })
  personGroupId!: string;

  @Column({ type: 'uuid' })
  relatedPersonGroupId!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text', nullable: true })
  parentRole!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
