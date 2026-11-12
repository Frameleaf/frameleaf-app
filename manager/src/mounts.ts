import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve } from 'node:path';
import { Refusal, type Mount } from './contracts.js';
import { filesystemMounts } from './postgres-storage.js';

/**
 * FL-1320: the media mounts of an installation (`Installation.mounts`).
 *
 * - The library mount is always first: a writable bind (or, for some imports, a volume) at `/data`.
 * - A thumbnail mount is an optional second, writable bind at `/data/thumbs` from a folder on another drive.
 *   Docker mounts it over the library's own `thumbs` folder, so the server's paths and database records do
 *   not change. At most one, and only beside a `/data` library bind.
 * - Anything else (an import's extra folders) follows, unchanged.
 *
 * Thumbnails can be rebuilt, photos cannot: a missing thumbnail folder is a named problem, never a reason to
 * touch the library, and Library Move moves only the library mount.
 */
export const LIBRARY_TARGET = '/data';
export const THUMBNAIL_TARGET = '/data/thumbs';
/** The server's folder marker (server/src/services/storage.service.ts); `.immich` is the legacy name. */
export const FOLDER_MARKER = '.frameleaf';
const LEGACY_FOLDER_MARKER = '.immich';

export const isThumbnailMount = (mount: Mount) => mount.target === THUMBNAIL_TARGET;
/** The thumbnail mount, when thumbnails are on a folder of their own. */
export const thumbnailMount = (mounts: Mount[]): Mount | undefined => mounts.find(isThumbnailMount);
/** Every mount but the thumbnail one: what identifies the library itself (restore lineage, Library Move). */
export const libraryMounts = (mounts: Mount[]): Mount[] => mounts.filter((mount) => !isThumbnailMount(mount));
/** The folder thumbnails are in on the host: the thumbnail mount, else `thumbs` inside the library folder. */
export function thumbnailFolder(mounts: Mount[]): string | null {
  const own = thumbnailMount(mounts);
  if (own) return own.source;
  const library = mounts[0];
  return library?.type === 'bind' && library.target === LIBRARY_TARGET ? join(library.source, 'thumbs') : null;
}

/**
 * FL-1477: the server's built-in Imports folder on the host, `imports` inside the server's media location. The
 * server shows it to administrators so they know where to copy an export. Null when the library is not a bind,
 * or the media location is outside it, since no host path can then be named.
 */
export function importsFolder(mounts: Mount[], mediaLocation: string = LIBRARY_TARGET): string | null {
  const library = mounts[0];
  if (library?.type !== 'bind' || library.target !== LIBRARY_TARGET) return null;
  const inside = posix.relative(LIBRARY_TARGET, posix.normalize(mediaLocation));
  if (inside.startsWith('..') || posix.isAbsolute(inside)) return null;
  return join(library.source, ...inside.split('/').filter(Boolean), 'imports');
}

/** Refuses a mounts list that breaks the model above. */
export function assertMounts(mounts: Mount[]): void {
  const thumbnails = mounts.filter(isThumbnailMount);
  if (!thumbnails.length) return;
  const [library] = mounts;
  if (
    thumbnails.length > 1 ||
    library?.target !== LIBRARY_TARGET ||
    library.type !== 'bind' ||
    library.readOnly ||
    mounts[1] !== thumbnails[0] ||
    thumbnails[0].type !== 'bind' ||
    thumbnails[0].readOnly ||
    thumbnails[0].source === library.source ||
    thumbnails[0].source.startsWith(`${library.source}/`) ||
    library.source.startsWith(`${thumbnails[0].source}/`)
  )
    throw new Refusal('unsupported_thumbnail_mount');
}

/**
 * The mounts with thumbnails in `source`, or back inside the library folder when `source` is null. The
 * thumbnail mount always comes straight after the library mount, so `mounts[0]` stays the library.
 */
export function withThumbnails(mounts: Mount[], source: string | null): Mount[] {
  const [library, ...rest] = libraryMounts(mounts);
  const next = source
    ? [library, { type: 'bind', source, target: THUMBNAIL_TARGET, readOnly: false } satisfies Mount, ...rest]
    : [library, ...rest];
  assertMounts(next);
  return next;
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    },
  );
export const folderExists = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    },
  );

