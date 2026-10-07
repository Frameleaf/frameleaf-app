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
test('authenticated TrueNAS and Unraid packaging refuses untrusted releases and emits no DSM package', async () => {
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
    assert(!fs.existsSync(path.join(output, 'synology')), 'DSM packages belong in the private Synology repository');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Synology source and SPK builders stay out of the public app repository', () => {
  assert(!fs.existsSync(path.join(__dirname, 'synology')));
  assert(!fs.existsSync(path.join(__dirname, 'build-spk.cjs')));
});
