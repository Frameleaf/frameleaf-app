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
import { ServerCheck, checkHost } from '../src/server-check.js';
import type { Container, Docker } from '../src/docker.js';
import type { Releases, VerifiedRelease } from '../src/releases.js';
import type { Backups } from '../src/backups.js';
import type { PostgresStorage } from '../src/postgres-storage.js';
import { fileHash } from '../src/files.js';

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
      return { platform: 'linux/amd64', version: state.dockerVersion, compose: '2.29.0', dataRoot: '/var/lib/docker', memory: null, processors: null };
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
    assert.deepEqual(result.checks.map((check) => check.id), ['docker', 'media', 'database', 'backups', 'manager', 'port']);
    assert.deepEqual(
      Object.fromEntries(result.checks.map((check) => [check.id, check.status])),
      { docker: 'problem', media: 'ok', database: 'problem', backups: 'ok', manager: 'ok', port: 'problem' },
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
    assert.deepEqual(result.checks.at(-1), { id: 'release', status: 'ok', facts: { tag: f.release.nas.tag } });
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
    assert.deepEqual(result.checks.at(-1), { id: 'release', status: 'problem', code: 'release_architecture_unavailable', detail: 'linux/amd64' });
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
      [['docker', 'problem', 'unsupported_docker_version_or_architecture'], ['media', 'ok', undefined], ['database', 'ok', undefined], ['port', 'problem', 'port_in_use']],
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
