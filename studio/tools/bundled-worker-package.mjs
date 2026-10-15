#!/usr/bin/env node
// FL-408: assemble the bundled Studio worker's runtime from a prepared and built engine.
//
//   node studio/tools/bundled-worker-package.mjs <destination>
//
// The destination mirrors the repository layout the worker resolves from (studio/tools next to
// studio/engine) but holds only what runs: the worker modules, the engine's built harness and
// headless render core, and the three runtime packages those import (playwright, playwright-core,
// zod). Nothing else from the engine's development dependencies is shipped.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = fileURLToPath(new URL('../', import.meta.url));
const engine = path.join(studio, 'engine');

export const WORKER_MODULES = [
  'bundled-worker.mjs',
  'bundled-worker-client.mjs',
  'bundled-worker-executor.mjs',
  'bundled-worker-recipe.mjs',
  'bundled-worker-renderer.mjs',
];
export const ENGINE_RUNTIME_PACKAGES = ['playwright', 'playwright-core', 'zod'];

export async function packageWorker(destination) {
  const target = path.resolve(destination);
  const tools = path.join(target, 'studio', 'tools');
  const runtime = path.join(target, 'studio', 'engine');
  await mkdir(tools, { recursive: true });
  for (const file of WORKER_MODULES) await cp(path.join(studio, 'tools', file), path.join(tools, file));
  await cp(path.join(studio, 'engine-build.json'), path.join(target, 'studio', 'engine-build.json'));
  await cp(path.join(studio, 'notices'), path.join(target, 'studio', 'notices'), { recursive: true });

  const manifest = JSON.parse(await readFile(path.join(engine, 'package.json'), 'utf8'));
  for (const entry of ['dist', 'headless', 'LICENSE']) {
    await cp(path.join(engine, entry), path.join(runtime, entry), { recursive: true });
  }
  assert.ok((await readFile(path.join(runtime, 'dist', 'headless.html'))).length > 0, 'Build the engine harness first');
  await writeFile(
    path.join(runtime, 'package.json'),
    `${JSON.stringify({ name: manifest.name, version: manifest.version, private: true, type: manifest.type }, null, 2)}\n`,
  );
  for (const name of ENGINE_RUNTIME_PACKAGES) {
    await cp(path.join(engine, 'node_modules', name), path.join(runtime, 'node_modules', name), {
      recursive: true,
      dereference: true,
    });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  assert.equal(process.argv.length, 3, 'Usage: node studio/tools/bundled-worker-package.mjs <destination>');
  await packageWorker(process.argv[2]);
  console.log(`Packaged the bundled Studio worker into ${process.argv[2]}`);
}
