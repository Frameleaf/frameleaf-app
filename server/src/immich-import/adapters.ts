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
