import { posix } from 'node:path';
import { z } from 'zod';
import type { PhotoviewRow, PhotoviewTable, openPhotoviewSnapshot } from 'src/library-import/photoview.js';
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import {
  type ImportManifest,
  importFilePathSchema,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { normalizePhotoviewAccess } from 'src/library-import/photoview-access.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  sourceRoot: string;
  photoOwners: Record<string, string>;
  albumOwners: Record<string, string>;
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
};
type Manifest = Extract<ImportManifest, { version: 3 }>;
const tables: PhotoviewTable[] = [
  'users',
  'albums',
  'media',
  'media_exif',
  'video_metadata',
  'user_albums',
  'user_media_data',
  'face_groups',
  'image_faces',
  'media_urls',
  'user_preferences',
  'share_tokens',
];
const refuse = (code: string): never => {
  throw new Error(`Photoview source refused: ${code}`);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' && value > 0n ? String(value) : refuse('PHOTOVIEW_RELATIONSHIPS_INVALID');

/** Only admitted snapshots. Source fencing, private credentials and independent byte capture remain caller obligations. */
export function readPhotoviewManifest(snapshot: ReturnType<typeof openPhotoviewSnapshot>, input: Input) {
  if (
    input.source.kind !== 'photoview' ||
    input.source.version !== fixture.source.version ||
    snapshot.version !== input.source.version
  )
    return refuse('PHOTOVIEW_VERSION_UNQUALIFIED');
  if (snapshot.schemaSha256 !== input.source.schemaSha256) return refuse('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (name) => Reflect.get(input.inventory, name) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('PHOTOVIEW_CAPTURE_INCOMPLETE');
  const captured = new Map<PhotoviewTable, PhotoviewRow[]>();
  const archive: SourceArchiveRecord[] = [];
  for (const table of tables) {
    const records = [...snapshot.rows(table)].flat();
    for (const value of records) {
      encodeSourceArchiveRecord({ table, value });
      archive.push({ table, value });
    }
    captured.set(table, records);
  }
  const rows = (table: PhotoviewTable) => captured.get(table)!;
  const users = rows('users');
  const albums = new Map(rows('albums').map((row) => [key(row.id), row]));
  const photos = new Map(rows('media').map((row) => [key(row.id), row]));
  const exif = new Map(rows('media_exif').map((row) => [key(row.id), row]));
  const access = new Map(
    normalizePhotoviewAccess({
      users,
      albums: rows('albums'),
      media: rows('media'),
      userAlbums: rows('user_albums'),
      preferences: rows('user_media_data'),
    }).map((row) => [row.id, row]),
  );
  if (
    Object.keys(input.photoOwners).some((id) => !photos.has(id)) ||
    Object.keys(input.albumOwners).some((id) => !albums.has(id))
  )
    return refuse('PHOTOVIEW_MAPPING_CHANGED');
  const grants = Map.groupBy(rows('user_albums'), (row) => key(row.album_id));
  const albumReaders = (id: string) => {
    const readers = new Set<string>();
    let current: string | undefined = id;
    // Parent integrity and cycles were checked by normalizePhotoviewAccess.
    while (current !== undefined) {
      for (const row of grants.get(current) ?? []) readers.add(key(row.user_id));
      const parent: PhotoviewRow['parent_album_id'] = albums.get(current)!.parent_album_id;
      current = parent === null ? undefined : key(parent);
    }
    return readers;
  };
  const albumOwner = (id: string) => {
    const owner = Object.hasOwn(input.albumOwners, id) ? input.albumOwners[id] : undefined;
    return owner !== undefined && albumReaders(id).has(owner) ? owner : refuse('PHOTOVIEW_OWNER_MAPPING_REQUIRED');
  };
  const root = input.sourceRoot;
  const relative = (value: unknown) => {
    if (
      typeof root !== 'string' ||
      !posix.isAbsolute(root) ||
      posix.normalize(root) !== root ||
      (root !== '/' && !importFilePathSchema.safeParse(root.slice(1)).success)
    )
      return refuse('PHOTOVIEW_ORIGINAL_PATH_INVALID');
    const prefix = root === '/' ? '/' : root + '/';
    if (typeof value !== 'string' || posix.normalize(value) !== value || !value.startsWith(prefix))
      return refuse('PHOTOVIEW_ORIGINAL_PATH_INVALID');
    const parsed = importFilePathSchema.safeParse(value.slice(prefix.length));
    return parsed.success ? parsed.data : refuse('PHOTOVIEW_ORIGINAL_PATH_INVALID');
  };
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  if (archive.length > 0) loss('PHOTOVIEW_SOURCE_METADATA_ARCHIVED');
  // shortcut: archive face geometry and directory ancestry until their destination mappings are qualified.
  if (rows('face_groups').length > 0 || rows('image_faces').length > 0) loss('PHOTOVIEW_PEOPLE_ARCHIVED');
  if (rows('albums').some((row) => row.parent_album_id !== null)) loss('PHOTOVIEW_DIRECTORY_HIERARCHY_ARCHIVED');
  if (rows('share_tokens').length > 0 || albums.keys().some((id) => albumReaders(id).size > 1))
    loss('PHOTOVIEW_SHARING_RESTRICTED');
  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
  const files: ImportManifest['files'] = [];
  const file = (id: string, path: unknown, role: 'original' | 'sidecar') => {
    const sourcePath = relative(path);
    const proof = proofs.get(id);
    if (!proof || proof.path !== sourcePath || proof.role !== role) return refuse('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
    const { modifiedAt, ...value } = proof;
    importTimestampSchema.parse(modifiedAt);
    const parsed = importFileSchema.safeParse(value);
    if (!parsed.success) return refuse('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
    files.push(parsed.data);
    return proof;
  };
  const originalURLs = Map.groupBy(
    rows('media_urls').filter((row) => row.purpose === 'original'),
    (row) => key(row.media_id),
  );
  const assets: Manifest['assets'] = [];
  for (const [id, row] of photos) {
    const ownerId = Object.hasOwn(input.photoOwners, id) ? input.photoOwners[id] : undefined;
    const privacy = access.get(id)!;
    if (ownerId === undefined || !privacy.readerIds.includes(ownerId))
      return refuse('PHOTOVIEW_OWNER_MAPPING_REQUIRED');
    const primary = file(`media:${id}`, row.path, 'original');
    if (
      (originalURLs.get(id) ?? []).some(
        (url) => typeof url.file_size !== 'bigint' || String(url.file_size) !== primary.bytes,
      )
    )
      return refuse('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
    const fileIds = [primary.id];
    if (row.side_car_path !== null) {
      if (row.type !== 'photo' || row.side_car_path !== String(row.path) + '.xmp')
        return refuse('PHOTOVIEW_SIDECAR_REVIEW_REQUIRED');
      fileIds.push(file(`sidecar:${id}`, row.side_car_path, 'sidecar').id);
    }
    const metadata = row.exif_id === null ? undefined : exif.get(key(row.exif_id));
    if (row.exif_id !== null && !metadata) return refuse('PHOTOVIEW_RELATIONSHIPS_INVALID');
    const fields = z
      .object({
        description: z.string().nullable(),
        gps_latitude: z.number().min(-90).max(90).nullable(),
        gps_longitude: z.number().min(-180).max(180).nullable(),
      })
      .safeParse(metadata ?? { description: null, gps_latitude: null, gps_longitude: null });
    if (!fields.success || (fields.data.gps_latitude === null) !== (fields.data.gps_longitude === null))
      return refuse('PHOTOVIEW_METADATA_INVALID');
    if (typeof row.date_shot !== 'string') return refuse('PHOTOVIEW_CAPTURE_TIME_INVALID');
    const clock = row.date_shot.replace(' ', 'T');
    const takenAt = clock.replace(/(\.\d{6})\d+(?=Z$|[+-]\d{2}:\d{2}$)/, '$1');
    if (!importTimestampSchema.safeParse(takenAt).success) return refuse('PHOTOVIEW_CAPTURE_TIME_INVALID');
    if (takenAt !== clock) loss('PHOTOVIEW_CAPTURE_PRECISION_ARCHIVED', id);
    // The internal source parser tags floating EXIF wall clocks as UTC; this cannot prove a regional offset.
    if (metadata?.date_shot !== null && metadata !== undefined && /(?:Z|\+00:00|-00:00)$/.test(takenAt))
      loss('PHOTOVIEW_CAPTURE_TIME_ZONE_UNRESOLVED', id);
    const type =
      row.type === 'photo' ? 'IMAGE' : row.type === 'video' ? 'VIDEO' : refuse('PHOTOVIEW_MEDIA_TYPE_INVALID');
    if (privacy.favorites.some((preference) => preference.userId !== ownerId))
      loss('PHOTOVIEW_VIEWER_PREFERENCES_ARCHIVED', id);
    if (typeof row.title !== 'string') return refuse('PHOTOVIEW_METADATA_INVALID');
    if (row.title !== posix.basename(primary.path)) loss('PHOTOVIEW_TITLE_ARCHIVED', id);
    assets.push({
      id,
      ownerId,
      fileIds,
      primaryFileId: primary.id,
      type,
      fileModifiedAt: primary.modifiedAt,
      originalFileNames: { [primary.id]: posix.basename(primary.path) },
      visibility: 'timeline',
      localDateTime: takenAt.replace(/(?:Z|[+-]\d{2}:\d{2})$/, ''),
      metadata: {
        takenAt,
        latitude: fields.data.gps_latitude,
        longitude: fields.data.gps_longitude,
        ...(fields.data.description === null ? {} : { description: fields.data.description }),
        favorite: privacy.favorites.find((preference) => preference.userId === ownerId)?.favorite ?? false,
      },
    });
  }
  if (files.length !== proofs.size) return refuse('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
  const memberships = Map.groupBy(assets, (asset) => access.get(asset.id)!.albumId);
  const mappedAlbums: ImportManifest['albums'] = [];
  for (const [id, row] of albums) {
    const ownerId = albumOwner(id);
    if (typeof row.title !== 'string') return refuse('PHOTOVIEW_METADATA_INVALID');
    const owners = Map.groupBy(memberships.get(id) ?? [], (asset) => asset.ownerId);
    mappedAlbums.push({
      id,
      ownerId,
      name: row.title,
      assetIds: (owners.get(ownerId) ?? []).map((asset) => asset.id),
      members: [],
    });
    for (const [other, members] of owners) {
      if (other === ownerId) continue;
      // Each member owner was independently checked against this directory's inherited source readers.
      mappedAlbums.push({
        id: `${id}:owner:${other}`,
        ownerId: other,
        name: row.title,
        assetIds: members.map((asset) => asset.id),
        members: [],
      });
      loss('PHOTOVIEW_ALBUM_PARTITIONED', id);
    }
  }
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source: input.source,
    inventory: input.inventory,
    users: users.map((row) => ({ id: key(row.id), name: z.string().parse(row.username) })),
    files,
    assets,
    albums: mappedAlbums,
    losses,
  });
  return { manifest, archive };
}
