import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  realpath,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { digest, Refusal, sha256 } from '../src/contracts.js';
import { Store } from '../src/store.js';
import {
  NativeService,
  readNativeBootstrap,
  protectNativeController,
  nativeControllerAclSafe,
  createNativeService,
  validateNativeTls,
} from '../src/runtime/native-service.js';
import type { NativeRuntime } from '../src/runtime/native.js';

const password = 'synthetic native database password';
async function fixture(run: (f: any) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-native-service-')),
  );
  const store = new Store(join(root, 'manager'));
  const controller = join(root, 'controller');
  await writeFile(controller, 'synthetic controller', { mode: 0o700 });
  const engine = join(root, 'backup-engine');
  await writeFile(engine, 'synthetic backup engine', { mode: 0o700 });
  const installation = {
    runtime: 'native',
    id: 'a'.repeat(12),
    secureInstallationId: '11111111-1111-4111-8111-111111111111',
    controller,
    candidate: join(root, 'runtime'),
    state: join(root, 'state'),
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54329,
    apiPort: 2283,
  };
  const bootstrap = {
    protocolVersion: 2,
    backupKey: 'k'.repeat(43),
    installation,
    controllerSha256: sha256('synthetic controller'),
    backupEngine: {
      executable: engine,
      sha256: sha256('synthetic backup engine'),
    },
    tls: {
      certificatePem: 'synthetic certificate',
      privateKeyPem: 'synthetic private key',
    },
    name: 'Native library',
    release: 'frameleaf-v3.0.0-1',
    password,
  };
  const effects: string[] = [];
  const runtime: NativeRuntime = {
    status: () => ({ state: 'stopped' }),
    identity: {
      runtime: 'native',
      installationId: installation.id,
      fingerprint: 'd'.repeat(64),
    },
    start: async () => {
      effects.push('start');
      return {
        protocolVersion: 1,
        state: 'running',
        secureInstallationId: '11111111-1111-4111-8111-111111111111',
        manifestSha256: installation.manifestSha256,
        sourceRevision: installation.sourceRevision,
        certified: false,
      };
    },
    stop: async () => {
      effects.push('stop');
      return { protocolVersion: 1, state: 'stopped' };
    },
    checkpoint: async () => {
      throw new Refusal('native_checkpoint_unavailable');
    },
    startRestorePreparation: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    finalizeRestore: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    selectRestore: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    verifyRestore: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    prepareRestore: async () => {
      throw new Refusal('native_restore_unavailable');
    },
    startCheckpointCleanup: async () => {
      throw new Refusal('native_checkpoint_unavailable');
    },
    startDatabase: async () => {
      throw new Refusal('native_checkpoint_unavailable');
    },
    cleanupCheckpoint: async () => {
      throw new Refusal('native_checkpoint_unavailable');
    },
  };
  try {
    await run({ root, store, controller, bootstrap, runtime, effects });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
const read = (value: unknown) =>
  readNativeBootstrap(
    Readable.from([Buffer.from(JSON.stringify(value) + '\n')]),
  );
test('native bootstrap is bounded, complete, strict and keeps credentials out of persisted/public state', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    const parsed = await read(bootstrap);
    const service = new NativeService(store, parsed, runtime);
    assert.deepEqual(service.installation(), {
      id: bootstrap.installation.id,
      name: 'Native library',
      release: bootstrap.release,
      port: 2283,
      runtime: 'native',
    });
    assert.ok(!JSON.stringify(service.installation()).includes(password));
    assert.equal(await service.backupPassword(), bootstrap.backupKey);
    assert.ok(
      !JSON.stringify(service.installation()).includes(bootstrap.backupKey),
    );
    assert.ok(
      !JSON.stringify(store.get('native-installation')).includes(
        bootstrap.backupKey,
      ),
    );
    assert.ok(
      !JSON.stringify(store.get('native-installation')).includes(password),
    );
    assert.ok(
      !JSON.stringify(store.get('native-installation')).includes(
        bootstrap.tls.privateKeyPem,
      ),
    );
    for (const value of [
      { ...bootstrap, extra: true },
      {
        ...bootstrap,
        installation: {
          ...bootstrap.installation,
          secureInstallationId: undefined,
        },
      },
      {
        ...bootstrap,
        installation: {
          ...bootstrap.installation,
          secureInstallationId: '00000000-0000-0000-0000-000000000000',
        },
      },
      {
        ...bootstrap,
        installation: {
          ...bootstrap.installation,
          secureInstallationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        },
      },
      { ...bootstrap, password: 'x\nsecret' },
      {
        ...bootstrap,
        installation: { ...bootstrap.installation, apiPort: 54329 },
      },
      { ...bootstrap, controllerSha256: '0'.repeat(64) },
      { ...bootstrap, backupEngine: undefined },
      { ...bootstrap, backupKey: undefined },
      { ...bootstrap, backupKey: 'short' },
      { ...bootstrap, password: bootstrap.backupKey },
      { ...bootstrap, backupKey: 'k'.repeat(42) + '\n' },
      {
        ...bootstrap,
        backupEngine: { executable: 'restic', sha256: 'a'.repeat(64) },
      },
      {
        ...bootstrap,
        backupEngine: { ...bootstrap.backupEngine, sha256: '0'.repeat(64) },
      },
      {
        ...bootstrap,
        backupEngine: { ...bootstrap.backupEngine, extra: true },
      },
    ])
      await assert.rejects(read(value));
    await assert.rejects(readNativeBootstrap(Readable.from(['{}'])));
    await assert.rejects(
      readNativeBootstrap(Readable.from([Buffer.from([0xff, 10])])),
    );
    await assert.rejects(
      readNativeBootstrap(
        Readable.from([JSON.stringify(bootstrap) + '\n{}\n']),
      ),
    );
    await assert.rejects(
      readNativeBootstrap(Readable.from(['x'.repeat(16385)])),
    );
    const hanging = new Readable({ read() {} });
    await assert.rejects(readNativeBootstrap(hanging, 10));
    assert.equal(hanging.destroyed, true);
  });
});
test('native bootstrap binds the engine bytes, physical path and installation fingerprint', async () => {
  await fixture(async ({ root, bootstrap, store, runtime }) => {
    const link = join(root, 'engine-link');
    await symlink(bootstrap.backupEngine.executable, link);
    await assert.rejects(
      read({
        ...bootstrap,
        backupEngine: { ...bootstrap.backupEngine, executable: link },
      }),
    );
    const service = new NativeService(store, bootstrap, runtime);
    assert.equal(typeof service.backupCommand, 'function');
    assert.deepEqual(
      store.get('native-installation').descriptor.backupEngine,
      bootstrap.backupEngine,
    );
    assert.throws(
      () =>
        new NativeService(
          store,
          {
            ...bootstrap,
            backupEngine: { ...bootstrap.backupEngine, sha256: 'f'.repeat(64) },
          },
          runtime,
        ),
      /native_installation_changed/,
    );
    await writeFile(bootstrap.backupEngine.executable, 'changed engine');
    await assert.rejects(read(bootstrap));
  });
});
test('native bootstrap refuses linked or changed controllers', async () => {
  await fixture(async ({ root, bootstrap, controller }) => {
    const link = join(root, 'link');
    await symlink(controller, link);
    await assert.rejects(
      read({
        ...bootstrap,
        installation: { ...bootstrap.installation, controller: link },
      }),
    );
    if (process.platform !== 'win32') {
      await chmod(controller, 0o777);
      await assert.rejects(read(bootstrap));
      await chmod(controller, 0o600);
      await assert.rejects(read(bootstrap));
      await chmod(controller, 0o700);
    }
    await writeFile(controller, 'changed controller');
    await assert.rejects(read(bootstrap));
  });
});
test('native lifecycle dispatch binds installation, journals effects, retries and never falls through to Docker backup', async () => {
  await fixture(async ({ store, bootstrap, runtime, effects }) => {
    const service = new NativeService(store, await read(bootstrap), runtime);
    const key = randomUUID(),
      started = service.control('start', key, bootstrap.installation.id);
    assert.equal((await service.wait(started.id)).state, 'complete');
    assert.equal(
      service.control('start', key, bootstrap.installation.id).id,
      started.id,
    );
    assert.deepEqual(effects, ['start']);
    assert.throws(
      () => service.control('stop', randomUUID(), 'f'.repeat(12)),
      /installation_changed/,
    );
    assert.throws(
      () => service.control('backup', randomUUID()),
      /native_action_unavailable/,
    );
    const stopped = service.control('stop', randomUUID());
    await service.wait(stopped.id);
    assert.deepEqual(effects, ['start', 'stop']);
    assert.equal(store.history().length, 2);
  });
});
test('native selection refuses Docker state, descriptor changes and runtime identity mismatch', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    const parsed = await read(bootstrap);
    store.set('installation', { id: 'e'.repeat(12) });
    assert.throws(
      () => new NativeService(store, parsed, runtime),
      /manager_runtime_changed/,
    );
    store.db.prepare('DELETE FROM settings WHERE key=?').run('installation');
    assert.throws(
      () =>
        new NativeService(store, parsed, {
          ...runtime,
          identity: { ...runtime.identity, installationId: 'f'.repeat(12) },
        }),
      /native_installation_changed/,
    );
    new NativeService(store, parsed, runtime);
    assert.throws(
      () =>
        new NativeService(
          store,
          {
            ...parsed,
            installation: {
              ...parsed.installation,
              state: parsed.installation.state + '-other',
            },
          },
          runtime,
        ),
      /native_installation_changed/,
    );
  });
});

