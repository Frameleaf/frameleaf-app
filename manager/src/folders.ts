import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { Refusal } from './contracts.js';
import { folderDetail } from './host-paths.js';
import { filesystemMounts } from './postgres-storage.js';

/**
 * A new install maps one broad folder into Manager, and folders are chosen in Manager rather than in the template:
 * all of /mnt on Unraid and TrueNAS, or the folders given to launch.sh on a plain Docker host (colon separated in
 * MANAGER_FOLDER_ROOT: the first holds Manager's own folder, the rest are extra drives). Existing installs keep
 * their saved template and explicit roots, so none of this applies to them.
 */
const MNT = '/mnt';
/** The entries of a colon-separated folder list, without empty ones. */
const split = (value: string) => value.split(':').filter(Boolean);
/** The broad folders Manager was given, in order: /mnt unless the launcher named its own. */
export const broadRootList = () => split(process.env.MANAGER_FOLDER_ROOT || MNT);
/** Whether `roots` (single entries or colon-separated lists) are exactly the broad folders, so folders are chosen in Manager. */
export const broadRoots = (roots: string[]) => {
  const [given, broad] = [roots.flatMap(split), broadRootList()];
  return given.length === broad.length && given.every((root, i) => root === broad[i]);
};
const unraid = () => process.env.MANAGER_PLATFORM === 'unraid';

const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
const lexicalOverlap = (a: string, b: string) => within(a, b) || within(b, a);
/** The broad folders holding `path`, innermost first: a drive given inside another folder is its own place. */
const holders = (path: string) =>
  broadRootList()
    .filter((root) => within(path, root))
    .sort((a, b) => b.length - a.length);
/** Drives and remote shares hold their own files; everything else directly under /mnt is a view of the same shares. */
const INDEPENDENT = ['disks', 'remotes', 'rootshare', 'addons'];
const shareView = (path: string) => {
  const [, mnt, view, ...rest] = path.split('/');
  return unraid() && mnt === 'mnt' && view && !INDEPENDENT.includes(view) ? { view, path: `/${rest.join('/')}` } : null;
};
const combined = (view: string) => view === 'user' || view === 'user0';
/** /mnt/user/a and /mnt/disk1/a can be the same files. Two different disks or pools never are. */
export function overlaps(a: string, b: string): boolean {
  if (lexicalOverlap(a, b)) return true;
  const [left, right] = [shareView(a), shareView(b)];
  return !!left && !!right && (combined(left.view) || combined(right.view)) && lexicalOverlap(left.path, right.path);
}
/** The share, pool or drive holding `path`. On Unraid /mnt/disks/UD01 is one drive and /mnt/remotes/nas one share, a level deeper than /mnt/user. */
const volume = (path: string) => {
  const roots = broadRootList();
  if (roots.length > 1 || roots[0] !== MNT) return holders(path)[0];
  const parts = path.split('/').slice(1);
  return `/${parts.slice(0, unraid() && ['disks', 'remotes', 'rootshare'].includes(parts[1]) ? 3 : 2).join('/')}`;
};

/** The location variables a new install no longer sets. An install that sets its roots is left alone. */
export function applyFolderDefaults(env: Record<string, string | undefined> = process.env): void {
  const root = ['unraid', 'truenas'].includes(env.MANAGER_PLATFORM ?? '') ? MNT : env.MANAGER_FOLDER_ROOT;
  if (!root || env.MANAGER_STORAGE_ROOTS || !env.MANAGER_DATA) return;
  env.MANAGER_STORAGE_ROOTS = root;
  env.MANAGER_DATABASE_ROOTS = root;
  env.MANAGER_MOUNT_ROOTS = root;
  env.MANAGER_BACKUP_ROOT ??= join(dirname(env.MANAGER_DATA), 'frameleaf-backups');
}

function assertUsable(path: string): void {
  // Strictly inside a broad folder: never a broad folder itself, even one inside another, and never /.
  const inside = holders(path);
  if (
    path !== resolve(path) ||
    /[\n\0,:]/.test(path) ||
    !inside.length ||
    inside.includes(path) ||
    // TrueNAS keeps Docker and its apps in /mnt/.ix-apps; nothing hidden directly in a broad folder is a place for photos.
    inside.some((root) => relative(root, path).startsWith('.')) ||
    // /mnt/user is every share at once, /mnt/tank a whole pool; a folder needs to be inside one.
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

/** Whether `place` is a mount of its own in the host's mount table, not just a folder of that name. */
export const isMounted = (place: string, mountinfo: string) => filesystemMounts(mountinfo).some((mount) => mount.target === place);
/** A TrueNAS pool that isn't imported can leave an empty /mnt/tank: writing there lands on the boot disk, hidden once the pool returns. */
const poolAbsent = async (place: string) =>
  process.env.MANAGER_PLATFORM === 'truenas' && !isMounted(place, await readFile('/run/frameleaf-host/mountinfo', 'utf8').catch(() => ''));

/** A folder chosen in setup, created when it is missing. A drive or share that isn't there is never invented. */
export async function ensureChosenFolder(path: string): Promise<void> {
  assertUsable(path);
  const place = volume(path);
  // ponytail: off TrueNAS, an unmounted drive that left its empty mount point behind passes; the disk-space check is the next guard.
  if (!(await stat(place).then((s) => s.isDirectory(), () => false)) || (await poolAbsent(place)))
    throw new Refusal('storage_volume_missing', 409, folderDetail(path));
  // A link could lead outside /mnt or into another chosen folder, past the checks that compare these paths.
  if ((await realTarget(path)) !== path) throw new Refusal('invalid_storage_path', 409, folderDetail(path));
  await mkdir(path, { recursive: true });
}

/** Manager's own folder, before anything can show a problem. A mistyped pool must stop here: /mnt/typo would land on the boot disk. */
export async function ensureManagerFolder(path: string): Promise<void> {
  if (unraid()) {
    await mkdir(path, { recursive: true });
    return;
  }
  await ensureChosenFolder(path).catch((error: Refusal) => {
    throw new Error(`MANAGER_DATA is ${path}, which can't be used (${error.code}). Set it to a folder on a pool or drive that exists, then restart.`);
  });
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

/** With several broad folders, the picker's top level lists them; it is never a folder to use. */
export const FOLDER_TOP = '/';

/**
 * The folders directly inside `requested`, or inside its nearest existing parent, so a default not yet created still opens.
 * With one broad folder, anything outside it opens that folder. With several, it opens the list of them.
 */
export async function listFolders(requested: string): Promise<FolderListing> {
  const roots = broadRootList();
  let path = resolve(requested);
  if (!holders(path).length) {
    if (roots.length > 1)
      return { path: FOLDER_TOP, parent: null, folders: roots.map((root) => ({ name: root, path: root })), truncated: false };
    path = roots[0];
  }
  for (;;) {
    const real = await realpath(path).catch(() => null);
    if (real !== null && holders(real).length && (await stat(real)).isDirectory()) break;
    if (roots.includes(path)) throw new Refusal('storage_volume_missing');
    path = dirname(path);
  }
  const entries = await readdir(path, { withFileTypes: true }).catch(() => {
    throw new Refusal('storage_permissions', 409, folderDetail(path));
  });
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Up stays inside the broad folders: from a nested drive to the folder around it, from an outer one to the list.
  const parent = holders(path).some((root) => root !== path) ? dirname(path) : roots.length > 1 ? FOLDER_TOP : null;
  return { path, parent, folders: folders.slice(0, LISTING_LIMIT), truncated: folders.length > LISTING_LIMIT };
}
