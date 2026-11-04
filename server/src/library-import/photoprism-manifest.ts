import { posix } from 'node:path';
import { z } from 'zod';
import mariadb from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import sqlite from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { type ImportManifest, importTimestampSchema, parseImportManifest } from 'src/library-import/manifest.js';
import { type PhotoprismInventoryRecord, readPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { normalizeTagValue } from 'src/utils/tag.js';

const labelSchema = z.object({
  id: z.bigint().positive(),
  label_name: z.string(),
  label_priority: z.bigint(),
  deleted_at: z
    .string()
    .transform((value) => value.replace(' ', 'T'))
    .pipe(z.iso.datetime({ offset: true }))
    .nullable(),
});
const labelLinkSchema = z.object({
  photo_id: z.bigint().positive(),
  label_id: z.bigint().positive(),
  label_src: z.string(),
  uncertainty: z.bigint(),
});

type SealedManifest = Extract<ImportManifest, { version: 3 }>;
type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  photoOwners: Record<string, string>;
  albumOwners: Record<string, string>;
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
  materializedAlbums: Record<string, string[]>;
};
const refuse = (code: string): never => {
  throw new Error(`PhotoPrism source refused: ${code}`);
};

/** Maps captured records, not credentials or previews. Capture authority and independent byte verification remain required. */
export function assemblePhotoprismManifest(records: Iterable<PhotoprismInventoryRecord>, input: Input) {
  if (input.source.kind !== 'photoprism' || input.source.version !== sqlite.source.version)
    return refuse('PHOTOPRISM_VERSION_UNQUALIFIED');
  if (![sqlite.schemaSha256, mariadb.schemaSha256].includes(input.source.schemaSha256))
    return refuse('PHOTOPRISM_SCHEMA_UNQUALIFIED');
  const rows = [...records];
  const photos = rows.filter((row) => row.type === 'photo').map((row) => row.value);
  const files = rows
    .filter((row) => row.type === 'file')
    .map((row) => row.value)
    .filter((file) => file.role !== undefined);
  const albums = rows.filter((row) => row.type === 'album').map((row) => row.value);
  const memberships = rows.filter((row) => row.type === 'membership').map((row) => row.value);
  const principals = rows
    .filter((row) => row.type === 'principal')
    .map((row) => row.value)
    .filter((user) => !user.system);
  const archive: SourceArchiveRecord[] = rows
    .filter((row) => row.type === 'archive')
    .map(({ table, value }) => ({ table, value }));
  for (const record of archive) encodeSourceArchiveRecord(record);
  const rawFiles = new Map(
    archive.filter((row) => row.table === 'files').map((row) => [row.value.file_uid, row.value]),
  );
  const observed = new Map(input.files.map((file) => [file.id, file]));
  if (observed.size !== input.files.length || files.length !== observed.size)
    return refuse('PHOTOPRISM_FILE_EVIDENCE_MISMATCH');
  const users = new Set(principals.map((user) => user.id));
  const photoIds = new Set(photos.map((photo) => photo.id));
  const albumIds = new Set(albums.map((album) => album.id));
  const dynamicAlbums = new Set(albums.filter((album) => album.review.length > 0).map((album) => album.id));
  const photoFiles = Map.groupBy(files, (file) => file.photoId);
  const albumMemberships = Map.groupBy(memberships, (row) => row.albumId);
  const owner = (id: string, assignments: Record<string, string>) => {
    if (!Object.hasOwn(assignments, id) || !users.has(assignments[id]))
      return refuse('PHOTOPRISM_OWNER_MAPPING_REQUIRED');
    return assignments[id];
  };
  if (
    Object.keys(input.photoOwners).some((id) => !photoIds.has(id)) ||
    Object.keys(input.albumOwners).some((id) => !albumIds.has(id)) ||
    Object.keys(input.materializedAlbums).some((id) => !dynamicAlbums.has(id))
  )
    return refuse('PHOTOPRISM_MAPPING_CHANGED');
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  // Destination albums start owner-only; archived source grants never silently become new access.
  if (
    principals.length > 1 ||
    photos.some((photo) => !photo.state.private) ||
    albums.some((album) => !album.private) ||
    archive.some((row) => ['links', 'shares', 'photos_users', 'albums_users'].includes(row.table))
  )
    loss('PHOTOPRISM_SHARING_RESTRICTED');
  if (archive.length > 0) loss('PHOTOPRISM_SOURCE_METADATA_ARCHIVED');
  if (archive.some((row) => ['markers', 'subjects'].includes(row.table))) loss('PHOTOPRISM_PEOPLE_ARCHIVED');
  if (archive.some((row) => ['labels', 'photos_labels'].includes(row.table))) loss('PHOTOPRISM_LABELS_ARCHIVED');
  const labels = new Map<string, z.infer<typeof labelSchema>>();
  for (const row of archive) {
    if (row.table !== 'labels') continue;
    const parsed = labelSchema.safeParse(row.value);
    if (!parsed.success || labels.has(String(parsed.data.id))) return refuse('PHOTOPRISM_LABEL_INVALID');
    labels.set(String(parsed.data.id), parsed.data);
  }
  const photoSources = new Set(photos.map((photo) => photo.sourceId));
  const labelPairs = new Set<string>(),
    unsupportedLabels = new Set<string>();
  const manualTags = new Map<string, Set<string>>();
  for (const row of archive) {
    if (row.table !== 'photos_labels') continue;
    const parsed = labelLinkSchema.safeParse(row.value);
    if (!parsed.success) return refuse('PHOTOPRISM_LABEL_RELATIONSHIP_INVALID');
    const link = parsed.data,
      labelId = String(link.label_id),
      photoId = String(link.photo_id);
    const label = labels.get(labelId),
      pair = `${photoId}:${labelId}`;
    if (!label || !photoSources.has(photoId) || labelPairs.has(pair))
      return refuse('PHOTOPRISM_LABEL_RELATIONSHIP_INVALID');
    labelPairs.add(pair);
    if (!['manual', 'batch'].includes(link.label_src)) continue;
    if (link.uncertainty < 0n || link.uncertainty > 100n) return refuse('PHOTOPRISM_LABEL_REVIEW_REQUIRED');
    const deleted = label.deleted_at !== null && !/^0001-01-01T00:00:00(?:\.0+)?(?:Z|\+00:00)$/u.test(label.deleted_at);
    if (link.uncertainty === 100n || deleted || label.label_priority < 0n) continue;
    const tag = label.label_name;
    if (!tag.trim() || tag.includes('\0') || normalizeTagValue(tag) !== tag) {
      if (!unsupportedLabels.has(labelId)) loss('PHOTOPRISM_LABEL_TAG_UNREPRESENTABLE', labelId);
      unsupportedLabels.add(labelId);
      continue;
    }
    const tags = manualTags.get(photoId) ?? new Set<string>();
    tags.add(tag);
    manualTags.set(photoId, tags);
  }

  const manifestFiles: ImportManifest['files'] = files.map((file) => {
    const proof = observed.get(file.id);
    if (!proof || proof.path !== file.path || proof.bytes !== file.bytes || proof.role !== file.role)
      return refuse('PHOTOPRISM_FILE_EVIDENCE_MISMATCH');
    importTimestampSchema.parse(proof.modifiedAt);
    const { modifiedAt: _modifiedAt, ...value } = proof;
    return value;
  });
  const assets: SealedManifest['assets'] = photos.map((photo) => {
    const localClock = photo.metadata.timeZone === undefined ? photo.localDateTime : undefined;
    if (photo.review.some((code) => code !== 'LOCAL_TIME_ZONE_UNRESOLVED' || localClock === undefined))
      return refuse('PHOTOPRISM_METADATA_REVIEW_REQUIRED');
    const related = photoFiles.get(photo.id) ?? [];
    if (related.filter((file) => file.role === 'sidecar').length > 1)
      return refuse('PHOTOPRISM_SIDECAR_REVIEW_REQUIRED');
    const originals = related.filter((file) => file.role === 'original');
    const primary = originals.filter((file) => file.primary);
    // The source primary may be generated; a sole original is still unambiguous.
    if (primary.length === 0 && originals.length === 1) primary.push(originals[0]);
    if (primary.length !== 1) return refuse('PHOTOPRISM_PRIMARY_ORIGINAL_REQUIRED');
    const media = originals.map((file) => {
      const type = rawFiles.get(file.id)?.media_type;
      return type === 'video' ? 'VIDEO' : ['image', 'raw', 'animated'].includes(String(type)) ? 'IMAGE' : undefined;
    });
    if (media.includes(undefined) || new Set(media).size !== 1)
      return refuse('PHOTOPRISM_MEDIA_RELATIONSHIP_REVIEW_REQUIRED');
    const { title, ...metadata } = photo.metadata;
    const labels = manualTags.get(photo.sourceId);
    if (metadata.tags || labels?.size) metadata.tags = [...new Set([...(metadata.tags ?? []), ...(labels ?? [])])];
    if (title) loss('PHOTOPRISM_TITLE_ARCHIVED', photo.id);
    const type = media[0]!;
    const names = originals.map((file) => {
      const name = rawFiles.get(file.id)?.original_name;
      return [file.id, typeof name === 'string' && name ? name : posix.basename(file.path)];
    });
    return {
      id: photo.id,
      ownerId: owner(photo.id, input.photoOwners),
      fileIds: related.map((file) => file.id),
      primaryFileId: primary[0].id,
      type,
      ...(localClock === undefined ? {} : { localDateTime: localClock }),
      fileModifiedAt: observed.get(primary[0].id)!.modifiedAt,
      originalFileNames: Object.fromEntries(names),
      // Owner 2026-11-04: a private photo imports Locked, ahead of archived so it stays private.
      visibility: photo.state.removed
        ? 'trash'
        : photo.state.private
          ? 'locked'
          : photo.state.archived
            ? 'archive'
            : 'timeline',
      ...(!photo.state.removed && photo.state.private && photo.state.archived ? { archived: true as const } : {}),
      metadata: { ...metadata, ...(photo.state.removed ? { deletedAt: photo.stateChangedAt } : {}) },
    };
  });
  const mappedAlbums: ImportManifest['albums'] = [];
  for (const album of albums) {
    const ownerId = owner(album.id, input.albumOwners);
    if (album.deletedAt) {
      loss('PHOTOPRISM_DELETED_ALBUM_ARCHIVED', album.id);
      continue;
    }
    let assetIds: string[];
    if (album.review.length > 0) {
      if (!Object.hasOwn(input.materializedAlbums, album.id)) return refuse('PHOTOPRISM_ALBUM_SNAPSHOT_REQUIRED');
      assetIds = input.materializedAlbums[album.id];
      loss('PHOTOPRISM_ALBUM_SNAPSHOT', album.id);
    } else {
      assetIds = (albumMemberships.get(album.id) ?? [])
        .filter((row) => !row.hidden && !row.missing)
        .toSorted((a, b) => (BigInt(a.order) < BigInt(b.order) ? -1 : BigInt(a.order) > BigInt(b.order) ? 1 : 0))
        .map((row) => row.photoId);
    }
    mappedAlbums.push({
      id: album.id,
      ownerId,
      name: album.name,
      ...(album.description === undefined ? {} : { description: album.description }),
      assetIds,
      members: [],
    });
  }
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source: input.source,
    inventory: input.inventory,
    users: principals.map((user) => ({ id: user.id, name: user.name })),
    files: manifestFiles,
    assets,
    albums: mappedAlbums,
    losses,
  });
  return { manifest, archive };
}

/** The snapshot reader admits its exact schema and committed read transaction before mapping any records. */
export function readPhotoprismSqliteManifest(path: string, input: Input) {
  if (input.source.schemaSha256 !== sqlite.schemaSha256) return refuse('PHOTOPRISM_SCHEMA_UNQUALIFIED');
  return assemblePhotoprismManifest(readPhotoprismInventory(path, input.source.version), input);
}
