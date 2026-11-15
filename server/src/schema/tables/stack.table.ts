import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { stack_delete_audit } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('stack')
@UpdatedAtTrigger('stack_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: stack_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
export class StackTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;

  //TODO: Add constraint to ensure primary asset exists in the assets array
  @ForeignKeyColumn(() => AssetTable, { nullable: false, unique: true })
  primaryAssetId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  ownerId!: string;

  /** FL-953: made by automatic burst stacking, not by a person; the owner's setting can take it apart. */
  @Column({ type: 'boolean', default: false })
  isAutomatic!: Generated<boolean>;

  /** FL-953: which automatic stacking made it; null for a stack a person made. */
  @Column({ type: 'smallint', nullable: true, default: null })
  autoVersion!: Generated<number | null>;
}
