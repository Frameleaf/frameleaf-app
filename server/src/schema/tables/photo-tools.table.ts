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
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

/**
 * A reusable develop preset (FL-64). Mirrors migration 2100000000540-AddPhotoToolsPresetsAndExports.
 *
 * A preset is its owner's alone: a name and the develop settings it applies (sliders, look and
 * strength, selective masks). It holds no pixels and no reference to any asset, so it can be
 * applied to any photo the owner may edit. `updatedAt` is written by the queries that change the
 * row; there is no trigger.
 */
@Unique({ columns: ['ownerId', 'name'] })
@Table('develop_preset')
export class DevelopPresetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  name!: string;

  /** `DevelopPresetSettings`: normalized on every write. */
  @Column({ type: 'jsonb' })
  settings!: Record<string, unknown>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}

/**
 * An original handed out for development in another application (FL-64). Mirrors migration
 * 2100000000540-AddPhotoToolsPresetsAndExports.
 *
 * `sourceChecksum` is the SHA-256 of the original's bytes when it was exported. A file brought
 * back against this export is accepted only while the asset's original still has that checksum,
 * so a return can never attach to a replaced or different original. Rows go with the asset.
 */
@Table('develop_export')
export class DevelopExportTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  assetId!: string;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column({ type: 'bytea' })
  sourceChecksum!: Buffer;

  @Column()
  fileName!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;
}
