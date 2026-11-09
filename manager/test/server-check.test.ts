// FL-1317 Check this server: the review reports every problem at once, and install start repeats the checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Operations, ReviewInput } from '../src/operations.js';
import { Store } from '../src/store.js';
import { Refusal, type Installation } from '../src/contracts.js';
import { ServerCheck, checkHost, detectPlatform } from '../src/server-check.js';
import type { Container, Docker } from '../src/docker.js';
import type { Releases, VerifiedRelease } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import { fileHash } from '../src/files.js';
import { dockerRoomNeeded, dockerStorageFree, hostPortScript, hostProbes } from '../src/host-probes.js';
import { createServer, type AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const GB = 1024 ** 3;
const publishing = (port: number, running = true): Container =>
  ({
    Id: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    Name: '/other-app',
    State: { Running: running },
    Config: { Labels: {} },
    HostConfig: { PortBindings: { '80/tcp': [{ HostPort: String(port) }] } },
    Mounts: [],
  }) as unknown as Container;

async function fixture({ stateLink = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'manager-server-check-')));
  const media = join(root, 'media'),
    database = join(root, 'database');
  await mkdir(media);
  await mkdir(database);
  // A state folder reached through a link is one Manager refuses to write recovery points through.
  if (stateLink) {
    await mkdir(join(root, 'state-real'));
    await symlink(join(root, 'state-real'), join(root, 'state'));
  }
  const store = new Store(join(root, 'state'));
  const state = {
    dockerVersion: '27.5.1' as string | null,
    containers: [] as Container[],
    inventoryFails: false,
    databaseRefusal: null as string | null,
    acquired: 0,
    pulled: 0,
    // FL-1318 host probes: a server with room, online, nothing else on its ports, and 32 GB of memory.
    memory: 32 * GB as number | null,
    dockerFree: 31 * GB as number | null,
    offline: [] as string[],
    hostBusy: [] as number[],
    hostUnknown: false,
    dockerman: true,
    ownMemory: null as number | null,
  };
  const release = {
    directory: join(root, 'release'),
    nas: {
      tag: 'frameleaf-v1.2.13',
      platforms: ['linux/amd64'],
      images: {
        server: `fixture.invalid/server@sha256:${'a'.repeat(64)}`,
        machineLearning: `fixture.invalid/ml@sha256:${'b'.repeat(64)}`,
        postgres: `fixture.invalid/postgres@sha256:${'c'.repeat(64)}`,
      },
    },
  } as VerifiedRelease;
  const docker = {
    compatibility: async () => {
      if (!state.dockerVersion) throw new Refusal('unsupported_docker_version_or_architecture');
      return { platform: 'linux/amd64', version: state.dockerVersion, compose: '2.29.0', dataRoot: '/var/lib/docker', memory: state.memory, processors: null };
    },
    inventory: async () => {
      if (state.inventoryFails) throw new Error('docker ps timed out');
      return state.containers;
    },
    pull: async () => {
      state.pulled++;
    },
  } as unknown as Docker;
  const releases = {
    acquire: async () => {
      state.acquired++;
      await mkdir(release.directory, { recursive: true });
      return release;
    },
    eligible: async () => ({}),
    verify: async () => release,
  } as unknown as Releases;
  const storage = {
    validate: async (path: string) => {
      if (state.databaseRefusal) throw new Refusal(state.databaseRefusal, 409, path);
      return { root: path };
    },
    allocate: async () => join(database, randomUUID()),
  } as unknown as PostgresStorage;
  const operations = new Operations(store, docker, releases, {} as Backups, [root], storage);
  operations.probes = {
    dockerFree: async () => state.dockerFree,
    reaches: async (url) => !state.offline.some((host) => new URL(url).hostname === host),
    hostFreePorts: async (ports) => (state.hostUnknown ? null : ports.filter((port) => !state.hostBusy.includes(port))),
    dockermanMapped: async () => state.dockerman,
    memory: () => state.ownMemory,
  };
  const input = ReviewInput.parse({
    kind: 'install', tag: release.nas.tag, mediaPath: media, databaseRoot: database, port: 2283, ml: false, lifecycle: 'docker-only',
  });
  return { root, store, state, operations, input, release, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const reviews = (store: Store) =>
  (store.db.prepare("SELECT key FROM settings WHERE key LIKE 'review:%'").all() as { key: string }[]).map((row) => row.key);

test('a server with several problems reports them all in one pass, and nothing is downloaded or stored', async () => {
  const f = await fixture();
  try {
    f.state.dockerVersion = null;
    f.state.databaseRefusal = 'insufficient_database_space';
    f.state.containers = [publishing(2283)];
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, false);
    assert.equal(result.host, 'linux');
    const byId = Object.fromEntries(result.checks.map((check) => [check.id, check]));
    assert.deepEqual(result.checks.map((check) => check.id), ['docker', 'room', 'media', 'database', 'thumbnails', 'backups', 'manager', 'port', 'downloads', 'memory']);
    assert.deepEqual(
      Object.fromEntries(result.checks.map((check) => [check.id, check.status])),
      { docker: 'problem', room: 'ok', media: 'ok', database: 'problem', thumbnails: 'ok', backups: 'ok', manager: 'ok', port: 'problem', downloads: 'ok', memory: 'unknown' },
    );
    assert.equal(byId.docker.code, 'unsupported_docker_version_or_architecture');
    assert.equal(byId.database.code, 'insufficient_database_space');
    assert.equal(byId.port.code, 'port_in_use');
    assert.deepEqual(byId.port.facts, { port: 2283, free: 2284 });
    assert.equal(typeof byId.media.facts?.free, 'number');
    assert.equal(f.state.acquired, 0, 'the release is not fetched while a problem remains');
    assert.equal('id' in result, false);
    assert.deepEqual(reviews(f.store), []);
  } finally {
    await f.cleanup();
  }
});

