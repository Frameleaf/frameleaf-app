import { z } from 'zod';
import type { NextcloudRow, NextcloudTable, openNextcloudSnapshot } from 'src/library-import/nextcloud.js';
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import {
  type ImportManifest,
  importFilePathSchema,
  importFileSchema,
  importTimestampSchema,
  parseImportManifest,
} from 'src/library-import/manifest.js';
import { resolveNextcloudHomeOriginal } from 'src/library-import/nextcloud-files.js';
import { nextcloudProjections } from 'src/library-import/nextcloud.js';
import { type SourceArchiveRecord, encodeSourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { normalizeTagValue } from 'src/utils/tag.js';

type Input = {
  source: ImportManifest['source'];
  inventory: ImportManifest['inventory'];
  metadataView: 'photos' | 'memories';
  storageRoots: Record<string, string>;
  files: (ImportManifest['files'][number] & { modifiedAt: string })[];
};
type Manifest = Extract<ImportManifest, { version: 5 }>;
const refuse = (code: string): never => {
  throw new Error('Nextcloud source refused: ' + code);
};
const key = (value: unknown): string =>
  typeof value === 'bigint' && value > 0n ? String(value) : refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
const text = (value: unknown): string =>
  typeof value === 'string' && value.length > 0 ? value : refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
const metadataValue = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : refuse('NEXTCLOUD_METADATA_INVALID');
};
const json = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) return refuse('NEXTCLOUD_METADATA_INVALID');
  try {
    return z.record(z.string(), z.unknown()).parse(JSON.parse(value));
  } catch {
    return refuse('NEXTCLOUD_METADATA_INVALID');
  }
};
const instant = (seconds: unknown): string => {
  const numeric = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (typeof numeric !== 'number' || !Number.isSafeInteger(numeric)) return refuse('NEXTCLOUD_METADATA_INVALID');
  const date = new Date(numeric * 1000);
  if (!Number.isFinite(date.getTime())) return refuse('NEXTCLOUD_METADATA_INVALID');
  const result = date.toISOString();
  return importTimestampSchema.safeParse(result).success ? result : refuse('NEXTCLOUD_METADATA_INVALID');
};

