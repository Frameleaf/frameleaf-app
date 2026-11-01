import isoCountries from 'i18n-iso-countries';
import { createHash } from 'node:crypto';
import * as semver from 'semver';
import type { EmbeddingTransferEvidence } from 'src/immich-import/embeddings.js';
import type { SourceStructure } from 'src/immich-import/schema.js';
import frozen from 'src/immich-import/fixtures/frozen-sources.json' with { type: 'json' };
import structure2x from 'src/immich-import/fixtures/structure/2.x.json' with { type: 'json' };
import structure30 from 'src/immich-import/fixtures/structure/3.0.0.json' with { type: 'json' };
import structure31 from 'src/immich-import/fixtures/structure/3.1.0.json' with { type: 'json' };
import structure32 from 'src/immich-import/fixtures/structure/3.2.0.json' with { type: 'json' };
import { sourceViews } from 'src/immich-import/legacy.js';
import { FrozenSource, ImportRefused, ImportRow, TableShape } from 'src/immich-import/types.js';

const fixtures = frozen as {
  versions: Record<string, { commit: string; schema: string; migrations: string; structure: string }>;
  schemas: Record<string, Record<string, TableShape>>;
  migrations: Record<string, string[]>;
};

// Explicit content allowlist. Credentials, sessions, migrations, queues, server config and extension DDL never enter it.
export const CONTENT_TABLES = [
  'cluster_group',
  'user',
  'library',
  'person_group',
  'asset',
  'stack',
  'person',
  'asset_face',
  'album',
  'album_user',
  'album_asset',
  'smart_album',
  'smart_album_asset',
  'smart_album_exclusion',
  'partner',
  'shared_link',
  'shared_link_asset',
  'tag',
  'tag_closure',
  'tag_asset',
  'memory',
  'memory_asset',
  'activity',
  'user_metadata',
  'asset_exif',
  'asset_metadata',
  'asset_edit',
  'asset_file',
  'asset_audio',
  'asset_video',
  'asset_keyframe',
  'asset_ocr',
  'ocr_search',
  'smart_search',
  'face_search',
] as const;
export const DEFERRED_COLUMNS: Record<string, string[]> = {
  asset: ['livePhotoVideoId', 'stackId'],
  person: ['faceAssetId'],
  tag: ['parentId'],
  album: ['parentId'],
};
export const PATH_COLUMNS: Record<string, string[]> = {
  user: ['profileImagePath'],
  asset: ['originalPath'],
  person: ['thumbnailPath'],
  asset_file: ['path'],
};
const RELEASES = Object.keys(fixtures.versions).sort(semver.compare);
const releaseMigrations = (release: string): string[] => fixtures.migrations[fixtures.versions[release].migrations];

const PINNED_STRUCTURES: Record<string, SourceStructure> = {
  '3.0.0': structure30,
  '3.1.0': structure31,
  '3.2.0': structure32,
};
const REPLAYED_STRUCTURES = structure2x.releases as Record<string, SourceStructure>;

/**
 * Any Immich 2.0.0 or later. Releases newer than the frozen set read through the newest frozen
 * shape; source preflight then requires its ledger and every read column to still be present.
 */
export const frozenSource = (version: string): FrozenSource => {
  const release =
    semver.valid(version) && semver.gte(version, '2.0.0') ? semver.maxSatisfying(RELEASES, `<=${version}`) : null;
  if (!release) {
    throw new ImportRefused('UNSUPPORTED_SOURCE_VERSION');
  }
  const selected = fixtures.versions[release];
  const exact = Object.hasOwn(PINNED_STRUCTURES, selected.structure);
  const structure = exact ? PINNED_STRUCTURES[selected.structure] : REPLAYED_STRUCTURES[selected.structure];
  // 2.x releases share the 3.0.0 shape; content tables they predate are skipped.
  const tables = Object.fromEntries(
    Object.entries(fixtures.schemas[selected.schema]).filter(
      ([table]) => exact || !(CONTENT_TABLES as readonly string[]).includes(table) || structure.tables[table],
    ),
  );
  const migrations = releaseMigrations(release);
  return { commit: selected.commit, structure, tables, migrations, views: sourceViews(migrations, tables), exact };
};
/**
 * Content the pre-Frameleaf fork added on top of upstream Immich: nested albums (1779700000000-AddAlbumParentAndClosure,
 * 1779800000000-AddAlbumIcon, 1779900000000-AddAlbumSortOrder) and smart albums (1779600000000-CreateSmartAlbumTables).
 * Read only when the source has every column with this type; upstream sources never do.
 */
