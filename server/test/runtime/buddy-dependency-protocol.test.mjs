import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const server = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Observe the existing first cache at its existing pre-bootstrap signal boundary.
// No loader/config/client is replaced. No SQL, Redis or worker connection runs.
const observer = `
import { writeFile } from 'node:fs/promises';
const originalOn = process.on;
const boundary = new Error('protocol test pre-bootstrap boundary');
const expected = JSON.parse(process.env.FRAMELEAF_PROTOCOL_TEST_EXPECTED);
const finish = async (result) => {
  await writeFile(process.env.FRAMELEAF_PROTOCOL_TEST_RESULT, JSON.stringify(result), { mode: 0o600 });
  process.exit(0);
};
originalOn.call(process, 'unhandledRejection', async (error) => {
  if (error !== boundary) return finish({ cacheReached: false });
  try {
    const { ConfigRepository } = await import(process.env.FRAMELEAF_PROTOCOL_TEST_CONFIG);
    const config = new ConfigRepository();
    const first = config.getEnv();
    await finish({
      cacheReached: true,
      cacheStable: config.getEnv() === first,
      portMatches: first.port === expected.port,
      identityPreserved: first.frameleafCloud.identityDir === expected.identityDir,
      securityPreserved: process.env.FRAMELEAF_EDGE_SECRET === expected.edgeSecret,
      linkInert: process.env.FRAMELEAF_LINK_TOKEN === undefined,
      entitlementInert: process.env.FRAMELEAF_LICENSE_EXTRA_JWKS_FILE === undefined,
    });
  } catch {
    await finish({ cacheReached: false });
  }
});
process.on = function (event, ...args) {
  if (event === 'SIGTERM' && process.title === 'frameleaf') throw boundary;
  return originalOn.call(this, event, ...args);
};
`;

