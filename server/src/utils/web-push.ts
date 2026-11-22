import { createCipheriv, createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes } from 'node:crypto';

/**
 * FL-926: Web Push message encryption (RFC 8291) in the aes128gcm content coding (RFC 8188), as
 * UnifiedPush distributors such as ntfy expect it.
 *
 * The device (user agent) gives this server its P-256 public key (`p256dh`, the 65-byte uncompressed
 * point, base64url) and a 16-byte authentication secret (`auth`, base64url). For each message the server:
 *
 * 1. makes a fresh ephemeral P-256 key pair and the shared secret `ECDH(ephemeral, p256dh)`;
 * 2. derives `IKM = HKDF-SHA256(salt = auth, ikm = shared, info = "WebPush: info" ‖ 0x00 ‖ p256dh ‖ ephemeral public, 32)`;
 * 3. picks a random 16-byte salt and derives `CEK = HKDF-SHA256(salt, IKM, "Content-Encoding: aes128gcm" ‖ 0x00, 16)`
 *    and `NONCE = HKDF-SHA256(salt, IKM, "Content-Encoding: nonce" ‖ 0x00, 12)`;
 * 4. encrypts `plaintext ‖ 0x02` (one, last, unpadded record) with AES-128-GCM;
 * 5. sends `salt (16) ‖ rs (uint32, 4096) ‖ idlen (1, 65) ‖ ephemeral public key (65) ‖ ciphertext ‖ tag (16)`.
 *
 * Only Node's own crypto is used. `encryptWebPush` takes an injected salt and ephemeral key so the
 * RFC 8291 section 5 test vector can be checked byte for byte.
 */
export const WEB_PUSH_RECORD_SIZE = 4096;
export const WEB_PUSH_SALT_BYTES = 16;
export const WEB_PUSH_AUTH_BYTES = 16;
export const WEB_PUSH_KEY_BYTES = 65;
const TAG_BYTES = 16;
const HEADER_BYTES = WEB_PUSH_SALT_BYTES + 4 + 1 + WEB_PUSH_KEY_BYTES;
/** UnifiedPush distributors must accept 4096-byte messages; this is the most plaintext that fits one. */
export const WEB_PUSH_MAX_PLAINTEXT_BYTES = 4096 - HEADER_BYTES - TAG_BYTES - 1;

const decode = (value: string) => Buffer.from(value.trim().replace(/=+$/, ''), 'base64url');

/** A device's `p256dh` key as raw bytes; throws unless it is an uncompressed point on P-256. */
export const parseWebPushPublicKey = (value: string): Buffer => {
  const raw = decode(value);
  if (raw.length !== WEB_PUSH_KEY_BYTES || raw[0] !== 0x04) {
    throw new Error('A UnifiedPush public key is the 65-byte uncompressed P-256 point (p256dh), base64url');
  }
  try {
    // throws for a point that is not on the curve
    createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: raw.subarray(1, 33).toString('base64url'),
        y: raw.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
  } catch {
    throw new Error('The UnifiedPush public key is not a P-256 point');
  }
  return raw;
};

/** A device's Web Push authentication secret as raw bytes; throws unless it is 16 bytes. */
export const parseWebPushAuth = (value: string): Buffer => {
  const raw = decode(value);
  if (raw.length !== WEB_PUSH_AUTH_BYTES) {
    throw new Error('A UnifiedPush auth secret is 16 bytes, base64url');
  }
  return raw;
};

const deriveKeys = (shared: Buffer, auth: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer) => {
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  return {
    key: Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'latin1'), 16)),
    nonce: Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'latin1'), 12)),
  };
};

export type WebPushKeys = { p256dh: string; auth: string };

/**
 * Encrypt `plaintext` to a device's Web Push keys; returns the aes128gcm message body. `options` is
 * for tests only: a fixed salt and the ephemeral (application server) private key.
 */
export const encryptWebPush = (
  plaintext: Buffer,
  keys: WebPushKeys,
  options: { salt?: Buffer; senderPrivateKey?: Buffer } = {},
): Buffer => {
  if (plaintext.length > WEB_PUSH_MAX_PLAINTEXT_BYTES) {
    throw new Error(`A UnifiedPush message holds at most ${WEB_PUSH_MAX_PLAINTEXT_BYTES} bytes`);
  }
  const uaPublic = parseWebPushPublicKey(keys.p256dh);
  const auth = parseWebPushAuth(keys.auth);
  const salt = options.salt ?? randomBytes(WEB_PUSH_SALT_BYTES);
  if (salt.length !== WEB_PUSH_SALT_BYTES) {
    throw new Error('The Web Push salt is 16 bytes');
  }
  const sender = createECDH('prime256v1');
  if (options.senderPrivateKey) {
    sender.setPrivateKey(options.senderPrivateKey);
  } else {
    sender.generateKeys();
  }
  const asPublic = sender.getPublicKey();
  const { key, nonce } = deriveKeys(sender.computeSecret(uaPublic), auth, uaPublic, asPublic, salt);

  const header = Buffer.alloc(HEADER_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(WEB_PUSH_RECORD_SIZE, WEB_PUSH_SALT_BYTES);
  header.writeUInt8(asPublic.length, WEB_PUSH_SALT_BYTES + 4);
  asPublic.copy(header, WEB_PUSH_SALT_BYTES + 5);

  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  // a single record, so it is the last one: the 0x02 delimiter and no padding
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([0x02])), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
};

/**
 * The device side of `encryptWebPush` (one record), with the device's P-256 private key: for tests and
 * the medium test against a real distributor.
 */
export const decryptWebPush = (body: Buffer, keys: { privateKey: Buffer; auth: string }): Buffer => {
  const salt = body.subarray(0, WEB_PUSH_SALT_BYTES);
  const idLength = body.readUInt8(WEB_PUSH_SALT_BYTES + 4);
  const asPublic = body.subarray(WEB_PUSH_SALT_BYTES + 5, WEB_PUSH_SALT_BYTES + 5 + idLength);
  const record = body.subarray(WEB_PUSH_SALT_BYTES + 5 + idLength);
  const device = createECDH('prime256v1');
  device.setPrivateKey(keys.privateKey);
  const { key, nonce } = deriveKeys(
    device.computeSecret(asPublic),
    parseWebPushAuth(keys.auth),
    device.getPublicKey(),
    asPublic,
    salt,
  );
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - TAG_BYTES));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - TAG_BYTES)), decipher.final()]);
  const end = padded.lastIndexOf(0x02);
  if (end === -1 || padded.subarray(end + 1).some((byte) => byte !== 0)) {
    throw new Error('Not a single final Web Push record');
  }
  return padded.subarray(0, end);
};
