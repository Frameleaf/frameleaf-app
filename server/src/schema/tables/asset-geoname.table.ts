import { Column, ForeignKeyColumn, Table } from '@frameleaf/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';

/**
 * FL-987: the GeoNames places behind an item's stored English city, region and country, so their names can
 * be shown in the viewer's language. A side table: `asset_exif.city`, `state` and `country` are unchanged.
 * A row with every place empty records an item that was looked at and matches no place.
 */
@Table({ name: 'asset_geoname', primaryConstraintName: 'asset_geoname_pkey' })
export class AssetGeonameTable {
  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'integer', nullable: true })
  cityGeonameId!: number | null;

  @Column({ type: 'integer', nullable: true })
  admin1GeonameId!: number | null;

  /** ISO 3166-1 alpha-2. */
  @Column({ type: 'character', length: 2, nullable: true })
  countryCode!: string | null;
}
