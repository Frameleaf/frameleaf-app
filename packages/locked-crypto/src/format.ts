import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from 'node:crypto';
import { type FileHandle, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

/*
 * Layout (spec §5; every integer big-endian):
 *   prefix:     magic "FLLK" | version u8 = 1 | flags u8 = 0 | plaintext length u64 | segment size u32
 *   recipients: count u8, then per recipient key id (8) | ephemeral X25519 public key (32) | wrapped file key (32 + 16)
 *   info:       length u32 | AES-256-GCM(info JSON) + tag
 *   segments:   AES-256-GCM(segment i) + tag, each SEGMENT_SIZE + 16 bytes, the last one shorter
 * The prefix is the HKDF salt for every key in the file, so it is authenticated by every tag. The
 * recipient list is outside the salt, which is what lets rewrapFile keep the segments byte-identical.
 */

export const LOCKED_MAGIC = 'FLLK';
export const SEGMENT_SIZE = 65_536;

export type LockedFileKind = 'original' | 'thumbnail' | 'preview' | 'fullsize' | 'encoded-video' | 'sidecar' | 'other';
export interface LockedFileInfo {
  assetId: string;
  kind: LockedFileKind;
  originalFileName: string;
  mime: string;
}
export interface Recipient {
  publicKey: Buffer;
}
export interface LockedHeader {
  version: 1;
  plaintextLength: number;
  keyIds: Buffer[];
  headerLength: number;
}

/** The secret (PIN, passphrase, recovery key or private key) does not open this key file or locked file. */
export class WrongSecretError extends Error {
  name = 'WrongSecretError';
}
/** The locked file is damaged, truncated, reordered or not a locked file at all. */
export class LockedFileCorruptError extends Error {
  name = 'LockedFileCorruptError';
}

const VERSION = 1;
const TAG = 16;
const SEALED_SEGMENT = SEGMENT_SIZE + TAG;
const PREFIX_LENGTH = 18;
const KEY_ID_LENGTH = 8;
const RECIPIENT_LENGTH = KEY_ID_LENGTH + 32 + 32 + TAG;
const MAX_INFO_LENGTH = 64 * 1024;
const ZERO_NONCE = Buffer.alloc(12);
const MAGIC = Buffer.from(LOCKED_MAGIC, 'latin1');
const COPY_CHUNK = 16 * SEALED_SEGMENT;

const hkdf = (key: Buffer, salt: Buffer, purpose: string) =>
  Buffer.from(hkdfSync('sha256', key, salt, `frameleaf-locked/1/${purpose}`, 32));

const seal = (key: Buffer, nonce: Buffer, plaintext: Buffer, aad?: Buffer) => {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad) cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
};

/** Returns the plaintext only after the tag has verified; throws otherwise. */
const unseal = (key: Buffer, nonce: Buffer, sealed: Buffer, aad?: Buffer) => {
  if (sealed.length < TAG) throw new Error('Sealed data is shorter than its tag');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(-TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, -TAG)), decipher.final()]);
};

const segmentNonce = (index: number) => {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
};

const segmentAad = (index: number, isLast: boolean) => {
  const aad = Buffer.alloc(9);
  aad.writeBigUInt64BE(BigInt(index), 0);
  aad[8] = isLast ? 1 : 0;
  return aad;
};

/** A file always has at least one segment (empty for an empty file), so dropping everything is detected. */
const segmentCount = (plaintextLength: number) => Math.max(1, Math.ceil(plaintextLength / SEGMENT_SIZE));
const segmentPlainLength = (plaintextLength: number, index: number) =>
  Math.min(SEGMENT_SIZE, plaintextLength - index * SEGMENT_SIZE);

// ---- X25519 keys ----

const assertRawKey = (key: Buffer, what: string) => {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(`${what} must be 32 raw bytes`);
};

const publicKeyObject = (publicKey: Buffer) => {
  assertRawKey(publicKey, 'X25519 public key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: publicKey.toString('base64url') }, format: 'jwk' });
};

// PKCS#8 wrapper for a raw X25519 private key (RFC 8410), used only to derive its public key.
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export const publicKeyFromPrivate = (privateKey: Buffer): Buffer => {
  assertRawKey(privateKey, 'X25519 private key');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519_PREFIX, privateKey]), format: 'der', type: 'pkcs8' });
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
};

