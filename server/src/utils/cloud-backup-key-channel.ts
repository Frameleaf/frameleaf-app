import {
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import type { FrameleafCloudBackup } from 'src/types.js';
import { keyFingerprint } from 'src/utils/cloud-backup.js';

export const BACKUP_KEY_REQUEST_LIFETIME_MS = 30_000;
const MAX_REPLAYS = 1024;
const DOMAIN = 'frameleaf-backup-worker-v1';
type Binding = Pick<FrameleafCloudBackup, 'instanceId' | 'bucketRef' | 'keyFingerprint'>;
const base64 = (length: number) => z.string().regex(new RegExp(`^[\\w-]{${length}}$`));
const requestSchema = z.strictObject({
  version: z.literal(1),
  instanceId: z.string().min(1).max(128),
  bucketRef: z.string().min(1).max(2048),
  keyFingerprint: z.string().regex(/^[\dA-F]{4}-[\dA-F]{4}$/),
  requestId: z.uuid(),
  workerId: z.string().min(1).max(128),
  issuedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  publicKey: base64(43),
  signature: base64(86),
});
export type BackupKeyRequest = z.infer<typeof requestSchema>;
const shareSchema = z.strictObject({
  version: z.literal(1),
  request: requestSchema,
  workerId: z.string().min(1).max(128),
  publicKey: base64(43),
  iv: base64(16),
  ciphertext: base64(43),
  tag: base64(22),
  signature: base64(86),
});
export type BackupKeyShare = z.infer<typeof shareSchema>;

const bindingMatches = (left: Binding, right: Binding) =>
  left.instanceId === right.instanceId &&
  left.bucketRef === right.bucketRef &&
  left.keyFingerprint === right.keyFingerprint;

/** Explicit transcripts avoid object-order ambiguity and separate signing from other identity uses. */
const requestTranscript = (request: Omit<BackupKeyRequest, 'signature'>) =>
  JSON.stringify([
    `${DOMAIN}/request`,
    request.version,
    request.instanceId,
    request.bucketRef,
    request.keyFingerprint,
    request.requestId,
    request.workerId,
    request.issuedAt,
    request.publicKey,
  ]);
const shareHeader = (share: Pick<BackupKeyShare, 'request' | 'workerId' | 'publicKey' | 'iv'>) =>
  JSON.stringify([`${DOMAIN}/share`, requestTranscript(share.request), share.workerId, share.publicKey, share.iv]);
const shareTranscript = (share: Omit<BackupKeyShare, 'signature'>) =>
  Buffer.from(JSON.stringify([shareHeader(share), share.ciphertext, share.tag]));
const signatureOf = (key: KeyObject, data: string | Buffer) => sign(null, Buffer.from(data), key).toString('base64url');
const verifies = (key: KeyObject, data: string | Buffer, signature: string) =>
  verify(null, Buffer.from(data), createPublicKey(key), Buffer.from(signature, 'base64url'));
const fresh = (request: BackupKeyRequest) => {
  const age = Date.now() - request.issuedAt;
  return age >= -5000 && age < BACKUP_KEY_REQUEST_LIFETIME_MS;
};
const publicX25519 = (x: string) => createPublicKey({ format: 'jwk', key: { kty: 'OKP', crv: 'X25519', x } });
const ephemeral = () => {
  const pair = generateKeyPairSync('x25519');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ format: 'jwk' }).x! };
};
const encryptionKey = (privateKey: KeyObject, peer: string, header: string, requestId: string) => {
  const shared = diffieHellman({ privateKey, publicKey: publicX25519(peer) });
  try {
    return Buffer.from(hkdfSync('sha256', shared, requestId, header, 32));
  } finally {
    shared.fill(0);
  }
};

/**
 * The trust root comes from the private identity volume, never a JWK/recipient row in PostgreSQL.
 * Re-read on exchange so a completed instance-key rotation takes effect without a restart.
 */
export const loadBackupWorkerIdentity = async (path: string): Promise<KeyObject> => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(8193);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 8192) {
      throw new Error('Backup worker identity must be a bounded regular private key file');
    }
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      !current.isFile()
    ) {
      throw new Error('Backup worker identity changed during capture; retry the request');
    }
    const key = createPrivateKey(bytes.subarray(0, length));
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Backup worker identity must be Ed25519');
    return key;
  } finally {
    bytes.fill(0);
    await file.close();
  }
};

/**
 * A worker's own-memory key and one short-lived recipient. The display fingerprint only selects a
 * bucket: possession of the private instance identity authorizes a worker. Only an authenticated
 * request receives a reply, encrypted to that request's ephemeral X25519 key. Recorded database
 * traffic and the signing key alone cannot open it after the recipient is discarded.
 */
export class CloudBackupKeyChannel {
  private memory?: { binding: Binding; key: Buffer };
  private pending?: { request: BackupKeyRequest; privateKey: KeyObject; timer: NodeJS.Timeout };
  private readonly seen = new Map<string, number>();
  private generation = 0;
  private closed = false;

  constructor(
    private readonly workerId: string,
    private readonly identity: () => Promise<KeyObject>,
  ) {}

