import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Operations } from '../src/operations.js';
import { ServiceOverrides } from '../src/compose.js';
import type { Installation } from '../src/contracts.js';
import type { Docker } from '../src/docker.js';
import { containerText, parseContainerSettings } from '../ui/src/presentation.js';

// Changing the advanced container settings of an installed stack: journaled, re-rendered, cancellable.

// Rendering probes the host's GPU via `docker info` on x64 (up to 10 s on CI runners); keep the test off the host.
process.env.MANAGER_ML_ACCELERATION = 'cpu';

const image = 'ghcr.io/frameleaf/server@sha256:' + 'a'.repeat(64);
const installation = {
  id: 'a'.repeat(12),
  project: 'frameleaf-aaaaaaaaaaaa',
  release: 'frameleaf-v3.2.0-1',
  port: 2283,
  ml: true,
  origin: 'new_library',
  sourceId: null,
  mayHaveWrittenMedia: true,
  mounts: [{ type: 'bind', source: '/mnt/user/photos', target: '/data', readOnly: false }],
  databasePath: '/fixtures/db',
} as unknown as Installation;
const settled = async (store: Store) => {
  for (const deadline = Date.now() + 5000; store.history()[0].state === 'running' && Date.now() < deadline; )
    await new Promise((resolve) => setTimeout(resolve, 5));
  return store.history()[0];
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'manager-container-settings-'));
  const bundle = join(directory, 'bundle');
  await mkdir(bundle);
  await writeFile(join(bundle, 'docker-compose.yml'), JSON.stringify({ services: { database: {}, 'frameleaf-server': {}, 'frameleaf-machine-learning': {} } }));
  const store = new Store(join(directory, 'state'));
  store.set('installation', installation);
  store.set('database-password', 'pw');
  store.set('application-config', { environment: { TZ: 'UTC' }, settings: null, services: { database: { environment: {}, mounts: [], cpus: 2 } } });
  const compose: unknown[][] = [];
  let fail = false;
  const docker = { compose: (...args: unknown[]) => { compose.push(args); return fail ? Promise.reject(new Error('down')) : Promise.resolve(); }, inventory: () => Promise.resolve([]) } as unknown as Docker;
  const releases = { acquire: (tag: string) => Promise.resolve({ directory: bundle, tag, nas: { images: { server: image, machineLearning: image, postgres: image } } }) } as never;
  const operations = new Operations(store, docker, releases, {} as never, [], { verify: () => Promise.resolve() } as never);
  const rendered = async () => JSON.parse(await readFile(join(operations.directory(), 'compose.json'), 'utf8'));
  return { directory, store, operations, compose, rendered, setFail: (value: boolean) => (fail = value) };
}

