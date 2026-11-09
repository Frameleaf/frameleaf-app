import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blockDevice,
  boundedProbe,
  driveMounts,
  findDrives,
  NEW_LIBRARY_BYTES,
  suggestDrive,
  suggestFolders,
  timedWrite,
  type Drive,
  type Sysfs,
} from '../src/drives.js';
import { filesystemMounts } from '../src/postgres-storage.js';

const GB = 1024 ** 3;

// The host's /proc/1/mountinfo on Unraid: array disks, the user share, an NVMe btrfs cache, a SATA SSD pool, a ZFS
// pool with a dataset, an Unassigned Devices hard drive, a read-only drive, a network share and docker.img.
const UNRAID = `
22 1 0:20 / / rw,relatime - rootfs rootfs rw
30 22 0:25 / /mnt rw,relatime shared:5 - tmpfs tmpfs rw,size=1024k
40 30 9:1 / /mnt/disk1 rw,noatime shared:10 - xfs /dev/md1p1 rw
41 30 9:2 / /mnt/disk2 rw,noatime shared:11 - xfs /dev/md2p1 rw
42 30 0:45 / /mnt/cache rw,noatime shared:12 - btrfs /dev/nvme0n1p1 rw,ssd,space_cache=v2
43 30 8:17 / /mnt/fast\\040ssd rw,noatime shared:13 - xfs /dev/sdb1 rw
44 30 0:60 / /mnt/tank rw,noatime shared:14 - zfs tank rw,xattr
45 44 0:61 / /mnt/tank/appdata rw,noatime shared:15 - zfs tank/appdata rw,xattr
46 30 0:50 / /mnt/user rw,noatime shared:16 - fuse.shfs shfs rw,user_id=0
47 30 0:51 / /mnt/user0 rw,noatime shared:17 - fuse.shfs shfs rw,user_id=0
48 30 8:33 / /mnt/disks/UD01 rw,noatime shared:18 - xfs /dev/sdc1 rw
49 30 8:49 / /mnt/disks/RO ro,noatime shared:19 - ext4 /dev/sdd1 ro
50 30 0:70 / /mnt/remotes/nas_photos rw,relatime shared:20 - cifs //nas/photos rw
51 22 7:2 / /var/lib/docker rw,noatime shared:21 - btrfs /dev/loop2 rw
52 30 0:45 /appdata /mnt/cache-appdata rw,noatime shared:22 - btrfs /dev/nvme0n1p1 rw
`;

// /sys as the kernel lays it out: /sys/dev/block/<major:minor> and /sys/class/block/<name> link to the device, and a
// partition sits in its disk's folder with a `partition` file and no queue of its own.
function sysfs(files: Record<string, string>, links: Record<string, string>, folders: Record<string, string[]> = {}): Sysfs {
  return {
    read: async (path) => files[path] ?? null,
    real: async (path) => links[path] ?? null,
    list: async (path) => folders[path] ?? [],
  };
}
const UNRAID_SYS = sysfs(
  {
    '/sys/devices/pci0/nvme/nvme0/nvme0n1/nvme0n1p1/partition': '1',
    '/sys/devices/pci0/nvme/nvme0/nvme0n1/queue/rotational': '0',
    '/sys/devices/pci0/ata2/block/sdb/sdb1/partition': '1',
    '/sys/devices/pci0/ata2/block/sdb/queue/rotational': '0',
    '/sys/devices/pci0/ata3/block/sdc/sdc1/partition': '1',
    '/sys/devices/pci0/ata3/block/sdc/queue/rotational': '1',
    '/sys/devices/pci0/ata3/block/sdc/device/vendor': 'ATA',
    '/sys/devices/pci0/ata3/block/sdc/device/model': 'WDC WD80EFAX',
  },
  {
    '/sys/class/block/nvme0n1p1': '/sys/devices/pci0/nvme/nvme0/nvme0n1/nvme0n1p1',
    '/sys/dev/block/8:17': '/sys/devices/pci0/ata2/block/sdb/sdb1',
    '/sys/dev/block/8:33': '/sys/devices/pci0/ata3/block/sdc/sdc1',
  },
);

const space = (free: Record<string, number>) => async (path: string) =>
  path in free ? { freeBytes: free[path] * GB, totalBytes: 4000 * GB } : null;

