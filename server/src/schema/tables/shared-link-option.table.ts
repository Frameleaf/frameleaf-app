import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { SharedLinkTable } from 'src/schema/tables/shared-link.table.js';

/**
 * FL-826: what Frameleaf adds to a shared link, beside the upstream `shared_link` table. A link without a
 * row has every option at its default.
 */
@Table('shared_link_option')
export class SharedLinkOptionTable {
  @ForeignKeyColumn(() => SharedLinkTable, { primary: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  sharedLinkId!: string;

  /** Downloads through the link are web size (2048 px JPEG) only, whatever format is asked for. */
  @Column({ type: 'boolean', default: false })
  webSizeOnly!: Generated<boolean>;
}
