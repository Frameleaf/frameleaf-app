import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import {
  BUDDY_BLOCK_BYTES,
  BUDDY_UUID,
  buddyObjectId,
  decryptBuddyBlock,
  encryptBuddyBlock,
} from 'src/utils/buddy-backup-crypto.js';

/** Client format 1 reuses Buddy's authenticated blocks with a separate key domain per payload/chunk. */
export const CLIENT_BACKUP_FORMAT = 'frameleaf-client-backup';
export const CLIENT_BACKUP_MAGIC = Buffer.from('FLCBAE01');
const HEADER_BYTES = 48;
const BLOCK_OVERHEAD = 60; // keyed block identity (32), nonce (12), tag (16)
const FOOTER_BYTES = 92; // an authenticated SHA-256 block
const HEX = /^[\da-f]{64}$/;
const VERSION = String.raw`[1-9]\d{0,8}`;
const UUID = String.raw`[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}`;
const FILE = new RegExp(String.raw`^(o|db)/v1/(${UUID})/(${VERSION})/([\da-f]{64})(?:/([^/]+))?$`);
const MANIFEST = new RegExp(String.raw`^m/v1/(${UUID})/(${VERSION})/(\d{8}T\d{6}Z)\.json\.gz$`);
export type ClientBackupContext = {
  bucket: string;
  key: string;
  vaultId: string;
  keyVersion: number;
  kind: 'object' | 'database' | 'manifest';
  id: string;
};

export const clientBackupWritesEnabled = () => process.env.FRAMELEAF_BACKUP_CLIENT_ENCRYPTION === '1';

