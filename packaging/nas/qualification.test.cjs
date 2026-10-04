// Synthetic admission/rollback negative contracts only; never certification evidence.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { validateQualificationPlan, verifyCheckpointPair, mediaInventory } = require('./qualification.cjs');
const { load } = createRequire(path.resolve(__dirname, '../../server/package.json'))('js-yaml');
const hash = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const digest = (n) => `sha256:${String(n).repeat(64)}`;
const approved = { officialImmich: ['v3.1.0'], priorFrameleaf: [] };
const nas = { images: { server: `ghcr.io/frameleaf/frameleaf-server@${digest(1)}`, postgres: `ghcr.io/frameleaf/frameleaf-postgres@${digest(2)}` }, migration: approved };
const fixture = () => ({
  schemaVersion: 1, environment: 'sanitized-production-shaped', family: 'officialImmich', sourceVersion: 'v3.1.0',
  targetServer: nas.images.server, targetPostgres: nas.images.postgres, postgresMajor: 14,
  extensions: [{ name: 'plpgsql', version: '1.0' }], fixtureRelease: 'nas-fixture-contract-only',
  checkpoint: { id: 'contract-only', database: { name: 'database.dump', checkpointId: 'contract-only', digest: digest(3) }, media: { name: 'media.tar', checkpointId: 'contract-only', digest: digest(4) }, mediaTreeDigest: digest(5), databaseSchemaDigest: digest(6), tableCounts: [{ schema: 'public', table: 'asset', count: 1, dataDigest: digest(7) }], sequences: [] },
});

test('admission binds exact source, signed targets and one complete rollback pair', () => {
  assert.equal(validateQualificationPlan(fixture(), nas, approved).sourceVersion, 'v3.1.0');
  assert.throws(() => validateQualificationPlan(fixture(), nas, { officialImmich: [], priorFrameleaf: [] }), /not been reviewed/);
  assert.throws(() => validateQualificationPlan(fixture(), { ...nas, migration: { officialImmich: [] } }, approved), /absent from the signed release/);
  const mutations = [
    (p) => { p.sourceVersion = 'v3.1.1'; },
    (p) => { p.environment = 'synthetic'; },
    (p) => { p.targetServer = p.targetServer.replace(digest(1), digest(8)); },
    (p) => { p.targetPostgres = 'ghcr.io/frameleaf/frameleaf-postgres:latest'; },
    (p) => { p.postgresMajor = 18; },
    (p) => { delete p.checkpoint.database; },
    (p) => { delete p.checkpoint.media; },
    (p) => { p.checkpoint.media.checkpointId = 'different-point-in-time'; },
    (p) => { p.checkpoint.media.digest = p.checkpoint.database.digest; },
    (p) => { delete p.checkpoint.mediaTreeDigest; },
    (p) => { p.checkpoint.tableCounts[0].table = 'asset; DROP TABLE asset'; },
    (p) => { delete p.checkpoint.tableCounts[0].dataDigest; },
    (p) => { delete p.checkpoint.sequences; },
    (p) => { p.checkpoint.sequences = [{ schema: 'public', name: 'id_seq', lastValue: 1, isCalled: true }]; },
    (p) => { p.extensions = []; },
    (p) => { p.fixtureRelease = '../../arbitrary'; },
  ];
  for (const mutate of mutations) { const plan = fixture(); mutate(plan); assert.throws(() => validateQualificationPlan(plan, nas, approved)); }
});

test('checkpoint verification refuses altered bytes, missing halves and symlinks', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-checkpoint-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plan = fixture();
  for (const key of ['database', 'media']) {
    const bytes = Buffer.from(`synthetic ${key} bytes`);
    fs.writeFileSync(path.join(directory, plan.checkpoint[key].name), bytes);
    plan.checkpoint[key].digest = hash(bytes);
  }
  verifyCheckpointPair(plan, directory);
  const media = path.join(directory, 'media.tar');
  fs.writeFileSync(media, 'changed media');
  assert.throws(() => verifyCheckpointPair(plan, directory), /media checkpoint content differs/);
  fs.rmSync(media);
  assert.throws(() => verifyCheckpointPair(plan, directory));
  fs.symlinkSync(path.join(directory, 'database.dump'), media);
  assert.throws(() => verifyCheckpointPair(plan, directory), /regular file/);
});

test('media rollback inventory detects lost bytes, extra paths and unsafe links', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nas-media-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'original.jpg'), 'synthetic original');
  const baseline = mediaInventory(directory);
  fs.writeFileSync(path.join(directory, 'original.jpg'), 'corrupted original');
  assert.notEqual(mediaInventory(directory), baseline);
  fs.writeFileSync(path.join(directory, 'original.jpg'), 'synthetic original');
  assert.equal(mediaInventory(directory), baseline);
  fs.writeFileSync(path.join(directory, 'unexpected'), 'extra');
  assert.notEqual(mediaInventory(directory), baseline);
  fs.rmSync(path.join(directory, 'unexpected'));
  fs.symlinkSync('/etc/passwd', path.join(directory, 'link'));
  assert.throws(() => mediaInventory(directory), /links are forbidden/);
});

test('qualification workflow has trusted step names but cannot certify incomplete adapters', () => {
  const workflow = load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/nas-qualification.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions.packages, 'read');
  assert.match(workflow.jobs.qualification.if, /refs\/heads\/fork\/main/);
  assert.equal(workflow.jobs.qualification.name, 'NAS qualification (${{ inputs.family }}, ${{ inputs.version }})');
  const steps = workflow.jobs.qualification.steps;
  for (const name of ['Preflight', 'Backup and restore', 'Migration', 'Rollback']) assert(steps.some((step) => step.name === name && !step['continue-on-error']));
  assert(!steps.some((step) => /upload-artifact/.test(step.uses || '') || /cosign\s+(?:sign|attest)\b/.test(step.run || '')));
  const source = fs.readFileSync(path.join(__dirname, 'qualification.cjs'), 'utf8');
  assert.match(source, /reviewed source-specific migration and paired rollback adapters are not implemented/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, 'certified-sources.json'), 'utf8')), { officialImmich: [], priorFrameleaf: [] });
});

test('media extractor rejects traversal, links, special files and duplicate aliases', () => {
  execFileSync('python3', [path.join(__dirname, 'extract-checkpoint.test.py')], { stdio: 'inherit' });
});