test('production native service rechecks controller before launch and cold inspection', async () => {
  await fixture(async ({ store, bootstrap, controller }) => {
    const parsed = await read(bootstrap);
    const service = new NativeService(store, parsed);
    await writeFile(controller, 'replaced after bootstrap');
    const op = service.control('start', randomUUID());
    const result = await service.wait(op.id);
    assert.equal(result.state, 'failed');
    assert.equal(result.error, 'native_controller_changed');
    await assert.rejects(
      service.runtime.stop(),
      /native_controller_unprotected|native_controller_protection_unavailable/,
    );
  });
});

test('cancel during controller verification never fetches database credentials or spawns a child', async () => {
  await fixture(async ({ bootstrap }) => {
    const { NativeHost } = await import('../src/runtime/native.js');
    let release!: () => void;
    let credentials = 0;
    const verification = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = new NativeHost(
      bootstrap.installation,
      async () => {
        credentials++;
        return password;
      },
      () => verification,
    );
    const starting = host.start();
    const stopping = host.stop();
    release();
    await assert.rejects(starting, /native_start_cancelled/);
    await assert.rejects(stopping, /native_start_cancelled/);
    assert.equal(credentials, 0);
  });
});

test('installed execution authority refuses writable/user-owned development trees', async () => {
  await fixture(async ({ controller }) => {
    await assert.rejects(protectNativeController(controller));
  });
});
test(
  'installed execution authority accepts a protected system executable on POSIX',
  { skip: process.platform === 'win32' },
  async () => {
    await protectNativeController(await realpath('/bin/echo'));
  },
);