test('the same folder chosen for photos and the database is refused on both', async () => {
  const f = await fixture();
  process.env.MANAGER_FOLDER_ROOT = f.root;
  try {
    const shared = join(f.root, 'share', 'frameleaf');
    const result = await f.operations.review({ ...f.input, mediaPath: shared, databaseRoot: shared, backupPath: join(f.root, 'share', 'backups') });
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.checks.filter((check) => check.status === 'problem').map((check) => [check.id, check.code]),
      [['media', 'chosen_folders_overlap'], ['database', 'chosen_folders_overlap']],
    );
  } finally {
    delete process.env.MANAGER_FOLDER_ROOT;
    await f.cleanup();
  }
});

test('a problem with Manager’s own folder is its own result, not the backups folder', async () => {
  const f = await fixture({ stateLink: true });
  try {
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.checks.filter((check) => check.id === 'backups' || check.id === 'manager').map((check) => [check.id, check.status, check.code]),
      [['backups', 'ok', undefined], ['manager', 'problem', 'storage_outside_approved_roots']],
    );
  } finally {
    await f.cleanup();
  }
});

test('the next free port skips every port in use', async () => {
  const f = await fixture();
  try {
    f.state.containers = [publishing(2283), publishing(2284), publishing(2285, false)];
    const result = await f.operations.review(f.input);
    assert.deepEqual(result.checks.find((check) => check.id === 'port')?.facts, { port: 2283, free: 2285 });
  } finally {
    await f.cleanup();
  }
});

test('a port Manager could not check is unknown and does not block', async () => {
  const f = await fixture();
  try {
    f.state.inventoryFails = true;
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true);
    const port = result.checks.find((check) => check.id === 'port')!;
    assert.equal(port.status, 'unknown');
    assert.deepEqual(result.checks.find((check) => check.id === 'release'), { id: 'release', status: 'ok', facts: { tag: f.release.nas.tag } });
  } finally {
    await f.cleanup();
  }
});

