import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const server = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A preload observer, not a loader replacement. No application module is
// imported until the unchanged dist/main.js has filled its first config cache,
// constructed Workers and reached signal registration. Stop before bootstrap:
// no worker, database or Cloud connection is needed for this ordering assertion.
const observer = `
import { writeFile } from 'node:fs/promises';
const originalOn = process.on;
const boundary = new Error('test startup observation boundary');
const resultFile = process.env.FRAMELEAF_BOOT_TEST_RESULT_FILE;
const expected = JSON.parse(process.env.FRAMELEAF_BOOT_TEST_EXPECTED);
const finish = async (result) => {
  await writeFile(resultFile, JSON.stringify(result), { mode: 0o600 });
  process.exit(0);
};
originalOn.call(process, 'unhandledRejection', async (error) => {
  if (error !== boundary) return finish({ observed: false });
  try {
    const { ConfigRepository } = await import(process.env.FRAMELEAF_BOOT_TEST_CONFIG_URL);
    const config = new ConfigRepository();
    const first = config.getEnv();
    await finish({
      observed: true,
      portMatches: first.port === expected.port,
      cacheStable: config.getEnv() === first,
      identityPreserved: first.frameleafCloud.identityDir === expected.identityDir,
      replacementSecretPreserved: process.env.FRAMELEAF_EDGE_SECRET === expected.edgeSecret,
      dependencyPreserved: process.env.REDIS_PASSWORD === expected.redisPassword,
      undeclaredPreserved: process.env.FRAMELEAF_BOOT_TEST_UNDECLARED === expected.undeclared,
      linkNotActivated: process.env.FRAMELEAF_LINK_TOKEN === undefined,
      entitlementNotActivated: process.env.FRAMELEAF_LICENSE_EXTRA_JWKS_FILE === undefined,
    });
  } catch {
    await finish({ observed: false });
  }
});
process.on = function (event, ...args) {
  if (event === 'SIGTERM' && process.title === 'frameleaf') throw boundary;
  return originalOn.call(this, event, ...args);
};
`;

const runStartup = async (root, identityDir, binding, port) => {
  const resultFile = join(root, randomUUID() + '.json');
  const edgeSecret = randomBytes(24).toString('base64url');
  const redisPassword = randomBytes(24).toString('base64url');
  const undeclared = randomBytes(24).toString('base64url');
  const env = {
    PATH: dirname(process.execPath),
    FRAMELEAF_ENV: 'production',
    FRAMELEAF_PORT: '2283',
    FRAMELEAF_IDENTITY_DIR: identityDir,
    FRAMELEAF_MEDIA_LOCATION: join(root, 'media'),
    FRAMELEAF_EDGE_SECRET: edgeSecret,
    REDIS_PASSWORD: redisPassword,
    FRAMELEAF_BOOT_TEST_UNDECLARED: undeclared,
    FRAMELEAF_BOOT_TEST_RESULT_FILE: resultFile,
    FRAMELEAF_BOOT_TEST_CONFIG_URL: pathToFileURL(join(server, 'dist/repositories/config.repository.js')).href,
    FRAMELEAF_BOOT_TEST_EXPECTED: JSON.stringify({ port, identityDir, edgeSecret, redisPassword, undeclared }),
    ...(binding ? { FRAMELEAF_BUDDY_BOOT_BINDING_FILE: binding } : {}),
  };
  const child = spawn(
    process.execPath,
    ['--import', join(root, 'observer.mjs'), join(server, 'dist/main.js')],
    {
      cwd: server,
      env,
      // Never forward application errors, configuration values or private paths.
      stdio: 'ignore',
    },
  );
  const outcome = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, 30_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
  assert(outcome, 'Compiled startup did not reach the bounded observer');
  let result;
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'));
  } catch {
    assert.fail('Compiled startup produced no sanitized observation');
  }
  assert.equal(result.observed, true, 'Existing compiled startup/config graph must load before behavioral RED');
  for (const key of [
    'cacheStable',
    'identityPreserved',
    'replacementSecretPreserved',
    'dependencyPreserved',
    'undeclaredPreserved',
    'linkNotActivated',
    'entitlementNotActivated',
  ])
    assert.equal(result[key], true, 'Replacement-local authority must remain unchanged');
  assert.equal(result.portMatches, true, 'Selected typed boot setting must be effective in the first startup cache');
};

