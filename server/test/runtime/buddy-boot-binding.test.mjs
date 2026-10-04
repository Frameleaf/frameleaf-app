import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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
      helpMatches: first.buildMetadata.thirdPartyDocumentationUrl === expected.docs,
      cacheStable: config.getEnv() === first,
      identityPreserved: first.frameleafCloud.identityDir === expected.identityDir,
      replacementSecretPreserved: process.env.FRAMELEAF_EDGE_SECRET === expected.edgeSecret,
      dependencyPreserved: process.env.DB_PASSWORD === expected.databasePassword,
      sourceFilesPreserved: process.env.DB_PASSWORD_FILE === expected.dbPasswordFile,
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

const runStartup = async (root, identityDir, binding, port, options = {}) => {
  const resultFile = join(root, randomUUID() + '.json');
  const edgeSecret = randomBytes(24).toString('base64url');
  const databasePassword = randomBytes(24).toString('base64url');
  const undeclared = randomBytes(24).toString('base64url');
  const dbPasswordFile = join(root, 'replacement-db-secret-source');
  const env = {
    PATH: dirname(process.execPath),
    FRAMELEAF_ENV: 'production',
    FRAMELEAF_PORT: '2283',
    FRAMELEAF_IDENTITY_DIR: identityDir,
    FRAMELEAF_MEDIA_LOCATION: join(root, 'media'),
    FRAMELEAF_EDGE_SECRET: edgeSecret,
    DB_PASSWORD: databasePassword,
    DB_PASSWORD_FILE: dbPasswordFile,
    FRAMELEAF_BOOT_TEST_UNDECLARED: undeclared,
    FRAMELEAF_BOOT_TEST_RESULT_FILE: resultFile,
    FRAMELEAF_BOOT_TEST_CONFIG_URL: pathToFileURL(join(server, 'dist/repositories/config.repository.js')).href,
    FRAMELEAF_BOOT_TEST_EXPECTED: JSON.stringify({
      port,
      identityDir,
      edgeSecret,
      databasePassword,
      undeclared,
      dbPasswordFile,
      docs: options.docs,
    }),
    ...(binding ? { FRAMELEAF_BUDDY_BOOT_BINDING_FILE: binding } : {}),
    ...options.env,
  };
  const child = spawn(process.execPath, ['--import', join(root, 'observer.mjs'), join(server, 'dist/main.js')], {
    cwd: server,
    env,
    // Never forward application errors, configuration values or private paths.
    stdio: 'ignore',
  });
  const outcome = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true });
    }, 30_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolve({ error: true });
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
  });
  assert(!outcome.timedOut && !outcome.error, 'Compiled startup did not terminate at the bounded observer');
  if (options.refuse) {
    assert.equal(outcome.code, 1, 'Invalid local authority must stop startup before the application graph');
    await assert.rejects(readFile(resultFile), { code: 'ENOENT' });
    return;
  }
  assert.equal(outcome.code, 0, 'Compiled startup did not reach the bounded observer');
  let result;
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'));
  } catch {
    assert.fail('Compiled startup produced no sanitized observation');
  }
  assert.equal(result.observed, true, 'Existing compiled startup/config graph must load before behavioral RED');
  for (const key of [
    'helpMatches',
    'cacheStable',
    'identityPreserved',
    'replacementSecretPreserved',
    'dependencyPreserved',
    'sourceFilesPreserved',
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
    await writeFile(join(identityDir, 'instance-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    const jwk = publicKey.export({ format: 'jwk' });
    const replacementIdentity = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
      .digest('base64url');
    const configuration = {
      version: 1,
      entries: [
        { key: 'FRAMELEAF_PORT', state: 'value', value: 2391 },
        { key: 'FRAMELEAF_EDGE_SECRET', state: 'value', value: randomBytes(24).toString('base64url') },
        { key: 'DB_PASSWORD', state: 'value', value: randomBytes(24).toString('base64url') },
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
        settings: { system: {}, users: [] },
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
    // Repeat a genuinely fresh process; never clear a live application's cache.
    await runStartup(root, identityDir, binding, 2391);
    const originalBinding = await readFile(binding);
    const originalArtifact = await readFile(join(recoveryDirectory, 'boot-configuration.json'));
    const writeBinding = async (changes) =>
      writeFile(binding, JSON.stringify({ ...JSON.parse(originalBinding), ...changes }), { mode: 0o600 });
    for (const changes of [
      { replacementIdentity: 'A'.repeat(43) },
      { snapshotId: randomUUID() },
      { vaultId: randomUUID() },
      { recoveryId: randomUUID() },
      { scope: 'server' },
      { state: 'request' },
      { mode: 'keep' }, // A grant must match the published plan mode.
      { environmentKeys: ['FRAMELEAF_EDGE_SECRET'] },
      { environmentKeys: ['DB_PASSWORD'] },
      { environmentKeys: ['FRAMELEAF_IDENTITY_DIR'] },
      { environmentKeys: ['FRAMELEAF_LINK_TOKEN'] },
      { environmentKeys: ['FRAMELEAF_LICENSE_EXTRA_JWKS_FILE'] },
      { preparedDigest: '0'.repeat(64) },
      { environmentKeys: ['FRAMELEAF_PORT', 'FRAMELEAF_PORT'] },
      { environmentKeys: ['NODE_OPTIONS'] },
      { environmentKeys: ['IMMICH_PORT'] },
      { environmentKeys: ['FRAMELEAF_SHUTDOWN_GRACE_SECONDS'] },
      { unrecognized: true },
    ]) {
      await writeBinding(changes);
      await runStartup(root, identityDir, binding, 2391, { refuse: true });
    }
    await writeFile(binding, originalBinding);
    for (const state of ['publishing', 'files-ready', 'database-ready', 'rolled-back']) {
      await files.state(state);
      await runStartup(root, identityDir, binding, 2391, { refuse: true });
    }
    await files.state('complete');
    await chmod(binding, 0o644);
    await runStartup(root, identityDir, binding, 2391, { refuse: true });
    await chmod(binding, 0o600);
    await writeFile(
      join(recoveryDirectory, 'boot-configuration.json'),
      Buffer.concat([originalArtifact, Buffer.from(' ')]),
    );
    await runStartup(root, identityDir, binding, 2391, { refuse: true });
    await rm(join(recoveryDirectory, 'boot-configuration.json'));
    const foreignArtifact = join(root, 'foreign-artifact.json');
    await writeFile(foreignArtifact, originalArtifact, { mode: 0o600 });
    await symlink(foreignArtifact, join(recoveryDirectory, 'boot-configuration.json'));
    await runStartup(root, identityDir, binding, 2391, { refuse: true });
    await rm(join(recoveryDirectory, 'boot-configuration.json'));
    await writeFile(join(recoveryDirectory, 'boot-configuration.json'), originalArtifact, { mode: 0o600 });

    const markerDirectory = join(identityDir, 'buddy');
    await mkdir(markerDirectory, { mode: 0o700 });
    const marker = join(markerDirectory, 'recovery-active.json');
    await writeFile(
      marker,
      JSON.stringify({ isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: recoveryId } }),
      { mode: 0o600 },
    );
    await runStartup(root, identityDir, binding, 2283);
    await writeFile(
      marker,
      JSON.stringify({ isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: randomUUID() } }),
    );
    await runStartup(root, identityDir, binding, 2391, { refuse: true });
    await writeFile(marker, '{');
    await runStartup(root, identityDir, binding, 2391, { refuse: true });
    await writeFile(
      marker,
      JSON.stringify({ isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: recoveryId } }),
    );

    // Real durable request finalization, including complete retry and lost fence.
    const { finalizeBuddyBootBinding } = await import('../../dist/utils/buddy-boot-binding.js');
    const previousBinding = process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE;
    const previousIdentity = process.env.FRAMELEAF_IDENTITY_DIR;
    try {
      process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE = binding;
      process.env.FRAMELEAF_IDENTITY_DIR = identityDir;
      await writeBinding({ state: 'request' });
      await files.state('files-ready');
      await runStartup(root, identityDir, binding, 2283);
      await assert.rejects(finalizeBuddyBootBinding(root, recoveryId, async () => {}));
      assert.equal(JSON.parse(await readFile(binding)).state, 'request');
      await files.state('complete');
      await assert.rejects(
        finalizeBuddyBootBinding(root, recoveryId, async () => {
          throw new Error('synthetic fence lost');
        }),
      );
      assert.equal(JSON.parse(await readFile(binding)).state, 'request');
      let beforeRename = 0;
      await assert.rejects(
        finalizeBuddyBootBinding(root, recoveryId, async () => {
          if (++beforeRename === 3) throw new Error('synthetic fence lost before durable readiness');
        }),
      );
      assert.equal(JSON.parse(await readFile(binding)).state, 'request');
      let finalizationFences = 0;
      await finalizeBuddyBootBinding(root, recoveryId, async () => {
        finalizationFences++;
      });
      assert(finalizationFences >= 3, 'Durable readiness must assert its live maintenance fence');
      await writeBinding({ state: 'request' });
      let afterRename = 0;
      await assert.rejects(
        finalizeBuddyBootBinding(root, recoveryId, async () => {
          if (++afterRename === 4) throw new Error('synthetic fence lost after durable readiness');
        }),
      );
      assert.equal(JSON.parse(await readFile(binding)).state, 'ready');
      await runStartup(root, identityDir, binding, 2283);
      const ready = await readFile(binding);
      await finalizeBuddyBootBinding(root, recoveryId, async () => {});
      assert((await readFile(binding)).equals(ready), 'Complete retry must be idempotent');
    } finally {
      if (previousBinding === undefined) delete process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE;
      else process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE = previousBinding;
      if (previousIdentity === undefined) delete process.env.FRAMELEAF_IDENTITY_DIR;
      else process.env.FRAMELEAF_IDENTITY_DIR = previousIdentity;
    }
    await rm(marker);
    await runStartup(root, identityDir, binding, 2391);

    // Keep/replace are bound to a corresponding publication plan, not a loose switch.
    const updateBootFixture = async (mode, entries, environmentKeys = ['FRAMELEAF_PORT']) => {
      plan.mode = mode;
      plan.manifest.bootConfiguration = { version: 1, entries };
      await stageBuddyBootConfiguration(recoveryDirectory, snapshotId, plan.manifest.bootConfiguration);
      const bytes = Buffer.from(JSON.stringify(plan));
      await writeFile(join(recoveryDirectory, 'prepared.json'), bytes);
      await files.state('publishing');
      await files.publish(await readBuddyRecovery(root, recoveryId), [], [file.path]);
      await files.verify(plan, [], [file.path]);
      await files.state('complete');
      await writeBinding({
        mode,
        environmentKeys,
        artifactDigest: digest(await readFile(join(recoveryDirectory, 'boot-configuration.json'))),
        preparedDigest: digest(bytes),
      });
    };
    await updateBootFixture('keep', configuration.entries);
    await runStartup(root, identityDir, binding, 2283);
    await runStartup(root, identityDir, binding, 2284, { env: { FRAMELEAF_PORT: undefined, IMMICH_PORT: '2284' } });
    await runStartup(root, identityDir, binding, 2391, { env: { FRAMELEAF_PORT: undefined } });
    await updateBootFixture('replace', configuration.entries);
    await runStartup(root, identityDir, binding, 2391, { env: { FRAMELEAF_PORT: undefined, IMMICH_PORT: '2284' } });
    await runStartup(root, identityDir, binding, 2391, {
      refuse: true,
      env: { FRAMELEAF_PORT: '2283', IMMICH_PORT: '2284' },
    });
    await updateBootFixture('replace', [
      { key: 'FRAMELEAF_PORT', state: 'unset' },
      ...configuration.entries.filter((entry) => entry.key !== 'FRAMELEAF_PORT'),
    ]);
    await runStartup(root, identityDir, binding, 2283, { env: { FRAMELEAF_PORT: undefined, IMMICH_PORT: '2284' } });
    const restoredDocs = 'https://restored.example.test/docs';
    const localDocs = 'https://replacement.example.test/docs';
    const helpEntries = [...configuration.entries, { key: 'FRAMELEAF_DOCS_URL', state: 'value', value: restoredDocs }];
    await updateBootFixture('keep', helpEntries, ['FRAMELEAF_PORT', 'FRAMELEAF_DOCS_URL']);
    await runStartup(root, identityDir, binding, 2283, {
      docs: localDocs,
      env: { IMMICH_THIRD_PARTY_DOCUMENTATION_URL: localDocs },
    });
    await runStartup(root, identityDir, binding, 2283, {
      docs: restoredDocs,
      env: { IMMICH_THIRD_PARTY_DOCUMENTATION_URL: 'invalid-legacy-url' },
    });
    await runStartup(root, identityDir, binding, 2283, {
      docs: localDocs,
      env: { FRAMELEAF_DOCS_URL: localDocs, IMMICH_THIRD_PARTY_DOCUMENTATION_URL: restoredDocs },
    });
    await updateBootFixture('replace', helpEntries, ['FRAMELEAF_PORT', 'FRAMELEAF_DOCS_URL']);
    await runStartup(root, identityDir, binding, 2391, {
      docs: restoredDocs,
      env: { IMMICH_THIRD_PARTY_DOCUMENTATION_URL: localDocs },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
