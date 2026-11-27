import { CreateDateColumn, ForeignKeyColumn, Index, Table } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { AlbumTable } from 'src/schema/tables/album.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-1814: the albums each account itself last added items to, for the album picker's "Used lately".
 * One row per account and album; adding again moves `usedAt` forward.
 */
@Table('album_recent_use')
@Index({ name: 'album_recent_use_userId_usedAt_idx', columns: ['userId', 'usedAt'] })
export class AlbumRecentUseTable {
  @ForeignKeyColumn(() => UserTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  userId!: string;

  @ForeignKeyColumn(() => AlbumTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  albumId!: string;

  @CreateDateColumn()
  usedAt!: Generated<Timestamp>;
}
