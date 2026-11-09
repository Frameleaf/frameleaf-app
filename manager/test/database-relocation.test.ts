import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { Refusal } from '../src/contracts.js';
import { fileHash } from '../src/files.js';
import { hostRealpathScript, hostRealpaths } from '../src/host-realpath.js';
import { execFileSync } from 'node:child_process';

// FL-1322: moving the installed database to a folder on another drive, on the same release and image.
type Options = { restore?: 'fails' | 'differs' | 'hangs'; start?: 'fails' | 'fails-while-running' | 'crash-then-fails' | 'media' };
async function relocationFixture(options: Options = {}) {
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'manager-database-relocation-')));
  const oldRoot = join(directory, 'cache');
  const newRoot = join(directory, 'ssd');
  await mkdir(oldRoot);
  await mkdir(newRoot);
  const store = new Store(join(directory, 'state'));
  const postgres = `ghcr.io/frameleaf/frameleaf-postgres:19rc1-pgvector0.8.7@sha256:${'b'.repeat(64)}`;
  const server = `fixture.invalid/server@sha256:${'c'.repeat(64)}`;
  const id = 'a'.repeat(12);
  const escaped = (path: string) => path.replaceAll('$', '$$$$');
  const current = { id, project: 'frameleaf-test', release: 'frameleaf-v1.2.6', ml: false, mounts: [], origin: 'new_library',
    port: 2283, sourceId: null, mayHaveWrittenMedia: true, databaseRoot: oldRoot,
    databasePath: join(oldRoot, `frameleaf-${id}-postgres-Old1`) };
  const release = { directory: join(directory, current.release), nas: { tag: current.release, platforms: ['linux/amd64'],
    images: { server, postgres, machineLearning: server } } };
  await mkdir(release.directory);
  await writeFile(join(release.directory, 'docker-compose.yml'), JSON.stringify({ services: {
    database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }));
  const previousCompose = { services: {
    database: { image: postgres, volumes: [{ type: 'bind', source: escaped(current.databasePath), target: '/var/lib/postgresql' }] },
    'frameleaf-server': { image: server },
  } };
  const stack = join(directory, 'state', 'stack', 'compose.json');
  await mkdir(join(directory, 'state', 'stack'), { recursive: true });
  await writeFile(stack, JSON.stringify(previousCompose));
  store.set('installation', current);
  store.set('database-password', 'fixture-only');
  store.set('application-config', { environment: {}, settings: null, services: {} });

  const library = { version: '19rc1', extensions: ['plpgsql', 'vector'], tables: { 'public.asset': 3, 'public.user': 1 } };
  const folders = new Map<string, any>([[current.databasePath, library]]);
  const running = async () => {
    const compose = JSON.parse(await readFile(stack, 'utf8'));
    const data = compose.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql');
    return data.source.replaceAll('$$', '$') as string;
  };
  const composed: string[][] = [];
  const restored: string[] = [];
  const allocated: [string, number][] = [];
  const validated: unknown[][] = [];
  let serverUp = false;
  let fullStarts = 0;
  let hang: () => void = () => {};
  const reachedRestore = new Promise<void>((resolve) => (hang = resolve));
  let started: () => void = () => {};
  const reachedStart = new Promise<void>((resolve) => (started = resolve));
  const extra: any[] = [];
  // Host-only links (outside anything Manager maps) and paths the host can't resolve; null: the helper can't run.
  const host: { links: Record<string, string>; unresolvable: string[]; unavailable?: boolean } = { links: {}, unresolvable: [] };
  const docker = {
    compose: async (_dir: string, _project: string, action: string, services: string[] = []) => {
      composed.push([action, ...services]);
      const path = await running();
      if (action === 'stop') serverUp = false;
      if (action === 'up' && !folders.has(path)) folders.set(path, { version: '19rc1', extensions: ['plpgsql'], tables: {} });
      if (action === 'up' && !services.length) {
        const moved = path !== current.databasePath;
        if (moved && options.start === 'fails') throw new Error('container frameleaf-test-frameleaf-server-1 exited');
        if (moved && options.start === 'crash-then-fails' && ++fullStarts === 1) {
          // The server starts and takes writes; Manager stops before `up` returns.
          serverUp = true;
          started();
          return new Promise<void>(() => {});
        }
        if (moved && options.start === 'crash-then-fails') throw new Error('container frameleaf-test-frameleaf-server-1 exited');
        serverUp = true;
        if (moved && options.start === 'fails-while-running') throw new Error('container frameleaf-test-frameleaf-server-1 is unhealthy');
      }
    },
    inventory: async () => [
      { Id: 'b'.repeat(64), Name: '/frameleaf-test-database-1', State: { Running: true },
        Config: { Labels: { 'app.frameleaf.manager': id, 'com.docker.compose.service': 'database' } },
        Mounts: [{ Type: 'bind', Source: await running(), RW: true, Destination: '/var/lib/postgresql' }] },
      { Id: 'c'.repeat(64), Name: '/frameleaf-test-frameleaf-server-1', State: { Running: serverUp },
        Config: { Labels: { 'app.frameleaf.manager': id, 'com.docker.compose.service': 'frameleaf-server' } }, Mounts: [] },
      ...extra,
    ],
    sql: async (_db: unknown, query: string) => {
      if (query.includes('pg_database_size')) return String(2 * 1024 ** 3);
      if (query === 'SELECT 1;') return '1';
      assert.match(query, /query_to_xml/);
      return JSON.stringify(folders.get(await running()));
    },
    verifyDump: async () => {},
    restore: async (_db: unknown, file: string) => {
      const path = await running();
      assert.notEqual(path, current.databasePath, 'never restored into the original folder');
      assert.ok(path.startsWith(newRoot + '/'), 'restored on the chosen drive');
      assert.match(file, /database\.dump$/);
      restored.push(path);
      if (options.restore === 'hangs' && restored.length === 1) {
        hang();
        return new Promise<void>(() => {});
      }
      if (options.restore === 'fails') throw new Error('pg_restore: error: could not execute query');
      const copy = structuredClone(library);
      if (options.restore === 'differs') copy.tables['public.asset'] = 2;
      folders.set(path, copy);
    },
  };
  let attempt = 0;
  const databaseStorage = {
    roots: [],
    verify: async () => {},
    validate: async (...args: unknown[]) => {
      validated.push(args);
      return { root: args[0], filesystem: 'ext4', device: '8:1' };
    },
    allocate: async (root: string, installation: string, bytes: number) => {
      allocated.push([root, bytes]);
      return join(root, `frameleaf-${installation}-postgres-$new${++attempt}`);
    },
  };
  const releases = { eligible: async () => {}, verify: async () => {}, acquire: async () => release };
  const backups = { initialize: async () => {}, snapshot: async () => 'snapshot' };
  const create = () => {
    const operations = new Operations(store, docker as never, releases as never, backups as never, [], databaseStorage as never);
    (operations as any).fencing = {
      assertMedia: async (_mounts: unknown, installation: any) => {
        if (options.start === 'media' && installation.databasePath !== current.databasePath) throw new Refusal('media_mount_changed');
      },
      verify: async () => {},
    };
    (operations as any).libraryStatus = async () => null;
    operations.hostRealpaths = async (paths) =>
      host.unavailable ? null : paths.map((path) => (host.unresolvable.includes(path) ? null : (host.links[path] ?? path)));
    // The checkpoint itself is covered by the backup tests: here it leaves its dump and compose.json.
    (operations as any).checkpoint = async (operation: any) => {
      const checkpoint = join(directory, 'state', 'checkpoints', operation.id);
      await mkdir(checkpoint, { recursive: true });
      await writeFile(join(checkpoint, 'database.dump'), 'pre-move dump');
      await writeFile(join(checkpoint, 'compose.json'), await readFile(stack));
      operation.receipts['checkpoint-dump'] = { sha256: await fileHash(join(checkpoint, 'database.dump')) };
      store.save(operation);
      return checkpoint;
    };
    return operations;
  };
  const begin = async (operations = create()) => {
    const review = await operations.reviewDatabaseMove(newRoot);
    const operation = operations.moveDatabaseTo(review.id, crypto.randomUUID());
    return { review, operation };
  };
  const settled = async (operationId: string) => {
    for (;;) {
      const operation = store.history().find((o) => o.id === operationId)!;
      if (operation.state !== 'running') return operation;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { host, extra, reachedStart, stopServer: () => (serverUp = false), directory, store, current, newRoot, oldRoot, previousCompose, folders, composed, restored, allocated, validated,
    reachedRestore, create, begin, settled, escaped,
    attemptPath: (n: number) => join(newRoot, `frameleaf-${id}-postgres-$new${n}`),
    stackNow: async () => JSON.parse(await readFile(stack, 'utf8')),
    cleanup: async () => { store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('reviewing a database move checks the chosen drive has room for the copy and a later engine upgrade', async () => {
  const f = await relocationFixture();
  try {
    const operations = f.create();
    await assert.rejects(operations.reviewDatabaseMove(f.oldRoot), /database_already_in_folder/);
    await assert.rejects(operations.reviewDatabaseMove(f.current.databasePath + '/inside'), /chosen_folders_overlap/);
    const review = await operations.reviewDatabaseMove(f.newRoot);
    assert.deepEqual(f.validated, [[f.newRoot, 4 * 1024 ** 3, f.current.id]], 'twice the measured size, with own containers excused');
    assert.equal(review.from, f.oldRoot);
    assert.equal(review.to, f.newRoot);
    assert.equal(review.databaseBytes, 2 * 1024 ** 3);
    assert.equal(review.requiredBytes, 4 * 1024 ** 3);
    assert.equal(typeof review.availableBytes, 'number');
    assert.match(review.recovery, /Once Frameleaf has started on the new folder, it stays there/);
    assert.deepEqual(f.composed, [], 'a review changes nothing');
    (operations as any).databaseStorage.validate = async () => {
      throw new Refusal('insufficient_database_space');
    };
    await assert.rejects(operations.reviewDatabaseMove(f.newRoot), /insufficient_database_space/);
    // A review is for the installation as it was reviewed.
    f.store.set('installation', { ...f.current, port: 2284 });
    assert.throws(() => operations.moveDatabaseTo(review.id, crypto.randomUUID()), /review_expired/);
  } finally {
    await f.cleanup();
  }
});

test('a database moves to another drive unchanged, and the original folder is kept', async () => {
  const f = await relocationFixture();
  try {
    const { operation } = await f.begin();
    const done = await f.settled(operation.id);
    assert.equal(done.state, 'complete');
    assert.equal(done.error, null);
    assert.deepEqual(done.completed, ['stop-application', 'database-checkpoint', 'database-move', 'start']);
    assert.deepEqual(f.composed, [['stop', 'frameleaf-server'], ['stop'], ['up', 'database'], ['up']]);
    assert.deepEqual(f.allocated, [[f.newRoot, 2 * 1024 ** 3]], 'allocated in the chosen folder');
    const installation = f.store.get<any>('installation');
    assert.equal(installation.databaseRoot, f.newRoot);
    assert.equal(installation.databasePath, f.attemptPath(1));
    assert.equal(installation.release, f.current.release, 'same release');
    const stack = await f.stackNow();
    assert.equal(stack.services.database.image, f.previousCompose.services.database.image, 'same engine');
    assert.equal(stack.services.database.volumes.find((v: any) => v.target === '/var/lib/postgresql').source,
      f.escaped(f.attemptPath(1)));
    assert.deepEqual(f.folders.get(f.attemptPath(1)), f.folders.get(f.current.databasePath), 'same tables, counts and extensions');
    assert.deepEqual(f.store.get('retained-database-directories'), [f.current.databasePath]);
    assert.deepEqual(await f.create().retainedDatabases(), [{ path: f.current.databasePath, present: false }]);
    // The retained original sits beside a move back to its root, never under it.
    await f.create().reviewDatabaseMove(f.oldRoot);
    await assert.rejects(f.create().reviewDatabaseMove(join(f.current.databasePath, 'inside')), /chosen_folders_overlap/);
  } finally {
    await f.cleanup();
  }
});

for (const failure of ['fails', 'differs'] as const)
  test(`a database move whose restore ${failure === 'fails' ? 'fails' : 'does not match'} starts again on the original folder`, async () => {
    const f = await relocationFixture({ restore: failure });
    try {
      const { operation } = await f.begin();
      const done = await f.settled(operation.id);
      assert.equal(done.state, 'complete');
      assert.equal(done.error, 'database_relocation_rolled_back');
      assert.equal(done.receipts['rollback-intent'], failure === 'fails' ? 'database_move_failed' : 'database_move_verification_failed');
      assert.ok(!done.completed.includes('start'));
      assert.deepEqual(await f.stackNow(), f.previousCompose, 'the original image and folder');
      assert.deepEqual(f.store.get<any>('installation'), f.current);
      assert.deepEqual(f.composed.at(-1), ['up'], 'Frameleaf runs again');
      assert.deepEqual(f.folders.get(f.current.databasePath).tables, { 'public.asset': 3, 'public.user': 1 });
      assert.deepEqual(f.store.get('retained-database-directories'), [f.attemptPath(1)], 'the partial copy is kept');
      await f.create().reviewDatabaseMove(f.newRoot); // A retry into the same root is offered.
    } finally {
      await f.cleanup();
    }
  });

test('a start refused before the server could run on the moved database goes back to the original folder', async () => {
  const f = await relocationFixture({ start: 'media' });
  try {
    const { operation } = await f.begin();
    const done = await f.settled(operation.id);
    assert.equal(done.error, 'database_relocation_rolled_back');
    assert.equal(done.receipts['rollback-intent'], 'media_mount_changed');
    assert.equal(done.receipts['start-state'], undefined, 'the server never started on the new folder');
    assert.deepEqual(await f.stackNow(), f.previousCompose);
    assert.deepEqual(f.store.get<any>('installation'), f.current);
  } finally {
    await f.cleanup();
  }
});

test('a moved database whose server fails to start is kept: it may have written', async () => {
  const f = await relocationFixture({ start: 'fails' });
  try {
    const { operation } = await f.begin();
    const done = await f.settled(operation.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.receipts['start-state'], 'starting');
    assert.equal(done.receipts['rollback-intent'], undefined);
    assert.equal(f.store.get<any>('installation').databasePath, f.attemptPath(1));
  } finally {
    await f.cleanup();
  }
});

test('a crash after the server started on the moved database never rolls back, even once the server stopped', async () => {
  const f = await relocationFixture({ start: 'crash-then-fails' });
  try {
    const { operation } = await f.begin();
    await f.reachedStart;
    f.store.interrupt();
    f.stopServer(); // The server took writes, then stopped with the host.
    const journal = f.store.history().find((o) => o.id === operation.id)!;
    assert.equal(journal.step, 'start');
    assert.equal(journal.receipts['start-state'], 'starting', 'journaled before the server first started');
    const operations = f.create();
    assert.equal(operations.history().find((o) => o.id === journal.id)!.canCancel, false);
    await assert.rejects(operations.recover(journal.id), /database_move_reverse_required/);
    operations.resume(journal.id);
    const done = await f.settled(journal.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.receipts['rollback-intent'], undefined);
    assert.ok(!done.completed.includes('return-original-database'));
    assert.equal(f.store.get<any>('installation').databasePath, f.attemptPath(1));
    assert.equal((await f.stackNow()).services.database.volumes[0].source, f.escaped(f.attemptPath(1)));
  } finally {
    await f.cleanup();
  }
});

test('a moved database whose server is running when the start fails is kept, never rolled back', async () => {
  const f = await relocationFixture({ start: 'fails-while-running' });
  try {
    const { operation } = await f.begin();
    const done = await f.settled(operation.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.receipts['rollback-intent'], undefined);
    assert.equal(f.store.get<any>('installation').databasePath, f.attemptPath(1));
    const operations = f.create();
    assert.equal(operations.history().find((o) => o.id === done.id)!.canCancel, false);
    await assert.rejects(operations.recover(done.id), /database_move_reverse_required/);
  } finally {
    await f.cleanup();
  }
});

test('cancelling an interrupted database move returns to the original database', async () => {
  const f = await relocationFixture({ restore: 'hangs' });
  try {
    const { operation } = await f.begin();
    await f.reachedRestore;
    // Manager stops while pg_restore runs: the next Manager has only the journal.
    f.store.interrupt();
    const journal = f.store.history().find((o) => o.id === operation.id)!;
    assert.equal(journal.step, 'database-move');
    const operations = f.create();
    assert.equal(operations.history().find((o) => o.id === journal.id)!.canCancel, true);
    await operations.recover(journal.id);
    const done = f.store.history().find((o) => o.id === journal.id)!;
    assert.equal(done.state, 'complete');
    assert.equal(done.error, 'database_relocation_cancelled');
    assert.deepEqual(await f.stackNow(), f.previousCompose);
    assert.deepEqual(f.store.get<any>('installation'), f.current);
    assert.deepEqual(f.composed.at(-1), ['up']);
    assert.deepEqual(f.store.get('retained-database-directories'), [f.attemptPath(1)]);
    assert.equal(f.store.locked(), null, 'the lock is released');
  } finally {
    await f.cleanup();
  }
});

test('resuming an interrupted database move restores into another new folder and keeps the partial one', async () => {
  const f = await relocationFixture({ restore: 'hangs' });
  try {
    const { operation } = await f.begin();
    await f.reachedRestore;
    f.store.interrupt();
    const operations = f.create();
    operations.resume(operation.id);
    const done = await f.settled(operation.id);
    assert.equal(done.state, 'complete');
    assert.equal(done.error, null);
    assert.deepEqual(f.restored, [f.attemptPath(1), f.attemptPath(2)]);
    assert.equal(f.store.get<any>('installation').databasePath, f.attemptPath(2));
    assert.deepEqual(f.store.get('retained-database-directories'), [f.current.databasePath, f.attemptPath(1)]);
  } finally {
    await f.cleanup();
  }
});

test('a retained database folder is removed only on request, and never the one in use', async () => {
  const f = await relocationFixture();
  try {
    const { operation } = await f.begin();
    await f.settled(operation.id);
    const operations = f.create();
    await mkdir(f.current.databasePath);
    await writeFile(join(f.current.databasePath, 'PG_VERSION'), '19');
    await assert.rejects(operations.removeRetainedDatabase(f.attemptPath(1)), /database_folder_not_retained/);
    await assert.rejects(operations.removeRetainedDatabase(join(f.oldRoot, 'elsewhere')), /database_folder_not_retained/);
    f.store.set('retained-database-directories', [f.oldRoot]);
    await assert.rejects(operations.removeRetainedDatabase(f.oldRoot), /invalid_database_directory/, 'only a database folder Manager made');
    // Even a listed folder is refused while it is the one in use.
    f.store.set('retained-database-directories', [f.current.databasePath, f.attemptPath(1)]);
    await assert.rejects(operations.removeRetainedDatabase(f.attemptPath(1)), /database_folder_in_use/);
    f.store.set('retained-database-directories', [f.current.databasePath]);
    // Not while another operation is open.
    const open = f.store.start('backup', crypto.randomUUID(), {}).operation;
    await assert.rejects(operations.removeRetainedDatabase(f.current.databasePath), /operation_in_progress/);
    open.state = 'complete';
    f.store.save(open);
    // Another container mapping a folder above it, or inside it, may use these files; Manager's own mapping and
    // this library's stack mapping a folder above it do not.
    const container = (name: string, source: string, labels: Record<string, string> = {}) =>
      ({ Id: name.padEnd(64, '0'), Name: `/${name}`, State: { Running: false }, Config: { Labels: labels },
        Mounts: [{ Type: 'bind', Source: source, Destination: '/data', RW: true }] });
    // A link to the folder above it, as Docker can report a bind of a symlink.
    await symlink(f.oldRoot, join(f.directory, 'cache-link'));
    for (const [other, source] of [['filebrowser', f.oldRoot], ['backup-tool', join(f.current.databasePath, 'base')],
      ['linked-app', join(f.directory, 'cache-link')]] as const) {
      f.extra.splice(0, f.extra.length, container(other, source));
      await assert.rejects(operations.removeRetainedDatabase(f.current.databasePath),
        (error: Refusal) => error.code === 'database_folder_in_use' && error.detail === `Container ${other} maps this folder.`, other);
    }
    // A link only the host can follow, to the folder above it.
    f.host.links['/srv/apps/linked'] = f.oldRoot;
    f.extra.splice(0, f.extra.length, container('host-linked-app', '/srv/apps/linked'));
    await assert.rejects(operations.removeRetainedDatabase(f.current.databasePath),
      (error: Refusal) => error.code === 'database_folder_in_use' && error.detail === 'Container host-linked-app maps this folder.');
    // A mapping whose real place can't be told, or no host check at all, keeps the folder.
    f.host.links = {};
    f.host.unresolvable = ['/srv/apps/unreadable'];
    f.extra.splice(0, f.extra.length, container('unreadable-app', '/srv/apps/unreadable'));
    await assert.rejects(operations.removeRetainedDatabase(f.current.databasePath),
      (error: Refusal) => error.code === 'database_folder_unverified' && /unreadable-app/.test(error.detail ?? ''));
    f.host.unresolvable = [];
    f.host.unavailable = true;
    f.extra.splice(0, f.extra.length);
    await assert.rejects(operations.removeRetainedDatabase(f.current.databasePath), /database_folder_unverified/);
    f.host.unavailable = false;
    assert.ok((await stat(f.current.databasePath)).isDirectory(), 'kept every time');
    f.extra.splice(0, f.extra.length,
      container('frameleaf-manager', f.directory, { 'app.frameleaf.manager.role': 'controller' }),
      container('frameleaf-test-frameleaf-server-1', f.oldRoot, { 'app.frameleaf.manager': f.current.id }));
    await operations.removeRetainedDatabase(f.current.databasePath);
    await assert.rejects(stat(f.current.databasePath), /ENOENT/);
    assert.deepEqual(f.store.get('retained-database-directories'), []);
  } finally {
    await f.cleanup();
  }
});

test('the host resolver follows links inside the host root, keeps a missing tail and gives up on a loop', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-host-root-')));
  try {
    await mkdir(join(root, 'mnt', 'cache', 'db'), { recursive: true });
    await mkdir(join(root, 'srv'));
    await symlink('/mnt/cache', join(root, 'srv', 'absolute')); // absolute: followed inside the host root
    await symlink('../mnt/cache/db', join(root, 'srv', 'relative'));
    await symlink('/srv/loop-b', join(root, 'srv', 'loop-a'));
    await symlink('/srv/loop-a', join(root, 'srv', 'loop-b'));
    const output = execFileSync(process.execPath, ['-e', hostRealpathScript, root, JSON.stringify([
      '/srv/absolute/db', '/srv/relative', '/srv/absolute/not-yet/x', '/srv/loop-a', '/mnt/cache/./db/../db',
    ])], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), ['/mnt/cache/db', '/mnt/cache/db', '/mnt/cache/not-yet/x', null, '/mnt/cache/db']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the host resolver runs in Manager’s own image with the host read-only and no network, and fails closed', async () => {
  const image = `sha256:${'d'.repeat(64)}`;
  const manager = { Id: 'e'.repeat(64), Image: image, State: { Running: true },
    Config: { Env: ['MANAGER_DATA=/state'], Labels: { 'app.frameleaf.manager.role': 'controller' } } };
  const calls: string[][] = [];
  const docker = { inventory: async () => [manager] } as never;
  const resolve = hostRealpaths(docker, '/state', (async (_binary: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify(['/mnt/cache/db', null]);
  }) as never);
  assert.deepEqual(await resolve(['/srv/a', '/srv/b']), ['/mnt/cache/db', null]);
  const args = calls[0];
  for (const flag of [['--network', 'none'], ['--volume', '/:/host:ro'], ['--cap-drop', 'ALL'], ['--entrypoint', 'node']])
    assert.ok(args.some((arg, i) => arg === flag[0] && args[i + 1] === flag[1]), flag.join(' '));
  assert.ok(args.includes('--read-only') && args.includes(image));
  // A wrong-sized or malformed answer, a failed run or no Manager container is never taken as "nothing found".
  for (const answer of ['["/a"]', '["relative", "/b"]', 'not json'])
    assert.equal(await hostRealpaths(docker, '/state', (async () => answer) as never)(['/srv/a', '/srv/b']), null);
  assert.equal(await hostRealpaths(docker, '/state', (async () => { throw new Error('no docker'); }) as never)(['/a']), null);
  assert.equal(await hostRealpaths({ inventory: async () => [] } as never, '/state')(['/a']), null);
});
