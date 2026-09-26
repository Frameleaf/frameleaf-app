import { Injectable } from '@nestjs/common';
import isoCountries from 'i18n-iso-countries';
import { type Expression, type Insertable, type Kysely, type NotNull, type SqlBool, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import readLine from 'node:readline';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { citiesFile, reverseGeocodeMaxDistance } from 'src/constants.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetVisibility, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { GeodataPlacesTable } from 'src/schema/tables/geodata-places.table.js';
import { NaturalEarthCountriesTable } from 'src/schema/tables/natural-earth-countries.table.js';
import { withAlbumVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { isTimelineVisible, visibilityIs } from 'src/utils/locked.js';

export interface MapMarkerSearchOptions extends HiddenContentQueryOptions {
  isArchived?: boolean;
  isFavorite?: boolean;
  fileCreatedBefore?: Date;
  fileCreatedAfter?: Date;
  /** FL-54: owners who hide their locations from the viewer; their assets contribute no markers */
  locationHiddenOwnerIds?: string[];
}

/** A timestamptz column as an ISO-8601 UTC string, the shape the JSON API returns for dates. */
const isoTimestamp = (column: 'asset.fileCreatedAt' | 'asset.localDateTime') =>
  sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The settings sheet's filters for an album map (FL-51). Each narrows the album's own markers; favorites
 * are matched only among `favoriteOwnerId`'s own items, because a favorite is private to its owner.
 */
export interface AlbumMapMarkerSearchOptions {
  isArchived?: boolean;
  isFavorite?: boolean;
  fileCreatedBefore?: Date;
  fileCreatedAfter?: Date;
  favoriteOwnerId?: string;
  /** Keep only album items this user owns (the sheet's "Partner items" switched off). Only ever narrows the album. */
  onlyOwnerId?: string;
  /** FL-54: owners who hide their locations from the viewer (for a shared link, its creator) */
  locationHiddenOwnerIds?: string[];
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface ReverseGeocodeResult {
  country: string | null;
  state: string | null;
  city: string | null;
}

interface MapDB extends DB {
  geodata_places_tmp: GeodataPlacesTable;
  naturalearth_countries_tmp: NaturalEarthCountriesTable;
}

@Injectable()
export class MapRepository {
  constructor(
    private configRepository: ConfigRepository,
    private metadataRepository: SystemMetadataRepository,
    private logger: LoggingRepository,
    @InjectKysely() private db: Kysely<MapDB>,
  ) {
    this.logger.setContext(MapRepository.name);
  }

  async init(): Promise<void> {
    this.logger.log('Initializing metadata repository');
    const { resourcePaths } = this.configRepository.getEnv();
    const geodataDate = await readFile(resourcePaths.geodata.dateFile, 'utf8');

    // TODO move to service init
    const geocodingMetadata = await this.metadataRepository.get(SystemMetadataKey.ReverseGeocodingState);
    if (geocodingMetadata?.lastUpdate === geodataDate) {
      return;
    }

    await Promise.all([this.importGeodata(), this.importNaturalEarthCountries()]);

    await this.metadataRepository.set(SystemMetadataKey.ReverseGeocodingState, {
      lastUpdate: geodataDate,
      lastImportFileName: citiesFile,
    });

    this.logger.log('Geodata import completed');
  }

  /** Markers for an album: the same media the album itself shows this viewer (see `withAlbumVisibility`). */
  @GenerateSql({ params: [DummyValue.UUID] })
  getAlbumMapMarkers(
    albumId: string,
    options: HiddenContentQueryOptions & LockedVisibilityOptions & AlbumMapMarkerSearchOptions = {},
  ) {
    const {
      isArchived,
      isFavorite,
      fileCreatedAfter,
      fileCreatedBefore,
      favoriteOwnerId,
      onlyOwnerId,
      locationHiddenOwnerIds,
    } = options;
    return (
      this.mapMarkersQuery()
        .innerJoin('album_asset', 'asset.id', 'album_asset.assetId')
        .where('album_asset.albumId', '=', albumId)
        .$call((qb) => withAlbumVisibility(qb, options.lockedOwnerId))
        .$call((qb) => withHiddenContentFilter(qb, options))
        // an album shows archived items, so only an explicit `false` leaves them out
        .$if(isArchived === false, (qb) => qb.where('asset.visibility', '!=', sql.lit(AssetVisibility.Archive)))
        .$if(isFavorite !== undefined && !!favoriteOwnerId, (qb) =>
          qb.where((eb) => {
            const ownFavorite = eb.and([eb('asset.isFavorite', '=', true), eb('asset.ownerId', '=', favoriteOwnerId!)]);
            return isFavorite ? ownFavorite : eb.not(ownFavorite);
          }),
        )
        .$if(fileCreatedAfter !== undefined, (qb) => qb.where('asset.fileCreatedAt', '>=', fileCreatedAfter!))
        .$if(fileCreatedBefore !== undefined, (qb) => qb.where('asset.fileCreatedAt', '<=', fileCreatedBefore!))
        .$if(!!onlyOwnerId, (qb) => qb.where('asset.ownerId', '=', onlyOwnerId!))
        .$if(!!locationHiddenOwnerIds?.length, (qb) => qb.where('asset.ownerId', 'not in', locationHiddenOwnerIds!))
        .execute()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  getMapMarkers(authUserId: string, ownerIds: string[], albumIds: string[], options: MapMarkerSearchOptions = {}) {
    const { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore, locationHiddenOwnerIds } = options;
    return this.mapMarkersQuery()
      .$call((qb) => withHiddenContentFilter(qb, options))
      .$if(isArchived === true, (qb) =>
        qb.where((eb) =>
          eb.or([
            isTimelineVisible('asset'),
            eb.and([eb('asset.ownerId', '=', authUserId), visibilityIs(AssetVisibility.Archive, 'asset')]),
          ]),
        ),
      )
      .$if(isArchived === false || isArchived === undefined, (qb) => qb.where(isTimelineVisible('asset')))
      .$if(isFavorite !== undefined, (q) => q.where('isFavorite', '=', isFavorite!))
      .$if(fileCreatedAfter !== undefined, (q) => q.where('fileCreatedAt', '>=', fileCreatedAfter!))
      .$if(fileCreatedBefore !== undefined, (q) => q.where('fileCreatedAt', '<=', fileCreatedBefore!))
      .$if(!!locationHiddenOwnerIds?.length, (qb) => qb.where('asset.ownerId', 'not in', locationHiddenOwnerIds!))
      .where((eb) => {
        const expression: Expression<SqlBool>[] = [];

        if (ownerIds.length > 0) {
          expression.push(eb('ownerId', 'in', ownerIds));
        }

        if (albumIds.length > 0) {
          expression.push(
            eb.exists((eb) =>
              eb
                .selectFrom('album_asset')
                .innerJoin('album_user as album_owner', (join) =>
                  join
                    .onRef('album_owner.albumId', '=', 'album_asset.albumId')
                    .on('album_owner.role', '=', sql.lit(AlbumUserRole.Owner)),
                )
                .whereRef('asset.id', '=', 'album_asset.assetId')
                .where('album_asset.albumId', 'in', albumIds)
                // FL-54 owner default: an item whose owner hides locations from the album's owner puts no
                // marker on the map through that album
                .where((eb) =>
                  eb.not(
                    eb.exists(
                      eb
                        .selectFrom('partner')
                        .whereRef('partner.sharedById', '=', 'asset.ownerId')
                        .whereRef('partner.sharedWithId', '=', 'album_owner.userId')
                        .whereRef('partner.sharedById', '!=', 'partner.sharedWithId')
                        .where('partner.shareLocation', '=', false),
                    ),
                  ),
                ),
            ),
          );
        }

        return eb.or(expression);
      })
      .execute();
  }

  /**
   * FL-51: counts for the map settings sheet under its date and favorite filters: the owner's
   * located archived items, partners' located timeline items, and the owner's timeline items with no
   * location. Hidden content follows the session.
   */
  async getMapStatistics(
    authUserId: string,
    partnerIds: string[],
    options: MapMarkerSearchOptions = {},
  ): Promise<{ archived: number; partner: number; unlocated: number }> {
    const { isFavorite, fileCreatedAfter, fileCreatedBefore } = options;
    const base = () =>
      this.db
        .selectFrom('asset')
        .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .where('asset.deletedAt', 'is', null)
        .$call((qb) => withHiddenContentFilter(qb, options))
        .$if(isFavorite !== undefined, (qb) => qb.where('asset.isFavorite', '=', isFavorite!))
        .$if(fileCreatedAfter !== undefined, (qb) => qb.where('asset.fileCreatedAt', '>=', fileCreatedAfter!))
        .$if(fileCreatedBefore !== undefined, (qb) => qb.where('asset.fileCreatedAt', '<=', fileCreatedBefore!));

    const [archived, partner, unlocated] = await Promise.all([
      base()
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('asset.ownerId', '=', authUserId)
        .where(visibilityIs(AssetVisibility.Archive, 'asset'))
        .where('asset_exif.latitude', 'is not', null)
        .where('asset_exif.longitude', 'is not', null)
        .executeTakeFirst(),
      partnerIds.length > 0
        ? base()
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('asset.ownerId', 'in', partnerIds)
            .where(isTimelineVisible('asset'))
            .where('asset_exif.latitude', 'is not', null)
            .where('asset_exif.longitude', 'is not', null)
            .executeTakeFirst()
        : Promise.resolve({ count: 0 }),
      base()
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('asset.ownerId', '=', authUserId)
        .where(isTimelineVisible('asset'))
        .where((eb) => eb.or([eb('asset_exif.latitude', 'is', null), eb('asset_exif.longitude', 'is', null)]))
        .executeTakeFirst(),
    ]);

    return {
      archived: Number(archived?.count ?? 0),
      partner: Number(partner?.count ?? 0),
      unlocated: Number(unlocated?.count ?? 0),
    };
  }

  private mapMarkersQuery() {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_exif', (builder) =>
        builder
          .onRef('asset.id', '=', 'asset_exif.assetId')
          .on('asset_exif.latitude', 'is not', null)
          .on('asset_exif.longitude', 'is not', null),
      )
      .where('asset.deletedAt', 'is', null)
      .orderBy('asset.fileCreatedAt', 'desc')
      .select([
        'id',
        'asset_exif.latitude as lat',
        'asset_exif.longitude as lon',
        'asset_exif.city',
        'asset_exif.state',
        'asset_exif.country',
        'asset.originalFileName',
        'asset.type',
        isoTimestamp('asset.fileCreatedAt').as('fileCreatedAt'),
        isoTimestamp('asset.localDateTime').as('localDateTime'),
      ])
      .$narrowType<{ lat: NotNull; lon: NotNull }>();
  }

  async reverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult> {
    this.logger.debug(`Request: ${point.latitude},${point.longitude}`);

    const response = await this.db
      .selectFrom('geodata_places')
      .selectAll()
      .where(
        sql`earth_box(ll_to_earth_public(${point.latitude}, ${point.longitude}), ${reverseGeocodeMaxDistance})`,
        '@>',
        sql`ll_to_earth_public(latitude, longitude)`,
      )
      .orderBy(
        sql`(earth_distance(ll_to_earth_public(${point.latitude}, ${point.longitude}), ll_to_earth_public(latitude, longitude)))`,
      )
      .limit(1)
      .executeTakeFirst();

    if (response) {
      this.logger.verboseFn(() => `Raw: ${JSON.stringify(response, null, 2)}`);

      const { countryCode, name: city, admin1Name } = response;
      // eslint-disable-next-line import-x/no-named-as-default-member
      const country = isoCountries.getName(countryCode, 'en') ?? null;
      const state = admin1Name;

      return { country, state, city };
    }

    this.logger.log(
      `Empty response from database for city reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}. Likely cause: no nearby large populated place (500+ within ${reverseGeocodeMaxDistance / 1000}km). Falling back to country boundaries.`,
    );

    const ne_response = await this.db
      .selectFrom('naturalearth_countries')
      .selectAll()
      .where('coordinates', '@>', sql<string>`point(${point.longitude}, ${point.latitude})`)
      .limit(1)
      .executeTakeFirst();

    if (!ne_response) {
      this.logger.log(
        `Empty response from database for natural earth country reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}`,
      );

      return { country: null, state: null, city: null };
    }

    this.logger.verboseFn(() => `Raw: ${JSON.stringify(ne_response, ['id', 'admin', 'admin_a3', 'type'], 2)}`);

    const { admin_a3 } = ne_response;
    // eslint-disable-next-line import-x/no-named-as-default-member
    const country = isoCountries.getName(admin_a3, 'en') ?? null;
    const state = null;
    const city = null;

    return { country, state, city };
  }

  private async importNaturalEarthCountries() {
    const { resourcePaths } = this.configRepository.getEnv();
    const geoJSONData = JSON.parse(await readFile(resourcePaths.geodata.naturalEarthCountriesPath, 'utf8'));
    if (geoJSONData.type !== 'FeatureCollection' || !Array.isArray(geoJSONData.features)) {
      this.logger.fatal('Invalid GeoJSON FeatureCollection');
      return;
    }

    const entities: Insertable<NaturalEarthCountriesTable>[] = [];
    for (const feature of geoJSONData.features) {
      for (const entry of feature.geometry.coordinates) {
        const coordinates: number[][][] = feature.geometry.type === 'MultiPolygon' ? entry[0] : entry;
        const featureRecord: Insertable<NaturalEarthCountriesTable> = {
          admin: feature.properties.ADMIN,
          admin_a3: feature.properties.ADM0_A3,
          type: feature.properties.TYPE,
          coordinates: `(${coordinates.map((point) => `(${point[0]},${point[1]})`).join(', ')})`,
        };
        entities.push(featureRecord);
        if (feature.geometry.type === 'Polygon') {
          break;
        }
      }
    }

    await this.db.transaction().execute(async (manager) => {
      await sql`CREATE TABLE naturalearth_countries_tmp
                (
                  LIKE naturalearth_countries INCLUDING ALL EXCLUDING INDEXES
                )`.execute(manager);
      await manager.schema.dropTable('naturalearth_countries').execute();
      await manager.schema.alterTable('naturalearth_countries_tmp').renameTo('naturalearth_countries').execute();
    });

    await this.db.insertInto('naturalearth_countries').values(entities).execute();
    await sql`ALTER TABLE naturalearth_countries ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(this.db);
  }

  private async importGeodata() {
    const { resourcePaths } = this.configRepository.getEnv();
    const [admin1, admin2] = await Promise.all([
      this.loadAdmin(resourcePaths.geodata.admin1),
      this.loadAdmin(resourcePaths.geodata.admin2),
    ]);

    await this.db.schema.dropTable('geodata_places_tmp').ifExists().execute();
    await this.db.transaction().execute(async (manager) => {
      await sql`CREATE TABLE geodata_places_tmp
                (
                  LIKE geodata_places INCLUDING ALL EXCLUDING INDEXES
                )`.execute(manager);
      await manager.schema.dropTable('geodata_places').execute();
      await manager.schema.alterTable('geodata_places_tmp').renameTo('geodata_places').execute();
    });
    await this.db.schema
      .createIndex('IDX_geodata_gist_earthcoord')
      .on('geodata_places')
      .using('gist')
      .expression(sql`ll_to_earth_public(latitude, longitude)`)
      .execute();
    await this.loadCities500(admin1, admin2);
    await this.createGeodataIndices();
  }

  private async loadCities500(admin1Map: Map<string, string>, admin2Map: Map<string, string>) {
    const { resourcePaths } = this.configRepository.getEnv();
    const cities500 = resourcePaths.geodata.cities500;
    if (!existsSync(cities500)) {
      throw new Error(`Geodata file ${cities500} not found`);
    }

    this.logger.log(`Starting geodata import`);
    const startTime = performance.now();

    const input = createReadStream(cities500, { highWaterMark: 512 * 1024 * 1024 });
    let bufferGeodata = [];
    const lineReader = readLine.createInterface({ input });
    let count = 0;

    let futures = [];
    for await (const line of lineReader) {
      const lineSplit = line.split('\t');
      if ((lineSplit[7] === 'PPLX' && lineSplit[8] !== 'AU') || lineSplit[7] === 'PPLH') {
        continue;
      }

      const geoData = {
        id: Number.parseInt(lineSplit[0]),
        name: lineSplit[1],
        alternateNames: lineSplit[3],
        latitude: Number(lineSplit[4]),
        longitude: Number(lineSplit[5]),
        countryCode: lineSplit[8],
        admin1Code: lineSplit[10],
        admin2Code: lineSplit[11],
        modificationDate: lineSplit[18],
        admin1Name: admin1Map.get(`${lineSplit[8]}.${lineSplit[10]}`) ?? null,
        admin2Name: admin2Map.get(`${lineSplit[8]}.${lineSplit[10]}.${lineSplit[11]}`) ?? null,
      };
      bufferGeodata.push(geoData);
      if (bufferGeodata.length >= 5000) {
        const curLength = bufferGeodata.length;
        futures.push(
          this.db
            .insertInto('geodata_places')
            .values(bufferGeodata)
            .execute()

            .then(() => {
              count += curLength;
              if (count % 10_000 === 0) {
                this.logger.log(`${count} geodata records imported`);
              }
            }),
        );
        bufferGeodata = [];
        // leave spare connection for other queries
        if (futures.length >= 9) {
          await Promise.all(futures);
          futures = [];
        }
      }
    }

    if (bufferGeodata.length > 0) {
      await this.db.insertInto('geodata_places').values(bufferGeodata).execute();
      count += bufferGeodata.length;
    }

    await Promise.all(futures);

    const duration = performance.now() - startTime;
    const seconds = duration / 1000;
    const recordsPerSecond = Math.round(count / seconds);

    this.logger.log(
      `Successfully imported ${count} geodata records in ${seconds.toFixed(2)}s (${recordsPerSecond} records/second)`,
    );
  }

  private async loadAdmin(filePath: string) {
    if (!existsSync(filePath)) {
      this.logger.error(`Geodata file ${filePath} not found`);
      throw new Error(`Geodata file ${filePath} not found`);
    }

    const input = createReadStream(filePath, { highWaterMark: 512 * 1024 * 1024 });
    const lineReader = readLine.createInterface({ input });

    const adminMap = new Map<string, string>();
    for await (const line of lineReader) {
      const lineSplit = line.split('\t');
      adminMap.set(lineSplit[0], lineSplit[1]);
    }

    return adminMap;
  }

  private createGeodataIndices() {
    return Promise.all([
      sql`ALTER TABLE geodata_places ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(this.db),
      this.db.schema
        .createIndex(`idx_geodata_places_alternate_names`)
        .on('geodata_places')
        .using('gin (f_unaccent("alternateNames") gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_name`)
        .on('geodata_places')
        .using('gin (f_unaccent(name) gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_admin1_name`)
        .on('geodata_places')
        .using('gin (f_unaccent("admin1Name") gin_trgm_ops)')
        .execute(),
      this.db.schema
        .createIndex(`idx_geodata_places_admin2_name`)
        .on('geodata_places')
        .using('gin (f_unaccent("admin2Name") gin_trgm_ops)')
        .execute(),
    ]);
  }
}
