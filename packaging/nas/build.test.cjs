const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { build } = require('./build.cjs');
const {
  createBundle,
  hash,
  INSTALL_FILES,
  VARIANTS,
  REPOSITORY,
  SOURCE,
  ATTESTATION_TYPE,
} = require('../../.github/frameleaf-release.cjs');

const digest = (n) => `sha256:${String(n).repeat(64)}`;
test(
  'TrueNAS rendering rejects missing, empty, changed and symlinked libraries before import',
  {
    skip: process.env.FRAMELEAF_REQUIRE_TRUENAS_RENDER !== 'true',
  },
  () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-truenas-trust-'));
    const app = path.join(root, 'app');
    const library = path.join(root, 'base_v2_3_4');
    const sentinel = path.join(root, 'imported');
    const reject = (message) => {
      for (const flags of [[], ['-O']]) {
        assert.throws(
          () =>
            execFileSync('python3', [...flags, path.join(__dirname, 'check-truenas.py'), app, library], {
              stdio: 'pipe',
            }),
          message,
        );
      }
    };
    try {
      fs.mkdirSync(app);
      fs.copyFileSync(path.join(__dirname, 'truenas/app.yaml'), path.join(app, 'app.yaml'));
      reject(/Missing or symlinked TrueNAS library/);
      fs.mkdirSync(library);
      reject(/Empty TrueNAS library/);
      fs.writeFileSync(
        path.join(library, 'render.py'),
        `from pathlib import Path\nPath(${JSON.stringify(sentinel)}).touch()\n`,
      );
      reject(/TrueNAS library hash mismatch/);
      assert(!fs.existsSync(sentinel), 'Unverified code must not be imported');
      fs.symlinkSync(path.join(library, 'render.py'), path.join(library, 'linked.py'));
      reject(/Symlink in TrueNAS library/);
      fs.unlinkSync(path.join(library, 'linked.py'));
      fs.renameSync(library, path.join(root, 'actual-library'));
      fs.symlinkSync(path.join(root, 'actual-library'), library);
      reject(/Missing or symlinked TrueNAS library/);
      assert(!fs.existsSync(sentinel));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
test('authenticated release packaging, negative trust cases, and Synology worker timing', async () => {
  if (process.env.FRAMELEAF_REQUIRE_TRUENAS_RENDER === 'true') {
    assert(process.env.TRUENAS_LIBRARY, 'Mandatory hosted TrueNAS rendering requires TRUENAS_LIBRARY');
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-nas-'));
  const tag = 'frameleaf-v3.1.0-1';
  const sha = 'a'.repeat(40);
  const database = 'ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7';
  const bundle = path.join(root, 'bundle');
  const output = path.join(root, 'output');
  const sourceRoot = path.join(root, 'source');
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, body);
  };
  try {
    for (const name of INSTALL_FILES) {
      let body = fs.readFileSync(path.join(__dirname, '../../docker', name), 'utf8');
      if (name.startsWith('docker-compose')) {
        const pinned = new RegExp(`${database.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}`, 'g');
        assert(pinned.test(body), `${name} must retain a pinned production PostgreSQL image`);
        body = body.replace(pinned, `${database}@${digest(8)}`);
      }
      write(path.join(sourceRoot, 'docker', name), body);
    }
    const release = {
      schemaVersion: 3,
      repository: REPOSITORY,
      tag,
      sourceCommit: sha,
      buildRun: `${SOURCE}/actions/runs/123`,
      images: VARIANTS.map((spec, i) => ({
        image: `ghcr.io/frameleaf/${spec.image}`,
        suffix: spec.suffix,
        digest: digest(i + 1),
        sourceCommit: sha,
        platforms: spec.platforms,
      })),
      dependencies: [{ reference: database, digest: digest(8) }],
    };
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
      return (
        [release]
          .map((predicate) =>
            JSON.stringify({
              payload: Buffer.from(
                JSON.stringify({
                  predicateType: type,
                  predicate,
                  subject: [{ name, digest: { sha256: value.slice(7) } }],
                }),
              ).toString('base64'),
            }),
          )
          .join('\n') + '\n'
      );
    };
    const trusted = {
      head_sha: sha,
      head_branch: 'fork/main',
      head_repository: { full_name: REPOSITORY },
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/docker.yml',
    };
    const request = async (endpoint) => {
      if (endpoint === 'actions/runs/123') return trusted;
      throw new Error(`Unexpected evidence request: ${endpoint}`);
    };
    let rejected = 0;
    const reject = async (pattern, verification = {}) => {
      const out = path.join(root, `rejected-${rejected++}`);
      await assert.rejects(build(bundle, tag, out, { run, request, ...verification }), pattern);
      assert(!fs.existsSync(out), 'An unverified bundle must produce no package');
    };
    await reject(/signature rejected/, {
      run: () => {
        throw new Error('signature rejected');
      },
    });
    await reject(/Signed attestation differs/, {
      run: (command, args) =>
        args[0] === 'verify'
          ? '[]'
          : JSON.stringify({
              payload: Buffer.from(
                JSON.stringify({ predicateType: ATTESTATION_TYPE, predicate: {}, subject: [] }),
              ).toString('base64'),
            }),
    });
    await reject(/Build provenance is not trusted/, {
      request: async (endpoint) =>
        endpoint === 'actions/runs/123' ? { ...trusted, head_sha: 'b'.repeat(40) } : request(endpoint),
    });
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
    const forgedRelease = JSON.stringify({ ...release, provenance: 'forged' });
    write(path.join(bundle, 'release-manifest.json'), forgedRelease);
    write(path.join(bundle, 'SHA256SUMS'), sums.replace(hash(originalRelease).slice(7), hash(forgedRelease).slice(7)));
    await reject(/Signed attestation differs/);
    write(path.join(bundle, 'release-manifest.json'), originalRelease);
    write(path.join(bundle, 'SHA256SUMS'), sums);
    await build(bundle, tag, output, { run, request });
    assert(calls.some((args) => args[0] === 'verify-attestation' && args.at(-1) === nas.images.server));
    const read = (name) => fs.readFileSync(path.join(output, name), 'utf8');
    const unraidServer = read('unraid/templates/frameleaf-server.xml');
    assert(unraidServer.includes(nas.images.server));
    // FL-291: the stop timeout must exceed FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS (9 s by default)
    assert(unraidServer.includes('<ExtraParams>--stop-timeout=10</ExtraParams>'));
    assert(
      read('truenas/ix-dev/community/frameleaf/templates/docker-compose.yaml').includes(
        'server_container.set_grace_period(10)',
      ),
    );
    // FL-300: Frameleaf serves no metrics, so the app neither asks for metrics ports nor sets their variables
    for (const name of ['questions.yaml', 'templates/docker-compose.yaml', 'templates/test_values/basic-values.yaml']) {
      assert(!/metrics/i.test(read(`truenas/ix-dev/community/frameleaf/${name}`)), `${name} still mentions metrics`);
    }
    assert.match(
      unraidServer,
      /<Config Name="Machine learning" Target="FRAMELEAF_MACHINE_LEARNING_ENABLED" Default=""[^>]*><\/Config>/,
    );
    assert(read('unraid/templates/frameleaf-ml.xml').includes(nas.images.machineLearning));
    const values = read('truenas/ix-dev/community/frameleaf/ix_values.yaml');
    assert(values.includes('repository: "ghcr.io/frameleaf/frameleaf-postgres"'));
    assert(values.includes(`19beta4-pgvector0.8.7@${digest(8)}`));
    assert(!values.includes('immich-app'));
    if (process.env.TRUENAS_LIBRARY) {
      const rendered = execFileSync('python3', [
        path.join(__dirname, 'check-truenas.py'),
        path.join(output, 'truenas/ix-dev/community/frameleaf'),
        process.env.TRUENAS_LIBRARY,
      ]).toString();
      assert.match(rendered, /TrueNAS library render passed with ML disabled and enabled/);
      assert(
        !fs.existsSync(path.join(process.env.TRUENAS_LIBRARY, '__pycache__')),
        'Rendering must not mutate the verified library',
      );
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
      ...process.env,
      SYNOPKG_PKGDEST: target,
      SYNOPKG_PKGVAR: state,
      SYNOPKG_PKGINST_TEMP_DIR: staging,
      wizard_media_path: '/volume1/frameleaf/library',
      wizard_database_path: '/volume1/frameleaf/postgres',
      wizard_database_password: 'FixtureOnly123456',
      wizard_web_port: '3456',
      wizard_enable_ml: 'false',
    };
    assert(!fs.existsSync(target) && !fs.existsSync(state));
    assert.throws(
      () =>
        execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
          env: { ...env, SYNOPKG_PKGINST_TEMP_DIR: '' },
          stdio: 'pipe',
        }),
      /Missing DSM installer staging directory/,
    );
    assert.throws(
      () =>
        execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
          env: { ...env, SYNOPKG_PKGINST_TEMP_DIR: unpack },
          stdio: 'pipe',
        }),
      /Unsupported DSM installer staging layout/,
    );
    for (const [wizard_media_path, wizard_database_path] of [
      ['/volume1/frameleaf/library', '/volume1/frameleaf/library'],
      ['/volume1/frameleaf', '/volume1/frameleaf/postgres'],
      ['/volume1/frameleaf/library', '/volume1/frameleaf'],
    ]) {
      assert.throws(
        () =>
          execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
            env: { ...env, wizard_media_path, wizard_database_path },
            stdio: 'pipe',
          }),
        /Media and database directories must not overlap/,
      );
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    }
    for (const [wizard_media_path, wizard_database_path] of [
      ['/volume1/frameleaf/', '/volume1/frameleaf/postgres'],
      ['/volume1/frameleaf/library', '/volume1/frameleaf/'],
    ]) {
      assert.throws(
        () =>
          execFileSync('sh', [path.join(unpack, 'scripts/preinst')], {
            env: { ...env, wizard_media_path, wizard_database_path },
            stdio: 'pipe',
          }),
        /without spaces, symlinks or traversal/,
      );
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
      ...env,
      SYNOPKG_PKGINST_TEMP_DIR: localStaging,
      wizard_media_path: path.join(localVolume, 'library'),
      wizard_database_path: path.join(localVolume, 'postgres'),
    };
    execFileSync('sh', [localScript], { env: localEnv });
    fs.unlinkSync(path.join(localStaging, 'project/.env'));
    for (const [wizard_media_path, wizard_database_path] of [
      [path.join(localVolume, 'media-link'), path.join(localVolume, 'library/postgres')],
      [path.join(localVolume, 'library/postgres'), path.join(localVolume, 'media-link')],
    ]) {
      assert.throws(
        () =>
          execFileSync('sh', [localScript], {
            env: { ...localEnv, wizard_media_path, wizard_database_path },
            stdio: 'pipe',
          }),
        /without spaces, symlinks or traversal/,
      );
      assert(!fs.existsSync(path.join(localStaging, 'project/.env')));
    }
    const installEnv = { ...localEnv, SYNOPKG_PKGINST_TEMP_DIR: staging };
    assert.throws(
      () =>
        execFileSync('sh', [localScript], {
          env: { ...installEnv, wizard_database_path: path.join(localVolume, 'missing') },
          stdio: 'pipe',
        }),
      /directories must already exist/,
    );
    const databasePath = path.join(localVolume, 'postgres');
    const rootUser = process.getuid?.() === 0;
    if (rootUser) {
      for (const dir of [root, localVolume, path.join(localVolume, 'library'), staging, path.join(staging, 'project')])
        fs.chmodSync(dir, 0o755);
      fs.chmodSync(localScript, 0o644);
    }
    fs.chmodSync(databasePath, 0o000);
    try {
      assert.throws(
        () =>
          execFileSync('sh', [localScript], {
            env: installEnv,
            stdio: 'pipe',
            ...(rootUser ? { uid: 65534, gid: 65534 } : {}),
          }),
        /Cannot inspect database directory/,
      );
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    } finally {
      fs.chmodSync(databasePath, 0o755);
    }
    for (const version of ['14', '18', '19']) {
      write(path.join(localVolume, 'postgres/PG_VERSION'), `${version}\n`);
      assert.throws(
        () => execFileSync('sh', [localScript], { env: installEnv, stdio: 'pipe' }),
        /requires an empty database directory/,
      );
      assert(!fs.existsSync(path.join(staging, 'project/.env')));
    }
    fs.unlinkSync(path.join(localVolume, 'postgres/PG_VERSION'));
    execFileSync('sh', [localScript], { env: installEnv });
    const configured = fs.readFileSync(path.join(staging, 'project/.env'), 'utf8');
    assert(configured.includes('WEB_PORT=3456\n') && configured.includes('ENABLE_ML=false\n'));
    assert.equal(fs.statSync(path.join(staging, 'project/.env')).mode & 0o777, 0o600);
    assert(!fs.existsSync(target) && !fs.existsSync(state));
    // The installer transfers payload after preinst, before Docker Project Acquire and postinst.
    fs.renameSync(staging, target);
    fs.mkdirSync(state);
    const effective = JSON.parse(
      execFileSync(
        'docker',
        ['compose', '-f', path.join(target, 'project/compose.yaml'), 'config', '--format', 'json'],
        { env },
      ).toString(),
    );
    assert.equal(effective.services.server.ports[0].published, '3456');
    assert.equal(effective.services.server.stop_grace_period, '10s');
    assert.equal(effective.services.server.environment.FRAMELEAF_MACHINE_LEARNING_ENABLED, 'false');
    assert.equal(effective.services.database.image, nas.images.postgres);
    assert(!effective.services['machine-learning']);
    execFileSync('sh', [path.join(unpack, 'scripts/postinst')], { env });
    assert.equal(fs.readFileSync(path.join(state, 'frameleaf.env'), 'utf8'), configured);
    fs.mkdirSync(staging);
    execFileSync('tar', ['-xzf', path.join(unpack, 'package.tgz'), '-C', staging]);
    fs.writeFileSync(path.join(databasePath, 'PG_VERSION'), '19\n');
    execFileSync('sh', [localScript], { env: { ...installEnv, SYNOPKG_PKG_STATUS: 'UPGRADE' } });
    assert.equal(fs.readFileSync(path.join(staging, 'project/.env'), 'utf8'), configured);
    assert.equal(fs.readFileSync(path.join(target, 'project/.env'), 'utf8'), configured);
    // Hosted Compose rendering complements the shell-only retained-admission controls below.
    const retainedConfig = path.join(state, 'frameleaf.env');
    const stagedConfig = path.join(staging, 'project/.env');
    const quoted =
      '# Retained fixture with literal quotes and CRLF\r\n' +
      configured
        .trimEnd()
        .split('\n')
        .map((line, index) => {
          const equal = line.indexOf('=');
          const quote = index % 2 ? '"' : "'";
          return `export ${line.slice(0, equal)} = ${quote}${line.slice(equal + 1)}${quote} # literal fixture`;
        })
        .join('\r\n') +
      '\r\n';
    const quotedBytes = Buffer.from(quoted);
    fs.writeFileSync(retainedConfig, quotedBytes);
    fs.unlinkSync(stagedConfig);
    try {
      execFileSync('sh', [localScript], { env: { ...installEnv, SYNOPKG_PKG_STATUS: 'UPGRADE' }, stdio: 'pipe' });
      const rendered = JSON.parse(
        execFileSync(
          'docker',
          [
            'compose',
            '--env-file',
            stagedConfig,
            '-f',
            path.join(target, 'project/compose.yaml'),
            'config',
            '--format',
            'json',
          ],
          { env, stdio: 'pipe' },
        ).toString(),
      );
      assert.deepEqual(
        {
          retainedUnchanged: fs.readFileSync(retainedConfig).equals(quotedBytes),
          stagedUnchanged: fs.readFileSync(stagedConfig).equals(quotedBytes),
          installedUnchanged: fs.readFileSync(path.join(target, 'project/.env'), 'utf8') === configured,
          portMatches: rendered.services.server.ports[0].published === '3456',
          mlMatches: rendered.services.server.environment.FRAMELEAF_MACHINE_LEARNING_ENABLED === 'false',
          passwordMatches: rendered.services.server.environment.DB_PASSWORD === env.wizard_database_password,
        },
        {
          retainedUnchanged: true,
          stagedUnchanged: true,
          installedUnchanged: true,
          portMatches: true,
          mlMatches: true,
          passwordMatches: true,
        },
      );
    } finally {
      fs.writeFileSync(retainedConfig, configured);
      fs.writeFileSync(stagedConfig, configured, { mode: 0o600 });
    }
    assert.throws(() =>
      execFileSync('sh', [localScript], { env: { ...installEnv, wizard_web_port: '1' }, stdio: 'pipe' }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Synology retained settings admission preserves bytes and refuses invalid upgrade staging', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frameleaf-synology-retained-')));
  const volume = path.join(root, 'volume1');
  const media = path.join(volume, 'library');
  const database = path.join(volume, 'postgres');
  const state = path.join(root, 'state');
  const staging = path.join(root, 'staging/project');
  const installed = path.join(root, 'installed/project');
  const retained = path.join(state, 'frameleaf.env');
  const staged = path.join(staging, '.env');
  const localScript = path.join(root, 'preinst');
  const commandSentinel = path.join(root, 'retained-command-executed');
  try {
    for (const directory of [
      media,
      database,
      state,
      staging,
      installed,
      path.join(media, 'postgres'),
      path.join(database, 'media'),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const preinst = fs.readFileSync(path.join(__dirname, 'synology/scripts/preinst'), 'utf8');
    // Adapt only the DSM /volumeN prefix to a disposable local fixture; platform admission remains unqualified.
    const adapted = preinst.replace('/volume[0-9]/*', `${root}/volume[0-9]/*`);
    assert.notEqual(adapted, preinst);
    fs.writeFileSync(localScript, adapted);
    fs.writeFileSync(path.join(staging, 'compose.yaml'), 'services: {}\n');
    fs.symlinkSync(media, path.join(volume, 'media-link'));
    const configured = [
      `UPLOAD_LOCATION=${media}`,
      `DB_DATA_LOCATION=${database}`,
      'DB_PASSWORD=FixtureOnly123456',
      'WEB_PORT=3456',
      'COMPOSE_PROFILES=',
      'ENABLE_ML=false',
      '',
    ].join('\n');
    const installedConfig = path.join(installed, '.env');
    fs.writeFileSync(installedConfig, configured);
    const sentinelBytes = Buffer.from([0, 255, 7, 19, 83]);
    const mediaSentinel = path.join(media, 'retained-media.bin');
    const databaseSentinel = path.join(database, 'retained-database.bin');
    fs.writeFileSync(mediaSentinel, sentinelBytes);
    fs.writeFileSync(databaseSentinel, sentinelBytes);
    fs.writeFileSync(path.join(database, 'PG_VERSION'), '19\n');
    const env = {
      ...process.env,
      SYNOPKG_PKGINST_TEMP_DIR: path.dirname(staging),
      SYNOPKG_PKGVAR: state,
      SYNOPKG_PKG_STATUS: 'UPGRADE',
    };
    const unchanged = (bytes) => ({
      retained: fs.readFileSync(retained).equals(bytes),
      installed: fs.readFileSync(installedConfig, 'utf8') === configured,
      media: fs.readFileSync(mediaSentinel).equals(sentinelBytes),
      database: fs.readFileSync(databaseSentinel).equals(sentinelBytes),
      version: fs.readFileSync(path.join(database, 'PG_VERSION'), 'utf8') === '19\n',
      commandExecuted: fs.existsSync(commandSentinel),
    });
    const expectedUnchanged = {
      retained: true,
      installed: true,
      media: true,
      database: true,
      version: true,
      commandExecuted: false,
    };
    const quoted =
      '# Literal retained values\r\n' +
      configured
        .trimEnd()
        .split('\n')
        .map((line, index) => {
          const equal = line.indexOf('=');
          const quote = index % 2 ? '"' : "'";
          return `export ${line.slice(0, equal)} = ${quote}${line.slice(equal + 1)}${quote} # fixture`;
        })
        .join('\r\n') +
      '\r\n';
    for (const [name, value] of [
      ['plain', configured],
      ['literal quoted CRLF', quoted],
    ]) {
      await t.test(`accepts ${name} retained settings`, () => {
        const bytes = Buffer.from(value);
        fs.writeFileSync(retained, bytes);
        fs.rmSync(staged, { force: true });
        const result = spawnSync('sh', [localScript], { env, stdio: 'pipe' });
        assert.ifError(result.error);
        assert.equal(result.status, 0);
        assert(fs.readFileSync(staged).equals(bytes));
        assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
        assert.deepEqual(unchanged(bytes), expectedUnchanged);
      });
    }
    for (const [name, changes, alter] of [
      ['port below allowed range', { WEB_PORT: '1' }],
      ['port above allowed range', { WEB_PORT: '65536' }],
      ['nonnumeric port', { WEB_PORT: 'not-a-port' }],
      ['invalid ML boolean', { ENABLE_ML: 'perhaps' }],
      ['media traversal', { UPLOAD_LOCATION: `${media}/../library` }],
      ['database path containing spaces', { DB_DATA_LOCATION: `${volume}/unsafe database` }],
      ['symlinked media path', { UPLOAD_LOCATION: path.join(volume, 'media-link') }],
      ['equal media and database paths', { DB_DATA_LOCATION: media }],
      ['database nested in media', { DB_DATA_LOCATION: path.join(media, 'postgres') }],
      ['media nested in database', { UPLOAD_LOCATION: path.join(database, 'media') }],
      ['duplicate port assignment', { WEB_PORT: '3456\nWEB_PORT=4567' }],
      ['unterminated quoted value', { WEB_PORT: '"3456' }],
      ['password outside installer grammar', { DB_PASSWORD: 'Fixture!Only123456' }],
      ['missing required port', {}, (value) => value.replace(/^WEB_PORT=.*\n/m, '')],
      ['command substitution in media path', { UPLOAD_LOCATION: `$(touch ${commandSentinel})` }],
      ['inconsistent ML profile', { COMPOSE_PROFILES: 'ml' }],
    ]) {
      await t.test(`refuses retained ${name} before staging`, () => {
        let invalid = alter ? alter(configured) : configured;
        for (const [key, value] of Object.entries(changes)) {
          const original = invalid;
          invalid = invalid.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
          assert.notEqual(invalid, original, 'Fixture must change a declared retained field');
        }
        assert.notEqual(invalid, configured, 'Fixture must change retained configuration');
        const bytes = Buffer.from(invalid);
        fs.writeFileSync(retained, bytes);
        fs.rmSync(staged, { force: true });
        fs.rmSync(`${staged}.tmp`, { force: true });
        const result = spawnSync('sh', [localScript], { env, stdio: 'pipe' });
        assert.ifError(result.error);
        // Only outcome flags are reported; retained configuration and passwords never enter diagnostics.
        assert.deepEqual(
          {
            refused: result.status !== null && result.status !== 0 && result.signal === null,
            staged: fs.existsSync(staged),
            stagedTemporary: fs.existsSync(`${staged}.tmp`),
            ...unchanged(bytes),
          },
          { refused: true, staged: false, stagedTemporary: false, ...expectedUnchanged },
        );
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
