/* eslint-disable no-restricted-imports -- Offline recovery runs directly under Node without application aliases. */
import { createHash, randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUDDY_ID, type BuddyKeyring, decryptBuddyBlock } from './buddy-backup-crypto.ts';
import { readBuddyMetadata } from './buddy-backup-metadata.ts';
import {
  type BuddyReceipt,
  type BuddySignedSnapshot,
  buddyDigest,
  createBuddyDirectory,
  flushBuddyDirectory,
} from './buddy-backup-vault.ts';
import type { BuddyManifest } from '../services/buddy-backup-capture.service.ts';

/** Both peer recovery and offline recovery use this authenticated reader; it has no Cloud dependency. */
export class BuddyBackupReader {
  private receipts: Map<string, BuddyReceipt>;
  readonly ring: BuddyKeyring;
  readonly envelope: BuddySignedSnapshot;
  private readBlock: (id: string) => Promise<Buffer>;
  private execution: { signal?: AbortSignal; progress?: (bytes: number) => void };
  constructor(
    ring: BuddyKeyring,
    envelope: BuddySignedSnapshot,
    readBlock: (id: string) => Promise<Buffer>,
    execution: { signal?: AbortSignal; progress?: (bytes: number) => void } = {},
  ) {
    this.ring = ring;
    this.envelope = envelope;
    this.readBlock = readBlock;
    this.execution = execution;
    if (
      envelope.snapshot.version !== 1 ||
      envelope.snapshot.vaultId !== ring.vaultId ||
      !Number.isSafeInteger(envelope.snapshot.sequence) ||
      envelope.snapshot.sequence < 1 ||
      !Array.isArray(envelope.snapshot.objects) ||
      envelope.snapshot.objects.length > 1_000_000
    )
      throw new Error('Invalid Buddy recovery snapshot');
    this.receipts = new Map(envelope.snapshot.objects.map((receipt) => [receipt.id, receipt]));
  }

  async block(id: string, keyVersion: number) {
    this.execution.signal?.throwIfAborted();
    const receipt = this.receipts.get(id);
    if (!receipt || !BUDDY_ID.test(id) || !this.ring.keys[keyVersion])
      throw new Error('Buddy recovery object or key unavailable');
    const bytes = await this.readBlock(id);
    this.execution.signal?.throwIfAborted();
    if (bytes.length !== receipt.bytes || buddyDigest(bytes) !== receipt.digest)
      throw new Error('Buddy recovery ciphertext failed verification');
    return decryptBuddyBlock(
      Buffer.from(this.ring.keys[keyVersion], 'base64url'),
      { vaultId: this.ring.vaultId, id, keyVersion },
      bytes,
    );
  }

  async manifest(): Promise<BuddyManifest> {
    const chunks: Buffer[] = [];
    let length = 0;
    const { snapshot } = this.envelope;
    if (!Array.isArray(snapshot.manifest) || snapshot.manifest.length === 0 || snapshot.manifest.length > 128)
      throw new Error('Buddy recovery manifest exceeds its limit');
    for (const id of snapshot.manifest) {
      const chunk = await this.block(id, snapshot.keyVersion);
      length += chunk.length;
      if (length > 1024 ** 3) throw new Error('Buddy recovery manifest exceeds its limit');
      chunks.push(chunk);
    }
    const manifest = JSON.parse(Buffer.concat(chunks).toString()) as BuddyManifest;
    if (
      manifest.version !== 1 ||
      manifest.vaultId !== this.ring.vaultId ||
      manifest.snapshotId !== snapshot.id ||
      manifest.sequence !== snapshot.sequence ||
      manifest.previous !== snapshot.previous ||
      manifest.library?.version !== 2 ||
      !manifest.library.assets ||
      !manifest.contents
    )
      throw new Error('Buddy snapshot manifest binding failed');
    if (manifest.metadata !== undefined) {
      manifest.metadata = readBuddyMetadata(manifest.metadata);
    }
    if (manifest.bootConfiguration !== undefined) {
      const { readBuddyBootConfiguration } = await import('./buddy-boot-configuration.ts');
      manifest.bootConfiguration = readBuddyBootConfiguration(manifest.bootConfiguration);
    }
    return manifest;
  }

  /** Whole-file SHA256 and byte count verify before an atomic publication; memory stays at one block. */
  async download(manifest: BuddyManifest, sha256: string, destination: string) {
    this.execution.signal?.throwIfAborted();
    const content = manifest.contents[sha256];
    if (
      !BUDDY_ID.test(sha256) ||
      !content ||
      !Number.isSafeInteger(content.bytes) ||
      content.bytes < 0 ||
      !Array.isArray(content.blocks) ||
      content.blocks.length > 1_000_000
    )
      throw new Error('Buddy file is not in the encrypted manifest');
    await createBuddyDirectory(dirname(destination));
    const temporary = join(dirname(destination), `.tmp-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        for (const id of content.blocks) {
          this.execution.signal?.throwIfAborted();
          const bytes = await this.block(id, content.keyVersion);
          size += bytes.length;
          if (size > content.bytes) throw new Error('Buddy file exceeds its declared size');
          hash.update(bytes);
          this.execution.signal?.throwIfAborted();
          await file.writeFile(bytes);
          this.execution.signal?.throwIfAborted();
          this.execution.progress?.(bytes.length);
        }
        if (size !== content.bytes || hash.digest('hex') !== sha256) throw new Error('Buddy plaintext checksum failed');
        await file.sync();
      } finally {
        await file.close();
      }
      this.execution.signal?.throwIfAborted();
      await rename(temporary, destination);
      await flushBuddyDirectory(dirname(destination));
      return { sha256, size };
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
