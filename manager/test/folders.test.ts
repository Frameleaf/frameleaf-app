import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlappingWriter } from '../src/postgres-storage.js';
import { adoptMappedFolders, assertExternalFolder, assertSeparateFolders, applyFolderDefaults, broadRoots, externalRoots, externalRuleSources, ensureChosenFolder, ensureManagerFolder, inside, isMounted, listFolders, realTarget, sameFiles } from '../src/folders.js';
import type { Refusal } from '../src/contracts.js';
import { externalFolderIssue, externalFolders, setExternalFolders } from '../ui/src/presentation.js';

const occupied = ['/mnt/user/appdata/frameleaf-media', '/mnt/user/appdata/frameleaf-manager'];
// The folder rules are Unraid's unless a test says otherwise.
process.env.MANAGER_PLATFORM = 'unraid';
async function on(platform: string, root: string | null, run: () => unknown) {
  process.env.MANAGER_PLATFORM = platform;
  if (root) process.env.MANAGER_FOLDER_ROOT = root;
  try {
    await run();
  } finally {
    process.env.MANAGER_PLATFORM = 'unraid';
    delete process.env.MANAGER_FOLDER_ROOT;
  }
}

test('a new Unraid template gets all of /mnt; explicit roots and other platforms are left alone', () => {
  const fresh: Record<string, string> = { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/mnt/user/appdata/frameleaf-manager' };
  applyFolderDefaults(fresh);
  assert.ok(broadRoots([fresh.MANAGER_STORAGE_ROOTS]));
  assert.equal(fresh.MANAGER_MOUNT_ROOTS, '/mnt');
  assert.equal(fresh.MANAGER_BACKUP_ROOT, '/mnt/user/appdata/frameleaf-backups');
  const existing = { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/state', MANAGER_STORAGE_ROOTS: '/mnt/user/photos' };
  applyFolderDefaults(existing);
  assert.deepEqual(existing, { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/state', MANAGER_STORAGE_ROOTS: '/mnt/user/photos' });
  const plain: Record<string, string> = { MANAGER_PLATFORM: 'linux', MANAGER_DATA: '/state' };
  applyFolderDefaults(plain);
  assert.equal(plain.MANAGER_STORAGE_ROOTS, undefined);
});

test('a new TrueNAS or plain Docker install gets its broad folder; one with saved roots keeps them', () => {
  const truenas: Record<string, string> = { MANAGER_PLATFORM: 'truenas', MANAGER_DATA: '/mnt/tank/frameleaf/manager' };
  applyFolderDefaults(truenas);
  assert.equal(truenas.MANAGER_STORAGE_ROOTS, '/mnt');
  assert.equal(truenas.MANAGER_DATABASE_ROOTS, '/mnt');
  assert.equal(truenas.MANAGER_BACKUP_ROOT, '/mnt/tank/frameleaf/frameleaf-backups');
  const plain: Record<string, string> = { MANAGER_PLATFORM: 'linux', MANAGER_FOLDER_ROOT: '/srv/frameleaf', MANAGER_DATA: '/srv/frameleaf/manager' };
  applyFolderDefaults(plain);
  assert.equal(plain.MANAGER_STORAGE_ROOTS, '/srv/frameleaf');
  const saved = { MANAGER_PLATFORM: 'truenas', MANAGER_DATA: '/mnt/tank/manager', MANAGER_STORAGE_ROOTS: '/mnt/tank/media' };
  applyFolderDefaults(saved);
  assert.deepEqual(saved, { MANAGER_PLATFORM: 'truenas', MANAGER_DATA: '/mnt/tank/manager', MANAGER_STORAGE_ROOTS: '/mnt/tank/media' });
});

test('an earlier install that maps /mnt gets External folders and keeps its saved roots', () => {
  const mapped = '40 30 0:2 /mnt /mnt ro,relatime master:1 - rootfs rootfs rw\n41 40 0:45 / /mnt/user rw,relatime master:2 - fuse.shfs shfs rw';
  const saved = { MANAGER_PLATFORM: 'unraid', MANAGER_DATA: '/mnt/user/appdata/frameleaf-manager', MANAGER_STORAGE_ROOTS: '/mnt/user/appdata/frameleaf-media' };
  const earlier: Record<string, string> = { ...saved };
  adoptMappedFolders(earlier, mapped);
  assert.deepEqual(earlier, { ...saved, MANAGER_EXTERNAL_ROOTS: '/mnt' });
  // Its four own folders mapped, as the earlier template has them: nothing changes.
  const unmapped: Record<string, string> = { ...saved };
  adoptMappedFolders(unmapped, '40 30 0:45 /appdata/frameleaf-media /mnt/user/appdata/frameleaf-media rw - fuse.shfs shfs rw');
  assert.deepEqual(unmapped, saved);
  const unreadable: Record<string, string> = { ...saved };
  adoptMappedFolders(unreadable, 'not a mount table');
  assert.deepEqual(unreadable, saved);
  // A new install already has /mnt as its roots, and plain Docker without a launcher folder has no broad folder.
  for (const env of [{ ...saved, MANAGER_STORAGE_ROOTS: '/mnt' }, { MANAGER_PLATFORM: 'linux', MANAGER_DATA: '/state', MANAGER_STORAGE_ROOTS: '/srv/media' }]) {
    const copy: Record<string, string> = { ...env };
    adoptMappedFolders(copy, mapped);
    assert.deepEqual(copy, env);
  }
});

test('on an earlier install the external rules cover what /mnt added, never a folder its saved roots allowed', () => {
  const sources = ['/mnt/user/appdata/frameleaf-media/inbox', '/mnt/user/photos/Archive'];
  const savedRoots = ['/mnt/user/appdata/frameleaf-media'];
  assert.deepEqual(externalRoots(), []);
  assert.deepEqual(externalRuleSources(sources, false, savedRoots), []);
  assert.deepEqual(externalRuleSources(sources, true, savedRoots), sources);
  process.env.MANAGER_EXTERNAL_ROOTS = '/mnt';
  try {
    assert.deepEqual(externalRuleSources(sources, false, savedRoots), ['/mnt/user/photos/Archive']);
  } finally {
    delete process.env.MANAGER_EXTERNAL_ROOTS;
  }
});

test('on TrueNAS a pool is just a pool, whatever it is called, and the apps dataset is off limits', async () => {
  await on('truenas', null, async () => {
    assert.doesNotThrow(() => assertSeparateFolders(['/mnt/user/a', '/mnt/tank/a']));
    assert.doesNotThrow(() => assertExternalFolder('/mnt/disks/photos', ['/mnt/tank/media']));
    assert.throws(() => assertExternalFolder('/mnt/.ix-apps/docker/x', []), (error: Refusal) => error.code === 'invalid_storage_path');
    await assert.rejects(ensureChosenFolder('/mnt/tank'), (error: Refusal) => error.code === 'invalid_storage_path');
    await assert.rejects(ensureChosenFolder('/mnt/no-such-pool/media'), (error: Refusal) => error.code === 'storage_volume_missing');
  });
});

test('a folder left where a pool used to be is not a mounted pool', () => {
  const mountinfo = '36 1 0:30 / /mnt/tank rw,relatime shared:1 - zfs tank rw\n37 36 0:31 / /mnt/tank/media rw,relatime shared:2 - zfs tank/media rw';
  assert.ok(isMounted('/mnt/tank', mountinfo));
  assert.ok(!isMounted('/mnt/exported', mountinfo));
  assert.ok(!isMounted('/mnt/tank', ''));
});

test('Manager will not create its own folder on a pool that is not there', async () => {
  await on('truenas', null, () => assert.rejects(ensureManagerFolder('/mnt/POOL_NAME/frameleaf/manager'), /MANAGER_DATA is \/mnt\/POOL_NAME/));
});

test('on plain Docker, folders are created and browsed inside the folder given to the launcher', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folder-root-')));
  await on('linux', root, async () => {
    assert.ok(broadRoots([root]));
    assert.ok(!broadRoots(['/mnt']));
    await ensureManagerFolder(join(root, 'manager'));
    await ensureChosenFolder(join(root, 'media', 'new'));
    assert.ok((await stat(join(root, 'media', 'new'))).isDirectory());
    await assert.rejects(ensureChosenFolder('/mnt/user/photos'), (error: Refusal) => error.code === 'invalid_storage_path');
    assert.throws(() => assertExternalFolder(join(root, '.hidden'), []), (error: Refusal) => error.code === 'invalid_storage_path');
    // The picker still opens at /mnt in the browser; that lands on the folder Manager was given.
    const listing = await listFolders('/mnt');
    assert.equal(listing.path, root);
    assert.equal(listing.parent, null);
    assert.deepEqual(listing.folders.map((f) => f.name), ['manager', 'media']);
  });
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

test('on plain Docker with extra drives, each drive is browsed and used, and the drives are listed at the top', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'folder-roots-')));
  const [main, ssd] = [join(base, 'main'), join(base, 'ssd')];
  await Promise.all([mkdir(main), mkdir(join(ssd, 'old'), { recursive: true })]);
  await on('linux', `${main}:${ssd}`, async () => {
    assert.ok(broadRoots([`${main}:${ssd}`]));
    assert.ok(broadRoots([main, ssd]));
    assert.ok(!broadRoots([main]));
    assert.ok(!broadRoots([ssd, main]));
    await ensureManagerFolder(join(main, 'manager'));
    await ensureChosenFolder(join(ssd, 'database'));
    assert.ok((await stat(join(ssd, 'database'))).isDirectory());
    for (const path of [main, ssd, '/', join(ssd, '.hidden'), '/mnt/user/photos', `${ssd}x/db`])
      await assert.rejects(ensureChosenFolder(path), (error: Refusal) => error.code === 'invalid_storage_path', path);
    assert.doesNotThrow(() => assertExternalFolder(join(ssd, 'old'), [join(main, 'media')]));
    assert.throws(() => assertExternalFolder(join(ssd, 'database', 'x'), [join(ssd, 'database')]), (error: Refusal) => !!error.code);
    const top = await listFolders('/mnt');
    assert.deepEqual(top, { path: '/', parent: null, folders: [{ name: main, path: main }, { name: ssd, path: ssd }], truncated: false });
    const drive = await listFolders(ssd);
    assert.equal(drive.parent, '/');
    assert.deepEqual(drive.folders.map((f) => f.name), ['database', 'old']);
    // A default not yet created opens its nearest folder on the right drive.
    assert.equal((await listFolders(join(ssd, 'old', 'not-yet'))).path, join(ssd, 'old'));
  });
  // A drive that isn't there is never invented.
  await on('linux', `${main}:${join(base, 'gone')}`, async () => {
    await assert.rejects(ensureChosenFolder(join(base, 'gone', 'db')), (error: Refusal) => error.code === 'storage_volume_missing');
    await assert.rejects(listFolders(join(base, 'gone')), (error: Refusal) => error.code === 'storage_volume_missing');
  });
});

test('overlapping broad folders: the innermost drive is its own place, and Up walks back out', async () => {
  const outer = await realpath(await mkdtemp(join(tmpdir(), 'folder-nested-')));
  const inner = join(outer, 'disk2');
  await mkdir(join(inner, 'photos'), { recursive: true });
  await on('linux', `${outer}:${inner}`, async () => {
    await ensureChosenFolder(join(inner, 'photos', 'new'));
    await assert.rejects(ensureChosenFolder(inner), (error: Refusal) => error.code === 'invalid_storage_path');
    await assert.rejects(ensureChosenFolder(join(inner, '.hidden')), (error: Refusal) => error.code === 'invalid_storage_path');
    assert.throws(() => assertSeparateFolders([inner, join(inner, 'photos')]), (error: Refusal) => error.code === 'chosen_folders_overlap');
    assert.equal((await listFolders(inner)).parent, outer);
    assert.equal((await listFolders(outer)).parent, '/');
    assert.equal((await listFolders('/elsewhere')).folders.length, 2);
  });
  // The inner drive given first changes nothing about where a folder belongs.
  await on('linux', `${inner}:${outer}`, async () => {
    await ensureChosenFolder(join(inner, 'photos', 'other'));
    assert.equal((await listFolders(inner)).parent, outer);
  });
});

test('one plain Docker folder keeps the picker it always had', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'folder-one-')));
  await on('linux', `${root}:`, async () => {
    assert.ok(broadRoots([root]));
    const listing = await listFolders('/');
    assert.equal(listing.path, root);
    assert.equal(listing.parent, null);
  });
});

