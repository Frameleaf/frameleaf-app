import { Injectable } from '@nestjs/common';
import isoCountries from 'i18n-iso-countries';
import { type Expression, type Insertable, type Kysely, type NotNull, type SqlBool, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import readLine from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, gunzipSync } from 'node:zlib';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import type { LockedVisibilityOptions } from 'src/utils/locked-visibility.js';
import { LANDMARK_MAX_RADIUS_M, citiesFile, reverseGeocodeMaxDistance } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetVisibility, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { GeodataPlacesTable } from 'src/schema/tables/geodata-places.table.js';
import { LandmarkAreaTable, LandmarkTable } from 'src/schema/tables/landmark.table.js';
import { NaturalEarthCountriesTable } from 'src/schema/tables/natural-earth-countries.table.js';
import { withAlbumVisibility, withHiddenContentFilter } from 'src/utils/database.js';
import { isTimelineVisible, visibilityIs } from 'src/utils/locked.js';

export interface MapMarkerSearchOptions extends HiddenContentQueryOptions {
  isArchived?: boolean;
  isFavorite?: boolean;
  fileCreatedBefore?: Date;
  fileCreatedAfter?: Date;
}

/** How a landmark's brand icon is drawn: the colour of the circle around it, and whether it fills its frame. */
type LandmarkIcon = { background: string; tile: boolean };
const LANDMARK_ID = /^Q\d{1,18}$/;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
/** The icon pack is one file of some tens of megabytes; a slow link gets half an hour for it. */
const LANDMARK_ICON_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

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

