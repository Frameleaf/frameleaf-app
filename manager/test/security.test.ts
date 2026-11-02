import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { Store } from '../src/store.js';
import { Security } from '../src/security.js';

test('credential changes invalidate existing sessions and in-flight old-password logins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-credentials-'));
  const store = new Store(directory),
    password = 'old private password',
    replacement = 'new private password';
  const security = new Security(store, 'https://manager.test:9443');
  try {
    await security.claim('Owner', password, '::ffff:192.168.1.5');
    const old = await security.login(password);
    await assert.rejects(security.updateAdministrator('Changed', 'wrong', replacement), /invalid_credentials/);
    assert.equal(store.get<any>('administrator').name, 'Owner');
    const changed = await security.updateAdministrator('Changed', password, replacement);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 1);
    assert.notEqual(changed.session, old.session);
    await assert.rejects(security.login(password), /invalid_credentials/);
    await security.login(replacement);
    // confirm yields during scrypt: a record rotated before it returns cannot mint a session.
    const pending = security.login(replacement);
    store.set('administrator', { name: 'Rotated elsewhere', salt: 'different', hash: '0'.repeat(128) });
    await assert.rejects(pending, /invalid_credentials/);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM sessions').get()!.count, 2);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('home-network claim, atomic administrator creation, sessions and CSRF survive Manager replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-security-'));
  const password = 'a private test password';
  let store = new Store(directory);
  try {
    let security = new Security(store, 'https://manager.test:9443');
    for (const address of ['203.0.113.9', '100.64.0.5', '::ffff:8.8.8.8', '2001:db8::1', undefined])
      await assert.rejects(security.claim('Owner', password, address), /claim_lan_only/);
    const claims = await Promise.allSettled([
      security.claim('Owner', password, '::ffff:192.168.1.5'),
      security.claim('Other', 'another long password', 'fd00::5'),
    ]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
    const winnerPassword = store.get<any>('administrator').name === 'Owner' ? password : 'another long password';
    await assert.rejects(security.login('wrong'), /invalid_credentials/);
    const session = await security.login(winnerPassword);
    store.close();
    store = new Store(directory);
    security = new Security(store, 'https://manager.test:9443');
    const request = (patch: Record<string, unknown> = {}) =>
      ({
        headers: {
          host: 'manager.test:9443',
          origin: 'https://manager.test:9443',
          cookie: `__Host-frameleaf-manager=${session.session}`,
          'x-csrf-token': session.csrf,
        },
        method: 'POST',
        path: '/manager-api/control',
        socket: { remoteAddress: '127.0.0.1' },
        is: () => true,
        ...patch,
      }) as unknown as Request;
    assert.equal(security.session(request()).csrf, session.csrf);
    let status = 0,
      next = false;
    const response = {
      set: () => {},
      status: (value: number) => {
        status = value;
        return response;
      },
      json: () => {},
    } as unknown as Response;
    security.guard(request(), response, () => {
      next = true;
    });
    assert.equal(next, true);
    for (const headers of [
      { host: 'evil.test' },
      { host: 'manager.test:9443', origin: 'https://evil.test' },
      { ...request().headers, 'x-csrf-token': 'bad' },
      { ...request().headers, cookie: '' },
    ]) {
      next = false;
      status = 0;
      security.guard(request({ headers }), response, () => {
        next = true;
      });
      assert.equal(next, false);
      assert.ok(status === 401 || status === 403);
    }
    for (let i = 0; i < 10; i++) security.limit('other-client');
    assert.throws(() => security.limit('other-client'), /rate_limited/);
    assert.ok(!JSON.stringify(store.get('administrator')).includes(winnerPassword));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a persisted destructive intent prevents concurrent or repeated operations after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-journal-'));
  let store = new Store(directory);
  try {
    const initial = store.start('import', 'request-1', { review: 'immutable' });
    initial.operation.step = 'restore-new-database';
    initial.operation.completed.push('fence-source');
    store.save(initial.operation);
    assert.throws(() => store.start('install', 'request-2', {}), /operation_in_progress/);
    assert.equal(store.start('import', 'request-1', { review: 'immutable' }).created, false);
    assert.throws(() => store.start('import', 'request-1', { review: 'changed' }), /request_key_reused/);
    store.close();
    store = new Store(directory);
    store.interrupt();
    const recovered = store.history()[0];
    assert.equal(recovered.state, 'interrupted');
    assert.equal(recovered.step, 'restore-new-database');
    assert.deepEqual(recovered.completed, ['fence-source']);
    assert.throws(() => store.start('backup', 'request-3', {}), /operation_in_progress/);
    recovered.state = 'complete';
    store.save(recovered);
    assert.equal(store.start('backup', 'request-3', {}).created, true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});


test('optional same-host HTTPS framing retains Manager origin and CSRF protection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-frame-'));
  const store = new Store(directory);
  try {
    const origin = 'https://nas.test:9443';
    const invoke = (frame?: string, headers = { host: 'nas.test:9443' }, method = 'GET', path = '/') => {
      let csp = '', status = 0, next = false;
      const security = new Security(store, origin, frame);
      const response = {
        set: (value: Record<string, string>) => { csp = value['Content-Security-Policy']; },
        status: (value: number) => { status = value; return response; },
        json: () => {},
      } as unknown as Response;
      security.guard({ headers, method, path, socket: { remoteAddress: 'fixture' }, is: () => true } as unknown as Request,
        response, () => { next = true; });
      return { csp, status, next };
    };
    assert.match(invoke().csp, /frame-ancestors 'none'/);
    assert.match(invoke('https://nas.test:5001').csp, /frame-ancestors https:\/\/nas.test:5001;/);
    assert.equal(invoke('https://nas.test:5001').next, true);
    for (const frame of ['http://nas.test:5000', 'https://other.test:5001', 'https://user@nas.test:5001',
      'https://nas.test:5001/path', 'https://nas.test:5001?query=1', 'https://nas.test:5001#fragment', '*'])
      assert.throws(() => invoke(frame));
    assert.equal(invoke('https://nas.test:5001', { host: 'evil.test' }).status, 403);
    const dsmWrite = invoke('https://nas.test:5001', { host: 'nas.test:9443', origin: 'https://nas.test:5001' } as any,
      'POST', '/manager-api/login');
    assert.equal(dsmWrite.status, 403, 'Framing does not grant the parent origin API access');
    assert.equal(dsmWrite.next, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('without MANAGER_ORIGIN, Manager accepts local addresses only and still checks write origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-no-origin-'));
  const store = new Store(directory);
  try {
    const security = new Security(store, undefined);
    const invoke = (headers: Record<string, string>, method = 'GET', path = '/') => {
      let status = 0, next = false;
      const response = {
        set: () => {},
        status: (value: number) => { status = value; return response; },
        json: () => {},
      } as unknown as Response;
      security.guard({ headers, method, path, socket: { remoteAddress: 'fixture' }, is: () => true } as unknown as Request,
        response, () => { next = true; });
      return { status, next };
    };
    for (const host of ['192.168.1.20:9443', '[fd00::1]:9443', 'localhost:9443', 'tower.local:9443', 'tower:9443'])
      assert.equal(invoke({ host }).next, true, host);
    for (const host of ['evil.example:9443', 'attacker.com', '', 'a b'])
      assert.equal(invoke({ host }).status, 403, host);
    assert.equal(invoke({ host: 'tower:9443', origin: 'https://tower:9443' }, 'POST', '/manager-api/login').next, true);
    assert.equal(invoke({ host: 'tower:9443', origin: 'https://192.168.1.20:9443' }, 'POST', '/manager-api/login').status, 403);
    assert.equal(security.requestOrigin({ headers: { host: 'tower.local:9443' } } as unknown as Request), 'https://tower.local:9443');
    assert.throws(() => new Security(store, undefined, 'https://tower:5001'));
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a signed-in session polling the dashboard never runs out of the per-address budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-rate-'));
  const store = new Store(directory);
  try {
    const security = new Security(store, 'https://manager.test:9443');
    await security.claim('Owner', 'a private test password', '::ffff:192.168.1.5');
    const session = await security.login('a private test password');
    const statuses: number[] = [];
    const response = {
      set: () => {},
      status: (value: number) => {
        statuses.push(value);
        return response;
      },
      json: () => {},
    } as unknown as Response;
    const get = (cookie: string) =>
      security.guard(
        {
          headers: { host: 'manager.test:9443', cookie },
          method: 'GET',
          path: '/manager-api/dashboard',
          socket: { remoteAddress: '192.168.1.5' },
        } as unknown as Request,
        response,
        () => {},
      );
    // Two visible tabs polling every 10 s for 10 minutes.
    for (let i = 0; i < 130; i++) get(`__Host-frameleaf-manager=${session.session}`);
    assert.deepEqual(statuses, []);
    // Requests without a session still share the address's budget.
    for (let i = 0; i < 121; i++) get('');
    assert.equal(statuses.at(-1), 429);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
