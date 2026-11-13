import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { digest, Refusal, sha256 } from '../src/contracts.js';
import { Store } from '../src/store.js';
import {
  NativeService,
  validateNativePorts,
} from '../src/runtime/native-service.js';
import {
  NATIVE_TLS_GRACE_MS,
  nativeTlsRotationMessage,
} from '../src/runtime/native-installation.js';
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

type Identity = { certificatePem: string; privateKeyPem: string };
/** A self-signed identity like the one Desktop mints: `ec` is P-256, as rcgen generates. */
function identity(root: string, kind: 'ec' | 'rsa' = 'ec'): Identity {
  const name = join(root, randomUUID());
  if (kind === 'ec')
    execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.sec1`], { stdio: 'ignore' });
  else execFileSync('openssl', ['genrsa', '-out', `${name}.sec1`, '2048'], { stdio: 'ignore' });
  execFileSync('openssl', ['pkcs8', '-topk8', '-nocrypt', '-in', `${name}.sec1`, '-out', `${name}.key`], { stdio: 'ignore' });
  execFileSync(
    'openssl',
    ['req', '-x509', '-new', '-key', `${name}.key`, '-out', `${name}.crt`, '-days', '30', '-subj', '/CN=Frameleaf Manager'],
    { stdio: 'ignore' },
  );
  return {
    certificatePem: readFileSync(`${name}.crt`, 'utf8'),
    privateKeyPem: readFileSync(`${name}.key`, 'utf8'),
  };
}
/** The handover Desktop sends: the outgoing key signs the hash of the certificate that replaces it. */
function handover(from: Identity, to: Identity, operationId = randomUUID(), installationId = 'a'.repeat(12)) {
  return {
    operationId,
    previousCertificatePem: from.certificatePem,
    signature: sign(
      'sha256',
      Buffer.from(
        nativeTlsRotationMessage(
          installationId,
          operationId,
          sha256(from.certificatePem),
          sha256(to.certificatePem),
        ),
      ),
      createPrivateKey(from.privateKeyPem),
    ).toString('base64'),
  };
}
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
    tls: identity(root),
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

for (const kind of ['ec', 'rsa'] as const)
  test(`a rotated ${kind} certificate is accepted only with a handover signed by the certificate it replaces`, async () => {
    await fixture(async ({ root, store, settings, ...rest }) => {
      const bootstrap = { ...rest.bootstrap, tls: identity(root, kind) };
      start(store, bootstrap);
      const next = identity(root, kind),
        stranger = identity(root, kind);
      const rotated = { ...bootstrap, tls: next };
      const before = settings();
      const good = handover(bootstrap.tls, next);
      for (const tlsRotation of [
        undefined,
        // Signed by a key that is not the stored certificate's.
        { ...handover(stranger, next), previousCertificatePem: bootstrap.tls.certificatePem },
        // A real handover, but from a certificate this store never accepted.
        handover(stranger, next),
        // A handover to some other certificate, or for another operation or installation.
        handover(bootstrap.tls, stranger),
        { ...good, operationId: randomUUID() },
        handover(bootstrap.tls, next, randomUUID(), 'b'.repeat(12)),
        { ...good, signature: Buffer.from('not a signature').toString('base64') },
        { ...good, previousCertificatePem: 'not a certificate' },
      ]) {
        assert.throws(() => start(store, { ...rotated, tlsRotation }), /native_installation_changed/);
        assert.equal(settings(), before);
      }
      for (const malformed of [{ ...good, extra: true }, { ...good, signature: '***' }, { ...good, operationId: 'x' }])
        assert.throws(() => start(store, { ...rotated, tlsRotation: malformed }));
      assert.equal(settings(), before);
      start(store, { ...rotated, tlsRotation: good });
      assert.equal(stored(store).descriptor.tlsCertificatePemSha256, sha256(next.certificatePem));
      assert.equal(stored(store).fingerprint, digest(stored(store).descriptor));
      // Idempotent: with the handover resent, and without it once it is applied.
      const after = settings();
      start(store, { ...rotated, tlsRotation: good });
      start(store, rotated);
      assert.equal(settings(), after);
      for (const secret of [next.privateKeyPem, bootstrap.tls.privateKeyPem, bootstrap.password])
        assert.ok(!after.includes(secret));
    });
  });
test('the replaced certificate still starts Manager during the grace period, and only then', async (t) => {
  await fixture(async ({ root, store, bootstrap, settings }) => {
    start(store, bootstrap);
    const original = stored(store).fingerprint;
    const next = identity(root);
    const rotated = { ...bootstrap, tls: next, tlsRotation: handover(bootstrap.tls, next) };
    const began = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now: began });
    start(store, rotated);
    assert.deepEqual(
      { previous: store.get<any>('native-tls-rotation').previous, until: store.get<any>('native-tls-rotation').until },
      { previous: sha256(bootstrap.tls.certificatePem), until: began + NATIVE_TLS_GRACE_MS },
    );
    // A Desktop that rolled back presents the certificate it had: accepted, and current again.
    t.mock.timers.setTime(began + NATIVE_TLS_GRACE_MS - 1);
    start(store, bootstrap);
    assert.equal(stored(store).fingerprint, original);
    assert.equal(store.get('native-tls-rotation'), null);
    // Going forward again needs the handover again; the grace period never moves a store forward.
    const { tlsRotation, ...unsigned } = rotated;
    assert.throws(() => start(store, unsigned), /native_installation_changed/);
    start(store, rotated);
    // Once the period has passed the replaced certificate is refused and nothing is rewritten.
    t.mock.timers.setTime(began + 2 * NATIVE_TLS_GRACE_MS);
    const before = settings();
    assert.throws(() => start(store, bootstrap), /native_installation_changed/);
    assert.equal(settings(), before);
    start(store, rotated);
    // A certificate that was never this store's is refused at any time.
    assert.throws(() => start(store, { ...bootstrap, tls: identity(root) }), /native_installation_changed/);
  });
});
test('a rotation waits for an idle store, combines with a port change, and survives a second rotation', async () => {
  await fixture(async ({ root, store, bootstrap, settings }) => {
    start(store, bootstrap);
    const second = identity(root),
      third = identity(root);
    const rotated = { ...ports(bootstrap, 54400, 2290), tls: second, tlsRotation: handover(bootstrap.tls, second) };
    const before = settings();
    const { operation } = store.start('backup', 'synthetic-active', {});
    assert.throws(() => start(store, rotated), /operation_in_progress/);
    assert.equal(settings(), before);
    operation.state = 'complete';
    store.save(operation);
    start(store, rotated);
    assert.equal(stored(store).descriptor.installation.apiPort, 2290);
    start(store, { ...rotated, tls: third, tlsRotation: handover(second, third) });
    assert.equal(store.get<any>('native-tls-rotation').previous, sha256(second.certificatePem));
    // The first certificate is two rotations old: its grace ended when the second was replaced.
    assert.throws(() => start(store, ports(bootstrap, 54400, 2290)), /native_installation_changed/);
    // A handover against an empty store is not a first start.
    const empty = new Store(join(root, 'empty'));
    try {
      assert.throws(() => start(empty, rotated), /native_installation_changed/);
      assert.equal(empty.get('native-installation'), null);
    } finally {
      empty.close();
    }
  });
});
test('the handover text is the one Desktop signs', () => {
  // The same vector is asserted in Frameleaf Desktop's manager_tls tests.
  assert.equal(
    nativeTlsRotationMessage(
      'a'.repeat(12),
      '11111111-1111-4111-8111-111111111111',
      sha256('previous certificate'),
      sha256('next certificate'),
    ),
    '["frameleaf-manager/tls-rotation/v1","aaaaaaaaaaaa","11111111-1111-4111-8111-111111111111","2bc7e50b728123932b06aab01b3da0ca6252a1d098a6acddb0cb49d7259736b1","dd63fac2b87aa649854359fe02d928d097ca45fcb5d85aaa472d064cb67ad69b"]',
  );
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
