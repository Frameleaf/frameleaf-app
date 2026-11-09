import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Refusal } from './contracts.js';
import { folderDetail } from './host-paths.js';

/**
 * A new Unraid install maps all of /mnt into Manager, and folders are chosen in Manager rather than in the
 * template. Existing installs keep their saved template and explicit roots, so none of this applies to them.
 */
export const BROAD_ROOT = '/mnt';
export const broadRoots = (roots: string[]) => roots.length === 1 && roots[0] === BROAD_ROOT;

const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
export const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
/** /mnt/disks/UD01 is one drive and /mnt/remotes/nas one share, so they sit a level deeper than /mnt/user. */
const volume = (path: string) => {
  const parts = path.split('/').slice(1);
  return `/${parts.slice(0, ['disks', 'remotes', 'rootshare'].includes(parts[1]) ? 3 : 2).join('/')}`;
};

/** The location variables a new Unraid template no longer sets. An install that sets its roots is left alone. */
export function applyUnraidFolderDefaults(env: Record<string, string | undefined> = process.env): void {
  if (env.MANAGER_PLATFORM !== 'unraid' || env.MANAGER_STORAGE_ROOTS || !env.MANAGER_DATA) return;
  env.MANAGER_STORAGE_ROOTS = BROAD_ROOT;
  env.MANAGER_DATABASE_ROOTS = BROAD_ROOT;
  env.MANAGER_MOUNT_ROOTS = BROAD_ROOT;
  env.MANAGER_BACKUP_ROOT ??= join(dirname(env.MANAGER_DATA), 'frameleaf-backups');
}

function assertUsable(path: string): void {
  if (
    path !== resolve(path) ||
    /[\n\0,:]/.test(path) ||
    !path.startsWith(`${BROAD_ROOT}/`) ||
    // /mnt/user is every share at once; a folder needs to be one of them or inside one.
    path.split('/').length < 4
  )
    throw new Refusal('invalid_storage_path', 409, folderDetail(path));
}

/** Where `path` really lands, including the part that doesn't exist yet: a link anywhere on the way shows up as a difference. */
export async function realTarget(path: string): Promise<string> {
  let existing = path;
  for (;;) {
    const real = await realpath(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw new Refusal('storage_permissions', 409, folderDetail(path));
      return null;
    });
    if (real !== null) return join(real, relative(existing, path));
    existing = dirname(existing);
  }
}

/** A folder chosen in setup, created when it is missing. A drive or share that isn't there is never invented. */
export async function ensureChosenFolder(path: string): Promise<void> {
  assertUsable(path);
  // ponytail: an unmounted drive that left its empty mount point behind passes; the disk-space check is the next guard.
  if (!(await stat(volume(path)).then((s) => s.isDirectory(), () => false)))
    throw new Refusal('storage_volume_missing', 409, folderDetail(path));
  // A link could lead outside /mnt or into another chosen folder, past the checks that compare these paths.
  if ((await realTarget(path)) !== path) throw new Refusal('invalid_storage_path', 409, folderDetail(path));
  await mkdir(path, { recursive: true });
}

/** Photos, database, backups and Manager's own settings must not share a folder. */
export function assertSeparateFolders(paths: string[]): void {
  paths.forEach((path, i) => {
    if (paths.slice(i + 1).some((other) => overlaps(path, other))) throw new Refusal('chosen_folders_overlap', 409, folderDetail(path));
  });
}

/** An external folder holds someone's photos: never all of /mnt, and never Frameleaf's own data. */
export function assertExternalFolder(source: string, occupied: string[]): void {
  assertUsable(source);
  if (occupied.some((path) => overlaps(source, path))) throw new Refusal('external_folder_holds_frameleaf_data', 409, folderDetail(source));
}

export type FolderListing = { path: string; parent: string | null; folders: { name: string; path: string }[]; truncated: boolean };
const LISTING_LIMIT = 500;

/** The folders directly inside `requested`, or inside its nearest existing parent, so a default not yet created still opens. */
export async function listFolders(requested: string): Promise<FolderListing> {
  let path = resolve(requested);
  if (!within(path, BROAD_ROOT)) path = BROAD_ROOT;
  for (;;) {
    const real = await realpath(path).catch(() => null);
    if (real !== null && within(real, BROAD_ROOT) && (await stat(real)).isDirectory()) break;
    if (path === BROAD_ROOT) throw new Refusal('storage_volume_missing');
    path = dirname(path);
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => {
    throw new Refusal('storage_permissions', 409, folderDetail(path));
  });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path, parent: path === BROAD_ROOT ? null : dirname(path), folders: folders.slice(0, LISTING_LIMIT), truncated: folders.length > LISTING_LIMIT };
}
