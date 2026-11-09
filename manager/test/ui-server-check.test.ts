// FL-1317 Check this server wording: fixes the owner can actually make, for every host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRows, checkSummary, type CheckContext, type CheckHost } from '../ui/src/server-check.js';

const context = (host: CheckHost, chosen: CheckContext['chosen'], folderSetup = true): CheckContext => ({
  host,
  folderSetup,
  chosen,
  paths: { media: '/mnt/user/photos', database: '/mnt/cache/appdata/frameleaf-databases', backups: '/mnt/user/backups' },
});

test('Choose another folder is offered only for a folder this flow sends', () => {
  const results = [
    { id: 'media', status: 'problem' as const, code: 'storage_inaccessible' },
    { id: 'database', status: 'problem' as const, code: 'database_directory_missing' },
  ];
  // A restore keeps the backup's media folders: only the database folder is chosen.
  const [media, database] = checkRows(results, context('unraid', ['database']));
  assert.equal(media.action, undefined);
  assert.ok(media.steps?.length);
  assert.deepEqual(database.action, { kind: 'folder', folder: 'database', label: 'Choose another folder' });
  const fresh = checkRows(results, context('unraid', ['media', 'database', 'backups']));
  assert.equal(fresh[0].action?.kind, 'folder');
});

test('Manager’s own folder never offers a folder picker', () => {
  for (const code of ['insufficient_disk_space', 'storage_permissions', 'storage_outside_approved_roots']) {
    const [row] = checkRows([{ id: 'manager', status: 'problem', code }], context('unraid', ['media', 'database', 'backups']));
    assert.equal(row.action, undefined, code);
    assert.ok(row.steps?.length, code);
  }
  const [room] = checkRows([{ id: 'manager', status: 'problem', code: 'insufficient_disk_space' }], context('truenas', ['database']));
  assert.equal(room.title, 'Not enough room in Manager’s own folder');
});

test('a missing thumbnails drive offers the photos folder only when there is one', () => {
  const missing = { id: 'thumbnails', status: 'problem' as const, code: 'thumbnail_folder_missing' };
  const [offered] = checkRows([{ ...missing, facts: { missing: '/mnt/disks/fast/thumbs', folder: '/mnt/user/photos/thumbs' } }], context('unraid', ['database']));
  assert.equal(offered.title, 'The thumbnails drive isn’t connected');
  assert.deepEqual(offered.action, { kind: 'thumbnails', label: 'Keep thumbnails with your photos' });
  assert.ok(offered.steps?.length);
  const [none] = checkRows([{ ...missing, facts: { missing: '/mnt/disks/fast/thumbs', folder: null } }], context('linux', ['database']));
  assert.equal(none.action, undefined);
  assert.ok(none.steps?.length);
});

test('every problem has a fix on Unraid, TrueNAS, HexOS and other Linux', () => {
  const problems = [
    ['docker', 'unsupported_docker_version_or_architecture'], ['docker', 'compose_v2_required'], ['docker', 'unsupported_docker_host'], ['docker', 'check_failed'],
    ['media', 'storage_inaccessible'], ['media', 'storage_permissions'], ['media', 'insufficient_disk_space'], ['media', 'external_media_volume_unavailable'],
    ['database', 'database_directory_missing'], ['database', 'database_permissions'], ['database', 'insufficient_database_space'], ['database', 'chosen_folders_overlap'],
    ['backups', 'storage_permissions'], ['media', 'media_folder_missing'], ['media', 'mounted_folder_missing'], ['thumbnails', 'thumbnail_folder_missing'], ['manager', 'insufficient_disk_space'], ['manager', 'storage_permissions'], ['port', 'port_in_use'], ['containers', 'service_override_conflict'],
    ['release', 'release_architecture_unavailable'], ['release', 'release_download_failed'], ['release', 'release_verification_failed'], ['other', 'anything'],
  ];
  for (const host of ['unraid', 'truenas', 'hexos', 'linux'] as const)
    for (const folderSetup of [true, false])
      for (const [id, code] of problems) {
        const [row] = checkRows([{ id, status: 'problem', code, facts: { port: 2283, free: 2284 } }], context(host, ['media', 'database', 'backups'], folderSetup));
        assert.ok(row.title, `${host} ${id} ${code}: title`);
        assert.ok(row.steps?.length || row.action, `${host} ${id} ${code}: no fix`);
      }
});

test('a restore says it restores; an install and an import say they install', () => {
  const rows = checkRows([{ id: 'port', status: 'problem', code: 'port_in_use', facts: { port: 2283, free: 2284 } }], context('linux', ['database'], false));
  assert.equal(checkSummary(rows, 'restore').title, '1 thing to fix before restoring');
  assert.equal(checkSummary(rows, 'import').title, '1 thing to fix before installing');
  assert.equal(checkSummary(rows).title, '1 thing to fix before installing');
  const unknown = checkRows([{ id: 'port', status: 'unknown', code: 'check_failed', facts: { port: 2283 } }], context('linux', ['database'], false));
  assert.equal(checkSummary(unknown, 'restore').lead, 'Frameleaf can restore. There’s one thing worth knowing first.');
});

test('warnings and unknowns never block; problems lead the summary', () => {
  const rows = checkRows(
    [
      { id: 'docker', status: 'ok', facts: { version: '27.5' } },
      { id: 'port', status: 'unknown', code: 'check_failed', facts: { port: 2283 } },
    ],
    context('linux', ['media', 'database', 'backups'], false),
  );
  assert.equal(rows[0].value, 'Docker 27.5');
  assert.equal(rows[1].title, 'Couldn’t check the port');
  assert.deepEqual(checkSummary(rows), { problems: 0, notes: 1, title: 'This server is ready', lead: 'Frameleaf can install. There’s one thing worth knowing first.' });
});
