import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { NativeHost, type NativeInstallation } from '../src/runtime/native.js';
const operation = '11111111-1111-4111-8111-111111111111';
const binding = {
  schemaVersion: 1 as const,
  runtime: 'native' as const,
  operationId: operation,
  reviewId: '22222222-2222-4222-8222-222222222222',
  snapshotId: 'd'.repeat(64),
  installationId: 'a'.repeat(12),
  manifestSha256: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  libraryId: 'e'.repeat(12),
  recoverySha256: 'f'.repeat(64),
};
async function fixture(
  scenario: string,
  run: (host: NativeHost) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'frameleaf-restore-client-')),
  );
  const installation: NativeInstallation = {
    runtime: 'native',
    id: binding.installationId,
    controller: join(root, 'controller.mjs'),
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
    manifestSha256: binding.manifestSha256,
    sourceRevision: binding.sourceRevision,
    certified: false,
    databasePort: 54321,
    apiPort: 54322,
  };
  await writeFile(
    installation.controller,
    `#!${process.execPath}
import {createInterface} from 'node:readline';
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();const config=JSON.parse((await lines.next()).value);
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');const scenario=${JSON.stringify(scenario)};
emit({protocolVersion:1,state:config.mode==='restore-prepare'?'restore-prepare-ready':'running',manifestSha256:config.manifestSha256,sourceRevision:'c'.repeat(40),certified:false});
let pending;
for await(const line of {[Symbol.asyncIterator]:()=>lines}){
 if(line==='stop'){if(pending)emit({protocolVersion:1,state:'restore-prepare-failed',operationId:pending,code:'host_restore_failed'});emit({protocolVersion:1,state:'stopped'});break;}
 const request=JSON.parse(line);if(Object.keys(request).sort().join(',')!=='action,binding,operationId,protocolVersion'||request.action!=='prepare-restore'||request.protocolVersion!==1||request.operationId!==request.binding.operationId)process.exit(8);
 pending=request.operationId;if(scenario==='hold')continue;
 if(scenario==='failure'){emit({protocolVersion:1,state:'restore-prepare-failed',operationId:pending,code:'host_restore_failed'});pending=null;continue;}
 const receipt={protocolVersion:1,schemaVersion:1,state:'restore-prepared',binding:request.binding,attemptId:'33333333-3333-4333-8333-333333333333',profileIdentity:'1:2',targetIdentity:'1:3',databaseIdentity:'1:4',validation:{postgresMajor:19,vectorVersion:'0.8.7',canonical:true,executionStateReconstructed:true}};
 if(scenario==='binding')receipt.binding={...receipt.binding,reviewId:'44444444-4444-4444-8444-444444444444'};
 if(scenario==='schema')receipt.validation.canonical=false;if(scenario==='path')receipt.path='/outside';
 const wire=JSON.stringify(receipt)+'\\n';process.stdout.write(wire+(scenario==='duplicate'?wire:''));pending=null;
}
`,
    { mode: 0o700 },
  );
  await chmod(installation.controller, 0o700);
  const host = new NativeHost(
    installation,
    async () => 'synthetic-private-restore-password',
  );
  try {
    await run(host);
  } finally {
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
test('restore client refuses detached, foreign and malformed requests before effects', async () => {
  const root = await realpath(tmpdir());
  const host = new NativeHost(
    {
      runtime: 'native',
      id: binding.installationId,
      controller: process.execPath,
      candidate: root,
      state: root,
      manifestSha256: binding.manifestSha256,
      sourceRevision: binding.sourceRevision,
      certified: false,
      databasePort: 54321,
      apiPort: 54322,
    },
    async () => assert.fail('credentials must not be read'),
  );
  assert.equal(typeof host.prepareRestore, 'function');
  await assert.rejects(
    host.prepareRestore(binding),
    /native_restore_unavailable/,
  );
  for (const changed of [
    { ...binding, path: '/outside' },
    { ...binding, installationId: '0'.repeat(12) },
    { ...binding, manifestSha256: '0'.repeat(64) },
    { ...binding, sourceRevision: '0'.repeat(40) },
  ])
    await assert.rejects(
      host.prepareRestore(changed),
      /native_restore_request_invalid/,
    );
  await assert.rejects(
    host.prepareRestore(binding, AbortSignal.abort()),
    /native_restore_cancelled/,
  );
});
test(
  'restore client uses distinct maintenance, exact binding and one pending operation',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('normal', async (host) => {
      assert.equal(
        (await host.startRestorePreparation()).state,
        'restore-prepare-ready',
      );
      assert.deepEqual(host.status(), {
        state: 'unknown',
        code: 'native_restore_maintenance',
      });
      await assert.rejects(host.start(), /native_runtime_busy/);
      await assert.rejects(
        host.checkpoint(operation),
        /native_checkpoint_unavailable/,
      );
      const approved = { ...binding };
      const controller = new AbortController();
      const work = host.prepareRestore(approved, controller.signal);
      approved.reviewId = '44444444-4444-4444-8444-444444444444';
      await assert.rejects(host.prepareRestore(binding), /native_restore_busy/);
      const receipt = await work;
      assert.equal(receipt.state, 'restore-prepared');
      assert.deepEqual(receipt.binding, binding);
      controller.abort();
      assert.deepEqual(host.status(), {
        state: 'unknown',
        code: 'native_restore_maintenance',
      });
      assert.deepEqual(await host.stop(), {
        protocolVersion: 1,
        state: 'stopped',
      });
    });
  },
);
test(
  'restore replies reject changed bindings, invalid schema, paths and duplicates',
  { skip: process.platform === 'win32' },
  async () => {
    for (const scenario of ['binding', 'schema', 'path', 'duplicate'])
      await fixture(scenario, async (host) => {
        await host.startRestorePreparation();
        if (scenario === 'duplicate') {
          await host.prepareRestore(binding).catch(() => {});
          await assert.rejects(host.stop(), /native_host_protocol_invalid/);
        } else
          await assert.rejects(
            host.prepareRestore(binding),
            /native_host_protocol_invalid/,
          );
      });
  },
);
test(
  'restore failure permits retry while cancellation drains its bound reply',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('failure', async (host) => {
      await host.startRestorePreparation();
      await assert.rejects(
        host.prepareRestore(binding),
        /native_restore_failed/,
      );
      await assert.rejects(
        host.prepareRestore(binding),
        /native_restore_failed/,
      );
    });
    await fixture('hold', async (host) => {
      await host.startRestorePreparation();
      const controller = new AbortController();
      const work = host.prepareRestore(binding, controller.signal);
      controller.abort();
      await assert.rejects(work, /native_restore_cancelled/);
      assert.deepEqual(await host.stop(), {
        protocolVersion: 1,
        state: 'stopped',
      });
    });
  },
);
