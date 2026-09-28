#!/usr/bin/env node
import { writeResourcePolicy } from './resource-policy.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageAttribution, auditAttribution } from './attribution.mjs';
import { parseJsonRejectingDuplicateKeys, validateContracts } from '../../scripts/frameleaf-studio-contracts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => parseJsonRejectingDuplicateKeys(await readFile(file, 'utf8'), file);
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

// Only regular files are inputs: symlinks must never escape the verified snapshot.
export async function inventory(directory, prefix = '', exclude = new Set()) {
  assert.ok((await lstat(path.join(directory, prefix))).isDirectory(), `Not a directory: ${prefix || directory}`);
  const files = [];
  for (const name of (await readdir(path.join(directory, prefix))).sort()) {
    const relative = path.posix.join(prefix, name);
    if (exclude.has(relative)) continue;
    const location = path.join(directory, relative);
    const stat = await lstat(location);
    if (stat.isDirectory()) files.push(...await inventory(directory, relative, exclude));
    else {
      assert.ok(stat.isFile(), `Not a regular file: ${relative}`);
      files.push({ path: relative, sha256: sha256(await readFile(location)) });
    }
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export async function verifySnapshot(directory, files) {
  assert.deepEqual(await inventory(directory), [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    `Snapshot changed (missing, extra, modified or linked files): ${directory}`);
}

export function licenses(lock) {
  return Object.entries(lock.packages).filter(([location]) => location).map(([location, pkg]) => ({
    location, name: pkg.name ?? location.split('node_modules/').at(-1), version: pkg.version,
    license: pkg.license ?? 'UNDECLARED', dev: pkg.dev === true, optional: pkg.optional === true,
    resolved: pkg.resolved ?? null, integrity: pkg.integrity ?? null,
  }));
}

async function inputs() {
  await validateContracts(root);
  const provenance = await json(path.join(root, 'studio/freecut-provenance.json'));
  const configuration = await json(path.join(root, 'studio/engine-build.json'));
  assert.equal(configuration.upstreamCommit, provenance.commit);
  assert.equal(configuration.lockfileSha256, sha256(await readFile(path.join(root, 'studio/engine-package-lock.json'))));
  for (const patch of configuration.patches) {
    assert.match(patch.path, /^patches\/[a-z0-9.-]+\.patch$/);
    assert.equal(patch.sha256, sha256(await readFile(path.join(root, 'studio', patch.path))));
    assert.equal(patch.upstreamCommit, provenance.commit);
  }
  return { provenance, configuration };
}

async function prepare(archivePath) {
  const { provenance, configuration } = await inputs();
  const studio = path.join(root, 'studio');
  const vendor = path.join(studio, 'vendor/freecut');
  const engine = path.join(studio, 'engine');
  assert.equal(await lstat(engine).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; }),
    false, 'studio/engine already exists; preserve or explicitly remove your generated workspace before preparing again');
  await mkdir(path.join(studio, 'vendor'), { recursive: true });
  const scratch = await mkdtemp(path.join(studio, '.prepare-'));
  try {
    if (!await lstat(vendor).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; })) {
      let archive;
      if (archivePath) archive = await readFile(archivePath);
      else {
        const response = await fetch(provenance.archiveUrl, { signal: AbortSignal.timeout(120_000) });
        assert.ok(response.ok, `Archive download failed: HTTP ${response.status}`);
        archive = Buffer.from(await response.arrayBuffer());
      }
      assert.equal(sha256(archive), provenance.archiveSha256, 'Archive SHA-256 mismatch');
      const archiveFile = path.join(scratch, 'source.tar.gz');
      await writeFile(archiveFile, archive);
      execFileSync('tar', ['-xzf', archiveFile, '-C', scratch]);
      const extracted = path.join(scratch, `freecut-${provenance.commit}`);
      await verifySnapshot(extracted, provenance.files);
      await rename(extracted, vendor);
    }
    await verifySnapshot(vendor, provenance.files);
    const generated = path.join(scratch, 'engine');
    await cp(vendor, generated, { recursive: true });
    for (const patch of configuration.patches) {
      execFileSync('git', ['apply', '--check', `--directory=${path.relative(root, generated)}`, path.join(studio, patch.path)], { cwd: root });
      execFileSync('git', ['apply', `--directory=${path.relative(root, generated)}`, path.join(studio, patch.path)], { cwd: root });
    }
    await cp(path.join(studio, 'engine-package-lock.json'), path.join(generated, 'package-lock.json'));
    await writeResourcePolicy(studio, generated);
    const source = await inventory(generated);
    const sourceSha256 = sha256(JSON.stringify(source));
    assert.equal(sourceSha256, configuration.sourceSha256, 'Adapted source digest mismatch');
    await writeJson(path.join(generated, 'frameleaf-source.json'), {
      upstreamCommit: provenance.commit, archiveSha256: provenance.archiveSha256,
      patches: configuration.patches, lockfileSha256: configuration.lockfileSha256, sourceSha256, files: source,
    });
    await rename(generated, engine);
    await verifySnapshot(vendor, provenance.files);
    console.log(`Prepared ${source.length} files; adapted source SHA-256 ${sourceSha256}`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function attest() {
  const { provenance, configuration } = await inputs();
  const engine = path.join(root, 'studio/engine');
  assert.equal(process.versions.node, configuration.node, 'Use the pinned Node version for attestation');
  const npm = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(npm, configuration.npm, 'Use the pinned npm version for attestation');
  await verifySnapshot(path.join(root, 'studio/vendor/freecut'), provenance.files);
  const source = await json(path.join(engine, 'frameleaf-source.json'));
  assert.equal(sha256(JSON.stringify(source.files)), configuration.sourceSha256);
  // Unexpected new inputs also invalidate the build; allow only these generated roots.
  const current = await inventory(engine, '', new Set(['node_modules', 'dist', 'frameleaf-source.json', 'frameleaf-build.json']));
  assert.deepEqual(current, source.files, 'Build modified or added adapted inputs');
  const attribution = await packageAttribution(path.join(root, 'studio'), path.join(engine, 'dist'), engine);
  const artifacts = await inventory(path.join(engine, 'dist'));
  assert.ok(artifacts.some((file) => file.path === 'index.html'));
  assert.ok(artifacts.some((file) => file.path === 'headless.html'));
  const dependencyLicenses = licenses(await json(path.join(engine, 'package-lock.json')));
  const report = {
    upstreamCommit: provenance.commit, archiveSha256: provenance.archiveSha256,
    sourceSha256: configuration.sourceSha256, lockfileSha256: configuration.lockfileSha256,
    patches: configuration.patches, node: process.version, npm, platform: process.platform, arch: process.arch,
    artifactSha256: sha256(JSON.stringify(artifacts)), artifacts,
    dependencyLicenses, attribution,
    bundledNotices: await Promise.all(['LICENSE', 'src/infrastructure/audio/THIRD_PARTY_LICENSE', 'src/infrastructure/upscale/models/NOTICE.md'].map(async (notice) => ({ path: notice, text: await readFile(path.join(engine, notice), 'utf8') }))),
    distributionApproval: false,
  };
  await writeJson(path.join(engine, 'frameleaf-build.json'), report);
  console.log(`Built artifact SHA-256 ${report.artifactSha256}; ${dependencyLicenses.length} dependency license records`);
}

export async function main(args) {
  if (args[0] === 'prepare' && (args.length === 1 || (args.length === 3 && args[1] === '--archive'))) {
    await prepare(args[2]);
  } else if (args.length === 1 && args[0] === 'verify') {
    const { provenance } = await inputs();
    await verifySnapshot(path.join(root, 'studio/vendor/freecut'), provenance.files);
    console.log(`Verified all ${provenance.files.length} immutable source files`);
  } else if (args.length === 1 && args[0] === 'attest') await attest();
  else if (args.length === 1 && args[0] === 'audit-attribution') {
    await inputs();
    console.log(await auditAttribution(path.join(root, 'studio'), path.join(root, 'studio/engine/dist'), path.join(root, 'studio/engine')));
  }
  else throw new Error('Usage: node studio/tools/engine.mjs prepare [--archive FILE] | verify | attest | audit-attribution');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
