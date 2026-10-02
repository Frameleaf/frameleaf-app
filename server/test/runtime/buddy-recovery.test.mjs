import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BuddyRecoveryFiles, buddyRecoveryTarget } from '../../src/utils/buddy-backup-recovery.ts';
import { buddyBackupCommand } from '../../src/utils/buddy-backup-offline.ts';
import { buddyObjectId, encryptBuddyBlock } from '../../src/utils/buddy-backup-crypto.ts';
import { BuddyVault, buddySnapshotBytes } from '../../src/utils/buddy-backup-vault.ts';

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
    await rm(join(root, vaultId), { recursive: true });
    const restored = join(root, 'restored');
    await buddyBackupCommand(['recover', '--vault', join(exported, vaultId), '--kit', kit, '--output', restored]);
    assert.deepEqual(await readFile(join(restored, 'objects', sha256)), data);
    assert.equal(JSON.parse(await readFile(join(restored, 'recovery-complete.json'), 'utf8')).snapshotId, snapshotId);
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
