const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { build } = require('./build.cjs');
const { NAS_ATTESTATION_TYPE } = require('../../.github/verify-release-bundle.cjs');
const { createBundle, hash, INSTALL_FILES, VARIANTS, REPOSITORY, SOURCE, ATTESTATION_TYPE } = require('../../.github/frameleaf-release.cjs');

const digest = (n) => `sha256:${String(n).repeat(64)}`;
test('authenticated release packaging, negative trust cases, and Synology worker timing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-nas-'));
  const tag = 'frameleaf-v3.1.0-1';
  const sha = 'a'.repeat(40);
  const qualificationSha = 'b'.repeat(40);
  const receiptCommit = 'c'.repeat(40);
  const database = 'ghcr.io/frameleaf/frameleaf-postgres:14-vectorchord0.4.3-pgvectors0.2.0';
  const bundle = path.join(root, 'bundle');
  const output = path.join(root, 'output');
  const sourceRoot = path.join(root, 'source');
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, body);
  };
  try {
    for (const name of INSTALL_FILES)
      write(path.join(sourceRoot, 'docker', name), fs.readFileSync(path.join(__dirname, '../../docker', name)));
    write(path.join(sourceRoot, 'server/src/fork-schema/supported-versions.json'), '{}');
    const release = {
      schemaVersion: 2, repository: REPOSITORY, tag, sourceCommit: sha,
      certifiedBuildRun: `${SOURCE}/actions/runs/123`,
      images: VARIANTS.map((spec, i) => ({
        image: `ghcr.io/frameleaf/${spec.image}`, suffix: spec.suffix,
        digest: digest(i + 1), sourceCommit: sha, platforms: spec.platforms,
      })),
      dependencies: [{ reference: database, digest: digest(8) }],
    };
    const reports = {};
    const receipts = Object.fromEntries([['officialImmich', 'v3.1.0'], ['priorFrameleaf', 'frameleaf-v3.1.0-0']].map(([family, version]) => {
      const file = `packaging/nas/qualification/${family.toLowerCase()}.json`;
      const report = JSON.stringify({
        schemaVersion: 1, environment: 'sanitized-production-shaped', sourceVersion: version,
        targetServer: `${release.images[0].image}@${release.images[0].digest}`,
        targetPostgres: `${database}@${digest(8)}`, run: `${SOURCE}/actions/runs/456`, sourceCommit: qualificationSha,
        checks: { preflight: 'passed', backupRestore: 'passed', migration: 'passed', rollback: 'passed' },
      });
      reports[`contents/${file}?ref=${receiptCommit}`] = { encoding: 'base64', content: Buffer.from(report).toString('base64') };
      return [family, [{ version, evidence: { commit: receiptCommit, path: file, digest: hash(report) } }]];
    }));
    const migration = Object.fromEntries(Object.entries(receipts).map(([family, entries]) => [family, entries.map((entry) => entry.version)]));
    const signedReports = Object.values(reports).map((report) => JSON.parse(Buffer.from(report.content, 'base64')));
    write(path.join(sourceRoot, 'packaging/nas/certified-sources.json'), JSON.stringify(migration));
    await createBundle(bundle, sourceRoot, tag, release, new Map([[database, digest(8)]]));
    const nas = JSON.parse(fs.readFileSync(path.join(bundle, 'nas-manifest.json')));
    assert.equal(nas.images.postgres, `${database}@${digest(8)}`);
    const calls = [];
    const run = (command, args) => {
      assert.equal(command, 'cosign');
      assert.equal(args[2], path.resolve(__dirname, '../../cosign.pub'));
      calls.push(args);
      if (args[0] === 'verify') return '[]';
      const [name, value] = args.at(-1).split('@');
      const type = args[4];
      return (type === NAS_ATTESTATION_TYPE ? signedReports : [release]).map((predicate) => JSON.stringify({ payload: Buffer.from(JSON.stringify({
        predicateType: type, predicate,
        subject: [{ name, digest: { sha256: value.slice(7) } }],
      })).toString('base64') })).join('\n') + '\n';
    };
    const trusted = {
      head_sha: sha, head_branch: 'fork/main', head_repository: { full_name: REPOSITORY },
      event: 'push', status: 'completed', conclusion: 'success', path: '.github/workflows/docker.yml',
    };
    const jobs = { total_count: 2, jobs: Object.entries(receipts).map(([family, [source]]) => ({
      name: `NAS qualification (${family}, ${source.version})`, conclusion: 'success',
      steps: ['Preflight', 'Backup and restore', 'Migration', 'Rollback'].map((name) => ({ name, conclusion: 'success' })),
    })) };
    const request = async (endpoint) => {
      if (reports[endpoint]) return reports[endpoint];
      if (endpoint === 'actions/runs/123') return trusted;
      if (endpoint === 'actions/runs/456') return { ...trusted, head_sha: qualificationSha, path: '.github/workflows/nas-qualification.yml' };
      if (endpoint === 'actions/runs/456/jobs?filter=latest&per_page=100') return jobs;
      throw new Error(`Unexpected evidence request: ${endpoint}`);
    };
    let rejected = 0;
    const reject = async (pattern, verification = {}) => {
      const out = path.join(root, `rejected-${rejected++}`);
      await assert.rejects(build(bundle, tag, out, receipts, { run, request, ...verification }), pattern);
      assert(!fs.existsSync(out), 'An unverified bundle must produce no package');
    };
    await reject(/signature rejected/, { run: () => { throw new Error('signature rejected'); } });
    await reject(/Signed attestation differs/, { run: (command, args) => args[0] === 'verify' ? '[]' : JSON.stringify({
      payload: Buffer.from(JSON.stringify({ predicateType: ATTESTATION_TYPE, predicate: {}, subject: [] })).toString('base64'),
    }) });
    await reject(/Build certification is not trusted/, { request: async (endpoint) => endpoint === 'actions/runs/123' ? { ...trusted, head_sha: 'b'.repeat(40) } : request(endpoint) });
    await reject(/Migration evidence run is not trusted/, { request: async (endpoint) => endpoint === 'actions/runs/456' ? { ...trusted, head_sha: sha } : request(endpoint) });
    await reject(/Missing successful migration qualification steps/, { request: async (endpoint) => endpoint.includes('/jobs?') ? { ...jobs, jobs: [] } : request(endpoint) });
    await reject(/Migration evidence checksum differs/, { request: async (endpoint) => endpoint.startsWith('contents/') ? { encoding: 'base64', content: Buffer.from('{}').toString('base64') } : request(endpoint) });
    // Rehashing caller-provided receipts cannot authorize a changed target or unsigned report.
    const receipt = receipts.officialImmich[0];
    const receiptDigest = receipt.evidence.digest;
    for (const [patch, pattern] of [
      [{ targetServer: `${release.images[0].image}@${digest(9)}` }, /Migration target server differs/],
      [{ sourceCommit: 'd'.repeat(40) }, /Signed attestation differs/],
    ]) {
      const altered = JSON.stringify({ ...signedReports[0], ...patch });
      receipt.evidence.digest = hash(altered);
      await reject(pattern, { request: async (endpoint) => endpoint.includes('/officialimmich.json?') ?
        { encoding: 'base64', content: Buffer.from(altered).toString('base64') } : request(endpoint) });
    }
    receipt.evidence.digest = receiptDigest;
    const originalNas = fs.readFileSync(path.join(bundle, 'nas-manifest.json'));
    write(path.join(bundle, 'nas-manifest.json'), '{}');
    await reject(/checksum differs/);
    write(path.join(bundle, 'nas-manifest.json'), originalNas);
    const sums = fs.readFileSync(path.join(bundle, 'SHA256SUMS'), 'utf8');
    fs.unlinkSync(path.join(bundle, 'SHA256SUMS'));
    await reject(/ENOENT/);
    write(path.join(bundle, 'SHA256SUMS'), sums);
    // Even a rehashed checksum list cannot authenticate a modified release manifest.
    const originalRelease = fs.readFileSync(path.join(bundle, 'release-manifest.json'));
    const forgedRelease = JSON.stringify({ ...release, certification: 'forged' });
    write(path.join(bundle, 'release-manifest.json'), forgedRelease);
    write(path.join(bundle, 'SHA256SUMS'), sums.replace(hash(originalRelease).slice(7), hash(forgedRelease).slice(7)));
    await reject(/Signed attestation differs/);
    write(path.join(bundle, 'release-manifest.json'), originalRelease);
    write(path.join(bundle, 'SHA256SUMS'), sums);
    for (const invalid of [{ officialImmich: [], priorFrameleaf: [] }, { officialImmich: ['v3.0.0'], priorFrameleaf: ['frameleaf-v3.1.0-0'] }]) {
      write(path.join(sourceRoot, 'packaging/nas/certified-sources.json'), JSON.stringify(invalid));
      await createBundle(bundle, sourceRoot, tag, release, new Map([[database, digest(8)]]));
      await reject(/migration version allowlist is required|Migration receipts differ/);
    }
    write(path.join(sourceRoot, 'packaging/nas/certified-sources.json'), JSON.stringify(migration));
    await createBundle(bundle, sourceRoot, tag, release, new Map([[database, digest(8)]]));
    await assert.rejects(build(bundle, tag, path.join(root, 'missing-receipts'), undefined, { run, request }), /receipts are required/);
    assert(!fs.existsSync(path.join(root, 'missing-receipts')));
    // The release SHA, qualification workflow SHA and report commit intentionally differ.
    await build(bundle, tag, output, receipts, { run, request });
    assert(calls.some((args) => args[0] === 'verify-attestation' && args.at(-1) === nas.images.server));
    const read = (name) => fs.readFileSync(path.join(output, name), 'utf8');
    assert(read('unraid/templates/frameleaf-server.xml').includes(nas.images.server));
    assert(read('unraid/templates/frameleaf-ml.xml').includes(nas.images.machineLearning));
    const values = read('truenas/ix-dev/community/frameleaf/ix_values.yaml');
    assert(values.includes('repository: "ghcr.io/frameleaf/frameleaf-postgres"'));
    assert(values.includes(`14-vectorchord0.4.3-pgvectors0.2.0@${digest(8)}`));
    assert(!values.includes('immich-app'));
    if (process.env.TRUENAS_LIBRARY) {
      execFileSync('python3', [path.join(__dirname, 'check-truenas.py'), path.join(output, 'truenas/ix-dev/community/frameleaf'), process.env.TRUENAS_LIBRARY]);
    }
    const unpack = path.join(root, 'unpack');
    fs.mkdirSync(unpack);
    execFileSync('tar', ['-xf', path.join(output, 'synology/Frameleaf-noarch-3.1.0-1.spk'), '-C', unpack]);
    const staging = path.join(root, 'installer-staging');
    const target = path.join(root, 'target');
    const state = path.join(root, 'var');
    fs.mkdirSync(staging);
    execFileSync('tar', ['-xzf', path.join(unpack, 'package.tgz'), '-C', staging]);
    const env = {
      ...process.env, SYNOPKG_PKGDEST: target, SYNOPKG_PKGVAR: state, SYNOPKG_PKGINST_TEMP_DIR: staging,
      wizard_media_path: '/volume1/frameleaf/library', wizard_database_path: '/volume1/frameleaf/postgres',
      wizard_database_password: 'FixtureOnly123456', wizard_web_port: '3456', wizard_enable_ml: 'false',
    };
    assert(!fs.existsSync(target) && !fs.existsSync(state));
    assert.throws(() => execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
      env: { ...env, SYNOPKG_PKGINST_TEMP_DIR: '' }, stdio: 'pipe',
    }), /Missing DSM installer staging directory/);
    assert.throws(() => execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
      env: { ...env, SYNOPKG_PKGINST_TEMP_DIR: unpack }, stdio: 'pipe',
    }), /Unsupported DSM installer staging layout/);
    for (const [wizard_media_path, wizard_database_path] of [
      ['/volume1/frameleaf/library', '/volume1/frameleaf/library'],
      ['/volume1/frameleaf', '/volume1/frameleaf/postgres'],
      ['/volume1/frameleaf/library', '/volume1/frameleaf'],
    ]) {
      assert.throws(() => execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
        env: { ...env, wizard_media_path, wizard_database_path }, stdio: 'pipe',
      }), /Media and database directories must not overlap/);
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    }
    for (const [wizard_media_path, wizard_database_path] of [
      ['/volume1/frameleaf/', '/volume1/frameleaf/postgres'],
      ['/volume1/frameleaf/library', '/volume1/frameleaf/'],
    ]) {
      assert.throws(() => execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
        env: { ...env, wizard_media_path, wizard_database_path }, stdio: 'pipe',
      }), /without spaces, symlinks or traversal/);
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    }
    const localVolume = path.join(fs.realpathSync(root), 'volume1');
    const localScript = path.join(root, 'local-preinst');
    const preinst = fs.readFileSync(path.join(unpack, 'scripts/preinst'), 'utf8');
    const localPreinst = preinst.replace('/volume[0-9]/*', `${fs.realpathSync(root)}/volume[0-9]/*`);
    assert.notEqual(localPreinst, preinst);
    write(localScript, localPreinst);
    fs.mkdirSync(path.join(localVolume, 'library/postgres'), { recursive: true });
    fs.mkdirSync(path.join(localVolume, 'postgres'));
    fs.symlinkSync(path.join(localVolume, 'library'), path.join(localVolume, 'media-link'));
    const localStaging = path.join(root, 'local-staging');
    fs.cpSync(path.join(staging, 'project'), path.join(localStaging, 'project'), { recursive: true });
    const localEnv = {
      ...env, SYNOPKG_PKGINST_TEMP_DIR: localStaging,
      wizard_media_path: path.join(localVolume, 'library'), wizard_database_path: path.join(localVolume, 'postgres'),
    };
    execFileSync('sh', [localScript], { env: localEnv });
    fs.unlinkSync(path.join(localStaging, 'project/.env'));
    for (const [wizard_media_path, wizard_database_path] of [
      [path.join(localVolume, 'media-link'), path.join(localVolume, 'library/postgres')],
      [path.join(localVolume, 'library/postgres'), path.join(localVolume, 'media-link')],
    ]) {
      assert.throws(() => execFileSync('sh', [localScript], {
        env: { ...localEnv, wizard_media_path, wizard_database_path }, stdio: 'pipe',
      }), /without spaces, symlinks or traversal/);
      assert(!fs.existsSync(path.join(localStaging, 'project/.env')));
    }
    const installEnv = { ...localEnv, SYNOPKG_PKGINST_TEMP_DIR: staging };
    assert.throws(() => execFileSync('sh', [localScript], {
      env: { ...installEnv, wizard_database_path: path.join(localVolume, 'missing') }, stdio: 'pipe',
    }), /directories must already exist/);
    const databasePath = path.join(localVolume, 'postgres');
    const rootUser = process.getuid?.() === 0;
    if (rootUser) {
      for (const dir of [root, localVolume, path.join(localVolume, 'library'), staging, path.join(staging, 'project')])
        fs.chmodSync(dir, 0o755);
      fs.chmodSync(localScript, 0o644);
    }
    fs.chmodSync(databasePath, 0o000);
    try {
      assert.throws(() => execFileSync('sh', [localScript], {
        env: installEnv, stdio: 'pipe', ...(rootUser ? { uid: 65534, gid: 65534 } : {}),
      }), /Cannot inspect database directory/);
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    } finally { fs.chmodSync(databasePath, 0o755); }
    write(path.join(localVolume, 'postgres/PG_VERSION'), '18\n');
    assert.throws(() => execFileSync('sh', [localScript], { env: installEnv, stdio: 'pipe' }),
      /not a PostgreSQL 14 cluster/);
    assert(!fs.existsSync(path.join(staging, 'project/.env')));
    write(path.join(localVolume, 'postgres/PG_VERSION'), '14\n');
    execFileSync('sh', [localScript], { env: installEnv });
    const configured = fs.readFileSync(path.join(staging, 'project/.env'), 'utf8');
    assert(configured.includes('WEB_PORT=3456\n') && configured.includes('ENABLE_ML=false\n'));
    assert.equal(fs.statSync(path.join(staging, 'project/.env')).mode & 0o777, 0o600);
    assert(!fs.existsSync(target) && !fs.existsSync(state));
    // The installer transfers payload after preinst, before Docker Project Acquire and postinst.
    fs.renameSync(staging, target);
    fs.mkdirSync(state);
    const effective = JSON.parse(execFileSync('docker', ['compose', '-f', path.join(target, 'project/compose.yaml'), 'config', '--format', 'json'], { env }).toString());
    assert.equal(effective.services.server.ports[0].published, '3456');
    assert.equal(effective.services.server.environment.IMMICH_MACHINE_LEARNING_ENABLED, 'false');
    assert.equal(effective.services.database.image, nas.images.postgres);
    assert(!effective.services['machine-learning']);
    execFileSync('sh', [path.join(unpack, 'scripts/postinst')], { env });
    assert.equal(fs.readFileSync(path.join(state, 'frameleaf.env'), 'utf8'), configured);
    fs.mkdirSync(staging);
    execFileSync('tar', ['-xzf', path.join(unpack, 'package.tgz'), '-C', staging]);
    execFileSync('sh', [path.join(unpack, 'scripts/preinst')], { env: { ...env, SYNOPKG_PKG_STATUS: 'UPGRADE' } });
    assert.equal(fs.readFileSync(path.join(staging, 'project/.env'), 'utf8'), configured);
    assert.equal(fs.readFileSync(path.join(target, 'project/.env'), 'utf8'), configured);
    assert.throws(() => execFileSync('sh', [localScript], { env: { ...installEnv, wizard_web_port: '1' }, stdio: 'pipe' }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
