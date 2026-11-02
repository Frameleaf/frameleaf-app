import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Fencing } from '../src/fencing.js';
import type { Store } from '../src/store.js';
import { HostAutostart, autostartScript } from '../src/unraid-autostart.js';
import { command, type Container } from '../src/docker.js';

const image = `sha256:${'a'.repeat(64)}`;
const controller = {
  Image: image, State: { Running: true }, Mounts: [],
  Config: { Labels: { 'app.frameleaf.manager.role': 'controller' }, Env: ['MANAGER_DATA=/state'] },
} as Container;

test('discovers a custom Docker root without a mount and uses only the local controller image', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const docker = {
    inventory: async () => [controller, { ...controller, State: { Running: false } }],
    compatibility: async () => ({ dataRoot: '/custom/docker data' }),
  };
  const execute: typeof command = async (_binary, args, options) => {
    calls.push({ args, input: options?.input });
    return JSON.stringify({ text: 'immich 10\nother\n' });
  };
  const file = new HostAutostart(docker as any, '/state', execute);
  assert.equal(await file.read(), 'immich 10\nother\n');
  await file.write('immich 10\nother\n', 'other\n');
  assert.equal(calls.length, 2);
  for (const [index, { args }] of calls.entries()) {
    assert.equal(args[args.indexOf('--mount') + 1], 'type=bind,source=/custom/docker data/unraid-autostart,target=/autostart' + (index === 0 ? ',readonly' : ''));
    assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'node', image, '-e', autostartScript, '/autostart']);
    assert.ok(args.includes('--rm') && args.includes('--read-only'));
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
    assert.equal(args[args.indexOf('--network') + 1], 'none');
  }
  assert.deepEqual(JSON.parse(calls[1].input!), { expected: 'immich 10\nother\n', modified: 'other\n' });
});

test('refuses ambiguous controllers, unverified images and invalid Docker roots', async () => {
  for (const [containers, root] of [
    [[controller, controller], '/docker'],
    [[{ ...controller, Image: 'latest' }], '/docker'],
    [[controller], '/docker,readonly'],
    [[controller], '/docker/../elsewhere'],
    [[controller], '/'],
  ] as [Container[], string][]) {
    const docker = { inventory: async () => containers, compatibility: async () => ({ dataRoot: root }) };
    await assert.rejects(new HostAutostart(docker as any, '/state', async () => assert.fail('must not run')).read());
  }
});

test('helper preserves the inode, rejects stale writes and never creates a missing file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-autostart-'));
  const path = join(root, 'autostart');
  const run = async (request: unknown) => JSON.parse(await command('docker', ['-e', autostartScript, path], {
    executable: process.execPath, input: JSON.stringify(request),
  }));
  try {
    await writeFile(path, 'immich 10\nother\n');
    const inode = (await stat(path)).ino;
    assert.deepEqual(await run({}), { text: 'immich 10\nother\n' });
    assert.deepEqual(await run({ expected: 'stale', modified: '' }), { error: 'autostart_changed' });
    assert.equal(await readFile(path, 'utf8'), 'immich 10\nother\n');
    assert.deepEqual(await run({ expected: 'immich 10\nother\n', modified: 'other\n' }), { text: 'other\n' });
    assert.equal((await stat(path)).ino, inode);
    assert.equal(await readFile(path, 'utf8'), 'other\n');
    await rm(path);
    assert.deepEqual(await run({}), { error: 'unraid_autostart_unavailable' });
    await assert.rejects(stat(path), { code: 'ENOENT' });
    await mkdir(path);
    assert.deepEqual(await run({}), { error: 'unraid_autostart_unavailable' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('helper failures never become an empty autostart list', async () => {
  const docker = { inventory: async () => [controller], compatibility: async () => ({ dataRoot: '/docker' }) };
  const file = new HostAutostart(docker as any, '/state', async () => JSON.stringify({ error: 'unraid_autostart_unavailable' }));
  await assert.rejects(file.read(), { message: 'unraid_autostart_unavailable' });
});

test('fresh setup accepts only a proven absent host list; imports still require the file', async () => {
  const docker = { inventory: async () => [controller], compatibility: async () => ({ dataRoot: '/docker' }) };
  for (const response of ['missing', 'present', 'unavailable']) {
    const file = new HostAutostart(docker as any, '/state', async (_binary, args) => {
      if (args.includes('type=bind,source=/docker,target=/docker,readonly')) return response;
      throw new Error('bind source missing or inaccessible');
    });
    if (response === 'missing') {
      assert.equal(await file.read(false), '');
      await new Fencing(docker as any, { directory: '/state' } as Store, file).assertMedia([]);
    }
    else await assert.rejects(file.read(false), { message: 'unraid_autostart_unavailable' });
    await assert.rejects(file.read(true), { message: 'unraid_autostart_unavailable' });
  }
});
