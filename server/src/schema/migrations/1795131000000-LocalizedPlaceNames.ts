import { Kysely, sql } from 'kysely';

/**
 * FL-987: place names in the viewer's language. `geodata_place_name` holds the downloaded pack of names;
 * `asset_geoname` links each located item to the places its stored English names came from. Both are side
 * tables: `asset_exif.city`, `state` and `country` keep their values.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE geodata_place_name (
    "geonameId" integer NOT NULL,
    lang character varying(10) NOT NULL,
    name character varying(200) NOT NULL,
    CONSTRAINT geodata_place_name_pkey PRIMARY KEY ("geonameId", lang)
  )`.execute(db);
  await sql`CREATE TABLE asset_geoname (
    "assetId" uuid NOT NULL,
    "cityGeonameId" integer,
    "admin1GeonameId" integer,
    "countryCode" character(2),
    CONSTRAINT asset_geoname_pkey PRIMARY KEY ("assetId"),
    CONSTRAINT "asset_geoname_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES asset (id) ON DELETE CASCADE
  )`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE asset_geoname`.execute(db);
  await sql`DROP TABLE geodata_place_name`.execute(db);
}
