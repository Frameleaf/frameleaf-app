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

test('adapter config loads private engine plugins and preserves resolver boundaries', async () => {
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
    const vitePath = (file) => file.split(path.sep).join('/');
    const adapter = path.join(root, 'studio/adapters/web');
    const engine = path.join(root, 'studio/engine');
    const dependency = result.plugins.find((plugin) => plugin.name === 'frameleaf-resolve-from-engine');
    const resolver = { async resolve(source, importer, options) {
      assert.equal(source, 'mediabunny');
      assert.equal(importer, path.join(engine, 'src/main.tsx'));
      assert.equal(options.skipSelf, true);
      return { id: 'engine-dependency-fixture' };
    } };
    assert.deepEqual(await dependency.resolveId.call(resolver, 'mediabunny',
      vitePath(path.join(adapter, 'src/library-media.ts')), {}), { id: 'engine-dependency-fixture' });
    assert.equal(await dependency.resolveId.call(resolver, 'mediabunny',
      vitePath(adapter + '-other/src/file.ts'), {}), null);
    const persistence = result.plugins.find((plugin) => plugin.name === 'frameleaf-gate-timeline-persistence');
    const shim = vitePath(path.join(adapter, 'src/shims/timeline-persistence.ts'));
    assert.equal(await persistence.resolveId.call({ async resolve() {
      return { id: vitePath(path.join(engine, 'src/features/timeline/stores/timeline-persistence.ts')) };
    } }, './timeline-persistence', vitePath(path.join(engine, 'src/features/timeline/stores/store.ts')), {}), shim);
    assert.equal(await persistence.resolveId.call({ resolve() { throw new Error('shim must retain its upstream import'); } },
      './timeline-persistence', shim, {}), null);
    const workspace = result.plugins.find((plugin) => plugin.name === 'frameleaf-upstream-tests-on-virtual-workspace');
    assert.equal(await workspace.resolveId.call({ async resolve() {
      return { id: vitePath(path.join(engine, 'src/infrastructure/storage/workspace-fs/__tests__/in-memory-handle.ts')) };
    } }, './in-memory-handle', vitePath(path.join(engine, 'src/test.ts')), {}),
    vitePath(path.join(adapter, 'test/upstream/in-memory-handle.ts')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
