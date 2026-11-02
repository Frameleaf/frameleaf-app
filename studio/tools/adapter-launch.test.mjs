import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
    await writeFile(cli, 'process.stdout.write(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}),()=>process.exit(7));', { mode: 0o644 });
    for (const command of ['build', 'test']) {
      const result = spawnSync(process.execPath, [path.join(root, 'studio/tools/adapter.mjs'), command], {
        encoding: 'utf8', timeout: 5000, env: { ...process.env, PATH: '' },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /"args":/, result.stderr);
      const observed = JSON.parse(result.stdout);
      assert.equal(observed.node, process.execPath);
      assert.deepEqual(observed.args, [command, ...(command === 'test' ? ['run'] : []),
        '--config', path.join(root, 'studio/adapters/web/vite.config.mjs')]);
      assert.match(result.stderr, /status: 7/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
