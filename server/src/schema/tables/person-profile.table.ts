import { Check, Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PersonGroupTable } from 'src/schema/tables/person-group.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';
import type { LifeDatePrecision } from 'src/utils/date.js';

/**
 * FL-864, FL-941: what an owner keeps about one of their people beyond the upstream `person` row: the date of
 * passing and private notes. Keyed like `person` itself (`ownerId` + the API's person id, `person_group.id`), so a
 * partner's copy of the same person has its own row. Notes are only ever returned to that owner.
 */
@Table('person_profile')
@Check({
  name: 'person_profile_birthDatePrecision_check',
  expression: `"birthDatePrecision" = ANY (ARRAY['month'::text, 'year'::text, 'about'::text])`,
})
@Check({
  name: 'person_profile_deathDatePrecision_check',
  expression: `"deathDatePrecision" = ANY (ARRAY['month'::text, 'year'::text, 'about'::text])`,
})
export class PersonProfileTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @ForeignKeyColumn(() => PersonGroupTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  personId!: string;

  @Column({ type: 'date', nullable: true })
  deathDate!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  /**
   * FL-1814: how much of the date of birth (on `person`) and of passing (above) is known; null is the exact day.
   * Kept here, with the owner's own details, so a partner's copy of the person never takes them.
   */
  @Column({ type: 'text', nullable: true })
  birthDatePrecision!: LifeDatePrecision | null;

  @Column({ type: 'text', nullable: true })
  deathDatePrecision!: LifeDatePrecision | null;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;
}
