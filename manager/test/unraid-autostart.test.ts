import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Refusal } from '../src/contracts.js';
import { Fencing } from '../src/fencing.js';
import { Store } from '../src/store.js';
import { HostAutostart, autostartScript } from '../src/unraid-autostart.js';
import { command, type Container } from '../src/docker.js';

const image = `sha256:${'a'.repeat(64)}`;
const helperId = 'b'.repeat(64);
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
    return args[0] === 'create' ? helperId : args[0] === 'start' ? JSON.stringify({ text: 'immich 10\nother\n' }) : '';
  };
  const file = new HostAutostart(docker as any, '/state', execute);
  assert.equal(await file.read(), 'immich 10\nother\n');
  await file.write('immich 10\nother\n', 'other\n');
  assert.equal(calls.length, 6);
  const creates = calls.filter(({ args }) => args[0] === 'create');
  for (const [index, { args }] of creates.entries()) {
    assert.equal(args[args.indexOf('--mount') + 1], 'type=bind,source=/custom/docker data/unraid-autostart,target=/autostart' + (index === 0 ? ',readonly' : ''));
    assert.deepEqual(args.slice(args.indexOf('--entrypoint')), ['--entrypoint', 'node', image, '-e', autostartScript, '/autostart']);
    assert.ok(args.includes('--read-only'));
    assert.equal(args[args.indexOf('--label') + 1], 'app.frameleaf.manager.autostart=/state');
    assert.equal(args[args.indexOf('--pull') + 1], 'never');
    assert.equal(args[args.indexOf('--network') + 1], 'none');
  }
  assert.deepEqual(JSON.parse(calls[4].input!), { expected: 'immich 10\nother\n', modified: 'other\n' });
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
  const file = new HostAutostart(docker as any, '/state', async (_binary, args) => args[0] === 'create' ? helperId : args[0] === 'start' ? JSON.stringify({ error: 'unraid_autostart_unavailable' }) : '');
  await assert.rejects(file.read(), { message: 'unraid_autostart_unavailable' });
});

test('fresh setup accepts only a proven absent host list; imports still require the file', async () => {
  const docker = { inventory: async () => [controller], compatibility: async () => ({ dataRoot: '/docker' }) };
  for (const response of ['missing', 'present', 'unavailable']) {
    const file = new HostAutostart(docker as any, '/state', async (_binary, args) => {
      if (args[0] === 'create') {
        if (args.includes('type=bind,source=/docker,target=/docker,readonly')) return helperId;
        throw new Error('bind source missing or inaccessible');
      }
      return args[0] === 'start' ? response : '';
    });
    if (response === 'missing') {
      assert.equal(await file.read(false), '');
      await new Fencing(docker as any, { directory: '/state' } as Store, file).assertMedia([]);
    }
    else await assert.rejects(file.read(false), { message: 'unraid_autostart_unavailable' });
    await assert.rejects(file.read(true), { message: 'unraid_autostart_unavailable' });
  }
});

