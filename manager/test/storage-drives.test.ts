import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Stats, StatsFs } from 'node:fs';
import type { Mount } from '../src/contracts.js';
import { isLowOnSpace, readStorage, storagePlaces } from '../src/storage-drives.js';
import { driveChecks } from '../src/troubleshooting.js';

const GB = 1e9;
const library: Mount = { type: 'bind', source: '/mnt/photos/frameleaf', target: '/data', readOnly: false };
const thumbs: Mount = { type: 'bind', source: '/mnt/ssd/thumbs', target: '/data/thumbs', readOnly: false };

/** A fake server: each folder sits on a drive (device id) with this much room left of 1 TB. */
function server(drives: Record<string, { device: number; availableGb: number }>) {
  const drive = (path: string) => {
    const found = Object.entries(drives).find(([folder]) => path === folder || path.startsWith(`${folder}/`))?.[1];
    if (!found) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return found;
  };
  return {
    realpath: (async (path: string) => (drive(path), path)) as never,
    stat: (async (path: string) => ({ dev: drive(path).device }) as Stats) as never,
    statfs: (async (path: string) => {
      const { availableGb } = drive(path);
      return { bsize: 1000, blocks: 1e9, bavail: availableGb * 1e6, bfree: availableGb * 1e6 } as StatsFs;
    }) as never,
  };
}

test('a library on one drive: thumbnails are not listed apart, and every place shares one check', async () => {
  const places = storagePlaces(
    { mounts: [library], databaseRoot: '/mnt/photos/databases' },
    { media: ['/mnt/photos/frameleaf'], backups: '/mnt/photos/backups' },
  );
  assert.deepEqual(
    places.map((place) => [place.name, place.use]),
    [
      ['Storage 1', 'media'],
      ['Database drive', 'database'],
      ['Backup drive', 'backups'],
    ],
  );

  const fs = server({ '/mnt/photos': { device: 1, availableGb: 10 } });
  const checks = await driveChecks(places, fs);
  assert.deepEqual(checks, [
    {
      name: 'Storage 1',
      ok: false,
      detail: '10.0 GB free (1%). Nearly full: make room on this drive. Also holds the database and the backups',
    },
  ]);

  const storage = await readStorage(places, fs);
  assert.deepEqual(
    storage.map(({ path, uses, device, lowOnSpace }) => ({ path, uses, device, lowOnSpace })),
    [
      { path: '/mnt/photos/frameleaf', uses: ['media'], device: '1', lowOnSpace: true },
      { path: '/mnt/photos/databases', uses: ['database'], device: '1', lowOnSpace: true },
      { path: '/mnt/photos/backups', uses: ['backups'], device: '1', lowOnSpace: true },
    ],
  );
});

test('thumbnails and the database on drives of their own each get their own named check', async () => {
  const places = storagePlaces(
    { mounts: [library, thumbs], databaseRoot: '/mnt/nvme/databases' },
    // With a broad folder mapped, the media places are every bind source, the thumbnail folder included.
    { media: ['/mnt/photos/frameleaf', '/mnt/ssd/thumbs'], backups: '/mnt/photos/backups' },
  );
  assert.deepEqual(
    places.map((place) => [place.name, place.path, place.use]),
    [
      ['Storage 1', '/mnt/photos/frameleaf', 'media'],
      ['Thumbnails drive', '/mnt/ssd/thumbs', 'thumbnails'],
      ['Database drive', '/mnt/nvme/databases', 'database'],
      ['Backup drive', '/mnt/photos/backups', 'backups'],
    ],
  );

  const fs = server({
    '/mnt/photos': { device: 1, availableGb: 600 },
    '/mnt/ssd': { device: 2, availableGb: 1.5 },
    '/mnt/nvme': { device: 3, availableGb: 300 },
  });
  assert.deepEqual(await driveChecks(places, fs), [
    { name: 'Storage 1', ok: true, detail: '600.0 GB free (60%). Also holds the backups' },
    { name: 'Thumbnails drive', ok: false, detail: '1.5 GB free (0%). Nearly full: make room on this drive' },
    { name: 'Database drive', ok: true, detail: '300.0 GB free (30%)' },
  ]);

  const storage = await readStorage(places, fs);
  assert.deepEqual(
    storage.map(({ uses, device, availableBytes, lowOnSpace }) => ({ uses, device, availableBytes, lowOnSpace })),
    [
      { uses: ['media'], device: '1', availableBytes: 600 * GB, lowOnSpace: false },
      { uses: ['thumbnails'], device: '2', availableBytes: 1.5 * GB, lowOnSpace: true },
      { uses: ['database'], device: '3', availableBytes: 300 * GB, lowOnSpace: false },
      { uses: ['backups'], device: '1', availableBytes: 600 * GB, lowOnSpace: false },
    ],
  );
});

test('a folder that cannot be read is unknown on the Storage page, and a problem in troubleshooting', async () => {
  const places = storagePlaces(null, { media: ['/mnt/gone'], backups: '/mnt/photos/backups', databaseRoots: ['/mnt/photos/db'] });
  const fs = server({ '/mnt/photos': { device: 1, availableGb: 600 } });
  const [gone] = await readStorage(places, fs);
  assert.deepEqual(gone, {
    path: '/mnt/gone',
    uses: ['media'],
    device: null,
    totalBytes: null,
    availableBytes: null,
    freeBytes: null,
    lowOnSpace: null,
  });
  const checks = await driveChecks(places, fs);
  assert.deepEqual(checks[0], { name: 'Storage 1', ok: false, detail: 'Manager cannot read this mounted drive.' });
  assert.equal(checks.length, 2);
});

test('a folder used for two things is read once, with both uses', async () => {
  const storage = await readStorage(
    [
      { name: 'Storage 1', path: '/mnt/photos', use: 'media' },
      { name: 'Backup drive', path: '/mnt/photos', use: 'backups' },
    ],
    server({ '/mnt/photos': { device: 1, availableGb: 600 } }),
  );
  assert.deepEqual(storage.map((entry) => entry.uses), [['media', 'backups']]);
});

test('low on space means under 5% or 2 GB left, the rule troubleshooting has always used', () => {
  assert.equal(isLowOnSpace(100 * GB, 1000 * GB), false);
  assert.equal(isLowOnSpace(40 * GB, 1000 * GB), true);
  assert.equal(isLowOnSpace(2 * GB, 20 * GB), true);
  assert.equal(isLowOnSpace(3 * GB, 20 * GB), false);
});