const observeMain = async (root, identityDir, binding, port) => {
  const resultFile = join(root, randomUUID() + '.json');
  const edgeSecret = randomBytes(24).toString('base64url');
  const child = spawn(process.execPath, ['--import', join(root, 'observer.mjs'), join(server, 'dist/main.js')], {
    cwd: server,
    env: {
      PATH: dirname(process.execPath),
      FRAMELEAF_ENV: 'production',
      FRAMELEAF_PORT: '2283',
      FRAMELEAF_IDENTITY_DIR: identityDir,
      FRAMELEAF_MEDIA_LOCATION: join(root, 'media'),
      FRAMELEAF_EDGE_SECRET: edgeSecret,
      DB_HOSTNAME: '127.0.0.1',
      DB_PORT: '1',
      DB_DATABASE_NAME: 'replacement_local',
      DB_USERNAME: 'replacement_local',
      DB_PASSWORD: randomBytes(24).toString('base64url'),
      REDIS_HOSTNAME: '127.0.0.1',
      REDIS_PORT: '1',
      REDIS_PASSWORD: randomBytes(24).toString('base64url'),
      FRAMELEAF_PROTOCOL_TEST_RESULT: resultFile,
      FRAMELEAF_PROTOCOL_TEST_CONFIG: pathToFileURL(join(server, 'dist/repositories/config.repository.js')).href,
      FRAMELEAF_PROTOCOL_TEST_EXPECTED: JSON.stringify({ identityDir, edgeSecret, port }),
      ...(binding ? { FRAMELEAF_BUDDY_BOOT_BINDING_FILE: binding } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Retain only the existing main's sanitized refusal category, never raw output.
  let explicitRefusal = false;
  let stderrTail = '';
  child.stderr.on('data', (bytes) => {
    stderrTail = (stderrTail + bytes.toString()).slice(-256);
    explicitRefusal ||= stderrTail.includes('Frameleaf startup configuration could not be validated');
  });
  const outcome = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ timedOut: true });
    }, 30_000);
    child.once('error', () => {
      clearTimeout(timeout);
      resolve({ spawnFailed: true });
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
  });
  assert(!outcome.timedOut && !outcome.spawnFailed, 'Compiled main setup must terminate at the bounded observer');
  let result = { cacheReached: false };
  try {
    result = JSON.parse(await readFile(resultFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { code: outcome.code, explicitRefusal, ...result };
};

const assertCache = (result) => {
  assert.equal(result.code, 0, 'Existing compiled application graph must reach the observation boundary');
  for (const key of [
    'cacheReached',
    'cacheStable',
    'portMatches',
    'identityPreserved',
    'securityPreserved',
    'linkInert',
    'entitlementInert',
  ])
    assert.equal(result[key], true, 'Compiled cache and replacement-local security control failed');
};

test('compiled main admits a replacement-local v2 dependency grant before the first cache', async () => {
  for (const name of [
    'main.js',
    'repositories/config.repository.js',
    'utils/buddy-boot-binding.js',
    'utils/buddy-boot-configuration.js',
    'utils/buddy-backup-crypto.js',
    'utils/buddy-backup-vault.js',
    'utils/buddy-backup-offline.js',
    'utils/buddy-backup-recovery.js',
  ])
    assert((await lstat(join(server, 'dist', name))).isFile(), 'Hosted compiled distribution prerequisite missing');
  const { captureBuddyBootConfiguration } = await import('../../dist/utils/buddy-boot-configuration.js');
  const { buddyObjectId, encryptBuddyBlock } = await import('../../dist/utils/buddy-backup-crypto.js');
  const { BuddyVault, buddySnapshotBytes, writeBuddyFile } = await import('../../dist/utils/buddy-backup-vault.js');
  const { buddyBackupCommand } = await import('../../dist/utils/buddy-backup-offline.js');
  const { BuddyRecoveryFiles, readBuddyRecovery } = await import('../../dist/utils/buddy-backup-recovery.js');
  const { finalizeBuddyBootBinding } = await import('../../dist/utils/buddy-boot-binding.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-protocol-')));
  try {
    await chmod(root, 0o700);
    const recoveryId = randomUUID();
    const snapshotId = randomUUID();
    const vaultId = randomUUID();
    const source = join(root, 'source');
    const identityDir = join(root, 'identity');
    const recoveryDirectory = join(root, 'recovery', recoveryId);
    for (const directory of [source, identityDir, join(root, 'media')]) await mkdir(directory, { mode: 0o700 });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeBuddyFile(join(identityDir, 'instance-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const jwk = publicKey.export({ format: 'jwk' });
    const replacementIdentity = createHash('sha256')
      .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
      .digest('base64url');
    const values = {
      FRAMELEAF_PORT: '2391',
      DB_HOSTNAME: '127.0.0.1',
      DB_PORT: '1',
      DB_DATABASE_NAME: 'selected_database',
      DB_USERNAME: 'selected_role',
      DB_PASSWORD: randomBytes(24).toString('base64url'),
      REDIS_HOSTNAME: '127.0.0.1',
      REDIS_PORT: '1',
      REDIS_DBINDEX: '3',
      REDIS_USERNAME: 'selected_acl',
      REDIS_PASSWORD: randomBytes(24).toString('base64url'),
      FRAMELEAF_EDGE_SECRET: randomBytes(24).toString('base64url'),
      FRAMELEAF_LINK_TOKEN: 'fll_' + randomBytes(24).toString('base64url'),
      FRAMELEAF_LICENSE_EXTRA_JWKS_FILE: join(source, 'historical-entitlement.json'),
      FRAMELEAF_IDENTITY_DIR: join(source, 'historical-identity'),
    };
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    let configuration;
    try {
      Object.assign(process.env, values);
      configuration = captureBuddyBootConfiguration({ version: 1, environmentKeys: Object.keys(values) });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.equal(configuration.entries.find((entry) => entry.key === 'FRAMELEAF_PORT').value, 2391);
    assert.equal(configuration.entries.find((entry) => entry.key === 'REDIS_DBINDEX').value, 3);
    const published = Buffer.from(JSON.stringify({ selected: ['FRAMELEAF_PORT'] }));
    const file = { path: join(source, 'settings.json'), sha256: digest(published), size: published.length };
    await writeBuddyFile(file.path, published);
    const key = randomBytes(32);
    const object = buddyObjectId(key, vaultId, published);
    const manifest = {
      version: 1,
      vaultId,
      snapshotId,
      sequence: 1,
      previous: null,
      frameleafVersion: 'protocol-fixture',
      library: { version: 2, assets: {}, database: null },
      contents: { [file.sha256]: { blocks: [object], bytes: published.length, keyVersion: 1 } },
      assetLinks: {},
      assetFiles: {},
      dependencies: [],
      configurationFiles: [file],
      environment: { FRAMELEAF_PORT: '2491' },
      bootConfiguration: configuration,
      storageRoot: source,
      storageRoots: [source],
      settings: { system: {}, fork: [], users: [] },
    };
    const encoded = Buffer.from(JSON.stringify(manifest));
    const manifestId = buddyObjectId(key, vaultId, encoded);
    const vaultRoot = join(root, 'source-vault');
    const vault = new BuddyVault(vaultRoot, vaultId);
    const capacity = { quotaBytes: 100_000, freeBytes: 100e9, totalBytes: 200e9 };
    const receipts = [];
    for (const [id, bytes] of [
      [object, published],
      [manifestId, encoded],
    ]) {
      const ciphertext = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, bytes);
      assert(!ciphertext.includes(bytes), 'Fixture must carry encrypted source objects');
      const receipt = BuddyVault.receipt(id, ciphertext);
      await vault.put(receipt, ciphertext, capacity);
      receipts.push(receipt);
    }
    const now = Date.now();
    const sourceSigner = generateKeyPairSync('ed25519');
    assert(
      sourceSigner.publicKey.export({ format: 'jwk' }).x !== jwk.x,
      'Replacement identity must differ from the source snapshot signer',
    );
    const snapshot = {
      version: 1,
      vaultId,
      id: snapshotId,
      sequence: 1,
      previous: null,
      keyVersion: 1,
      createdAt: new Date(now).toISOString(),
      retainUntil: new Date(now + 31 * 86400_000).toISOString(),
      objects: receipts,
      manifest: [manifestId],
    };
    await vault.commit(
      {
        snapshot,
        signature: sign(null, buddySnapshotBytes(snapshot), sourceSigner.privateKey).toString('base64url'),
      },
      sourceSigner.publicKey.export({ format: 'jwk' }),
      now,
      capacity,
    );
    const kit = join(root, 'kit.json');
    await writeBuddyFile(
      kit,
      JSON.stringify({ version: 1, vaultId, current: 1, keys: { 1: key.toString('base64url') } }),
    );
    const exported = join(root, 'export');
    await buddyBackupCommand(['export', '--vault', join(vaultRoot, vaultId), '--output', exported]);
    await rm(source, { recursive: true });
    await rm(vaultRoot, { recursive: true });
    await buddyBackupCommand([
      'recover',
      '--vault',
      join(exported, vaultId),
      '--kit',
      kit,
      '--output',
      recoveryDirectory,
    ]);
    await assert.rejects(readFile(file.path), { code: 'ENOENT' });
    const recovered = JSON.parse(await readFile(join(recoveryDirectory, 'manifest.json'), 'utf8'));
    assert(
      JSON.stringify(recovered.bootConfiguration) === JSON.stringify(configuration),
      'Encrypted offline reader must preserve typed capture',
    );
    const completion = JSON.parse(await readFile(join(recoveryDirectory, 'recovery-complete.json'), 'utf8'));
    assert.equal(completion.snapshotId, snapshotId);
    assert.equal(completion.vaultId, vaultId);
    await mkdir(source, { mode: 0o700 }); // Explicit replacement-local configuration allowlist, not source reuse.
    const plan = { version: 1, scope: 'settings', mode: 'replace', manifest: recovered, files: [file] };
    const prepared = Buffer.from(JSON.stringify(plan));
    await writeBuddyFile(join(recoveryDirectory, 'prepared.json'), prepared);
    let fenceHeld = true;
    const fenceEpoch = randomUUID();
    let fenceChecks = 0;
    const fence = async () => {
      assert(fenceHeld, 'Publication fixture fence was lost');
      fenceChecks++;
    };
    const files = new BuddyRecoveryFiles(root, recoveryId, fence);
    await files.publish(await readBuddyRecovery(root, recoveryId), [], [file.path]);
    await files.verify(plan, [], [file.path]);
    await files.state('complete');
    assert((await readFile(file.path)).equals(published), 'Actual publication prerequisite failed');
    assert.equal(await files.load(), 'complete');
    const common = {
      version: 1,
      state: 'request',
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
    };
    const binding = join(identityDir, 'buddy-boot-binding.json');
    await writeBuddyFile(binding, JSON.stringify(common));
    const marker = join(identityDir, 'buddy', 'recovery-active.json');
    await writeBuddyFile(
      marker,
      JSON.stringify({ isMaintenanceMode: true, secret: randomUUID(), action: { buddyRecoveryId: recoveryId } }),
    );
    const localEnvironment = {
      FRAMELEAF_IDENTITY_DIR: identityDir,
      FRAMELEAF_BUDDY_BOOT_BINDING_FILE: binding,
    };
    const previousLocal = Object.fromEntries(Object.keys(localEnvironment).map((name) => [name, process.env[name]]));
    try {
      Object.assign(process.env, localEnvironment);
      await finalizeBuddyBootBinding(root, recoveryId, fence);
    } finally {
      for (const [name, value] of Object.entries(previousLocal)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert(fenceChecks >= 3, 'Actual publication and readiness must assert the fixture fence');
    await rm(marker);
    const v1 = JSON.parse(await readFile(binding, 'utf8'));
    assert.equal(v1.state, 'ready');
    await writeFile(join(root, 'observer.mjs'), observer, { mode: 0o600 });
    assertCache(await observeMain(root, identityDir, undefined, 2283));
    assertCache(await observeMain(root, identityDir, binding, 2391));
    for (const environmentKeys of [
      ['DB_PASSWORD'],
      ['REDIS_PASSWORD'],
      ['FRAMELEAF_EDGE_SECRET'],
      ['FRAMELEAF_LINK_TOKEN'],
    ]) {
      await writeBuddyFile(binding, JSON.stringify({ ...v1, environmentKeys }));
      const refused = await observeMain(root, identityDir, binding, 2391);
      assert.equal(refused.code, 1, 'V1 dependency/security input must remain refused');
      assert.equal(refused.explicitRefusal, true);
      assert.equal(refused.cacheReached, false, 'V1 dependency refusal must precede application cache');
    }
    const selected = ['DB_HOSTNAME', 'DB_PORT', 'DB_DATABASE_NAME', 'DB_USERNAME', 'DB_PASSWORD'];
    const cacheSelected = ['REDIS_HOSTNAME', 'REDIS_PORT', 'REDIS_DBINDEX', 'REDIS_USERNAME', 'REDIS_PASSWORD'];
    const publicationDigest = digest(await readFile(join(recoveryDirectory, 'publication.json')));
    // Proposed v2 protocol fixture. Registration/challenge/readiness are authored
    // local actor records, NOT observations of a live service or consumer clients.
    const dependencyGrants = [
      ['postgres', selected],
      ['valkey', cacheSelected],
    ].map(([dependency, environmentKeys]) => {
      const grantId = randomUUID();
      const requestNonce = randomBytes(24).toString('base64url');
      const revision = randomUUID();
      const registration = {
        version: 1,
        dependency,
        kind: 'standalone',
        registrationId: randomUUID(),
        revision,
        replacementIdentity,
        transport: 'tcp',
        hostname: '127.0.0.1',
        port: 1,
        tls: 'disabled',
      };
      const request = {
        version: 1,
        grantId,
        dependency,
        profile: 'verify-existing',
        profileVersion: 1,
        connectionMode: 'parts',
        environmentKeys,
        sourceBindings: environmentKeys.map((key) => ({ key, source: 'environment' })),
        requestNonce,
        priorConfigurationRevision: randomUUID(),
        registration,
        recoveryId,
        snapshotId,
        vaultId,
        replacementIdentity,
        artifactDigest: common.artifactDigest,
        preparedDigest: common.preparedDigest,
      };
      const receipt = {
        version: 1,
        state: 'eligible',
        grantId,
        requestDigest: digest(Buffer.from(JSON.stringify(request))),
        requestNonce,
        registrationId: registration.registrationId,
        serviceRevision: revision,
        replacementIdentity,
        recoveryId,
        snapshotId,
        vaultId,
        artifactDigest: common.artifactDigest,
        preparedDigest: common.preparedDigest,
        publicationDigest,
        sourceRevision: randomUUID(),
        publicationFence: { recoveryId, epoch: fenceEpoch, replacementIdentity },
        challenge: { replacementIdentity, requestNonce, serviceRevision: revision },
        journal: ['requested', 'validated', 'service-prepared', 'files-prepared', 'verified', 'eligible'],
      };
      const bytes = Buffer.from(JSON.stringify(receipt));
      const signature = sign(null, bytes, privateKey).toString('base64url');
      assert(
        verify(null, bytes, publicKey, Buffer.from(signature, 'base64url')),
        'Local protocol signature prerequisite failed',
      );
      return { request, receipt, signature };
    });
    const v2 = {
      ...v1,
      version: 2,
      environmentKeys: ['FRAMELEAF_PORT', ...selected, ...cacheSelected],
      dependencyGrants,
    };
    await writeBuddyFile(binding, JSON.stringify(v2), false, fence);
    for (const name of [
      binding,
      join(identityDir, 'instance-key.pem'),
      join(recoveryDirectory, 'boot-configuration.json'),
      join(recoveryDirectory, 'prepared.json'),
      join(recoveryDirectory, 'publication.json'),
    ]) {
      const metadata = await lstat(name);
      assert(metadata.isFile() && (metadata.mode & 0o777) === 0o600, 'Private fixture authority prerequisite failed');
    }
    const admitted = await observeMain(root, identityDir, binding, 2391);
    // ONLY this final admission assertion can establish the intended protocol RED.
    // Setup failures, v1 refusal or service/client setup are not consumer RED.
    assert.equal(
      admitted.explicitRefusal,
      false,
      'Reviewed v2 dependency protocol must be admitted before application cache',
    );
    assertCache(admitted);
    fenceHeld = false;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
