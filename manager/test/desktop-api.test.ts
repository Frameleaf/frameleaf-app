import assert from 'node:assert/strict';
import express from 'express';
import { createServer, request } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.js';
import { Security } from '../src/security.js';
import {
  DesktopGrants,
  pairingMessage,
  requestMessage,
} from '../src/desktop-grants.js';
import { Refusal, sha256 } from '../src/contracts.js';
import { Operations } from '../src/operations.js';
import { desktopApi } from '../src/desktop-api.js';
import { NativeService } from '../src/runtime/native-service.js';
const password = 'synthetic Manager API password',
  origin = 'https://manager.test:9443',
  installationId = 'a'.repeat(12);
const key = generateKeyPairSync('ed25519'),
  deviceId = randomUUID(),
  publicKey = key.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
const signature = (value: string) =>
  sign(null, Buffer.from(value), key.privateKey).toString('base64');
async function fixture(
  run: (f: any) => Promise<void>,
  native = false,
  nativeBackups = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'manager-desktop-api-')),
    store = new Store(root),
    claim = join(root, 'claim-key'),
    effects: string[] = [];
  await writeFile(claim, 'c'.repeat(64));
  const security = new Security(store, origin, claim);
  await security.claim('Owner', password, 'c'.repeat(64));
  const session = await security.login(password),
    grants = new DesktopGrants(store, security);
  const dockerOperations = new Operations(
    store,
    {
      compose: async (_directory: string, project: string, action: string) => {
        effects.push(action + ':' + project);
      },
    } as never,
    {} as never,
    {} as never,
    [],
    {} as never,
  );
  if (!native)
    store.set('installation', {
      id: installationId,
      project: 'owned',
      name: 'My library',
      release: 'frameleaf-v3.0.0-1',
      port: 2283,
    });
  const operations = native
    ? new NativeService(
        store,
        {
          protocolVersion: 2,
          backupKey: 'k'.repeat(43),
          tls: {
            certificatePem: 'synthetic certificate',
            privateKeyPem: 'synthetic private key',
          },
          controllerSha256: 'e'.repeat(64),
          backupEngine: {
            executable: join(root, 'backup-engine'),
            sha256: 'f'.repeat(64),
          },
          name: 'Native library',
          release: 'frameleaf-v3.0.0-1',
          password,
          installation: {
            runtime: 'native',
            id: installationId,
            controller: join(root, 'controller'),
            candidate: join(root, 'runtime'),
            state: join(root, 'state'),
            manifestSha256: 'b'.repeat(64),
            sourceRevision: 'c'.repeat(40),
            certified: false,
            databasePort: 54329,
            apiPort: 2283,
          },
        },
        {
          identity: {
            runtime: 'native',
            installationId,
            fingerprint: 'd'.repeat(64),
          },
          start: async () => {
            effects.push('native-start');
            return {
              protocolVersion: 1,
              state: 'running',
              manifestSha256: 'b'.repeat(64),
              sourceRevision: 'c'.repeat(40),
              certified: false,
            };
          },
          stop: async () => {
            effects.push('native-stop');
            return { protocolVersion: 1, state: 'stopped' };
          },
          checkpoint: async () => {
            throw new Refusal('native_checkpoint_unavailable');
          },
          status: () => ({ state: 'running' }),
          startRestorePreparation: async () => {
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
        },
        nativeBackups ? ({} as never) : undefined,
      )
    : dockerOperations;
  const app = express();
  app.use(desktopApi(store, security, grants, operations));
  app.use(security.guard);
  app.use(express.json());
  app.post('/manager-api/control', (_req, res) => res.json({ browser: true }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const call = (
    path: string,
    body = '{}',
    headers: Record<string, string> = {},
    method = 'POST',
  ) =>
    new Promise<any>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path,
          method,
          agent: false,
          headers: {
            host: 'manager.test:9443',
            'content-type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: data ? JSON.parse(data) : null,
              headers: res.headers,
            }),
          );
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => req.destroy(Error('fixture request timeout')));
      req.end(body);
    });
  const browser = {
    origin,
    cookie: `__Host-frameleaf-manager=${session.session}`,
    'x-csrf-token': session.csrf,
  };
  const pair = async (
    scopes = ['status', 'start', 'stop', 'restart', 'backup'],
  ) => {
    const approval = await grants.approve(password, {
      deviceId,
      publicKey,
      installationId,
      scopes,
    });
    return grants.redeem({
      pairingId: approval.pairingId,
      secret: approval.secret,
      signature: signature(pairingMessage(approval)),
    });
  };
  const signed = (grant: any, path: string, body = '{}', scope = 'status') => {
    const proof = {
      protocolVersion: 1,
      managerId: grants.identity.id,
      grantId: grant.id,
      deviceId,
      token: grant.token,
      timestamp: Date.now(),
      nonce: randomUUID(),
    };
    return {
      'x-frameleaf-manager-proof': Buffer.from(
        JSON.stringify({
          ...proof,
          signature: signature(
            requestMessage(grants.identity, proof, {
              installationId,
              scope,
              method: 'POST',
              path,
              bodySha256: sha256(body),
            }),
          ),
        }),
      ).toString('base64'),
    };
  };
  try {
    await run({
      store,
      security,
      grants,
      operations,
      effects,
      call,
      browser,
      pair,
      signed,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise(setImmediate);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}
test('browser-approved pairing and native redemption preserve browser Host/Origin/CSRF checks', async () => {
  await fixture(async ({ call, browser, signed }) => {
    const input = JSON.stringify({
      password,
      deviceId,
      publicKey,
      scopes: ['status', 'stop'],
    });
    assert.equal(
      (await call('/manager-api/desktop-grants/approve', input)).status,
      403,
    );
    assert.equal(
      (
        await call('/manager-api/desktop-grants/approve', input, {
          ...browser,
          'x-csrf-token': 'wrong',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          '/manager-api/desktop-grants/approve',
          JSON.stringify({ ...JSON.parse(input), installationId }),
          browser,
        )
      ).status,
      400,
    );
    const approved = await call(
      '/manager-api/desktop-grants/approve',
      input,
      browser,
    );
    assert.equal(approved.status, 200);
    const approval = approved.body;
    assert.equal(approval.installationId, installationId);
    const redeemed = await call(
      '/manager-api/desktop/redeem',
      JSON.stringify({
        pairingId: approval.pairingId,
        secret: approval.secret,
        signature: signature(pairingMessage(approval)),
      }),
    );
    assert.equal(redeemed.status, 200);
    const grant = redeemed.body;
    const path = '/manager-api/desktop/status';
    const status = await call(path, '{}', signed(grant, path));
    assert.equal(status.status, 200);
    assert.equal(status.body.installation.id, installationId);
    assert.equal(status.headers['cache-control'], 'no-store');
    const list = await call('/manager-api/desktop-grants', '', browser, 'GET');
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify(list.body).includes(grant.token));
  });
});
test('native transport refuses browser context, wrong host, noncanonical paths and oversized/malformed JSON', async () => {
  await fixture(async ({ call, pair, signed, browser }) => {
    const grant = await pair(),
      path = '/manager-api/desktop/status',
      headers = signed(grant, path);
    for (const patch of [
      { origin },
      { origin: 'https://evil.test' },
      { cookie: browser.cookie },
      { authorization: 'Bearer photo-token' },
      { 'sec-fetch-site': 'none' },
      { host: 'evil.test' },
    ])
      assert.equal(
        (await call(path, '{}', { ...headers, ...patch })).status,
        403,
      );
    assert.equal(
      (await call(path, '{}', { ...headers, 'content-type': 'text/plain' }))
        .status,
      415,
    );
    assert.equal((await call(path, '{', headers)).status, 400);
    assert.equal(
      (await call(path, JSON.stringify({ data: 'x'.repeat(17000) }), headers))
        .status,
      413,
    );
    assert.equal((await call(path, '', headers, 'GET')).status, 405);
    for (const suffix of ['?x=1', '/', '/unknown'])
      assert.ok((await call(path + suffix, '{}', headers)).status >= 400);
    assert.equal(
      (await call('/manager-api/control', '{}', headers)).status,
      403,
    );
  });
});
test('proofs bind actual raw request bytes and replay cannot dispatch a second effect', async () => {
  await fixture(async ({ call, pair, signed, effects, store }) => {
    const grant = await pair(),
      path = '/manager-api/desktop/control',
      body = JSON.stringify({ action: 'stop', key: randomUUID() }),
      headers = signed(grant, path, body, 'stop');
    assert.equal((await call(path, body + ' ', headers)).status, 401);
    assert.equal((await call(path, body, {})).status, 401);
    assert.deepEqual(effects, []);
    const accepted = await call(path, body, headers);
    assert.equal(accepted.status, 200);
    const id = accepted.body.id;
    assert.equal((await call(path, body, headers)).status, 409);
    assert.equal(
      (await call(path, body, signed(grant, path, body, 'stop'))).body.id,
      id,
    );
    assert.deepEqual(store.history()[0].input, { installationId });
    assert.deepEqual(effects, ['stop:owned']);
    const poll = '/manager-api/desktop/operation',
      input = JSON.stringify({ id }),
      result = await call(poll, input, signed(grant, poll, input));
    assert.equal(result.status, 200);
    assert.equal(result.body.state, 'complete');
    assert.equal(result.body.input, undefined);
    assert.equal(result.body.receipts, undefined);
  });
});
test('scope, installation and journal ownership prevent unauthorized control and resume', async () => {
  await fixture(async ({ call, pair, signed, store, effects }) => {
    const grant = await pair(['status', 'start']),
      path = '/manager-api/desktop/control',
      body = JSON.stringify({ action: 'stop', key: randomUUID() });
    assert.equal(
      (await call(path, body, signed(grant, path, body, 'stop'))).status,
      403,
    );
    const operation = store.start('stop', 'browser-owned', {}).operation;
    operation.state = 'failed';
    store.save(operation);
    const poll = '/manager-api/desktop/operation',
      input = JSON.stringify({ id: operation.id });
    assert.equal(
      (await call(poll, input, signed(grant, poll, input))).status,
      403,
    );
    const resume = '/manager-api/desktop/resume',
      value = JSON.stringify({ id: operation.id, action: 'start' });
    assert.equal(
      (await call(resume, value, signed(grant, resume, value, 'start'))).status,
      403,
    );
    store.set('installation', { id: 'b'.repeat(12), project: 'replacement' });
    const status = '/manager-api/desktop/status';
    assert.equal((await call(status, '{}', signed(grant, status))).status, 403);
    assert.deepEqual(effects, []);
  });
});
test('paired resume uses the original bound lifecycle operation and revoke takes effect on the next call', async () => {
  await fixture(async ({ call, pair, signed, store, browser, effects }) => {
    const grant = await pair(),
      operation = store.start('stop', 'interrupted', {
        installationId,
      }).operation;
    operation.state = 'interrupted';
    store.save(operation);
    const path = '/manager-api/desktop/resume',
      body = JSON.stringify({ id: operation.id, action: 'stop' });
    const resumed = await call(path, body, signed(grant, path, body, 'stop'));
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.id, operation.id);
    assert.deepEqual(effects, ['stop:owned']);
    assert.equal(
      (
        await call(
          '/manager-api/desktop-grants/revoke',
          JSON.stringify({ id: grant.id, password }),
          browser,
        )
      ).status,
      200,
    );
    const status = '/manager-api/desktop/status';
    assert.equal((await call(status, '{}', signed(grant, status))).status, 401);
  });
});
test('redemption rate limits are applied before credential verification', async () => {
  await fixture(async ({ call }) => {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (await call('/manager-api/desktop/redeem', '{}')).status,
        401,
      );
    assert.equal((await call('/manager-api/desktop/redeem', '{}')).status, 429);
  });
});

