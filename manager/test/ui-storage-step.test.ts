// FL-1321 Storage step wording: drive hints, folder rules and the server check's database and thumbnails rows,
// in the words of the approved prototype (frameleaf-prototype src/manager-setup.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrder, checkRows, type CheckContext } from '../ui/src/server-check.js';
import { driveHint, fastFolderIssue, onSuggested, type Drive, type Suggestion } from '../ui/src/drives.js';

const GB = 1024 ** 3;
const drives: Drive[] = [
  { path: '/mnt/cache', name: 'Cache pool', label: 'Cache pool (NVMe SSD)', kind: 'nvme', speed: 'fast', freeBytes: 180 * GB, base: '/mnt/cache/appdata' },
  { path: '/mnt/user', name: 'Hard drive array', label: 'Hard drive array', kind: 'hdd', speed: 'slow', freeBytes: 2150 * GB, base: '/mnt/user' },
  { path: '/mnt/disks/vm', name: 'vm', label: 'vm', kind: 'unknown', speed: 'unknown', freeBytes: 90 * GB, base: '/mnt/disks/vm' },
];
const context = (chosen: CheckContext['chosen']): CheckContext => ({
  host: 'unraid',
  folderSetup: true,
  chosen,
  paths: { media: '/mnt/user/frameleaf-photos', database: '/mnt/user/appdata/frameleaf-databases', thumbnails: '/mnt/remotes/nas/thumbs', backups: '/mnt/user/appdata/frameleaf-backups' },
});

test('the line under each folder names its drive and free space, and says nothing it can’t tell', () => {
  assert.deepEqual(driveHint('/mnt/cache/appdata/frameleaf-databases', drives), { speed: 'fast', text: 'Cache pool (NVMe SSD) · 180 GB free' });
  assert.deepEqual(driveHint('/mnt/user/frameleaf-photos', drives), { speed: 'slow', text: 'Hard drive array · 2.1 TB free' });
  assert.deepEqual(driveHint('/mnt/remotes/nas/photos', drives), { speed: 'network', text: 'Network share' });
  assert.equal(driveHint('/mnt/disks/vm/photos', drives), null, 'an unidentified drive');
  assert.equal(driveHint('/srv/elsewhere', drives), null);
  assert.equal(driveHint('/mnt/cache/x', []), null, 'no drive report');
});

test('a suggestion reads as applied only while the folder is on its drive', () => {
  const suggestion: Suggestion = { status: 'found', drive: drives[0], title: 'Suggested: Cache pool (NVMe SSD)', reason: '', folder: '/mnt/cache/appdata/frameleaf-thumbnails' };
  assert.equal(onSuggested(suggestion, '/mnt/cache/appdata/elsewhere', drives), true);
  assert.equal(onSuggested(suggestion, '/mnt/user/appdata/frameleaf-thumbnails', drives), false);
  assert.equal(onSuggested({ status: 'none', reason: '' }, '/mnt/cache/x', drives), false);
});

test('folder rules for thumbnails and the database, in the prototype’s words', () => {
  const folders = { media: '/mnt/user/photos', database: '/mnt/cache/appdata/frameleaf-databases', backups: '/mnt/user/backups', manager: '/mnt/user/appdata/frameleaf-manager' };
  assert.equal(fastFolderIssue('/mnt/cache', folders, 'thumbnails'), 'Choose a folder inside this one.');
  assert.equal(fastFolderIssue('/mnt/remotes/nas/thumbs', folders, 'thumbnails'), 'This is a network share. Choose a drive inside this server.');
  assert.equal(fastFolderIssue('/mnt/user/photos/thumbs', folders, 'thumbnails'), 'This is inside your photos and videos folder. Choose a folder of its own.');
  assert.equal(fastFolderIssue('/mnt/disk1/photos/thumbs', folders, 'thumbnails'), 'This is inside your photos and videos folder. Choose a folder of its own.', 'an array disk is the same files as /mnt/user');
  assert.equal(fastFolderIssue('/mnt/user/appdata/frameleaf-manager/t', folders, 'thumbnails'), 'This folder holds Frameleaf Manager’s own settings. Choose a folder of its own.');
  assert.equal(fastFolderIssue('/mnt/user/backups/t', folders, 'database'), 'This folder holds your Frameleaf backups. Choose a folder of its own.');
  assert.equal(fastFolderIssue('/mnt/cache/appdata/frameleaf-databases/t', folders, 'thumbnails'), 'This folder holds your Frameleaf database. Choose a folder of its own.');
  assert.equal(fastFolderIssue('/mnt/cache/appdata/frameleaf-databases/t', folders, 'database'), null);
  assert.equal(fastFolderIssue('/mnt/cache/appdata/frameleaf-thumbnails', folders, 'thumbnails'), null);
});

