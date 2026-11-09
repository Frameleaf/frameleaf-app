// FL-1317 Check this server wording: fixes the owner can actually make, for every host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOrder, checkRows, checkSummary, type CheckContext, type CheckHost } from '../ui/src/server-check.js';

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

// FL-1318: the prototype's rows for Docker's storage, downloads, memory and Unraid's Docker tab.
const GB = 1024 ** 3;
test('Docker’s storage: what is needed and free, the fix for each host, and “couldn’t check”', () => {
  const [ok] = checkRows([{ id: 'room', status: 'ok', facts: { needed: 8 * GB, free: 31 * GB } }], context('unraid', []));
  assert.deepEqual([ok.label, ok.value], ['Room for Frameleaf', '8 GB needed · 31 GB free']);
  for (const host of ['unraid', 'truenas', 'hexos', 'linux'] as const) {
    const [full] = checkRows([{ id: 'room', status: 'problem', code: 'insufficient_docker_space', facts: { needed: 8 * GB, free: 3.1 * GB } }], context(host, []));
    assert.equal(full.title, 'Not enough room in Docker’s storage');
    assert.equal(full.detail, 'Frameleaf needs about 8 GB there, and only 3.1 GB is free.');
    assert.ok(full.steps?.length, host);
  }
  const [unraid] = checkRows([{ id: 'room', status: 'problem', code: 'insufficient_docker_space', facts: { needed: 4 * GB, free: GB } }], context('unraid', []));
  assert.match(unraid.steps![1], /Docker vDisk size/);
  const [unknown] = checkRows([{ id: 'room', status: 'unknown', code: 'docker_storage_unreadable', facts: { needed: 4 * GB } }], context('linux', []));
  assert.equal(unknown.title, 'Couldn’t check Docker’s storage');
  assert.equal(unknown.action?.kind, 'recheck');
});

test('downloads name the host that didn’t answer', () => {
  const [ok] = checkRows([{ id: 'downloads', status: 'ok' }], context('linux', []));
  assert.equal(ok.value, 'Frameleaf’s download server answered');
  for (const host of ['ghcr.io', 'github.com']) {
    const [row] = checkRows([{ id: 'downloads', status: 'problem', code: 'download_host_unreachable', detail: host }], context('truenas', []));
    assert.equal(row.title, 'Manager can’t reach Frameleaf’s downloads');
    assert.equal(row.detail, `This server couldn’t connect to ${host}, where Frameleaf is downloaded from.`);
    assert.deepEqual(row.steps, ['Check this server is connected to the internet.', 'If your network uses a VPN, DNS filter or ad blocker, allow ghcr.io and github.com.']);
  }
});

test('low memory offers to turn off faces and smart search, except on a restore', () => {
  const low = { id: 'memory', status: 'warning' as const, code: 'low_memory', facts: { bytes: 3.8 * GB, ml: true } };
  const [row] = checkRows([low], context('hexos', []));
  assert.equal(row.title, 'This server has 4 GB of memory');
  assert.equal(row.detail, 'Frameleaf will work, but faces and smart search can run out of memory with less than 8 GB.');
  assert.deepEqual(row.action, { kind: 'ml', label: 'Turn off faces and smart search' });
  assert.equal(checkRows([low], { ...context('hexos', []), fixedMl: true })[0].action, undefined);
  assert.equal(checkRows([{ id: 'memory', status: 'ok', facts: { bytes: 32 * GB } }], context('linux', []))[0].value, '32 GB');
  assert.equal(checkRows([{ id: 'memory', status: 'unknown', code: 'memory_unknown' }], context('linux', []))[0].title, 'Couldn’t check memory');
  assert.equal(checkSummary(checkRows([low], context('hexos', []))).problems, 0);
});

test('Unraid’s Docker tab is a warning with the path to add', () => {
  const [row] = checkRows([{ id: 'unraid', status: 'warning', code: 'dockerman_templates_unmapped' }], context('unraid', []));
  assert.equal(row.label, 'Unraid Docker tab');
  assert.equal(row.title, 'Frameleaf won’t be editable from Unraid’s Docker tab');
  assert.match(row.steps!.at(-1)!, /\/run\/frameleaf-host\/templates-user/);
  assert.equal(checkRows([{ id: 'unraid', status: 'ok' }], context('unraid', []))[0].value, 'Ready');
});

test('the running list follows the prototype’s order and shows Unraid’s Docker tab only on Unraid', () => {
  assert.deepEqual(checkOrder('install', false, 'unraid'), ['docker', 'room', 'media', 'database', 'thumbnails', 'backups', 'manager', 'port', 'downloads', 'release', 'memory', 'unraid']);
  assert.deepEqual(checkOrder('restore', false, 'linux'), ['docker', 'room', 'media', 'database', 'port', 'downloads', 'release', 'memory']);
});