test('fresh compiled startup consumes only a completed replacement-local selected boot setting', async () => {
  // Missing builds/imports are setup failures, never the desired RED evidence.
  for (const name of ['main.js', 'repositories/config.repository.js', 'utils/buddy-boot-configuration.js'])
    assert((await lstat(join(server, 'dist', name))).isFile(), 'Hosted compiled distribution prerequisite missing');
  const { stageBuddyBootConfiguration } = await import('../../dist/utils/buddy-boot-configuration.js');
  const { BuddyRecoveryFiles, readBuddyRecovery } = await import('../../dist/utils/buddy-backup-recovery.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-boot-')));
  try {
    await chmod(root, 0o700);
    const identityDir = join(root, 'identity');
    const recoveryId = randomUUID();
    const snapshotId = randomUUID();
    const vaultId = randomUUID();
    const recoveryDirectory = join(root, 'recovery', recoveryId);
    for (const directory of [identityDir, join(root, 'media'), recoveryDirectory, join(recoveryDirectory, 'objects')])
      await mkdir(directory, { recursive: true, mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(
      join(identityDir, 'instance-key.pem'),
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    const jwk = publicKey.export({ format: 'jwk' });
    const replacementIdentity = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
      .digest('base64url');
    const configuration = {
      version: 1,
      entries: [
        { key: 'FRAMELEAF_PORT', state: 'value', value: 2391 },
        { key: 'FRAMELEAF_EDGE_SECRET', state: 'value', value: randomBytes(24).toString('base64url') },
        { key: 'REDIS_PASSWORD', state: 'value', value: randomBytes(24).toString('base64url') },
        { key: 'FRAMELEAF_IDENTITY_DIR', state: 'value', value: join(root, 'historical-identity') },
        { key: 'FRAMELEAF_LINK_TOKEN', state: 'value', value: 'fll_' + randomBytes(24).toString('base64url') },
        { key: 'FRAMELEAF_LICENSE_EXTRA_JWKS_FILE', state: 'value', value: join(root, 'historical-entitlement.json') },
      ],
    };
    await stageBuddyBootConfiguration(recoveryDirectory, snapshotId, configuration);
    const published = Buffer.from(JSON.stringify({ selected: ['FRAMELEAF_PORT'] }));
    const file = { path: join(root, 'selected-settings.json'), sha256: digest(published), size: published.length };
    await writeFile(join(recoveryDirectory, 'objects', file.sha256), published, { mode: 0o600 });
    const plan = {
      version: 1,
      scope: 'settings',
      mode: 'replace',
      manifest: {
        version: 1,
        vaultId,
        snapshotId,
        sequence: 1,
        previous: null,
        frameleafVersion: 'synthetic',
        library: { version: 2, assets: {}, database: null },
        contents: {},
        assetLinks: {},
        assetFiles: {},
        dependencies: [],
        configurationFiles: [file],
        environment: { FRAMELEAF_PORT: '2491' },
        bootConfiguration: configuration,
        storageRoot: join(root, 'media'),
        storageRoots: [join(root, 'media')],
        settings: { system: {}, fork: [], users: [] },
      },
      files: [file],
    };
    const prepared = Buffer.from(JSON.stringify(plan));
    await writeFile(join(recoveryDirectory, 'prepared.json'), prepared, { mode: 0o600 });
    let fenceChecks = 0;
    const files = new BuddyRecoveryFiles(root, recoveryId, () => {
      fenceChecks++;
      return Promise.resolve();
    });
    await files.publish(await readBuddyRecovery(root, recoveryId), [], [file.path]);
    await files.verify(plan, [], [file.path]);
    await files.state('complete');
    assert(fenceChecks > 0, 'Fixture must exercise the publication fence callback');
    assert.equal(await files.load(), 'complete');
    assert((await readFile(file.path)).equals(published), 'Fixture publication must be genuine');
    // Proposed v1 local eligibility contract from the approved boot seam. This
    // grants only selected settings scope, never database/full-server authority.
    const binding = join(identityDir, 'buddy-boot-binding.json');
    await writeFile(
      binding,
      JSON.stringify({
        version: 1,
        state: 'ready',
        recoveryId,
        snapshotId,
        vaultId,
        replacementIdentity,
        scope: 'settings',
        mode: 'replace',
        environmentKeys: ['FRAMELEAF_PORT'],
        recoveryDirectory,
        artifactDigest: digest(await readFile(join(recoveryDirectory, 'boot-configuration.json'))),
        preparedDigest: digest(prepared),
      }),
      { mode: 0o600 },
    );
    for (const name of [
      binding,
      join(identityDir, 'instance-key.pem'),
      join(recoveryDirectory, 'prepared.json'),
      join(recoveryDirectory, 'boot-configuration.json'),
      join(recoveryDirectory, 'publication.json'),
    ]) {
      const metadata = await lstat(name);
      assert(metadata.isFile() && (metadata.mode & 0o777) === 0o600, 'Fixture authority files must be private');
    }
    await writeFile(join(root, 'observer.mjs'), observer, { mode: 0o600 });
    await runStartup(root, identityDir, undefined, 2283);
    await runStartup(root, identityDir, binding, 2391);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
