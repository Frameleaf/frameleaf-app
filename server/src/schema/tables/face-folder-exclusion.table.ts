import { Column, ForeignKeyColumn, PrimaryGeneratedColumn, Table, Unique } from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * FL-934: a folder whose photos an owner leaves out of face recognition. `pathPrefix` is an absolute
 * folder path ending in `/`, matched against the start of `asset.originalPath` of that owner's photos
 * only, so `/photos/scan/` never takes in `/photos/scans/` and a partner's copy follows its own owner.
 */
@Table('face_folder_exclusion')
@Unique({ columns: ['ownerId', 'pathPrefix'] })
export class FaceFolderExclusionTable {
  @PrimaryGeneratedColumn() id!: Generated<string>;
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false }) ownerId!: string;
  @Column() pathPrefix!: string;
  @Column({ type: 'timestamp with time zone', default: () => 'now()' }) createdAt!: Generated<Timestamp>;
}
