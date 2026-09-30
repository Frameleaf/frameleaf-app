#!/usr/bin/env node
/**
 * Build or test the Frameleaf web adapter (FL-88) against the prepared engine workspace.
 *
 *   node studio/tools/engine.mjs prepare [--archive FILE]
 *   npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund
 *   node studio/tools/adapter.mjs test     # adapter tests on the real engine stores, and Freecut's
 *                                          # own storage, project and bundle suites on the adapter's
 *                                          # workspace (jsdom; see vite.config.mjs)
 *   node studio/tools/adapter.mjs build    # web/static/studio-engine, served at /studio-engine/
 *
 * The adapter installs nothing: it runs the engine's own lockfile-pinned toolchain from
 * studio/engine/node_modules, and it never writes into studio/vendor/freecut, which is verified
 * unchanged afterwards.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageAttribution } from './attribution.mjs';
import { main as engine } from './engine.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = path.join(root, 'studio/engine');
const config = path.join(root, 'studio/adapters/web/vite.config.mjs');
const output = path.join(root, 'web/static/studio-engine');

const present = (location) => lstat(location).then(() => true, () => false);

/** Verify the production entry's emitted layout, not the separately styled browser fixture. */
export async function verifyEditorStyles(directory) {
  const html = await readFile(path.join(directory, 'editor.html'), 'utf8');
  const links = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="(\/studio-engine\/assets\/[^"/]+\.css)"/g)];
  assert.ok(links.length > 0, 'Production editor has no emitted stylesheet');
  const css = (await Promise.all(links.map((link) => readFile(
    path.join(directory, link[1].slice('/studio-engine/'.length)), 'utf8',
  )))).join('\n');
  // These engine-owned layout classes collapse the panels when generated source is not scanned.
  for (const name of ['flex-col', 'h-full', 'min-h-0', 'absolute', 'inset-0', 'overflow-hidden', 'items-center']) {
    assert.ok(new RegExp(`\\.${name}\\s*\\{`).test(css), `Production editor is missing .${name}`);
  }
}

export async function main(args) {
  const [command] = args;
  assert.ok(args.length === 1 && (command === 'build' || command === 'test'), 'Usage: node studio/tools/adapter.mjs build | test');
  assert.ok(await present(path.join(workspace, 'frameleaf-source.json')), 'Prepare the engine first: node studio/tools/engine.mjs prepare');
  const vp = path.join(workspace, 'node_modules/.bin/vp');
  assert.ok(await present(vp), 'Install the engine lockfile first: npm --prefix studio/engine ci --ignore-scripts');
  const vpArgs = command === 'build' ? ['build', '--config', config] : ['test', 'run', '--config', config];
  execFileSync(vp, vpArgs, { cwd: workspace, stdio: 'inherit' });
  if (command === 'build') {
    await verifyEditorStyles(output);
    // The licences travel with the code: every installed package's notice files and the reviewed
    // artifact notices (attribution/), audited against the trusted inputs, next to notices/.
    const audit = await packageAttribution(path.join(root, 'studio'), output, workspace);
    console.log(`Attribution: ${audit.noticeCount} notices, ${audit.resourceCount} resources`);
  }
  // The vendored snapshot stays byte-identical to the pinned archive.
  await engine(['verify']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
