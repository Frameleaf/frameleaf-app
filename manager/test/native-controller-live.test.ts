import assert from 'node:assert/strict';
import { mkdir, readFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { test } from 'node:test';
import { NativeHost, NativeOperations } from '../src/runtime/native.js';
import { Store } from '../src/store.js';

async function port(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, '127.0.0.1', resolve),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test(
  'Manager journal controls the actual factory-signed native host',
  {
    skip: !process.env.FRAMELEAF_NATIVE_MANAGER_STATE,
  },
  async () => {
    const root = process.env.FRAMELEAF_NATIVE_MANAGER_STATE!;
    const candidate = process.env.FRAMELEAF_TEST_HOST_CANDIDATE!;
    const controller = process.env.FRAMELEAF_NATIVE_MANAGER_CONTROLLER!;
    assert.ok(
      isAbsolute(root) && isAbsolute(candidate) && isAbsolute(controller),
    );
    await assert.rejects(access(root));
    await mkdir(root, { mode: 0o700 });
    const manifest = JSON.parse(
      await readFile(join(candidate, 'manifest.json'), 'utf8'),
    );
    const { createHash } = await import('node:crypto');
    const manifestSha256 = createHash('sha256')
      .update(await readFile(join(candidate, 'manifest.json')))
      .digest('hex');
    const databasePort = await port();
    let apiPort = await port();
    while (apiPort === databasePort) apiPort = await port();
    const store = new Store(join(root, 'manager'));
    const password = 'synthetic-native-manager-host-password';
    const descriptor = {
      runtime: 'native' as const,
      id: 'a'.repeat(12),
      controller,
      candidate,
      state: join(root, 'host'),
      manifestSha256,
      sourceRevision: manifest.sourceRevision,
      certified: manifest.certified,
      databasePort,
      apiPort,
    };
    const host = new NativeHost(descriptor, async () => {
      assert.equal(store.history()[0].state, 'running');
      assert.equal(store.history()[0].step, 'start-native-host');
      return password;
    });
    const operations = new NativeOperations(store, host);
    try {
      for (const kind of ['start', 'restart', 'stop'] as const) {
        const operation = operations.control(kind, `${kind}-fixture`);
        const outcome = await operations.wait(operation.id);
        assert.equal(
          outcome.state,
          'complete',
          outcome.error ?? 'operation failed',
        );
        assert.equal(outcome.input.fingerprint, host.identity.fingerprint);
        if (kind === 'stop')
          assert.deepEqual(host.status(), { state: 'stopped' });
        else {
          assert.deepEqual(host.status(), { state: 'running' });
          assert.equal(
            outcome.receipts['start-native-host']['manifestSha256'],
            manifestSha256,
          );
        }
        assert.equal(
          operations.control(kind, `${kind}-fixture`).id,
          operation.id,
        );
      }
      assert.equal(store.history().length, 3);
      assert.doesNotMatch(
        JSON.stringify(store.history()),
        new RegExp(password),
      );
      const unattached = new NativeHost(descriptor, async () => {
        throw Error('credentials must not be requested');
      });
      const freshManager = new NativeOperations(store, unattached);
      const stop = freshManager.control('stop', 'cold-stop-refusal');
      const inspected = await freshManager.wait(stop.id);
      assert.equal(
        inspected.state,
        'complete',
        inspected.error ?? 'inspection failed',
      );
      assert.equal(
        (inspected.receipts['stop-native-host'] as any).inspection
          .installationId,
        descriptor.id,
      );
    } finally {
      await host.stop().catch(() => {});
      store.close();
    }
  },
);