test('mountinfo lines are read with escaped paths, devices and options', () => {
  const [mount] = filesystemMounts('43 30 8:17 / /mnt/fast\\040ssd rw,noatime shared:13 - xfs /dev/sdb1 rw');
  assert.deepEqual(mount, { target: '/mnt/fast ssd', root: '/', device: '8:17', options: ['rw', 'noatime'], type: 'xfs', source: '/dev/sdb1' });
});

test('only writable disk mounts under Manager’s folders count, one per drive', () => {
  const found = driveMounts(filesystemMounts(UNRAID), { roots: ['/mnt'], dockerRoot: '/var/lib/docker', platform: 'unraid' });
  assert.deepEqual(
    found.map((d) => d.path),
    // No /mnt itself, user0, read-only drive, network share or docker.img. The ZFS dataset folds into its pool,
    // and a second mount of the cache's subvolume folds into the cache.
    ['/mnt/cache', '/mnt/disk1', '/mnt/disk2', '/mnt/disks/UD01', '/mnt/fast ssd', '/mnt/tank', '/mnt/user'],
  );
  // A folder outside the roots is not Manager's to use.
  assert.deepEqual(
    driveMounts(filesystemMounts(UNRAID), { roots: ['/mnt/disks'], platform: 'unraid' }).map((d) => d.path),
    ['/mnt/disks/UD01'],
  );
});

test('sysfs: a partition is judged by its disk, and an anonymous btrfs device by its source', async () => {
  const [, , , , cache, ssd, , , , , drive] = filesystemMounts(UNRAID);
  assert.deepEqual(await blockDevice(cache, UNRAID_SYS), { name: 'nvme0n1', rotational: false, nvme: true, virtual: false });
  assert.deepEqual(await blockDevice(ssd, UNRAID_SYS), { name: 'sdb', rotational: false, nvme: false, virtual: false });
  assert.deepEqual(await blockDevice(drive, UNRAID_SYS), { name: 'sdc', rotational: true, nvme: false, virtual: false });
  // A whole disk with no partition, a virtual disk, and an encrypted device on NVMe.
  const sys = sysfs(
    {
      '/sys/devices/virtio1/block/vda/queue/rotational': '1',
      '/sys/devices/virtual/block/dm-0/queue/rotational': '0',
      '/sys/devices/pci0/ata1/block/sda/queue/rotational': '1',
      '/sys/devices/pci0/ata1/block/sda/device/vendor': 'QEMU',
    },
    {
      '/sys/dev/block/253:0': '/sys/devices/virtio1/block/vda',
      '/sys/dev/block/254:0': '/sys/devices/virtual/block/dm-0',
      '/sys/dev/block/8:0': '/sys/devices/pci0/ata1/block/sda',
    },
    { '/sys/devices/virtual/block/dm-0/slaves': ['nvme1n1p1'] },
  );
  const at = (device: string) => filesystemMounts(`1 1 ${device} / /mnt/x rw - ext4 /dev/x rw`)[0];
  assert.deepEqual(await blockDevice(at('253:0'), sys), { name: 'vda', rotational: true, nvme: false, virtual: true });
  assert.deepEqual(await blockDevice(at('254:0'), sys), { name: 'dm-0', rotational: false, nvme: true, virtual: false });
  assert.equal((await blockDevice(at('8:0'), sys))?.virtual, true);
  // LVM or LUKS on a virtio disk, and on a QEMU SCSI disk's partition: still virtual, so it gets a timed write.
  const layered = sysfs(
    {
      '/sys/devices/virtual/block/dm-1/queue/rotational': '1',
      '/sys/devices/virtual/block/dm-2/queue/rotational': '1',
      '/sys/devices/pci0/scsi/block/sdb/sdb2/partition': '2',
      '/sys/devices/pci0/scsi/block/sdb/device/vendor': 'QEMU',
    },
    {
      '/sys/dev/block/254:1': '/sys/devices/virtual/block/dm-1',
      '/sys/dev/block/254:2': '/sys/devices/virtual/block/dm-2',
      '/sys/devices/virtual/block/dm-1/slaves/vda2': '/sys/devices/virtio1/block/vda/vda2',
      '/sys/devices/virtual/block/dm-2/slaves/sdb2': '/sys/devices/pci0/scsi/block/sdb/sdb2',
    },
    { '/sys/devices/virtual/block/dm-1/slaves': ['vda2'], '/sys/devices/virtual/block/dm-2/slaves': ['sdb2'] },
  );
  assert.deepEqual(await blockDevice(at('254:1'), layered), { name: 'dm-1', rotational: true, nvme: false, virtual: true });
  assert.equal((await blockDevice(at('254:2'), layered))?.virtual, true);
  assert.equal((await blockDevice(at('254:0'), sys))?.virtual, false);
  assert.equal(await blockDevice(at('8:99'), sys), null);
});

