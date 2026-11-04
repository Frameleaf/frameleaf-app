import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  prepareCommonImportRuntime,
  removeCommonImportBootstrap,
  stageCommonImportBootstrap,
} from '../src/common-import-runtime.js';

test('mounts private import configuration and bundle read-only and recovery state writable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID();
  const destinationId = randomUUID();
  await mkdir(join(root, 'bundle'), { mode: 0o700 });
  const mounts = await prepareCommonImportRuntime(root, operationId, destinationId);
  assert.deepEqual(
    mounts.map(({ target, read_only, bind }) => [target, read_only, bind.create_host_path]),
    [
      ['/run/frameleaf/import-private', true, false],
      ['/run/frameleaf/import-bundle', true, false],
      ['/run/frameleaf/import-state', false, false],
    ],
  );
  const config = join(root, 'config', 'command.json');
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  for (const directory of ['config', 'bundle', 'state']) {
    assert.equal((await stat(join(root, directory))).mode & 0o777, 0o700);
  }
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), {
    format: 'frameleaf-library-import-command',
    version: 1,
    operationId,
    destinationId,
    bundleDirectory: '/run/frameleaf/import-bundle',
    stateDirectory: '/run/frameleaf/import-state',
  });
  assert.deepEqual(await prepareCommonImportRuntime(root, operationId, destinationId), mounts);
  await assert.rejects(
    prepareCommonImportRuntime(root, operationId, randomUUID()),
    /import_runtime_configuration_changed/,
  );
});

test('refuses a linked or non-private recovery directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID();
  const destinationId = randomUUID();
  await mkdir(join(root, 'bundle'), { mode: 0o700 });
  await symlink(join(root, 'bundle'), join(root, 'state'));
  await assert.rejects(prepareCommonImportRuntime(root, operationId, destinationId), /import_runtime_directory_unsafe/);
  await rm(join(root, 'state'));
  await mkdir(join(root, 'state'), { mode: 0o700 });
  await chmod(join(root, 'state'), 0o755);
  await assert.rejects(prepareCommonImportRuntime(root, operationId, destinationId), /import_runtime_directory_unsafe/);
});

test('mounts the bundle published for this operation and refuses substituted directory names', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operationId = randomUUID();
  const destinationId = randomUUID();
  const name = `bundle-${operationId}-aBc123`;
  await mkdir(join(root, name), { mode: 0o700 });
  const mounts = await prepareCommonImportRuntime(root, operationId, destinationId, name);
  assert.equal(mounts[1].source, join(root, name));
  for (const invalid of ['../bundle', `bundle-${randomUUID()}-aBc123`, `${name}/other`]) {
    await assert.rejects(
      prepareCommonImportRuntime(root, operationId, destinationId, invalid),
      /import_runtime_bundle_invalid/,
    );
  }
});

test('keeps the reviewed bootstrap identity in configuration and removes only the private credential', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationId = randomUUID();
  const destinationId = randomUUID();
  const userId = randomUUID();
  const root = join(directory, `import-runtime-${operationId}`);
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, 'bundle'), { mode: 0o700 });
  await prepareCommonImportRuntime(root, operationId, destinationId, 'bundle', userId);
  const config = join(root, 'config', 'command.json');
  const contents = JSON.parse(await readFile(config, 'utf8'));
  assert.deepEqual(contents.bootstrapAdmin, { userId, path: '/run/frameleaf/import-private/bootstrap-admin.json' });
  await assert.rejects(
    prepareCommonImportRuntime(root, operationId, destinationId, 'bundle', randomUUID()),
    /import_runtime_configuration_changed/,
  );
  const credential = join(root, 'config', 'bootstrap-admin.json');
  const input = { email: 'fixture@example.test', name: 'Fixture admin', password: 'synthetic-private-credential' };
  await stageCommonImportBootstrap(directory, { operationId, destinationId, userId }, input);
  await stageCommonImportBootstrap(directory, { operationId, destinationId, userId }, input);
  assert.equal((await stat(credential)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(credential, 'utf8')), { operationId, destinationId, userId, ...input });
  assert(!JSON.stringify(contents).includes(input.password));
  await assert.rejects(
    stageCommonImportBootstrap(
      directory,
      { operationId, destinationId, userId },
      { ...input, password: 'different-private-password' },
    ),
    /import_runtime_bootstrap_changed/,
  );
  await removeCommonImportBootstrap(directory, operationId);
  await removeCommonImportBootstrap(directory, operationId);
  await assert.rejects(stat(credential), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), contents);
});
