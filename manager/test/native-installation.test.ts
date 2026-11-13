import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, Refusal } from '../src/contracts.js';
import { Store } from '../src/store.js';
import {
  NativeService,
  validateNativePorts,
} from '../src/runtime/native-service.js';
import type { NativeRuntime } from '../src/runtime/native.js';

const unavailable = async () => {
  throw new Refusal('native_action_unavailable');
};
const runtime = {
  status: () => ({ state: 'stopped' }),
  identity: {
    runtime: 'native',
    installationId: 'a'.repeat(12),
    fingerprint: 'd'.repeat(64),
  },
  start: unavailable,
  stop: unavailable,
  checkpoint: unavailable,
  startRestorePreparation: unavailable,
  finalizeRestore: unavailable,
  selectRestore: unavailable,
  verifyRestore: unavailable,
  prepareRestore: unavailable,
  startCheckpointCleanup: unavailable,
  startDatabase: unavailable,
  cleanupCheckpoint: unavailable,
} as unknown as NativeRuntime;

async function fixture(run: (f: { root: string; store: Store; bootstrap: any; settings: () => string }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'frameleaf-native-installation-')));
  const store = new Store(join(root, 'manager'));
  const bootstrap = {
    protocolVersion: 2,
    backupKey: 'k'.repeat(43),
    installation: {
      runtime: 'native',
      id: 'a'.repeat(12),
      secureInstallationId: '11111111-1111-4111-8111-111111111111',
      controller: join(root, 'controller'),
      candidate: join(root, 'runtime'),
      state: join(root, 'state'),
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54329,
      apiPort: 2283,
    },
    controllerSha256: 'e'.repeat(64),
    backupEngine: { executable: join(root, 'backup-engine'), sha256: 'f'.repeat(64) },
    tls: { certificatePem: 'synthetic certificate', privateKeyPem: 'synthetic private key' },
    name: 'Native library',
    release: 'frameleaf-v3.0.0-1',
    password: 'synthetic native database password',
  };
  const settings = () => JSON.stringify(store.db.prepare('SELECT * FROM settings ORDER BY key').all());
  try {
    await run({ root, store, bootstrap, settings });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
const start = (store: Store, bootstrap: unknown) => new NativeService(store, bootstrap as never, runtime);
const ports = (bootstrap: any, databasePort: number, apiPort: number) => ({
  ...bootstrap,
  installation: { ...bootstrap.installation, databasePort, apiPort },
});
const stored = (store: Store) => store.get<any>('native-installation');

test('changed database and photo ports are configuration: accepted without a transition, recorded atomically', async () => {
  await fixture(async ({ store, bootstrap, settings }) => {
    start(store, bootstrap);
    const original = stored(store).fingerprint;
    const moved = ports(bootstrap, 54400, 2290);
    const service = start(store, moved);
    assert.equal(service.installation().port, 2290);
    assert.equal(stored(store).descriptor.installation.databasePort, 54400);
    assert.equal(stored(store).fingerprint, digest(stored(store).descriptor));
    assert.notEqual(stored(store).fingerprint, original);
    // The same configuration starts again, and so does a move back.
    start(store, moved);
    start(store, bootstrap);
    assert.equal(stored(store).fingerprint, original);
    // Nothing but the ports rides along, and the ports must still be a valid pair.
    const before = settings();
    for (const value of [
      { ...moved, name: 'different' },
      { ...moved, release: 'frameleaf-v3.0.0-2' },
      { ...moved, installation: { ...moved.installation, state: moved.installation.state + '-other' } },
      { ...moved, installation: { ...moved.installation, manifestSha256: '0'.repeat(64) } },
      { ...moved, controllerSha256: '0'.repeat(64) },
      ports(bootstrap, 2283, 2283),
      ports(bootstrap, 0, 2283),
    ]) {
      assert.throws(() => start(store, value));
      assert.equal(settings(), before);
    }
  });
});
test('a port change waits for a store with no operation in flight and never rewrites it while one is', async () => {
  await fixture(async ({ store, bootstrap, settings }) => {
    start(store, bootstrap);
    const before = settings();
    const { operation } = store.start('start', 'synthetic-active', {});
    for (const state of ['running', 'interrupted', 'failed'] as const) {
      operation.state = state;
      store.save(operation);
      assert.throws(() => start(store, ports(bootstrap, 54400, 2290)), /operation_in_progress/);
      assert.equal(settings(), before);
      // The unchanged configuration is not a change, so the library stays startable.
      start(store, bootstrap);
    }
    operation.state = 'complete';
    store.save(operation);
    start(store, ports(bootstrap, 54400, 2290));
  });
});
test('a package transition and a port change combine, and an applied transition does not block later port changes', async () => {
  await fixture(async ({ store, bootstrap }) => {
    start(store, bootstrap);
    const next = {
      ...ports(bootstrap, 54400, 2290),
      release: 'frameleaf-v3.0.0-2',
      installation: {
        ...bootstrap.installation,
        databasePort: 54400,
        apiPort: 2290,
        candidate: bootstrap.installation.candidate + '-next',
        manifestSha256: '9'.repeat(64),
        sourceRevision: '8'.repeat(40),
      },
      installationTransition: { operationId: randomUUID(), fromFingerprint: stored(store).fingerprint },
    };
    start(store, next);
    assert.equal(stored(store).descriptor.installation.apiPort, 2290);
    assert.equal(stored(store).descriptor.release, 'frameleaf-v3.0.0-2');
    // Desktop keeps sending the applied transition; the ports may still move under it.
    start(store, next);
    start(store, ports(next, 54329, 2283));
    assert.equal(stored(store).descriptor.installation.apiPort, 2283);
    // An applied transition never explains a different package.
    assert.throws(() => start(store, { ...ports(next, 54329, 2283), release: 'frameleaf-v3.0.0-3' }), /native_installation_changed/);
    assert.throws(
      () => start(store, { ...next, installationTransition: { ...next.installationTransition, fromFingerprint: '0'.repeat(64) } }),
      /native_installation_changed/,
    );
  });
});

test('neither configured port may be the one Manager itself serves on', () => {
  const origin = 'https://127.0.0.1:19443';
  validateNativePorts({ databasePort: 54400, apiPort: 2290 }, origin);
  validateNativePorts({ databasePort: 9443, apiPort: 2283 }, origin);
  for (const [databasePort, apiPort] of [
    [19443, 2283],
    [54329, 19443],
  ])
    assert.throws(
      () => validateNativePorts({ databasePort, apiPort }, origin),
      /native_ports_invalid/,
    );
  assert.throws(
    () => validateNativePorts({ databasePort: 54329, apiPort: 2283 }, 'https://192.168.1.20:9443'),
    /native_manager_origin_invalid/,
  );
});
test('a bootstrap without the new fields is admitted exactly as before', async () => {
  await fixture(async ({ store, bootstrap, settings }) => {
    start(store, bootstrap);
    const before = settings();
    start(store, bootstrap);
    assert.equal(settings(), before);
    assert.deepEqual(Object.keys(stored(store).descriptor), [
      'protocolVersion',
      'installation',
      'controllerSha256',
      'backupEngine',
      'name',
      'release',
      'tlsCertificatePemSha256',
    ]);
    assert.throws(() => start(store, { ...bootstrap, tls: { ...bootstrap.tls, certificatePem: 'another' } }), /native_installation_changed/);
    assert.equal(settings(), before);
  });
});
