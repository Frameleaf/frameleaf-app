import { Column, ForeignKeyColumn, PrimaryColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-813: "Allow again". While an account keeps deleted items from being uploaded again, a row here lets
 * these bytes through once more. It covers the deletions made before `createdAt`: deleting the item
 * again later puts it back on the skip list.
 */
@Table('asset_upload_skip_exception')
export class AssetUploadSkipExceptionTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  ownerId!: string;

  @PrimaryColumn({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'timestamp with time zone', default: () => 'now()' })
  createdAt!: Generated<Timestamp>;
}