test('Unraid: the array is slow from its path and never written to; pools are read from sysfs; ZFS gets a timed write', async () => {
  const probed: string[] = [];
  const drives = await findDrives({
    roots: ['/mnt'],
    platform: 'unraid',
    dockerRoot: '/var/lib/docker',
    mountinfo: UNRAID,
    sys: UNRAID_SYS,
    probe: async (path) => (probed.push(path), 'fast'),
    space: space({ '/mnt/cache': 180, '/mnt/fast ssd': 420, '/mnt/tank': 900, '/mnt/user': 2150, '/mnt/disk1': 1000, '/mnt/disk2': 1150, '/mnt/disks/UD01': 640 }),
  });
  assert.deepEqual(probed, ['/mnt/tank']);
  const view = Object.fromEntries(drives.map((d) => [d.path, [d.label, d.kind, d.speed, d.evidence, d.base]]));
  assert.deepEqual(view, {
    '/mnt/cache': ['Cache pool (NVMe SSD)', 'nvme', 'fast', 'device', '/mnt/cache/appdata'],
    '/mnt/disk1': ['Disk 1 (array)', 'hdd', 'slow', 'path', '/mnt/disk1'],
    '/mnt/disk2': ['Disk 2 (array)', 'hdd', 'slow', 'path', '/mnt/disk2'],
    '/mnt/disks/UD01': ['UD01 (hard drive)', 'hdd', 'slow', 'device', '/mnt/disks/UD01'],
    '/mnt/fast ssd': ['Fast ssd pool (SSD)', 'ssd', 'fast', 'device', '/mnt/fast ssd/appdata'],
    '/mnt/tank': ['Tank pool (SSD)', 'ssd', 'fast', 'timed-write', '/mnt/tank/appdata'],
    '/mnt/user': ['Hard drive array', 'hdd', 'slow', 'path', '/mnt/user'],
  });
  const { database, thumbs } = suggestFolders(drives);
  assert.equal(database.status, 'found');
  assert.equal(database.status === 'found' && database.folder, '/mnt/cache/appdata/frameleaf-databases');
  // 180 GB less the database's 20 GB still holds 75 GB of thumbnails, and NVMe comes first.
  assert.equal(thumbs.status === 'found' && thumbs.drive.path, '/mnt/cache');
  assert.equal(
    thumbs.status === 'found' && thumbs.reason,
    'It has 160 GB free after the database, and thumbnails need about 50 GB. The timeline loads hundreds of small images at once, so large libraries scroll faster from an SSD or NVMe drive.',
  );
});

test('TrueNAS: ZFS pools are timed, the boot pool and hidden app storage are skipped', async () => {
  const mountinfo = `
1 0 0:21 / / rw - zfs boot-pool/ROOT/25.04 rw
2 1 0:22 / /mnt rw - tmpfs tmpfs rw
3 2 0:30 / /mnt/ssd rw - zfs ssd rw
4 2 0:31 / /mnt/tank rw - zfs tank rw
5 4 0:32 / /mnt/tank/photos rw - zfs tank/photos rw
6 2 0:33 / /mnt/.ix-apps rw - zfs ssd/ix-apps rw
7 2 0:34 / /mnt/boot rw - zfs boot-pool/data rw
`;
  const drives = await findDrives({
    roots: ['/mnt'],
    platform: 'truenas',
    mountinfo,
    sys: sysfs({}, {}),
    probe: async (path) => (path === '/mnt/ssd' ? 'fast' : 'slow'),
    space: space({ '/mnt/ssd': 420, '/mnt/tank': 2150 }),
  });
  assert.deepEqual(
    drives.map((d) => [d.path, d.label, d.speed]),
    [
      ['/mnt/ssd', 'ssd pool (SSD)', 'fast'],
      ['/mnt/tank', 'tank pool (hard drive)', 'slow'],
    ],
  );
  const { database } = suggestFolders(drives);
  assert.equal(database.status === 'found' && database.folder, '/mnt/ssd/frameleaf-databases');
});

