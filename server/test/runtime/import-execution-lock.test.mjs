import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { prepareImportTransferRuntime } from '../../scripts/prepare-import-transfer-runtime.mjs';

const linux = { skip: process.platform !== 'linux' };
let root, state, runner;
before(async () => {
  if (process.platform !== 'linux') return;
  root = await mkdtemp(join(tmpdir(), 'frameleaf-execution-launcher-'));
  state = join(root, 'state');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(state, { mode: 0o700 });
  await symlink(new URL('../../node_modules', import.meta.url), join(root, 'node_modules'), 'dir');
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'src',
      type: 'module',
      imports: { '#library-import-transfer/*': './resources/library-import/*.js' },
      exports: {
        './library-import/manifest.js': './manifest.mjs',
        './library-import/execution-lock.js': './execution-lock.mjs',
      },
    }),
  );
  await prepareImportTransferRuntime(join(root, 'resources/library-import'));
  await mkdir(join(root, 'library-import'));
  for (const [target, source] of [
    ['execution-lock.js', '../execution-lock.mjs'],
    ['command-input.js', '../command-input.mjs'],
  ])
    await symlink(source, join(root, 'library-import', target));
  await writeFile(join(root, 'main.js'), await readFile(new URL('../../src/main.ts', import.meta.url), 'utf8'));
  await writeFile(
    join(root, 'supervisor.js'),
    `
    import { assertImportExecutionLock } from './execution-lock.mjs';
    await assertImportExecutionLock(process.env.FRAMELEAF_IMPORT_BOOT_TEST_STATE);
    console.log('application-imported-under-lock');
  `,
  );
  await writeFile(
    join(root, 'boot-observer.mjs'),
    `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const original = childProcess.spawn;
    childProcess.spawn = (command, ...args) => original(
      command === '/usr/local/bin/frameleaf-import-rename'
        ? fileURLToPath(new URL('./resources/library-import/frameleaf-import-rename', import.meta.url)) : command,
      ...args);
    syncBuiltinESMExports();
  `,
  );
  const source = await readFile(new URL('../../src/library-import/execution-lock.ts', import.meta.url), 'utf8');
  await writeFile(join(root, 'execution-lock.mjs'), stripTypeScriptTypes(source));
  for (const [source, target] of [
    ['command-input.ts', 'command-input.mjs'],
    ['manifest.ts', 'manifest.mjs'],
    ['local-transfer-state.ts', 'local-transfer-state.mjs'],
  ])
    await writeFile(
      join(root, target),
      stripTypeScriptTypes(await readFile(new URL('../../src/library-import/' + source, import.meta.url), 'utf8'), {
        mode: 'transform',
      }),
    );
  runner = join(root, 'runner.mjs');
  await writeFile(
    runner,
    `
    import childProcess from 'node:child_process';
    import { mock } from 'node:test';
    import { syncBuiltinESMExports } from 'node:module';
    import { fileURLToPath } from 'node:url';
    import { enterImportExecutionLock, assertImportExecutionLock } from './execution-lock.mjs';
    const spawn = childProcess.spawn;
    mock.method(childProcess, 'spawn', (command, ...args) => spawn(
      command === '/usr/local/bin/frameleaf-import-rename'
        ? fileURLToPath(new URL('./resources/library-import/frameleaf-import-rename', import.meta.url)) : command,
      ...args));
    syncBuiltinESMExports();
    try {
      if (await enterImportExecutionLock(process.argv[2])) {
        await assertImportExecutionLock(process.argv[2]);
        if (process.argv[3] === 'journal') {
          const assert = (await import('node:assert/strict')).default;
          const fs = await import('node:fs');
          const { LocalLibraryImportState } = await import('./local-transfer-state.mjs');
          const { importPlanSha256 } = await import('./resources/library-import/import-plan.js');
          const fixture = JSON.parse(fs.readFileSync(process.argv[2] + '/journal-plan.json', 'utf8'));
          const input = { binding: { manifestSha256: 'a'.repeat(64), planSha256: importPlanSha256(fixture.plan) },
            destinationId: fixture.plan.destinationId, destinationNonce: '01900000-0000-4000-8000-000000000001' };
          let state = await LocalLibraryImportState.open(process.argv[2], { create: true });
          const identity = state.identity;
          const journal = state.bind(fixture.plan.destinationId, input);
          journal.begin(fixture.plan.destinationId, input.binding);
          journal.sealPlan(fixture.plan.destinationId, fixture.plan);
          journal.intent(fixture.plan.destinationId, fixture.plan.files[0]);
          state.mark(fixture.plan.destinationId, 'copying');
          await state.close();
          state = await LocalLibraryImportState.open(process.argv[2], { create: false });
          try {
            assert.deepEqual(state.identity, identity);
            state.bind(fixture.plan.destinationId, input);
            assert.deepEqual(state.inspect(fixture.plan.destinationId), { phase: 'copying', writersMayHaveStarted: false,
              abandoned: false, files: [{ state: 'intent', count: 1 }] });
            assert.throws(() => state.bind(fixture.plan.destinationId, { ...input, destinationId: 'changed' }));
            assert.throws(() => state.bind(fixture.plan.destinationId, { ...input,
              destinationNonce: '01900000-0000-4000-8000-000000000002' }));
          } finally { await state.close(); }
          const readOnly = await LocalLibraryImportState.open(process.argv[2], { create: false, readOnly: true });
          try {
            assert.equal(readOnly.inspect(fixture.plan.destinationId).phase, 'copying');
            assert.throws(() => readOnly.bind(fixture.plan.destinationId, input));
          } finally { await readOnly.close(); }
          await assert.rejects(LocalLibraryImportState.open(process.argv[2], { create: true, readOnly: true }));
        }
        if (process.argv[3] === 'transfer') {
          const { DatabaseSync } = await import('node:sqlite');
          const { ImportTransferJournal } = await import('./resources/library-import/import-transfer-journal.js');
          const { importPlanSha256 } = await import('./resources/library-import/import-plan.js');
          const { relocateImportFiles } = await import('./resources/library-import/import-relocation.js');
          const fs = await import('node:fs');
          const plan = JSON.parse(fs.readFileSync(process.argv[2] + '/transfer.json', 'utf8'));
          const db = new DatabaseSync(process.argv[2] + '/transfer.sqlite');
          try {
            db.exec('CREATE TABLE operations(id TEXT PRIMARY KEY,active INTEGER,value TEXT NOT NULL)');
            db.prepare('INSERT INTO operations VALUES(?,1,?)').run(plan.destinationId,
              JSON.stringify({ kind: 'import', state: 'running' }));
            const journal = new ImportTransferJournal({ db });
            journal.begin(plan.destinationId, { manifestSha256: 'a'.repeat(64), planSha256: importPlanSha256(plan) });
            journal.sealPlan(plan.destinationId, plan);
            for (const file of plan.files) journal.intent(plan.destinationId, file);
            await relocateImportFiles(journal, plan.destinationId, Object.fromEntries(plan.roots.map((r) => [r.id, r])), false);
            await assertImportExecutionLock(process.argv[2]);
            process.stdout.write('moved');
          } finally { db.close(); }
        }
        if (process.argv[3] === 'hold') {
          process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
          process.stdin.resume();
        }
      }
    } catch (error) {
      process.stderr.write(error.code || 'unexpected-lock-error');
      process.exitCode = 1;
    }
  `,
  );
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const start = (directory = state, hold = false, environment = {}) =>
  spawn(process.execPath, [runner, directory, hold ? 'hold' : 'exit'], {
    env: { ...process.env, ...environment },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

test(
  'both admin entrypoints validate the common import and acquire its lock before application imports',
  linux,
  async () => {
    const directory = join(root, 'bootstrap');
    await mkdir(directory, { mode: 0o700 });
    const configuration = join(directory, 'config.json');
    await writeFile(
      configuration,
      JSON.stringify({
        format: 'frameleaf-library-import-command',
        version: 1,
        operationId: randomUUID(),
        destinationId: randomUUID(),
        bundleDirectory: join(directory, 'bundle'),
        stateDirectory: directory,
      }),
      { mode: 0o600 },
    );
    const execute = (alias, args, environment = {}) =>
      execFileSync(
        process.execPath,
        ['--import', join(root, 'boot-observer.mjs'), join(root, 'main.js'), alias, 'import-library', ...args],
        {
          env: { ...process.env, FRAMELEAF_IMPORT_BOOT_TEST_STATE: directory, ...environment },
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    const args = ['preflight', '--source', 'photoprism', '--config', configuration];
    for (const alias of ['frameleaf-admin', 'immich-admin']) {
      assert.equal(execute(alias, args).trim(), 'application-imported-under-lock');
      for (const [arguments_, environment] of [
        [[...args, '--password', 'private-test-password'], {}],
        [args, { FRAMELEAF_IMPORT_EXECUTION_LOCK_FD: '3' }],
      ]) {
        assert.throws(
          () => execute(alias, arguments_, environment),
          (error) => {
            assert.equal(error.status, 1);
            assert.equal(String(error.stdout), '');
            assert.equal(String(error.stderr).trim(), 'Frameleaf startup configuration could not be validated');
            return true;
          },
        );
      }
    }
  },
);

test(
  'the real launcher re-execs into the locked process and refuses concurrent forward or recovery work',
  linux,
  async () => {
    const owner = start(state, true);
    const exit = once(owner, 'exit');
    let worker;
    try {
      const bytes = await Promise.race([
        once(owner.stdout, 'data').then(([bytes]) => bytes),
        exit.then(([code]) => {
          throw new Error('launcher exited without ownership: ' + code);
        }),
      ]);
      worker = JSON.parse(String(bytes)).pid;
      assert.notEqual(worker, owner.pid, 'the exec worker, rather than a lock helper, retains ownership');
      assert.deepEqual(await once(start(), 'exit'), [75, null]);
      process.kill(worker, 'SIGKILL');
      worker = undefined;
      assert.deepEqual(await exit, [1, null]);
      assert.deepEqual(await once(start(), 'exit'), [0, null]);
    } finally {
      if (worker) process.kill(worker, 'SIGKILL');
      if (owner.exitCode === null && owner.signalCode === null) await exit;
    }
  },
);

test('rejects forged descriptor authority, symlinked directories and public recovery state', linux, async () => {
  assert.deepEqual(await once(start(state, false, { FRAMELEAF_IMPORT_EXECUTION_LOCK_FD: '3' }), 'exit'), [1, null]);
  const alias = join(root, 'alias');
  await symlink(state, alias);
  assert.deepEqual(await once(start(alias), 'exit'), [1, null]);
  await chmod(state, 0o755);
  assert.deepEqual(await once(start(), 'exit'), [1, null]);
  await chmod(state, 0o700);
  await chmod(join(state, 'execution.lock'), 0o644);
  assert.deepEqual(await once(start(), 'exit'), [1, null]);
  await chmod(join(state, 'execution.lock'), 0o600);
  assert.deepEqual(await once(start(), 'exit'), [0, null]);
});

test(
  'reads only stable private import inputs and rejects unsafe files or secret-bearing configuration',
  linux,
  async () => {
    const { readPrivateImportJSON, loadLibraryImportConfig } = await import(
      new URL('command-input.mjs', 'file://' + root + '/')
    );
    const config = {
      format: 'frameleaf-library-import-command',
      version: 1,
      operationId: '11111111-1111-4111-8111-111111111111',
      destinationId: '22222222-2222-4222-8222-222222222222',
      bundleDirectory: join(root, 'bundle'),
      stateDirectory: state,
    };
    const path = join(state, 'import.json'),
      bytes = JSON.stringify(config);
    await writeFile(path, bytes, { mode: 0o600 });
    assert.deepEqual(await loadLibraryImportConfig(path), config);
    assert.deepEqual(await readPrivateImportJSON(path, 65_536), {
      value: config,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    await assert.rejects(readPrivateImportJSON(path, 4), /import_private_input_unavailable/);
    await chmod(path, 0o644);
    await assert.rejects(loadLibraryImportConfig(path), /import_private_input_unavailable/);
    await chmod(path, 0o600);
    const alias = join(state, 'input-alias.json');
    await link(path, alias);
    await assert.rejects(loadLibraryImportConfig(path), /import_private_input_unavailable/);
    await rm(alias);
    await symlink(path, alias);
    await assert.rejects(loadLibraryImportConfig(alias), /import_private_input_unavailable/);
    await writeFile(path, JSON.stringify({ ...config, password: 'never-log-this-synthetic-value' }));
    await assert.rejects(
      loadLibraryImportConfig(path),
      (error) => error.code === 'import_command_configuration_invalid' && !error.message.includes('never-log-this'),
    );
    await writeFile(path, Buffer.from([0x22, 0xc3, 0x28, 0x22]));
    await assert.rejects(readPrivateImportJSON(path, 65_536), /import_private_input_unavailable/);
  },
);

test('native relocation inherits execution ownership and leaves the Node owner lock valid', linux, async () => {
  const source = join(root, 'source'),
    destination = join(root, 'destination');
  await mkdir(source, { mode: 0o700 });
  await mkdir(destination, { mode: 0o700 });
  const bytes = Buffer.from('original-for-locked-relocation');
  await writeFile(join(source, 'photo.jpg'), bytes);
  const value = await stat(join(source, 'photo.jpg'), { bigint: true });
  const roots = [];
  for (const [id, path] of [
    ['source', source],
    ['destination', destination],
  ]) {
    const directory = await stat(path, { bigint: true });
    roots.push({ id, path, device: String(directory.dev), inode: String(directory.ino) });
  }
  const plan = {
    version: 1,
    source: {
      kind: 'photoview',
      version: 'v2.4.0',
      identity: 'synthetic',
      revision: 'frozen',
      schemaSha256: 'a'.repeat(64),
    },
    destinationId: randomUUID(),
    owners: [],
    roots,
    files: [
      {
        id: 'original',
        mode: 'relocate',
        sourceRoot: 'source',
        sourcePath: 'photo.jpg',
        destinationRoot: 'destination',
        destinationPath: 'photo.jpg',
        destinationDevice: roots[1].device,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: String(value.size),
        sourceIdentity: {
          device: String(value.dev),
          inode: String(value.ino),
          bytes: String(value.size),
          mtimeNs: String(value.mtimeNs),
          ctimeNs: String(value.ctimeNs),
          links: String(value.nlink),
        },
      },
    ],
  };
  await writeFile(join(state, 'transfer.json'), JSON.stringify(plan), { mode: 0o600 });
  const command = spawn(process.execPath, [runner, state, 'transfer'], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(await once(command, 'exit'), [0, null]);
  assert.deepEqual(await readFile(join(destination, 'photo.jpg')), bytes);
});

test(
  'the private local transfer journal survives reopen and offers read-only progress without changing ownership',
  linux,
  async () => {
    await writeFile(
      join(state, 'journal-plan.json'),
      await readFile(new URL('../../src/library-import/fixtures/manager-plan-v2.json', import.meta.url)),
      { mode: 0o600 },
    );
    const command = spawn(process.execPath, [runner, state, 'journal'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    command.stderr.on('data', (bytes) => {
      error += String(bytes);
    });
    assert.deepEqual(await once(command, 'exit'), [0, null], error);
  },
);
