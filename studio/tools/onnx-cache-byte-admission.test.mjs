// Synthetic transport/cache contracts against the patched source and generated policy.
// No model download, inference or browser qualification is claimed here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeResourcePolicy } from './resource-policy.mjs';
import { approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

test('direct ONNX cache and network bytes are verified before use or persistence', async (t) => {
  const studio = path.resolve(import.meta.dirname, '..');
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-onnx-cache-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const relative = 'src/shared/utils/onnx-model-cache.ts';
  const source = await readFile(path.join(studio, 'vendor/freecut', relative));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const provenance = JSON.parse(await readFile(path.join(studio, 'freecut-provenance.json')));
  assert.equal(hash(source), provenance.files.find((file) => file.path === relative).sha256);
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), source);
  const build = JSON.parse(await readFile(path.join(studio, 'engine-build.json')));
  for (const patch of build.patches) {
    const file = path.join(studio, patch.path);
    const bytes = await readFile(file);
    if (!bytes.includes(Buffer.from(`a/${relative}`))) continue;
    assert.equal(hash(bytes), patch.sha256, 'The exercised patch must match its registered digest');
    execFileSync('git', ['apply', `--include=${relative}`, file], { cwd: root });
  }
  const revision = 'a'.repeat(40);
  const base = `https://huggingface.co/synthetic-contract/cache/resolve/${revision}/`;
  const payload = new TextEncoder().encode('{"text":"café"}');
  const row = { id: 'model:synthetic-contract/cache', kind: 'model', locator: 'synthetic-contract/cache', revision,
    licenseDeclared: 'Synthetic contract only', decisions: { redistribution: 'blocked', localRuntime: 'blocked', hostedUse: 'blocked' },
    files: [{ path: 'weights.bin', sha256: hash(payload) }, { path: 'config.json', sha256: hash(payload) }, { path: 'unreviewed.bin', sha256: null }] };
  await cp(path.join(studio, 'runtime'), path.join(root, 'runtime'), { recursive: true });
  await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify({ schemaVersion: 1, resources: [row] }));
  await writeFile(path.join(root, 'rights-approval.json'), JSON.stringify({ schemaVersion: 1, approvedBy: 'Synthetic contract',
    approvedOn: '2026-10-06', source: 'Authored transport refusal check, not production approval', uses: ['localRuntime'],
    resources: [{ id: row.id, sha256: approvalRowDigest(row) }] }));
  await writeResourcePolicy(root, path.join(root, 'policy'));
  const code = stripTypeScriptTypes(await readFile(path.join(root, relative), 'utf8'))
    .replace("'@/shared/utils/resource-admission.mjs'", "'./policy/src/shared/utils/resource-admission.mjs'");
  await writeFile(path.join(root, 'cache.mjs'), code);
  const model = await import(path.join(root, 'cache.mjs'));
  const saved = new Map();
  let downloads = 0; let puts = 0; let served = payload;
  const cache = {
    match: async (url) => saved.get(url)?.clone(),
    put: async (url, response) => { puts++; saved.set(url, response.clone()); },
    delete: async (url) => saved.delete(url),
  };
  const fetchBefore = globalThis.fetch;
  const cachesBefore = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  t.after(() => {
    globalThis.fetch = fetchBefore;
    if (cachesBefore) Object.defineProperty(globalThis, 'caches', cachesBefore);
    else delete globalThis.caches;
  });
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async () => cache } });
  globalThis.fetch = async () => { downloads++; return new Response(served, { headers: { 'content-length': String(served.length) } }); };
  const url = `${base}weights.bin`;
  const progress = [[], []];
  const requests = progress.map((events) => model.fetchOnnxModelBytes(url, (...event) => events.push(event)));
  assert.equal(requests[0], requests[1], 'Concurrent callers share one verified download');
  assert.deepEqual(new Uint8Array(await requests[0]), payload);
  assert.equal(downloads, 1); assert.equal(puts, 1);
  assert.ok(progress.every((events) => events.some(([, , warm]) => warm === false)));
  globalThis.fetch = async () => { throw new Error('offline'); };
  const warmProgress = [];
  assert.deepEqual(new Uint8Array(await model.fetchOnnxModelBytes(url, (...event) => warmProgress.push(event))), payload, 'Verified warm bytes remain usable offline');
  assert.ok(warmProgress.some(([, , warm]) => warm === true));
  saved.set(url, new Response('corrupt'));
  await assert.rejects(model.fetchOnnxModelBytes(url), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(saved.has(url), false, 'A corrupt cache entry is evicted without a hidden network retry');
  globalThis.fetch = async () => { downloads++; return new Response(served); };
  served = new TextEncoder().encode('corrupt');
  await assert.rejects(model.fetchOnnxModelBytes(url), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(saved.has(url), false); assert.equal(puts, 1, 'Unverified network bytes are never persisted');
  served = payload;
  assert.equal(await model.fetchOnnxModelText(`${base}config.json`), '{"text":"café"}');
  assert.deepEqual(await model.fetchOnnxModelJson(`${base}config.json`), { text: 'café' });
  saved.set(`${base}config.json`, new Response('corrupt'));
  await assert.rejects(model.fetchOnnxModelText(`${base}config.json`), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(saved.has(`${base}config.json`), false);
  await assert.rejects(model.fetchOnnxModelBytes(`${base}unreviewed.bin`), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(saved.has(`${base}unreviewed.bin`), false);
  const before = downloads;
  await assert.rejects(async () => model.fetchOnnxModelBytes(base.replace(revision, 'main') + 'weights.bin'), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(downloads, before, 'A branch URL is refused before any download');
});
