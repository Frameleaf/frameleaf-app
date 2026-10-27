import { Column, CreateDateColumn, ForeignKeyColumn, Index, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated, Int8, Timestamp } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-413: the identical-files journal. Mirrors migration 2100000003009-IdenticalFileChange.
 *
 * One row per photo the identical-files run pointed at another person's identical file (`link`): its own
 * former path and content, and the Unused files entry its own file went to. That is what "Restore own
 * file" undoes; an undone row (`undoneAt`) keeps the photo from ever being linked again automatically.
 * Merges inside one library are the owner's duplicate decisions (FL-61) and are journalled there.
 */
@Table('identical_file_change')
@Index({ columns: ['assetId'] })
@Index({ columns: ['runId'] })
export class IdenticalFileChangeTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ type: 'uuid' })
  runId!: string;

  /** `link`. */
  @Column()
  kind!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  assetId!: string;

  /** The photo whose file was kept; null once it is gone. */
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  keptAssetId!: string | null;

  /** The photo's own former file. */
  @Column()
  ownPath!: string;

  /** SHA-256 of the content. */
  @Column({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'bigint' })
  sizeInBytes!: Int8;

  /** The Unused files entry the photo's own file went to; null while something still held it. */
  @Column({ type: 'uuid', nullable: true })
  trashEntryId!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @Column({ type: 'timestamp with time zone', nullable: true })
  undoneAt!: Timestamp | null;
}
