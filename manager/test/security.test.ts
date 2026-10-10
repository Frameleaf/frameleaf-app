import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { Store } from '../src/store.js';
import { Security } from '../src/security.js';

test('credential changes invalidate existing sessions and in-flight old-password logins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-credentials-'));
  const store = new Store(directory),
    proof = 'a'.repeat(64),
    password = 'old private password',
    replacement = 'new private password';
  await writeFile(join(directory, 'claim-key'), proof);
  const security = new Security(store, 'https://manager.test:9443', join(directory, 'claim-key'));
  try {
    await security.claim('Owner', password, proof);
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

test('claim proof, atomic administrator creation, sessions and CSRF survive Manager replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'manager-security-'));
  const proof = '1'.repeat(64),
    password = 'a private test password';
  await writeFile(join(directory, 'claim-key'), proof);
  let store = new Store(directory);
  try {
    let security = new Security(store, 'https://manager.test:9443', join(directory, 'claim-key'));
    await assert.rejects(security.claim('Owner', password, '2'.repeat(64)), /invalid_claim_proof/);
    const claims = await Promise.allSettled([
      security.claim('Owner', password, proof),
      security.claim('Other', 'another long password', proof),
    ]);
    assert.equal(claims.filter((r) => r.status === 'fulfilled').length, 1);
    const winnerPassword = store.get<any>('administrator').name === 'Owner' ? password : 'another long password';
    await assert.rejects(security.login('wrong'), /invalid_credentials/);
    const session = await security.login(winnerPassword);
    store.close();
    store = new Store(directory);
    security = new Security(store, 'https://manager.test:9443', join(directory, 'claim-key'));
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
      const security = new Security(store, origin, join(directory, 'claim-key'), frame);
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
