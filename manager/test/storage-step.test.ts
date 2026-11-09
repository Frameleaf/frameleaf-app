// FL-1321 Storage step: the database's drive in the server check, and thumbnails chosen on a faster drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations, ReviewInput } from '../src/operations.js';
import { Store } from '../src/store.js';
import type { Installation } from '../src/contracts.js';
import { databaseDriveFinding, driveOf, suggestFolders, type Drive, type DriveReport } from '../src/drives.js';
import { newLibraryFolders, onNetworkShare } from '../src/folders.js';
import type { Docker } from '../src/docker.js';
import type { Releases, VerifiedRelease } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';

const GB = 1024 ** 3;
const drive = (path: string, speed: Drive['speed'], free: number, extra: Partial<Drive> = {}): Drive => ({
  path,
  hostPath: path,
  name: path.split('/').pop()!,
  label: path.split('/').pop()!,
  kind: speed === 'fast' ? 'nvme' : speed === 'slow' ? 'hdd' : 'unknown',
  speed,
  evidence: 'device',
  filesystem: 'xfs',
  freeBytes: free * GB,
  totalBytes: 4000 * GB,
  base: path,
  ...extra,
});

async function fixture(report?: (root: string) => DriveReport) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-storage-step-')));
  // Folders are chosen in Manager under this broad folder, as /mnt is on Unraid.
  process.env.MANAGER_FOLDER_ROOT = root;
  const [array, fast] = [join(root, 'array'), join(root, 'fast')];
  await mkdir(array);
  await mkdir(fast);
  const store = new Store(join(root, 'state'));
  const release = {
    directory: join(root, 'release'),
    nas: { tag: 'frameleaf-v1.2.13', platforms: ['linux/amd64'], images: {} },
  } as unknown as VerifiedRelease;
  const docker = {
    compatibility: async () => ({ platform: 'linux/amd64', version: '27.5.1', compose: '2.29.0', dataRoot: '/var/lib/docker', memory: null, processors: null }),
    inventory: async () => [],
    pull: async () => undefined,
  } as unknown as Docker;
  const releases = {
    acquire: async () => {
      await mkdir(release.directory, { recursive: true });
      return release;
    },
    eligible: async () => ({}),
    verify: async () => release,
  } as unknown as Releases;
  const storage = {
    validate: async (path: string) => ({ root: path }),
    allocate: async (path: string) => join(path, 'postgres'),
  } as unknown as PostgresStorage;
  const backups = { relocate: async () => undefined } as unknown as Backups;
  const operations = new Operations(store, docker, releases, backups, [root], storage);
  if (report) operations.driveReport = async () => report(root);
  const input = ReviewInput.parse({
    kind: 'install',
    tag: release.nas.tag,
    mediaPath: join(array, 'frameleaf-photos'),
    databaseRoot: join(array, 'appdata', 'frameleaf-databases'),
    backupPath: join(array, 'appdata', 'frameleaf-backups'),
    port: 2283,
    ml: false,
    lifecycle: 'docker-only',
  });
  return {
    root,
    array,
    fast,
    operations,
    input,
    cleanup: async () => {
      delete process.env.MANAGER_FOLDER_ROOT;
      await rm(root, { recursive: true, force: true });
    },
  };
}
const fastReport = (root: string) => suggestFolders([drive(join(root, 'array'), 'slow', 2150), drive(join(root, 'fast'), 'fast', 180)]);

test('a database on hard drives is worth knowing only when a faster drive with room is there', async () => {
  const f = await fixture(fastReport);
  try {
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true, 'a warning never blocks the install');
    const database = result.checks.find((check) => check.id === 'database')!;
    assert.equal(database.status, 'warning');
    assert.equal(database.code, 'database_on_hard_drives');
    assert.equal(database.facts?.drive, 'array');
    assert.equal(database.facts?.suggestion, join(f.fast, 'frameleaf-databases'));
    assert.equal(database.facts?.suggestedName, 'fast');
    assert.match(String(database.facts?.reason), /^It has 180 GB free, and the database needs about 20 GB\./);
    // Fixed: the suggested folder is on the fast drive, and the check is fine.
    const fixed = await f.operations.review({ ...f.input, databaseRoot: join(f.fast, 'frameleaf-databases') });
    const ok = fixed.checks.find((check) => check.id === 'database')!;
    assert.equal(ok.status, 'ok');
    assert.equal(ok.facts?.drive, 'fast');
  } finally {
    await f.cleanup();
  }
});