/** The named problem for a bind source that is not there, by what the container uses it for. */
function missing(service: string, source: string, target: string): Refusal {
  if (service === 'frameleaf-server' && target === THUMBNAIL_TARGET)
    return new Refusal(
      'thumbnail_folder_missing',
      409,
      `The thumbnails folder ${source} is not there: its drive may be disconnected or not mounted. Nothing was started, and your photos are untouched. Reconnect the drive, then try again.`,
    );
  if (service === 'frameleaf-server' && target === LIBRARY_TARGET)
    return new Refusal(
      'media_folder_missing',
      409,
      `The photos folder ${source} is not there: its drive may be disconnected or not mounted. Nothing was started. Reconnect the drive, then try again.`,
    );
  return new Refusal(
    'mounted_folder_missing',
    409,
    `${service}: ${source} (mounted at ${target}) is not there: its drive may be disconnected or not mounted. Nothing was started. Reconnect it, then try again.`,
  );
}

/**
 * Which paths Manager can answer for: those inside one of its own mounts (its state, the media and database
 * roots, /mnt). An imported library may keep a host folder that was never mapped into Manager; only Docker can
 * see that one, so it is left to Docker. Outside a container (a native Manager, tests) every path is checked.
 */
export async function visibility(
  mountinfo = '/proc/self/mountinfo',
  container = '/.dockerenv',
): Promise<(path: string) => boolean> {
  if (!(await exists(container))) return () => true;
  const contents = await readFile(mountinfo, 'utf8').catch(() => null);
  if (contents === null) return () => true;
  const targets = filesystemMounts(contents)
    .map((mount) => mount.target)
    .filter((target) => target !== '/');
  // Path-aware: `..` and repeated slashes are resolved first, and /mnt/disk10 is not inside /mnt/disk1.
  return (path) =>
    targets.some((target) => {
      const inner = relative(resolve(target), resolve(path));
      return inner === '' || (inner !== '..' && !inner.startsWith('../') && !isAbsolute(inner));
    });
}

/** Before a start: every bind source of these mounts must exist. Docker's own error would stop the whole stack. */
export async function assertMountSources(mounts: Mount[] = [], service = 'frameleaf-server', visible?: (path: string) => boolean): Promise<void> {
  visible ??= await visibility();
  for (const mount of mounts)
    if (mount.type === 'bind' && visible(mount.source) && !(await exists(mount.source)))
      throw missing(service, mount.source, mount.target);
}

/**
 * The same check against a rendered stack, for the services a `compose up` or `restart` starts (all when none
 * are named). Compose doubles `$` in every string (renderCompose), so sources are read back unescaped.
 */
export async function assertComposeMountSources(
  directory: string,
  services: string[] = [],
  visible?: (path: string) => boolean,
): Promise<void> {
  visible ??= await visibility();
  const compose = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8')) as {
    services?: Record<string, { volumes?: ({ type?: string; source?: string; target?: string } | string)[] }>;
  };
  for (const [name, service] of Object.entries(compose.services ?? {})) {
    if (services.length && !services.includes(name)) continue;
    for (const volume of service.volumes ?? []) {
      if (typeof volume !== 'object' || volume.type !== 'bind' || !volume.source || !volume.target) continue;
      const source = volume.source.replaceAll('$$', '$');
      if (visible(source) && !(await exists(source))) throw missing(name, source, volume.target.replaceAll('$$', '$'));
    }
  }
}

/**
 * Seeds the server's marker in a thumbnail folder Manager has deliberately chosen (a new thumbnail folder, or
 * the library's own `thumbs` folder when a restore falls back to it). A library the server has checked before
 * refuses to start when a checked folder has lost its marker: that protects against an unmounted drive and
 * stays. So this never runs on an ordinary start, only on a folder Manager has just chosen and checked, and it
 * never replaces a marker that is there.
 */
export async function seedThumbnailMarker(folder: string): Promise<'seeded' | 'present'> {
  // Never recursive: a parent that is gone (an unmounted drive) must not be recreated on the boot disk.
  await mkdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await folderExists(folder))) throw new Refusal('thumbnail_folder_missing', 409, `${folder} is not a folder.`);
  for (const name of [FOLDER_MARKER, LEGACY_FOLDER_MARKER]) if (await exists(join(folder, name))) return 'present';
  try {
    await writeFile(join(folder, FOLDER_MARKER), Date.now().toString(), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return 'present';
  }
  return 'seeded';
}
