import { resolve, sep } from 'node:path';
import {
  CLOUD_BACKUP_MANIFEST_FORMAT,
  CloudBackupManifest,
  CloudBackupManifestFile,
  cloudBackupAlbumSchema,
  cloudBackupPersonSchema,
  isSha256Hex,
  readManifestAsset,
  readManifestSection,
} from 'src/utils/cloud-backup.js';
import { isLockedKeyUserId } from 'src/utils/locked-backup.js';

/**
 * How a cloud backup is laid out inside a snapshot of the backup engine (FL-1676). A snapshot is one tree:
 *
 * ```
 * locked-keys/<userId>.json      each person's Locked key file, read first
 * database/<dump name>.sql       the database dump, uncompressed so that daily dumps share most chunks
 * files/<storage path…>          originals, sidecars, thumbnails, transcodes and profile pictures
 * catalog/catalog.json           the catalog, written last: what the snapshot holds and for which items
 * ```
 *
 * The catalog is what used to be the manifest: item id → its files, with each item's record and details,
 * the albums and people they name, the profile pictures and the dump. A file's `objectKey` is its place in
 * the tree (names joined with `/`), and `sha256` is still the hash of its content, so a restore checks what
 * it wrote against the catalog as before. Nothing outside the engine's own objects is stored: the provider
 * sees no name, no folder shape and no item count.
 */
export const CLOUD_BACKUP_CATALOG_VERSION = 4;

export const SNAPSHOT_LOCKED_KEYS = 'locked-keys';
export const SNAPSHOT_DATABASE = 'database';
export const SNAPSHOT_FILES = 'files';
export const SNAPSHOT_CATALOG = 'catalog';
export const CATALOG_PATH: readonly string[] = [SNAPSHOT_CATALOG, 'catalog.json'];
/** A catalog larger than this is refused rather than read into memory. */
export const CLOUD_BACKUP_CATALOG_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * The engine stores a name as it is, but refuses one holding a slash, a backslash or a NUL (it could not
 * be put back inside its folder on every system). A backslash is a legal character in a file name here, so
 * it is written as `%5C`, and `%` as `%25` so that reading a name back is exact.
 */
export const encodeTreeName = (name: string) => name.replaceAll('%', '%25').replaceAll('\\', '%5C');
export const decodeTreeName = (name: string) => name.replaceAll('%5C', '\\').replaceAll('%25', '%');

/** Where a file on this server sits in a snapshot: under `files/`, at its full storage path. */
export const fileTreePath = (storagePath: string): string[] => {
  const names = resolve(storagePath).split(sep).filter(Boolean);
  if (names.length === 0) {
    throw new Error('A backed-up file needs a path');
  }
  return [SNAPSHOT_FILES, ...names.map((name) => encodeTreeName(name))];
};

export const lockedKeyTreePath = (userId: string): string[] => [SNAPSHOT_LOCKED_KEYS, `${userId}.json`];

/** The dump is stored uncompressed, so its name in the snapshot loses the `.gz`. */
export const databaseTreePath = (dumpName: string): string[] => [SNAPSHOT_DATABASE, dumpName.replace(/\.gz$/, '')];

/** A place in the tree as one string, the form the catalog keeps in `objectKey`. */
export const treeKey = (path: readonly string[]) => path.join('/');

const SAFE_NAME = (name: string) => name !== '' && name !== '.' && name !== '..' && !/[\\\0]/.test(name);

/** The names of a catalog `objectKey`. A key that could climb out of the snapshot is refused. */
export const treePathOf = (key: string): string[] => {
  const names = key.split('/');
  if (names.length < 2 || names.some((name) => !SAFE_NAME(name))) {
    throw new Error('The backup names a file outside of itself');
  }
  return names;
};

