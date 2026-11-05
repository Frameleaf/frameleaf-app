import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pigallery2Row, Pigallery2Table, openPigallery2Snapshot } from 'src/library-import/pigallery2.js';
import mysqlFixture from 'src/library-import/fixtures/pigallery2/3.5.2-mysql84.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import {
  type ImportManifest,
  importFilePathSchema,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { resolvePigallery2File } from 'src/library-import/pigallery2-files.js';
import { pigallery2Projections } from 'src/library-import/pigallery2-projections.js';
import { pigallery2SidecarCandidates } from 'src/library-import/pigallery2-sidecars.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { normalizeTagValue } from 'src/utils/tag.js';

type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  owners: Record<string, string>;
  grants: Record<string, string[]>;
  materializedAlbums: Record<string, { ownerId: string; mediaIds: string[] }>;
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
  archivedFiles: { path: string; bytes: string; sha256: string; content: Uint8Array }[];
};
const refuse = (code: string): never => {
  throw new Error('PiGallery2 source refused: ' + code);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' && value > 0n ? String(value) : refuse('PIGALLERY2_RELATIONSHIPS_INVALID');

/** Maps admitted records; the controller separately proves source identity, access inventories, fencing and original bytes. */
export function readPigallery2Manifest(
  snapshot: Pick<ReturnType<typeof openPigallery2Snapshot>, 'version' | 'schemaSha256' | 'rows'>,
  input: Input,
) {
  if (
    input.source.kind !== 'pigallery2' ||
    input.source.version !== fixture.source.version ||
    snapshot.version !== input.source.version
  )
    return refuse('PIGALLERY2_VERSION_UNQUALIFIED');
  if (
    ![fixture.schemaSha256, mysqlFixture.schemaSha256].includes(input.source.schemaSha256) ||
    snapshot.schemaSha256 !== input.source.schemaSha256
  )
    return refuse('PIGALLERY2_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (field) => Reflect.get(input.inventory, field) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('PIGALLERY2_CAPTURE_INCOMPLETE');
  const captured = new Map<Pigallery2Table, Pigallery2Row[]>();
  const archive: SourceArchiveRecord[] = [];
  for (const table of Object.keys(pigallery2Projections) as Pigallery2Table[]) {
    const records = [...snapshot.rows(table)].flat();
    for (const value of records) {
      encodeSourceArchiveRecord({ table, value });
      archive.push({ table, value });
    }
    captured.set(table, records);
  }
  const rows = (table: Pigallery2Table) => captured.get(table)!;
  const index = (table: Pigallery2Table) => {
    const result = new Map<string, Pigallery2Row>();
    for (const row of rows(table)) {
      const id = key(row.id);
      if (result.has(id)) return refuse('PIGALLERY2_RELATIONSHIPS_INVALID');
      result.set(id, row);
    }
    return result;
  };
  const users = index('user_entity'),
    media = index('media_entity'),
    directories = index('directory_entity'),
    saved = index('album_base_entity');
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  if (archive.length > 0) loss('PIGALLERY2_SOURCE_METADATA_ARCHIVED');
  // Global guest authentication and allow/block rules are outside the database snapshot.
  loss('PIGALLERY2_SHARING_RESTRICTED');
  if (rows('person_entry').length > 0 || rows('person_junction_table').length > 0) loss('PIGALLERY2_PEOPLE_ARCHIVED');

  const grants = new Map<string, Set<string>>();
  for (const [userId, ids] of Object.entries(input.grants)) {
    if (
      !users.has(userId) ||
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !media.has(id))
    )
      return refuse('PIGALLERY2_OWNER_REVIEW_REQUIRED');
    grants.set(userId, new Set(ids));
  }
  if (
    grants.size !== users.size ||
    Object.keys(input.owners).length !== media.size ||
    Object.keys(input.owners).some((id) => !media.has(id))
  )
    return refuse('PIGALLERY2_OWNER_REVIEW_REQUIRED');
  for (const id of media.keys())
    if (!grants.get(input.owners[id])?.has(id)) return refuse('PIGALLERY2_OWNER_REVIEW_REQUIRED');

  const directoryPaths = new Map<string, string>();
  const usedDirectoryPaths = new Set<string>();
  for (const id of directories.keys()) {
    const chain: string[] = [],
      seen = new Set<string>();
    let current: string | undefined = id;
    while (current !== undefined && !directoryPaths.has(current)) {
      const row = directories.get(current);
      if (!row || seen.has(current)) return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
      seen.add(current);
      chain.push(current);
      const parent: Pigallery2Row['parentId'] = row.parentId;
      current = parent === null ? undefined : key(parent);
    }
    for (const child of chain.toReversed()) {
      const row = directories.get(child)!;
      // Separately indexed subfolders can have no parent link; their stored path remains authoritative.
      if (row.parentId === null) {
        if (row.name === '.' && row.path === './') directoryPaths.set(child, '');
        else {
          if (
            typeof row.name !== 'string' ||
            row.name.includes('/') ||
            !importFilePathSchema.safeParse(row.name).success ||
            typeof row.path !== 'string' ||
            !row.path.endsWith('/')
          )
            return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
          const prefix = row.path === './' ? '' : row.path.slice(0, -1);
          if (row.path !== './' && !importFilePathSchema.safeParse(prefix).success)
            return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
          directoryPaths.set(child, prefix ? prefix + '/' + row.name : row.name);
        }
      } else {
        const parentPath = directoryPaths.get(key(row.parentId));
        if (
          parentPath === undefined ||
          typeof row.name !== 'string' ||
          row.name.includes('/') ||
          !importFilePathSchema.safeParse(row.name).success ||
          row.path !== (parentPath ? parentPath + '/' : './')
        )
          return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
        directoryPaths.set(child, parentPath ? parentPath + '/' + row.name : row.name);
      }
      const path = directoryPaths.get(child)!;
      if (usedDirectoryPaths.has(path)) return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
      usedDirectoryPaths.add(path);
    }
  }

  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
  const files: ImportManifest['files'] = [];
  const assets: Extract<ImportManifest, { version: 3 }>['assets'] = [];
  const allowedArchivePaths = new Set<string>(),
    requiredArchivePaths = new Set<string>();
  const folderMembers = new Map<string, Map<string, string[]>>();
  for (const [id, row] of media) {
    const directoryId = key(row.directoryId),
      directory = directories.get(directoryId);
    if (!directory) return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
    const source = resolvePigallery2File('media_entity', row, directory);
    const proof = proofs.get(source.id);
    if (!proof || proof.path !== source.path || proof.bytes !== source.bytes || proof.role !== 'original')
      return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
    const { modifiedAt, ...file } = proof;
    if (!importFileSchema.safeParse(file).success || !importTimestampSchema.safeParse(modifiedAt).success)
      return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
    files.push(file);
    for (const path of pigallery2SidecarCandidates(source.path)) allowedArchivePaths.add(path);
    const timestamp = row.metadataCreationdate;
    if (typeof timestamp !== 'bigint' || timestamp === 0n || !Number.isSafeInteger(Number(timestamp)))
      return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
    const instant = new Date(Number(timestamp));
    if (!Number.isFinite(instant.getTime())) return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
    const takenAt = instant.toISOString();
    if (!importTimestampSchema.safeParse(takenAt).success) return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
    let offset = 0;
    if (row.metadataCreationdateoffset === null) loss('PIGALLERY2_CAPTURE_OFFSET_UNKNOWN', id);
    else {
      // The pinned entity stores the offset as smallint minutes; its reader only accepts -12:00 to +14:00.
      const minutes = row.metadataCreationdateoffset;
      if (typeof minutes !== 'bigint' || minutes < -720n || minutes > 840n)
        return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
      offset = Number(minutes);
    }
    const local = new Date(Number(timestamp) + offset * 60_000);
    if (!Number.isFinite(local.getTime())) return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
    const localDateTime = local.toISOString().slice(0, -1);
    if (!importTimestampSchema.safeParse(localDateTime + 'Z').success) return refuse('PIGALLERY2_CAPTURE_TIME_INVALID');
    const caption = z.string().nullable().safeParse(row.metadataCaption),
      keywords = z.string().nullable().safeParse(row.metadataKeywords);
    const latitude = z.number().min(-90).max(90).nullable().safeParse(row.metadataPositionDataGPSDataLatitude),
      longitude = z.number().min(-180).max(180).nullable().safeParse(row.metadataPositionDataGPSDataLongitude);
    const rating = row.metadataRating ?? 0n;
    if (
      !caption.success ||
      !keywords.success ||
      !latitude.success ||
      !longitude.success ||
      (latitude.data === null) !== (longitude.data === null) ||
      typeof rating !== 'bigint' ||
      rating < 0n ||
      rating > 5n
    )
      return refuse('PIGALLERY2_METADATA_INVALID');
    if (row.metadataTitle) loss('PIGALLERY2_TITLE_ARCHIVED', id);
    const tags = keywords.data === null || keywords.data === '' ? [] : keywords.data.split(',');
    if (
      new Set(tags).size !== tags.length ||
      tags.some((tag) => !tag || tag.includes('\0') || normalizeTagValue(tag) !== tag)
    )
      return refuse('PIGALLERY2_METADATA_INVALID');
    const ownerId = input.owners[id];
    assets.push({
      id,
      ownerId,
      fileIds: [file.id],
      primaryFileId: file.id,
      type: row.type === 'PhotoEntity' ? 'IMAGE' : 'VIDEO',
      visibility: 'timeline',
      originalFileNames: { [file.id]: z.string().parse(row.name) },
      fileModifiedAt: modifiedAt,
      localDateTime,
      metadata: {
        takenAt,
        description: caption.data ?? '',
        latitude: latitude.data,
        longitude: longitude.data,
        rating: Number(rating),
        tags,
      },
    });
    const byOwner = folderMembers.get(directoryId) ?? new Map<string, string[]>();
    const members = byOwner.get(ownerId) ?? [];
    members.push(id);
    byOwner.set(ownerId, members);
    folderMembers.set(directoryId, byOwner);
  }
  if (files.length !== proofs.size) return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
  for (const row of rows('file_entity')) {
    const directory = directories.get(key(row.directoryId));
    if (!directory) return refuse('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
    const file = resolvePigallery2File('file_entity', row, directory);
    if (requiredArchivePaths.has(file.path)) return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
    requiredArchivePaths.add(file.path);
    allowedArchivePaths.add(file.path);
  }
  const archived = new Set<string>(),
    originalPaths = new Set(files.map((file) => file.path));
  for (const file of input.archivedFiles) {
    if (
      !allowedArchivePaths.has(file.path) ||
      archived.has(file.path) ||
      originalPaths.has(file.path) ||
      !(file.content instanceof Uint8Array) ||
      String(file.content.byteLength) !== file.bytes ||
      createHash('sha256').update(file.content).digest('hex') !== file.sha256 ||
      !importFileSchema.safeParse({
        id: 'archive',
        path: file.path,
        role: 'sidecar',
        bytes: file.bytes,
        sha256: file.sha256,
      }).success
    )
      return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
    archived.add(file.path);
    archive.push({
      table: 'frameleaf_archived_file',
      value: { path: file.path, bytes: file.bytes, sha256: file.sha256, content: file.content },
    });
  }
  if ([...requiredArchivePaths].some((path) => !archived.has(path))) return refuse('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
  const albums: ImportManifest['albums'] = [];
  for (const [directoryId, owners] of folderMembers)
    for (const [ownerId, assetIds] of owners)
      albums.push({
        id: 'directory:' + directoryId + ':owner:' + ownerId,
        ownerId,
        name: directoryPaths.get(directoryId) || 'Library',
        assetIds,
        members: [],
      });
  if (Object.keys(input.materializedAlbums).some((id) => !saved.has(id))) return refuse('PIGALLERY2_MAPPING_CHANGED');
  const assetOwners = new Map(assets.map((asset) => [asset.id, asset.ownerId]));
  for (const [id, row] of saved) {
    const captured = input.materializedAlbums[id];
    if (!captured) return refuse('PIGALLERY2_ALBUM_SNAPSHOT_REQUIRED');
    if (row.type !== 'SavedSearchEntity') return refuse('PIGALLERY2_ALBUM_TYPE_UNQUALIFIED');
    if (
      !users.has(captured.ownerId) ||
      !Array.isArray(captured.mediaIds) ||
      new Set(captured.mediaIds).size !== captured.mediaIds.length ||
      captured.mediaIds.some((id) => !grants.get(captured.ownerId)?.has(id))
    )
      return refuse('PIGALLERY2_OWNER_REVIEW_REQUIRED');
    if (captured.mediaIds.some((id) => assetOwners.get(id) !== captured.ownerId))
      loss('PIGALLERY2_CROSS_OWNER_MEMBERSHIP_ARCHIVED', id);
    albums.push({
      id: 'saved:' + id,
      ownerId: captured.ownerId,
      name: z.string().parse(row.name) + ' (snapshot)',
      assetIds: captured.mediaIds.filter((id) => assetOwners.get(id) === captured.ownerId),
      members: [],
    });
    loss('PIGALLERY2_ALBUM_SNAPSHOT', id);
  }
  for (const record of archive) encodeSourceArchiveRecord(record);
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source: input.source,
    inventory: input.inventory,
    users: [...users].map(([id, row]) => ({ id, name: z.string().parse(row.name) })),
    files,
    assets,
    albums,
    losses,
  });
  return { manifest, archive };
}
