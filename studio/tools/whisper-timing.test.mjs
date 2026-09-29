// FL-103 / FL-111: the Whisper worker's word timestamps, checked against real model output.
//
// Always: the transformers.js the worker bundles is the version the recorded evidence was made
// with, so a version change fails here until the real-model run below passes on it and the
// evidence is re-recorded.
// STUDIO_WHISPER_TIMING=1: download the approved whisper-tiny revision (about 40 MB, cached under
// STUDIO_MODEL_CACHE or the OS temp folder) and transcribe the fixture clip with the worker's own
// options; every word must match the recorded timing and no word may run into a measured pause.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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

test('the Whisper worker bundles the transformers.js version its timing evidence was recorded with', { skip: !ready && 'engine not prepared' }, () => {
  const { specifier, version } = workerTransformers();
  assert.doesNotMatch(specifier, /^https?:/, 'no CDN import');
  assert.equal(version, evidence.transformersVersion, `word timing was verified on ${evidence.transformersVersion}; re-run with STUDIO_WHISPER_TIMING=1 before changing it`);
  assert.notEqual(version, evidence.rejected.transformersVersion);
});

test('real whisper-tiny word timestamps land on the clip\'s words and pauses', { skip: (!ready && 'engine not prepared') || (process.env.STUDIO_WHISPER_TIMING !== '1' && 'set STUDIO_WHISPER_TIMING=1 to download the model') }, async () => {
  const { packageDir } = workerTransformers();
  const { pipeline, env } = await import(pathToFileURL(path.join(packageDir, 'dist/transformers.node.mjs')).href);
  env.allowLocalModels = false;
  env.cacheDir = process.env.STUDIO_MODEL_CACHE ?? path.join(os.tmpdir(), 'frameleaf-whisper-timing');
  const asr = await pipeline('automatic-speech-recognition', evidence.model, { revision: evidence.revision, dtype: evidence.dtype, device: 'cpu' });
  const result = await asr(readWav(path.join(here, 'fixtures/whisper-timing.wav')), evidence.options);
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
});
