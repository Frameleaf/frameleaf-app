import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { Store } from '../src/store.js';
import { Security } from '../src/security.js';

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