test('macOS ACL check rejects mutation grants to other users, deny ACLs, malformed output and diagnostics', () => {
  assert.equal(
    nativeControllerAclSafe(
      '-rwxr-xr-x  1 root wheel 128 Oct 17 /bin/helper\n',
      '',
    ),
    true,
  );
  assert.equal(
    nativeControllerAclSafe(
      '-rwxr-xr-x@ 1 root wheel 128 Oct 17 /bin/helper\n',
      '',
    ),
    true,
  );
  for (const output of [
    'drwxr-xr-x+ 1 root wheel 128 Oct 17 /protected\n 0: user:other allow add_file,delete_child\n',
    'drwxr-xr-x+ 1 root wheel 128 Oct 17 /protected\n 0: everyone deny delete\n',
    'drwxr-xr-x+ 1 root wheel 128 Oct 17 /protected\n',
    'unexpected',
  ])
    assert.equal(nativeControllerAclSafe(output, ''), false);
  assert.equal(
    nativeControllerAclSafe('-rwxr-xr-x 1 root wheel helper\n', 'ls failed'),
    false,
  );
});
test('production bootstrap refuses unprotected installation before persisting binding', async () => {
  await fixture(async ({ store, bootstrap }) => {
    await assert.rejects(
      createNativeService(
        store,
        Readable.from([JSON.stringify(bootstrap) + '\n']),
        'https://manager.test:9443',
      ),
    );
    assert.equal(store.get('native-installation'), null);
  });
});