/** Internal mapping only; the controller separately authorizes capture, roots, credentials, effective access and activation. */
export function readNextcloudManifest(snapshot: ReturnType<typeof openNextcloudSnapshot>, input: Input) {
  if (
    input.source.kind !== 'nextcloud' ||
    input.source.version !== fixture.source.version ||
    snapshot.version !== input.source.version
  )
    return refuse('NEXTCLOUD_VERSION_UNQUALIFIED');
  if (input.source.schemaSha256 !== fixture.schemaSha256 || snapshot.schemaSha256 !== input.source.schemaSha256)
    return refuse('NEXTCLOUD_SCHEMA_UNQUALIFIED');
  if (
    ['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'].some(
      (name) => Reflect.get(input.inventory, name) !== true,
    ) ||
    input.inventory.revisionBefore !== input.source.revision ||
    input.inventory.revisionAfter !== input.source.revision
  )
    return refuse('NEXTCLOUD_CAPTURE_INCOMPLETE');
  if (!['photos', 'memories'].includes(input.metadataView)) return refuse('NEXTCLOUD_METADATA_VIEW_REQUIRED');
  const captured = new Map<NextcloudTable, NextcloudRow[]>();
  const archive: SourceArchiveRecord[] = [];
  for (const table of Object.keys(nextcloudProjections) as NextcloudTable[]) {
    const records = [...snapshot.rows(table)].flat();
    for (const value of records) {
      encodeSourceArchiveRecord({ table, value });
      archive.push({ table, value });
    }
    captured.set(table, records);
  }
  const rows = (table: NextcloudTable) => captured.get(table)!;
  const index = (table: NextcloudTable, column: string, numeric = true) => {
    const result = new Map<string, NextcloudRow>();
    for (const row of rows(table)) {
      const id = numeric ? key(row[column]) : text(row[column]);
      if (result.has(id)) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
      result.set(id, row);
    }
    return result;
  };
  const users = index('oc_users', 'uid', false),
    storages = index('oc_storages', 'numeric_id'),
    cached = index('oc_filecache', 'fileid'),
    mimetypes = index('oc_mimetypes', 'id'),
    memories = index('oc_memories', 'fileid'),
    photos = index('oc_files_metadata', 'file_id'),
    categories = index('oc_vcategory', 'id'),
    sourceAlbums = index('oc_photos_albums', 'album_id');
  const mounts = new Map<string, NextcloudRow[]>();
  for (const mount of rows('oc_mounts')) {
    const id = key(mount.storage_id),
      entries = mounts.get(id) ?? [];
    entries.push(mount);
    mounts.set(id, entries);
  }
  const losses: ImportManifest['losses'] = [];
  const loss = (code: string, entityId?: string) => {
    losses.push({ code, ...(entityId === undefined ? {} : { entityId }), acknowledged: false });
  };
  loss('NEXTCLOUD_SOURCE_METADATA_ARCHIVED');
  loss('NEXTCLOUD_SHARING_RESTRICTED');
  loss('NEXTCLOUD_GLOBAL_PRIVACY_REQUIRES_QUALIFICATION');
  if (rows('oc_systemtag').length > 0) loss('NEXTCLOUD_RESTRICTED_SYSTEM_TAGS_ARCHIVED');
  const roots = Object.values(input.storageRoots);
  for (const [id, root] of Object.entries(input.storageRoots))
    if (
      !storages.has(id) ||
      !importFilePathSchema.safeParse(root).success ||
      roots.some((other) => other !== root && (root.startsWith(other + '/') || other.startsWith(root + '/')))
    )
      return refuse('NEXTCLOUD_STORAGE_BINDING_INVALID');
  if (new Set(roots).size !== roots.length) return refuse('NEXTCLOUD_STORAGE_BINDING_INVALID');
  const proofs = new Map(input.files.map((file) => [file.id, file]));
  if (proofs.size !== input.files.length) return refuse('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
  const files: ImportManifest['files'] = [];
  const assets: Manifest['assets'] = [];
  const tagsByFile = new Map<string, NextcloudRow[]>();
  for (const tag of rows('oc_vcategory_to_object')) {
    if (tag.type !== 'files') continue;
    const id = key(tag.objid),
      entries = tagsByFile.get(id) ?? [];
    entries.push(tag);
    tagsByFile.set(id, entries);
  }
  for (const [id, file] of cached) {
    const mimetype = mimetypes.get(key(file.mimetype));
    if (!mimetype) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
    if (!/^(image|video)\//u.test(text(mimetype.mimetype))) continue;
    const storageId = key(file.storage),
      storage = storages.get(storageId),
      storageMounts = mounts.get(storageId) ?? [],
      homeMounts = storageMounts.filter(
        (mount) =>
          storage?.id === 'home::' + String(mount.user_id) &&
          mount.mount_point === '/' + String(mount.user_id) + '/' &&
          mount.mount_id === null,
      );
    if (homeMounts.length > 1) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
    const mount = homeMounts[0];
    // These are Nextcloud-generated application media, outside any mounted user home.
    if (
      storageMounts.length === 0 &&
      typeof storage?.id === 'string' &&
      storage.id.startsWith('local::') &&
      typeof file.path === 'string' &&
      file.path.startsWith('appdata_')
    )
      continue;
    if (!mount || !storage) return refuse('NEXTCLOUD_ORIGINAL_INVALID');
    const owner = users.get(text(mount.user_id)),
      root = cached.get(key(mount.root_id));
    const original = resolveNextcloudHomeOriginal({ file, storage, mount, root, owner, mimetype });
    const prefix = input.storageRoots[storageId];
    if (!prefix) return refuse('NEXTCLOUD_STORAGE_BINDING_INVALID');
    const proof = proofs.get('file:' + id);
    if (
      !proof ||
      proof.path !== prefix + '/' + original.path ||
      proof.bytes !== original.bytes ||
      proof.role !== 'original' ||
      !importTimestampSchema.safeParse(proof.modifiedAt).success ||
      proof.modifiedAt !== instant(file.mtime)
    )
      return refuse('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
    const { modifiedAt, ...receipt } = proof;
    if (!importFileSchema.safeParse(receipt).success) return refuse('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
    files.push(receipt);
    const metadata: Manifest['assets'][number]['metadata'] = { tags: [], favorite: false };
    let localDateTime: string | undefined;
    const memory = memories.get(id),
      photo = photos.get(id);
    if (input.metadataView === 'memories' && memory) {
      if (memory.mtime !== file.mtime || memory.orphan !== 0n) return refuse('NEXTCLOUD_METADATA_STALE');
      metadata.takenAt = instant(memory.epoch);
      localDateTime = text(memory.datetaken).replace(' ', 'T');
      if (!importTimestampSchema.safeParse(localDateTime + 'Z').success) return refuse('NEXTCLOUD_METADATA_INVALID');
      const exif = json(memory.exif);
      if (exif.Description !== undefined) metadata.description = metadataValue(z.string(), exif.Description);
      if (exif.Rating !== undefined) metadata.rating = metadataValue(z.number().int().min(0).max(5), exif.Rating);
      metadata.latitude = metadataValue(z.number().min(-90).max(90).nullable(), memory.lat);
      metadata.longitude = metadataValue(z.number().min(-180).max(180).nullable(), memory.lon);
      if ((metadata.latitude === null) !== (metadata.longitude === null)) return refuse('NEXTCLOUD_METADATA_INVALID');
      if (memory.liveid !== '') loss('NEXTCLOUD_LIVE_PHOTO_REQUIRES_QUALIFICATION', id);
    } else if (input.metadataView === 'photos' && photo) {
      const values = json(photo.json);
      const date = values['photos-original_date_time'];
      if (date !== undefined)
        metadata.takenAt = instant(metadataValue(z.object({ value: z.number().int() }), date).value);
      // Removing Photos GPS unsets the key; never restore stale coordinates from another cache or embedded EXIF.
      const gps = values['photos-gps'];
      const coordinates =
        gps === undefined
          ? { latitude: null, longitude: null }
          : metadataValue(
              z.object({
                value: z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
              }),
              gps,
            ).value;
      metadata.latitude = coordinates.latitude;
      metadata.longitude = coordinates.longitude;
    }
    if (!metadata.takenAt) {
      metadata.takenAt = modifiedAt;
      loss('NEXTCLOUD_CAPTURE_TIME_UNAVAILABLE', id);
    }
    if (localDateTime === undefined) {
      // Present unknown source clocks in UTC and disclose the fallback, without inventing a source time zone.
      localDateTime = metadata.takenAt.slice(0, -1);
      loss('NEXTCLOUD_CAPTURE_CLOCK_UNKNOWN', id);
    }
    for (const tag of tagsByFile.get(id) ?? []) {
      const category = categories.get(key(tag.categoryid));
      if (!category || !users.has(text(category.uid))) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
      if (category.uid !== original.ownerId || category.type !== 'files') continue;
      const name = text(category.category);
      if (name === '_$!<Favorite>!$_') metadata.favorite = true;
      else {
        const normalized = normalizeTagValue(name);
        if (!normalized) return refuse('NEXTCLOUD_METADATA_INVALID');
        if (normalized !== name) loss('NEXTCLOUD_TAG_NORMALIZED', id);
        if (!metadata.tags!.includes(normalized)) metadata.tags!.push(normalized);
      }
    }
    assets.push({
      id,
      ownerId: original.ownerId,
      fileIds: [receipt.id],
      primaryFileId: receipt.id,
      originalFileNames: { [receipt.id]: text(file.name) },
      fileModifiedAt: modifiedAt,
      type: original.mime.startsWith('image/') ? 'IMAGE' : 'VIDEO',
      visibility: 'timeline',
      ...(localDateTime === undefined ? {} : { localDateTime }),
      metadata,
    });
  }
  if (files.length !== proofs.size) return refuse('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
  const assetIndex = new Map(assets.map((asset) => [asset.id, asset]));
  const entriesByAlbum = new Map<string, NextcloudRow[]>();
  for (const entry of rows('oc_photos_albums_files')) {
    if (!sourceAlbums.has(key(entry.album_id)) || !assetIndex.has(key(entry.file_id)))
      return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
    const id = key(entry.album_id),
      entries = entriesByAlbum.get(id) ?? [];
    entries.push(entry);
    entriesByAlbum.set(id, entries);
  }
  const albums: ImportManifest['albums'] = [];
  for (const [id, album] of sourceAlbums) {
    const ownerId = text(album.user);
    if (!users.has(ownerId)) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
    if (album.filters !== null) return refuse('NEXTCLOUD_SMART_ALBUM_REVIEW_REQUIRED');
    const members = new Set<string>();
    for (const entry of entriesByAlbum.get(id) ?? []) {
      const asset = assetIndex.get(key(entry.file_id))!;
      if (entry.owner !== asset.ownerId) return refuse('NEXTCLOUD_RELATIONSHIPS_INVALID');
      if (asset.ownerId === ownerId) members.add(asset.id);
      else loss('NEXTCLOUD_CROSS_OWNER_ALBUM_RESTRICTED', id);
    }
    albums.push({ id, ownerId, name: text(album.name), assetIds: [...members], members: [] });
  }
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 5,
    source: input.source,
    inventory: input.inventory,
    users: users
      .values()
      .map((user) => ({ id: text(user.uid), name: user.displayname ?? text(user.uid) }))
      .toArray(),
    files,
    assets,
    albums,
    stacks: [],
    livePhotos: [],
    losses,
  });
  return { manifest, archive };
}