test('no faster drive, a full one, or no drive report: the database on hard drives is simply fine', async () => {
  for (const report of [
    (root: string) => suggestFolders([drive(join(root, 'array'), 'slow', 2150)]),
    (root: string) => suggestFolders([drive(join(root, 'array'), 'slow', 2150), drive(join(root, 'fast'), 'fast', 14)]),
    undefined,
  ]) {
    const f = await fixture(report);
    try {
      const result = await f.operations.review(f.input);
      assert.equal(result.checks.find((check) => check.id === 'database')?.status, 'ok');
    } finally {
      await f.cleanup();
    }
  }
});

test('thumbnails: with the photos by default, or a folder of their own the review creates and checks', async () => {
  const f = await fixture(fastReport);
  try {
    const plain = await f.operations.review(f.input);
    assert.deepEqual(plain.checks.map((check) => check.id), ['docker', 'media', 'database', 'thumbnails', 'backups', 'manager', 'port', 'release']);
    assert.deepEqual(plain.checks.find((check) => check.id === 'thumbnails')?.facts, { withPhotos: true });

    const thumbnailsPath = join(f.fast, 'frameleaf-thumbnails');
    const result = await f.operations.review({ ...f.input, databaseRoot: join(f.fast, 'frameleaf-databases'), thumbnailsPath });
    const thumbnails = result.checks.find((check) => check.id === 'thumbnails')!;
    assert.equal(thumbnails.status, 'ok');
    assert.equal(thumbnails.facts?.path, thumbnailsPath);
    assert.equal(thumbnails.facts?.drive, 'fast');
    assert.deepEqual(await readdir(thumbnailsPath), [], 'created empty');
  } finally {
    await f.cleanup();
  }
});

test('a thumbnails folder inside the photos, the database, backups or Manager’s own folder is refused', async () => {
  const f = await fixture(fastReport);
  try {
    for (const thumbnailsPath of [
      join(f.input.mediaPath!, 'thumbs'),
      join(f.input.databaseRoot, 'thumbs'),
      join(f.input.backupPath!, 'thumbs'),
      join(f.root, 'state', 'thumbs'),
    ]) {
      const result = await f.operations.review({ ...f.input, thumbnailsPath });
      assert.equal(result.ready, false, thumbnailsPath);
      const thumbnails = result.checks.find((check) => check.id === 'thumbnails')!;
      assert.equal(thumbnails.status, 'problem');
      assert.equal(thumbnails.code, 'chosen_folders_overlap');
    }
  } finally {
    await f.cleanup();
  }
});

test('an import never takes a thumbnails folder from setup', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.operations.review({ ...f.input, kind: 'import', sourceId: 'a'.repeat(64), thumbnailsPath: join(f.fast, 'thumbs') }),
      /thumbnail_folder_unavailable/,
    );
  } finally {
    await f.cleanup();
  }
});

