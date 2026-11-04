import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  prepareImportTransferRuntime,
  verifyImportTransferRuntime,
  packageImportTransferRuntime,
} from '../../scripts/prepare-import-transfer-runtime.mjs';

let directory, temporary;
before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'frameleaf-import-runtime-'));
  directory = join(temporary, 'runtime');
  await symlink(new URL('../../node_modules', import.meta.url), join(temporary, 'node_modules'), 'dir');
  await prepareImportTransferRuntime(directory);
});
after(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('packages the actual Manager transfer modules and matching declarations without unrelated services', async () => {
  const manifest = await verifyImportTransferRuntime(directory);
  assert.equal(manifest.format, 'frameleaf-import-transfer-runtime');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.files.some(({ name }) => name === 'frameleaf-import-rename'), process.platform === 'linux');
  const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8');
  const copied = dockerfile
    .split('\n')
    .filter((line) => line.startsWith('COPY '))
    .join(' ');
  for (const source of manifest.sources.filter(({ name }) => name.startsWith('manager/src/')))
    assert(copied.split(/\s+/u).includes('./' + source.name), `Server image omits ${source.name}`);
  for (const name of [
    'import-plan',
    'import-sqlite',
    'import-transfer-journal',
    'import-copy',
    'import-file-review',
    'import-adoption',
    'import-relocation',
  ]) {
    assert(manifest.files.some((file) => file.name === name + '.js'));
    assert(manifest.files.some((file) => file.name === name + '.d.ts'));
  }
  assert(!manifest.files.some((file) => /discovery|operations|security|desktop-api/.test(file.name)));
  for (const file of manifest.files) {
    assert.equal(
      file.sha256,
      createHash('sha256')
        .update(await readFile(join(directory, file.name)))
        .digest('hex'),
    );
  }
  if (process.platform === 'linux') {
    const probe = spawnSync(join(directory, 'frameleaf-import-rename'), [], { encoding: 'utf8' });
    assert.equal(probe.status, 2, 'the packaged helper refuses an invocation without inherited media descriptors');
  }
});

test('the Server-packaged journal retains real SQLite checkpoints across reopen', async () => {
  const { ImportTransferJournal } = await import(pathToFileURL(join(directory, 'import-transfer-journal.js')).href);
  const { parseImportPlan, importPlanSha256 } = await import(pathToFileURL(join(directory, 'import-plan.js')).href);
  const fixture = JSON.parse(
    await readFile(new URL('../../src/library-import/fixtures/manager-plan-v2.json', import.meta.url)),
  );
  const plan = parseImportPlan(fixture.plan);
  const operationId = randomUUID();
  const database = join(temporary, 'recovery.sqlite');
  let db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE operations(id TEXT PRIMARY KEY,active INTEGER,value TEXT NOT NULL)');
    db.prepare('INSERT INTO operations VALUES(?,1,?)').run(
      operationId,
      JSON.stringify({ kind: 'import', state: 'running' }),
    );
    const journal = new ImportTransferJournal({ db });
    journal.begin(operationId, { manifestSha256: 'a'.repeat(64), planSha256: importPlanSha256(plan) });
    journal.sealPlan(operationId, plan);
    journal.intent(operationId, plan.files[0]);
    db.close();
    db = new DatabaseSync(database);
    const recovered = new ImportTransferJournal({ db });
    assert.deepEqual(recovered.review(operationId).plan, plan);
    assert.deepEqual(recovered.files(operationId), [{ file: plan.files[0], state: 'intent' }]);
  } finally {
    db.close();
  }
});

test('production verification refuses altered runtime bytes and links outside its package', async () => {
  const file = join(directory, 'import-copy.js');
  const original = await readFile(file);
  try {
    await writeFile(file, original.toString() + '\n// altered\n');
    await assert.rejects(verifyImportTransferRuntime(directory), /runtime artifact changed/);
    await rm(file);
    await symlink(new URL('../../package.json', import.meta.url), file);
    await assert.rejects(verifyImportTransferRuntime(directory), /runtime artifact link/);
  } finally {
    await rm(file, { force: true });
    await writeFile(file, original);
  }
});

test('restores only the prepared transfer runtime after production pruning', async () => {
  const pruned = join(temporary, 'production');
  const result = await packageImportTransferRuntime(pruned, directory);
  await writeFile(join(pruned, 'package.json'), await readFile(new URL('../../package.json', import.meta.url)));
  const consumer = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'const { parseImportPlan } = await import("#library-import-transfer/import-plan"); if (typeof parseImportPlan !== "function") process.exit(1);',
    ],
    { cwd: pruned, encoding: 'utf8' },
  );
  assert.equal(consumer.status, 0, consumer.stderr);

  assert.deepEqual(result, await verifyImportTransferRuntime(directory));
  assert.deepEqual(await verifyImportTransferRuntime(join(pruned, 'resources/library-import'), directory), result);
  const compiled = await import(pathToFileURL(join(pruned, 'resources/library-import/import-relocation.js')).href);
  assert.equal(typeof compiled.rollbackImportRelocations, 'function');
});