test('fencing verifies the current host file after a helper write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-fresh-autostart-'));
  const store = new Store(root);
  const file = { read: async () => 'immich\nother\n', write: async () => {} };
  try {
    const fence = new Fencing({} as any, store, file);
    await assert.rejects((fence as any).rewriteAutostart(() => 'other\n'), { message: 'autostart_write_failed' });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

for (const modified of ['other\n', 'other\nrestored-service 10\n']) {
  test(`interrupted autostart write is reconciled before retry (${modified.length} bytes)`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-torn-autostart-'));
    const store = new Store(root);
    const path = join(root, 'autostart');
    const text = 'immich\nother\n';
    await writeFile(path, text);
    let interrupted = false;
    const file = {
      read: async () => readFile(path, 'utf8'),
      write: async (expected: string, value: string) => {
        assert.equal(await readFile(path, 'utf8'), expected);
        if (!interrupted) {
          interrupted = true;
          const at = Math.min(9, Buffer.byteLength(value));
          await writeFile(path, Buffer.concat([Buffer.from(value).subarray(0, at), Buffer.from(text).subarray(at)]));
          throw new Error('simulated interrupted write');
        }
        await writeFile(path, value);
      },
    };
    try {
      await assert.rejects((new Fencing({} as any, store, file) as any).rewriteAutostart(() => modified), /interrupted write/);
      const resumed = new Fencing({} as any, store, file);
      await (resumed as any).rewriteAutostart((current: string) => current);
      assert.equal(await readFile(path, 'utf8'), modified);
      assert.equal(store.get('autostart-write'), null);
    } finally { store.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test('reconciliation refuses unrelated host edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-changed-autostart-'));
  const store = new Store(root);
  store.set('autostart-write', { text: 'immich\nother\n', modified: 'other\n' });
  let current = 'new-neighbour\n';
  let writes = 0;
  const file = { read: async () => current, write: async (expected: string, modified: string) => {
    assert.equal(current, expected);
    writes++;
    current = modified;
  } };
  try {
    await assert.rejects((new Fencing({} as any, store, file) as any).rewriteAutostart((current: string) => current), { message: 'autostart_changed', status: 409,
      detail: 'The Unraid autostart list changed after an interrupted write. Restore the list to its original or intended content, then try again.' });
    assert.equal(current, 'new-neighbour\n');
    assert.equal(writes, 0);
    for (const restored of ['immich\nother\n', 'other\n']) {
      store.set('autostart-write', { text: 'immich\nother\n', modified: 'other\n' });
      current = restored;
      await (new Fencing({} as any, store, file) as any).rewriteAutostart((text: string) => text);
      assert.equal(current, 'other\n');
      assert.equal(store.get('autostart-write'), null);
    }
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('stops an interrupted daemon helper before retry and removes a timed-out helper before returning', async () => {
  const orphan = { ...controller, Id: 'c'.repeat(64), Config: { ...controller.Config,
    Labels: { 'app.frameleaf.manager.autostart': '/state' } } };
  const docker = { inventory: async () => [controller, orphan], compatibility: async () => ({ dataRoot: '/docker' }) };
  const calls: string[][] = [];
  const file = new HostAutostart(docker as any, '/state', async (_binary, args) => {
    calls.push(args);
    if (args[0] === 'create') return helperId;
    if (args[0] === 'start') throw new Error('simulated timeout');
    return '';
  });
  await assert.rejects(file.write('immich\nother\n', 'other\n'), { message: 'unraid_autostart_unavailable' });
  assert.deepEqual(calls[0], ['rm', '--force', orphan.Id]);
  assert.equal(calls[1][0], 'create');
  assert.deepEqual(calls[2], ['start', '--attach', '--interactive', helperId]);
  assert.deepEqual(calls[3], ['rm', '--force', helperId]);
});

test('a rejected comparison retains host edits without leaving a pending write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'manager-stale-autostart-'));
  const store = new Store(root);
  const file = { read: async () => 'immich\nother\n', write: async () => { throw new Refusal('autostart_changed'); } };
  try {
    await assert.rejects((new Fencing({} as any, store, file) as any).rewriteAutostart(() => 'other\n'), { message: 'autostart_changed' });
    assert.equal(store.get('autostart-write'), null);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('concurrent reads finish helper cleanup before the next helper starts', async () => {
  const docker = { inventory: async () => [controller], compatibility: async () => ({ dataRoot: '/docker' }) };
  let active = 0, peak = 0;
  const file = new HostAutostart(docker as any, '/state', async (_binary, args) => {
    if (args[0] === 'create') { peak = Math.max(peak, ++active); return helperId; }
    if (args[0] === 'rm') { active--; return ''; }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return JSON.stringify({ text: 'other\n' });
  });
  assert.deepEqual(await Promise.all([file.read(), file.read()]), ['other\n', 'other\n']);
  assert.equal(peak, 1);
  assert.equal(active, 0);
});
