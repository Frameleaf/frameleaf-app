import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

// A non-native test realm must still import unrelated admission consumers, but
// cannot authorize any model fetch/cache through mock Request properties.
test('missing native Request getter imports safely and refuses model transport before any sink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-request-realm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, '../runtime'), path.join(root, 'runtime'), { recursive: true });
  const row = { id: 'model:synthetic-contract/realm', kind: 'model', locator: 'synthetic-contract/realm', revision: 'a'.repeat(40),
    licenseDeclared: 'Synthetic contract only', decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' },
    files: [{ path: 'config.json', sha256: createHash('sha256').update('synthetic').digest('hex') }] };
  await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify({ schemaVersion: 1, resources: [row] }));
  await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify({ schemaVersion: 1, approvedBy: 'Synthetic contract',
    approvedOn: '2026-10-07', source: 'Authored realm contract, not production approval', uses: ['localRuntime'],
    resources: [{ id: row.id, sha256: approvalRowDigest(row) }] }));
  const engine = path.join(root, 'engine');
  await writeResourcePolicy(root, engine);
  const saved = { Request: globalThis.Request, fetch: globalThis.fetch, caches: globalThis.caches, location: globalThis.location };
  const symbols = ['fetch-pinned', 'cache-pinned'].map(name => Symbol.for(`frameleaf.resource-admission.${name}`));
  assert.ok(symbols.every(symbol => globalThis[symbol] === undefined), 'Fresh test process');
  t.after(() => { Object.assign(globalThis, saved); for (const symbol of symbols) delete globalThis[symbol]; });
  let requests = 0, transports = 0, reads = 0, writes = 0;
  globalThis.Request = class MockRequest {
    constructor(url) { requests++; this.url = String(url); this.method = 'GET'; this.body = null; }
  };
  globalThis.fetch = async () => { transports++; return new Response('synthetic'); };
  globalThis.location = { href: 'http://127.0.0.1:5186/qualification' };
  const raw = { match: async () => { reads++; return new Response('synthetic'); }, put: async () => { writes++; } };
  globalThis.caches = { open: async () => raw, match: raw.match };
  const admission = await import(path.join(engine, 'src/shared/utils/resource-admission.mjs'));
  assert.equal(admission.requireResource(row.id).revision, row.revision, 'Non-transport policy queries remain available');
  const url = `https://huggingface.co/${row.locator}/resolve/${row.revision}/config.json`;
  const cache = await caches.open('transformers-cache');
  for (const work of [() => fetch(url), () => fetch(new URL(url)), () => cache.match(url),
    () => cache.put(url, new Response('synthetic')), () => caches.match(url),
    () => caches.match(new saved.Request(url))]) {
    await assert.rejects(work, /FRAMELEAF_RESOURCE_BLOCKED/);
  }
  assert.deepEqual([requests, transports, reads, writes], [0, 0, 0, 0], 'No mock Request, transport, cache read or cache persist occurs');
  await assert.rejects(() => fetch(new saved.Request(url)), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(transports, 0, 'Missing branding cannot delegate an opaque Request to raw transport');
  assert.equal(await (await caches.match('http://127.0.0.1:5186/local', { cacheName: 'fixture-unrelated' })).text(), 'synthetic');
  assert.equal(reads, 1, 'An explicit unrelated bucket retains its cache behavior');
});
