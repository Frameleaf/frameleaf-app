import {
  AfterInsertTrigger,
  AfterUpdateTrigger,
  Column,
  ForeignKeyColumn,
  Index,
  Int8,
  Table,
  UpdateDateColumn,
} from '@frameleaf/sql-tools';
import type { Generated, Timestamp } from '@frameleaf/sql-tools';
import type { ImageEncodingInfo } from 'src/dtos/image-encoding.dto.js';
import { LockableProperty } from 'src/database.js';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { asset_exif_landmark_match } from 'src/schema/functions.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';

@Table('asset_exif')
@Index({
  name: 'IDX_asset_exif_gist_earthcoord',
  using: 'gist',
  expression: 'll_to_earth_public(latitude, longitude)',
})
@Index({
  name: 'idx_asset_exif_description_trigram',
  using: 'gin',
  expression: 'f_unaccent("description") gin_trgm_ops',
})
// Rating and capture time live on different tables: this supplies the rating prefix,
// while PostgreSQL still orders matching assets by capture time and id after the join.
@Index({
  name: 'asset_exif_rating_order_idx',
  expression: '(COALESCE(rating, 0)) DESC, "assetId"',
})
@UpdatedAtTrigger('asset_exif_updatedAt')
@AfterInsertTrigger({
  name: 'asset_exif_landmark_match_insert',
  scope: 'row',
  function: asset_exif_landmark_match,
})
@AfterUpdateTrigger({
  name: 'asset_exif_landmark_match_update',
  scope: 'row',
  function: asset_exif_landmark_match,
})
export class AssetExifTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'character varying', nullable: true })
  make!: string | null;

  @Column({ type: 'character varying', nullable: true })
  model!: string | null;

  @Column({ type: 'integer', nullable: true })
  exifImageWidth!: number | null;

  @Column({ type: 'integer', nullable: true })
  exifImageHeight!: number | null;

  @Column({ type: 'bigint', nullable: true })
  fileSizeInByte!: Int8 | null;

  @Column({ type: 'character varying', nullable: true })
  orientation!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  dateTimeOriginal!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  modifyDate!: Timestamp | null;

  @Column({ type: 'character varying', nullable: true })
  lensModel!: string | null;

  @Column({ type: 'double precision', nullable: true })
  fNumber!: number | null;

  @Column({ type: 'double precision', nullable: true })
  focalLength!: number | null;

  @Column({ type: 'integer', nullable: true })
  iso!: number | null;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'character varying', nullable: true, index: true })
  city!: string | null;

  @Column({ type: 'character varying', nullable: true })
  state!: string | null;

  @Column({ type: 'character varying', nullable: true })
  country!: string | null;

  @Column({ type: 'text', default: '' })
  description!: Generated<string>; // or caption

  @Column({ type: 'double precision', nullable: true })
  fps!: number | null;

  @Column({ type: 'character varying', nullable: true })
  exposureTime!: string | null;

  @Column({ type: 'character varying', nullable: true, index: true })
  livePhotoCID!: string | null;

  @Column({ type: 'character varying', nullable: true })
  timeZone!: string | null;

  @Column({ type: 'character varying', nullable: true })
  projectionType!: string | null;

  @Column({ type: 'character varying', nullable: true })
  profileDescription!: string | null;

  @Column({ type: 'character varying', nullable: true })
  colorspace!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  imageEncoding!: ImageEncodingInfo | null;

  @Column({ type: 'integer', nullable: true })
  bitsPerSample!: number | null;

  @Column({ type: 'character varying', nullable: true, index: true })
  autoStackId!: string | null;

  @Column({ type: 'integer', nullable: true })
  rating!: number | null;

  @Column({ type: 'character varying', array: true, nullable: true })
  tags!: string[] | null;

  @UpdateDateColumn({ default: () => 'clock_timestamp()' })
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ type: 'character varying', array: true, nullable: true })
  lockedProperties!: Array<LockableProperty> | null;
}
