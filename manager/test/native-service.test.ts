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
import { Refusal, sha256 } from '../src/contracts.js';
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
      { ...bootstrap, password: 'x\nsecret' },
      {
        ...bootstrap,
        installation: { ...bootstrap.installation, apiPort: 54329 },
      },
      { ...bootstrap, controllerSha256: '0'.repeat(64) },
      { ...bootstrap, backupEngine: undefined },
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
