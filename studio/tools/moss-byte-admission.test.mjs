// Actual MOSS readers and model/external-shard sinks with synthetic approved bytes.
// No model download, inference, OPFS platform or production activation is qualified.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
const engine = new URL('../engine/public/moss-tts/', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const revision = 'a'.repeat(40);
const payload = new TextEncoder().encode('{"synthetic":true}');
const corrupt = new TextEncoder().encode('mismatch');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'moss-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const f of ['browser_model_store.js', 'browser_onnx_runtime.js', 'vendor'])
    await cp(new URL(f, engine), path.join(root, f), { recursive: true });
  await cp(new URL('../runtime/resource-admission.mjs', import.meta.url), path.join(root, 'resource-admission.mjs'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const source = await readFile(path.join(root, 'browser_model_store.js'), 'utf8');
  const repos = [...source.matchAll(/repoId: '([^']+)',\s+localDirName: '([^']+)',\s+requiredFiles: \[([\s\S]*?)\]/g)]
    .map(m => ({ id: m[1], dir: m[2], files: [...m[3].matchAll(/'([^']+)'/g)].map(f => f[1]) }));
  assert.equal(repos.length, 2);
  const policy = Object.fromEntries(repos.map(repo => [`model:${repo.id}`, {
    locator: repo.id, revision, localRuntime: 'allowed', approvalSha256: 'b'.repeat(64),
    files: Object.fromEntries(repo.files.map(file => { const url = `https://huggingface.co/${repo.id}/resolve/${revision}/${file}`;
      return [url, { url, revision, approvalSha256: 'b'.repeat(64), sha256: hash(payload) }]; })),
  }]));
  await writeFile(path.join(root, 'resource-policy.json'), JSON.stringify(policy));
  const fetchBefore = globalThis.fetch;
  const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const storeBefore = globalThis.NanoReaderBrowserModelStore;
  const pin = Symbol.for('frameleaf.resource-admission.fetch-pinned'); const pinBefore = globalThis[pin];
  delete globalThis[pin];
  t.after(() => { globalThis.fetch = fetchBefore; globalThis.NanoReaderBrowserModelStore = storeBefore;
    if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore); else delete globalThis.navigator;
    if (pinBefore === undefined) delete globalThis[pin]; else globalThis[pin] = pinBefore; });
  const files = new Map(); let writes = 0; let aborts = 0; let served = payload; let failWrite = false; let cancelOnWrite; let fetches = 0; let status = 200; let cancelOnFetch;
  const directory = (prefix = '') => ({
    getDirectoryHandle: async name => directory(prefix + name + '/'),
    getFileHandle: async (name, { create } = {}) => {
      const key = prefix + name;
      if (!create && !files.has(key)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return { getFile: async () => new Blob([files.get(key)]), createWritable: async () => {
        let pending; return { truncate: async () => {}, write: async bytes => { writes++; cancelOnWrite?.(); if (failWrite) throw new Error('write failed'); pending = new Uint8Array(bytes); },
          close: async () => { files.set(key, pending); }, abort: async () => { aborts++; } };
      } };
    },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => directory(), persist: async () => true } } });
  globalThis.fetch = async () => { fetches++; cancelOnFetch?.(); return new Response(served, { status }); };
  const storeModule = await import(pathToFileURL(path.join(root, 'browser_model_store.js')));
  const runtimeModule = await import(pathToFileURL(path.join(root, 'browser_onnx_runtime.js')));
  const ort = await import(pathToFileURL(path.join(root, 'vendor/ort/ort.wasm.min.mjs')));
  const sessions = []; const createBefore = ort.InferenceSession.create;
  ort.InferenceSession.create = async (bytes, options) => { sessions.push({ bytes, options }); return {}; };
  t.after(() => { ort.InferenceSession.create = createBefore; });
  const policyModule = await import(pathToFileURL(path.join(root, 'resource-policy.json')), { with: { type: 'json' } });
  const runtime = new runtimeModule.BrowserOnnxTtsRuntime();
  runtime.localPathRoot = 'https://local.example/models';
  return { runtime, store: globalThis.NanoReaderBrowserModelStore, storeModule, repos, files, sessions, policy: policyModule.default,
    cancelWrite: callback => { cancelOnWrite = callback; }, cancelFetch: callback => { cancelOnFetch = callback; },
    status: value => { status = value; }, serve: bytes => { served = bytes; }, failWrite: () => { failWrite = true; }, counts: () => ({ writes, aborts, fetches }) };
}

test('local and injected readers verify raw metadata, model and external-shard bytes before consumption', async t => {
  const f = await fixture(t); const model = 'MOSS-TTS-Nano-100M-ONNX/moss_tts_prefill.onnx';
  assert.deepEqual(await f.runtime.readBufferAsset(model), payload);
  assert.deepEqual(await f.runtime.readJsonAsset('browser_poc_manifest.json'), { synthetic: true });
  f.serve(corrupt);
  await assert.rejects(f.runtime.readBufferAsset(model), /FRAMELEAF_RESOURCE_BLOCKED/);
  f.runtime.assetReader = { readBuffer: async ({ relativePath }) => relativePath.endsWith('.json') ? payload : corrupt, readText: async () => '{"synthetic":true}', readJson: async () => ({ forged: true }) };
  await assert.rejects(f.runtime.readBufferAsset(model), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.deepEqual(await f.runtime.readJsonAsset('browser_poc_manifest.json'), { synthetic: true }, 'Parsed-object bypass is unused');
  f.runtime.ensureManifestLoaded = async () => { f.runtime.manifest = { model_files: { tokenizer_model: 'tokenizer.model' } }; f.runtime.manifestRelativeDir = ''; };
  f.runtime.assetReader = { readBuffer: async () => corrupt };
  await assert.rejects(f.runtime.ensureTokenizerLoaded(), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(f.runtime.tokenizer, null, 'Rejected bytes cannot initialize tokenizer');
  f.runtime.assetReader = { readBuffer: async ({ relativePath }) => relativePath.endsWith('.data') ? corrupt : payload };
  await assert.rejects(f.runtime.createOrtSession(model, ['MOSS-TTS-Nano-100M-ONNX/moss_tts_global_shared.data']), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(f.sessions.length, 0, 'Rejected external data prevents any ORT creation');
  f.runtime.assetReader = { readBuffer: async () => payload };
  await f.runtime.createOrtSession(model, ['MOSS-TTS-Nano-100M-ONNX/moss_tts_global_shared.data']);
  assert.deepEqual(f.sessions[0].bytes, payload); assert.deepEqual(f.sessions[0].options.externalData[0].data, payload);
  for (const bad of ['../tokenizer.model', 'MOSS-TTS-Nano-100M-ONNX/../tokenizer.model', 'tokenizer.model?x=1', 'unknown.onnx', 'tokenizer.model/extra'])
    await assert.rejects(f.runtime.readBufferAsset(bad), /FRAMELEAF_RESOURCE_BLOCKED/);
  f.runtime.assetReader = { readJson: async () => ({ forged: true }) };
  await assert.rejects(f.runtime.readJsonAsset('browser_poc_manifest.json'), /raw|bytes|FRAMELEAF_RESOURCE_BLOCKED/);
});

test('raw tokenizer and codec metadata paths refuse before reader, tokenizer or ORT', async t => {
  const f = await fixture(t);
  let reads = 0;
  f.runtime.assetReader = { readBuffer: async () => { reads++; return payload; } };
  f.runtime.ensureOrtConfigured = async () => {};
  const dir = 'MOSS-TTS-Nano-100M-ONNX';
  const codecDir = 'MOSS-Audio-Tokenizer-Nano-ONNX';
  for (const raw of ['/tokenizer.model', '\\tokenizer.model', 'MOSS-TTS-Nano-100M-ONNX\\tokenizer.model', '../tokenizer.model']) {
    f.runtime.ensureManifestLoaded = async () => {
      f.runtime.manifest = { model_files: { tokenizer_model: raw } };
      f.runtime.manifestRelativeDir = dir;
    };
    await assert.rejects(f.runtime.ensureTokenizerLoaded(), /FRAMELEAF_RESOURCE_BLOCKED/);
    assert.equal(reads, 0, raw);
    assert.equal(f.runtime.tokenizer, null, 'Raw metadata rejection precedes tokenizer sandbox');
  }
  for (const raw of ['/moss_audio_tokenizer_encode.onnx', '\\moss_audio_tokenizer_encode.onnx', '../moss_audio_tokenizer_encode.onnx']) {
    f.runtime.ensureManifestLoaded = async () => {
      f.runtime.codecMetaRelativePath = `${codecDir}/codec_meta.json`;
      f.runtime.codecMeta = { files: { encode: raw } };
    };
    await assert.rejects(f.runtime.ensureCodecEncodeLoaded(), /FRAMELEAF_RESOURCE_BLOCKED/);
    assert.equal(reads, 0, raw);
    assert.equal(f.sessions.length, 0);
  }
  for (const raw of ['/moss_audio_tokenizer_encode.data', '\\moss_audio_tokenizer_encode.data', '../moss_audio_tokenizer_encode.data']) {
    f.runtime.ensureManifestLoaded = async () => {
      f.runtime.codecMetaRelativePath = `${codecDir}/codec_meta.json`;
      f.runtime.codecMeta = { files: { encode: 'moss_audio_tokenizer_encode.onnx' }, external_data_files: { 'moss_audio_tokenizer_encode.onnx': [raw] } };
    };
    await assert.rejects(f.runtime.ensureCodecEncodeLoaded(), /FRAMELEAF_RESOURCE_BLOCKED/);
    assert.equal(reads, 0, raw);
    assert.equal(f.sessions.length, 0, 'Metadata shard rejection precedes actual session creation');
  }
  f.runtime.ensureManifestLoaded = async () => {
    f.runtime.codecMetaRelativePath = `${codecDir}/codec_browser_onnx_meta.json`;
    f.runtime.codecMeta = { files: { encode: 'moss_audio_tokenizer_encode.onnx' }, external_data_files: { 'moss_audio_tokenizer_encode.onnx': ['moss_audio_tokenizer_encode.data'] } };
  };
  await f.runtime.ensureCodecEncodeLoaded();
  assert.equal(reads, 2, 'Canonical metadata reaches verified model and shard readers');
  assert.equal(f.sessions.length, 1);
  assert.deepEqual(f.sessions[0].options.externalData[0], { path: 'moss_audio_tokenizer_encode.data', data: payload });
});

test('OPFS download and warm reuse validate all files; rejected or failed writes do not commit', async t => {
  const f = await fixture(t);
  f.serve(corrupt);
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels(), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(f.counts().writes, 0); assert.equal(f.files.size, 0);
  f.serve(payload);
  const result = await f.store.ensureExternalBrowserOnnxModels(); assert.equal(result.downloaded, true);
  assert.equal(f.files.size, 16); assert.equal(f.counts().writes, 16);
  const key = [...f.files.keys()].find(k => k.endsWith('tokenizer.model')); f.files.set(key, corrupt);
  await assert.rejects(f.store.readBufferFromManagedPath(result.managedPath, 'MOSS-TTS-Nano-100M-ONNX/tokenizer.model'), /FRAMELEAF_RESOURCE_BLOCKED/);
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels(), /FRAMELEAF_RESOURCE_BLOCKED/);
  f.files.set(key, payload);
  assert.equal((await f.store.ensureExternalBrowserOnnxModels()).downloaded, false);
  assert.equal(f.counts().writes, 16, 'Verified complete warm store never downloads or rewrites');
  f.failWrite();
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels({ forceDownload: true }), /write failed/);
  assert.equal(f.counts().aborts, 1); assert.deepEqual(f.files.get(key), payload);
});


test('missing/mismatched exact bindings refuse before fetch or reader; cancellation never commits', async t => {
  const f = await fixture(t);
  const row = f.policy['model:OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX'];
  const url = `https://huggingface.co/${row.locator}/resolve/${revision}/tokenizer.model`;
  const binding = row.files[url];
  let reads = 0; f.runtime.assetReader = { readBuffer: async () => { reads++; return payload; } };
  for (const patch of [{ sha256: null }, { revision: 'c'.repeat(40) }, { approvalSha256: 'c'.repeat(64) }]) {
    row.files[url] = { ...binding, ...patch };
    await assert.rejects(f.runtime.readBufferAsset('tokenizer.model'), /FRAMELEAF_RESOURCE_BLOCKED/);
  }
  delete row.files[url];
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels(), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(reads, 0); assert.equal(f.counts().fetches, 0); assert.equal(f.counts().writes, 0);
  row.files[url] = binding;
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.counts().fetches, 0);
  const duringBody = new AbortController(); f.cancelFetch(() => duringBody.abort());
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels({ signal: duringBody.signal }), { name: 'AbortError' });
  assert.equal(f.counts().writes, 0); assert.equal(f.files.size, 0);
  f.cancelFetch(null);
  f.status(206);
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels(), /FRAMELEAF_RESOURCE_BLOCKED/);
  assert.equal(f.files.size, 0);
  f.status(200);
  const duringWrite = new AbortController(); f.cancelWrite(() => duringWrite.abort());
  await assert.rejects(f.store.ensureExternalBrowserOnnxModels({ signal: duringWrite.signal }), { name: 'AbortError' });
  assert.equal(f.counts().aborts, 1); assert.equal(f.files.size, 0, 'Aborted writable has no committed payload');
});