  getKey(binding: Binding): Buffer | null {
    if (this.memory && !bindingMatches(this.memory.binding, binding)) this.clear();
    return this.memory && bindingMatches(this.memory.binding, binding) ? this.memory.key : null;
  }

  setKey(binding: Binding, key: Buffer) {
    if (this.closed) throw new Error('Backup key channel is closed');
    if (key.length !== 32 || keyFingerprint(key) !== binding.keyFingerprint) throw new Error('Invalid backup key');
    // Copy before clearing: a caller may be handing back the channel's current buffer.
    const copy = Buffer.from(key);
    this.clear();
    this.memory = { binding: { ...binding }, key: copy };
  }

  clear() {
    this.generation++;
    this.memory?.key.fill(0);
    this.memory = undefined;
    this.discardRequest();
  }

  close() {
    this.closed = true;
    this.clear();
    this.seen.clear();
  }

  private discardRequest() {
    clearTimeout(this.pending?.timer);
    this.pending = undefined;
  }

  async request(binding: Binding): Promise<BackupKeyRequest | null> {
    if (this.closed || this.getKey(binding)) return null;
    if (this.pending && fresh(this.pending.request) && bindingMatches(this.pending.request, binding)) return null;
    const generation = this.generation;
    const identity = await this.identity();
    if (this.closed || generation !== this.generation) return null;
    this.generation++;
    this.discardRequest();
    const pair = ephemeral();
    const body: Omit<BackupKeyRequest, 'signature'> = {
      version: 1,
      instanceId: binding.instanceId,
      bucketRef: binding.bucketRef,
      keyFingerprint: binding.keyFingerprint,
      requestId: randomUUID(),
      workerId: this.workerId,
      issuedAt: Date.now(),
      publicKey: pair.publicKey,
    };
    const request = { ...body, signature: signatureOf(identity, requestTranscript(body)) };
    const timer = setTimeout(() => this.discardRequest(), BACKUP_KEY_REQUEST_LIFETIME_MS);
    timer.unref();
    this.pending = { request, privateKey: pair.privateKey, timer };
    return request;
  }

  async share(value: unknown, binding: Binding): Promise<BackupKeyShare | null> {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success || this.closed) return null;
    const request = parsed.data;
    if (request.workerId === this.workerId || !fresh(request) || !bindingMatches(request, binding)) return null;
    const generation = this.generation;
    const identity = await this.identity();
    const key = this.getKey(binding);
    if (!key || generation !== this.generation || !verifies(identity, requestTranscript(request), request.signature)) {
      return null;
    }
    for (const [id, until] of this.seen) {
      if (until <= Date.now()) this.seen.delete(id);
    }
    if (this.seen.has(request.requestId) || this.seen.size >= MAX_REPLAYS) return null;
    this.seen.set(request.requestId, request.issuedAt + BACKUP_KEY_REQUEST_LIFETIME_MS);
    const pair = ephemeral();
    const header = {
      request,
      workerId: this.workerId,
      publicKey: pair.publicKey,
      iv: randomBytes(12).toString('base64url'),
    };
    let derived: Buffer | undefined;
    try {
      derived = encryptionKey(pair.privateKey, request.publicKey, shareHeader(header), request.requestId);
      const cipher = createCipheriv('aes-256-gcm', derived, Buffer.from(header.iv, 'base64url'));
      cipher.setAAD(Buffer.from(shareHeader(header)));
      const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]).toString('base64url');
      const body = { version: 1 as const, ...header, ciphertext, tag: cipher.getAuthTag().toString('base64url') };
      return { ...body, signature: signatureOf(identity, shareTranscript(body)) };
    } catch {
      // Invalid/low-order X25519 keys are untrusted input. Never log a key or a received envelope.
      return null;
    } finally {
      derived?.fill(0);
    }
  }

  async accept(value: unknown, binding: Binding): Promise<boolean> {
    const parsed = shareSchema.safeParse(value);
    const pending = this.pending;
    if (!parsed.success || !pending || this.closed) return false;
    const share = parsed.data;
    if (
      !fresh(pending.request) ||
      !bindingMatches(share.request, binding) ||
      requestTranscript(share.request) !== requestTranscript(pending.request) ||
      share.request.signature !== pending.request.signature
    ) {
      return false;
    }
    const generation = this.generation;
    const identity = await this.identity();
    if (
      generation !== this.generation ||
      this.pending !== pending ||
      !fresh(pending.request) ||
      !verifies(identity, shareTranscript(share), share.signature)
    ) {
      return false;
    }
    let derived: Buffer | undefined;
    let first: Buffer | undefined;
    let key: Buffer | undefined;
    try {
      derived = encryptionKey(pending.privateKey, share.publicKey, shareHeader(share), share.request.requestId);
      const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(share.iv, 'base64url'));
      decipher.setAAD(Buffer.from(shareHeader(share)));
      decipher.setAuthTag(Buffer.from(share.tag, 'base64url'));
      first = decipher.update(Buffer.from(share.ciphertext, 'base64url'));
      key = Buffer.concat([first, decipher.final()]);
      this.setKey(binding, key);
      return true;
    } catch {
      return false;
    } finally {
      first?.fill(0);
      key?.fill(0);
      derived?.fill(0);
    }
  }
}
