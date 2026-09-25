#!/usr/bin/env node
/**
 * Build or test the Frameleaf web adapter (FL-88) against the prepared engine workspace.
 *
 *   node studio/tools/engine.mjs prepare [--archive FILE]
 *   npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund
 *   node studio/tools/adapter.mjs test     # adapter tests on the real engine stores (jsdom)
 *   node studio/tools/adapter.mjs build    # web/static/studio-engine, served at /studio-engine/
 *
 * The adapter installs nothing: it runs the engine's own lockfile-pinned toolchain from
 * studio/engine/node_modules, and it never writes into studio/vendor/freecut, which is verified
 * unchanged afterwards.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { main as engine } from './engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = path.join(root, 'studio/engine');
const config = path.join(root, 'studio/adapters/web/vite.config.mjs');

const present = (location) => lstat(location).then(() => true, () => false);

export async function main(args) {
  const [command] = args;
  assert.ok(args.length === 1 && (command === 'build' || command === 'test'), 'Usage: node studio/tools/adapter.mjs build | test');
  assert.ok(await present(path.join(workspace, 'frameleaf-source.json')), 'Prepare the engine first: node studio/tools/engine.mjs prepare');
  const vp = path.join(workspace, 'node_modules/.bin/vp');
  assert.ok(await present(vp), 'Install the engine lockfile first: npm --prefix studio/engine ci --ignore-scripts');
  const vpArgs = command === 'build' ? ['build', '--config', config] : ['test', 'run', '--config', config];
  execFileSync(vp, vpArgs, { cwd: workspace, stdio: 'inherit' });
  // The vendored snapshot stays byte-identical to the pinned archive.
  await engine(['verify']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