const FORK_COLUMNS: Record<string, Record<string, string>> = {
  album: { parentId: 'uuid', icon: 'character varying', sortOrder: 'double precision' },
};
const FORK_TABLES: Record<string, TableShape> = {
  smart_album: {
    columns: ['id', 'kind', 'ownerId', 'albumId', 'createdAt'],
    key: ['id'],
    types: { id: 'uuid', kind: 'text', ownerId: 'uuid', albumId: 'uuid', createdAt: 'timestamp with time zone' },
  },
  smart_album_asset: {
    columns: ['smartAlbumId', 'assetId', 'addedAt', 'matchReason'],
    key: ['smartAlbumId', 'assetId'],
    types: { smartAlbumId: 'uuid', assetId: 'uuid', addedAt: 'timestamp with time zone', matchReason: 'text' },
  },
  smart_album_exclusion: {
    columns: ['smartAlbumId', 'assetId'],
    key: ['smartAlbumId', 'assetId'],
    types: { smartAlbumId: 'uuid', assetId: 'uuid' },
  },
};
export const withForkContent = (source: FrozenSource, structure: SourceStructure): FrozenSource => {
  const present = (table: string, types: Record<string, string>) =>
    Object.entries(types).every(([column, type]) => structure.tables[table]?.[column]?.type === type);
  const tables = { ...source.tables };
  for (const [table, types] of Object.entries(FORK_COLUMNS)) {
    const shape = tables[table];
    if (shape && present(table, types)) {
      tables[table] = {
        ...shape,
        columns: [...shape.columns, ...Object.keys(types)],
        types: { ...shape.types, ...types },
      };
    }
  }
  for (const [table, shape] of Object.entries(FORK_TABLES)) {
    if (present(table, shape.types)) {
      tables[table] = shape;
    }
  }
  return { ...source, tables, views: sourceViews(source.migrations, tables) };
};
/** The newest frozen release whose complete migration ledger the source contains. */
export const newestContainedRelease = (ledger: readonly string[]): string | undefined => {
  const names = new Set(ledger);
  return RELEASES.findLast((release) => releaseMigrations(release).every((name) => names.has(name)));
};
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const clusterId = (ownerId: string): string => {
  const hex = createHash('sha256').update(`frameleaf:immich-import:cluster:${ownerId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
// Immich 3.3 (1790587508209-RenameGeoNamesCountries) stores GeoNames country names. Frameleaf's reverse
// geocoder names countries with i18n-iso-countries, so imported names are mapped back to keep Places grouped.
const GEONAMES_COUNTRIES: Record<string, string> = {
  'Aland Islands': 'AX',
  'Bonaire, Saint Eustatius and Saba': 'BQ',
  Brunei: 'BN',
  'Cabo Verde': 'CV',
  'Cocos Islands': 'CC',
  'Ivory Coast': 'CI',
  Curacao: 'CW',
  Czechia: 'CZ',
  'Falkland Islands': 'FK',
  Vatican: 'VA',
  Iran: 'IR',
  Laos: 'LA',
  Micronesia: 'FM',
  Moldova: 'MD',
  'The Netherlands': 'NL',
  China: 'CN',
  Gambia: 'GM',
  Russia: 'RU',
  'Saint Barthelemy': 'BL',
  'Saint Martin': 'MF',
  'Sint Maarten': 'SX',
  'Palestinian Territory': 'PS',
  Syria: 'SY',
  Taiwan: 'TW',
  'North Macedonia': 'MK',
  'Timor Leste': 'TL',
  Turkey: 'TR',
  Tanzania: 'TZ',
  'United States': 'US',
  'British Virgin Islands': 'VG',
  'U.S. Virgin Islands': 'VI',
};
export const transformRow = (table: string, source: ImportRow, legacyPeople: boolean): ImportRow => {
  const row = { ...source };
  // Destination synchronization identities are generated locally.
  delete row.updateId;
  delete row.createId;
  if (table === 'asset_exif' && typeof row.country === 'string' && Object.hasOwn(GEONAMES_COUNTRIES, row.country)) {
    // eslint-disable-next-line import-x/no-named-as-default-member
    row.country = isoCountries.getName(GEONAMES_COUNTRIES[row.country], 'en') ?? row.country;
  }
  if (legacyPeople && table === 'user') {
    row.clusterGroupId = clusterId(String(row.id));
  }
  if (legacyPeople && table === 'person') {
    row.personGroupId = row.id;
    delete row.id;
  }
  if (legacyPeople && table === 'asset_face') {
    row.personGroupId = row.personId;
    delete row.personId;
  }
  return row;
};
export const vectorCompatible = (value: unknown, evidence?: EmbeddingTransferEvidence): boolean => {
  if (!evidence || typeof value !== 'string') return false;
  const { sourceDimensions, destinationDimensions, producingModel, sourceConfiguredModel, destinationConfiguredModel } =
    evidence;
  if (
    !producingModel ||
    producingModel !== sourceConfiguredModel ||
    producingModel !== destinationConfiguredModel ||
    !sourceDimensions ||
    sourceDimensions !== destinationDimensions
  )
    return false;
  try {
    const vector: unknown = JSON.parse(value);
    return (
      Array.isArray(vector) &&
      vector.length === destinationDimensions &&
      vector.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  } catch {
    return false;
  }
};
