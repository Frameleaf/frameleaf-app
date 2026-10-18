import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NativeHost, type NativeInstallation } from '../src/runtime/native.js';

const operation = '11111111-1111-4111-8111-111111111111';
const nextOperation = '22222222-2222-4222-8222-222222222222';
async function fixture(
  scenario: string,
  run: (host: NativeHost, installation: NativeInstallation) => Promise<void>,
) {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'frameleaf-checkpoint-client-'),
  );
  const installation: NativeInstallation = {
    runtime: 'native',
    id: 'a'.repeat(12),
    controller: join(root, 'controller.mjs'),
    candidate: join(root, 'candidate'),
    state: join(root, 'state'),
    manifestSha256: 'b'.repeat(64),
    sourceRevision: 'c'.repeat(40),
    certified: false,
    databasePort: 54321,
    apiPort: 54322,
  };
  await writeFile(
    installation.controller,
    `#!${process.execPath}
import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin})[Symbol.asyncIterator]();
const config=JSON.parse((await lines.next()).value), scenario=${JSON.stringify(scenario)};
const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
emit({protocolVersion:1,state:'running',manifestSha256:config.manifestSha256,sourceRevision:'c'.repeat(40),certified:false});
if(scenario==='unsolicited')emit({protocolVersion:1,state:'checkpoint-failed',operationId:'${operation}',code:'host_checkpoint_failed'});
let pending=null;
for await(const line of {[Symbol.asyncIterator]:()=>lines}){
 if(line==='stop'){
  if(pending)emit({protocolVersion:1,state:'checkpoint-failed',operationId:pending,code:'host_checkpoint_failed'});
  emit({protocolVersion:1,state:'stopped'});break;
 }
 const request=JSON.parse(line);
 if(request.action==='cleanup-checkpoint'){
  if(Object.keys(request).sort().join(',')!=='action,checkpoint,operationId,protocolVersion'||request.checkpoint.operationId!==request.operationId)process.exit(8);
  const cleaned={protocolVersion:1,...request.checkpoint,state:'checkpoint-cleaned'};
  if(scenario==='cleanup-dump')cleaned.dump={...cleaned.dump,sha256:'e'.repeat(64)};
  if(scenario==='cleanup-action')cleaned.state='checkpoint';
  if(scenario==='cleanup-failure'){emit({protocolVersion:1,state:'checkpoint-cleanup-failed',operationId:request.operationId,code:'host_checkpoint_cleanup_failed'});continue;}
  emit(cleaned);continue;
 }
 if(Object.keys(request).sort().join(',')!=='action,operationId,protocolVersion'||request.protocolVersion!==1||request.action!=='checkpoint')process.exit(8);
 pending=request.operationId;
 if(scenario==='hold')continue;
 if(scenario==='exit')process.exit(7);
 if(scenario==='failure'||scenario==='private-error'){
  emit({protocolVersion:1,state:'checkpoint-failed',operationId:pending,code:scenario==='failure'?'host_checkpoint_failed':'synthetic-private-detail'});pending=null;continue;
 }
 const receipt={protocolVersion:1,state:'checkpoint',schemaVersion:1,operationId:pending,manifestSha256:config.manifestSha256,
 sourceRevision:'c'.repeat(40),postgresMajor:'19',databaseFormat:'frameleaf-canonical',dump:{bytes:27,sha256:'d'.repeat(64)}};
 const mutations={operationId:'${nextOperation}',manifestSha256:'e'.repeat(64),sourceRevision:'f'.repeat(40),schemaVersion:2,postgresMajor:'18',databaseFormat:'immich-source',extra:'synthetic-private-detail'};
 if(scenario in mutations)receipt[scenario]=mutations[scenario];
 if(scenario==='zero-bytes')receipt.dump.bytes=0;
 if(scenario==='unsafe-bytes')receipt.dump.bytes=9007199254740992;
 if(scenario==='fractional-bytes')receipt.dump.bytes=1.5;
 if(scenario==='bad-digest')receipt.dump.sha256='not-a-digest';
 if(scenario==='extra-dump')receipt.dump.extra='synthetic-private-detail';
 const wire=JSON.stringify(receipt)+'\\n';
 if(scenario==='oversized')process.stdout.write(' '.repeat(8193)+wire);
 else if(scenario==='incomplete'){process.stdout.write(wire.slice(0,-1));process.exit(0);}
 else process.stdout.write(wire+(scenario==='duplicate'?wire:''));
 pending=null;
}
`,
  );
  await chmod(installation.controller, 0o700);
  const host = new NativeHost(
    installation,
    async () => 'synthetic-private-checkpoint-password',
  );
  try {
    await run(host, installation);
  } finally {
    await host.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

test('checkpoint refuses invalid identities and detached owners without launching', async () => {
  const root = await realpath(tmpdir());
  const host = new NativeHost(
    {
      runtime: 'native',
      id: 'a'.repeat(12),
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
      throw Error('must not read credentials');
    },
  );
  for (const invalid of [
    '../outside',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    '00000000-0000-0000-0000-000000000000',
  ])
    await assert.rejects(
      host.checkpoint(invalid),
      /native_checkpoint_request_invalid/,
    );
  await assert.rejects(
    host.checkpoint(operation),
    /native_checkpoint_unavailable/,
  );
});

test(
  'checkpoint sends only an operation identity and binds successive receipts',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('normal', async (host, installation) => {
      await host.start();
      const controller = new AbortController();
      const first = host.checkpoint(operation, controller.signal);
      await assert.rejects(
        host.checkpoint(nextOperation),
        /native_checkpoint_busy/,
      );
      const receipt = await first;
      assert.equal(receipt.operationId, operation);
      assert.equal(receipt.manifestSha256, installation.manifestSha256);
      assert.equal(receipt.sourceRevision, installation.sourceRevision);
      assert.deepEqual(receipt.dump, { bytes: 27, sha256: 'd'.repeat(64) });
      controller.abort();
      assert.equal(host.status().state, 'running');
      assert.equal(
        (await host.checkpoint(nextOperation)).operationId,
        nextOperation,
      );
      await host.stop();
      await assert.rejects(
        host.checkpoint(operation),
        /native_checkpoint_unavailable/,
      );
    });
  },
);

