import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('adapter launches the locked JavaScript CLI with its own Node and propagates CLI failures', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio CLI & unicode é ')));
  try {
    for (const name of ['adapter.mjs', 'engine.mjs', 'attribution.mjs', 'resource-policy.mjs', 'owned-subtitle-runtime.mjs']) {
      const destination = path.join(root, 'studio/tools', name);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(new URL(name, import.meta.url), destination);
    }
    for (const name of ['frameleaf-studio-contracts.mjs', 'frameleaf-studio-rights.mjs']) {
      const destination = path.join(root, 'scripts', name);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(new URL(`../../scripts/${name}`, import.meta.url), destination);
    }
    const workspace = path.join(root, 'studio/engine');
    const cli = path.join(workspace, 'node_modules/vite-plus/bin/vp');
    await mkdir(path.dirname(cli), { recursive: true });
    await writeFile(path.join(workspace, 'frameleaf-source.json'), '{}');
    // No executable bit or package-manager shell wrapper is available to this fixture.
    await writeFile(cli, 'process.stdout.write(JSON.stringify({node:process.execPath,cwd:process.cwd(),args:process.argv.slice(2)}),()=>process.exit(7));', { mode: 0o644 });
    for (const command of ['build', 'test']) {
      const result = spawnSync(process.execPath, [path.join(root, 'studio/tools/adapter.mjs'), command], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /"args":/, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.node, process.execPath);
      assert.equal(observed.cwd, workspace);
      assert.deepEqual(observed.args, [command, ...(command === 'test' ? ['run'] : []),
        '--config', path.join(root, 'studio/adapters/web/vite.config.mjs')]);
      assert.match(result.stderr, /status: 7/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('adapter config imports its engine plugin from a path containing URL metacharacters', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio config # % é ')));
  try {
    const files = {
      'package.json': '{"type":"module"}',
      'studio/engine/package.json': '{"type":"module"}',
      'studio/engine/vite.config.ts': 'export const stableAssetSourcemapsPlugin=()=>({name:"engine-fixture"});export default {build:{rollupOptions:{output:{}}}};',
      'studio/engine/node_modules/@vitejs/plugin-react/package.json': '{"main":"index.cjs"}',
      'studio/engine/node_modules/@vitejs/plugin-react/index.cjs': 'module.exports=()=>({name:"react-fixture"});',
      'studio/engine/node_modules/@tailwindcss/vite/package.json': '{"type":"module","exports":"./index.mjs"}',
      'studio/engine/node_modules/@tailwindcss/vite/index.mjs': 'export default ()=>({name:"tailwind-fixture"});',
      'studio/engine-build.json': '{}',
      'studio/freecut-feature-manifest.json': '{"features":[]}',
      'web/src/lib/frameleaf/studio/frame-protocol.ts': 'export const STUDIO_FRAME_PROTOCOL_VERSION=1;',
    };
    for (const [name, text] of Object.entries(files)) {
      const destination = path.join(root, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text);
    }
    const configuration = path.join(root, 'studio/adapters/web/vite.config.mjs');
    await mkdir(path.dirname(configuration), { recursive: true });
    await cp(new URL('../adapters/web/vite.config.mjs', import.meta.url), configuration);
    await mkdir(path.join(root, 'studio/tools'), { recursive: true });
    await cp(new URL('stable-file-url-sourcemaps.mjs', import.meta.url), path.join(root, 'studio/tools/stable-file-url-sourcemaps.mjs'));
    const result = await (await import(pathToFileURL(configuration).href)).default();
    assert.ok(result.plugins.some((plugin) => plugin.name === 'tailwind-fixture'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