test('the installed library keeps thumbnails as its second mount', async () => {
  const f = await fixture(fastReport);
  try {
    const thumbnailsPath = join(f.fast, 'frameleaf-thumbnails');
    const result = await f.operations.review({ ...f.input, databaseRoot: join(f.fast, 'frameleaf-databases'), thumbnailsPath });
    assert.equal(result.ready, true);
    if (!result.ready) return;
    const operation = f.operations.start(result.id, randomUUID());
    let installation: Installation | undefined;
    for (let i = 0; i < 300 && !installation && f.operations.store.history().find((o) => o.id === operation.id)?.state === 'running'; i++) {
      installation = (operation.receipts['configuration-intent'] as { installation: Installation } | undefined)?.installation;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    installation ??= (f.operations.store.history().find((o) => o.id === operation.id)?.receipts['configuration-intent'] as { installation: Installation } | undefined)
      ?.installation;
    assert.ok(installation, 'the configuration was recorded');
    assert.deepEqual(installation.mounts, [
      { type: 'bind', source: f.input.mediaPath, target: '/data', readOnly: false },
      { type: 'bind', source: thumbnailsPath, target: '/data/thumbs', readOnly: false },
    ]);
    for (let i = 0; i < 300 && f.operations.store.history().find((o) => o.id === operation.id)?.state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await readdir(thumbnailsPath)).includes('.frameleaf'), 'the chosen folder carries the server’s folder marker');
  } finally {
    await f.cleanup();
  }
});

test('the drive under a folder, and the finding for the database', () => {
  const drives = [drive('/mnt/user', 'slow', 2150, { label: 'Hard drive array' }), drive('/mnt/cache', 'fast', 180, { label: 'Cache pool (NVMe SSD)', name: 'Cache pool', base: '/mnt/cache/appdata' }), drive('/mnt/disks/vm', 'unknown', 90)];
  assert.equal(driveOf('/mnt/cache/appdata/x', drives)?.path, '/mnt/cache');
  assert.equal(driveOf('/mnt/cache2/x', drives), undefined, 'not a prefix of another drive');
  const report = suggestFolders(drives);
  assert.deepEqual(databaseDriveFinding('/mnt/user/appdata/frameleaf-databases', report), {
    drive: 'Hard drive array',
    warning: {
      suggestion: '/mnt/cache/appdata/frameleaf-databases',
      suggestedDrive: 'Cache pool (NVMe SSD)',
      suggestedName: 'Cache pool',
      reason: (report.database as { reason: string }).reason,
    },
  });
  assert.deepEqual(databaseDriveFinding('/mnt/cache/appdata/frameleaf-databases', report), { drive: 'Cache pool (NVMe SSD)' });
  assert.deepEqual(databaseDriveFinding('/mnt/disks/vm/db', report), { drive: 'vm' }, 'a drive Manager could not identify never warns');
  assert.deepEqual(databaseDriveFinding('/somewhere/else', report), { drive: null });
});

test('network shares are refused for thumbnails', () => {
  const mountinfo = [
    '36 25 0:32 / /mnt/tank rw,relatime shared:1 - zfs tank rw',
    '37 25 0:45 / /mnt/nas rw,relatime shared:2 - nfs4 nas:/export rw',
    '38 25 0:46 / /mnt/smb rw,relatime shared:3 - cifs //nas/photos rw',
  ].join('\n');
  assert.equal(onNetworkShare('/mnt/tank/thumbs', mountinfo), false);
  assert.equal(onNetworkShare('/mnt/nas/thumbs', mountinfo), true);
  assert.equal(onNetworkShare('/mnt/smb/a/b', mountinfo), true);
  const platform = process.env.MANAGER_PLATFORM;
  process.env.MANAGER_PLATFORM = 'unraid';
  try {
    assert.equal(onNetworkShare('/mnt/remotes/nas_photos/thumbs', ''), true);
  } finally {
    if (platform === undefined) delete process.env.MANAGER_PLATFORM;
    else process.env.MANAGER_PLATFORM = platform;
  }
});

test('new Unraid libraries keep photos on the array; other hosts and installed libraries are unchanged', () => {
  assert.deepEqual(newLibraryFolders('/mnt/user/appdata', 'unraid'), {
    media: '/mnt/user/frameleaf-photos',
    database: '/mnt/user/appdata/frameleaf-databases',
    fastDatabase: true,
  });
  assert.deepEqual(newLibraryFolders('/srv/frameleaf', 'linux'), {
    media: '/srv/frameleaf/frameleaf-media',
    database: '/srv/frameleaf/frameleaf-databases',
    fastDatabase: false,
  });
});