test('native TLS refuses malformed private input with a stable public error', () => {
  const marker = 'synthetic private key must never be reflected';
  for (const origin of [
    'http://manager.test:9443',
    'https://manager.test:9443/path',
    'https://manager.test:9443',
  ]) {
    assert.throws(
      () =>
        validateNativeTls(
          { certificatePem: 'invalid certificate', privateKeyPem: marker },
          origin,
        ),
      (error) =>
        error instanceof Error &&
        error.message === 'native_tls_invalid' &&
        !error.message.includes(marker),
    );
  }
});

test('native readiness receipt contains only the verified installation binding', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    const service = new NativeService(store, bootstrap, runtime);
    assert.deepEqual(service.ready('https://127.0.0.1:9443'), {
      protocolVersion: 2,
      state: 'ready',
      installationId: bootstrap.installation.id,
      manifestSha256: bootstrap.installation.manifestSha256,
      origin: 'https://127.0.0.1:9443',
    });
    assert.throws(
      () => service.ready('https://0.0.0.0:9443'),
      /native_manager_origin_invalid/,
    );
  });
});

test('native recovery lists safe backup metadata and prepares a review without host actions', async () => {
  await fixture(async ({ store, bootstrap, runtime, effects }) => {
    const { createHash } = await import('node:crypto');
    const { mkdir } = await import('node:fs/promises');
    const { createNativeRecovery } =
      await import('../src/runtime/native-recovery.js');
    const bytes = Buffer.from('PGDMP synthetic native review');
    const operation = { id: randomUUID(), createdAt: 1234 };
    const checkpoint = {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: operation.id,
      manifestSha256: bootstrap.installation.manifestSha256,
      sourceRevision: bootstrap.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: {
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    };
    const recovery = createNativeRecovery(
      {
        installation: bootstrap.installation,
        libraryId: bootstrap.installation.id,
        name: bootstrap.name,
        release: bootstrap.release,
        operation,
      },
      checkpoint,
    );
    const snapshot = '1'.repeat(64);
    let index = [
      {
        id: snapshot,
        time: '2026-10-18T00:00:00Z',
        paths: ['/private/backup/staging'],
      },
    ];
    const backups = {
      list: async () => index,
      restore: async (id, directory) => {
        assert.equal(id, snapshot);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, 'database.dump'), bytes, {
          mode: 0o600,
        });
        await writeFile(
          join(directory, 'recovery.json'),
          JSON.stringify(recovery),
          { mode: 0o600 },
        );
      },
    };
    const service = new NativeService(
      store,
      bootstrap,
      runtime,
      backups as never,
    );
    assert.equal(typeof service.listRestoreBackups, 'function');
    assert.equal(typeof service.reviewRestore, 'function');
    assert.deepEqual(
      await service.listRestoreBackups(bootstrap.installation.id),
      [{ id: snapshot, time: index[0].time }],
    );
    const pending = service.reviewRestore(snapshot, bootstrap.installation.id);
    await assert.rejects(
      service.reviewRestore(snapshot, bootstrap.installation.id),
      /native_restore_review_busy/,
    );
    const accepted = await pending;
    assert.equal(accepted.state, 'preparing');
    let review;
    for (let attempt = 0; attempt < 100; attempt++) {
      review = service.restoreReview(accepted.id, bootstrap.installation.id);
      if (review.state === 'prepared') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(review.state, 'prepared');
    assert.equal(review.libraryId, bootstrap.installation.id);
    assert.equal(review.mediaIncluded, false);
    assert.equal(review.requiresRuntimeChange, false);
    assert.equal(store.history().length, 0);
    assert.deepEqual(effects, []);
    await assert.rejects(
      service.reviewRestore(snapshot, 'f'.repeat(12)),
      /installation_changed/,
    );
    await assert.rejects(
      service.listRestoreBackups('f'.repeat(12)),
      /installation_changed/,
    );
    index = [{ ...index[0], id: '/private/path' }];
    await assert.rejects(
      service.listRestoreBackups(bootstrap.installation.id),
      /native_backup_index_invalid/,
    );
  });
});