test('a release built for another processor is a problem, and its bundle is not kept', async () => {
  const f = await fixture();
  try {
    f.release.nas.platforms = ['linux/arm64'];
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, false);
    assert.deepEqual(result.checks.find((check) => check.id === 'release'), { id: 'release', status: 'problem', code: 'release_architecture_unavailable', detail: 'linux/amd64' });
    assert.deepEqual(await readdir(f.root).then((names) => names.includes('release')), false);
  } finally {
    await f.cleanup();
  }
});

test('install start repeats the checks: a port taken after the review refuses before any download', async () => {
  const f = await fixture();
  try {
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true);
    assert.ok(result.checks.every((check) => check.status === 'ok'));
    if (!result.ready) return;
    f.state.containers = [publishing(2283)];
    const operation = f.operations.start(result.id, randomUUID());
    for (let i = 0; i < 200 && f.store.history().find((o) => o.id === operation.id)?.state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const saved = f.store.history().find((o) => o.id === operation.id)!;
    assert.equal(saved.state, 'failed');
    assert.equal(saved.error, 'port_in_use');
    assert.equal(saved.step, 'preflight');
    assert.equal(f.state.pulled, 0);
  } finally {
    await f.cleanup();
  }
});

test('the restore review reports its problems together and removes the unpacked backup', async () => {
  const f = await fixture();
  try {
    const target = {
      id: 'aaaabbbbcccc', project: 'frameleaf-aaaabbbbcccc', release: f.release.nas.tag, port: 2283, ml: false,
      origin: 'new_library', libraryId: 'aaaabbbbcccc', sourceId: null, mayHaveWrittenMedia: true,
      databaseRoot: join(f.root, 'database'), databasePath: join(f.root, 'database', 'old'),
      mounts: [{ type: 'bind', source: join(f.root, 'media'), target: '/data', readOnly: false }],
    } as Installation;
    const backups = {
      restore: async (_snapshot: string, checkpoint: string) => {
        await mkdir(checkpoint);
        await writeFile(join(checkpoint, 'database.dump'), 'fixture dump');
        await writeFile(join(checkpoint, 'recovery.json'), JSON.stringify({
          schemaVersion: 2, mediaIncluded: false, databaseFormat: 'frameleaf-canonical', databasePassword: 'd'.repeat(48),
          application: { environment: {}, settings: null, authority: 'database' },
          dumpSha256: await fileHash(join(checkpoint, 'database.dump')), installation: target,
        }));
      },
    } as unknown as Backups;
    (f.operations as unknown as { backups: Backups }).backups = backups;
    f.state.dockerVersion = null;
    f.state.containers = [publishing(2283)];
    const result = await f.operations.reviewRestore('a'.repeat(64), join(f.root, 'database'));
    assert.equal(result.ready, false);
    assert.deepEqual(
      result.checks.map((check) => [check.id, check.status, check.code]),
      [
        ['docker', 'problem', 'unsupported_docker_version_or_architecture'], ['room', 'ok', undefined], ['media', 'ok', undefined],
        ['database', 'ok', undefined], ['port', 'problem', 'port_in_use'], ['downloads', 'ok', undefined], ['memory', 'unknown', 'memory_unknown'],
      ],
    );
    assert.equal(f.state.acquired, 0);
    assert.deepEqual((await readdir(f.store.directory)).filter((name) => name.startsWith('restore-')), []);
    // FL-1320: a photos drive that isn't mounted is named plainly in the list.
    await rm(join(f.root, 'media'), { recursive: true });
    const gone = await f.operations.reviewRestore('a'.repeat(64), join(f.root, 'database'));
    assert.deepEqual(gone.checks.find((check) => check.id === 'media')?.code, 'media_folder_missing');
  } finally {
    await f.cleanup();
  }
});