test('plain Docker: the mapped folder is its drive, and a virtual disk claiming to spin is timed', async () => {
  const mountinfo = `
1 0 253:1 / / rw,relatime - ext4 /dev/vda1 rw
2 1 0:40 / /var/lib/docker/overlay2/abc/merged rw - overlay overlay rw
3 1 0:41 / /srv/media rw - nfs4 nas:/media rw
`;
  const sys = sysfs(
    { '/sys/devices/virtio1/block/vda/vda1/partition': '1', '/sys/devices/virtio1/block/vda/queue/rotational': '1' },
    { '/sys/dev/block/253:1': '/sys/devices/virtio1/block/vda/vda1' },
  );
  const drives = await findDrives({
    roots: ['/srv/frameleaf'],
    platform: 'linux',
    dockerRoot: '/var/lib/docker',
    mountinfo,
    sys,
    probe: async () => 'fast',
    space: space({ '/srv/frameleaf': 300 }),
  });
  assert.deepEqual(
    drives.map((d) => [d.path, d.name, d.kind, d.speed, d.evidence]),
    [['/srv/frameleaf', 'frameleaf', 'ssd', 'fast', 'timed-write']],
  );
  // A timed write that can't run leaves the drive unidentified: listed, never suggested.
  const unknown = await findDrives({ roots: ['/srv/frameleaf'], platform: 'linux', mountinfo, sys, probe: async () => null, space: space({ '/srv/frameleaf': 300 }) });
  assert.deepEqual([unknown[0].kind, unknown[0].speed, unknown[0].label], ['unknown', 'unknown', 'frameleaf']);
  assert.equal(suggestDrive('database', unknown).status, 'none');
});

const drive = (path: string, kind: Drive['kind'], freeGb: number | null, speed: Drive['speed'] = kind === 'hdd' ? 'slow' : 'fast'): Drive => ({
  path,
  hostPath: path,
  name: path,
  label: `${path} label`,
  kind,
  speed,
  evidence: 'device',
  filesystem: 'xfs',
  freeBytes: freeGb === null ? null : freeGb * GB,
  totalBytes: null,
  base: path,
});

test('suggestions: NVMe first, then the most free space, with room for 1.5 times the need', () => {
  const nvme = drive('/mnt/cache', 'nvme', 40);
  const ssd = drive('/mnt/ssd', 'ssd', 900);
  const hdd = drive('/mnt/user', 'hdd', 5000);
  assert.equal(NEW_LIBRARY_BYTES.database, 20 * GB);
  assert.equal(NEW_LIBRARY_BYTES.thumbs, 50 * GB);
  // 40 GB holds 1.5 × 20 GB, so the smaller NVMe wins over the bigger SSD.
  const first = suggestDrive('database', [hdd, ssd, nvme]);
  assert.equal(first.status === 'found' && first.drive.path, '/mnt/cache');
  // 50 GB of thumbnails needs 75 GB: the NVMe is passed over for the SSD.
  const thumbs = suggestDrive('thumbs', [hdd, ssd, nvme]);
  assert.equal(thumbs.status === 'found' && thumbs.drive.path, '/mnt/ssd');
  // Exactly 1.5 times is enough; a byte less is not.
  assert.equal(suggestDrive('database', [nvme], { needBytes: (40 * GB) / 1.5 }).status, 'found');
  assert.equal(suggestDrive('database', [nvme], { needBytes: (40 * GB) / 1.5 + 1 }).status, 'too_full');
  // Of two SSDs, the one with more room.
  const larger = suggestDrive('database', [drive('/mnt/a', 'ssd', 100), drive('/mnt/b', 'ssd', 200)]);
  assert.equal(larger.status === 'found' && larger.drive.path, '/mnt/b');
});