test('native recovery acknowledges durable work before readback and reports failure or interrupted restart safely', async () => {
  await fixture(async ({ store, bootstrap, runtime, effects }) => {
    let failReadback;
    const blocked = new Promise((_resolve, reject) => {
      failReadback = reject;
    });
    void blocked.catch(() => {});
    const service = new NativeService(store, bootstrap, runtime, {
      restore: () => blocked,
    } as never);
    const snapshot = '1'.repeat(64),
      key = randomUUID();
    let timer;
    try {
      const accepted = await Promise.race([
        service.reviewRestore(snapshot, bootstrap.installation.id, key),
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(Error('review acknowledgement blocked on readback')),
            1000,
          );
        }),
      ]);
      clearTimeout(timer);
      assert.equal(accepted.state, 'preparing');
      assert.equal(accepted.id, key);
      assert.deepEqual(
        await service.reviewRestore(snapshot, bootstrap.installation.id, key),
        accepted,
      );
      assert.equal(
        store.get(`native-restore-review:${accepted.id}`).state,
        'preparing',
      );
      assert.equal(
        service.restoreReview(accepted.id, bootstrap.installation.id).state,
        'preparing',
      );
      failReadback(Error('synthetic private storage details'));
      let status;
      for (let attempt = 0; attempt < 100; attempt++) {
        status = service.restoreReview(accepted.id, bootstrap.installation.id);
        if (status.state === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(status.state, 'failed');
      assert.deepEqual(
        await service.reviewRestore(snapshot, bootstrap.installation.id, key),
        accepted,
      );
      await assert.rejects(
        service.reviewRestore('2'.repeat(64), bootstrap.installation.id, key),
        /native_restore_review_changed/,
      );
      assert.ok(!JSON.stringify(status).includes('private storage'));
      const savedKey = `native-restore-review:${accepted.id}`,
        saved = store.get(savedKey);
      saved.state = 'preparing';
      delete saved.error;
      store.set(savedKey, saved);
      const restarted = new NativeService(
        store,
        bootstrap,
        runtime,
        {} as never,
      );
      assert.equal(
        restarted.restoreReview(accepted.id, bootstrap.installation.id).state,
        'interrupted',
      );
      saved.expires = 0;
      store.set(savedKey, saved);
      assert.equal(
        restarted.restoreReview(accepted.id, bootstrap.installation.id).state,
        'expired',
      );
      assert.throws(
        () => restarted.restoreReview(accepted.id, 'f'.repeat(12)),
        /installation_changed/,
      );
      assert.deepEqual(effects, []);
    } finally {
      clearTimeout(timer);
      failReadback(Error('fixture cleanup'));
    }
  });
});

test('restore service requires a fresh compatible review and preserves the same request after expiry', async () => {
  await fixture(async ({ store, bootstrap, runtime, effects }) => {
    const { digest } = await import('../src/contracts.js');
    const { createNativeRecovery } =
      await import('../src/runtime/native-recovery.js');
    const service = new NativeService(store, bootstrap, runtime, {} as never);
    assert.equal(typeof service.restore, 'function');
    const reviewId = randomUUID(),
      key = randomUUID();
    const context = {
      installation: bootstrap.installation,
      libraryId: bootstrap.installation.id,
      release: bootstrap.release,
    };
    const checkpoint = {
      protocolVersion: 1,
      state: 'checkpoint',
      schemaVersion: 1,
      operationId: randomUUID(),
      manifestSha256: bootstrap.installation.manifestSha256,
      sourceRevision: bootstrap.installation.sourceRevision,
      postgresMajor: '19',
      databaseFormat: 'frameleaf-canonical',
      dump: { bytes: 20, sha256: '1'.repeat(64) },
    };
    const review = {
      id: reviewId,
      state: 'prepared',
      snapshot: '2'.repeat(64),
      expires: Date.now() + 900_000,
      contextFingerprint: digest(context),
      recovery: createNativeRecovery(
        {
          ...context,
          name: bootstrap.name,
          operation: { id: checkpoint.operationId, createdAt: Date.now() },
        },
        checkpoint,
      ),
    };
    store.set(`native-restore-review:${reviewId}`, { ...review, expires: 0 });
    assert.throws(
      () => service.restore(reviewId, key, bootstrap.installation.id),
      /native_restore_review_expired/,
    );
    const changed = structuredClone(review);
    changed.recovery.checkpoint.sourceRevision = '0'.repeat(40);
    store.set(`native-restore-review:${reviewId}`, changed);
    assert.throws(
      () => service.restore(reviewId, key, bootstrap.installation.id),
      /native_restore_runtime_change_required/,
    );
    assert.equal(store.history().length, 0);
    store.set(`native-restore-review:${reviewId}`, review);
    assert.throws(
      () => service.restore(reviewId, key, 'f'.repeat(12)),
      /installation_changed/,
    );
    const operation = service.restore(reviewId, key, bootstrap.installation.id);
    assert.equal(operation.kind, 'restore');
    assert.equal((await service.wait(operation.id)).state, 'failed'); // Metadata alone cannot replace real readback.
    store.set(`native-restore-review:${reviewId}`, { ...review, expires: 0 });
    assert.equal(
      service.restore(reviewId, key, bootstrap.installation.id).id,
      operation.id,
    );
    assert.throws(
      () => service.restore(randomUUID(), key, bootstrap.installation.id),
      /request_key_reused/,
    );
    assert.deepEqual(effects, []);
  });
});