test('ServerCheck: warning and unknown never block; the guard refuses with the first problem', async () => {
  const checks = new ServerCheck();
  await checks.run('memory', async () => ({ outcome: { status: 'warning', code: 'low_memory', facts: { bytes: 4 } } }));
  await checks.run('port', async () => { throw new Error('timeout'); }, { unknownOnError: true });
  assert.equal(checks.blocked, false);
  checks.assert();
  await checks.run('docker', async () => { throw new Refusal('compose_v2_required', 409, 'Compose 1.29'); });
  await checks.run('media', async () => { throw new Error('EIO'); });
  assert.equal(checks.blocked, true);
  assert.deepEqual(checks.results.map((r) => [r.id, r.status, r.code]), [
    ['memory', 'warning', 'low_memory'], ['port', 'unknown', 'check_failed'], ['docker', 'problem', 'compose_v2_required'], ['media', 'problem', 'check_failed'],
  ]);
  assert.throws(() => checks.assert(), (error: Refusal) => error.code === 'compose_v2_required' && error.detail === 'Compose 1.29');
});

test('the host that picks the fix steps', () => {
  assert.equal(checkHost('unraid'), 'unraid');
  assert.equal(checkHost('truenas'), 'truenas');
  assert.equal(checkHost('hexos'), 'hexos');
  assert.equal(checkHost('linux'), 'linux');
  assert.equal(checkHost(undefined), 'linux');
});

// FL-1318: Docker storage, downloads, host ports, memory and Unraid's Docker tab.
test('too little room in Docker’s storage is a problem with what is needed and free; less is needed without machine learning', async () => {
  const f = await fixture();
  process.env.MANAGER_ML_ACCELERATION = 'cpu';
  try {
    f.state.dockerFree = 6 * GB;
    const withMl = await f.operations.review({ ...f.input, ml: true });
    assert.equal(withMl.ready, false);
    assert.deepEqual(withMl.checks.find((check) => check.id === 'room'), {
      id: 'room', status: 'problem', code: 'insufficient_docker_space', facts: { needed: dockerRoomNeeded(true), free: 6 * GB },
    });
    assert.equal(dockerRoomNeeded(true), 8 * GB);
    assert.equal(f.state.acquired, 0, 'nothing downloads while Docker has no room');
    const withoutMl = await f.operations.review(f.input);
    assert.equal(withoutMl.ready, true);
    assert.deepEqual(withoutMl.checks.find((check) => check.id === 'room'), { id: 'room', status: 'ok', facts: { needed: 4 * GB, free: 6 * GB } });
    // A GPU build of machine learning needs more.
    assert.ok(dockerRoomNeeded(true, 'cuda') > dockerRoomNeeded(true));
  } finally {
    delete process.env.MANAGER_ML_ACCELERATION;
    await f.cleanup();
  }
});

test('Docker storage Manager can’t read is “couldn’t check” and never blocks', async () => {
  const f = await fixture();
  try {
    f.state.dockerFree = null;
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true);
    assert.deepEqual(result.checks.find((check) => check.id === 'room'), { id: 'room', status: 'unknown', code: 'docker_storage_unreadable', facts: { needed: 4 * GB } });
  } finally {
    await f.cleanup();
  }
});

test('a download host that doesn’t answer is a problem named by host, found before the release is fetched', async () => {
  const f = await fixture();
  try {
    for (const host of ['ghcr.io', 'github.com']) {
      f.state.offline = [host];
      const result = await f.operations.review(f.input);
      assert.equal(result.ready, false);
      assert.deepEqual(result.checks.find((check) => check.id === 'downloads'), { id: 'downloads', status: 'problem', code: 'download_host_unreachable', detail: host });
      assert.equal(result.checks.some((check) => check.id === 'release'), false);
    }
    assert.equal(f.state.acquired, 0);
    f.state.offline = [];
    const online = await f.operations.review(f.input);
    assert.deepEqual(online.checks.find((check) => check.id === 'downloads'), { id: 'downloads', status: 'ok' });
  } finally {
    await f.cleanup();
  }
});

test('a port a host app listens on is in use, and the next free port skips host apps too', async () => {
  const f = await fixture();
  try {
    f.state.hostBusy = [2283, 2284];
    f.state.containers = [publishing(2285)];
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, false);
    assert.deepEqual(result.checks.find((check) => check.id === 'port'), { id: 'port', status: 'problem', code: 'port_in_use', facts: { port: 2283, free: 2286 } });
  } finally {
    await f.cleanup();
  }
});

