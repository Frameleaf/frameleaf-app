import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { inspectRuntimePairs } from './runtime-pairs.mjs';

const engine = path.resolve(import.meta.dirname, '../engine');
test('prepared runtime asset pairs match the actual constrained versions and published bytes', async () => {
  const pairs = await inspectRuntimePairs(engine);
  assert.equal(pairs[0].packageVersion, '1.30.0');
  assert.equal(pairs[1].packageVersion, '1.31.0-dev.20260914-8d85527a0');
  assert.equal(pairs[3].packageVersion, '3.8.1');
  assert.notEqual(pairs[0].artifacts[1].sha256, pairs[1].artifacts[1].sha256);
});
test('a root/Hugging Face mixed pair and a different variant are rejected before build', async () => {
  const source = await readFile(path.join(engine, 'src/shared/utils/local-ort-assets.ts'), 'utf8');
  await assert.rejects(inspectRuntimePairs(engine, source.replace("import asyncifyWasm from '../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/", "import asyncifyWasm from 'onnxruntime-web/")), /Mixed or foreign asyncify/);
  await assert.rejects(inspectRuntimePairs(engine, source.replace("import jsepWasm from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm", "import jsepWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm")), /Mixed or foreign jsep/);
});
