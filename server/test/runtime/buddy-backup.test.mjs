import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buddyObjectId, decryptBuddyBlock, encryptBuddyBlock } from '../../src/utils/buddy-backup-crypto.ts';
import { BuddyVault, buddySnapshotBytes } from '../../src/utils/buddy-backup-vault.ts';
import { BuddyBackupReader } from '../../src/utils/buddy-backup-reader.ts';

test('Buddy records hide plaintext, authenticate their vault, identity and version, and reject tampering', () => {
  const key = randomBytes(32);
  const vaultId = randomUUID();
  const plaintext = Buffer.from('private-photo.jpg: private album and image bytes');
  const id = buddyObjectId(key, vaultId, plaintext);
  const context = { vaultId, id, keyVersion: 1 };
  const encrypted = encryptBuddyBlock(key, context, plaintext);
  assert(!encrypted.includes(plaintext));
  assert.deepEqual(decryptBuddyBlock(key, context, encrypted), plaintext);
  assert.notDeepEqual(encryptBuddyBlock(key, context, plaintext), encrypted);
  assert.deepEqual(encryptBuddyBlock(key, context, plaintext, encrypted.subarray(0, 12)), encrypted);
  assert.notEqual(buddyObjectId(key, randomUUID(), plaintext), id);
  assert.throws(() => decryptBuddyBlock(randomBytes(32), context, encrypted));
  assert.throws(() => decryptBuddyBlock(key, { ...context, vaultId: randomUUID() }, encrypted));
  assert.throws(() => decryptBuddyBlock(key, { ...context, keyVersion: 2 }, encrypted));
  assert.throws(() => decryptBuddyBlock(key, { ...context, id: 'a'.repeat(64) }, encrypted));
  encrypted[20] ^= 1;
  assert.throws(() => decryptBuddyBlock(key, context, encrypted));
});