/** Unknown client namespaces are rejected, never retried as plaintext or SSE-C. */
export const clientBackupContext = (
  bucket: string,
  key: string,
  expectedVaultId?: string,
): ClientBackupContext | null => {
  const file = FILE.exec(key);
  const manifest = MANIFEST.exec(key);
  if (!file && !manifest) {
    if (/^(?:o|db|m)\/v\d+\//.test(key)) throw new Error('Unsupported client backup object format');
    return null;
  }
  const vaultId = file ? file[2] : manifest![1];
  const keyVersion = Number(file ? file[3] : manifest![2]);
  if (!bucket || (expectedVaultId && expectedVaultId !== vaultId)) throw new Error('Backup vault mismatch');
  if (file && ((file[1] === 'o' && file[5]) || (file[1] === 'db' && !file[5])))
    throw new Error('Invalid backup object key');
  return {
    bucket,
    key,
    vaultId,
    keyVersion,
    kind: file ? (file[1] === 'o' ? 'object' : 'database') : 'manifest',
    id: file ? file[4] : key,
  };
};

const derive = (root: Buffer, vaultId: string, purpose: string) => {
  if (root.length !== 32 || !BUDDY_UUID.test(vaultId)) throw new Error('Invalid client backup key or vault');
  return Buffer.from(hkdfSync('sha256', root, Buffer.from(vaultId), `${CLIENT_BACKUP_FORMAT}/1/${purpose}`, 32));
};

export const clientBackupObjectId = (
  root: Buffer,
  vaultId: string,
  keyVersion: number,
  kind: 'object' | 'database',
  sha256: string,
) => {
  if (!HEX.test(sha256) || !Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > 999_999_999)
    throw new Error('Invalid client backup identity');
  return createHmac('sha256', derive(root, vaultId, `identity/${keyVersion}/${kind}`))
    .update(Buffer.from(sha256, 'hex'))
    .digest('hex');
};

export const clientBackupObjectKey = (
  root: Buffer,
  vaultId: string,
  keyVersion: number,
  sha256: string,
  dumpName?: string,
) => {
  if (dumpName && !/^[\w.-]+\.sql\.gz$/.test(dumpName)) throw new Error('Invalid backup database name');
  const kind = dumpName ? 'database' : 'object';
  const id = clientBackupObjectId(root, vaultId, keyVersion, kind, sha256);
  return `${dumpName ? 'db' : 'o'}/v1/${vaultId}/${keyVersion}/${id}${dumpName ? `/${dumpName}` : ''}`;
};

export const clientBackupManifestKey = (vaultId: string, keyVersion: number, legacyKey: string) => {
  const key = `m/v1/${vaultId}/${keyVersion}/${legacyKey.slice(2)}`;
  if (!clientBackupContext('validation', key)) throw new Error('Invalid client backup manifest key');
  return key;
};

export const clientBackupStoredSize = (size: number) => {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid backup length');
  const stored = HEADER_BYTES + FOOTER_BYTES + size + Math.ceil(size / BUDDY_BLOCK_BYTES) * BLOCK_OVERHEAD;
  if (!Number.isSafeInteger(stored)) throw new Error('Invalid encrypted backup length');
  return stored;
};

/** HEAD sizes remain comparable to the plaintext sizes in both manifest versions. */
export const clientBackupPlainSize = (stored: number) => {
  const chunks = Math.ceil((stored - HEADER_BYTES - FOOTER_BYTES) / (BUDDY_BLOCK_BYTES + BLOCK_OVERHEAD));
  const size = stored - HEADER_BYTES - FOOTER_BYTES - chunks * BLOCK_OVERHEAD;
  if (!Number.isSafeInteger(size) || size < 0 || clientBackupStoredSize(size) !== stored)
    throw new Error('Invalid encrypted backup length');
  return size;
};

const blockRoot = (root: Buffer, context: ClientBackupContext, header: Buffer, index: number) =>
  derive(
    root,
    context.vaultId,
    JSON.stringify([
      context.bucket,
      context.key,
      context.kind,
      context.keyVersion,
      header.toString('base64url'),
      index,
    ]),
  );

const seal = (root: Buffer, context: ClientBackupContext, header: Buffer, index: number, plaintext: Buffer) => {
  const key = blockRoot(root, context, header, index);
  try {
    const id = buddyObjectId(key, context.vaultId, plaintext);
    return Buffer.concat([Buffer.from(id, 'hex'), encryptBuddyBlock(key, { ...context, id }, plaintext)]);
  } finally {
    key.fill(0);
  }
};
const unseal = (root: Buffer, context: ClientBackupContext, header: Buffer, index: number, ciphertext: Buffer) => {
  const key = blockRoot(root, context, header, index);
  try {
    return decryptBuddyBlock(
      key,
      { ...context, id: ciphertext.subarray(0, 32).toString('hex') },
      ciphertext.subarray(32),
    );
  } finally {
    key.fill(0);
  }
};

/** A bounded reader for provider streams; transport chunk boundaries carry no protocol meaning. */
class BackupReader {
  private iterator: AsyncIterator<Buffer | Uint8Array>;
  private pending = Buffer.alloc(0);
  constructor(source: AsyncIterable<Buffer | Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async read(length: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let count = 0;
    while (count < length) {
      if (this.pending.length === 0) {
        const next = await this.iterator.next();
        if (next.done) throw new Error('Truncated encrypted backup');
        this.pending = Buffer.from(next.value);
      }
      const take = Math.min(length - count, this.pending.length);
      chunks.push(this.pending.subarray(0, take));
      this.pending = this.pending.subarray(take);
      count += take;
    }
    return Buffer.concat(chunks, length);
  }
  async end() {
    if (this.pending.length > 0) throw new Error('Unexpected encrypted backup bytes');
    for (let next = await this.iterator.next(); !next.done; next = await this.iterator.next())
      if (next.value.length > 0) throw new Error('Unexpected encrypted backup bytes');
  }
  async close() {
    await this.iterator.return?.();
  }
}

/** Fresh upload salt makes each attempt use independent keys. Persist bytes before sending/retrying. */
export async function* encryptClientBackup(
  source: AsyncIterable<Buffer | Uint8Array>,
  size: number,
  root: Buffer,
  context: ClientBackupContext,
) {
  clientBackupStoredSize(size);
  const header = Buffer.concat([CLIENT_BACKUP_MAGIC, randomBytes(32), Buffer.alloc(8)]);
  header.writeBigUInt64BE(BigInt(size), 40);
  const reader = new BackupReader(source);
  const hash = createHash('sha256');
  try {
    yield header;
    let index = 0;
    for (let offset = 0; offset < size; offset += BUDDY_BLOCK_BYTES) {
      const block = await reader.read(Math.min(BUDDY_BLOCK_BYTES, size - offset));
      hash.update(block);
      yield seal(root, context, header, index++, block);
    }
    await reader.end();
    const digest = hash.digest();
    if (
      context.kind !== 'manifest' &&
      clientBackupObjectId(root, context.vaultId, context.keyVersion, context.kind, digest.toString('hex')) !==
        context.id
    )
      throw new Error('Backup object identity mismatch');
    yield seal(root, context, header, index, digest);
  } finally {
    await reader.close();
  }
}

/** Only authenticated chunks enter the private restore staging file; footer/checksum precede publication. */
export async function* decryptClientBackup(
  source: AsyncIterable<Buffer | Uint8Array>,
  root: Buffer,
  context: ClientBackupContext,
) {
  const reader = new BackupReader(source);
  const hash = createHash('sha256');
  try {
    const header = await reader.read(HEADER_BYTES);
    if (!header.subarray(0, 8).equals(CLIENT_BACKUP_MAGIC)) throw new Error('Invalid encrypted backup header');
    const size = Number(header.readBigUInt64BE(40));
    clientBackupStoredSize(size);
    let index = 0;
    for (let offset = 0; offset < size; offset += BUDDY_BLOCK_BYTES) {
      const ciphertext = await reader.read(Math.min(BUDDY_BLOCK_BYTES, size - offset) + BLOCK_OVERHEAD);
      const plain = unseal(root, context, header, index++, ciphertext);
      hash.update(plain);
      yield plain;
    }
    const digest = hash.digest();
    const footer = unseal(root, context, header, index, await reader.read(FOOTER_BYTES));
    if (
      !digest.equals(footer) ||
      (context.kind !== 'manifest' &&
        clientBackupObjectId(root, context.vaultId, context.keyVersion, context.kind, digest.toString('hex')) !==
          context.id)
    )
      throw new Error('Backup object identity mismatch');
    await reader.end();
  } finally {
    await reader.close();
  }
}

export type ClientBackupKeys = { vaultId: string; current: number; keys: Record<string, string> };
/** A fresh independent root is mandatory: the legacy SSE-C root was disclosed to storage. */
export const parseClientBackupKeys = (input: unknown, legacyRoot: Buffer, vaultId: string): ClientBackupKeys | null => {
  if (input === undefined) return null;
  const ring = input as ClientBackupKeys;
  if (
    !ring ||
    ring.vaultId !== vaultId ||
    !BUDDY_UUID.test(vaultId) ||
    !Number.isSafeInteger(ring.current) ||
    ring.current < 1 ||
    !ring.keys ||
    typeof ring.keys !== 'object' ||
    Array.isArray(ring.keys)
  )
    throw new Error('Invalid client backup keyring');
  const values = Object.entries(ring.keys);
  if (
    values.length === 0 ||
    values.length > 128 ||
    !ring.keys[ring.current] ||
    values.some(
      ([version, value]) =>
        !/^[1-9]\d{0,8}$/.test(version) ||
        typeof value !== 'string' ||
        !/^[\d+/A-Za-z]{43}=$/.test(value) ||
        Buffer.from(value, 'base64').toString('base64') !== value ||
        Buffer.from(value, 'base64').equals(legacyRoot),
    ) ||
    new Set(values.map(([, value]) => value)).size !== values.length
  )
    throw new Error('Client backup roots must be independent of legacy SSE-C keys and other versions');
  return ring;
};

export const addClientBackupKeys = <T extends { key: string; instanceId: string }>(
  file: T,
): T & { client: ClientBackupKeys } => ({
  ...file,
  client: { vaultId: file.instanceId, current: 1, keys: { 1: randomBytes(32).toString('base64') } },
});

/** Retain every old root for historical reads; only the new independently random root is used for writes. */
export const rotateClientBackupKeys = (ring: ClientBackupKeys, legacyRoot: Buffer): ClientBackupKeys => {
  parseClientBackupKeys(ring, legacyRoot, ring.vaultId);
  const current = Math.max(...Object.keys(ring.keys).map(Number)) + 1;
  const next = { ...ring, current, keys: { ...ring.keys, [current]: randomBytes(32).toString('base64') } };
  return parseClientBackupKeys(next, legacyRoot, ring.vaultId)!;
};