function updatedBootstrap(bootstrap: any, store: Store) {
  return {
    ...bootstrap,
    release: 'frameleaf-v3.0.0-2',
    installation: {
      ...bootstrap.installation,
      candidate: bootstrap.installation.candidate + '-next',
      manifestSha256: 'e'.repeat(64),
      sourceRevision: 'f'.repeat(40),
    },
    installationTransition: {
      operationId: randomUUID(),
      fromFingerprint: store.get<any>('native-installation').fingerprint,
    },
  };
}
test('explicit binding transition preserves library, sessions and secrets and exactly replays', async () => {
  await fixture(async ({ store, bootstrap, runtime, effects }) => {
    new NativeService(store, bootstrap, runtime);
    store.set('synthetic-backup-setting', { retained: true });
    store.db
      .prepare('INSERT INTO sessions VALUES (?,?,?)')
      .run('hash', 'csrf', Date.now() + 60000);
    const target = updatedBootstrap(bootstrap, store);
    const parsed = await read(target);
    const old = store.get<any>('native-installation');
    const service = new NativeService(store, parsed, runtime);
    const current = store.get<any>('native-installation');
    assert.notEqual(current.fingerprint, old.fingerprint);
    assert.equal(current.fingerprint, digest(current.descriptor));
    assert.equal(current.descriptor.installationTransition, undefined);
    assert.equal(service.installation().release, target.release);
    assert.equal(await service.backupPassword(), bootstrap.backupKey);
    assert.equal(store.get('native-library-id'), bootstrap.installation.id);
    assert.deepEqual(store.get('synthetic-backup-setting'), { retained: true });
    assert.equal(store.db.prepare('SELECT * FROM sessions').all().length, 1);
    new NativeService(store, parsed, runtime);
    const { installationTransition, ...ordinary } = target;
    new NativeService(store, ordinary, runtime);
    assert.throws(
      () => new NativeService(store, bootstrap, runtime),
      /native_installation_changed/,
    );
    assert.deepEqual(effects, []);
    const snapshot = JSON.stringify(
      store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
    );
    for (const secret of [
      bootstrap.password,
      bootstrap.backupKey,
      bootstrap.tls.privateKeyPem,
    ])
      assert.ok(!snapshot.includes(secret));
    for (const changed of [
      { ...target, release: 'frameleaf-v3.0.0-3' },
      {
        ...target,
        installationTransition: {
          ...installationTransition,
          fromFingerprint: '0'.repeat(64),
        },
      },
      {
        ...target,
        installationTransition: {
          ...installationTransition,
          operationId: randomUUID(),
        },
      },
    ]) {
      assert.throws(() => new NativeService(store, changed, runtime));
      assert.equal(
        JSON.stringify(
          store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
        ),
        snapshot,
      );
    }
  });
});
test('binding transition refuses immutable drift and incomplete operations without writing settings', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    new NativeService(store, bootstrap, runtime);
    const target = updatedBootstrap(bootstrap, store);
    const before = JSON.stringify(
      store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
    );
    for (const value of [
      { ...target, name: 'different' },
      { ...target, tls: { ...target.tls, certificatePem: 'another' } },
      ...['id', 'secureInstallationId', 'state', 'databasePort', 'apiPort'].map(
        (key) => ({
          ...target,
          installation: {
            ...target.installation,
            [key]:
              key === 'id'
                ? 'c'.repeat(12)
                : key === 'secureInstallationId'
                  ? '22222222-2222-4222-8222-222222222222'
                  : key === 'state'
                    ? target.installation.state + '-other'
                    : 60000,
          },
        }),
      ),
      {
        ...target,
        installationTransition: {
          ...target.installationTransition,
          fromFingerprint: '0'.repeat(64),
        },
      },
      { ...bootstrap, installationTransition: target.installationTransition },
    ]) {
      assert.throws(() => new NativeService(store, value, runtime));
      assert.equal(
        JSON.stringify(
          store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
        ),
        before,
      );
    }
    const { operation } = store.start('start', 'synthetic-active', {});
    for (const state of ['running', 'interrupted', 'failed'] as const) {
      operation.state = state;
      store.save(operation);
      assert.throws(
        () => new NativeService(store, target, runtime),
        /operation_in_progress/,
      );
      assert.equal(
        JSON.stringify(
          store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
        ),
        before,
      );
    }
    operation.state = 'complete';
    store.save(operation);
    new NativeService(store, target, runtime);
    const history = JSON.stringify(store.history());
    new NativeService(store, target, runtime);
    assert.equal(JSON.stringify(store.history()), history);
  });
});
test('binding transition requires valid enrollment and rolls back failed receipt publication', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    assert.throws(
      () =>
        new NativeService(
          store,
          {
            ...bootstrap,
            installationTransition: {
              operationId: randomUUID(),
              fromFingerprint: 'b'.repeat(64),
            },
          },
          runtime,
        ),
    );
    assert.equal(store.get('native-installation'), null);
    new NativeService(store, bootstrap, runtime);
    const original = store.get<any>('native-installation');
    const target = updatedBootstrap(bootstrap, store);
    const before = JSON.stringify(
      store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
    );
    store.set('native-installation', {
      ...original,
      descriptor: { ...original.descriptor, name: 'corrupt' },
    });
    assert.throws(() => new NativeService(store, target, runtime));
    store.set('native-installation', original);
    store.db.exec(
      "CREATE TRIGGER deny_transition BEFORE INSERT ON settings WHEN NEW.key LIKE 'native-transition:%' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END",
    );
    assert.throws(
      () => new NativeService(store, target, runtime),
      /synthetic receipt failure/,
    );
    assert.equal(
      JSON.stringify(
        store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
      ),
      before,
    );
    store.db.exec('DROP TRIGGER deny_transition');
    new NativeService(store, target, runtime);
  });
});

