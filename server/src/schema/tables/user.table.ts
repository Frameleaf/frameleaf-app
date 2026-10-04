import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import type { ColumnType } from 'kysely';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { UserAvatarColor, UserStatus } from 'src/enum.js';
import { user_delete_audit } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { ClusterGroupTable } from 'src/schema/tables/cluster-group.table.js';

@Table('user')
@UpdatedAtTrigger('user_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: user_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
@Index({ columns: ['updatedAt', 'id'] })
export class UserTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ unique: true })
  email!: string;

  @Column({ nullable: true, default: null })
  password!: string | null;

  @Column({ nullable: true })
  pinCode!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ default: '' })
  profileImagePath!: Generated<string>;

  /**
   * The photo the profile picture was copied from, when it was copied from one (FL-53). A picture copied
   * from a photo that later becomes Locked is replaced (`replaceLockedProfileImages`).
   */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  profileImageAssetId!: string | null;

  @Column({ type: 'boolean', default: false })
  isAdmin!: Generated<boolean>;

  @Column({ type: 'boolean', default: true })
  shouldChangePassword!: Generated<boolean>;

  @Column({ default: null })
  avatarColor!: UserAvatarColor | null;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ nullable: true })
  oauthId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ unique: true, nullable: true, default: null })
  storageLabel!: string | null;

  // TODO remove default, make nullable, and convert empty spaces to null
  @Column({ default: '' })
  name!: string;

  @Column({ type: 'bigint', nullable: true })
  quotaSizeInBytes!: ColumnType<number> | null;

  @Column({ type: 'bigint', default: 0 })
  quotaUsageInBytes!: Generated<ColumnType<number>>;

  @Column({ type: 'character varying', default: UserStatus.Active })
  status!: Generated<UserStatus>;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  profileChangedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @ForeignKeyColumn(() => ClusterGroupTable, { onUpdate: 'CASCADE', nullable: false })
  clusterGroupId!: string;
}