test('inside() is one-way and sees the same Unraid files through another share view', () => {
  assert.equal(inside('/mnt/user/db/frameleaf-x/sub', '/mnt/user/db/frameleaf-x'), true);
  assert.equal(inside('/mnt/disk1/db/frameleaf-x', '/mnt/user/db/frameleaf-x'), true, 'a disk view of a user share folder');
  assert.equal(inside('/mnt/user/db', '/mnt/user/db/frameleaf-x'), false, 'a parent is not inside');
  assert.equal(inside('/mnt/disk1/db/frameleaf-x', '/mnt/disk2/db/frameleaf-x'), false, 'two disks are never the same files');
  assert.equal(inside('/mnt/disks/UD01/db', '/mnt/user/db'), false, 'an unassigned drive is its own');
});

test('an Unraid exclusive share is the same folder as its pool, and no other link is', () => {
  assert.ok(sameFiles('/mnt/user/appdata/frameleaf-manager', '/mnt/cache/appdata/frameleaf-manager'));
  assert.ok(!sameFiles('/mnt/user/appdata/frameleaf-manager', '/mnt/cache/other/frameleaf-manager'));
  assert.ok(!sameFiles('/mnt/user/appdata/x', '/mnt/user/appdata'), 'a parent is not the same folder');
  assert.ok(!sameFiles('/mnt/user/appdata/x', '/etc/x'));
});