test('suggestions: space promised to the database counts against the drive', () => {
  const nvme = drive('/mnt/cache', 'nvme', 100);
  const ssd = drive('/mnt/ssd', 'ssd', 80);
  // 100 GB less a 40 GB database leaves 60 GB, short of 75 GB; the SSD's 80 GB holds it.
  const thumbs = suggestDrive('thumbs', [nvme, ssd], { keep: { path: '/mnt/cache/appdata/frameleaf-databases', bytes: 40 * GB } });
  assert.equal(thumbs.status === 'found' && thumbs.drive.path, '/mnt/ssd');
  const both = suggestFolders([nvme], { databaseBytes: 40 * GB });
  assert.equal(both.database.status, 'found');
  assert.equal(both.thumbs.status, 'too_full');
  assert.equal(
    both.thumbs.reason,
    '/mnt/cache label has 60 GB free, but thumbnails need about 50 GB and room to grow, so Manager isn’t suggesting it.',
  );
  // A chosen database folder written loosely still reserves its space.
  const loose = suggestFolders([nvme], { databaseBytes: 40 * GB, databasePath: '/mnt//cache/appdata/frameleaf-databases/' });
  assert.equal(loose.thumbs.status, 'too_full');
  // A database already chosen elsewhere leaves the NVMe whole.
  const elsewhere = suggestFolders([nvme], { databaseBytes: 40 * GB, databasePath: '/mnt/ssd/frameleaf-databases' });
  assert.equal(elsewhere.thumbs.status === 'found' && elsewhere.thumbs.reason.startsWith('It has 100 GB free, and'), true);
});

test('suggestions: none without a fast drive, and unidentified drives or unknown space never suggested', () => {
  const none = suggestDrive('database', [drive('/mnt/user', 'hdd', 5000), drive('/mnt/x', 'unknown', 900, 'unknown'), drive('/mnt/y', 'ssd', null)]);
  assert.deepEqual(none, {
    status: 'none',
    needBytes: 20 * GB,
    reason: 'Manager didn’t find an SSD or NVMe drive on this server. Hard drives work, just more slowly.',
  });
  const full = suggestDrive('database', [drive('/mnt/cache', 'nvme', 14)]);
  assert.equal(full.status, 'too_full');
  assert.equal(
    full.reason,
    '/mnt/cache label has 14 GB free, but the database needs about 20 GB and room to grow, so Manager isn’t suggesting it.',
  );
  const big = suggestDrive('database', [drive('/mnt/ssd', 'ssd', 4000)]);
  assert.equal(big.status === 'found' && big.reason.startsWith('It has 3.9 TB free, and the database needs about 20 GB.'), true);
});

test('the timed write is quick and leaves nothing behind', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'drives-'));
  try {
    const started = performance.now();
    assert.ok(['fast', 'slow'].includes((await timedWrite(folder))!));
    assert.ok(performance.now() - started < 1000);
    assert.deepEqual(await readdir(folder), []);
    assert.equal(await timedWrite(join(folder, 'missing')), null);
    assert.deepEqual(await readdir(folder), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a write that hangs is not waited on: the drive reads as unidentified, one write per drive, tidied when it returns', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'drives-stall-'));
  try {
    let release!: () => void;
    const stalled = new Promise<void>((done) => (release = done));
    let started = 0;
    let stalledWrite!: Promise<unknown>;
    // A real file whose sync hangs until released, as on a pool stuck behind a failing disk.
    const hanging = (path: string) => {
      started++;
      return (stalledWrite = timedWrite(path, 800, async (file) => {
        const handle = await open(file, 'wx', 0o600);
        return { write: handle.write.bind(handle), datasync: () => stalled.then(() => handle.datasync()), close: () => handle.close() };
      }));
    };
    const before = performance.now();
    assert.equal(await boundedProbe('stall', folder, hanging, 100), null);
    assert.ok(performance.now() - before < 1000);
    // Still stalled: a second report gets the same answer and starts no second write.
    assert.equal(await boundedProbe('stall', folder, hanging, 100), null);
    assert.equal(started, 1);
    assert.equal((await readdir(folder)).length, 1);
    release();
    // Once the stalled write returns, its file is removed and the late result isn't kept: the next report probes again.
    // Waiting on the write itself, and a fake for the fresh probe, keeps this independent of the runner's disk speed.
    await stalledWrite;
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(await readdir(folder), []);
    let fresh = 0;
    assert.equal(await boundedProbe('stall', folder, async () => (fresh++, 'fast' as const)), 'fast');
    assert.equal(fresh, 1);
    // An answer of unidentified (a full drive, a permissions or passing I/O error) isn't kept either.
    let failures = 0;
    const failing = async () => (failures++, null);
    assert.equal(await boundedProbe('failing', folder, failing), null);
    assert.equal(await boundedProbe('failing', folder, failing), null);
    assert.equal(failures, 2);
    // A result in time is kept for later reports.
    let calls = 0;
    const quick = async () => (calls++, 'fast' as const);
    assert.equal(await boundedProbe('quick', folder, quick), 'fast');
    assert.equal(await boundedProbe('quick', folder, quick), 'fast');
    assert.equal(calls, 1);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
