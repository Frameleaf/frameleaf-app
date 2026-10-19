import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { NativeHost, NativeOperations } from '../src/runtime/native.js';
import { Store } from '../src/store.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function stoppedMarker(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(path, () => {
      void check();
    });
    const timer = setTimeout(() => {
      watcher.close();
      reject(Error('clean_stop_marker_timeout'));
    }, 15_000);
    watcher.once('error', () => {
      clearTimeout(timer);
      watcher.close();
      reject(Error('owner_state_watch_failed'));
    });
    async function check() {
      try {
        if (JSON.parse(await readFile(path, 'utf8')).phase === 'stopped') {
          clearTimeout(timer);
          watcher.close();
          resolve();
        }
      } catch {
        /* Truncate/write notifications can precede the final complete record. */
      }
    }
    void check();
  });
}

test(
  'a restarted Manager resumes its blocked stop after owner loss without credentials or PID adoption',
  {
    skip:
      !process.env.FRAMELEAF_NATIVE_RECOVERY_STATE ||
      process.platform === 'win32',
  },
  async () => {
    const root = process.env.FRAMELEAF_NATIVE_RECOVERY_STATE!;
    const candidate = process.env.FRAMELEAF_TEST_HOST_CANDIDATE!;
    const controller = process.env.FRAMELEAF_NATIVE_MANAGER_CONTROLLER!;
    assert.ok(
      isAbsolute(root) && isAbsolute(candidate) && isAbsolute(controller),
    );
    assert.ok(process.env.FRAMELEAF_NATIVE_INSTALLATION_ID, 'requires an enrolled disposable test identity');
    await assert.rejects(access(root));
    await mkdir(root, { mode: 0o700 });
    const raw = await readFile(join(candidate, 'manifest.json'));
    const manifest = JSON.parse(raw.toString('utf8'));
    const databasePort = await port();
    let apiPort = await port();
    while (apiPort === databasePort) apiPort = await port();
    const descriptor = {
      runtime: 'native' as const,
      id: 'a'.repeat(12),
      secureInstallationId: process.env.FRAMELEAF_NATIVE_INSTALLATION_ID!,
      controller,
      candidate,
      state: join(root, 'host'),
      manifestSha256: createHash('sha256').update(raw).digest('hex'),
      sourceRevision: manifest.sourceRevision,
      certified: manifest.certified,
      databasePort,
      apiPort,
    };
    const password = 'synthetic-native-manager-recovery-password';
    const journal = join(root, 'manager');
    const store = new Store(journal);
    const helper = join(root, 'manager-owner.mjs');
    await writeFile(
      helper,
      `import {NativeHost,NativeOperations} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/runtime/native.ts')).href)};
import {Store} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/store.ts')).href)};
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {descriptor,journal}=JSON.parse(raw);
const store=new Store(journal),host=new NativeHost(descriptor,async()=>${JSON.stringify(password)});
const operations=new NativeOperations(store,host),operation=operations.control('start','original-owner-start');
const result=await operations.wait(operation.id);process.send({state:result.state,error:result.error});
`,
    );
    const env =
      process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {};
    const manager = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), helper],
      {
        env,
        stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
      },
    );
    let credentials = 0;
    const coldHost = new NativeHost(descriptor, async () => {
      credentials++;
      throw Error('must not unlock credentials');
    });
    const operations = new NativeOperations(store, coldHost);
    let restarted: NativeHost | undefined;
    try {
      const ready = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error('manager_start_timeout')),
          300_000,
        );
        manager.once('message', (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        manager.once('error', () => {
          clearTimeout(timer);
          reject(Error('manager_start_failed'));
        });
        manager.once('exit', () => {
          clearTimeout(timer);
          reject(Error('manager_exited_before_ready'));
        });
      });
      manager.stdin!.end(JSON.stringify({ descriptor, journal }));
      assert.equal((await ready).state, 'complete');
      const stop = operations.control('stop', 'recover-owner-stop');
      const busy = await operations.wait(stop.id);
      assert.equal(busy.state, 'failed');
      assert.equal(busy.error, 'host_controller_already_owned');
      assert.throws(
        () => store.start('restore', 'blocked-until-quiescent', {}),
        /operation_in_progress/,
      );
      const clean = stoppedMarker(
        join(descriptor.state, 'controller-state.json'),
      );
      const exited = new Promise<void>((resolve) =>
        manager.once('close', () => resolve()),
      );
      manager.kill('SIGKILL');
      await exited;
      await clean;
      let outcome;
      for (let attempt = 0; attempt < 5; attempt++) {
        operations.resume(stop.id);
        outcome = await operations.wait(stop.id);
        if (outcome.error !== 'host_controller_already_owned') break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(outcome?.state, 'complete', outcome?.error ?? 'stop failed');
      const receipt = outcome!.receipts['stop-native-host'] as any;
      assert.equal(receipt.inspection.installationId, descriptor.id);
      assert.equal(
        receipt.inspection.manifestSha256,
        descriptor.manifestSha256,
      );
      assert.equal(credentials, 0);
      restarted = new NativeHost(descriptor, async () => password);
      const recovered = new NativeOperations(store, restarted);
      const start = recovered.control('start', 'start-after-recovery');
      assert.equal((await recovered.wait(start.id)).state, 'complete');
      const finalStop = recovered.control('stop', 'stop-after-recovery');
      assert.equal((await recovered.wait(finalStop.id)).state, 'complete');
      assert.ok(
        store.history().every((operation) => operation.state === 'complete'),
      );
      assert.doesNotMatch(
        JSON.stringify(store.history()),
        new RegExp(password),
      );
    } finally {
      if (manager.exitCode === null && manager.signalCode === null)
        manager.kill('SIGKILL');
      await restarted?.stop().catch(() => {});
      store.close();
    }
  },
);