const privateKeyObject = (privateKey: Buffer): KeyObject =>
  createPrivateKey({
    key: {
      kty: 'OKP',
      crv: 'X25519',
      x: publicKeyFromPrivate(privateKey).toString('base64url'),
      d: privateKey.toString('base64url'),
    },
    format: 'jwk',
  });

const sharedSecret = (privateKey: KeyObject, publicKey: Buffer) => {
  const secret = diffieHellman({ privateKey, publicKey: publicKeyObject(publicKey) });
  // A low-order public key gives an all-zero secret; never derive a key from it.
  if (secret.every((byte) => byte === 0)) throw new Error('Invalid X25519 public key');
  return secret;
};

export function generateKeyPair(): { publicKey: Buffer; privateKey: Buffer } {
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: Buffer.from(jwk.x!, 'base64url'), privateKey: Buffer.from(jwk.d!, 'base64url') };
}

export function keyId(publicKey: Buffer): Buffer {
  assertRawKey(publicKey, 'X25519 public key');
  return createHash('sha256').update(publicKey).digest().subarray(0, KEY_ID_LENGTH);
}

// ---- Header ----

interface ParsedRecipient {
  keyId: Buffer;
  ephemeral: Buffer;
  wrapped: Buffer;
}
interface ParsedHeader extends LockedHeader {
  prefix: Buffer;
  recipients: ParsedRecipient[];
  /** The info record exactly as stored: length u32 then ciphertext. */
  infoRecord: Buffer;
  infoCiphertext: Buffer;
}

const buildPrefix = (plaintextLength: number) => {
  const prefix = Buffer.alloc(PREFIX_LENGTH);
  MAGIC.copy(prefix, 0);
  prefix[4] = VERSION;
  prefix[5] = 0;
  prefix.writeBigUInt64BE(BigInt(plaintextLength), 6);
  prefix.writeUInt32BE(SEGMENT_SIZE, 14);
  return prefix;
};

const wrapAad = (recipient: { keyId: Buffer; ephemeral: Buffer }) =>
  Buffer.concat([recipient.keyId, recipient.ephemeral]);

const buildRecipients = (prefix: Buffer, fileKey: Buffer, recipients: Recipient[]) => {
  if (recipients.length === 0 || recipients.length > 255) throw new Error('A locked file needs 1 to 255 recipients');
  const entries = recipients.map(({ publicKey }) => {
    const id = keyId(publicKey);
    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPublic = Buffer.from(ephemeral.publicKey.export({ format: 'jwk' }).x!, 'base64url');
    const wrapKey = hkdf(sharedSecret(ephemeral.privateKey, publicKey), prefix, 'wrap');
    // Nonce 0 is safe: every wrap key comes from a fresh ephemeral key and is used once.
    const wrapped = seal(wrapKey, ZERO_NONCE, fileKey, wrapAad({ keyId: id, ephemeral: ephemeralPublic }));
    return Buffer.concat([id, ephemeralPublic, wrapped]);
  });
  return Buffer.concat([Buffer.from([recipients.length]), ...entries]);
};

const readFully = async (handle: FileHandle, length: number, position: number) => {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
};

const corrupt = (message: string) => new LockedFileCorruptError(message);

