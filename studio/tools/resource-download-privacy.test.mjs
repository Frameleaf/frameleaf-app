import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

// Synthetic requests and approval only; no network, customer data or inference.
test('model download transport refuses uploads before forwarding and preserves bodyless pinning', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-model-download-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, '../runtime'), path.join(root, 'runtime'), { recursive: true });
  const row = { id: 'model:synthetic-contract/privacy', kind: 'model', locator: 'synthetic-contract/privacy', revision: 'a'.repeat(40),
    licenseDeclared: 'Synthetic contract only', decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' }, files: [{ path: 'config.json', sha256: createHash('sha256').update('synthetic').digest('hex') }] };
  await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify({ schemaVersion: 1, resources: [row] }));
  await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify({ schemaVersion: 1, approvedBy: 'Synthetic contract',
    approvedOn: '2026-10-07', source: 'Authored privacy check, not production approval', uses: ['localRuntime'],
    resources: [{ id: row.id, sha256: approvalRowDigest(row) }] }));
  const engine = path.join(root, 'engine');
  await writeResourcePolicy(root, engine);
  const forwarded = [];
  const original = globalThis.fetch;
  const NativeRequest = globalThis.Request;
  // Vitest's jsdom compatibility Request extends Node's native Request. The
  // native brand-checking url getter is inherited rather than an own property.
  globalThis.Request = class Request extends NativeRequest {};
  const installed = Symbol.for('frameleaf.resource-admission.fetch-pinned');
  const previous = globalThis[installed];
  t.after(() => {
    globalThis.fetch = original;
    globalThis.Request = NativeRequest;
    if (previous === undefined) delete globalThis[installed]; else globalThis[installed] = previous;
  });
  assert.equal(previous, undefined, 'Run the transport check in its own Node test process');
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init); // Validate inputs as the native transport would.
    forwarded.push({ input, init, request });
    return new Response('synthetic');
  };
  await import(path.join(engine, 'src/shared/utils/resource-admission.mjs'));
  const branch = `https://huggingface.co/${row.locator}/resolve/main/config.json`;
  const pinned = branch.replace('/main/', `/${row.revision}/`);
  // A native URL with a foreign prototype reproduces the iframe instanceof mismatch.
  const foreignUrl = new URL(branch);
  Object.setPrototypeOf(foreignUrl, Object.defineProperties(runInNewContext('({})'), Object.getOwnPropertyDescriptors(URL.prototype)));
  assert.equal(foreignUrl instanceof URL, false);
  const boxed = new String(branch);
  for (const input of [foreignUrl, boxed]) {
    await assert.rejects(async () => fetch(input, { method: 'POST', body: 'synthetic audio' }), /FRAMELEAF_RESOURCE_BLOCKED/);
  }
  let methodReads = 0;
  let bodyReads = 0;
  const changingInit = {
    get method() { methodReads++; return bodyReads === 0 ? 'GET' : 'POST'; },
    get body() { return ++bodyReads === 1 ? null : 'synthetic audio'; },
  };
  const shadowed = new Request(pinned, { method: 'POST', body: 'synthetic audio' });
  Object.defineProperties(shadowed, { method: { value: 'GET' }, body: { value: null } });
  const refusals = await Promise.allSettled([
    assert.rejects(async () => fetch(pinned, changingInit), /FRAMELEAF_RESOURCE_BLOCKED/),
    assert.rejects(async () => fetch(shadowed), /FRAMELEAF_RESOURCE_BLOCKED/),
  ]);
  assert.deepEqual(refusals.map(({ status }) => status), ['fulfilled', 'fulfilled'], 'Changing init accessors and shadowed Request properties both refuse before transport');
  assert.equal(forwarded.length, 0, 'Neither request reaches the transport');
  assert.deepEqual([methodReads, bodyReads], [1, 1], 'Effective init state is read once');
  for (const input of [branch, new URL(branch), new Request(branch), foreignUrl, boxed]) {
    for (const method of ['GET', 'HEAD']) {
      await fetch(input, { method });
      const last = forwarded.at(-1);
      assert.equal(typeof last.input === 'string' ? last.input : last.input.url, pinned);
      assert.equal(last.request.method, method);
      assert.equal(last.init, undefined, 'Transport receives checked Request state without the original init');
    }
  }
  await fetch(new Request(branch, { method: 'DELETE' }), { method: 'GET' });
  assert.equal(forwarded.at(-1).input.url, pinned, 'The effective method also controls Request pinning');
  const properties = new Request(branch, { headers: { 'x-synthetic': 'preserved' }, credentials: 'omit', cache: 'no-store', redirect: 'error' });
  await fetch(properties, { method: 'HEAD' });
  assert.equal(forwarded.at(-1).request.headers.get('x-synthetic'), 'preserved');
  for (const key of ['credentials', 'cache', 'redirect']) assert.equal(forwarded.at(-1).request[key], properties[key]);
  let conversions = 0;
  await fetch({ toString() { return ++conversions === 1 ? branch : 'https://frameleaf.invalid/changed'; } });
  assert.equal(conversions, 1, 'Mutable input coercion is evaluated only once');
  assert.equal(forwarded.at(-1).request.url, pinned, 'The same normalized input is checked, pinned and forwarded');
  for (const input of [branch, new URL(pinned), new Request(pinned), foreignUrl, boxed]) {
    for (const init of [{ method: 'POST', body: 'synthetic audio' }, { method: 'DELETE' }, { body: '' }]) {
      await assert.rejects(async () => fetch(input, init), /FRAMELEAF_RESOURCE_BLOCKED/);
    }
  }
  const post = new Request(branch, { method: 'POST', body: 'synthetic audio' });
  await assert.rejects(async () => fetch(post), /FRAMELEAF_RESOURCE_BLOCKED/);
  await assert.rejects(async () => fetch(post, { method: 'GET' }), /FRAMELEAF_RESOURCE_BLOCKED/);
  for (const url of [pinned.replace('huggingface.co', 'HUGGINGFACE.CO:443'), pinned.replace('huggingface.co', 'huggingface.co.'), pinned.replace('https:', 'http:'), 'https://huggingface.co/api/models/synthetic-contract/privacy/tree/main']) {
    await assert.rejects(async () => fetch(url, { method: 'POST', body: 'synthetic audio' }), /FRAMELEAF_RESOURCE_BLOCKED/);
  }
  await assert.rejects(async () => fetch('https://synthetic:credential@huggingface.co/api?synthetic-query=private', { method: 'POST' }), {
    message: 'FRAMELEAF_RESOURCE_BLOCKED: https://huggingface.co/api',
  });
  await assert.rejects(async () => fetch('not a URL'), TypeError, 'Invalid inputs retain native transport rejection');
  assert.equal(forwarded.length, 13, 'No rejected request reaches the underlying transport');
  const host = 'https://frameleaf.invalid/explicit-cloud-job';
  const init = { method: 'POST', body: 'synthetic explicitly submitted job' };
  await fetch(host, init);
  assert.equal(forwarded.at(-1).input, host);
  assert.equal(forwarded.at(-1).init, init, 'Unrelated explicit host requests retain their behavior');
});
