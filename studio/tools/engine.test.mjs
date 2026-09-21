import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventory, licenses, verifySnapshot } from './engine.mjs';

test('snapshot gate rejects mutations, extra files, missing files and symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-snapshot-'));
  try {
    await mkdir(path.join(directory, 'headless'));
    await writeFile(path.join(directory, 'headless.html'), 'entry');
    await writeFile(path.join(directory, 'headless/contract.mjs'), 'contract');
    const files = await inventory(directory);
    assert.deepEqual(files.map(({ path }) => path), ['headless.html', 'headless/contract.mjs']);
    await verifySnapshot(directory, files);
    await writeFile(path.join(directory, 'headless.html'), 'tampered');
    await assert.rejects(verifySnapshot(directory, files));
    await writeFile(path.join(directory, 'headless.html'), 'entry');
    await writeFile(path.join(directory, 'extra'), 'generated');
    await assert.rejects(verifySnapshot(directory, files));
    await rm(path.join(directory, 'extra'));
    await rm(path.join(directory, 'headless.html'));
    await assert.rejects(verifySnapshot(directory, files));
    await symlink(path.join(directory, 'headless/contract.mjs'), path.join(directory, 'headless.html'));
    await assert.rejects(verifySnapshot(directory, files), /Not a regular file/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('license inventory retains every lockfile dependency, including transitive, optional and unknown declarations', async () => {
  const lock = JSON.parse(await readFile(new URL('../engine-package-lock.json', import.meta.url), 'utf8'));
  const rows = licenses(lock);
  assert.equal(rows.length, Object.keys(lock.packages).length - 1);
  assert.ok(rows.some(({ location }) => location.split('node_modules/').length > 2));
  assert.ok(rows.some(({ optional }) => optional));
  assert.equal(licenses({ packages: { '': {}, 'node_modules/example': { version: '1.0.0' } } })[0].license, 'UNDECLARED');
  assert.equal(lock.name, '@frameleaf/studio-engine');
});
