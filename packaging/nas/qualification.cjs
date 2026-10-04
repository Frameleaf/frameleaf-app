#!/usr/bin/env node
// Prerequisite execution only. No migration adapter, certification report or signing path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyBundle } = require('../../.github/verify-release-bundle.cjs');
const { cosign, COSIGN_PUBLIC_KEY } = require('../../.github/frameleaf-release.cjs');

const digest = /^sha256:[a-f0-9]{64}$/;
const image = /^ghcr\.io\/frameleaf\/frameleaf-postgres(?::[^@\s]+)?@sha256:[a-f0-9]{64}$/;
const hash = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function validateQualificationPlan(plan, nas, approved) {
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.environment, 'sanitized-production-shaped');
  assert(['officialImmich', 'priorFrameleaf'].includes(plan.family), 'Unsupported source family');
  assert.match(plan.sourceVersion, plan.family === 'officialImmich' ? /^v\d+\.\d+\.\d+$/ : /^frameleaf-v\d+\.\d+\.\d+-\d+$/);
  assert(approved[plan.family]?.includes(plan.sourceVersion), 'Source version has not been reviewed for qualification');
  assert(nas.migration?.[plan.family]?.includes(plan.sourceVersion), 'Source version is absent from the signed release');
  assert.equal(plan.targetServer, nas.images.server, 'Target server differs from signed release');
  assert.equal(plan.targetPostgres, nas.images.postgres, 'Target PostgreSQL differs from signed release');
  assert.match(plan.targetPostgres, image);
  assert.equal(plan.postgresMajor, 14, 'Cross-major volume reuse is forbidden');
  assert(Array.isArray(plan.extensions) && plan.extensions.length, 'Reviewed extension inventory is required');
  for (const extension of plan.extensions) {
    assert.match(extension.name, /^[a-z][a-z0-9_]*$/);
    assert.match(extension.version, /^[0-9][0-9A-Za-z.-]*$/);
  }
  assert.match(plan.fixtureRelease, /^nas-fixture-[a-z0-9-]+$/);
  const pair = plan.checkpoint;
  assert(pair && typeof pair.id === 'string' && /^[a-z0-9-]+$/.test(pair.id), 'A consistent checkpoint pair is required');
  for (const [key, name] of [['database', 'database.dump'], ['media', 'media.tar']]) {
    assert.equal(pair[key]?.name, name, 'Unexpected checkpoint asset');
    assert.equal(pair[key]?.checkpointId, pair.id, 'Database and media must come from the same checkpoint');
    assert.match(pair[key]?.digest ?? '', digest, 'Checkpoint digest is required');
  }
  assert.notEqual(pair.database.digest, pair.media.digest, 'Checkpoint assets must be distinct');
  assert.match(pair.mediaTreeDigest ?? '', digest, 'Reviewed media inventory digest is required');
  assert.match(pair.databaseSchemaDigest ?? '', digest, 'Reviewed database schema digest is required');
  assert(Array.isArray(pair.tableCounts) && pair.tableCounts.length, 'Reviewed table counts are required');
  assert(Array.isArray(pair.sequences), 'Reviewed sequence state inventory is required');
  const sequences = new Set();
  for (const row of pair.sequences) {
    assert.match(row.schema, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.match(row.name, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.match(row.lastValue, /^-?\d+$/);
    assert.equal(typeof row.isCalled, 'boolean');
    assert(!sequences.has(`${row.schema}.${row.name}`), 'Duplicate sequence inventory');
    sequences.add(`${row.schema}.${row.name}`);
  }
  const tables = new Set();
  for (const row of pair.tableCounts) {
    assert.match(row.schema, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.match(row.table, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert(Number.isSafeInteger(row.count) && row.count >= 0, 'Invalid table count');
    assert.match(row.dataDigest ?? '', digest, 'Reviewed full table content digest is required');
    assert(!tables.has(`${row.schema}.${row.table}`), 'Duplicate table inventory');
    tables.add(`${row.schema}.${row.table}`);
  }
  return plan;
}

function verifyCheckpointPair(plan, directory) {
  for (const key of ['database', 'media']) {
    const asset = plan.checkpoint[key];
    const file = path.join(directory, asset.name);
    assert(fs.lstatSync(file).isFile(), 'Checkpoint must be a regular file');
    assert.equal(hash(fs.readFileSync(file)), asset.digest, `${key} checkpoint content differs`);
  }
}

function mediaInventory(directory) {
  const entries = [];
  const walk = (relative) => {
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      const item = path.posix.join(relative, name);
      const file = path.join(directory, item);
      const stat = fs.lstatSync(file);
      assert(!stat.isSymbolicLink(), 'Media checkpoint links are forbidden');
      if (stat.isDirectory()) { entries.push([item, 'directory', stat.mode & 0o777]); walk(item); }
      else {
        assert(stat.isFile(), 'Media checkpoint special files are forbidden');
        entries.push([item, hash(fs.readFileSync(file)), stat.mode & 0o777]);
      }
    }
  };
  walk('');
  assert(entries.some((entry) => entry[1].startsWith('sha256:')), 'Empty media checkpoint');
  return hash(JSON.stringify(entries));
}

async function preflight(plan, releaseDirectory, releaseTag) {
  const release = await verifyBundle(releaseDirectory, releaseTag, { authenticate: true });
  const nas = JSON.parse(fs.readFileSync(path.join(releaseDirectory, 'nas-manifest.json'), 'utf8'));
  assert.equal(nas.sourceCommit, release.sourceCommit, 'NAS release commit differs');
  assert.equal(nas.tag, release.tag, 'NAS release tag differs');
  const server = release.images.find((row) => row.image === 'ghcr.io/frameleaf/frameleaf-server' && !row.suffix);
  assert.equal(nas.images.server, `${server.image}@${server.digest}`, 'NAS server differs from authenticated image');
  assert(release.dependencies?.some((row) => `${row.reference.split('@')[0]}@${row.digest}` === nas.images.postgres), 'PostgreSQL was not verified for this release');
  validateQualificationPlan(plan, nas, JSON.parse(fs.readFileSync(path.join(__dirname, 'certified-sources.json'), 'utf8')));
  cosign(['verify', '--key', path.resolve(__dirname, '../..', COSIGN_PUBLIC_KEY), plan.targetPostgres]);
}

function backupRestore(plan, directory) {
  verifyCheckpointPair(plan, directory);
  const media = path.join(directory, 'media');
  const restoredMedia = path.join(directory, 'restored-media');
  assert(!fs.existsSync(media) && !fs.existsSync(restoredMedia), 'Restore destinations must be fresh');
  execFileSync('python3', [path.join(__dirname, 'extract-checkpoint.py'), path.join(directory, 'media.tar'), media], { stdio: 'inherit' });
  assert.equal(mediaInventory(media), plan.checkpoint.mediaTreeDigest, 'Media inventory differs from reviewed checkpoint');
  fs.cpSync(media, restoredMedia, { recursive: true, errorOnExist: true, force: false });
  assert.equal(mediaInventory(restoredMedia), plan.checkpoint.mediaTreeDigest, 'Restored media differs');
  // Deliberately corrupt a disposable clone, then prove a mismatched media half cannot pass.
  fs.writeFileSync(path.join(restoredMedia, '__frameleaf_checkpoint_probe'), 'disposable corruption');
  assert.notEqual(mediaInventory(restoredMedia), plan.checkpoint.mediaTreeDigest, 'Media negative control did not fail');
  fs.rmSync(restoredMedia, { recursive: true });
  fs.cpSync(media, restoredMedia, { recursive: true });

  const prefix = `frameleaf-nas-${crypto.randomBytes(8).toString('hex')}`;
  const containers = [];
  const volumes = [];
  const docker = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 * 1024, ...options });
  const sql = (name, query) => docker(['exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'qualification', '-c', query]).trim();
  const fingerprint = (name) => {
    const extensions = JSON.parse(sql(name, `SELECT json_agg(x ORDER BY x.name COLLATE "C") FROM (SELECT extname AS name, extversion AS version FROM pg_extension) x`));
    assert.deepEqual(extensions, [...plan.extensions].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), 'Restored extension inventory differs');
    const schema = docker(['exec', name, 'pg_dump', '-U', 'postgres', '-d', 'qualification', '--schema-only', '--no-owner', '--no-privileges']);
    // PG14 pg_dump includes its tool/server version in comments; both clones use the exact same image.
    const normalized = schema.replace(/^\\(?:un)?restrict .*\n/gm, '');
    assert.equal(hash(normalized), plan.checkpoint.databaseSchemaDigest, 'Restored database schema differs');
    const inventory = JSON.parse(sql(name, `SELECT coalesce(json_agg(x ORDER BY x.schema COLLATE "C", x."table" COLLATE "C"), '[]'::json) FROM (SELECT schemaname AS schema, tablename AS "table" FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) x`));
    const tableInventory = plan.checkpoint.tableCounts.map(({ schema, table }) => ({ schema, table })).sort((a, b) => a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : a.table < b.table ? -1 : a.table > b.table ? 1 : 0);
    assert.deepEqual(inventory, tableInventory, 'Database table inventory differs');
    for (const row of plan.checkpoint.tableCounts) {
      assert.equal(Number(sql(name, `SELECT count(*) FROM "${row.schema}"."${row.table}"`)), row.count, 'Restored database row count differs');
      const rows = docker(['exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'qualification', '-c', `COPY (SELECT row_to_json(t)::text FROM "${row.schema}"."${row.table}" t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT`]);
      assert.equal(hash(rows), row.dataDigest, 'Restored database table content differs');
    }
    const sequenceInventory = JSON.parse(sql(name, `SELECT coalesce(json_agg(x ORDER BY x.schema COLLATE "C", x.name COLLATE "C"), '[]'::json) FROM (SELECT schemaname AS schema, sequencename AS name FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) x`));
    const expectedSequences = plan.checkpoint.sequences.map(({ schema, name }) => ({ schema, name })).sort((a, b) => a.schema < b.schema ? -1 : a.schema > b.schema ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    assert.deepEqual(sequenceInventory, expectedSequences, 'Restored sequence inventory differs');
    for (const row of plan.checkpoint.sequences) {
      const state = JSON.parse(sql(name, `SELECT row_to_json(x) FROM (SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM "${row.schema}"."${row.name}") x`));
      assert.deepEqual(state, { lastValue: row.lastValue, isCalled: row.isCalled }, 'Restored sequence state differs');
    }
  };
  try {
    docker(['pull', plan.targetPostgres], { stdio: 'inherit' });
    for (const suffix of ['source-clone', 'restore-clone']) {
      const name = `${prefix}-${suffix}`;
      const volume = `${name}-pgdata`;
      docker(['volume', 'create', volume]); volumes.push(volume);
      containers.push(name);
      docker(['run', '-d', '--name', name, '--network', 'none', '--security-opt', 'no-new-privileges', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=qualification', '--mount', `type=volume,src=${volume},dst=/var/lib/postgresql/data`, '--mount', `type=bind,src=${path.resolve(directory)},dst=/checkpoint,readonly`, plan.targetPostgres]);
      docker(['exec', name, 'sh', '-c', 'for n in $(seq 1 60); do pg_isready -U postgres -d qualification && exit 0; sleep 1; done; exit 1']);
      assert.equal(Math.floor(Number(sql(name, 'SHOW server_version_num')) / 10000), 14, 'Restore requires PostgreSQL 14');
      docker(['exec', name, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'postgres', '-d', 'qualification', suffix === 'source-clone' ? '/checkpoint/database.dump' : '/checkpoint/backup.dump']);
      fingerprint(name);
      if (suffix === 'source-clone') {
        const backup = docker(['exec', name, 'pg_dump', '-U', 'postgres', '-d', 'qualification', '--format=custom', '--no-owner', '--no-privileges'], { encoding: null, maxBuffer: 1024 * 1024 * 1024 });
        fs.writeFileSync(path.join(directory, 'backup.dump'), backup, { flag: 'wx', mode: 0o600 });
      }
    }
    const target = containers[1];
    sql(target, 'CREATE TABLE public.__frameleaf_checkpoint_probe (id integer)');
    assert.throws(() => fingerprint(target), /schema differs/, 'Database negative control must reject the corrupt clone');
    sql(target, 'DROP TABLE public.__frameleaf_checkpoint_probe');
    fingerprint(target);
    assert.equal(mediaInventory(restoredMedia), plan.checkpoint.mediaTreeDigest, 'Both restored checkpoint halves must match');
  } finally {
    const failures = [];
    for (const name of containers) { try { docker(['rm', '-f', name], { stdio: 'ignore' }); } catch { failures.push(name); } }
    for (const volume of volumes) { try { docker(['volume', 'rm', volume], { stdio: 'ignore' }); } catch { failures.push(volume); } }
    assert.equal(failures.length, 0, 'Disposable checkpoint cleanup failed');
  }
}

if (require.main === module) (async () => {
  const [phase, planFile, directory, tag] = process.argv.slice(2);
  assert(['preflight', 'backup-restore', 'migration', 'rollback'].includes(phase), 'Unsupported qualification phase');
  // Every phase independently reauthenticates inputs; no unsigned passed-status file can advance it.
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  await preflight(plan, path.join(directory, 'release'), tag);
  if (phase === 'preflight') return;
  if (phase === 'backup-restore') return backupRestore(plan, path.join(directory, 'checkpoint'));
  throw new Error(`${phase}: reviewed source-specific migration and paired rollback adapters are not implemented; no qualification receipt can be emitted`);
})().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { validateQualificationPlan, verifyCheckpointPair, mediaInventory, preflight, backupRestore };
