import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
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

test('artifact notices are distributed and independently audited against trusted source bytes', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-attribution-'));
  try {
    const studio = path.resolve(import.meta.dirname, '..');
    const dist = path.join(directory, 'dist');
    await mkdir(dist);
    await packageAttribution(studio, dist);
    await auditAttribution(studio, dist);
    const bundled = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.ok(bundled.notices.some(({ id }) => id === 'mediabunny-mpl'));
    assert.ok(bundled.notices.some(({ id }) => id === 'soundtouch'));
    assert.equal(bundled.distributionApproval, false);
    const notice = path.join(dist, 'attribution', bundled.notices[0].file);
    await writeFile(notice, 'altered license');
    await assert.rejects(auditAttribution(studio, dist), /notice/i);
    await rm(notice);
    await assert.rejects(auditAttribution(studio, dist), /ENOENT|notice/i);
    await packageAttribution(studio, dist);
    bundled.resources.push({ id: 'model:unknown-provider/unknown-weights' });
    await writeFile(path.join(dist, 'attribution/index.json'), JSON.stringify(bundled));
    await assert.rejects(auditAttribution(studio, dist), /inventory/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('artifact audit includes installed runtime package notices and rejects package/version or output substitution', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-package-notices-'));
  const sourceStudio = path.resolve(import.meta.dirname, '..');
  const studio = path.join(directory, 'studio');
  try {
    await mkdir(studio);
    for (const name of ['dependency-attribution.json', 'notices', 'rights-evidence']) {
      await cp(path.join(sourceStudio, name), path.join(studio, name), { recursive: true });
    }
    const dist = path.join(directory, 'dist');
    await mkdir(dist);
    await mkdir(path.join(directory, 'node_modules/example'), { recursive: true });
    const lock = { packages: { '': {}, 'node_modules/example': { version: '1.2.3', license: 'MIT' }, 'node_modules/missing-notice': { version: '1.0.0' } } };
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    await writeFile(path.join(studio, 'engine-package-lock.json'), JSON.stringify(lock));
    await mkdir(path.join(directory, 'node_modules/missing-notice'), { recursive: true });
    await writeFile(path.join(directory, 'node_modules/missing-notice/package.json'), JSON.stringify({ version: '1.0.0' }));
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '1.2.3' }));
    await writeFile(path.join(directory, 'node_modules/example/LICENSE'), 'Package copyright and license');
    await packageAttribution(studio, dist, directory);
    const output = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.equal(output.packages[0].status, 'notice-files-collected');
    const file = output.packages[0].notices[0].file;
    assert.equal(await readFile(path.join(dist, 'attribution', file), 'utf8'), 'Package copyright and license');
    await rm(path.join(dist, 'attribution', file));
    await symlink(path.join(directory, 'node_modules/example/LICENSE'), path.join(dist, 'attribution', file));
    await assert.rejects(auditAttribution(studio, dist, directory), /Linked attribution/);
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '9.9.9' }));
    await assert.rejects(packageAttribution(studio, dist, directory), /Package version changed/);
    await writeFile(path.join(directory, 'node_modules/example/package.json'), JSON.stringify({ version: '1.2.3' }));
    const receipt = await packageAttribution(studio, dist, directory);
    assert.deepEqual(receipt.unresolvedPackages, ['node_modules/missing-notice']);
    // Matching edits must not hide an installed package with no collected notice.
    delete lock.packages['node_modules/missing-notice'];
    await writeFile(path.join(directory, 'package-lock.json'), JSON.stringify(lock));
    output.packages = output.packages.filter(({ location }) => location !== 'node_modules/missing-notice');
    await writeFile(path.join(dist, 'attribution/index.json'), JSON.stringify(output));
    await assert.rejects(auditAttribution(studio, dist, directory), /Generated lockfile differs from pinned package authority/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
