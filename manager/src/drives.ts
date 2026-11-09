import { randomBytes, randomUUID } from 'node:crypto';
import { open, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { toContainer, toHost } from './host-paths.js';
import { filesystemMounts, type FilesystemMount } from './postgres-storage.js';

/**
 * The drives Manager can put Frameleaf's data on, how fast each is, and which one to suggest for the database or
 * thumbnails. Detection is a hint, never a promise: Unraid shares and ZFS hide the disk behind them, and a virtual
 * disk can report itself as spinning while finishing a sync in 0.10 ms. Anything Manager can't identify is listed
 * but never suggested.
 */
export type DriveKind = 'nvme' | 'ssd' | 'hdd' | 'unknown';
export type DriveSpeed = 'fast' | 'slow' | 'unknown';
/** How the speed was learned: the kernel's device flags, the Unraid path alone, a timed write, or not at all. */
export type DriveEvidence = 'device' | 'path' | 'timed-write' | 'none';
export type Drive = {
  /** Where the drive starts, as Manager's container sees it. */
  path: string;
  /** The same place on the server. */
  hostPath: string;
  /** "Cache pool", "Hard drive array", "tank pool". */
  name: string;
  /** The name with the drive type: "Cache pool (NVMe SSD)". */
  label: string;
  kind: DriveKind;
  speed: DriveSpeed;
  evidence: DriveEvidence;
  filesystem: string;
  freeBytes: number | null;
  totalBytes: number | null;
  /** The folder new Frameleaf folders go inside: an Unraid pool's appdata, otherwise the drive itself. */
  base: string;
};

const within = (path: string, parent: string) => path === parent || path.startsWith(parent === '/' ? '/' : `${parent}/`);

/** Filesystems that hold files on a disk in this server. Network shares, Docker layers and memory are left out. */
const DISK_FILESYSTEMS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'bcachefs', 'ntfs', 'ntfs3', 'exfat', 'vfat', 'fuse.shfs']);
/** Unraid's array: the combined share views and each parity-protected disk. Spun-down disks must stay asleep. */
const UNRAID_ARRAY = /^\/mnt\/(?:user0?|disk\d+)(?:\/|$)/;
const unraidArray = (hostPath: string) => UNRAID_ARRAY.test(hostPath);

/** One mount table entry per drive. ZFS gives every dataset its own device, so a pool is grouped by its name. */
const driveKey = (mount: FilesystemMount) => (mount.type === 'zfs' ? `zfs:${mount.source.split('/')[0]}` : `dev:${mount.device}`);

export type DriveMount = { key: string; path: string; hostPath: string; mount: FilesystemMount };

/**
 * The mounts Manager can use, one per drive: under one of its folders (`roots`, container paths), on a disk, writable,
 * not a loop device and not inside Docker's own storage. `dockerRoot` is a host path.
 *
 * A folder root that is itself inside a drive (plain Docker with one mapped folder) counts as that drive, at the
 * root. Unraid and TrueNAS keep everything on pools mounted under /mnt, so /mnt's own disk (the boot device) never does.
 */