test('the server check: a database on hard drives, with the one-press fix', () => {
  const [row] = checkRows(
    [
      {
        id: 'database',
        status: 'warning',
        code: 'database_on_hard_drives',
        facts: {
          drive: 'Hard drive array',
          free: 2150 * GB,
          suggestion: '/mnt/cache/appdata/frameleaf-databases',
          suggestedDrive: 'Cache pool (NVMe SSD)',
          suggestedName: 'Cache pool',
          reason: 'It has 180 GB free, and the database needs about 20 GB. Browsing and search read it constantly, so an SSD or NVMe drive makes them noticeably faster.',
        },
      },
    ],
    context(['media', 'database', 'backups']),
  );
  assert.equal(row.title, 'The database is on hard drives');
  assert.equal(
    row.detail,
    'Frameleaf will work, but a faster drive is available. Cache pool (NVMe SSD): It has 180 GB free, and the database needs about 20 GB. Browsing and search read it constantly, so an SSD or NVMe drive makes them noticeably faster.',
  );
  assert.deepEqual(row.action, { kind: 'suggest', folder: 'database', path: '/mnt/cache/appdata/frameleaf-databases', label: 'Use Cache pool' });
});

test('the server check: the database’s drive and the Thumbnails row when fine', () => {
  const rows = checkRows(
    [
      { id: 'database', status: 'ok', facts: { drive: 'Cache pool (NVMe SSD)', free: 180 * GB } },
      { id: 'thumbnails', status: 'ok', facts: { withPhotos: true } },
      { id: 'thumbnails', status: 'ok', facts: { path: '/mnt/cache/appdata/frameleaf-thumbnails', drive: 'Cache pool (NVMe SSD)', free: 180 * GB } },
      { id: 'database', status: 'ok', facts: { free: 180 * GB } },
    ],
    context(['media', 'database', 'thumbnails', 'backups']),
  );
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['Database', 'Cache pool (NVMe SSD) · 180 GB free'],
      ['Thumbnails', 'With your photos and videos'],
      ['Thumbnails', 'Cache pool (NVMe SSD) · 180 GB free'],
      ['Database', 'On this server · 180 GB free'],
    ],
  );
  assert.deepEqual(checkOrder('install'), ['docker', 'room', 'media', 'database', 'thumbnails', 'backups', 'manager', 'port', 'downloads', 'release', 'memory']);
  assert.ok(!checkOrder('import').includes('thumbnails'));
});

test('the server check: a thumbnails folder on a network share or a missing drive can be chosen again', () => {
  const [share, missing, overlap] = checkRows(
    [
      { id: 'thumbnails', status: 'problem', code: 'thumbnails_on_network_share' },
      { id: 'thumbnails', status: 'problem', code: 'thumbnail_folder_missing' },
      { id: 'thumbnails', status: 'problem', code: 'chosen_folders_overlap' },
    ],
    context(['media', 'database', 'thumbnails', 'backups']),
  );
  assert.equal(share.title, 'Thumbnails can’t go in this folder');
  assert.equal(share.detail, '/mnt/remotes/nas/thumbs is a network share. Thumbnails need a drive inside this server.');
  assert.deepEqual(share.action, { kind: 'folder', folder: 'thumbnails', label: 'Choose another folder' });
  assert.equal(missing.title, 'The thumbnails drive isn’t connected');
  assert.deepEqual(missing.action, { kind: 'folder', folder: 'thumbnails', label: 'Choose another folder' });
  assert.equal(overlap.title, 'These folders overlap');
  // FL-1320's restore case is unchanged: no folder chosen, so it offers keeping thumbnails with the photos.
  const [restore] = checkRows([{ id: 'thumbnails', status: 'problem', code: 'thumbnail_folder_missing', facts: { missing: '/mnt/cache/t', folder: '/mnt/user/photos/thumbs' } }], context(['database']));
  assert.deepEqual(restore.action, { kind: 'thumbnails', label: 'Keep thumbnails with your photos' });
});
