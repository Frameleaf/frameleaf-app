// FL-103 / FL-111: the Whisper worker's word timestamps, checked against real model output.
//
// Always: the transformers.js the worker bundles is the version the recorded evidence was made
// with, so a version change fails here until the real-model run below passes on it and the
// evidence is re-recorded.
// STUDIO_WHISPER_TIMING=1: download the approved whisper-tiny revision (about 40 MB, cached under
// a new ephemeral child of STUDIO_MODEL_CACHE or the OS temp folder) and transcribe the fixture clip with the worker's own
// options; every word must match the recorded timing and no word may run into a measured pause.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { withEphemeralPipeline } from './lib/ephemeral-pipeline.mjs';
import { ownerApproval, approvalRowDigest } from '../../scripts/frameleaf-studio-rights.mjs';

const here = import.meta.dirname;
const engine = path.resolve(here, '../engine');
const worker = path.join(engine, 'src/features/media-library/transcription/workers/whisper.worker.ts');
const evidence = JSON.parse(readFileSync(path.join(here, 'fixtures/whisper-timing.json'), 'utf8'));

/** The transformers.js package directory the worker imports (a relative dist path or a bare name). */
const workerTransformers = () => {
  const source = readFileSync(worker, 'utf8');
  const relative = /import\(\s*(?:\/\/[^\n]*\n\s*)*'([^']*@huggingface\/transformers[^']*)'/.exec(source);
  assert.ok(relative, 'the Whisper worker must import transformers.js by a static path');
  const specifier = relative[1];
  const file = specifier.startsWith('.') ? path.resolve(path.dirname(worker), specifier) : null;
  const packageDir = file
    ? file.slice(0, file.lastIndexOf(`${path.sep}dist${path.sep}`))
    : path.join(engine, 'node_modules', specifier);
  return { specifier, packageDir, version: JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version };
};

const readWav = (file) => {
  const bytes = readFileSync(file);
  assert.equal(bytes.toString('latin1', 0, 4), 'RIFF');
  let offset = 12;
  let format;
  while (offset < bytes.length) {
    const id = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ') format = { channels: bytes.readUInt16LE(offset + 10), rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
    if (id === 'data') {
      assert.deepEqual(format, { channels: 1, rate: 16_000, bits: 16 });
      const samples = new Float32Array(size / 2);
      for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(offset + 8 + index * 2) / 32_768;
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
};

const ready = existsSync(worker);
const requested = process.env.STUDIO_WHISPER_TIMING === '1';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const responseOrigin = (response) => response.url ? new URL(response.url).origin : null;

test('verified synthetic responses retain unknown upstream origin in diagnostics', () => {
  assert.equal(responseOrigin(new Response('verified bytes')), null);
  assert.equal(responseOrigin({ url: 'https://cdn.example/model.bin' }), 'https://cdn.example');
  assert.throws(() => responseOrigin({ url: 'invalid' }), { code: 'ERR_INVALID_URL' });
});

test('requested Whisper inference requires the prepared engine', () => {
  if (requested) assert.ok(ready, 'STUDIO_WHISPER_TIMING=1 requires a prepared engine; qualification cannot skip');
});

test('the Whisper worker bundles the transformers.js version its timing evidence was recorded with', { skip: !ready && 'engine not prepared' }, () => {
  const { specifier, version } = workerTransformers();
  assert.doesNotMatch(specifier, /^https?:/, 'no CDN import');
  assert.equal(version, evidence.transformersVersion, `word timing was verified on ${evidence.transformersVersion}; re-run with STUDIO_WHISPER_TIMING=1 before changing it`);
  assert.notEqual(version, evidence.rejected.transformersVersion);
});

test('real whisper-tiny word timestamps land on the clip\'s words and pauses', { skip: !requested && 'set STUDIO_WHISPER_TIMING=1 to download the model' }, async () => {
  assert.ok(ready, 'Requested real inference cannot skip an unprepared engine');
  const studio = path.resolve(here, '..');
  const manifest = JSON.parse(readFileSync(path.join(studio, 'dependency-attribution.json')));
  const approval = ownerApproval(JSON.parse(readFileSync(path.join(studio, 'rights-approval.json'))), manifest);
  const ids = [`model:${evidence.model}`, 'runtime:whisper-transformers'];
  for (const id of ids) {
    assert.equal(approval?.approved.get(id), true, `Exact reviewed row approval required: ${id}`);
    for (const use of ['localRuntime', 'hostedUse']) assert.ok(approval.uses.includes(use) && !Object.hasOwn(approval.excluded.get(id) ?? {}, use), `Approval excludes ${use}: ${id}`);
  }
  const { requireResource, approvedRevision, pinnedHuggingFaceUrl } = await import(pathToFileURL(path.join(engine, 'src/shared/utils/resource-admission.mjs')).href);
  for (const id of ids) requireResource(id);
  assert.equal(approvedRevision(ids[0]), evidence.revision);
  const { packageDir, version } = workerTransformers();
  assert.equal(version, evidence.transformersVersion, 'Real inference requires the exact timing-approved runtime');
  const runtimeRow = manifest.resources.find((row) => row.id === 'runtime:whisper-transformers');
  for (const file of runtimeRow.files) assert.equal(sha256(readFileSync(path.join(engine, 'node_modules', file.path))), file.sha256, 'Reviewed bundled runtime bytes differ');
  const { pipeline, env } = await import(pathToFileURL(path.join(packageDir, 'dist/transformers.node.mjs')).href);
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  const originalFetch = globalThis.fetch;
  const payloads = [];
  const report = { schemaVersion: 1, kind: 'diagnostic-whisper-timing', status: 'failed', productionAcceptance: 'unqualified-production-transport-diagnostic-only', model: evidence.model, revision: evidence.revision, transformersVersion: evidence.transformersVersion, sourceCommit: process.env.GITHUB_SHA ?? null, run: process.env.GITHUB_RUN_ID ?? null, fixtureSha256: sha256(readFileSync(path.join(here, 'fixtures/whisper-timing.wav'))), evidenceSha256: sha256(readFileSync(path.join(here, 'fixtures/whisper-timing.json'))), nodeRuntimeObservedSha256: sha256(readFileSync(path.join(packageDir, 'dist/transformers.node.mjs'))), approvalRows: ids.map((id) => ({ id, sha256: approvalRowDigest(manifest.resources.find((row) => row.id === id)) })), payloads };
  globalThis.fetch = async (input, init) => {
    const url = pinnedHuggingFaceUrl(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    assert.ok(['GET', 'HEAD'].includes(method), 'Fixture audio must never be uploaded');
    assert.ok(!init?.body && !input?.body, 'Download requests must have no body');
    assert.ok(url.startsWith(`https://huggingface.co/${evidence.model}/resolve/${evidence.revision}/`) && !new URL(url).search, 'Only exact approved model downloads are permitted');
    requireResource(url);
    const response = await originalFetch(url, init);
    if (method === 'GET' && response.ok) {
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      payloads.push({ origin: url, responseOrigin: responseOrigin(response), revision: evidence.revision, bytes: bytes.byteLength, observedSha256: sha256(bytes), approvedPayloadDigest: null });
    }
    return response;
  };
  try {
  const result = await withEphemeralPipeline(async (cache) => {
    env.cacheDir = cache;
    return pipeline('automatic-speech-recognition', evidence.model, { revision: evidence.revision, dtype: evidence.dtype, device: 'cpu' });
  }, async (asr) => asr(readWav(path.join(here, 'fixtures/whisper-timing.wav')), evidence.options), process.env.STUDIO_MODEL_CACHE);
  const words = result.chunks.map((chunk) => ({ text: chunk.text.trim().toLowerCase(), timestamp: chunk.timestamp }));
  assert.deepEqual(words.map((word) => word.text), evidence.expected.map((word) => word.text.trim().toLowerCase()));
  const tolerance = 0.06;
  for (const [index, word] of words.entries()) {
    const expected = evidence.expected[index].timestamp;
    assert.ok(Math.abs(word.timestamp[0] - expected[0]) <= tolerance && Math.abs(word.timestamp[1] - expected[1]) <= tolerance,
      `${word.text}: ${word.timestamp} vs recorded ${expected}`);
  }
  assert.ok(words[0].timestamp[0] <= 0.05, 'the first word starts with the speech');
  // A word either ends by the end of a pause or starts after its start: none spans a pause.
  for (const [start, end] of evidence.pauses) {
    for (const word of words) {
      assert.ok(!(word.timestamp[0] < start - tolerance && word.timestamp[1] > end + tolerance), `${word.text} spans the pause ${start}–${end}`);
    }
    const after = words.find((word) => word.timestamp[0] >= start - tolerance);
    assert.ok(after && after.timestamp[0] <= end + 0.2, `the word after the pause ${start}–${end} starts with the speech`);
  }
  report.status = 'passed';
  report.words = words;
  report.pipelineDisposed = true;
  report.ephemeralCacheRemoved = true;
  } finally {
    globalThis.fetch = originalFetch;
    if (process.env.STUDIO_WHISPER_REPORT) writeFileSync(process.env.STUDIO_WHISPER_REPORT, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
});