const GEODATA_INDEXES = [
  ['IDX_geodata_gist_earthcoord', 'gist', sql`ll_to_earth_public(latitude, longitude)`],
  ['idx_geodata_places_alternate_names', 'gin', sql`f_unaccent("alternateNames") gin_trgm_ops`],
  ['idx_geodata_places_name', 'gin', sql`f_unaccent(name) gin_trgm_ops`],
  ['idx_geodata_places_admin1_name', 'gin', sql`f_unaccent("admin1Name") gin_trgm_ops`],
  ['idx_geodata_places_admin2_name', 'gin', sql`f_unaccent("admin2Name") gin_trgm_ops`],
] as const;

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

  private landmarkIcons?: { file: string; mtimeMs: number; icons: Map<string, LandmarkIcon> };

  /**
   * Where a server keeps the icon pack it downloaded (FL-355): beside the thumbnails, which are also made
   * rather than kept, and hidden like their other caches so the untracked-file scan never reports it.
   */
  private installedLandmarkIcons(): string | undefined {
    try {
      return join(StorageCore.getBaseFolder(StorageFolder.Thumbnails), '.landmark-icons', 'current');
    } catch {
      // no media location yet
      return undefined;
    }
  }

  /** The folder brand icons are read from: the downloaded pack, else one shipped beside the geodata. */
  private landmarkIconFolder(): string {
    const installed = this.installedLandmarkIcons();
    return installed && existsSync(join(installed, 'icons.json'))
      ? realpathSync(installed)
      : this.configRepository.getEnv().resourcePaths.geodata.landmarkIcons;
  }

  /**
   * The brand icons this server has for landmarks, by landmark id: how to draw each (FL-355). The pack is
   * optional, so without it every landmark simply shows the icon for its kind. The index is read again
   * when its file changes, which is how the API worker sees a pack the microservices worker installed.
   */
  getLandmarkIcons(): Map<string, LandmarkIcon> {
    const file = join(this.landmarkIconFolder(), 'icons.json');
    try {
      const { mtimeMs } = statSync(file);
      if (this.landmarkIcons?.file !== file || this.landmarkIcons.mtimeMs !== mtimeMs) {
        const icons = new Map<string, LandmarkIcon>(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
        this.landmarkIcons = { file, mtimeMs, icons };
      }
      return this.landmarkIcons.icons;
    } catch {
      return new Map();
    }
  }

  /** Where a landmark's brand icon is on disk, if it has one. `id` must already be a checked landmark id. */
  getLandmarkIconPath(id: string): string | undefined {
    const icons = this.getLandmarkIcons();
    const file = this.landmarkIcons?.file;
    return icons.has(id) && file ? join(dirname(file), `${id}.png`) : undefined;
  }

  /**
   * Downloads the brand icon pack and unpacks it beside the thumbnails, unless that very pack is already
   * there. The file is taken whole and checked against its SHA-256 before anything in it is used: one
   * icon a line, `{"id","background","tile","png"}` with the PNG in base64 (see icons/pack.mjs). Resolves
   * to whether a pack was installed.
   */
  async installLandmarkIcons(pack: { url: string; sha256: string }): Promise<boolean> {
    const folder = this.installedLandmarkIcons();
    if (!folder || (await readFile(join(folder, 'pack.sha256'), 'utf8').catch(() => '')) === pack.sha256) {
      return false;
    }

    if (!/^[a-f0-9]{64}$/.test(pack.sha256)) {
      throw new Error('The icon pack checksum is malformed');
    }
    const root = dirname(folder);
    await mkdir(root, { recursive: true });
    const staging = await mkdtemp(join(root, '.tmp-'));
    const version = join(root, pack.sha256);
    const pointer = `${staging}.link`;
    try {
      const download = join(staging, 'pack.ndjson.gz');
      const response = await fetch(pack.url, { signal: AbortSignal.timeout(LANDMARK_ICON_DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok || !response.body) {
        throw new Error(`${pack.url} answered ${response.status}`);
      }
      const hash = createHash('sha256');
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            hash.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(download),
      );
      if (hash.digest('hex') !== pack.sha256) {
        throw new Error(`${pack.url} does not match its checksum`);
      }

      const index: Record<string, LandmarkIcon> = {};
      const unpack = async (line: string) => {
        if (!line) {
          return;
        }
        const { id, background, tile, png } = JSON.parse(line);
        // The id becomes a file name, so it is checked even though the whole file already was.
        if (!LANDMARK_ID.test(id) || !HEX_COLOUR.test(background) || typeof tile !== 'boolean') {
          throw new Error('The icon pack has a malformed line');
        }
        await writeFile(join(staging, `${id}.png`), Buffer.from(png, 'base64'));
        index[id] = { background, tile };
      };
      await pipeline(createReadStream(download), createGunzip(), async (source: AsyncIterable<Buffer>) => {
        let rest = '';
        for await (const chunk of source) {
          // the pack is ASCII throughout, so a chunk never ends inside a character
          const lines = (rest + chunk.toString('ascii')).split('\n');
          rest = lines.pop() ?? '';
          for (const line of lines) {
            await unpack(line);
          }
        }
        await unpack(rest);
      });

      await rm(download);
      await writeFile(join(staging, 'icons.json'), JSON.stringify(index));
      await writeFile(join(staging, 'pack.sha256'), pack.sha256);
      try {
        await rename(staging, version);
      } catch (error) {
        // Another worker may have published this exact pack while we downloaded it.
        if (
          !['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '') ||
          (await readFile(join(version, 'pack.sha256'), 'utf8').catch(() => '')) !== pack.sha256
        ) {
          throw error;
        }
      }
      // shortcut: retain old versions for active readers; add cache pruning when pack updates need it.
      await symlink(basename(version), pointer);
      await rename(pointer, folder);
      return true;
    } finally {
      await rm(pointer, { force: true });
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Imports the bundled geodata when it is newer than the last import. Resolves to whether an import ran. */
  async init(): Promise<boolean> {
    this.logger.log('Initializing metadata repository');
    const { resourcePaths } = this.configRepository.getEnv();
    const geodataDate = await readFile(resourcePaths.geodata.dateFile, 'utf8');

    // TODO move to service init
    const geocodingMetadata = await this.metadataRepository.get(SystemMetadataKey.ReverseGeocodingState);
    if (geocodingMetadata?.lastUpdate === geodataDate) {
      // A database backup leaves the place pack out (it ships with the server), so a restored database has
      // the geodata of this date and no places: put them back.
      const place = await this.db.selectFrom('landmark').select('id').limit(1).executeTakeFirst();
      return place ? false : this.importLandmarks();
    }

    await Promise.all([this.importGeodata(), this.importNaturalEarthCountries(), this.importLandmarks()]);

    await this.metadataRepository.set(SystemMetadataKey.ReverseGeocodingState, {
      lastUpdate: geodataDate,
      lastImportFileName: citiesFile,
    });

    this.logger.log('Geodata import completed');
    return true;
  }

  /**
   * Replaces the place pack (FL-352). Reverse geocoding does not depend on it, so a missing or unreadable
   * pack is logged and skipped rather than stopping the worker. Resolves to whether any place was imported.
   */
  private async importLandmarks(): Promise<boolean> {
    const { resourcePaths } = this.configRepository.getEnv();
    const startedAt = performance.now();
    this.logger.log('Restoring bundled landmark places');
    try {
      const landmarks: Insertable<LandmarkTable>[] = [];
      const areas: Insertable<LandmarkAreaTable>[] = [];
      for (const line of gunzipSync(await readFile(resourcePaths.geodata.landmarks))
        .toString('utf8')
        .split('\n')) {
        if (!line) {
          continue;
        }
        const { id, name, names, kind, lat, lon, radiusM, rank, areas: rings = [] } = JSON.parse(line);
        landmarks.push({ id, name, names, kind, latitude: lat, longitude: lon, radiusM, rank });
        for (const ring of rings as number[][][]) {
          areas.push({ landmarkId: id, area: `(${ring.map(([x, y]) => `(${x},${y})`).join(',')})` });
        }
      }

      await this.db.transaction().execute(async (manager) => {
        await manager.deleteFrom('landmark_area').execute();
        await manager.deleteFrom('landmark').execute();
        for (let index = 0; index < landmarks.length; index += 1000) {
          await manager
            .insertInto('landmark')
            .values(landmarks.slice(index, index + 1000))
            .execute();
        }
        for (let index = 0; index < areas.length; index += 500) {
          await manager
            .insertInto('landmark_area')
            .values(areas.slice(index, index + 500))
            .execute();
        }
      });
      this.logger.log(
        `Imported ${landmarks.length} landmarks in ${((performance.now() - startedAt) / 1000).toFixed(2)}s`,
      );
      return landmarks.length > 0;
    } catch (error) {
      this.logger.warn(`Landmarks were not imported: ${error}`);
      return false;
    }
  }

  /**
   * Re-matches every located asset against the current place pack, a slice of places at a time. New and
   * edited assets are matched by the asset_exif trigger; this is for after a pack import.
   */
  async matchAllLandmarks(): Promise<void> {
    await sql`delete from asset_landmark where "landmarkId" not in (select id from landmark)`.execute(this.db);
    const ids = await this.db.selectFrom('landmark').select('id').orderBy('id').execute();
    for (let index = 0; index < ids.length; index += 500) {
      const slice = ids.slice(index, index + 500).map(({ id }) => id);
      await this.db.transaction().execute(async (manager) => {
        await manager.deleteFrom('asset_landmark').where('landmarkId', 'in', slice).execute();
        await sql`
          insert into asset_landmark ("assetId", "landmarkId")
          select e."assetId", l.id
          from landmark l
          inner join asset_exif e
            on earth_box(ll_to_earth_public(l.latitude, l.longitude), l."radiusM")
              @> ll_to_earth_public(e.latitude, e.longitude)
            and earth_distance(
              ll_to_earth_public(l.latitude, l.longitude),
              ll_to_earth_public(e.latitude, e.longitude)) <= l."radiusM"
          where l.id in (${sql.join(slice)})
            and l."radiusM" <= ${LANDMARK_MAX_RADIUS_M}
            and (not exists (select from landmark_area a where a."landmarkId" = l.id)
              or exists (select from landmark_area a
                where a."landmarkId" = l.id and a.area @> point(e.longitude, e.latitude)))
          on conflict do nothing
        `.execute(manager);
      });
    }
  }

  /** Markers for an album: the same media the album itself shows this viewer (see `withAlbumVisibility`). */
  @GenerateSql({ params: [DummyValue.UUID] })
  getAlbumMapMarkers(
    albumId: string,
    options: HiddenContentQueryOptions & LockedVisibilityOptions & AlbumMapMarkerSearchOptions = {},
  ) {
    const { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore, favoriteOwnerId, onlyOwnerId } = options;
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
        .execute()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID], [DummyValue.UUID]] })
  getMapMarkers(authUserId: string, ownerIds: string[], albumIds: string[], options: MapMarkerSearchOptions = {}) {
    const { isArchived, isFavorite, fileCreatedAfter, fileCreatedBefore } = options;
    // FL-195: the viewer's own marks and detections, when their session is unlocked
    const reveal = options.revealLockedOwnerId;
    return this.mapMarkersQuery()
      .$call((qb) => withHiddenContentFilter(qb, options))
      .$if(isArchived === true, (qb) =>
        qb.where((eb) =>
          eb.or([
            isTimelineVisible('asset', reveal),
            eb.and([eb('asset.ownerId', '=', authUserId), visibilityIs(AssetVisibility.Archive, 'asset', reveal)]),
          ]),
        ),
      )
      .$if(isArchived === false || isArchived === undefined, (qb) => qb.where(isTimelineVisible('asset', reveal)))
      .$if(isFavorite !== undefined, (q) => q.where('isFavorite', '=', isFavorite!))
      .$if(fileCreatedAfter !== undefined, (q) => q.where('fileCreatedAt', '>=', fileCreatedAfter!))
      .$if(fileCreatedBefore !== undefined, (q) => q.where('fileCreatedAt', '<=', fileCreatedBefore!))
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
                .whereRef('asset.id', '=', 'album_asset.assetId')
                .where('album_asset.albumId', 'in', albumIds),
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
    // FL-195: the viewer's own marks and detections count when their session is unlocked; a partner's never
    const reveal = options.revealLockedOwnerId;
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
        .where(visibilityIs(AssetVisibility.Archive, 'asset', reveal))
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
        .where(isTimelineVisible('asset', reveal))
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
      .select(['countryCode', 'name', 'admin1Name'])
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

    const boundary = await this.db
      .selectFrom('naturalearth_countries')
      .select(['id', 'admin', 'admin_a3', 'type'])
      .where('coordinates', '@>', sql<string>`point(${point.longitude}, ${point.latitude})`)
      .limit(1)
      .executeTakeFirst();

    if (!boundary) {
      this.logger.log(
        `Empty response from database for natural earth country reverse geocoding lat: ${point.latitude}, lon: ${point.longitude}`,
      );

      return { country: null, state: null, city: null };
    }

    this.logger.verboseFn(() => `Raw: ${JSON.stringify(boundary, ['id', 'admin', 'admin_a3', 'type'], 2)}`);

    const { admin_a3 } = boundary;
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
      await manager.insertInto('naturalearth_countries_tmp').values(entities).execute();
      await manager.schema.dropTable('naturalearth_countries').execute();
      await manager.schema.alterTable('naturalearth_countries_tmp').renameTo('naturalearth_countries').execute();
      await sql`ALTER TABLE naturalearth_countries ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(manager);
    });
  }

  private async importGeodata() {
    const { resourcePaths } = this.configRepository.getEnv();
    const [admin1, admin2] = await Promise.all([
      this.loadAdmin(resourcePaths.geodata.admin1),
      this.loadAdmin(resourcePaths.geodata.admin2),
    ]);

    await this.db.schema.dropTable('geodata_places_tmp').ifExists().execute();
    try {
      await sql`CREATE TABLE geodata_places_tmp
                (
                  LIKE geodata_places INCLUDING ALL EXCLUDING INDEXES
                )`.execute(this.db);
      await this.loadCities500(admin1, admin2);
      await this.createGeodataIndices();
      await this.db.transaction().execute(async (manager) => {
        await manager.schema.dropTable('geodata_places').execute();
        await manager.schema.alterTable('geodata_places_tmp').renameTo('geodata_places').execute();
        await sql`ALTER TABLE geodata_places RENAME CONSTRAINT geodata_places_tmp_pkey TO geodata_places_pkey`.execute(
          manager,
        );
        for (const [name] of GEODATA_INDEXES) {
          await sql`ALTER INDEX ${sql.id(`${name}_tmp`)} RENAME TO ${sql.id(name)}`.execute(manager);
        }
      });
    } catch (error) {
      await this.db.schema
        .dropTable('geodata_places_tmp')
        .ifExists()
        .execute()
        .catch((cleanupError) => {
          this.logger.warn('Unable to remove failed geodata staging table', cleanupError);
        });
      throw error;
    }
  }

  private async loadCities500(admin1Map: Map<string, string>, admin2Map: Map<string, string>) {
    const { resourcePaths } = this.configRepository.getEnv();
    const cities500 = resourcePaths.geodata.cities500;
    if (!existsSync(cities500)) {
      throw new Error(`Geodata file ${cities500} not found`);
    }

    this.logger.log(`Starting geodata import`);
    const startTime = performance.now();

    const input = createReadStream(cities500, { highWaterMark: 64 * 1024 });
    const lineReader = readLine.createInterface({ input, crlfDelay: Infinity });
    let rows: Insertable<GeodataPlacesTable>[] = [];
    let pending: Promise<void>[] = [];
    const failures: unknown[] = [];
    let count = 0;

    const insertBatch = (batch: Insertable<GeodataPlacesTable>[]) =>
      this.db
        .insertInto('geodata_places_tmp')
        .values(batch)
        .execute()
        .then(() => {
          count += batch.length;
          if (count % 10_000 === 0) {
            this.logger.log(`${count} geodata records imported`);
          }
        })
        .catch((error: unknown) => {
          failures.push(error);
          lineReader.close();
          input.destroy();
        });

    try {
      for await (const line of lineReader) {
        if (failures.length > 0) {
          throw failures[0];
        }
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
        rows.push(geoData);
        if (rows.length === 5000) {
          pending.push(insertBatch(rows));
          rows = [];
          // Leave one database connection available for other queries.
          if (pending.length === 9) {
            await Promise.all(pending);
            pending = [];
          }
        }
      }
      await Promise.all(pending);
      if (failures.length > 0) {
        throw failures[0];
      }
      if (rows.length > 0) {
        await insertBatch(rows);
        if (failures.length > 0) {
          throw failures[0];
        }
      }
    } finally {
      lineReader.close();
      input.destroy();
      await Promise.all(pending);
    }

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

    const input = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const lineReader = readLine.createInterface({ input, crlfDelay: Infinity });

    const adminMap = new Map<string, string>();
    try {
      for await (const line of lineReader) {
        const [code, name] = line.split('\t', 2);
        adminMap.set(code, name);
      }
    } finally {
      lineReader.close();
      input.destroy();
    }

    return adminMap;
  }

  /**
   * The primary key comes first, on its own: adding it takes an ACCESS EXCLUSIVE lock, which conflicts
   * with the SHARE lock each index build holds. Started together, the key waited for the slower GIN
   * builds and the builds queued behind it waited for the key, until the connection's lock timeout
   * cancelled them and the microservices worker failed to start. The index builds share their lock, so
   * they still run together once the key is in place.
   */
  private async createGeodataIndices() {
    await sql`ALTER TABLE geodata_places_tmp ADD PRIMARY KEY (id) WITH (FILLFACTOR = 100)`.execute(this.db);
    const results = await Promise.allSettled(
      GEODATA_INDEXES.map(([name, method, expression]) =>
        this.db.schema
          .createIndex(`${name}_tmp`)
          .on('geodata_places_tmp')
          .using(method)
          .expression(expression)
          .execute(),
      ),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }
}
