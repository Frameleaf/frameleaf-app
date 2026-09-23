import {
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  Unique,
  UpdateDateColumn,
} from '@immich/sql-tools';
import type { Generated, Timestamp } from '@immich/sql-tools';
import { DocumentEditAction } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * The owner's decisions about the text read from a photo (FL-63). Mirrors migration
 * 2100000000400-AddAssetDocumentEdit.
 *
 * Recognized text lives in `asset_ocr`, which is replaceable: reading the photo again deletes every
 * row and writes new ones with new ids. A decision is therefore never a column on `asset_ocr` and
 * never a foreign key to it. It carries what it needs to find its line again instead:
 *
 * - `key` names what the decision is about: `line:<asset_ocr id at the time>` for one line of
 *   text, `field:<DocumentField>` for a suggested value. One decision per key and asset.
 * - `x1`..`y4` copy the region of the recognized line the decision was made against, in the same
 *   normalized coordinates of the original image as `asset_ocr`. After a new reading the decision
 *   attaches to the line that now covers the same region (`src/utils/documents.ts`).
 * - `sourceText` is the recognized text the decision was made against: the raw provenance. It is
 *   never returned once the recognized line it came from is gone, and a decision whose region a
 *   crop removed is not shown at all, so cropped or replaced text cannot reappear through it.
 * - `revision` counts writes. Every change names the revision it read (optimistic concurrency).
 *
 * No `updateId` and no `updatedAt` trigger: documents are not part of the mobile sync protocol, and
 * `updatedAt` is written explicitly by `DocumentRepository`.
 */
@Unique({ columns: ['assetId', 'key'] })
@Table('asset_document_edit')
export class AssetDocumentEditTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  // [assetId, key] is the unique constraint, which already indexes assetId
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  assetId!: string;

  @Column()
  key!: string;

  @Column()
  action!: DocumentEditAction;

  /** The owner's text for `correct`, the accepted value for `confirm`, null for `dismiss`. */
  @Column({ type: 'text', nullable: true })
  value!: string | null;

  @Column({ type: 'text', nullable: true })
  sourceText!: string | null;

  @Column({ type: 'real', nullable: true })
  x1!: number | null;

  @Column({ type: 'real', nullable: true })
  y1!: number | null;

  @Column({ type: 'real', nullable: true })
  x2!: number | null;

  @Column({ type: 'real', nullable: true })
  y2!: number | null;

  @Column({ type: 'real', nullable: true })
  x3!: number | null;

  @Column({ type: 'real', nullable: true })
  y3!: number | null;

  @Column({ type: 'real', nullable: true })
  x4!: number | null;

  @Column({ type: 'real', nullable: true })
  y4!: number | null;

  @Column({ type: 'integer', default: 1 })
  revision!: Generated<number>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  editedById!: string | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
