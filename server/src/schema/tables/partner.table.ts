import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { CreateIdColumn, UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { partner_delete_audit } from 'src/schema/functions.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('partner')
@UpdatedAtTrigger('partner_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: partner_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
export class PartnerTable {
  @ForeignKeyColumn(() => UserTable, {
    onDelete: 'CASCADE',
    primary: true,
    // [sharedById, sharedWithId] is the PK constraint
    index: false,
  })
  sharedById!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', primary: true })
  sharedWithId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @CreateIdColumn({ index: true })
  createId!: Generated<string>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'boolean', default: false })
  inTimeline!: Generated<boolean>;

  /**
   * Set by the sharing user (`sharedById`): whether `sharedWithId` may see the sharer's asset locations.
   * Off for a new partnership until the sharer turns it on (prototype default, FL-146 AL-40).
   */
  @Column({ type: 'boolean', default: false })
  shareLocation!: Generated<boolean>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
