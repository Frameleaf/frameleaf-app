// Hosted-only official v3.1.0 startup migration and forced paired recovery.
// Unsigned operation diagnostics are not certification reports or attestation predicates.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { github, hash } = require('../../.github/frameleaf-release.cjs');
const { verifyDatabaseCheckpoint } = require('./checkpoint-database.cjs');
const supported = require('../../server/src/fork-schema/supported-versions.json');
const sha = /^sha256:[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const keys = (object, allowed) => {
  assert(object && typeof object === 'object' && !Array.isArray(object), 'Expected typed fixture object');
  assert(Object.keys(object).every((key) => allowed.includes(key)), 'Unknown fixture field');
};

async function validateOfficialPlan(plan, nas, request = github) {
  assert.equal(plan.family, 'officialImmich', 'Prior Frameleaf requires a separate reviewed source adapter');
  assert.equal(plan.sourceVersion, 'v3.1.0', 'Only the existing exact official certification source is implemented');
  const adapter = plan.adapter;
  keys(adapter, ['kind', 'sourceServer', 'sourceEvidence', 'acceptance']);
  assert.equal(adapter.kind, 'official-immich-v3.1.0');
  assert(supported.certifiedTags.includes(plan.sourceVersion), 'Official version is not in the supported-source authority');
  assert.equal(adapter.sourceServer, `${supported.certification.officialImage}@${supported.certification.officialDigest}`, 'Official source image differs from the committed certification digest');
  assert.match(nas.images.valkey, /^docker\.io\/valkey\/valkey(?::[^@\s]+)?@sha256:[a-f0-9]{64}$/);
  keys(adapter.acceptance, ['name', 'checkpointId', 'digest']);
  assert.equal(adapter.acceptance.name, 'acceptance.json');
  assert.equal(adapter.acceptance.checkpointId, plan.checkpoint.id);
  assert.match(adapter.acceptance.digest, sha);
  const evidence = adapter.sourceEvidence;
  keys(evidence, ['commit', 'path', 'digest']);
  assert.match(evidence.commit, /^[a-f0-9]{40}$/);
  assert.match(evidence.path, /^packaging\/nas\/qualification-fixtures\/[a-z0-9-]+\.json$/);
  assert.match(evidence.digest, sha);
  const receipt = await request(`contents/${evidence.path}?ref=${evidence.commit}`);
  assert.equal(receipt.encoding, 'base64', 'Stopped-source capture evidence is unavailable');
  const bytes = Buffer.from(receipt.content, 'base64');
  assert.equal(hash(bytes), evidence.digest, 'Stopped-source capture evidence differs');
  const capture = JSON.parse(bytes);
  assert.equal(capture.schemaVersion, 1);
  assert.equal(capture.environment, 'sanitized-production-shaped');
  assert.equal(capture.sourceVersion, plan.sourceVersion);
  assert.equal(capture.sourceServer, adapter.sourceServer);
  assert.equal(capture.postgresMajor, 14);
  assert.equal(capture.sourceStopped, true);
  assert.equal(capture.sanitizationReviewed, true);
  assert.equal(capture.checkpointId, plan.checkpoint.id);
  assert.equal(capture.databaseDigest, plan.checkpoint.database.digest);
  assert.equal(capture.mediaDigest, plan.checkpoint.media.digest);
  assert.equal(capture.acceptanceDigest, adapter.acceptance.digest);
}

function validateAcceptance(fixture, plan) {
  keys(fixture, ['schemaVersion', 'environment', 'checkpointId', 'sourceVersion', 'sourceServer', 'targetServer', 'targetVersion', 'accounts', 'database', 'media']);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.environment, 'sanitized-production-shaped');
  assert.equal(fixture.checkpointId, plan.checkpoint.id);
  assert.equal(fixture.sourceVersion, plan.sourceVersion);
  assert.equal(fixture.sourceServer, plan.adapter.sourceServer);
  assert.equal(fixture.targetServer, plan.targetServer);
  keys(fixture.targetVersion, ['major', 'minor', 'patch']);
  for (const part of ['major', 'minor', 'patch']) assert(Number.isSafeInteger(fixture.targetVersion[part]) && fixture.targetVersion[part] >= 0, 'Exact target API version is required');
  assert(Array.isArray(fixture.accounts) && fixture.accounts.length >= 2, 'Admin and ordinary sanitized fixture accounts are required');
  const accountIds = new Set(); const emails = new Set();
  for (const account of fixture.accounts) {
    keys(account, ['email', 'password', 'id', 'name', 'isAdmin', 'statistics', 'assets', 'albums', 'deniedAssetIds']);
    assert.match(account.email, /^[^@\s]+@[a-z0-9.-]+\.test$/, 'Only reserved sanitized fixture identities are permitted');
    assert(typeof account.password === 'string' && account.password.length >= 8, 'A sanitized fixture password is required');
    assert.match(account.id, uuid);
    assert(!accountIds.has(account.id) && !emails.has(account.email), 'Fixture accounts must be distinct');
    accountIds.add(account.id); emails.add(account.email);
    assert(typeof account.name === 'string' && typeof account.isAdmin === 'boolean');
    keys(account.statistics, ['images', 'videos', 'total']);
    for (const key of ['images', 'videos', 'total']) assert(Number.isSafeInteger(account.statistics[key]) && account.statistics[key] >= 0);
    assert.equal(account.statistics.total, account.statistics.images + account.statistics.videos);
    assert(Array.isArray(account.assets) && account.assets.length, 'Authenticated asset checks are required');
    for (const asset of account.assets) {
      keys(asset, ['id', 'ownerId', 'originalFileName', 'type']);
      assert.match(asset.id, uuid); assert.match(asset.ownerId, uuid);
      assert(typeof asset.originalFileName === 'string' && ['IMAGE', 'VIDEO'].includes(asset.type));
    }
    assert(Array.isArray(account.albums) && account.albums.length, 'Authenticated album membership checks are required');
    for (const album of account.albums) {
      keys(album, ['id', 'albumName', 'assetCount', 'albumUsers']);
      assert.match(album.id, uuid); assert(typeof album.albumName === 'string');
      assert(Number.isSafeInteger(album.assetCount) && album.assetCount > 0);
      assert(Array.isArray(album.albumUsers) && album.albumUsers.length);
      for (const member of album.albumUsers) {
        keys(member, ['user', 'role']); keys(member.user, ['id']);
        assert.match(member.user.id, uuid); assert(['owner', 'editor', 'viewer'].includes(member.role));
      }
    }
    assert(Array.isArray(account.deniedAssetIds));
    for (const id of account.deniedAssetIds) assert.match(id, uuid);
  }
  assert(fixture.accounts.some((account) => account.isAdmin), 'Admin acceptance is required');
  assert(fixture.accounts.some((account) => !account.isAdmin && account.deniedAssetIds.length), 'Ordinary-user permission refusal is required');
  for (const account of fixture.accounts) for (const denied of account.deniedAssetIds) {
    assert(!account.assets.some((asset) => asset.id === denied), 'A denied asset cannot also be admitted to this account');
    assert(fixture.accounts.some((other) => other.id !== account.id && other.assets.some((asset) => asset.id === denied)), 'Permission refusal must target an existing independently authenticated asset');
  }
  keys(fixture.database, ['users', 'assets', 'albums', 'usersDigest', 'assetsDigest', 'albumMembershipDigest', 'albumAssetsDigest', 'targetLedgerDigest']);
  for (const key of ['users', 'assets', 'albums']) assert(Number.isSafeInteger(fixture.database[key]) && fixture.database[key] > 0);
  for (const key of ['usersDigest', 'assetsDigest', 'albumMembershipDigest', 'albumAssetsDigest', 'targetLedgerDigest']) assert.match(fixture.database[key], sha);
  keys(fixture.media, ['original', 'derivative']);
  for (const sample of Object.values(fixture.media)) {
    keys(sample, ['path', 'digest']);
    assert(typeof sample.path === 'string' && sample.path && !path.posix.isAbsolute(sample.path) && !sample.path.split('/').some((part) => !part || part === '..' || part === '.') && !sample.path.includes('\\'), 'Media sample must be a confined relative path');
    assert.match(sample.digest, sha);
  }
  assert.notEqual(fixture.media.original.path, fixture.media.derivative.path, 'Original and derivative must be independent samples');
  assert.match(fixture.media.original.path, /^(?:upload|library)\//, 'Original sample must use the existing media storage topology');
  assert.match(fixture.media.derivative.path, /^(?:thumbs|encoded-video)\//, 'Derivative sample must use the existing media storage topology');
  return fixture;
}

// All relationships, independent of album counts, metadata and user membership roles.
// Both migration and original-source acceptance use this same fixed query/hash oracle.
function verifyAlbumAssets(sql, expectedDigest) {
  const inventory = sql(`SELECT coalesce(json_agg(x), '[]'::json) FROM (SELECT "albumId"::text, "assetId"::text FROM public.album_asset ORDER BY "albumId"::text COLLATE "C", "assetId"::text COLLATE "C") x`).trim();
  assert.equal(hash(inventory), expectedDigest, 'Database album/asset relationships differ');
}

function project(actual, expected) {
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual) && actual.length === expected.length, 'Authenticated array invariant differs');
    return expected.map((value, index) => project(actual[index], value));
  }
  if (expected && typeof expected === 'object') {
    assert(actual && typeof actual === 'object', 'Authenticated object invariant differs');
    return Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, project(actual[key], value)]));
  }
  return actual;
}

