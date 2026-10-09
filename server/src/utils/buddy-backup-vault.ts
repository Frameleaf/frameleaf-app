/* eslint-disable no-restricted-imports -- Offline recovery runs directly under Node without application aliases. */
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BUDDY_BLOCK_BYTES, BUDDY_ID, BUDDY_SEALED_OVERHEAD, BUDDY_UUID } from './buddy-backup-crypto.ts';

export type BuddyReceipt = { id: string; bytes: number; digest: string };
export type BuddyCapacity = { quotaBytes: number; freeBytes: number; totalBytes: number };
export type BuddySnapshot = {
  version: 1;
  vaultId: string;
  id: string;
  sequence: number;
  previous: string | null;
  createdAt: string;
  retainUntil: string;
  keyVersion: number;
  manifest: string[];
  objects: BuddyReceipt[];
};
export type BuddySignedSnapshot = { snapshot: BuddySnapshot; signature: string };
export type BuddySnapshotSummary = Pick<
  BuddySnapshot,
  'id' | 'sequence' | 'previous' | 'createdAt' | 'retainUntil' | 'keyVersion'
>;
type BuddyPublicKey = { kty: 'OKP'; crv: 'Ed25519'; x: string };

export const buddySnapshotBytes = (snapshot: BuddySnapshot) => Buffer.from(JSON.stringify(snapshot));
export const buddyDigest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

