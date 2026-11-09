import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlappingWriter } from '../src/postgres-storage.js';
import { assertExternalFolder, assertSeparateFolders, applyUnraidFolderDefaults, broadRoots, ensureChosenFolder, realTarget } from '../src/folders.js';
import type { Refusal } from '../src/contracts.js';
import { externalFolderIssue, externalFolders, setExternalFolders } from '../ui/src/presentation.js';

const occupied = ['/mnt/user/appdata/frameleaf-media', '/mnt/user/appdata/frameleaf-manager'];

test('a new Unraid template gets all of /mnt; explicit roots and other platforms are left alone', () => {
  const fresh: Record<string, string> = { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/mnt/user/appdata/frameleaf-manager' };
  applyUnraidFolderDefaults(fresh);
  assert.ok(broadRoots([fresh.MANAGER_STORAGE_ROOTS]));
  assert.equal(fresh.MANAGER_MOUNT_ROOTS, '/mnt');
  assert.equal(fresh.MANAGER_BACKUP_ROOT, '/mnt/user/appdata/frameleaf-backups');
  const existing = { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/state', MANAGER_STORAGE_ROOTS: '/mnt/user/photos' };
  applyUnraidFolderDefaults(existing);
  assert.deepEqual(existing, { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/state', MANAGER_STORAGE_ROOTS: '/mnt/user/photos' });
  const truenas: Record<string, string> = { MANAGER_PLATFORM: 'linux', MANAGER_DATA: '/state' };
  applyUnraidFolderDefaults(truenas);
  assert.equal(truenas.MANAGER_STORAGE_ROOTS, undefined);
});

test('an external folder is never all of /mnt or Frameleaf data, on the server and in the browser', () => {
  for (const path of ['/mnt/user', '/mnt/user/appdata', '/mnt/user/appdata/frameleaf-media/x', '/mnt']) {
    assert.throws(() => assertExternalFolder(path, occupied), (error: Refusal) => !!error.code, path);
    assert.ok(externalFolderIssue(path, occupied, []), path);
  }
  for (const path of ['/mnt/user/photos/Archive', '/mnt/disks/UD01/Archive']) {
    assert.doesNotThrow(() => assertExternalFolder(path, occupied));
    assert.equal(externalFolderIssue(path, occupied, []), null);
  }
});

test('Unraid share and disk views of a folder count as the same folder, separate disks do not', () => {
  assert.throws(() => assertExternalFolder('/mnt/disk1/appdata/frameleaf-manager/x', occupied), (error: Refusal) => !!error.code);
  assert.throws(() => assertSeparateFolders(['/mnt/user/photos/a', '/mnt/cache/photos/a/b']), (error: Refusal) => !!error.code);
  assert.doesNotThrow(() => assertSeparateFolders(['/mnt/disk1/photos/a', '/mnt/disk2/photos/a']));
  assert.doesNotThrow(() => assertSeparateFolders(['/mnt/disks/UD01/photos/a', '/mnt/user/photos/a']));
});

test('photos, database and backups need separate folders', () => {
  assert.throws(() => assertSeparateFolders(['/mnt/user/a', '/mnt/user/a/db']), (error: Refusal) => error.code === 'chosen_folders_overlap');
  assert.doesNotThrow(() => assertSeparateFolders(['/mnt/user/a', '/mnt/user/ab']));
});

test('a chosen folder must be a real location under /mnt', async () => {
  for (const path of ['/etc/x', '/mnt/user', '/mnt/user/a,b', '/mnt/user/../../etc'])
    await assert.rejects(ensureChosenFolder(path), (error: Refusal) => error.code === 'invalid_storage_path', path);
});

test('a folder reached through a link is seen for where it really lands', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chosen-')));
  await mkdir(join(root, 'media'));
  await symlink(join(root, 'media'), join(root, 'link'));
  assert.equal(await realTarget(join(root, 'plain', 'new')), join(root, 'plain', 'new'));
  assert.equal(await realTarget(join(root, 'link', 'backups')), join(root, 'media', 'backups'));
});

test('with all of /mnt approved, a file manager on a whole share does not block the database folder', () => {
  const app = (Source: string) => [{ Id: 'other', Name: '/krusader', Config: { Labels: {} }, Mounts: [{ RW: true, Source }] }] as never;
  const path = '/mnt/user/appdata/frameleaf-databases';
  assert.equal(overlappingWriter(app('/mnt/user'), path, 'manager', undefined, ['/mnt']), undefined);
  assert.equal(overlappingWriter(app(path), path, 'manager', undefined, ['/mnt'])?.container, 'krusader');
});

test('editing External folders leaves a line the Advanced editor rejects as typed', () => {
  const text = '/mnt/user/a:/mnt/user/a:ro,slave\n/mnt/user/b:/mnt/user/b:ro';
  assert.deepEqual(externalFolders(text), [{ path: '/mnt/user/b', readOnly: true }]);
  assert.equal(setExternalFolders(text, []), '/mnt/user/a:/mnt/user/a:ro,slave');
  assert.ok(externalFolderIssue('/mnt/disk1/appdata/frameleaf-media/x', occupied, []));
});

test('External folders edit only same-path lines and keep advanced mappings', () => {
  const text = '/mnt/user/other:/archive:ro\n/mnt/user/a:/mnt/user/a:ro';
  assert.deepEqual(externalFolders(text), [{ path: '/mnt/user/a', readOnly: true }]);
  assert.equal(setExternalFolders(text, [{ path: '/mnt/user/b', readOnly: false }]), '/mnt/user/other:/archive:ro\n/mnt/user/b:/mnt/user/b');
});
