import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeHost, type NativeInstallation } from '../src/runtime/native.js';

const password = 'synthetic-private-controller-password';
async function fixture(
  run: (host: NativeHost, descriptor: NativeInstallation) => Promise<void>,
  scenario = 'normal',
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'frameleaf-controller-adapter-'),
  );
  const controller = join(root, 'controller.mjs');
  const installation: NativeInstallation = {
    runtime: 'native',
    id: 'a'.repeat(12),
    secureInstallationId: '11111111-1111-4111-8111-111111111111',
    controller,
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54321,
    apiPort: 54322,
  };
  await writeFile(
    controller,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value);
if(process.argv[2]==='--inspect-owner'){
 if('password' in config || config.secureInstallationId!==${JSON.stringify(installation.secureInstallationId)} || process.argv.includes(config.secureInstallationId) || Object.values(process.env).includes(config.secureInstallationId))process.exit(9);
 const fs=await import('node:fs/promises');
 await fs.appendFile(${JSON.stringify(join(root, 'probe-count'))},'p');
 if(await fs.access(${JSON.stringify(join(root, 'other-owner'))}).then(()=>true,()=>false)){
  process.stdout.write(JSON.stringify({protocolVersion:1,state:'failed',code:'host_controller_already_owned'})+'\\n');
  process.exit(1);
 }
 const proof={protocolVersion:1,state:'quiescent',installationId:config.installationId,secureInstallationId:config.secureInstallationId,manifestSha256:config.manifestSha256,
 sourceRevision:${JSON.stringify(installation.sourceRevision)},certified:false,profileIdentity:'e'.repeat(64),generation:'11111111-1111-4111-8111-111111111111'};
 if(${JSON.stringify(scenario)}==='inspection-id')proof.installationId='f'.repeat(12);
 if(${JSON.stringify(scenario)}==='inspection-secure-id')proof.secureInstallationId='22222222-2222-4222-8222-222222222222';
 if(${JSON.stringify(scenario)}==='inspection-missing-secure-id')delete proof.secureInstallationId;
 if(${JSON.stringify(scenario)}==='inspection-extra')proof.secret='synthetic-private-protocol';
 await new Promise(resolve=>process.stdout.write(JSON.stringify(proof)+'\\n',resolve));
 if(${JSON.stringify(scenario)}==='inspection-signal')process.kill(process.pid,'SIGTERM');
 process.exit(${JSON.stringify(scenario)}==='inspection-exit'?1:0);
}
if(config.secureInstallationId!==${JSON.stringify(installation.secureInstallationId)} || process.argv.includes(config.secureInstallationId) || Object.values(process.env).includes(config.secureInstallationId) || config.password!==${JSON.stringify(password)} || process.argv[2]!=='--owner-pipe' || process.argv.some(v=>v.includes(config.password)) || Object.values(process.env).includes(config.password)) process.exit(9);
const scenario=${JSON.stringify(scenario)};
if(scenario==='no-ready'){
 for await(const line of {[Symbol.asyncIterator]:()=>lines}){
  if(line==='stop'){
   await new Promise(resolve=>process.stdout.write(JSON.stringify({protocolVersion:1,state:'stopped'})+'\\n',resolve));
   process.exit(0);
  }
 }
}
const ready={protocolVersion:1,state:'running',secureInstallationId:config.secureInstallationId,manifestSha256:config.manifestSha256,sourceRevision:${JSON.stringify(installation.sourceRevision)},certified:false};
if(scenario==='identity')ready.manifestSha256='d'.repeat(64);
if(scenario==='secure-identity')ready.secureInstallationId='22222222-2222-4222-8222-222222222222';
if(scenario==='missing-secure-identity')delete ready.secureInstallationId;
if(scenario==='extra')ready.secret='synthetic-private-protocol';
process.stderr.write('synthetic-private-stderr');
process.stdout.write((scenario==='oversized'?'x'.repeat(16385):JSON.stringify(ready))+'\\n');
for await(const line of {[Symbol.asyncIterator]:()=>lines}){
 if(line==='stop'){
  process.stdout.write(JSON.stringify({protocolVersion:1,state:'stopped'})+'\\n');
  setTimeout(()=>process.exit(scenario==='bad-exit'?1:0),20);
  break;
 }
}
`,
  );
  await chmod(controller, 0o700);
  const host = new NativeHost(installation, async () => password);
  try {
    await run(host, installation);
  } finally {
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test('native ownership is unknown until attached, without asking for credentials', async () => {
  let credentials = 0;
  const root = await realpath(tmpdir());
  const host = new NativeHost(
    {
      runtime: 'native',
      id: 'a'.repeat(12),
      secureInstallationId: '11111111-1111-4111-8111-111111111111',
      controller: process.execPath,
      candidate: root,
      state: root,
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54321,
      apiPort: 54322,
    },
    async () => {
      credentials++;
      return password;
    },
  );
  assert.deepEqual(host.status(), {
    state: 'unknown',
    code: 'native_owner_not_attached',
  });
  // An invalid controller can exit before stdin is written, depending on OS scheduling.
  await assert.rejects(host.stop(), /native_host_(inspection|pipe)_failed/);
  assert.equal(host.status().state, 'unknown');
  assert.equal(credentials, 0);
});

test(
  'cold stop inspects current ownership without credentials and never reuses an old probe',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (_host, descriptor) => {
      let credentials = 0;
      const host = new NativeHost(descriptor, async () => {
        credentials++;
        throw Error('credentials must not be read');
      });
      const stopping = host.stop();
      await assert.rejects(host.start(), /native_runtime_busy/);
      const receipt = await stopping;
      assert.equal(receipt.inspection?.installationId, descriptor.id);
      assert.deepEqual(host.status(), { state: 'stopped' });
      await host.stop();
      assert.equal(credentials, 0);
      assert.equal(
        await (
          await import('node:fs/promises')
        ).readFile(join(descriptor.state, '..', 'probe-count'), 'utf8'),
        'pp',
      );
    });
  },
);

for (const scenario of [
  'inspection-id',
  'inspection-secure-id',
  'inspection-missing-secure-id',
  'inspection-extra',
  'inspection-exit',
  'inspection-signal',
]) {
  test(
    `cold inspection refuses ${scenario}`,
    { skip: process.platform === 'win32' },
    async () => {
      await fixture(async (_host, descriptor) => {
        const host = new NativeHost(descriptor, async () => {
          throw Error('must not read credentials');
        });
        await assert.rejects(
          host.stop(),
          new RegExp(
            ['inspection-id','inspection-secure-id'].includes(scenario)
              ? 'native_host_identity_changed'
              : 'native_host_inspection_failed',
          ),
        );
        assert.equal(host.status().state, 'unknown');
        assert.doesNotMatch(JSON.stringify(host.status()), /synthetic-private/);
      }, scenario);
    },
  );
}

test('native descriptors reject traversal and unknown authority fields', async () => {
  const root = await realpath(tmpdir());
  const descriptor = {
    runtime: 'native',
    id: 'a'.repeat(12),
    secureInstallationId: '11111111-1111-4111-8111-111111111111',
    controller: process.execPath,
    candidate: root,
    state: root,
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54321,
    apiPort: 54322,
  } as NativeInstallation;
  for (const change of [
    { state: root + '/parent/../state' },
    { apiPort: 54321 },
    { trustedKeys: ['untrusted'] },
  ]) {
    assert.throws(
      () => new NativeHost({ ...descriptor, ...change }, async () => password),
      /native_installation_invalid/,
    );
  }
});

test('credential errors never reach public status or errors', async () => {
  const root = await realpath(tmpdir());
  const host = new NativeHost(
    {
      runtime: 'native',
      id: 'a'.repeat(12),
      secureInstallationId: '11111111-1111-4111-8111-111111111111',
      controller: process.execPath,
      candidate: root,
      state: root,
      manifestSha256: 'b'.repeat(64),
      sourceRevision: 'c'.repeat(40),
      certified: false,
      databasePort: 54321,
      apiPort: 54322,
    },
    async () => {
      throw Error(password);
    },
  );
  await assert.rejects(host.start(), /native_credentials_unavailable/);
  assert.deepEqual(host.status(), {
    state: 'unknown',
    code: 'native_credentials_unavailable',
  });
});

test(
  'one owned controller serves duplicate starts and stop waits for its successful close',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (host) => {
      const first = host.start();
      const second = host.start();
      assert.equal(first, second);
      assert.equal((await first).state, 'running');
      assert.deepEqual(host.status(), { state: 'running' });
      const stopping = host.stop();
      assert.deepEqual(host.status(), { state: 'stopping' });
      assert.equal((await stopping).state, 'stopped');
      assert.deepEqual(host.status(), { state: 'stopped' });
      assert.equal((await host.stop()).state, 'stopped');
    });
  },
);

test(
  'a completed owner cannot reuse its old stop receipt after another owner starts',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (host, descriptor) => {
      await host.start();
      await host.stop();
      await writeFile(join(descriptor.state, '..', 'other-owner'), 'active');
      await assert.rejects(host.stop(), /host_controller_already_owned/);
      assert.deepEqual(host.status(), {
        state: 'unknown',
        code: 'host_controller_already_owned',
      });
    });
  },
);

test(
  'a stopped message with no ready identity cannot establish a global stop',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (host) => {
      const starting = host.start();
      await Promise.resolve();
      const stopping = host.stop();
      await assert.rejects(starting, /native_start_cancelled/);
      await assert.rejects(stopping, /native_start_cancelled/);
      assert.equal(host.status().state, 'unknown');
    }, 'no-ready');
  },
);

for (const [scenario, code] of [
  ['identity', 'native_host_identity_changed'],
  ['secure-identity', 'native_host_identity_changed'],
  ['missing-secure-identity', 'native_host_protocol_invalid'],
  ['extra', 'native_host_protocol_invalid'],
  ['oversized', 'native_host_protocol_invalid'],
]) {
  test(
    `native ready records refuse ${scenario} without surfacing stderr or payloads`,
    { skip: process.platform === 'win32' },
    async () => {
      await fixture(async (host) => {
        await assert.rejects(host.start(), new RegExp(code));
        await assert.rejects(host.stop(), new RegExp(code));
        assert.doesNotMatch(JSON.stringify(host.status()), /synthetic-private/);
      }, scenario);
    },
  );
}

test(
  'a stopped receipt followed by a failed exit cannot complete shutdown',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture(async (host) => {
      await host.start();
      await assert.rejects(host.stop(), /native_shutdown_unconfirmed/);
      assert.deepEqual(host.status(), {
        state: 'unknown',
        code: 'native_shutdown_unconfirmed',
      });
    }, 'bad-exit');
  },
);