export function driveMounts(
  mounts: FilesystemMount[],
  { roots, dockerRoot, platform }: { roots: string[]; dockerRoot?: string; platform?: string },
): DriveMount[] {
  const usable = (mount: FilesystemMount) =>
    DISK_FILESYSTEMS.has(mount.type) &&
    !mount.options.includes('ro') &&
    !/^\/dev\/(?:loop|ram|zram)/.test(mount.source) &&
    !(dockerRoot && within(mount.target, dockerRoot)) &&
    !(mount.type === 'zfs' && mount.source.split('/')[0] === 'boot-pool') &&
    // Unraid's combined view without cache is the same files as /mnt/user, and slower to ask.
    !(platform === 'unraid' && /^\/mnt\/user0(?:\/|$)/.test(mount.target));
  const hidden = (path: string, root: string) => path.slice(root.length).split('/').some((part) => part.startsWith('.'));
  const found: DriveMount[] = [];
  for (const mount of mounts) {
    const path = toContainer(mount.target);
    const root = roots.find((r) => within(path, r));
    if (!root || path === root || hidden(path, root) || !usable(mount)) continue;
    found.push({ key: driveKey(mount), path, hostPath: mount.target, mount });
  }
  if (platform !== 'unraid' && platform !== 'truenas') {
    for (const root of roots) {
      const hostRoot = toHost(root);
      const covering = mounts.filter((m) => within(hostRoot, m.target)).sort((a, b) => b.target.length - a.target.length)[0];
      if (covering && usable(covering)) found.push({ key: driveKey(covering), path: root, hostPath: hostRoot, mount: covering });
    }
  }
  // The top of each drive: a pool's datasets, a bind of a subfolder and a second mount of the same disk fold into it.
  const byKey = new Map<string, DriveMount>();
  const order = (a: DriveMount, b: DriveMount) => Number(b.mount.root === '/') - Number(a.mount.root === '/') || a.path.length - b.path.length;
  for (const drive of found.sort(order)) if (!byKey.has(drive.key)) byKey.set(drive.key, drive);
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Read-only access to /sys, so detection can be tested with fixture text. */
export type Sysfs = {
  read(path: string): Promise<string | null>;
  real(path: string): Promise<string | null>;
  list(path: string): Promise<string[]>;
};
export const hostSysfs: Sysfs = {
  read: (path) => readFile(path, 'utf8').then((text) => text.trim(), () => null),
  real: (path) => realpath(path).catch(() => null),
  list: (path) => readdir(path).catch(() => []),
};

export type BlockDevice = { name: string; rotational: boolean | null; nvme: boolean; virtual: boolean };
const VIRTUAL_VENDOR = /QEMU|VMware|VBOX|Virtual|Msft|Red Hat|Xen|Google|Amazon/i;
/** What the kernel says about the disk under a mount, or null when there is no block device to ask (ZFS, shfs). */
export async function blockDevice(mount: FilesystemMount, sys: Sysfs = hostSysfs): Promise<BlockDevice | null> {
  const [major] = mount.device.split(':');
  // btrfs and others report an anonymous device (major 0); their source still names the partition.
  const entry =
    major !== '0'
      ? `/sys/dev/block/${mount.device}`
      : /^\/dev\/[\w-]+$/.test(mount.source)
        ? `/sys/class/block/${basename(mount.source)}`
        : null;
  if (!entry) return null;
  const real = await sys.real(entry);
  if (!real) return null;
  // A partition has no queue of its own: its disk is the folder above it.
  const disk = (await sys.read(`${real}/partition`)) !== null ? dirname(real) : real;
  const name = basename(disk);
  const flag = await sys.read(`${disk}/queue/rotational`);
  // An encrypted or mapped device (LUKS, LVM) sits on other disks: NVMe or a virtual disk underneath still counts.
  const below = name.startsWith('dm-') ? await sys.list(`${disk}/slaves`) : [];
  const virtual = async (path: string, device: string) =>
    /^(?:x?vd)/.test(device) ||
    VIRTUAL_VENDOR.test(`${(await sys.read(`${path}/device/vendor`)) ?? ''} ${(await sys.read(`${path}/device/model`)) ?? ''}`);
  const slaveVirtual = async (slave: string) => {
    const real = await sys.real(`${disk}/slaves/${slave}`);
    const path = real && (await sys.read(`${real}/partition`)) !== null ? dirname(real) : real;
    return virtual(path ?? '', path ? basename(path) : slave);
  };
  return {
    name,
    rotational: flag === '0' ? false : flag === '1' ? true : null,
    nvme: /^nvme/.test(name) || (below.length > 0 && below.every((slave) => /^nvme/.test(slave))),
    virtual: (await virtual(disk, name)) || (await Promise.all(below.map(slaveVirtual))).some(Boolean),
  };
}

/** A sync this slow is a spinning disk (a half turn at 7200 rpm is 4.2 ms); SSDs and NVMe finish well under it. */
const FAST_SYNC_MS = 3;
const PROBE_BUDGET_MS = 800;
const PROBE_BLOCK = 64 * 1024;
/**
 * Time a few small synced writes in `folder` and remove the file, whatever happens. Random bytes, so ZFS compression
 * can't skip the write. Stops early once the budget is spent: a drive that slow is not fast. Null when it can't write.
 */
type ProbeHandle = Pick<Awaited<ReturnType<typeof open>>, 'write' | 'datasync' | 'close'>;
export async function timedWrite(
  folder: string,
  budgetMs = PROBE_BUDGET_MS,
  openFile: (file: string) => Promise<ProbeHandle> = (file) => open(file, 'wx', 0o600),
): Promise<'fast' | 'slow' | null> {
  const file = join(folder, `.frameleaf-drive-check-${randomUUID()}`);
  let handle: ProbeHandle | undefined;
  try {
    handle = await openFile(file);
    const block = randomBytes(PROBE_BLOCK);
    const started = performance.now();
    const syncs: number[] = [];
    for (let round = 0; round < 3; round++) {
      await handle.write(block, 0, block.length, round * block.length);
      const before = performance.now();
      await handle.datasync();
      syncs.push(performance.now() - before);
      if (performance.now() - started > budgetMs) return 'slow';
    }
    return syncs.sort((a, b) => a - b)[1] < FAST_SYNC_MS ? 'fast' : 'slow';
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(file, { force: true }).catch(() => undefined);
  }
}

export type Classification = { kind: DriveKind; speed: DriveSpeed; evidence: DriveEvidence };
/**
 * How fast a drive is. Unraid's array is slow from its path alone and is never written to. A physical disk is trusted;
 * anything unclear (ZFS, a virtual disk, no device to ask) gets a timed write.
 */
export async function classify(
  drive: DriveMount,
  { platform, sys = hostSysfs, probe = timedWrite }: { platform?: string; sys?: Sysfs; probe?: (path: string) => Promise<'fast' | 'slow' | null> },
): Promise<Classification> {
  if (platform === 'unraid' && (unraidArray(drive.hostPath) || drive.mount.type === 'fuse.shfs'))
    return { kind: 'hdd', speed: 'slow', evidence: 'path' };
  const device = drive.mount.type === 'zfs' ? null : await blockDevice(drive.mount, sys);
  if (device && !device.virtual) {
    if (device.nvme) return { kind: 'nvme', speed: 'fast', evidence: 'device' };
    if (device.rotational === false) return { kind: 'ssd', speed: 'fast', evidence: 'device' };
    if (device.rotational === true) return { kind: 'hdd', speed: 'slow', evidence: 'device' };
  }
  const timed = await probe(drive.path);
  if (timed === 'fast') return { kind: device?.nvme ? 'nvme' : 'ssd', speed: 'fast', evidence: 'timed-write' };
  if (timed === 'slow') return { kind: 'hdd', speed: 'slow', evidence: 'timed-write' };
  return { kind: 'unknown', speed: 'unknown', evidence: 'none' };
}

const KIND_TEXT: Record<DriveKind, string> = { nvme: 'NVMe SSD', ssd: 'SSD', hdd: 'hard drive', unknown: '' };
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** The plain name shown for a drive, and the folder Frameleaf's folders go inside. */
export function driveName(hostPath: string, path: string, platform?: string): { name: string; base: string; array: boolean } {
  const parts = hostPath.split('/').filter(Boolean);
  if (platform === 'unraid' && parts[0] === 'mnt') {
    if (parts[1] === 'user') return { name: 'Hard drive array', base: path, array: true };
    const disk = /^disk(\d+)$/.exec(parts[1] ?? '');
    if (disk) return { name: `Disk ${disk[1]}`, base: path, array: true };
    if (parts[1] === 'disks' && parts[2]) return { name: parts[2], base: path, array: false };
    // A pool: the appdata share lives on it, as Unraid's own templates expect.
    if (parts.length === 2) return { name: `${capitalised(parts[1])} pool`, base: `${path}/appdata`, array: false };
  }
  if (platform === 'truenas' && parts[0] === 'mnt' && parts.length === 2) return { name: `${parts[1]} pool`, base: path, array: false };
  return { name: basename(hostPath) || hostPath, base: path, array: false };
}
export function driveLabel(name: string, kind: DriveKind, array: boolean): string {
  if (name === 'Hard drive array') return name;
  if (array) return `${name} (array)`;
  return KIND_TEXT[kind] ? `${name} (${KIND_TEXT[kind]})` : name;
}

export type DriveSources = {
  roots: string[];
  platform?: string;
  dockerRoot?: string;
  mountinfo?: string;
  sys?: Sysfs;
  probe?: (path: string) => Promise<'fast' | 'slow' | null>;
  space?: (path: string) => Promise<{ freeBytes: number; totalBytes: number } | null>;
};
const hostSpace = (path: string) =>
  statfs(path).then(
    (s) => ({ freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }),
    () => null,
  );

// ponytail: one timed write per drive per quarter hour; the Storage page may ask often, and the answer rarely changes.
const PROBE_CACHE_MS = 15 * 60 * 1000;
/** The longest a drive report waits for one drive's timed write. */
export const PROBE_LIMIT_MS = 1000;
type ProbeResult = 'fast' | 'slow' | null;
const probes = new Map<string, { at: number; result: Promise<ProbeResult>; running: boolean }>();
/**
 * A drive's timed write, at most one in flight per drive, and never waited on past `limitMs`. A write or sync can't be
 * cancelled, so a stalled drive (a ZFS pool hung on a failing disk) reads as unidentified while its write is still
 * running; no second write starts behind it, and once it returns, its file is removed and the next report tries again.
 */
export function boundedProbe(
  key: string,
  path: string,
  probe: (path: string) => Promise<ProbeResult> = timedWrite,
  limitMs = PROBE_LIMIT_MS,
): Promise<ProbeResult> {
  const hit = probes.get(key);
  if (hit && (hit.running || Date.now() - hit.at < PROBE_CACHE_MS)) return hit.result;
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const entry = { at: Date.now(), running: true, result: Promise.resolve<ProbeResult>(null) };
  const run = probe(path)
    .catch(() => null)
    .then((result) => {
      clearTimeout(timer);
      entry.running = false;
      // Kept only when it came in time and says something: a full drive or a passing I/O error is tried again next time.
      if ((late || result === null) && probes.get(key) === entry) probes.delete(key);
      return result;
    });
  entry.result = Promise.race([
    run,
    new Promise<ProbeResult>((done) => {
      timer = setTimeout(() => ((late = true), done(null)), limitMs);
    }),
  ]);
  probes.set(key, entry);
  return entry.result;
}

/** Every drive Manager can use, from the host's mount table (`/run/frameleaf-host/mountinfo`). */
export async function findDrives(sources: DriveSources): Promise<Drive[]> {
  const mountinfo = sources.mountinfo ?? (await readFile('/run/frameleaf-host/mountinfo', 'utf8').catch(() => ''));
  const mounts = driveMounts(filesystemMounts(mountinfo), sources);
  const space = sources.space ?? hostSpace;
  return Promise.all(
    mounts.map(async (drive) => {
      const { name, base, array } = driveName(drive.hostPath, drive.path, sources.platform);
      const [type, room] = await Promise.all([
        classify(drive, {
          platform: sources.platform,
          sys: sources.sys,
          probe: sources.probe ?? ((path) => boundedProbe(`${drive.key}@${path}`, path)),
        }),
        space(drive.path),
      ]);
      return {
        path: drive.path,
        hostPath: drive.hostPath,
        name,
        label: driveLabel(name, type.kind, array),
        ...type,
        filesystem: drive.mount.type,
        freeBytes: room?.freeBytes ?? null,
        totalBytes: room?.totalBytes ?? null,
        base,
      };
    }),
  );
}

export type SuggestionKind = 'database' | 'thumbs';
const GB = 1024 ** 3;
// ponytail: fixed sizes for a library that doesn't exist yet. An import or an installed library passes its real sizes.
export const NEW_LIBRARY_BYTES: Record<SuggestionKind, number> = { database: 20 * GB, thumbs: 50 * GB };
export const ROOM_TO_GROW = 1.5;
const SUGGESTION_COPY: Record<SuggestionKind, { subject: string; folder: string; why: string }> = {
  database: {
    subject: 'the database needs',
    folder: 'frameleaf-databases',
    why: 'Browsing and search read it constantly, so an SSD or NVMe drive makes them noticeably faster.',
  },
  thumbs: {
    subject: 'thumbnails need',
    folder: 'frameleaf-thumbnails',
    why: 'The timeline loads hundreds of small images at once, so large libraries scroll faster from an SSD or NVMe drive.',
  },
};
export const gigabytes = (bytes: number) => {
  const gb = Math.floor(bytes / GB);
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${gb} GB`;
};

export type Suggestion =
  | { status: 'found'; drive: Drive; needBytes: number; title: string; reason: string; folder: string }
  | { status: 'too_full'; drive: Drive; needBytes: number; reason: string }
  | { status: 'none'; needBytes: number; reason: string };
/** Space already promised on a drive, such as the database when choosing where thumbnails go. */
export type Promised = { path: string; bytes: number };

/**
 * The fast drive to suggest for the database or thumbnails, and why. A drive has to hold 1.5 times what's needed after
 * anything already promised to it. NVMe first, then the most free space. A drive Manager couldn't identify, or whose
 * free space it couldn't read, is never suggested.
 */
export function suggestDrive(
  kind: SuggestionKind,
  drives: Drive[],
  { needBytes = NEW_LIBRARY_BYTES[kind], keep }: { needBytes?: number; keep?: Promised } = {},
): Suggestion {
  const copy = SUGGESTION_COPY[kind];
  const fast = drives
    .filter((drive): drive is Drive & { freeBytes: number } => drive.speed === 'fast' && drive.freeBytes !== null)
    .sort((a, b) => Number(b.kind === 'nvme') - Number(a.kind === 'nvme') || b.freeBytes - a.freeBytes);
  // resolve() folds /mnt//cache/ into /mnt/cache, so a promise always lands on its drive.
  const promised = (drive: Drive) => !!keep && within(resolve(keep.path), drive.path);
  const spare = (drive: Drive & { freeBytes: number }) => drive.freeBytes - (promised(drive) ? keep!.bytes : 0);
  const drive = fast.find((item) => spare(item) >= Math.ceil(needBytes * ROOM_TO_GROW));
  if (drive)
    return {
      status: 'found',
      drive,
      needBytes,
      title: `Suggested: ${drive.label}`,
      reason: `It has ${gigabytes(spare(drive))} free${promised(drive) ? ' after the database' : ''}, and ${copy.subject} about ${gigabytes(needBytes)}. ${copy.why}`,
      folder: `${drive.base}/${copy.folder}`,
    };
  if (fast.length)
    return {
      status: 'too_full',
      drive: fast[0],
      needBytes,
      reason: `${fast[0].label} has ${gigabytes(Math.max(0, spare(fast[0])))} free, but ${copy.subject} about ${gigabytes(needBytes)} and room to grow, so Manager isn’t suggesting it.`,
    };
  return { status: 'none', needBytes, reason: 'Manager didn’t find an SSD or NVMe drive on this server. Hard drives work, just more slowly.' };
}

export type DriveReport = { drives: Drive[]; database: Suggestion; thumbs: Suggestion };
/**
 * Suggestions for both folders at once. Thumbnails count the database's space as taken on the drive it is going to:
 * `databasePath` when one is chosen, otherwise the drive suggested for it.
 */
export function suggestFolders(
  drives: Drive[],
  { databaseBytes, thumbsBytes, databasePath }: { databaseBytes?: number; thumbsBytes?: number; databasePath?: string } = {},
): DriveReport {
  const database = suggestDrive('database', drives, { needBytes: databaseBytes });
  const target = databasePath ?? (database.status === 'found' ? database.drive.path : undefined);
  const keep = target ? { path: target, bytes: databaseBytes ?? NEW_LIBRARY_BYTES.database } : undefined;
  return { drives, database, thumbs: suggestDrive('thumbs', drives, { needBytes: thumbsBytes, keep }) };
}

/** The drive a folder is on: the one whose path holds it most closely. Undefined when Manager doesn't know it. */
export const driveOf = (path: string, drives: Drive[]): Drive | undefined =>
  drives.filter((drive) => within(resolve(path), drive.path)).sort((a, b) => b.path.length - a.path.length)[0];

export type DatabaseDriveFinding = {
  /** The label of the database's drive, for "Cache pool (NVMe SSD) · 180 GB free". */
  drive: string | null;
  /** FL-1321: the database is on hard drives while a faster drive with room was found, and the one-press fix. */
  warning?: { suggestion: string; suggestedDrive: string; suggestedName: string; reason: string };
};
/**
 * What the server check says about the database's drive. A warning only when the database is on a drive Manager
 * knows is slow and a faster one with room was found; a drive it couldn't identify never warns.
 */
export function databaseDriveFinding(path: string, report: DriveReport): DatabaseDriveFinding {
  const drive = driveOf(path, report.drives);
  const suggestion = report.database;
  if (drive?.speed !== 'slow' || suggestion.status !== 'found' || suggestion.drive.path === drive.path)
    return { drive: drive?.label ?? null };
  return {
    drive: drive.label,
    warning: { suggestion: suggestion.folder, suggestedDrive: suggestion.drive.label, suggestedName: suggestion.drive.name, reason: suggestion.reason },
  };
}
