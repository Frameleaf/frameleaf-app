import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const linux = { skip: process.platform !== 'linux' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-import-execution-'));
  const helper = join(root, 'helper');
  execFileSync('cc', [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    fileURLToPath(new URL('../import-rename.c', import.meta.url)),
    '-o',
    helper,
  ]);
  const path = join(root, 'execution.lock');
  await writeFile(path, 'retained-lock-inode', { mode: 0o600 });
  const start = (code: string, executable = process.execPath) => {
    // Each invocation opens a distinct description; forked copies of one description share flock ownership.
    const descriptor = openSync(path, 'r+');
    try {
      return spawn(helper, ['--exec-locked', executable, '-e', code], {
        stdio: ['pipe', 'pipe', 'pipe', descriptor],
      });
    } finally {
      closeSync(descriptor);
    }
  };
  return { root, path, helper, start };
}

test(
  'the executing process owns the import lock until its death, including SIGKILL',
  linux,
  async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.start> | undefined;
    try {
      owner = f.start(`
      const fs = require('node:fs');
      const info = fs.readFileSync('/proc/self/fdinfo/3', 'utf8');
      if (!new RegExp('FLOCK\\\\s+ADVISORY\\\\s+WRITE\\\\s+' + process.pid + '\\\\s').test(info)) process.exit(91);
      process.stdout.write('locked');
      process.stdin.resume();
    `);
      const ready = await Promise.race([
        once(owner.stdout, 'data').then(([bytes]) => String(bytes)),
        once(owner, 'exit').then(([code]) => {
          throw new Error('lock owner exited before readiness: ' + code);
        }),
      ]);
      assert.equal(ready, 'locked');
      const contender = f.start('process.exit(0)');
      assert.deepEqual(await once(contender, 'exit'), [75, null]);
      const exit = once(owner, 'exit');
      owner.kill('SIGKILL');
      assert.deepEqual(await exit, [null, 'SIGKILL']);
      owner = undefined;
      const resumed = f.start('process.exit(0)');
      assert.deepEqual(await once(resumed, 'exit'), [0, null]);
      assert.equal(await readFile(f.path, 'utf8'), 'retained-lock-inode');
    } finally {
      if (owner?.exitCode === null && owner.signalCode === null) {
        const exit = once(owner, 'exit');
        owner.kill('SIGKILL');
        await exit;
      }
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  'refuses public or hardlinked lock descriptors and releases ownership after exec failure',
  linux,
  async () => {
    const f = await fixture();
    try {
      await chmod(f.path, 0o644);
      assert.deepEqual(await once(f.start('process.exit(0)'), 'exit'), [
        2,
        null,
      ]);
      await chmod(f.path, 0o600);
      await link(f.path, join(f.root, 'alias'));
      assert.deepEqual(await once(f.start('process.exit(0)'), 'exit'), [
        2,
        null,
      ]);
      await rm(join(f.root, 'alias'));
      assert.deepEqual(
        await once(f.start('', '/no-such-frameleaf-executable'), 'exit'),
        [127, null],
      );
      assert.deepEqual(await once(f.start('process.exit(0)'), 'exit'), [
        0,
        null,
      ]);
      assert.deepEqual(await once(f.start('process.exit(0)', 'node'), 'exit'), [
        2,
        null,
      ]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  'retains relocation of an original whose literal filename is --exec-locked',
  linux,
  async () => {
    const f = await fixture();
    const source = join(f.root, 'source'),
      destination = join(f.root, 'destination');
    await mkdir(source);
    await mkdir(destination);
    const original = join(source, '--exec-locked');
    await writeFile(original, 'literal-option-looking-original');
    const identity = await stat(original, { bigint: true });
    const sourceDirectory = await open(source, 'r'),
      destinationDirectory = await open(destination, 'r');
    try {
      const moved = spawn(
        f.helper,
        [
          '--exec-locked',
          'photo.jpg',
          String(identity.dev),
          String(identity.ino),
        ],
        {
          stdio: [
            'ignore',
            'pipe',
            'pipe',
            sourceDirectory.fd,
            destinationDirectory.fd,
          ],
        },
      );
      assert.deepEqual(await once(moved, 'exit'), [0, null]);
      assert.equal(
        await readFile(join(destination, 'photo.jpg'), 'utf8'),
        'literal-option-looking-original',
      );
    } finally {
      await Promise.all([
        sourceDirectory.close(),
        destinationDirectory.close(),
      ]);
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  'an in-flight descendant retains the lock after its executing parent is killed',
  linux,
  async () => {
    const f = await fixture();
    let owner: ReturnType<typeof f.start> | undefined;
    let descendant: number | undefined;
    try {
      owner = f.start(`
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e',
        "const fs=require('node:fs'); if(!fs.readFileSync('/proc/self/fdinfo/5','utf8').includes('FLOCK'))process.exit(92); process.stdout.write('held'); setInterval(()=>{},1000)"],
        { stdio: ['ignore','pipe','inherit','ignore','ignore',3] });
      let announced = false;
      child.once('error', () => process.exit(94));
      child.once('exit', () => { if (!announced) process.exit(95); });
      child.stdout.once('data', () => { announced=true; process.stdout.write(JSON.stringify({ pid: child.pid })); });
      setInterval(()=>{},1000);
    `);
      const exit = once(owner, 'exit');
      const ready = await Promise.race([
        once(owner.stdout, 'data').then(([bytes]) => bytes),
        exit.then(([code]) => {
          throw new Error('owner exited before descendant readiness: ' + code);
        }),
      ]);
      descendant = JSON.parse(String(ready)).pid;
      owner.kill('SIGKILL');
      assert.deepEqual(await exit, [null, 'SIGKILL']);
      assert.deepEqual(await once(f.start('process.exit(0)'), 'exit'), [
        75,
        null,
      ]);
      process.kill(descendant!, 'SIGKILL');
      descendant = undefined;
      let resumed = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const [code] = await once(f.start('process.exit(0)'), 'exit');
        if (code === 0) {
          resumed = true;
          break;
        }
        assert.equal(code, 75);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(resumed, true);
    } finally {
      if (descendant) process.kill(descendant, 'SIGKILL');
      if (owner?.exitCode === null && owner.signalCode === null) {
        const exit = once(owner, 'exit');
        owner.kill('SIGKILL');
        await exit;
      }
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
