import { createHash } from 'node:crypto';
import type { EmbeddingTransferEvidence } from 'src/immich-import/embeddings.js';
import frozen from 'src/immich-import/fixtures/frozen-sources.json' with { type: 'json' };
import structure30 from 'src/immich-import/fixtures/structure/3.0.0.json' with { type: 'json' };
import structure31 from 'src/immich-import/fixtures/structure/3.1.0.json' with { type: 'json' };
import structure32 from 'src/immich-import/fixtures/structure/3.2.0.json' with { type: 'json' };
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
export const frozenSource = (version: string): FrozenSource => {
  const selected = Object.hasOwn(fixtures.versions, version) ? fixtures.versions[version] : undefined;
  if (!selected) {
    throw new ImportRefused('UNSUPPORTED_SOURCE_VERSION');
  }
  return {
    commit: selected.commit,
    structure: (
      { '3.0.0': structure30, '3.1.0': structure31, '3.2.0': structure32 } as Record<string, FrozenSource['structure']>
    )[selected.structure],
    tables: fixtures.schemas[selected.schema],
    migrations: fixtures.migrations[selected.migrations],
  };
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
export const transformRow = (table: string, source: ImportRow, legacyPeople: boolean): ImportRow => {
  const row = { ...source };
  // Destination synchronization identities are generated locally.
  delete row.updateId;
  delete row.createId;
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
