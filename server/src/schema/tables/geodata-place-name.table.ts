import { Column, PrimaryColumn, Table } from '@frameleaf/sql-tools';

/**
 * FL-987: the name of a GeoNames place (a city, a region or a country) in one of Frameleaf's languages, from
 * the downloaded place-name pack. `geonameId` deliberately has no foreign key: the pack names regions and
 * countries too, and re-importing `geodata_places` must not wipe the names. Names equal to the stored
 * English name are not in the pack, so a missing row means "show the English name".
 */
@Table({ name: 'geodata_place_name', primaryConstraintName: 'geodata_place_name_pkey' })
export class GeodataPlaceNameTable {
  @PrimaryColumn({ type: 'integer' })
  geonameId!: number;

  /** The pack's language code: fr, es, de, it, pt, nl, pl, sv, da or nb. */
  @PrimaryColumn({ type: 'character varying', length: 10 })
  lang!: string;

  @Column({ type: 'character varying', length: 200 })
  name!: string;
}