test(
  'generic checkpoint failure allows another request without exposing child details',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('failure', async (host) => {
      await host.start();
      await assert.rejects(
        host.checkpoint(operation),
        /native_checkpoint_failed/,
      );
      assert.equal(host.status().state, 'running');
      await assert.rejects(
        host.checkpoint(nextOperation),
        /native_checkpoint_failed/,
      );
    });
  },
);

for (const scenario of [
  'operationId',
  'manifestSha256',
  'sourceRevision',
  'schemaVersion',
  'postgresMajor',
  'databaseFormat',
  'extra',
  'extra-dump',
  'zero-bytes',
  'unsafe-bytes',
  'fractional-bytes',
  'bad-digest',
  'private-error',
  'oversized',
  'incomplete',
  'exit',
]) {
  test(
    `checkpoint refuses ${scenario} and closes its owned controller`,
    { skip: process.platform === 'win32' },
    async () => {
      await fixture(scenario, async (host) => {
        await host.start();
        await assert.rejects(host.checkpoint(operation), (error) => {
          assert.doesNotMatch(String(error), /synthetic-private/);
          return true;
        });
        await assert.rejects(host.stop());
        assert.equal(host.status().state, 'unknown');
      });
    },
  );
}

test(
  'unsolicited checkpoint output never establishes a pending operation',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('unsolicited', async (host) => {
      await host.start();
      await assert.rejects(host.stop(), /native_host_protocol_invalid/);
    });
  },
);

test(
  'duplicate checkpoint reply cannot complete a subsequent operation',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('duplicate', async (host) => {
      await host.start();
      await host.checkpoint(operation);
      await assert.rejects(host.stop(), /native_host_protocol_invalid/);
      await assert.rejects(
        host.checkpoint(nextOperation),
        /native_checkpoint_unavailable/,
      );
    });
  },
);

for (const action of ['stop', 'abort']) {
  test(
    `checkpoint ${action} rejects pending work while draining failure plus stopped`,
    { skip: process.platform === 'win32' },
    async () => {
      await fixture('hold', async (host) => {
        await host.start();
        const controller = new AbortController();
        const pending = host.checkpoint(operation, controller.signal);
        if (action === 'abort')
          controller.abort(new Error('synthetic-private-abort-reason'));
        const stopping = host.stop();
        await assert.rejects(pending, /native_checkpoint_cancelled/);
        assert.equal((await stopping).state, 'stopped');
        assert.equal(host.status().state, 'stopped');
      });
    },
  );
}

test(
  'already aborted checkpoint leaves the running owner untouched',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('normal', async (host) => {
      await host.start();
      await assert.rejects(
        host.checkpoint(
          operation,
          AbortSignal.abort('synthetic-private-reason'),
        ),
        /native_checkpoint_cancelled/,
      );
      assert.equal(host.status().state, 'running');
      assert.equal((await host.checkpoint(operation)).operationId, operation);
    });
  },
);

test(
  'checkpoint deadline rejects pending work and drains its owned controller',
  { skip: process.platform === 'win32' },
  async (t) => {
    await fixture('hold', async (host) => {
      await host.start();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = host.checkpoint(operation);
      const refused = assert.rejects(pending, /native_checkpoint_timeout/);
      t.mock.timers.tick(7_200_000);
      await refused;
      await assert.rejects(host.stop(), /native_checkpoint_timeout/);
      t.mock.timers.reset();
    });
  },
);

test(
  'cleanup binds the exact checkpoint receipt and does not accept another action or dump',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('normal', async (host) => {
      await host.start();
      const receipt = await host.checkpoint(operation);
      assert.equal(typeof host.cleanupCheckpoint, 'function');
      const cleaned = await host.cleanupCheckpoint(receipt);
      assert.deepEqual(cleaned, { ...receipt, state: 'checkpoint-cleaned' });
      assert.equal(host.status().state, 'running');
      await assert.rejects(
        host.cleanupCheckpoint({ ...receipt, sourceRevision: 'e'.repeat(40) }),
        /native_checkpoint_request_invalid/,
      );
    });
    for (const scenario of ['cleanup-dump', 'cleanup-action'])
      await fixture(scenario, async (host) => {
        await host.start();
        const receipt = await host.checkpoint(operation);
        await assert.rejects(
          host.cleanupCheckpoint(receipt),
          /native_host_protocol_invalid/,
        );
        await assert.rejects(host.stop());
      });
  },
);

test(
  'a cleanup failure is scoped and does not terminate the live owner',
  { skip: process.platform === 'win32' },
  async () => {
    await fixture('cleanup-failure', async (host) => {
      await host.start();
      const receipt = await host.checkpoint(operation);
      assert.equal(typeof host.cleanupCheckpoint, 'function');
      await assert.rejects(
        host.cleanupCheckpoint(receipt),
        /native_checkpoint_cleanup_failed/,
      );
      assert.equal(host.status().state, 'running');
      assert.equal(
        (await host.checkpoint(nextOperation)).operationId,
        nextOperation,
      );
    });
  },
);
