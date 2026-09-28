import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inventory, licenses, verifySnapshot } from './engine.mjs';
import { writeResourcePolicy } from './resource-policy.mjs';

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
    const fixtureManifest = JSON.parse(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
    fixtureManifest.packageNoticeEvidence = [];
    await writeFile(path.join(studio, 'dependency-attribution.json'), JSON.stringify(fixtureManifest));
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

test('production policy retains every blocked identity and rejects a manifest-only approval', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-runtime-policy-'));
  try {
    const studio = path.resolve(import.meta.dirname, '..');
    await cp(path.join(studio, 'runtime'), path.join(root, 'runtime'), { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(studio, 'dependency-attribution.json'), 'utf8'));
    await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
    const engine = path.join(root, 'engine');
    await writeResourcePolicy(root, engine);
    const actual = JSON.parse(await readFile(path.join(engine, 'src/shared/utils/resource-policy.json'), 'utf8'));
    assert.deepEqual(Object.keys(actual), manifest.resources.map(({ id }) => id));
    assert.equal(Object.keys(actual).length, 210);
    assert.deepEqual(await readFile(path.join(engine, 'src/shared/utils/resource-policy.json')), await readFile(path.join(engine, 'public/moss-tts/resource-policy.json')));
    manifest.resources[0].decisions.localRuntime = 'allowed';
    await writeFile(path.join(root, 'dependency-attribution.json'), JSON.stringify(manifest));
    await assert.rejects(writeResourcePolicy(root, engine), /Unreviewed runtime approval/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('supplemental notices require exact package bindings and retained evidence; partial native evidence stays blocked', async () => {
  const { packageAttribution, auditAttribution } = await import('./attribution.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-supplemental-notices-'));
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const studio = path.join(root, 'studio');
    const engine = path.join(root, 'engine');
    const dist = path.join(root, 'dist');
    for (const directory of [studio, dist, path.join(engine, 'node_modules/example'), path.join(engine, 'node_modules/native')]) await mkdir(directory, { recursive: true });
    const license = 'Synthetic test copyright and license';
    const evidence = 'Synthetic exact-version source receipt';
    await writeFile(path.join(studio, 'license.txt'), license);
    await writeFile(path.join(studio, 'evidence.json'), evidence);
    const pkg = { version: '1.2.3', integrity: 'sha512-fixture', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz' };
    const lock = { packages: { '': {}, 'node_modules/example': pkg, 'node_modules/native': pkg } };
    for (const name of ['example', 'native']) await writeFile(path.join(engine, 'node_modules', name, 'package.json'), JSON.stringify({ version: pkg.version }));
    for (const directory of [studio, engine]) await writeFile(path.join(directory, directory === studio ? 'engine-package-lock.json' : 'package-lock.json'), JSON.stringify(lock));
    const binding = { location: 'node_modules/example', ...pkg, noticeIds: ['supplement'], unresolved: null, evidence: [{ path: 'evidence.json', sha256: hash(evidence), sourceUrl: 'https://example.invalid/exact-version' }] };
    const manifest = { engineRevision: 'fixture', embeddedComponents: [], dolbyTools: {}, rightsPolicy: { distributionApproval: false }, resources: [], artifactNotices: [{ id: 'supplement', path: 'license.txt', sha256: hash(license) }], packageNoticeEvidence: [binding, { ...binding, location: 'node_modules/native', unresolved: 'Native constituents remain unmapped.' }] };
    const save = () => writeFile(path.join(studio, 'dependency-attribution.json'), JSON.stringify(manifest));
    await save();
    const receipt = await packageAttribution(studio, dist, engine);
    assert.deepEqual(receipt.unresolvedPackages, ['node_modules/native']);
    assert.equal(receipt.distributionApproval, false);
    const output = JSON.parse(await readFile(path.join(dist, 'attribution/index.json'), 'utf8'));
    assert.equal(output.packages[0].notices[0].file, 'supplement.txt');
    assert.equal(output.packages[1].noticeEvidence.unresolved, 'Native constituents remain unmapped.');
    await auditAttribution(studio, dist, engine);
    await writeFile(path.join(dist, 'attribution/supplement.txt'), 'tampered output');
    await assert.rejects(auditAttribution(studio, dist, engine), /notice changed/);
    for (const field of ['version', 'integrity', 'resolved']) {
      const original = binding[field];
      binding[field] = 'substituted';
      await save();
      await assert.rejects(packageAttribution(studio, dist, engine), /Package notice binding changed/);
      binding[field] = original;
    }
    binding.noticeIds = ['unknown'];
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Unknown package notice/);
    binding.noticeIds = ['supplement'];
    manifest.packageNoticeEvidence.push(binding);
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Duplicate package notice binding/);
    manifest.packageNoticeEvidence.pop();
    binding.location = 'node_modules/absent';
    await save();
    await assert.rejects(packageAttribution(studio, dist, engine), /Unknown package notice binding/);
    binding.location = 'node_modules/example';
    await save();
    await writeFile(path.join(studio, 'evidence.json'), 'tampered evidence');
    await assert.rejects(packageAttribution(studio, dist, engine), /Package notice evidence changed/);
    await rm(path.join(studio, 'evidence.json'));
    await symlink(path.join(studio, 'license.txt'), path.join(studio, 'evidence.json'));
    await assert.rejects(packageAttribution(studio, dist, engine), /Linked attribution/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
