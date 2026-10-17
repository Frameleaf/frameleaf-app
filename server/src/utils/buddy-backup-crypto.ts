import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

export const BUDDY_BLOCK_BYTES = 8 * 1024 * 1024;
export const BUDDY_SEALED_OVERHEAD = 28;
export const BUDDY_ID = /^[\da-f]{64}$/;
export const BUDDY_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export type BuddyBlockContext = { vaultId: string; id: string; keyVersion: number };
export type BuddyKeyring = { version: 1; vaultId: string; current: number; keys: Record<string, string> };

const derive = (root: Buffer, vaultId: string, purpose: string) => {
  if (root.length !== 32 || !BUDDY_UUID.test(vaultId)) throw new Error('Invalid Buddy key or vault');
  return Buffer.from(hkdfSync('sha256', root, Buffer.from(vaultId), `frameleaf-buddy/1/${purpose}`, 32));
};

/** IDs disclose neither plaintext hashes nor equality across independently keyed vaults. */
export const buddyObjectId = (root: Buffer, vaultId: string, plaintext: Buffer) =>
  createHmac('sha256', derive(root, vaultId, 'object-id'))
    .update(createHash('sha256').update(plaintext).digest())
    .digest('hex');

const contextBytes = ({ vaultId, id, keyVersion }: BuddyBlockContext) => {
  if (!BUDDY_UUID.test(vaultId) || !BUDDY_ID.test(id) || !Number.isSafeInteger(keyVersion) || keyVersion < 1)
    throw new Error('Invalid Buddy block context');
  return Buffer.from(JSON.stringify(['frameleaf-buddy-block', 1, vaultId, id, keyVersion]));
};

/** Persist the returned bytes before sending. Retries send those same bytes, never a new encryption. */
export const encryptBuddyBlock = (
  root: Buffer,
  context: BuddyBlockContext,
  plaintext: Buffer,
  nonce = randomBytes(12),
): Buffer => {
  if (plaintext.length > BUDDY_BLOCK_BYTES) throw new Error('Buddy block exceeds 8 MiB');
  const aad = contextBytes(context);
  if (buddyObjectId(root, context.vaultId, plaintext) !== context.id) throw new Error('Buddy object identity mismatch');
  if (nonce.length !== 12) throw new Error('Invalid Buddy encryption nonce');
  const cipher = createCipheriv(
    'aes-256-gcm',
    derive(root, context.vaultId, `block/${context.keyVersion}/${context.id}`),
    nonce,
  );
  cipher.setAAD(aad);
  return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};

/** Each block authenticates before any plaintext is returned to the restore writer. */
export const decryptBuddyBlock = (root: Buffer, context: BuddyBlockContext, encrypted: Buffer): Buffer => {
  if (encrypted.length < BUDDY_SEALED_OVERHEAD || encrypted.length > BUDDY_BLOCK_BYTES + BUDDY_SEALED_OVERHEAD)
    throw new Error('Invalid Buddy block length');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    derive(root, context.vaultId, `block/${context.keyVersion}/${context.id}`),
    encrypted.subarray(0, 12),
  );
  decipher.setAAD(contextBytes(context));
  decipher.setAuthTag(encrypted.subarray(-16));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]);
  if (!timingSafeEqual(Buffer.from(buddyObjectId(root, context.vaultId, plain)), Buffer.from(context.id)))
    throw new Error('Buddy object identity mismatch');
  return plain;
};

export const parseBuddyKeyring = (input: unknown, vaultId: string): BuddyKeyring => {
  const ring = input as BuddyKeyring;
  if (
    !ring ||
    ring.version !== 1 ||
    ring.vaultId !== vaultId ||
    !BUDDY_UUID.test(vaultId) ||
    !Number.isSafeInteger(ring.current) ||
    ring.current < 1 ||
    !ring.keys ||
    typeof ring.keys !== 'object' ||
    Array.isArray(ring.keys) ||
    Object.keys(ring.keys).length > 128 ||
    !ring.keys[ring.current] ||
    Object.entries(ring.keys).some(
      ([version, value]) =>
        !/^[1-9]\d{0,8}$/.test(version) ||
        typeof value !== 'string' ||
        !/^[\w-]{43}$/.test(value) ||
        Buffer.from(value, 'base64url').toString('base64url') !== value,
    )
  )
    throw new Error('Invalid Buddy recovery kit');
  return ring;
};

export const createBuddyKeyring = (vaultId: string): BuddyKeyring =>
  parseBuddyKeyring({ version: 1, vaultId, current: 1, keys: { 1: randomBytes(32).toString('base64url') } }, vaultId);

export type BuddyEscrow = { version: 1; vaultId: string; blob: string };
// Format 1 fixes scrypt N=32768/r=8/p=1 and AES-GCM: salt(16), nonce(12), ciphertext, tag(16).
const escrowKey = (passphrase: string, salt: Buffer) => {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024)
    throw new Error('Use a recovery passphrase of at least 12 characters and at most 1024 bytes');
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(passphrase, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
};
const escrowContext = (vaultId: string) => Buffer.from(`frameleaf-buddy-escrow/1/${vaultId}`);

/** This runs on the owner's Frameleaf server. Only the opaque result may be uploaded to Cloud. */
export const wrapBuddyKeyring = async (ring: BuddyKeyring, passphrase: string): Promise<BuddyEscrow> => {
  const plain = Buffer.from(JSON.stringify(parseBuddyKeyring(ring, ring.vaultId)));
  if (plain.length > 16 * 1024) throw new Error('Recovery kit exceeds escrow limit');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await escrowKey(passphrase, salt);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(escrowContext(ring.vaultId));
    return {
      version: 1,
      vaultId: ring.vaultId,
      blob: Buffer.concat([salt, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString(
        'base64url',
      ),
    };
  } finally {
    key.fill(0);
    plain.fill(0);
  }
};
export const unwrapBuddyKeyring = async (escrow: BuddyEscrow, passphrase: string): Promise<BuddyKeyring> => {
  if (
    escrow?.version !== 1 ||
    !BUDDY_UUID.test(escrow.vaultId) ||
    typeof escrow.blob !== 'string' ||
    escrow.blob.length > 32_768 ||
    !/^[\w-]+$/.test(escrow.blob)
  )
    throw new Error('Invalid encrypted recovery package');
  const bytes = Buffer.from(escrow.blob, 'base64url');
  if (bytes.length < 45 || bytes.length > 16 * 1024 + 44 || bytes.toString('base64url') !== escrow.blob)
    throw new Error('Invalid encrypted recovery package');
  const key = await escrowKey(passphrase, bytes.subarray(0, 16));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(16, 28));
    decipher.setAAD(escrowContext(escrow.vaultId));
    decipher.setAuthTag(bytes.subarray(-16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28, -16)), decipher.final()]);
    try {
      return parseBuddyKeyring(JSON.parse(plain.toString('utf8')), escrow.vaultId);
    } finally {
      plain.fill(0);
    }
  } finally {
    key.fill(0);
  }
};