test('saving new settings journals them, re-renders the stack and brings it up', async () => {
  const { directory, store, operations, compose, rendered } = await fixture();
  try {
    assert.deepEqual(operations.containerSettings(), { services: { database: { environment: {}, mounts: [], cpus: 2 } } });
    const services = ServiceOverrides.parse({ 'frameleaf-server': { environment: { TZ: 'America/Toronto' }, mounts: [{ source: '/mnt/user/archive', target: '/archive', readOnly: true }] } });
    const operation = operations.reconfigure(services, 'key-1');
    assert.equal(operation.kind, 'reconfigure');
    // Idempotent: the same key returns the same operation instead of a second apply.
    assert.equal(operations.reconfigure(services, 'key-1').id, operation.id);
    const done = await settled(store);
    assert.equal(done.state, 'complete', done.error ?? undefined);
    assert.deepEqual(done.completed, ['apply-container-settings', 'start']);
    assert.deepEqual(done.receipts['previous-container-settings'], { database: { environment: {}, mounts: [], cpus: 2 } });
    assert.deepEqual(operations.containerSettings().services, services);
    const stack = await rendered();
    assert.ok(stack.services['frameleaf-server'].volumes.some((m: any) => m.target === '/archive' && m.read_only));
    assert.equal(stack.services['frameleaf-server'].environment.TZ, 'America/Toronto');
    assert.equal(stack.services.database.deploy, undefined);
    assert.deepEqual(compose, [[operations.directory(), installation.project, 'up']]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a folder that shadows a managed mount is refused before anything is journaled; no installation, no route', async () => {
  const { directory, store, operations, compose } = await fixture();
  try {
    assert.throws(
      () => operations.reconfigure(ServiceOverrides.parse({ 'frameleaf-server': { mounts: [{ source: '/x', target: '/data', readOnly: false }] } }), 'key-2'),
      (error: any) => error.code === 'service_override_conflict' && error.detail.includes('/data'),
    );
    assert.throws(
      () => operations.reconfigure(ServiceOverrides.parse({ database: { mounts: [{ source: '/x', target: '/var/lib/postgresql/extra', readOnly: false }] } }), 'key-3'),
      /service_override_conflict/,
    );
    assert.equal(store.history().length, 0);
    assert.deepEqual(compose, []);
    store.set('installation', null);
    assert.throws(() => operations.containerSettings(), /no_installation/);
    assert.throws(() => operations.reconfigure({}, 'key-4'), /no_installation/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed apply blocks other operations until it is resumed or cancelled back to the previous settings', async () => {
  const { directory, store, operations, compose, rendered, setFail } = await fixture();
  try {
    setFail(true);
    const services = ServiceOverrides.parse({ 'frameleaf-server': { memory: '4g' } });
    const operation = operations.reconfigure(services, 'key-5');
    let failed = await settled(store);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.step, 'start');
    assert.equal((await rendered()).services['frameleaf-server'].deploy.resources.limits.memory, '4g');
    assert.ok(operations.history()[0].canCancel);
    assert.throws(() => operations.reconfigure(services, 'key-6'), /operation_in_progress/);
    assert.throws(() => operations.control('restart', 'key-7'), /operation_in_progress/);
    // Resume retries the journaled step; still failing, it stays recoverable.
    operations.resume(operation.id);
    failed = await settled(store);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.completed, ['apply-container-settings']);
    // Cancel renders the previous settings again and brings the stack up with them.
    setFail(false);
    await operations.recover(operation.id);
    const cancelled = store.history()[0];
    assert.equal(cancelled.state, 'complete');
    assert.equal(cancelled.error, 'reconfigure_cancelled_previous_settings_running');
    assert.deepEqual(operations.containerSettings().services, { database: { environment: {}, mounts: [], cpus: 2 } });
    const stack = await rendered();
    assert.equal(stack.services['frameleaf-server'].deploy, undefined);
    assert.equal(stack.services.database.deploy.resources.limits.cpus, '2');
    assert.equal(compose.length, 3);
    assert.equal(store.start('restart', 'key-8', {}).created, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the Services card shows stored settings as text and reads them back unchanged', () => {
  const services = {
    'frameleaf-server': { environment: { TZ: 'UTC', IMMICH_LOG_LEVEL: 'verbose' }, mounts: [{ source: '/mnt/a', target: '/a', readOnly: true }, { source: '/mnt/b', target: '/b', readOnly: false }], memory: '4g' },
    database: { environment: {}, mounts: [], cpus: 1.5 },
  };
  const text = containerText(services);
  assert.deepEqual(text['frameleaf-server'], { environment: 'TZ=UTC\nIMMICH_LOG_LEVEL=verbose', mounts: '/mnt/a:/a:ro\n/mnt/b:/b', memory: '4g', cpus: '' });
  assert.deepEqual(text['frameleaf-machine-learning'], { environment: '', mounts: '', memory: '', cpus: '' });
  for (const id of ['frameleaf-server', 'database'] as const) {
    const { errors, ...parsed } = parseContainerSettings(text[id]);
    assert.deepEqual(errors, []);
    assert.deepEqual(parsed, services[id]);
  }
});
