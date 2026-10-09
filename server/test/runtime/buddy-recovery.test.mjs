import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BuddyRecoveryFiles, buddyRecoveryTarget, readBuddyRecovery } from '../../dist/utils/buddy-backup-recovery.js';
import { buddyBackupCommand } from '../../dist/utils/buddy-backup-offline.js';
import { buddyObjectId, encryptBuddyBlock } from '../../dist/utils/buddy-backup-crypto.js';
import { BuddyVault, buddySnapshotBytes } from '../../dist/utils/buddy-backup-vault.js';

test('recovery verifies before publishing, preserves overwritten files, resumes and rolls back', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-apply-')));
  try {
    const id = randomUUID();
    const source = Buffer.from('backed up version');
    const old = Buffer.from('current version');
    const sha256 = createHash('sha256').update(source).digest('hex');
    const target = join(root, 'media', 'photo.jpg');
    await mkdir(join(root, 'media'));
    await writeFile(target, old);
    const stage = join(root, 'recovery', id, 'objects');
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, sha256), source);
    const plan = { version: 1, scope: 'server', mode: 'keep', files: [{ path: target, sha256, size: source.length }] };
    await assert.rejects(new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []), /newer content/);
    assert.deepEqual(await readFile(target), old);
    const absent = join(root, 'media', 'missing.jpg');
    await assert.rejects(
      new BuddyRecoveryFiles(root, id).publish(
        { ...plan, files: [{ ...plan.files[0], path: absent }, ...plan.files] },
        [join(root, 'media')],
        [],
      ),
      /newer content/,
    );
    await assert.rejects(readFile(absent), { code: 'ENOENT' });
    await assert.rejects(
      new BuddyRecoveryFiles(root, id).publish(
        { ...plan, files: [...plan.files, { ...plan.files[0], size: 1 }] },
        [join(root, 'media')],
        [],
      ),
      /Conflicting/,
    );
    plan.mode = 'replace';
    await new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []);
    await new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []);
    assert.deepEqual(await readFile(target), source);
    assert.deepEqual(await readFile(`${target}.buddy-rollback-${id}`), old);
    await new BuddyRecoveryFiles(root, id).rollback([join(root, 'media')], []);
    assert.deepEqual(await readFile(target), old);
    const second = randomUUID();
    const bad = join(root, 'recovery', second, 'objects');
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, sha256), 'damaged');
    await assert.rejects(new BuddyRecoveryFiles(root, second).publish(plan, [join(root, 'media')], []), /verification/);
    assert.deepEqual(await readFile(target), old);
    await symlink(root, join(root, 'media', 'link'));
    await assert.rejects(
      buddyRecoveryTarget(join(root, 'media', 'link', 'secret'), [join(root, 'media')], []),
      /Unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an encrypted export plus kit performs offline recovery with no database or Cloud', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buddy-offline-'));
  try {
    const vaultId = randomUUID();
    const snapshotId = randomUUID();
    const key = randomBytes(32);
    const vault = new BuddyVault(root, vaultId);
    const data = Buffer.from('offline original');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const object = buddyObjectId(key, vaultId, data);
    const manifest = {
      version: 1,
      vaultId,
      snapshotId,
      sequence: 1,
      previous: null,
      library: { version: 2, assets: {}, database: null },
      contents: { [sha256]: { blocks: [object], bytes: data.length, keyVersion: 1 } },
    };
    const metadata = Buffer.from(JSON.stringify(manifest));
    const manifestId = buddyObjectId(key, vaultId, metadata);
    const capacity = { quotaBytes: 100_000, freeBytes: 100e9, totalBytes: 200e9 };
    const receipts = [];
    for (const [id, bytes] of [
      [object, data],
      [manifestId, metadata],
    ]) {
      const sealed = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, bytes);
      const receipt = BuddyVault.receipt(id, sealed);
      await vault.put(receipt, sealed, capacity);
      receipts.push(receipt);
    }
    const now = Date.now();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
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
      { snapshot, signature: sign(null, buddySnapshotBytes(snapshot), privateKey).toString('base64url') },
      publicKey.export({ format: 'jwk' }),
      now,
      capacity,
    );
    const kit = join(root, 'kit.json');
    await writeFile(kit, JSON.stringify({ version: 1, vaultId, current: 1, keys: { 1: key.toString('base64url') } }));
    const exported = join(root, 'export');
    await buddyBackupCommand(['export', '--vault', join(root, vaultId), '--output', exported]);
    assert.deepEqual(JSON.parse(await readFile(join(exported, 'export-complete.json'), 'utf8')), { version: 1, vaultId });
    await rm(join(root, vaultId), { recursive: true });
    const wrongKit = join(root, 'wrong-kit.json');
    await writeFile(
      wrongKit,
      JSON.stringify({ version: 1, vaultId, current: 1, keys: { 1: randomBytes(32).toString('base64url') } }),
    );
    const wrongOutput = join(root, 'wrong-key');
    await assert.rejects(
      buddyBackupCommand(['recover', '--vault', join(exported, vaultId), '--kit', wrongKit, '--output', wrongOutput]),
    );
    await assert.rejects(readFile(join(wrongOutput, 'recovery-complete.json')), { code: 'ENOENT' });
    const ciphertextPath = join(exported, vaultId, 'objects', object.slice(0, 2), object);
    const ciphertext = await readFile(ciphertextPath);
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 1;
    await writeFile(ciphertextPath, tampered);
    const tamperedOutput = join(root, 'tampered');
    await assert.rejects(
      buddyBackupCommand(['recover', '--vault', join(exported, vaultId), '--kit', kit, '--output', tamperedOutput]),
      /ciphertext failed verification/,
    );
    await assert.rejects(readFile(join(tamperedOutput, 'recovery-complete.json')), { code: 'ENOENT' });
    await writeFile(ciphertextPath, ciphertext);
    const restored = join(root, 'restored');
    // A fresh Node process has no application alias loader or running server context.
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const { buddyBackupCommand } = await import(${JSON.stringify(new URL('../../dist/utils/buddy-backup-offline.js', import.meta.url).href)}); await buddyBackupCommand(process.argv.slice(1));`,
        'recover',
        '--vault',
        join(exported, vaultId),
        '--kit',
        kit,
        '--output',
        restored,
      ],
      { env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000 },
    );
    assert.deepEqual(await readFile(join(restored, 'objects', sha256)), data);
    assert.deepEqual(JSON.parse(await readFile(join(restored, 'manifest.json'), 'utf8')), manifest);
    assert.equal(JSON.parse(await readFile(join(restored, 'recovery-complete.json'), 'utf8')).snapshotId, snapshotId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline recovery stages a database-backed replacement without publishing historical paths', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-offline-replacement-')));
  try {
    const vaultId = randomUUID();
    const snapshotId = randomUUID();
    const instanceId = randomUUID();
    const ownerId = randomUUID();
    const assetId = randomUUID();
    const key = randomBytes(32);
    const source = join(root, 'original-server');
    const mediaRoot = join(source, 'media');
    const configurationRoot = join(source, 'config');
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(configurationRoot);
    const environmentSecret = randomBytes(32).toString('base64url');
    const storedKey = randomBytes(32);
    // Stored Cloud Backup keys use the existing FNV display fingerprint, not a SHA-256 digest.
    let fingerprintHash = 0x81_1c_9d_c5;
    for (const byte of storedKey) fingerprintHash = Math.imul(fingerprintHash ^ byte, 0x01_00_01_93) >>> 0;
    const fingerprintHex = fingerprintHash.toString(16).padStart(8, '0').toUpperCase();
    const storedKeyFingerprint = `${fingerprintHex.slice(0, 4)}-${fingerprintHex.slice(4)}`;
    const files = [
      { role: 'original', path: join(mediaRoot, 'photo.jpg'), bytes: Buffer.from('replacement original') },
      { role: 'profile', path: join(mediaRoot, 'profile.jpg'), bytes: Buffer.from('replacement profile') },
      {
        role: 'configuration',
        path: join(configurationRoot, 'frameleaf.json'),
        bytes: Buffer.from(JSON.stringify({ syntheticSecret: environmentSecret })),
      },
      {
        role: 'project',
        path: join(mediaRoot, 'project-dependency.svg'),
        bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>'),
      },
    ];
    const databaseText =
      '-- PostgreSQL database dump\nCREATE TABLE recovery_fixture (id integer PRIMARY KEY);\nINSERT INTO recovery_fixture VALUES (42);\n';
    const database = gzipSync(Buffer.from(databaseText));
    const databaseSha256 = createHash('sha256').update(database).digest('hex');
    const contents = {};
    const blocks = [];
    const inventory = [];
    for (const file of files) {
      await writeFile(file.path, file.bytes);
      const sha256 = createHash('sha256').update(file.bytes).digest('hex');
      const id = buddyObjectId(key, vaultId, file.bytes);
      inventory.push({ role: file.role, path: file.path, sha256, size: file.bytes.length, mtime: null });
      contents[sha256] = { blocks: [id], bytes: file.bytes.length, keyVersion: 1 };
      blocks.push([id, file.bytes]);
    }
    await writeFile(join(source, 'database.sql.gz'), database);
    const databaseId = buddyObjectId(key, vaultId, database);
    contents[databaseSha256] = { blocks: [databaseId], bytes: database.length, keyVersion: 1 };
    blocks.push([databaseId, database]);
    const manifest = {
      version: 1,
      vaultId,
      snapshotId,
      sequence: 1,
      previous: null,
      frameleafVersion: '2.0.0',
      storageRoot: mediaRoot,
      storageRoots: [mediaRoot],
      environment: { FRAMELEAF_TEST_SECRET: environmentSecret },
      settings: {
        system: { theme: 'dark' },
        fork: [{ key: 'recovery-fixture', value: { enabled: true } }],
        users: [{ userId: ownerId, key: 'preferences', value: { download: { archive: true } } }],
      },
      cloudBackupKeys: [
        {
          fingerprint: storedKeyFingerprint,
          content: JSON.stringify({
            format: 'frameleaf-backup-key',
            version: 1,
            algorithm: 'AES256 (SSE-C)',
            instanceId,
            bucket: 'fixture',
            mode: 'server',
            fingerprint: storedKeyFingerprint,
            key: storedKey.toString('base64'),
            createdAt: '2026-10-03T00:00:00.000Z',
          }),
        },
      ],
      assetLinks: { [assetId]: { livePhotoVideoId: null, libraryId: null, isExternal: false } },
      assetFiles: {},
      dependencies: [inventory[3]],
      configurationFiles: [inventory[2]],
      library: {
        format: 'frameleaf-backup-manifest',
        version: 2,
        instanceId,
        createdAt: '2026-10-03T00:00:00.000Z',
        database: { key: 'frameleaf-db-backup-fixture.sql.gz', sha256: databaseSha256, size: database.length },
        assets: {
          [assetId]: {
            owner: ownerId,
            files: [inventory[0]],
            type: 'IMAGE',
            originalFileName: 'photo.jpg',
            fileCreatedAt: '2026-10-03T00:00:00.000Z',
            fileModifiedAt: '2026-10-03T00:00:00.000Z',
            localDateTime: '2026-10-03T00:00:00.000Z',
            duration: null,
          },
        },
        profiles: { [ownerId]: inventory[1] },
        albums: {},
        people: {},
      },
      contents,
    };
    const encoded = Buffer.from(JSON.stringify(manifest));
    const manifestId = buddyObjectId(key, vaultId, encoded);
    blocks.push([manifestId, encoded]);
    const vaultRoot = join(root, 'original-vault');
    const vault = new BuddyVault(vaultRoot, vaultId);
    const capacity = { quotaBytes: 100_000, freeBytes: 100e9, totalBytes: 200e9 };
    const receipts = [];
    for (const [id, bytes] of blocks) {
      const sealed = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, bytes);
      const receipt = BuddyVault.receipt(id, sealed);
      await vault.put(receipt, sealed, capacity);
      receipts.push(receipt);
    }
    const now = Date.now();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
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
      { snapshot, signature: sign(null, buddySnapshotBytes(snapshot), privateKey).toString('base64url') },
      publicKey.export({ format: 'jwk' }),
      now,
      capacity,
    );
    const kit = join(root, 'independent-kit.json');
    await writeFile(kit, JSON.stringify({ version: 1, vaultId, current: 1, keys: { 1: key.toString('base64url') } }));
    const exported = join(root, 'export');
    await buddyBackupCommand(['export', '--vault', join(vaultRoot, vaultId), '--output', exported]);
    await rm(vaultRoot, { recursive: true });
    await rm(source, { recursive: true });
    // The replacement reattaches explicit original mounts; it does not inherit server identity.
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(configurationRoot);
    const replacementIdentity = join(root, 'replacement-identity');
    await mkdir(replacementIdentity);
    const identityPath = join(replacementIdentity, 'instance-key.pem');
    const identity = randomBytes(32);
    await writeFile(identityPath, identity);
    const output = join(root, 'offline-recovery');
    await buddyBackupCommand(['recover', '--vault', join(exported, vaultId), '--kit', kit, '--output', output]);
    for (const file of files) await assert.rejects(readFile(file.path), { code: 'ENOENT' });
    assert.ok((await readFile(identityPath)).equals(identity), 'offline staging must preserve replacement identity');
    // Consume the real maintenance staging contract; an extraction-only manifest is insufficient.
    const plan = await readBuddyRecovery(output, snapshotId);
    assert.equal(plan.scope, 'server');
    assert.equal(plan.mode, 'keep');
    assert.deepEqual(plan.files.map((file) => file.path).sort(), files.map((file) => file.path).sort());
    const stagedDatabase = await readFile(join(output, 'recovery', snapshotId, 'database.sql.gz'));
    assert.equal(createHash('sha256').update(stagedDatabase).digest('hex'), databaseSha256);
    assert.equal(gunzipSync(stagedDatabase).toString(), databaseText);
    assert.ok(
      plan.manifest.environment.FRAMELEAF_TEST_SECRET === environmentSecret,
      'environment reference must survive privately',
    );
    assert.ok(
      plan.manifest.cloudBackupKeys[0].content === manifest.cloudBackupKeys[0].content,
      'stored recovery key must survive privately',
    );
    assert.deepEqual(plan.manifest.settings, manifest.settings);
    const configuration = [files[2].path];
    const publisher = new BuddyRecoveryFiles(output, snapshotId);
    const forbiddenPlan = { ...plan, files: [{ ...inventory[0], path: identityPath }] };
    await assert.rejects(publisher.publish(forbiddenPlan, [mediaRoot], configuration), /configured storage mounts/);
    assert.ok((await readFile(identityPath)).equals(identity), 'foreign identity destination must remain unchanged');
    await symlink(replacementIdentity, join(mediaRoot, 'alias'));
    await assert.rejects(
      publisher.publish(
        { ...plan, files: [{ ...inventory[0], path: join(mediaRoot, 'alias', 'instance-key.pem') }] },
        [mediaRoot],
        configuration,
      ),
      /Unsafe/,
    );
    const stagedObject = join(output, 'recovery', snapshotId, 'objects', inventory[3].sha256);
    await writeFile(stagedObject, 'tampered staged dependency');
    await assert.rejects(publisher.publish(plan, [mediaRoot], configuration), /verification/);
    for (const file of files) await assert.rejects(readFile(file.path), { code: 'ENOENT' });
    await writeFile(stagedObject, files[3].bytes);
    await assert.rejects(
      new BuddyRecoveryFiles(output, snapshotId, async () => {
        throw new Error('lost maintenance fence');
      }).publish(plan, [mediaRoot], configuration),
      /lost maintenance fence/,
    );
    await writeFile(files[0].path, 'replacement has newer media');
    await assert.rejects(publisher.publish(plan, [mediaRoot], configuration), /newer content/);
    assert.equal(await readFile(files[0].path, 'utf8'), 'replacement has newer media');
    for (const file of files.slice(1)) await assert.rejects(readFile(file.path), { code: 'ENOENT' });
    await rm(files[0].path);
    await publisher.publish(plan, [mediaRoot], configuration);
    await new BuddyRecoveryFiles(output, snapshotId).verify(plan, [mediaRoot], configuration);
    for (const file of files)
      assert.ok((await readFile(file.path)).equals(file.bytes), 'published file must match verified backup bytes');
    assert.ok(
      (await readFile(identityPath)).equals(identity),
      'explicit publication must preserve replacement identity',
    );
    assert.ok(
      process.env.FRAMELEAF_TEST_SECRET !== environmentSecret,
      'historical environment must not be applied by offline recovery',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completed publication re-verifies targets and keeps per-file recovery writes bounded', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-resume-')));
  try {
    const id = randomUUID();
    const data = Buffer.from('original');
    const sha256 = createHash('sha256').update(data).digest('hex');
    const directory = join(root, 'recovery', id);
    await mkdir(join(directory, 'objects'), { recursive: true });
    await mkdir(join(root, 'media'));
    await writeFile(join(directory, 'objects', sha256), data);
    const plan = {
      version: 1,
      scope: 'server',
      mode: 'replace',
      files: Array.from({ length: 64 }, (_, n) => ({
        path: join(root, 'media', `${n}.jpg`),
        sha256,
        size: data.length,
      })),
    };
    const files = new BuddyRecoveryFiles(root, id);
    await files.publish(plan, [join(root, 'media')], []);
    await files.state('complete');
    assert.ok((await readFile(join(directory, 'publication.json'))).length < 128);
    const entries = await readdir(join(directory, 'publications'), { recursive: true });
    assert.equal(entries.filter((name) => /^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(name)).length, 64);
    await new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []);
    await writeFile(plan.files[0].path, 'tampered');
    await assert.rejects(new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []), /integrity/);
    await rm(plan.files[0].path);
    await assert.rejects(new BuddyRecoveryFiles(root, id).publish(plan, [join(root, 'media')], []), { code: 'ENOENT' });
    const fenced = new BuddyRecoveryFiles(root, randomUUID(), async () => {
      throw new Error('lost lock');
    });
    await assert.rejects(fenced.publish(plan, [join(root, 'media')], []), /lost lock/);
    assert.deepEqual(await readFile(plan.files[1].path), data);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