const parseHeader = async (handle: FileHandle): Promise<ParsedHeader> => {
  const fixed = await readFully(handle, PREFIX_LENGTH + 1, 0);
  if (fixed.length < PREFIX_LENGTH + 1 || !fixed.subarray(0, 4).equals(MAGIC)) throw corrupt('Not a locked file');
  if (fixed[4] !== VERSION) throw corrupt(`Unsupported locked file version ${fixed[4]}`);
  if (fixed[5] !== 0) throw corrupt('Unknown locked file flags');
  const length = fixed.readBigUInt64BE(6);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt('Locked file length is out of range');
  if (fixed.readUInt32BE(14) !== SEGMENT_SIZE) throw corrupt('Unsupported locked file segment size');
  const count = fixed[PREFIX_LENGTH]!;
  if (count === 0) throw corrupt('Locked file has no recipients');

  const listLength = count * RECIPIENT_LENGTH;
  const rest = await readFully(handle, listLength + 4, PREFIX_LENGTH + 1);
  if (rest.length < listLength + 4) throw corrupt('Locked file header is truncated');
  const recipients = Array.from({ length: count }, (_, index) => {
    const entry = rest.subarray(index * RECIPIENT_LENGTH, (index + 1) * RECIPIENT_LENGTH);
    return { keyId: entry.subarray(0, 8), ephemeral: entry.subarray(8, 40), wrapped: entry.subarray(40) };
  });
  const infoLength = rest.readUInt32BE(listLength);
  if (infoLength < TAG || infoLength > MAX_INFO_LENGTH) throw corrupt('Locked file info is out of range');
  const infoStart = PREFIX_LENGTH + 1 + listLength;
  const infoCiphertext = await readFully(handle, infoLength, infoStart + 4);
  if (infoCiphertext.length < infoLength) throw corrupt('Locked file header is truncated');

  return {
    version: VERSION,
    plaintextLength: Number(length),
    keyIds: recipients.map(({ keyId }) => Buffer.from(keyId)),
    headerLength: infoStart + 4 + infoLength,
    prefix: fixed.subarray(0, PREFIX_LENGTH),
    recipients,
    infoRecord: Buffer.concat([rest.subarray(listLength), infoCiphertext]),
    infoCiphertext,
  };
};

const expectedFileLength = (header: LockedHeader) =>
  header.headerLength + header.plaintextLength + segmentCount(header.plaintextLength) * TAG;

const assertFileLength = async (handle: FileHandle, header: LockedHeader) => {
  const { size } = await handle.stat();
  if (size !== expectedFileLength(header)) throw corrupt('Locked file is truncated or extended');
};

/** Finds this private key's recipient entry and returns the file key. */
const unwrapFileKey = (header: ParsedHeader, privateKey: Buffer) => {
  const id = keyId(publicKeyFromPrivate(privateKey));
  const recipient = header.recipients.find((entry) => entry.keyId.equals(id));
  if (!recipient) throw new WrongSecretError('This key is not a recipient of the locked file');
  try {
    const wrapKey = hkdf(sharedSecret(privateKeyObject(privateKey), recipient.ephemeral), header.prefix, 'wrap');
    return unseal(wrapKey, ZERO_NONCE, recipient.wrapped, wrapAad(recipient));
  } catch {
    // The key id matched, so a failed tag means the entry or prefix was altered (or a key id collision).
    throw corrupt('The locked file key does not authenticate');
  }
};

const openInfo = (header: ParsedHeader, fileKey: Buffer): LockedFileInfo => {
  try {
    return JSON.parse(unseal(hkdf(fileKey, header.prefix, 'info'), ZERO_NONCE, header.infoCiphertext).toString('utf8'));
  } catch {
    throw corrupt('Locked file info does not authenticate');
  }
};

const withHandle = async <T>(path: string, run: (handle: FileHandle) => Promise<T>) => {
  const handle = await open(path, 'r');
  try {
    return await run(handle);
  } finally {
    await handle.close();
  }
};

/**
 * Writes `dst` from `write`; on failure the partial file is removed. Synced before it resolves.
 * `dst` must not exist yet (it is created exclusively, so another writer's file is never truncated)
 * and must not be `src`. Callers replace a file through a temporary path of their own.
 */
const writeOutput = async <T>(src: string, dst: string, write: (handle: FileHandle) => Promise<T>) => {
  if (resolve(src) === resolve(dst)) throw new Error('The output path must differ from the input path');
  const handle = await open(dst, 'wx', 0o600);
  try {
    const result = await write(handle);
    await handle.sync();
    await handle.close();
    return result;
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(dst).catch(() => {});
    throw error;
  }
};

// ---- Public API ----

export async function isLockedFile(path: string): Promise<boolean> {
  return withHandle(path, async (handle) => (await readFully(handle, 4, 0)).equals(MAGIC));
}

export async function readHeader(path: string): Promise<LockedHeader> {
  const { version, plaintextLength, keyIds, headerLength } = await withHandle(path, parseHeader);
  return { version, plaintextLength, keyIds, headerLength };
}