export const flushBuddyDirectory = async (directory: string) => {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Flush each new directory's link in its parent, not just the final file's directory. */
export const createBuddyDirectory = async (directory: string): Promise<void> => {
  if (await exists(directory)) return;
  const parent = dirname(directory);
  if (parent === directory) throw new Error('Buddy storage root is unavailable');
  await createBuddyDirectory(parent);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await flushBuddyDirectory(parent);
};

/** The caller holds the vault's PostgreSQL advisory lock for all writes, including staging cleanup. */
export const writeBuddyFile = async (
  path: string,
  bytes: Buffer | string,
  immutable = false,
  authorize?: () => Promise<void>,
) => {
  await createBuddyDirectory(dirname(path));
  const temporary = join(dirname(path), `.tmp-${randomUUID()}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await authorize?.();
    if (immutable) await link(temporary, path);
    else await rename(temporary, path);
    await flushBuddyDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
    await flushBuddyDirectory(dirname(path));
  }
};

const exists = async (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
const names = async (directory: string) =>
  readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return [] as string[];
  });

/** Disk is authoritative. No database index is required to enumerate or recover a vault. */
export class BuddyVault {
  readonly directory: string;
  readonly vaultId: string;

  constructor(root: string, vaultId: string) {
    if (!BUDDY_UUID.test(vaultId)) throw new Error('Invalid Buddy vault identifier');
    this.vaultId = vaultId;
    this.directory = join(root, vaultId);
  }

  private path(id: string) {
    if (!BUDDY_ID.test(id)) throw new Error('Invalid Buddy object identifier');
    return join(this.directory, 'objects', id.slice(0, 2), id);
  }

  static receipt(id: string, bytes: Buffer): BuddyReceipt {
    return { id, bytes: bytes.length, digest: buddyDigest(bytes) };
  }

  private checkReceipt(receipt: BuddyReceipt) {
    if (
      !receipt ||
      Object.keys(receipt).some((key) => !['id', 'bytes', 'digest'].includes(key)) ||
      !BUDDY_ID.test(receipt.id) ||
      !BUDDY_ID.test(receipt.digest) ||
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes < BUDDY_SEALED_OVERHEAD ||
      receipt.bytes > BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD
    )
      throw new Error('Invalid Buddy object receipt');
  }

  async inventory(ids: string[]): Promise<BuddyReceipt[]> {
    if (ids.length > 100) throw new Error('Buddy inventory is limited to 100 objects');
    const found: BuddyReceipt[] = [];
    for (const id of ids) {
      const stored = await exists(this.path(id));
      if (!stored) continue;
      const receiptPath = join(this.directory, 'receipts', id);
      const receipt: BuddyReceipt = (await exists(receiptPath))
        ? JSON.parse(await readFile(receiptPath, 'utf8'))
        : BuddyVault.receipt(id, await this.read(id));
      this.checkReceipt(receipt);
      if (!stored.isFile() || receipt.id !== id || receipt.bytes !== stored.size)
        throw new Error('Buddy object integrity failure');
      found.push(receipt);
    }
    return found;
  }

  async usage() {
    if (!(await exists(join(this.directory, 'dirty')))) {
      try {
        const saved = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8')) as {
          committedBytes: number;
          reservedBytes: number;
        };
        if (
          Number.isSafeInteger(saved.committedBytes) &&
          saved.committedBytes >= 0 &&
          Number.isSafeInteger(saved.reservedBytes) &&
          saved.reservedBytes >= 0
        )
          return saved;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    // One reconstruction after lost/corrupt catalog or interrupted mutation; steady-state admission is O(1).
    let committedBytes = 0;
    let reservedBytes = 0;
    for (const name of await names(this.directory)) {
      if (name.startsWith('.tmp-')) await rm(join(this.directory, name), { force: true });
    }
    for (const shard of await names(join(this.directory, 'objects'))) {
      if (!/^[\da-f]{2}$/.test(shard)) continue;
      for (const id of await names(join(this.directory, 'objects', shard))) {
        if (id.startsWith('.tmp-')) {
          await rm(join(this.directory, 'objects', shard, id), { force: true });
          continue;
        }
        if (!BUDDY_ID.test(id)) continue;
        const entry = await lstat(this.path(id));
        if (!entry.isFile()) throw new Error('Invalid Buddy object storage');
        committedBytes += entry.size;
      }
    }
    for (const folder of ['receipts', 'reservations', 'snapshots', 'summaries']) {
      for (const name of await names(join(this.directory, folder))) {
        const path = join(this.directory, folder, name);
        if (name.startsWith('.tmp-')) {
          await rm(path, { force: true });
          continue;
        }
        if (!(folder === 'snapshots' || folder === 'summaries' ? BUDDY_UUID : BUDDY_ID).test(name))
          throw new Error('Unknown Buddy storage entry');
        const entry = await lstat(path);
        if (!entry.isFile()) throw new Error('Invalid Buddy metadata storage');
        committedBytes += entry.size;
      }
    }
    for (const id of await names(join(this.directory, 'reservations'))) {
      if (!BUDDY_ID.test(id)) continue;
      const receipt: BuddyReceipt = JSON.parse(await readFile(join(this.directory, 'reservations', id), 'utf8'));
      this.checkReceipt(receipt);
      if (receipt.id !== id) throw new Error('Invalid Buddy reservation');
      if (!(await exists(this.path(id)))) reservedBytes += receipt.bytes;
    }
    const usage = { committedBytes, reservedBytes };
    await this.account(usage);
    return usage;
  }

  private async dirty() {
    await writeBuddyFile(join(this.directory, 'dirty'), '1');
  }
  private async account(usage: { committedBytes: number; reservedBytes: number }) {
    await writeBuddyFile(join(this.directory, 'catalog.json'), JSON.stringify(usage));
    await rm(join(this.directory, 'dirty'), { force: true });
    await flushBuddyDirectory(this.directory);
  }
  private capacity(usage: { committedBytes: number; reservedBytes: number }, extra: number, capacity: BuddyCapacity) {
    if (
      !Number.isSafeInteger(capacity.quotaBytes) ||
      usage.committedBytes + usage.reservedBytes + extra > capacity.quotaBytes
    )
      throw new Error('Buddy quota reached');
    if (
      !Number.isFinite(capacity.freeBytes) ||
      !Number.isFinite(capacity.totalBytes) ||
      capacity.freeBytes - usage.reservedBytes - extra - 4096 < Math.max(10 * 1024 ** 3, capacity.totalBytes * 0.1)
    )
      throw new Error('Buddy disk reserve reached');
  }

  async reserve(receipt: BuddyReceipt, capacity: BuddyCapacity, authorize?: () => Promise<void>) {
    this.checkReceipt(receipt);
    const [stored] = await this.inventory([receipt.id]);
    if (stored) {
      if (stored.digest !== receipt.digest || stored.bytes !== receipt.bytes)
        throw new Error('Buddy objects are immutable');
      return;
    }
    const reservation = join(this.directory, 'reservations', receipt.id);
    if (await exists(reservation)) {
      const previous: BuddyReceipt = JSON.parse(await readFile(reservation, 'utf8'));
      if (previous.digest !== receipt.digest || previous.bytes !== receipt.bytes)
        throw new Error('Buddy reservation is immutable');
      return;
    }
    const usage = await this.usage();
    const metadata = JSON.stringify(receipt);
    this.capacity(usage, receipt.bytes + Buffer.byteLength(metadata), capacity);
    await this.dirty();
    await writeBuddyFile(reservation, metadata, true, authorize);
    await this.account({
      committedBytes: usage.committedBytes + Buffer.byteLength(metadata),
      reservedBytes: usage.reservedBytes + receipt.bytes,
    });
  }

  async put(receipt: BuddyReceipt, ciphertext: Buffer, capacity: BuddyCapacity, authorize?: () => Promise<void>) {
    this.checkReceipt(receipt);
    if (ciphertext.length !== receipt.bytes || buddyDigest(ciphertext) !== receipt.digest)
      throw new Error('Buddy block integrity failure');
    await this.reserve(receipt, capacity, authorize);
    const path = this.path(receipt.id);
    const usage = await this.usage();
    const present = !!(await exists(path));
    const reservation = join(this.directory, 'reservations', receipt.id);
    const reserved = await exists(reservation);
    const receiptPath = join(this.directory, 'receipts', receipt.id);
    const recorded = !!(await exists(receiptPath));
    const metadata = JSON.stringify(receipt);
    if (!recorded && !reserved) this.capacity(usage, Buffer.byteLength(metadata), capacity);
    await this.dirty();
    if (!present) {
      // Recheck actual disk space even for an old reservation after a pause or restart.
      if (capacity.freeBytes - receipt.bytes < Math.max(10 * 1024 ** 3, capacity.totalBytes * 0.1))
        throw new Error('Buddy disk reserve reached');
      await writeBuddyFile(path, ciphertext, true, authorize);
    }
    if (!recorded) await writeBuddyFile(receiptPath, metadata, true);
    await rm(reservation, { force: true });
    if (await exists(dirname(reservation))) await flushBuddyDirectory(dirname(reservation));
    await this.account({
      committedBytes:
        usage.committedBytes +
        (present ? 0 : receipt.bytes) +
        (recorded ? 0 : Buffer.byteLength(metadata)) -
        (reserved?.size ?? 0),
      reservedBytes: usage.reservedBytes - (!present && reserved ? receipt.bytes : 0),
    });
    return receipt;
  }

  async read(id: string): Promise<Buffer> {
    const handle = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < BUDDY_SEALED_OVERHEAD || stat.size > BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD)
        throw new Error('Invalid Buddy object storage');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private summary(snapshot: BuddySnapshot): BuddySnapshotSummary {
    const { id, sequence, previous, createdAt, retainUntil, keyVersion } = snapshot;
    return { id, sequence, previous, createdAt, retainUntil, keyVersion };
  }

  private validate(envelope: BuddySignedSnapshot, publicKey: BuddyPublicKey) {
    const { snapshot, signature } = envelope;
    const keys = new Set([
      'version',
      'vaultId',
      'id',
      'sequence',
      'previous',
      'createdAt',
      'retainUntil',
      'keyVersion',
      'manifest',
      'objects',
    ]);
    if (
      !snapshot ||
      Object.keys(snapshot).some((key) => !keys.has(key)) ||
      snapshot.version !== 1 ||
      Object.keys(envelope).some((key) => !['snapshot', 'signature'].includes(key)) ||
      !BUDDY_UUID.test(snapshot.id) ||
      snapshot.vaultId !== this.vaultId ||
      !Number.isSafeInteger(snapshot.sequence) ||
      snapshot.sequence < 1 ||
      !Number.isSafeInteger(snapshot.keyVersion) ||
      snapshot.keyVersion < 1 ||
      !(snapshot.previous === null || BUDDY_UUID.test(snapshot.previous)) ||
      !Array.isArray(snapshot.objects) ||
      snapshot.objects.length > 1_000_000 ||
      !Array.isArray(snapshot.manifest) ||
      snapshot.manifest.length === 0 ||
      snapshot.manifest.length > 128 ||
      !Number.isFinite(Date.parse(snapshot.createdAt)) ||
      !Number.isFinite(Date.parse(snapshot.retainUntil)) ||
      typeof signature !== 'string' ||
      !/^[\w-]{86}$/.test(signature) ||
      publicKey?.kty !== 'OKP' ||
      publicKey.crv !== 'Ed25519' ||
      !/^[\w-]{43}$/.test(publicKey.x) ||
      !verify(
        null,
        buddySnapshotBytes(snapshot),
        createPublicKey({ key: publicKey, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      )
    )
      throw new Error('Invalid Buddy snapshot envelope');
    const ids = new Set<string>();
    for (const receipt of snapshot.objects) {
      this.checkReceipt(receipt);
      if (ids.has(receipt.id)) throw new Error('Duplicate Buddy object');
      ids.add(receipt.id);
    }
    if (snapshot.manifest.some((id) => !ids.has(id))) throw new Error('Buddy snapshot manifest is missing');
  }

  async snapshot(id: string): Promise<BuddySignedSnapshot> {
    if (!BUDDY_UUID.test(id)) throw new Error('Invalid Buddy snapshot identifier');
    const path = join(this.directory, 'snapshots', id);
    const size = (await lstat(path)).size;
    if (size > 256 * 1024 * 1024) throw new Error('Buddy snapshot exceeds its limit');
    const { snapshot, signature, signer } = JSON.parse(await readFile(path, 'utf8')) as BuddySignedSnapshot & {
      signer: BuddyPublicKey;
    };
    const envelope = { snapshot, signature };
    this.validate(envelope, signer);
    if (snapshot.id !== id) throw new Error('Buddy snapshot filename binding failed');
    return envelope;
  }

  /** Small derived summaries; index loss reparses one envelope at a time, never the retained history at once. */
  async snapshots(): Promise<BuddySnapshotSummary[]> {
    const entries = (await names(join(this.directory, 'snapshots'))).filter((id) => BUDDY_UUID.test(id));
    if (entries.length > 4096) throw new Error('Buddy snapshot catalog exceeds its limit');
    const result: BuddySnapshotSummary[] = [];
    for (const id of entries) {
      const path = join(this.directory, 'summaries', id);
      let summary: BuddySnapshotSummary;
      try {
        const entry = JSON.parse(await readFile(path, 'utf8')) as { summary: BuddySnapshotSummary; digest: string };
        if (entry.summary?.id !== id || buddyDigest(Buffer.from(JSON.stringify(entry.summary))) !== entry.digest)
          throw new SyntaxError('Damaged Buddy summary');
        summary = entry.summary;
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        summary = this.summary((await this.snapshot(id)).snapshot);
        await this.dirty();
        await this.saveSummary(summary);
      }
      result.push(summary);
    }
    return result.sort((a, b) => b.sequence - a.sequence);
  }

  private summaryBytes(summary: BuddySnapshotSummary) {
    return JSON.stringify({ summary, digest: buddyDigest(Buffer.from(JSON.stringify(summary))) });
  }
  private async saveSummary(summary: BuddySnapshotSummary) {
    await writeBuddyFile(join(this.directory, 'summaries', summary.id), this.summaryBytes(summary));
  }

  /** Host housekeeping only: no peer operation accepts a deletion or a shorter retention deadline. */
  async prune(now = Date.now()) {
    const summaries = await this.snapshots();
    const months = new Set<string>();
    const references = new Set<string>();
    const removed: string[] = [];
    // Verify every envelope before the first deletion. Historical signer provenance travels with each signed envelope.
    for (const [index, summary] of summaries.entries()) {
      const { snapshot } = await this.snapshot(summary.id);
      if (JSON.stringify(this.summary(snapshot)) !== JSON.stringify(summary))
        throw new Error('Buddy retention summary is damaged');
      const created = Date.parse(snapshot.createdAt);
      const deadline = Date.parse(snapshot.retainUntil);
      const month = snapshot.createdAt.slice(0, 7);
      const monthly = !months.has(month) && months.size < 12;
      if (monthly) months.add(month);
      if (index === 0 || monthly || deadline > now || created > now - 30 * 86_400_000) {
        for (const receipt of snapshot.objects) references.add(receipt.id);
      } else removed.push(snapshot.id);
    }
    await this.dirty();
    for (const id of removed) {
      await rm(join(this.directory, 'snapshots', id));
      await rm(join(this.directory, 'summaries', id), { force: true });
    }
    if (removed.length > 0) {
      await flushBuddyDirectory(join(this.directory, 'snapshots'));
      await flushBuddyDirectory(join(this.directory, 'summaries'));
    }
    for (const shard of await names(join(this.directory, 'objects'))) {
      if (!/^[a-f\d]{2}$/.test(shard)) continue;
      for (const id of await names(join(this.directory, 'objects', shard))) {
        if (!BUDDY_ID.test(id) || references.has(id)) continue;
        if ((await lstat(this.path(id))).mtimeMs > now - 30 * 86_400_000) continue;
        await rm(this.path(id));
        await rm(join(this.directory, 'receipts', id), { force: true });
      }
      await flushBuddyDirectory(join(this.directory, 'objects', shard));
    }
    for (const id of await names(join(this.directory, 'reservations'))) {
      if (!BUDDY_ID.test(id)) continue;
      const path = join(this.directory, 'reservations', id);
      if ((await lstat(path)).mtimeMs < now - 7 * 86_400_000) await rm(path);
    }
    for (const directory of ['receipts', 'reservations']) {
      const path = join(this.directory, directory);
      if (await exists(path)) await flushBuddyDirectory(path);
    }
    return this.usage();
  }

  async commit(
    envelope: BuddySignedSnapshot,
    publicKey: { kty: 'OKP'; crv: 'Ed25519'; x: string },
    now: number,
    capacity: BuddyCapacity,
    authorize?: () => Promise<void>,
  ) {
    this.validate(envelope, publicKey);
    const { snapshot } = envelope;
    const existing = await this.snapshots();
    const duplicate = existing.some((entry) => entry.id === snapshot.id);
    if (duplicate) {
      if (JSON.stringify(await this.snapshot(snapshot.id)) !== JSON.stringify(envelope))
        throw new Error('Buddy snapshots are immutable');
      return;
    }
    if (
      !Number.isFinite(now) ||
      Math.abs(Date.parse(snapshot.createdAt) - now) > 300_000 ||
      Date.parse(snapshot.retainUntil) < now + 30 * 86_400_000 ||
      existing.length >= 4096
    )
      throw new Error('Buddy snapshot time, retention or catalog limit rejected');
    if (snapshot.sequence !== (existing[0]?.sequence ?? 0) + 1 || snapshot.previous !== (existing[0]?.id ?? null))
      throw new Error('Buddy snapshot rollback or concurrent commit');
    const ids = new Set<string>();
    let scannedBytes = 0;
    for (const [index, receipt] of snapshot.objects.entries()) {
      // Bound stale-authority work without a database check for every small object.
      if (index % 32 === 0 || scannedBytes >= 32 * 1024 * 1024) {
        await authorize?.();
        scannedBytes = 0;
      }
      this.checkReceipt(receipt);
      if (ids.has(receipt.id)) throw new Error('Duplicate Buddy object');
      ids.add(receipt.id);
      const [stored] = await this.inventory([receipt.id]);
      if (!stored || stored.bytes !== receipt.bytes || stored.digest !== receipt.digest)
        throw new Error('Buddy snapshot is incomplete');
      const bytes = await this.read(receipt.id);
      scannedBytes += bytes.length;
      if (bytes.length !== receipt.bytes || buddyDigest(bytes) !== receipt.digest)
        throw new Error('Buddy snapshot is incomplete');
    }
    if (snapshot.manifest.some((id) => !ids.has(id))) throw new Error('Buddy snapshot manifest is missing');
    const encoded = JSON.stringify({ ...envelope, signer: publicKey });
    const summary = this.summary(snapshot);
    const metadataBytes = Buffer.byteLength(encoded) + Buffer.byteLength(this.summaryBytes(summary));
    const usage = await this.usage();
    this.capacity(usage, metadataBytes, capacity);
    await this.dirty();
    await writeBuddyFile(join(this.directory, 'snapshots', snapshot.id), encoded, true, authorize);
    await this.saveSummary(summary);
    await this.account({ ...usage, committedBytes: usage.committedBytes + metadataBytes });
  }
}