const readFile = (value: unknown): CloudBackupManifestFile | null => {
  const file = value as Partial<CloudBackupManifestFile> | null;
  if (
    !file ||
    typeof file.role !== 'string' ||
    typeof file.path !== 'string' ||
    typeof file.objectKey !== 'string' ||
    typeof file.sha256 !== 'string' ||
    !isSha256Hex(file.sha256) ||
    !Number.isSafeInteger(file.size) ||
    // `file` is untrusted catalog data, not a Map or Set: its `size` can be negative
    // eslint-disable-next-line unicorn/no-impossible-length-comparison
    (file.size as number) < 0
  ) {
    return null;
  }
  try {
    treePathOf(file.objectKey);
  } catch {
    return null;
  }
  return {
    role: file.role,
    path: file.path,
    objectKey: file.objectKey,
    sha256: file.sha256,
    size: file.size as number,
    mtime: typeof file.mtime === 'string' ? file.mtime : null,
  };
};

/**
 * A catalog read back from a snapshot. Its shape is checked before anything trusts it: a file entry that is
 * not well formed stops the read (a restore must never guess), while an item's record or details that are
 * not well formed are left out, so the files still come back.
 */
export const readCatalog = (body: Buffer): CloudBackupManifest => {
  if (body.length > CLOUD_BACKUP_CATALOG_MAX_BYTES) {
    throw new Error('This backup’s catalog is too large to read.');
  }
  let parsed: Partial<CloudBackupManifest> & Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8')) as typeof parsed;
  } catch {
    throw new Error('This backup’s catalog cannot be read.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    parsed.format !== CLOUD_BACKUP_MANIFEST_FORMAT ||
    parsed.version !== CLOUD_BACKUP_CATALOG_VERSION ||
    typeof parsed.instanceId !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !parsed.assets ||
    typeof parsed.assets !== 'object' ||
    Array.isArray(parsed.assets)
  ) {
    throw new Error('This backup’s catalog is not one this server can read.');
  }
  const bad = () => new Error('This backup’s catalog names a file it does not describe.');

  const assets: CloudBackupManifest['assets'] = Object.create(null);
  for (const [id, value] of Object.entries(parsed.assets)) {
    const asset = value as { files?: unknown; owner?: unknown };
    if (!asset || !Array.isArray(asset.files)) {
      throw bad();
    }
    const files = asset.files.map((file) => readFile(file));
    if (files.includes(null)) {
      throw bad();
    }
    assets[id] = readManifestAsset({
      ...(asset as object),
      owner: typeof asset.owner === 'string' ? asset.owner : null,
      files: files as CloudBackupManifestFile[],
    });
  }

  const section = (input: unknown, valid: (id: string) => boolean = () => true) => {
    const read: Record<string, CloudBackupManifestFile> = Object.create(null);
    for (const [id, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
      const file = readFile(value);
      if (!file || !valid(id)) {
        throw bad();
      }
      read[id] = file;
    }
    return read;
  };

  let database: CloudBackupManifest['database'] = null;
  if (parsed.database) {
    const { key, sha256, size } = parsed.database as { key?: unknown; sha256?: unknown; size?: unknown };
    if (typeof key !== 'string' || typeof sha256 !== 'string' || !isSha256Hex(sha256) || !Number.isSafeInteger(size)) {
      throw bad();
    }
    treePathOf(key);
    database = { key, sha256, size: size as number };
  }
  // FL-721: a key file names its owner's user id
  const lockedKeys = section(parsed.lockedKeys, isLockedKeyUserId);
  return {
    format: CLOUD_BACKUP_MANIFEST_FORMAT,
    version: CLOUD_BACKUP_CATALOG_VERSION,
    instanceId: parsed.instanceId,
    createdAt: parsed.createdAt,
    database,
    assets,
    profiles: section(parsed.profiles),
    ...(Object.keys(lockedKeys).length > 0 && { lockedKeys }),
    albums: readManifestSection(parsed.albums, cloudBackupAlbumSchema),
    people: readManifestSection(parsed.people, cloudBackupPersonSchema),
  };
};

/** Every file a catalog names, the dump aside. */
export const catalogFiles = (catalog: CloudBackupManifest): CloudBackupManifestFile[] => [
  ...Object.values(catalog.assets).flatMap((asset) => asset.files),
  ...Object.values(catalog.profiles),
  ...Object.values(catalog.lockedKeys ?? {}),
];