test('a port a container publishes is left to the container check, so an import can reuse its source’s port', async () => {
  const f = await fixture();
  try {
    // The helper finds the port taken, by the published port of a container the import replaces, not a host app.
    f.state.hostBusy = [2283];
    f.state.containers = [publishing(2283)];
    const replaced = f.state.containers[0].Id;
    const checks = new ServerCheck();
    await (f.operations as unknown as { portCheck: (...args: unknown[]) => Promise<void> }).portCheck(
      checks, 2283, null, { workers: [replaced], containers: [] }, undefined, true,
    );
    assert.deepEqual(checks.results, [{ id: 'port', status: 'ok', facts: { port: 2283 } }]);
  } finally {
    await f.cleanup();
  }
});

test('a host port Manager couldn’t test is “couldn’t check” and never blocks', async () => {
  const f = await fixture();
  try {
    f.state.hostUnknown = true;
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true);
    assert.deepEqual(result.checks.find((check) => check.id === 'port'), { id: 'port', status: 'unknown', code: 'host_port_unchecked', facts: { port: 2283 } });
  } finally {
    await f.cleanup();
  }
});

test('less than 8 GB of memory with machine learning on is worth knowing, not a problem', async () => {
  const f = await fixture();
  try {
    f.state.memory = 4 * GB;
    f.state.dockerFree = 100 * GB;
    const withMl = await f.operations.review({ ...f.input, ml: true });
    assert.equal(withMl.ready, true);
    assert.deepEqual(withMl.checks.find((check) => check.id === 'memory'), { id: 'memory', status: 'warning', code: 'low_memory', facts: { bytes: 4 * GB, ml: true } });
    const withoutMl = await f.operations.review(f.input);
    assert.deepEqual(withoutMl.checks.find((check) => check.id === 'memory'), { id: 'memory', status: 'ok', facts: { bytes: 4 * GB, ml: false } });
    // When Docker can't answer, the memory Manager's own container sees.
    f.state.dockerVersion = null;
    f.state.ownMemory = 6 * GB;
    const noDocker = await f.operations.review({ ...f.input, ml: true });
    assert.deepEqual(noDocker.checks.find((check) => check.id === 'memory'), { id: 'memory', status: 'warning', code: 'low_memory', facts: { bytes: 6 * GB, ml: true } });
    f.state.dockerVersion = '27.5.1';
    // A machine sold as 8 GB reports a little less to Docker; it isn't warned.
    f.state.memory = 7.6 * GB;
    const eight = await f.operations.review({ ...f.input, ml: true });
    assert.equal(eight.checks.find((check) => check.id === 'memory')?.status, 'ok');
  } finally {
    await f.cleanup();
  }
});

test('Unraid’s Docker tab: an unmapped templates folder is a warning; other hosts don’t show the check', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.operations.review(f.input)).checks.some((check) => check.id === 'unraid'), false);
    process.env.MANAGER_PLATFORM = 'unraid';
    f.state.dockerman = false;
    const missing = await f.operations.review(f.input);
    assert.equal(missing.ready, true);
    assert.deepEqual(missing.checks.at(-1), { id: 'unraid', status: 'warning', code: 'dockerman_templates_unmapped' });
    f.state.dockerman = true;
    assert.deepEqual((await f.operations.review(f.input)).checks.at(-1), { id: 'unraid', status: 'ok' });
  } finally {
    delete process.env.MANAGER_PLATFORM;
    await f.cleanup();
  }
});

