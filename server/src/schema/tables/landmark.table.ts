import { Column, ForeignKeyColumn, Index, PrimaryColumn, PrimaryGeneratedColumn, Table } from '@frameleaf/sql-tools';
import type { Generated } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/** A notable place from the bundled place pack (FL-352). `id` is its Wikidata id. */
@Table({ name: 'landmark', primaryConstraintName: 'landmark_pkey' })
@Index({
  name: 'landmark_gist_earthcoord_idx',
  using: 'gist',
  expression: 'll_to_earth_public(latitude, longitude)',
})
export class LandmarkTable {
  @PrimaryColumn({ type: 'character varying', length: 20 })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  /** Names by language code, where they differ from `name`. */
  @Column({ type: 'jsonb', default: '{}' })
  names!: Generated<Record<string, string>>;

  @Column({ type: 'character varying', length: 20 })
  kind!: string;

  @Column({ type: 'double precision' })
  latitude!: number;

  @Column({ type: 'double precision' })
  longitude!: number;

  /** A photo farther than this from the centre is never at this place. */
  @Column({ type: 'integer' })
  radiusM!: number;

  /** Wikipedia language editions covering the place: its fame. */
  @Column({ type: 'integer' })
  rank!: number;
}

/** One outer boundary ring of an area place. A place with no rows here is matched by radius alone. */
@Table({ name: 'landmark_area', primaryConstraintName: 'landmark_area_pkey' })
@Index({ name: 'landmark_area_landmarkId_idx', columns: ['landmarkId'] })
export class LandmarkAreaTable {
  @PrimaryGeneratedColumn({ strategy: 'identity' })
  id!: Generated<number>;

  @Column({ type: 'character varying', length: 20 })
  landmarkId!: string;

  @Column({ type: 'polygon' })
  area!: string;
}

/**
 * Every place an asset was taken at. `landmarkId` deliberately has no foreign key: re-importing the
 * place pack replaces the `landmark` rows and must not wipe the matches.
 */
@Table({ name: 'asset_landmark', primaryConstraintName: 'asset_landmark_pkey' })
@Index({ name: 'asset_landmark_landmarkId_idx', columns: ['landmarkId'] })
export class AssetLandmarkTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true })
  assetId!: string;

  @PrimaryColumn({ type: 'character varying', length: 20 })
  landmarkId!: string;
}
