// Authenticated Manager component releases are separate from application releases.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { cosign, github, REPOSITORY, COSIGN_PUBLIC_KEY } = require('./frameleaf-release.cjs');
const { verifyAttestedPredicate } = require('./verify-release-bundle.cjs');
const TYPE = 'https://frameleaf.net/attestations/manager-release/v1';
const IMAGE = 'ghcr.io/frameleaf/frameleaf-manager';
const DIGEST = /^sha256:[a-f0-9]{64}$/;

async function verifyManagerRelease(file, { run, request = github } = {}) {
  assert((await fs.lstat(file)).isFile(), 'Manager manifest must be a regular file');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.component, 'frameleaf-manager');
  assert.equal(manifest.repository, REPOSITORY);
  assert.match(manifest.tag, /^manager-v\d+\.\d+\.\d+$/);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(manifest.image, /^ghcr\.io\/frameleaf\/frameleaf-manager@sha256:[a-f0-9]{64}$/);
  const id = /^https:\/\/github\.com\/Frameleaf\/frameleaf-app\/actions\/runs\/([1-9][0-9]*)$/.exec(manifest.buildRun)?.[1];
  assert(id, 'Invalid Manager build run');
  assert.equal(manifest.architectures?.length, 2);
  for (const architecture of ['amd64', 'arm64']) {
    const receipt = manifest.architectures.find(item => item.architecture === architecture);
    assert(receipt, `Missing ${architecture} qualification`);
    for (const field of ['digest', 'configDigest']) assert.match(receipt[field], DIGEST);
    assert.match(receipt.archiveSha256, /^[a-f0-9]{64}$/);
    assert.equal(receipt.sourceCommit, manifest.sourceCommit);
    assert.equal(receipt.repository, REPOSITORY);
    assert.equal(receipt.runId, id);
    assert.match(receipt.runAttempt, /^[1-9][0-9]*$/);
    assert.equal(receipt.smoke, 'passed');
    assert(Array.isArray(receipt.rootfsDiffIds) && receipt.rootfsDiffIds.length > 0);
    receipt.rootfsDiffIds.forEach(value => assert.match(value, DIGEST));
  }
  const build = await request(`actions/runs/${id}`);
  assert(build?.head_sha === manifest.sourceCommit && build.head_repository?.full_name === REPOSITORY &&
    ['fork/main', 'master/frameleaf-implementation'].includes(build.head_branch) &&
    build.event === 'workflow_dispatch' && build.status === 'completed' && build.conclusion === 'success' &&
    build.path === '.github/workflows/manager.yml', 'Manager build provenance is not trusted');
  assert.equal(String(build.run_attempt), manifest.architectures[0].runAttempt);
  assert.equal(manifest.architectures[1].runAttempt, manifest.architectures[0].runAttempt);
  cosign(['verify', '--key', path.resolve(__dirname, '..', COSIGN_PUBLIC_KEY), manifest.image], run);
  verifyAttestedPredicate(manifest.image, TYPE, manifest, run);
  return manifest;
}
module.exports = { verifyManagerRelease, TYPE, IMAGE };
if (require.main === module) verifyManagerRelease(process.argv[2])
  .then(manifest => console.log(`Verified ${manifest.tag}: ${manifest.image}`))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