/**
 * Re-reads a file this process just wrote and decrypts every segment with the file key it still
 * holds, so a sealer that has only public keys can prove the file opens. Returns the SHA-256 of the
 * decrypted bytes.
 */
const verifyWithFileKey = async (path: string, fileKey: Buffer, prefix: Buffer, info: LockedFileInfo) =>
  withHandle(path, async (handle) => {
    const header = await parseHeader(handle);
    if (!header.prefix.equals(prefix)) throw corrupt('The locked file prefix changed while it was written');
    await assertFileLength(handle, header);
    if (JSON.stringify(openInfo(header, fileKey)) !== JSON.stringify(info)) {
      throw corrupt('Locked file info does not match what was written');
    }
    const segmentKey = hkdf(fileKey, header.prefix, 'segment');
    const hash = createHash('sha256');
    try {
      const count = segmentCount(header.plaintextLength);
      for (let index = 0; index < count; index++) {
        const sealedLength = segmentPlainLength(header.plaintextLength, index) + TAG;
        const sealed = await readFully(handle, sealedLength, header.headerLength + index * SEALED_SEGMENT);
        if (sealed.length !== sealedLength) throw corrupt(`Locked file segment ${index} is truncated`);
        try {
          hash.update(unseal(segmentKey, segmentNonce(index), sealed, segmentAad(index, index === count - 1)));
        } catch {
          throw corrupt(`Locked file segment ${index} does not authenticate`);
        }
      }
    } finally {
      segmentKey.fill(0);
    }
    return hash.digest();
  });

/**
 * Encrypts `src` into `dst` (a different path; synced before it resolves).
 *
 * With `verify`, `dst` is read back and decrypted with the file key before the key is forgotten, and
 * the SHA-256 of what it decrypts to must equal the SHA-256 of the bytes read from `src`; otherwise
 * `dst` is removed and a `LockedFileCorruptError` is thrown. The digest is returned as `sha256`.
 */
export async function encryptFile(
  src: string,
  dst: string,
  recipients: Recipient[],
  info: LockedFileInfo,
  options: { verify?: boolean } = {},
): Promise<{ plaintextLength: number; sha256?: Buffer }> {
  return withHandle(src, async (input) => {
    const { size: plaintextLength } = await input.stat();
    const prefix = buildPrefix(plaintextLength);
    const fileKey = randomBytes(32);
    const segmentKey = hkdf(fileKey, prefix, 'segment');
    const sourceHash = createHash('sha256');
    let sha256: Buffer | undefined;
    try {
      const recipientList = buildRecipients(prefix, fileKey, recipients);
      const infoCiphertext = seal(hkdf(fileKey, prefix, 'info'), ZERO_NONCE, Buffer.from(JSON.stringify(info), 'utf8'));
      if (infoCiphertext.length > MAX_INFO_LENGTH) throw new Error('Locked file info is too long');
      const infoLength = Buffer.alloc(4);
      infoLength.writeUInt32BE(infoCiphertext.length);

      await writeOutput(src, dst, async (output) => {
        let position = 0;
        const write = async (bytes: Buffer) => {
          await output.write(bytes, 0, bytes.length, position);
          position += bytes.length;
        };
        await write(Buffer.concat([prefix, recipientList, infoLength, infoCiphertext]));
        const count = segmentCount(plaintextLength);
        for (let index = 0; index < count; index++) {
          const length = segmentPlainLength(plaintextLength, index);
          const plain = await readFully(input, length, index * SEGMENT_SIZE);
          if (plain.length !== length) throw new Error('Source file changed while it was being encrypted');
          sourceHash.update(plain);
          await write(seal(segmentKey, segmentNonce(index), plain, segmentAad(index, index === count - 1)));
        }
        if ((await readFully(input, 1, plaintextLength)).length > 0) {
          throw new Error('Source file changed while it was being encrypted');
        }
      });
      if (options.verify) {
        try {
          sha256 = await verifyWithFileKey(dst, fileKey, prefix, info);
          if (!sha256.equals(sourceHash.digest())) {
            throw corrupt('The locked file does not decrypt to its source');
          }
        } catch (error) {
          await unlink(dst).catch(() => {});
          throw error;
        }
      }
    } finally {
      fileKey.fill(0);
      segmentKey.fill(0);
    }
    return sha256 ? { plaintextLength, sha256 } : { plaintextLength };
  });
}