test('Unraid found from its docker.cfg counts as Unraid when MANAGER_PLATFORM isn’t set', async () => {
  const f = await fixture();
  try {
    delete process.env.MANAGER_PLATFORM;
    detectPlatform('unraid');
    f.state.dockerman = false;
    const result = await f.operations.review(f.input);
    assert.equal(result.host, 'unraid');
    assert.equal(f.operations.checkHost(), 'unraid');
    assert.deepEqual(result.checks.at(-1), { id: 'unraid', status: 'warning', code: 'dockerman_templates_unmapped' });
    // An explicit platform still wins.
    process.env.MANAGER_PLATFORM = 'truenas';
    assert.equal(f.operations.checkHost(), 'truenas');
  } finally {
    detectPlatform(undefined);
    delete process.env.MANAGER_PLATFORM;
    await f.cleanup();
  }
});

test('install start repeats the new checks: Docker storage that filled since the review refuses before any download', async () => {
  const f = await fixture();
  try {
    const result = await f.operations.review(f.input);
    assert.equal(result.ready, true);
    if (!result.ready) return;
    f.state.dockerFree = GB;
    const operation = f.operations.start(result.id, randomUUID());
    for (let i = 0; i < 200 && f.store.history().find((o) => o.id === operation.id)?.state === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const saved = f.store.history().find((o) => o.id === operation.id)!;
    assert.equal(saved.state, 'failed');
    assert.equal(saved.error, 'insufficient_docker_space');
    assert.equal(saved.step, 'preflight');
    assert.equal(f.state.pulled, 0);
  } finally {
    await f.cleanup();
  }
});

test('Docker’s free space is read from Manager’s own layer only inside a container on a layered driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-docker-free-'));
  try {
    const marker = join(root, '.dockerenv'),
      mounts = join(root, 'mounts');
    const free = async () => 31 * GB;
    await writeFile(mounts, 'overlay / overlay rw,relatime,lowerdir=/a,upperdir=/b 0 0\nproc /proc proc rw 0 0\n');
    assert.equal(await dockerStorageFree(mounts, marker, free), null, 'not in a container');
    await writeFile(marker, '');
    assert.equal(await dockerStorageFree(mounts, marker, free), 31 * GB);
    await writeFile(mounts, '/dev/sda1 / ext4 rw 0 0\n');
    assert.equal(await dockerStorageFree(mounts, marker, free), null, 'a root that isn’t Docker’s storage');
    assert.equal(await dockerStorageFree(join(root, 'missing'), marker, free), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the host port helper reports only the ports it could listen on', async () => {
  const busy = createServer();
  await new Promise<void>((resolve) => busy.listen({ port: 0, host: '0.0.0.0' }, resolve));
  const taken = (busy.address() as AddressInfo).port;
  try {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen({ port: 0, host: '0.0.0.0' }, resolve));
    const open = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const { stdout } = await run(process.execPath, ['-e', hostPortScript, JSON.stringify([taken, open])]);
    assert.deepEqual(JSON.parse(stdout), [open]);
  } finally {
    busy.close();
  }
});

test('the host port helper is Manager’s image on the host network, and anything unexpected is “couldn’t check”', async () => {
  const image = `sha256:${'e'.repeat(64)}`;
  const controller = {
    Id: 'f'.repeat(64), State: { Running: true }, Image: image,
    Config: { Labels: { 'app.frameleaf.manager.role': 'controller' }, Env: ['MANAGER_DATA=/data'] },
  } as unknown as Container;
  const calls: string[][] = [];
  let output = '[2284]';
  const docker = { inventory: async () => [controller] } as unknown as Docker;
  const probes = hostProbes(docker, '/data', (async (_binary: string, args: string[]) => {
    calls.push(args);
    return output;
  }) as never);
  assert.deepEqual(await probes.hostFreePorts([2283, 2284]), [2284]);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 6), ['run', '--rm', '--pull', 'never', '--network', 'host']);
  assert.ok(args.includes(image) && args.includes('--read-only') && args.at(-1) === '[2283,2284]');
  output = 'not json';
  assert.equal(await probes.hostFreePorts([2283]), null);
  const elsewhere = hostProbes(docker, '/other', (async () => '[2283]') as never);
  assert.equal(await elsewhere.hostFreePorts([2283]), null, 'no controller for this Manager');
});