async function authenticatedAcceptance(base, fixture, source = false) {
  const call = async (endpoint, token, body) => {
    const response = await fetch(`${base}/api${endpoint}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert(response.ok, 'Authenticated API request failed; response/auth data is not retained');
    return response.json();
  };
  assert.deepEqual(project(await call('/server/version'), source ? { major: 3, minor: 1, patch: 0 } : fixture.targetVersion), source ? { major: 3, minor: 1, patch: 0 } : fixture.targetVersion, 'Server API version differs');
  for (const account of fixture.accounts) {
    const session = await call('/auth/login', null, { email: account.email, password: account.password });
    assert(typeof session.accessToken === 'string' && session.accessToken.length > 0, 'Authenticated login did not return a session');
    assert.equal(session.userId, account.id, 'Authenticated user identity differs');
    const me = { id: account.id, email: account.email, name: account.name, isAdmin: account.isAdmin };
    assert.deepEqual(project(await call('/users/me', session.accessToken), me), me, 'Authenticated user invariant differs');
    assert.deepEqual(project(await call('/assets/statistics', session.accessToken), account.statistics), account.statistics, 'Authenticated asset statistics differ');
    for (const asset of account.assets) assert.deepEqual(project(await call(`/assets/${asset.id}`, session.accessToken), asset), asset, 'Authenticated asset invariant differs');
    for (const album of account.albums) assert.deepEqual(project(await call(`/albums/${album.id}`, session.accessToken), album), album, 'Authenticated album/permission invariant differs');
    for (const id of account.deniedAssetIds) {
      const denied = await fetch(`${base}/api/assets/${id}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${session.accessToken}` } });
      // requireAccess in this API returns 400 for an absent/unauthorized asset; the fixture
      // proves it exists through another account, so a generic missing-file response cannot pass.
      if (denied.status === 400) assert.equal((await denied.json()).message, 'Not found or no asset.read access', 'Asset access refusal differs');
      else { assert([403, 404].includes(denied.status), 'Asset permission refusal did not hold'); await denied.body?.cancel(); }
    }
  }
}

async function pairedRecovery({ stopTarget, discardDatabase, restoreDatabase, restoreMedia, verifyOriginalDatabase, verifyOriginalMedia, startSource, acceptSource }) {
  await stopTarget();
  await discardDatabase();
  await restoreDatabase();
  await restoreMedia();
  await verifyOriginalDatabase();
  await verifyOriginalMedia();
  await startSource();
  await acceptSource();
}

async function runOfficialAdapter(plan, directory, nas, phase, { verifyCheckpointPair, mediaInventory }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'NAS adapter execution requires the hosted workflow');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Customer and self-hosted NAS execution is forbidden');
  assert(['migration', 'rollback'].includes(phase));
  verifyCheckpointPair(plan, directory);
  const acceptanceFile = path.join(directory, 'acceptance.json');
  assert(fs.lstatSync(acceptanceFile).isFile(), 'Acceptance must be a regular owner-reviewed fixture');
  const bytes = fs.readFileSync(acceptanceFile);
  assert.equal(hash(bytes), plan.adapter.acceptance.digest, 'Acceptance fixture digest differs');
  let fixture;
  try { fixture = validateAcceptance(JSON.parse(bytes), plan); }
  catch { throw new Error('NAS_ADAPTER_ACCEPTANCE_INPUT_INVALID; fixture/auth data is not retained'); }
  const runDirectory = fs.mkdtempSync(path.join(directory, 'adapter-'));
  const media = path.join(runDirectory, 'media');
  const prefix = `frameleaf-nas-${crypto.randomBytes(8).toString('hex')}`;
  const network = `${prefix}-network`;
  const containers = new Set(); const volumes = new Set(); let networkCreated = false;
  const db = `${prefix}-database`; const redis = `${prefix}-redis`;
  let databaseVolume; let server; let category = 'restore-checkpoint';
  const report = { kind: 'unsigned-nas-adapter-operation', certification: false, schemaVersion: 1, phase, status: 'failed', sourceVersion: plan.sourceVersion, sourceServer: plan.adapter.sourceServer, targetServer: plan.targetServer, targetPostgres: plan.targetPostgres, checkpointId: plan.checkpoint.id, acceptanceDigest: plan.adapter.acceptance.digest, sourceEvidence: plan.adapter.sourceEvidence, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, machineLearning: 'not-qualified-disabled', backgroundJobs: 'startup-readiness-only', failureCategory: null };
  // Never inherit command output: errors, credentials, raw API responses and application logs stay out of diagnostics.
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const sql = (query) => docker(['exec', db, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'qualification', '-c', query]).trim();
  const removeContainer = (name) => { docker(['rm', '-f', name]); containers.delete(name); };
  // Application-created subdirectories may be root-owned. Delete only this run's media bind
  // through the already-admitted server image, without mounting its parent checkpoint/assets.
  const clearMedia = () => docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--security-opt', 'no-new-privileges', '--mount', `type=bind,src=${runDirectory},dst=/qualification`, '--entrypoint', 'node', plan.targetServer, '-e', 'require("node:fs").rmSync("/qualification/media", { recursive: true, force: true })']);
  const extractMedia = () => {
    execFileSync('python3', [path.join(__dirname, 'extract-checkpoint.py'), path.join(directory, 'media.tar'), media], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(mediaInventory(media), plan.checkpoint.mediaTreeDigest, 'Original media checkpoint differs');
  };
  let baselineFiles;
  const captureMedia = () => {
    const inventory = [];
    const walk = (relative = '') => {
      for (const name of fs.readdirSync(path.join(media, relative)).sort()) {
        const item = path.posix.join(relative, name); const file = path.join(media, item); const stat = fs.lstatSync(file);
        assert(stat.isDirectory() || stat.isFile(), 'Original checkpoint contains unsafe media');
        inventory.push({ path: item, directory: stat.isDirectory(), mode: stat.mode & 0o777, digest: stat.isFile() ? hash(fs.readFileSync(file)) : null });
        if (stat.isDirectory()) walk(item);
      }
    };
    walk(); return inventory;
  };
  const preservedMedia = () => {
    for (const expected of baselineFiles) {
      const file = path.join(media, expected.path); const stat = fs.lstatSync(file);
      assert.equal(stat.isDirectory(), expected.directory, 'Original media path type differs');
      assert.equal(stat.mode & 0o777, expected.mode, 'Original media mode differs');
      assert(fs.realpathSync(file).startsWith(`${fs.realpathSync(media)}${path.sep}`), 'Original media escaped the disposable root');
      if (!expected.directory) assert(stat.isFile() && hash(fs.readFileSync(file)) === expected.digest, 'Original media inventory content differs');
    }
  };
  const restoreDatabase = () => {
    databaseVolume = `${db}-${crypto.randomBytes(4).toString('hex')}`;
    docker(['volume', 'create', databaseVolume]); volumes.add(databaseVolume);
    containers.add(db);
    docker(['run', '-d', '--name', db, '--network', network, '--network-alias', 'database', '--security-opt', 'no-new-privileges', '-e', 'POSTGRES_PASSWORD=disposable-nas-fixture-only', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=qualification', '--mount', `type=volume,src=${databaseVolume},dst=/var/lib/postgresql/data`, '--mount', `type=bind,src=${path.resolve(directory)},dst=/checkpoint,readonly`, plan.targetPostgres]);
    docker(['exec', db, 'sh', '-c', 'for n in $(seq 1 60); do pg_isready -U postgres -d qualification && exit 0; sleep 1; done; exit 1']);
    assert.equal(Math.floor(Number(sql('SHOW server_version_num')) / 10000), 14);
    docker(['exec', db, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '-U', 'postgres', '-d', 'qualification', '/checkpoint/database.dump']);
  };
  const startRedis = () => {
    containers.add(redis);
    docker(['run', '-d', '--name', redis, '--network', network, '--network-alias', 'redis', '--security-opt', 'no-new-privileges', nas.images.valkey]);
    docker(['exec', redis, 'sh', '-c', 'for n in $(seq 1 60); do redis-cli ping | grep -qx PONG && exit 0; sleep 1; done; exit 1']);
  };
  const startServer = async (reference, source) => {
    server = `${prefix}-${source ? 'original' : 'target'}`;
    containers.add(server);
    docker(['run', '-d', '--name', server, '--network', network, '--security-opt', 'no-new-privileges', '--stop-timeout', '10', '-p', '127.0.0.1::2283', '-e', 'DB_HOSTNAME=database', '-e', 'DB_USERNAME=postgres', '-e', 'DB_PASSWORD=disposable-nas-fixture-only', '-e', 'DB_DATABASE_NAME=qualification', '-e', 'REDIS_HOSTNAME=redis', '-e', 'IMMICH_MACHINE_LEARNING_ENABLED=false', '-e', 'IMMICH_IGNORE_MOUNT_CHECK_ERRORS=true', '-e', 'IMMICH_PORT=2283', '--mount', `type=bind,src=${media},dst=/data`, reference]);
    const binding = docker(['port', server, '2283/tcp']).trim();
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    const base = `http://${binding}`;
    for (let attempt = 0; attempt < 180; attempt++) {
      const state = JSON.parse(docker(['inspect', '--format', '{{json .State}}', server]));
      assert(state.Running, 'Application exited during migration/startup');
      try {
        const response = await fetch(`${base}/api/server/ping`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
        const pong = response.ok && (await response.json()).res === 'pong';
        if (!response.ok) await response.body?.cancel();
        if (pong && docker(['logs', '--tail', '1000', server]).includes(`${source ? 'Immich' : 'Frameleaf'} Microservices is running`)) {
          docker(['exec', server, 'immich-healthcheck']);
          return base;
        }
      } catch { /* readiness only; no response/log data is retained */ }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Application readiness deadline exceeded');
  };
  const databaseAcceptance = (target) => {
    const counts = JSON.parse(sql(`SELECT json_build_object('users', (SELECT count(*) FROM public."user"), 'assets', (SELECT count(*) FROM public.asset), 'albums', (SELECT count(*) FROM public.album))`));
    assert.deepEqual(counts, Object.fromEntries(['users', 'assets', 'albums'].map((key) => [key, fixture.database[key]])), 'Database entity counts differ');
    const projections = {
      usersDigest: `SELECT id::text, email, name, "isAdmin" FROM public."user" ORDER BY id::text COLLATE "C"`,
      assetsDigest: `SELECT id::text, "ownerId"::text, "originalFileName", "originalPath", encode(checksum, 'hex') AS checksum FROM public.asset ORDER BY id::text COLLATE "C"`,
      albumMembershipDigest: `SELECT album.id::text, album."albumName", coalesce((SELECT json_agg(x ORDER BY x."userId" COLLATE "C") FROM (SELECT membership."userId"::text, membership.role FROM public.album_user membership WHERE membership."albumId" = album.id) x), '[]'::json) AS members FROM public.album ORDER BY album.id::text COLLATE "C"`,
    };
    for (const [key, projection] of Object.entries(projections)) assert.equal(hash(sql(`SELECT coalesce(json_agg(x), '[]'::json) FROM (${projection}) x`)), fixture.database[key], 'Database entity/permission content differs');
    verifyAlbumAssets(sql, fixture.database.albumAssetsDigest);
    if (target) {
      assert.equal(sql(`SELECT to_regnamespace('immich_fork') IS NOT NULL`), 't', 'Frameleaf schema adoption did not occur');
      assert.equal(hash(sql(`SELECT coalesce(json_agg(name ORDER BY name COLLATE "C"), '[]'::json) FROM public.kysely_migrations`)), fixture.database.targetLedgerDigest, 'Target migration ledger differs');
    }
  };
  const sampleMedia = () => {
    for (const sample of Object.values(fixture.media)) {
      const file = path.join(media, sample.path);
      assert(fs.lstatSync(file).isFile() && fs.realpathSync(file).startsWith(`${fs.realpathSync(media)}${path.sep}`), 'Media sample escaped its disposable root');
      assert.equal(hash(fs.readFileSync(file)), sample.digest, 'Original/derivative sample content differs');
    }
  };
  try {
    for (const reference of [plan.targetServer, plan.targetPostgres, nas.images.valkey, plan.adapter.sourceServer]) docker(['pull', reference]);
    docker(['network', 'create', '--internal', network]); networkCreated = true;
    extractMedia(); baselineFiles = captureMedia(); restoreDatabase();
    verifyDatabaseCheckpoint(plan, db, docker);
    sampleMedia(); startRedis();
    category = 'migration-startup';
    const targetBase = await startServer(plan.targetServer, false);
    category = 'migration-acceptance';
    await authenticatedAcceptance(targetBase, fixture);
    databaseAcceptance(true); sampleMedia(); preservedMedia();
    if (phase === 'rollback') {
      category = 'forced-paired-failure';
      docker(['stop', '-t', '10', server]);
      const schemaBefore = hash(docker(['exec', db, 'pg_dump', '-U', 'postgres', '-d', 'qualification', '--schema-only', '--no-owner', '--no-privileges']).replace(/^\\(?:un)?restrict .*\n/gm, ''));
      sql('CREATE TABLE public.__frameleaf_nas_failure_probe (id integer)');
      assert.notEqual(hash(docker(['exec', db, 'pg_dump', '-U', 'postgres', '-d', 'qualification', '--schema-only', '--no-owner', '--no-privileges']).replace(/^\\(?:un)?restrict .*\n/gm, '')), schemaBefore, 'Forced schema corruption was not detected');
      fs.appendFileSync(path.join(media, fixture.media.original.path), 'disposable forced failure');
      assert.throws(sampleMedia, /sample content differs/, 'Forced original-media corruption was not detected');
      report.forcedDatabaseFailureDetected = true; report.forcedMediaFailureDetected = true;
      category = 'paired-checkpoint-recovery';
      await pairedRecovery({
        stopTarget: () => { removeContainer(server); removeContainer(redis); },
        discardDatabase: () => { removeContainer(db); docker(['volume', 'rm', databaseVolume]); volumes.delete(databaseVolume); },
        restoreDatabase,
        restoreMedia: () => { clearMedia(); extractMedia(); },
        verifyOriginalDatabase: () => verifyDatabaseCheckpoint(plan, db, docker),
        verifyOriginalMedia: () => { assert.equal(mediaInventory(media), plan.checkpoint.mediaTreeDigest); sampleMedia(); },
        startSource: async () => { startRedis(); report.originalBase = await startServer(plan.adapter.sourceServer, true); },
        acceptSource: async () => { category = 'original-authenticated-acceptance'; await authenticatedAcceptance(report.originalBase, fixture, true); databaseAcceptance(false); sampleMedia(); preservedMedia(); delete report.originalBase; },
      });
      report.originalPairVerifiedBeforeStartup = true;
      report.originalAuthenticatedAcceptance = true;
    }
    report.status = 'passed';
  } catch {
    report.failureCategory = category;
  } finally {
    const failures = [];
    for (const name of containers) { try { docker(['rm', '-f', name]); } catch { failures.push('container'); } }
    for (const volume of volumes) { try { docker(['volume', 'rm', volume]); } catch { failures.push('volume'); } }
    if (networkCreated) { try { docker(['network', 'rm', network]); } catch { failures.push('network'); } }
    try { clearMedia(); fs.rmSync(runDirectory, { recursive: true, force: true }); } catch { failures.push('media'); }
    delete report.originalBase;
    report.cleanup = failures.length ? 'failed' : 'passed';
    if (failures.length) { report.status = 'failed'; report.failureCategory = 'cleanup'; }
    fs.writeFileSync(path.join(directory, `${phase}-operation.json`), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  assert.equal(report.status, 'passed', `NAS_ADAPTER_${report.failureCategory ?? 'UNKNOWN'}_FAILED; diagnostic contains no response/auth data`);
}

module.exports = { validateOfficialPlan, validateAcceptance, verifyAlbumAssets, project, pairedRecovery, runOfficialAdapter };
