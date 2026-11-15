import { Check, Column, ForeignKeyConstraint, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { PartnerTable } from 'src/schema/tables/partner.table.js';

/**
 * FL-774: what a partnership shares when its owner chose "Only what I choose". No row means Everything. An item
 * of the owner's is copied when it matches any chosen album, person or folder (or when none is chosen), and was
 * taken on or after `sinceDate` when one is set. Mirrors migration 1794730000000-PartnerScope.
 */
@Table('partner_scope')
@ForeignKeyConstraint({
  columns: ['sharedById', 'sharedWithId'],
  referenceTable: () => PartnerTable,
  referenceColumns: ['sharedById', 'sharedWithId'],
  onUpdate: 'NO ACTION',
  onDelete: 'CASCADE',
})
@Check({
  name: 'partner_scope_chooses_check',
  expression: `"sinceDate" IS NOT NULL OR cardinality("albumIds") > 0 OR cardinality("personIds") > 0 OR cardinality(folders) > 0`,
})
export class PartnerScopeTable {
  @PrimaryColumn({ type: 'uuid' })
  sharedById!: string;

  @PrimaryColumn({ type: 'uuid' })
  sharedWithId!: string;

  @Column({ type: 'date', nullable: true })
  sinceDate!: string | null;

  @Column({ type: 'uuid', array: true, default: [] })
  albumIds!: Generated<string[]>;

  /** The API's person ids (`asset_face.personGroupId`). */
  @Column({ type: 'uuid', array: true, default: [] })
  personIds!: Generated<string[]>;

  /** Folder paths as the Folders view names them; a folder also chooses the folders inside it. */
  @Column({ type: 'text', array: true, default: [] })
  folders!: Generated<string[]>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  updatedAt!: Generated<Timestamp>;
}