test('transition bootstrap rejects malformed authority and prior receipts cannot rebind later versions', async () => {
  await fixture(async ({ store, bootstrap, runtime }) => {
    new NativeService(store, bootstrap, runtime);
    const first = updatedBootstrap(bootstrap, store);
    for (const change of [
      {
        ...first.installationTransition,
        operationId: '00000000-0000-0000-0000-000000000000',
      },
      {
        ...first.installationTransition,
        operationId: randomUUID().toUpperCase(),
      },
      { ...first.installationTransition, fromFingerprint: 'foreign' },
      { ...first.installationTransition, extra: true },
    ])
      await assert.rejects(read({ ...first, installationTransition: change }));
    const original = store.get<any>('native-installation');
    const { password, backupKey, tls, ...unused } = bootstrap;
    void password;
    void backupKey;
    void unused;
    assert.equal(
      original.fingerprint,
      digest({
        protocolVersion: 2,
        installation: bootstrap.installation,
        controllerSha256: bootstrap.controllerSha256,
        backupEngine: bootstrap.backupEngine,
        name: bootstrap.name,
        release: bootstrap.release,
        tlsCertificatePemSha256: sha256(tls.certificatePem),
      }),
    );
    new NativeService(store, first, runtime);
    const second = {
      ...updatedBootstrap(first, store),
      release: 'frameleaf-v3.0.0-3',
    };
    new NativeService(store, second, runtime);
    const snapshot = JSON.stringify(
      store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
    );
    assert.throws(() => new NativeService(store, first, runtime));
    assert.equal(
      JSON.stringify(
        store.db.prepare('SELECT * FROM settings ORDER BY key').all(),
      ),
      snapshot,
    );
    store.set('native-library-id', '0'.repeat(12));
    assert.throws(() => new NativeService(store, second, runtime));
    assert.equal(store.get('native-library-id'), '0'.repeat(12));
  });
});