test('case and trailing-slash aliases cannot route around desktop security middleware', async () => {
  await fixture(async ({ call }) => {
    for (const path of [
      '/MANAGER-API/DESKTOP-GRANTS',
      '/manager-api/Desktop-Grants',
      '/manager-api/desktop-grants/',
    ]) {
      const result = await call(path, '', {}, 'GET');
      assert.ok(
        result.status === 403 || result.status === 404,
        `${path} returned ${result.status}`,
      );
      assert.equal(result.body.grants, undefined);
    }
  });
});

test('shared Manager guard rejects case aliases before a case-insensitive browser route', async () => {
  await fixture(async ({ call }) => {
    const result = await call('/MANAGER-API/CONTROL', '{}');
    assert.equal(result.status, 403);
    assert.equal(result.body.browser, undefined);
  });
});

test('paired native lifecycle uses the existing native journal, independently of Docker', async () => {
  await fixture(async ({ call, pair, signed, effects, operations, store }) => {
    const grant = await pair();
    const status = '/manager-api/desktop/status';
    const before = await call(status, '{}', signed(grant, status));
    assert.equal(before.status, 200);
    assert.equal(before.body.installation.name, 'Native library');
    const path = '/manager-api/desktop/control',
      key = randomUUID();
    const body = JSON.stringify({ action: 'start', key });
    const accepted = await call(path, body, signed(grant, path, body, 'start'));
    assert.equal(accepted.status, 200);
    await operations.wait(accepted.body.id);
    const replay = await call(path, body, signed(grant, path, body, 'start'));
    assert.equal(replay.body.id, accepted.body.id);
    assert.deepEqual(effects, ['native-start']);
    const lookup = '/manager-api/desktop/operation',
      lookupBody = JSON.stringify({ id: accepted.body.id });
    const result = await call(
      lookup,
      lookupBody,
      signed(grant, lookup, lookupBody),
    );
    assert.equal(result.body.state, 'complete');
    assert.equal(result.body.input, undefined);
    assert.equal(result.body.receipts, undefined);
    const backup = JSON.stringify({ action: 'backup', key: randomUUID() });
    const refused = await call(
      path,
      backup,
      signed(grant, path, backup, 'backup'),
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'native_action_unavailable');
    assert.equal(store.history().length, 1);
    assert.deepEqual(effects, ['native-start']);
  }, true);
});

test('a scoped native backup request is accepted idempotently and returns only its public operation state', async () => {
  await fixture(
    async ({ call, pair, signed, operations, store, effects }) => {
      const grant = await pair();
      const route = '/manager-api/desktop/control';
      const body = JSON.stringify({ action: 'backup', key: randomUUID() });
      const accepted = await call(
        route,
        body,
        signed(grant, route, body, 'backup'),
      );
      assert.equal(accepted.status, 200);
      await operations.wait(accepted.body.id);
      const replay = await call(
        route,
        body,
        signed(grant, route, body, 'backup'),
      );
      assert.equal(replay.body.id, accepted.body.id);
      const lookup = '/manager-api/desktop/operation',
        lookupBody = JSON.stringify({ id: accepted.body.id });
      const result = await call(
        lookup,
        lookupBody,
        signed(grant, lookup, lookupBody),
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.kind, 'backup');
      assert.equal(result.body.state, 'failed');
      assert.equal(result.body.receipts, undefined);
      assert.equal(result.body.input, undefined);
      assert.equal(store.history().length, 1);
      assert.deepEqual(effects, []);
    },
    true,
    true,
  );
});