export async function openDecrypt(
  path: string,
  privateKey: Buffer,
  range?: { start: number; end: number },
): Promise<{ stream: NodeJS.ReadableStream; plaintextLength: number; info: LockedFileInfo }> {
  const handle = await open(path, 'r');
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= handle.close());
  try {
    const header = await parseHeader(handle);
    const { plaintextLength } = header;
    const start = range?.start ?? 0;
    const end = range?.end ?? plaintextLength - 1;
    if (
      range &&
      (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= plaintextLength)
    ) {
      throw new RangeError(`Range ${start}-${end} is outside 0-${plaintextLength - 1}`);
    }
    const fileKey = unwrapFileKey(header, privateKey);
    const info = openInfo(header, fileKey);
    const segmentKey = hkdf(fileKey, header.prefix, 'segment');
    fileKey.fill(0);

    const count = segmentCount(plaintextLength);
    const first = plaintextLength === 0 ? 0 : Math.floor(start / SEGMENT_SIZE);
    const last = plaintextLength === 0 ? 0 : Math.floor(end / SEGMENT_SIZE);

    async function* segments() {
      try {
        await assertFileLength(handle, header);
        for (let index = first; index <= last; index++) {
          const sealedLength = segmentPlainLength(plaintextLength, index) + TAG;
          const sealed = await readFully(handle, sealedLength, header.headerLength + index * SEALED_SEGMENT);
          if (sealed.length !== sealedLength) throw corrupt(`Locked file segment ${index} is truncated`);
          let plain: Buffer;
          try {
            plain = unseal(segmentKey, segmentNonce(index), sealed, segmentAad(index, index === count - 1));
          } catch {
            throw corrupt(`Locked file segment ${index} does not authenticate`);
          }
          const from = index === first ? start - index * SEGMENT_SIZE : 0;
          const to = index === last ? end - index * SEGMENT_SIZE + 1 : plain.length;
          if (to > from) yield plain.subarray(from, to);
        }
      } finally {
        segmentKey.fill(0);
        await close();
      }
    }

    const stream = Readable.from(segments(), { objectMode: false });
    // A stream destroyed before its first read never runs the generator's finally.
    stream.once('close', () => {
      segmentKey.fill(0);
      void close();
    });
    return { stream, plaintextLength, info };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function decryptFile(src: string, dst: string, privateKey: Buffer): Promise<LockedFileInfo> {
  const { stream, info } = await openDecrypt(src, privateKey);
  try {
    await writeOutput(src, dst, async (output) => {
      let position = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        await output.write(chunk, 0, chunk.length, position);
        position += chunk.length;
      }
    });
  } finally {
    (stream as Readable).destroy();
  }
  return info;
}

export async function rewrapFile(src: string, dst: string, privateKey: Buffer, recipients: Recipient[]): Promise<void> {
  await withHandle(src, async (input) => {
    const header = await parseHeader(input);
    await assertFileLength(input, header);
    const fileKey = unwrapFileKey(header, privateKey);
    try {
      openInfo(header, fileKey);
      const newHeader = Buffer.concat([
        header.prefix,
        buildRecipients(header.prefix, fileKey, recipients),
        header.infoRecord,
      ]);
      await writeOutput(src, dst, async (output) => {
        await output.write(newHeader, 0, newHeader.length, 0);
        // The segments are copied as stored, a few at a time.
        const total = expectedFileLength(header) - header.headerLength;
        for (let offset = 0; offset < total; offset += COPY_CHUNK) {
          const chunk = await readFully(input, Math.min(COPY_CHUNK, total - offset), header.headerLength + offset);
          await output.write(chunk, 0, chunk.length, newHeader.length + offset);
        }
      });
    } finally {
      fileKey.fill(0);
    }
  });
}

export async function verifyFile(path: string, privateKey: Buffer): Promise<void> {
  const { stream } = await openDecrypt(path, privateKey);
  for await (const _chunk of stream) {
    // Each segment authenticates as it is read; the bytes are discarded.
  }
}
