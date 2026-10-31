// Verify the prepared engine's local runtime payloads before its tests/build.
// This is byte/source inventory, never model, hardware or redistribution qualification.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function inspectRuntimePairs(engine, sourceOverride) {
  const lock = JSON.parse(await readFile(path.join(engine, 'package-lock.json'), 'utf8'));
  const source = sourceOverride ?? await readFile(path.join(engine, 'src/shared/utils/local-ort-assets.ts'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(engine, '../dependency-attribution.json'), 'utf8'));
  const files = manifest.resources.find((row) => row.id === 'runtime:onnx-cdn').files;
  const hf = lock.packages['node_modules/@huggingface/transformers'];
  const hfOrt = lock.packages['node_modules/@huggingface/transformers/node_modules/onnxruntime-web'];
  assert.equal(hf.dependencies['onnxruntime-web'], hfOrt.version, 'Use the ONNX version constrained by Transformers');
  assert.equal(lock.packages['node_modules/kokoro-js/node_modules/@huggingface/transformers'].version, '3.8.1', 'Whisper timing calibration requires its recorded runtime');
  const groups = [
    ['jsep', 'onnxruntime-web/', 'node_modules/onnxruntime-web', '.jsep'],
    ['asyncify', '../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/', 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web', '.asyncify'],
    ['plain', '../../../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/', 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web', ''],
    ['kokoro', '../../../node_modules/kokoro-js/node_modules/@huggingface/transformers/dist/', 'node_modules/kokoro-js/node_modules/@huggingface/transformers', '.jsep'],
  ];
  const rows = [];
  for (const [name, prefix, location, variant] of groups) {
    const artifacts = [];
    for (const [suffix, extension] of [['Mjs', 'mjs'], ['Wasm', 'wasm']]) {
      const actual = source.match(new RegExp(`import ${name}${suffix} from '([^']+)\\?url'`))?.[1];
      const expected = `${prefix}ort-wasm-simd-threaded${variant}.${extension}`;
      assert.equal(actual, expected, `Mixed or foreign ${name} JS/WASM pair`);
      const relative = `${location}/dist/ort-wasm-simd-threaded${variant}.${extension}`;
      const bytes = await readFile(path.join(engine, relative));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(files.find((file) => `node_modules/${file.path}` === relative)?.sha256, sha256, `Runtime byte inventory changed: ${relative}`);
      artifacts.push({ path: relative, sha256 });
    }
    rows.push({ name, packageVersion: lock.packages[location].version, artifacts });
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await inspectRuntimePairs(path.resolve(import.meta.dirname, '../engine')), null, 2));
}