test('expiry or learned revocation at the publication boundary leaves no committed object', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-expiry-'));
  try {
    const vault = new BuddyVault(directory, randomUUID());
    const bytes = randomBytes(100);
    const receipt = BuddyVault.receipt('d'.repeat(64), bytes);
    const capacity = { quotaBytes: 10_000, freeBytes: 100e9, totalBytes: 200e9 };
    await vault.reserve(receipt, capacity);
    await assert.rejects(
      vault.put(receipt, bytes, capacity, async () => {
        throw new Error('revoked');
      }),
      /revoked/,
    );
    assert.deepEqual(await vault.inventory([receipt.id]), []);
    assert.equal((await vault.usage()).reservedBytes, bytes.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('vault plus recovery kit restores verified files without the source index and rejects snapshot substitution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-recovery-'));
  try {
    const vaultId = randomUUID();
    const key = randomBytes(32);
    const id = randomUUID();
    const ring = { version: 1, vaultId, current: 1, keys: { 1: key.toString('base64url') } };
    const vault = new BuddyVault(directory, vaultId);
    const plain = Buffer.from('recover this original after losing the source database');
    const sha256 = (await import('node:crypto')).createHash('sha256').update(plain).digest('hex');
    const block = buddyObjectId(key, vaultId, plain);
    const manifest = {
      version: 1,
      vaultId,
      snapshotId: id,
      sequence: 1,
      previous: null,
      library: { version: 2, assets: {} },
      contents: { [sha256]: { blocks: [block], bytes: plain.length, keyVersion: 1 } },
    };
    const metadata = Buffer.from(JSON.stringify(manifest));
    const manifestId = buddyObjectId(key, vaultId, metadata);
    const capacity = { quotaBytes: 10_000, freeBytes: 100e9, totalBytes: 200e9 };
    const receipts = [];
    for (const [object, bytes] of [
      [block, plain],
      [manifestId, metadata],
    ]) {
      const sealed = encryptBuddyBlock(key, { vaultId, id: object, keyVersion: 1 }, bytes);
      const receipt = BuddyVault.receipt(object, sealed);
      receipts.push(receipt);
      await vault.put(receipt, sealed, capacity);
    }
    const envelope = {
      snapshot: {
        version: 1,
        vaultId,
        id,
        sequence: 1,
        previous: null,
        keyVersion: 1,
        manifest: [manifestId],
        objects: receipts,
      },
      signature: '',
    };
    await rm(join(directory, vaultId, 'catalog.json'));
    const recoveredVault = new BuddyVault(directory, vaultId);
    let progress = 0;
    const reader = new BuddyBackupReader(ring, envelope, (id) => recoveredVault.read(id), {
      progress: (bytes) => {
        progress += bytes;
      },
    });
    const decoded = await reader.manifest();
    const target = join(directory, 'restored', 'original');
    await reader.download(decoded, sha256, target);
    assert.deepEqual(await readFile(target), plain);
    assert.equal(progress, plain.length);

    // Cancellation waits for a block transport to close before the reader removes its temporary file.
    const controller = new AbortController();
    let closeTransport;
    let beginDestroy;
    const destroyed = new Promise((resolve) => {
      beginDestroy = resolve;
    });
    const closing = new Promise((resolve) => {
      closeTransport = resolve;
    });
    const source = new PassThrough();
    const sink = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
      destroy(error, done) {
        beginDestroy();
        void closing.then(() => done(error));
      },
    });
    let readStarted;
    const started = new Promise((resolve) => {
      readStarted = resolve;
    });
    const cancelledReader = new BuddyBackupReader(
      ring,
      envelope,
      async () => {
        const transfer = pipeline(source, sink, { signal: controller.signal });
        readStarted();
        await transfer;
        throw new Error('Stalled transport cannot produce a block');
      },
      {
        signal: controller.signal,
        progress: () => {
          throw new Error('Cancelled read reported progress');
        },
      },
    );
    const cancelledTarget = join(directory, 'cancelled', 'original');
    let returned = false;
    const download = cancelledReader.download(decoded, sha256, cancelledTarget).finally(() => {
      returned = true;
    });
    const rejected = assert.rejects(download, { name: 'AbortError' });
    await started;
    controller.abort(new Error('Claim lost'));
    await destroyed;
    assert.equal(returned, false);
    assert.equal((await readdir(join(directory, 'cancelled'))).length, 1);
    closeTransport();
    await rejected;
    assert.deepEqual(await readdir(join(directory, 'cancelled')), []);
    await assert.rejects(readFile(cancelledTarget), { code: 'ENOENT' });
    await assert.rejects(
      new BuddyBackupReader(ring, { ...envelope, snapshot: { ...envelope.snapshot, id: randomUUID() } }, (id) =>
        recoveredVault.read(id),
      ).manifest(),
      /binding/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot commits account for metadata, reject stored corruption and accept immutable lost-ack retries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-snapshot-'));
  try {
    const now = Date.now();
    const vaultId = randomUUID();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const vault = new BuddyVault(directory, vaultId);
    const bytes = randomBytes(100);
    const receipt = BuddyVault.receipt('c'.repeat(64), bytes);
    const capacity = { quotaBytes: 10_000, freeBytes: 100e9, totalBytes: 200e9 };
    await vault.put(receipt, bytes, capacity);
    const snapshot = {
      version: 1,
      vaultId,
      id: randomUUID(),
      sequence: 1,
      previous: null,
      createdAt: new Date(now).toISOString(),
      retainUntil: new Date(now + 31 * 86400_000).toISOString(),
      keyVersion: 1,
      manifest: [receipt.id],
      objects: [receipt],
    };
    const envelope = {
      snapshot,
      signature: sign(null, buddySnapshotBytes(snapshot), privateKey).toString('base64url'),
    };
    await vault.commit(envelope, jwk, now, capacity);
    await vault.commit(envelope, jwk, now + 301_000, capacity);
    assert.equal((await vault.snapshots())[0].id, snapshot.id);
    assert.equal('objects' in (await vault.snapshots())[0], false);
    const usage = await vault.usage();
    assert(usage.committedBytes >= bytes.length + Buffer.byteLength(JSON.stringify(envelope)));
    const next = { ...snapshot, id: randomUUID(), sequence: 2, previous: snapshot.id };
    const nextEnvelope = {
      snapshot: next,
      signature: sign(null, buddySnapshotBytes(next), privateKey).toString('base64url'),
    };
    await assert.rejects(
      vault.commit(nextEnvelope, jwk, now, { ...capacity, quotaBytes: usage.committedBytes + 1 }),
      /quota/,
    );
    const stagedBytes = randomBytes(100);
    const stagedReceipt = BuddyVault.receipt('e'.repeat(64), stagedBytes);
    await vault.put(stagedReceipt, stagedBytes, capacity);
    const corrupted = Buffer.from(stagedBytes);
    corrupted[20] ^= 1;
    await writeFile(join(directory, vaultId, 'objects', stagedReceipt.id.slice(0, 2), stagedReceipt.id), corrupted);
    assert.deepEqual(await vault.inventory([stagedReceipt.id]), [stagedReceipt]);
    const corruptedSnapshot = { ...next, objects: [receipt, stagedReceipt] };
    const corruptedEnvelope = {
      snapshot: corruptedSnapshot,
      signature: sign(null, buddySnapshotBytes(corruptedSnapshot), privateKey).toString('base64url'),
    };
    const catalogPath = join(directory, vaultId, 'catalog.json');
    const catalog = await readFile(catalogPath);
    const snapshots = await vault.snapshots();
    await assert.rejects(vault.commit(corruptedEnvelope, jwk, now, capacity), /incomplete/);
    assert.deepEqual(await readFile(catalogPath), catalog);
    assert.deepEqual(await vault.snapshots(), snapshots);
    assert.deepEqual(await vault.snapshot(snapshot.id), envelope);
    assert.deepEqual(await vault.read(receipt.id), bytes);
    await vault.commit(envelope, jwk, now + 301_000, capacity);
    const stagedUsage = await vault.usage();
    await rm(catalogPath);
    assert.deepEqual(await new BuddyVault(directory, vaultId).usage(), stagedUsage);
    const storedPath = join(directory, vaultId, 'snapshots', snapshot.id);
    const stored = JSON.parse(await readFile(storedPath, 'utf8'));
    stored.snapshot.objects = [];
    await writeFile(storedPath, JSON.stringify(stored));
    const old = new Date(now - 60 * 86400_000);
    await utimes(join(directory, vaultId, 'objects', receipt.id.slice(0, 2), receipt.id), old, old);
    await assert.rejects(vault.prune(now + 70 * 86400_000), /snapshot envelope/);
    assert.deepEqual(await vault.read(receipt.id), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const allowedReads of [0, 32, 34]) {
  test(`snapshot authority refusal stops the scan after ${allowedReads} reads without publication`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-scan-authority-'));
    try {
      const now = Date.now();
      const vaultId = randomUUID();
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const jwk = publicKey.export({ format: 'jwk' });
      const vault = new BuddyVault(directory, vaultId);
      const capacity = { quotaBytes: 100_000, freeBytes: 100e9, totalBytes: 200e9 };
      const objects = [];
      for (let index = 0; index < 34; index++) {
        const key = randomBytes(32);
        const plain = Buffer.from(`object ${index}`);
        const id = buddyObjectId(key, vaultId, plain);
        const bytes = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, plain);
        const receipt = BuddyVault.receipt(id, bytes);
        await vault.put(receipt, bytes, capacity);
        objects.push(receipt);
      }
      const snapshot = {
        version: 1,
        vaultId,
        id: randomUUID(),
        sequence: 1,
        previous: null,
        createdAt: new Date(now).toISOString(),
        retainUntil: new Date(now + 31 * 86400_000).toISOString(),
        keyVersion: 1,
        manifest: [objects[0].id],
        objects,
      };
      const envelope = {
        snapshot,
        signature: sign(null, buddySnapshotBytes(snapshot), privateKey).toString('base64url'),
      };
      const catalogPath = join(directory, vaultId, 'catalog.json');
      const catalog = await readFile(catalogPath);
      const originalRead = vault.read.bind(vault);
      const reads = [];
      vault.read = async (id) => {
        reads.push(id);
        return originalRead(id);
      };
      await assert.rejects(
        vault.commit(envelope, jwk, now, capacity, async () => {
          if (reads.length >= allowedReads) throw new Error('authority refused');
        }),
        /authority refused/,
      );
      assert.deepEqual(
        reads,
        objects.slice(0, allowedReads).map(({ id }) => id),
      );
      assert.deepEqual(await readFile(catalogPath), catalog);
      assert.deepEqual(await vault.snapshots(), []);
      await assert.rejects(vault.snapshot(snapshot.id), { code: 'ENOENT' });
      await assert.rejects(readFile(join(directory, vaultId, 'snapshots', snapshot.id)), { code: 'ENOENT' });
      // A failed scan releases its caller's operation; valid offline work remains usable.
      await vault.commit(envelope, jwk, now, capacity);
      assert.deepEqual(await vault.snapshot(snapshot.id), envelope);
      await vault.commit(envelope, jwk, now + 301_000, capacity, async () => {
        throw new Error('duplicate must not rescan');
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const revoked of [false, true]) {
  test(`snapshot byte checkpoint ${revoked ? 'refuses revoked authority' : 'admits valid authority'} before the fifth large read`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-byte-authority-'));
    try {
      const now = Date.now();
      const vaultId = randomUUID();
      const key = randomBytes(32);
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const jwk = publicKey.export({ format: 'jwk' });
      const vault = new BuddyVault(directory, vaultId);
      const capacity = { quotaBytes: 64 * 1024 * 1024, freeBytes: 100e9, totalBytes: 200e9 };
      const upload = async (plain) => {
        const id = buddyObjectId(key, vaultId, plain);
        const bytes = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, plain);
        const receipt = BuddyVault.receipt(id, bytes);
        await vault.put(receipt, bytes, capacity);
        return receipt;
      };
      const original = Buffer.from('original valid data survives a revoked successor');
      const originalReceipt = await upload(original);
      const previousId = randomUUID();
      const manifest = {
        version: 1,
        vaultId,
        snapshotId: previousId,
        sequence: 1,
        previous: null,
        library: { version: 2, assets: {} },
        contents: {},
      };
      const manifestReceipt = await upload(Buffer.from(JSON.stringify(manifest)));
      const previousSnapshot = {
        version: 1,
        vaultId,
        id: previousId,
        sequence: 1,
        previous: manifest.previous,
        createdAt: new Date(now).toISOString(),
        retainUntil: new Date(now + 31 * 86_400_000).toISOString(),
        keyVersion: 1,
        manifest: [manifestReceipt.id],
        objects: [originalReceipt, manifestReceipt],
      };
      const previous = {
        snapshot: previousSnapshot,
        signature: sign(undefined, buddySnapshotBytes(previousSnapshot), privateKey).toString('base64url'),
      };
      await vault.commit(previous, jwk, now, capacity);
      const large = [];
      for (let index = 0; index < 5; index++) large.push(await upload(Buffer.alloc(8 * 1024 * 1024, index)));
      const nextId = randomUUID();
      const nextManifest = await upload(
        Buffer.from(JSON.stringify({ ...manifest, snapshotId: nextId, sequence: 2, previous: previousId })),
      );
      const objects = [...large, originalReceipt, nextManifest];
      const snapshot = {
        ...previousSnapshot,
        id: nextId,
        sequence: 2,
        previous: previousId,
        manifest: [nextManifest.id],
        objects,
      };
      const envelope = {
        snapshot,
        signature: sign(undefined, buddySnapshotBytes(snapshot), privateKey).toString('base64url'),
      };
      const catalogPath = join(directory, vaultId, 'catalog.json');
      const catalog = await readFile(catalogPath);
      const previousBytes = await readFile(join(directory, vaultId, 'snapshots', previousId));
      const summaries = await vault.snapshots();
      const originalRead = vault.read.bind(vault);
      const reads = [];
      let readBytes = 0;
      const checkpoints = [];
      vault.read = async (id) => {
        const bytes = await originalRead(id);
        reads.push(id);
        readBytes += bytes.length;
        return bytes;
      };
      const commit = vault.commit(envelope, jwk, now, capacity, async () => {
        checkpoints.push({ reads: reads.length, bytes: readBytes });
        // Revocation is learned after the fourth actual read, independently of callback cadence.
        if (revoked && reads.length >= 4) throw new Error('authority revoked');
      });
      if (revoked) await assert.rejects(commit, /authority revoked/);
      else await commit;
      const fourBytes = 4 * (8 * 1024 * 1024 + 28);
      assert.deepEqual(checkpoints[0], { reads: 0, bytes: 0 });
      assert.deepEqual(checkpoints[1], { reads: 4, bytes: fourBytes });
      assert.equal(checkpoints.length, revoked ? 2 : 3);
      assert.deepEqual(
        reads,
        objects.slice(0, revoked ? 4 : objects.length).map(({ id }) => id),
      );
      if (revoked) {
        assert.deepEqual(await readFile(catalogPath), catalog);
        assert.deepEqual(await vault.snapshots(), summaries);
        await assert.rejects(vault.snapshot(nextId), { code: 'ENOENT' });
        await assert.rejects(readFile(join(directory, vaultId, 'snapshots', nextId)), { code: 'ENOENT' });
        await assert.rejects(readFile(join(directory, vaultId, 'summaries', nextId)), { code: 'ENOENT' });
        assert.deepEqual(await readdir(join(directory, vaultId, 'snapshots')), [previousId]);
      } else {
        assert.deepEqual(checkpoints[2], {
          reads: objects.length,
          bytes: objects.reduce((sum, r) => sum + r.bytes, 0),
        });
        assert.deepEqual(await vault.snapshot(nextId), envelope);
      }
      assert.deepEqual(await readFile(join(directory, vaultId, 'snapshots', previousId)), previousBytes);
      const reader = new BuddyBackupReader(
        { version: 1, vaultId, current: 1, keys: { 1: key.toString('base64url') } },
        await vault.snapshot(previousId),
        originalRead,
      );
      assert.deepEqual(await reader.manifest(), manifest);
      assert.deepEqual(await reader.block(originalReceipt.id, 1), original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('durable reservations, lost acknowledgements and catalog loss preserve quota and immutable ciphertext', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buddy-vault-'));
  try {
    const key = randomBytes(32);
    const vaultId = randomUUID();
    const plain = randomBytes(512);
    const id = buddyObjectId(key, vaultId, plain);
    const ciphertext = encryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, plain);
    const vault = new BuddyVault(directory, vaultId);
    const receipt = BuddyVault.receipt(id, ciphertext);
    const capacity = { quotaBytes: ciphertext.length * 2 - 1, freeBytes: 100e9, totalBytes: 200e9 };
    await vault.reserve(receipt, capacity);
    const other = BuddyVault.receipt('b'.repeat(64), ciphertext);
    await assert.rejects(vault.reserve(other, capacity), /quota/);
    await vault.put(receipt, ciphertext, capacity);
    await vault.put(receipt, ciphertext, capacity);
    const usage = await vault.usage();
    assert(usage.committedBytes >= ciphertext.length);
    assert.equal(usage.reservedBytes, 0);
    const freshVault = new BuddyVault(directory, vaultId);
    assert.deepEqual(await freshVault.read(id), ciphertext);
    assert.deepEqual(decryptBuddyBlock(key, { vaultId, id, keyVersion: 1 }, await freshVault.read(id)), plain);
    const changed = Buffer.from(ciphertext);
    changed[20] ^= 1;
    await assert.rejects(freshVault.put(BuddyVault.receipt(id, changed), changed, capacity), /immutable/);
    await assert.rejects(freshVault.read('../outside'), /identifier/);
    assert.deepEqual(await readFile(join(directory, vaultId, 'objects', id.slice(0, 2), id)), ciphertext);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('passphrase escrow round-trips only for its vault and authentic passphrase', async () => {
  const { createBuddyKeyring, wrapBuddyKeyring, unwrapBuddyKeyring, parseBuddyKeyring } =
    await import('../../src/utils/buddy-backup-crypto.ts');
  const ring = createBuddyKeyring(randomUUID());
  const escrow = await wrapBuddyKeyring(ring, 'a long test recovery phrase');
  assert.deepEqual(await unwrapBuddyKeyring(escrow, 'a long test recovery phrase'), ring);
  await assert.rejects(unwrapBuddyKeyring(escrow, 'the wrong recovery phrase'));
  await assert.rejects(unwrapBuddyKeyring({ ...escrow, vaultId: randomUUID() }, 'a long test recovery phrase'));
  assert.throws(() =>
    parseBuddyKeyring(
      { ...ring, keys: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [i + 1, ring.keys[1]])) },
      ring.vaultId,
    ),
  );
});
