import {
  KeyObject,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/**
 * FL-228: the end-to-end encryption of push payloads ("frameleaf-push-v1").
 *
 * Every registered device holds an X25519 key pair and gives this server only its raw 32-byte public key
 * (base64url; CryptoKit `Curve25519.KeyAgreement.PublicKey.rawRepresentation`, or the Android Keystore /
 * Tink equivalent). For each payload the server:
 *
 * 1. makes a fresh ephemeral X25519 key pair and the shared secret `X25519(ephemeral, device)`;
 * 2. derives a 32-byte key with HKDF-SHA256: `ikm` = the shared secret, `salt` = ephemeral public key ‖
 *    device public key (raw bytes), `info` = `"frameleaf-push-v1"`;
 * 3. encrypts with AES-256-GCM under a random 96-bit nonce, with `version ‖ ephemeral public key` as the
 *    additional authenticated data;
 * 4. sends `base64url(version (1 byte, 0x01) ‖ ephemeral public key (32) ‖ nonce (12) ‖ ciphertext ‖ tag (16))`.
 *
 * The push gateway, APNs and FCM only ever see that opaque blob. The device's Notification Service
 * Extension (iOS) or messaging service (Android) reverses the steps with its private key.
 */
export const PUSH_ENVELOPE_VERSION = 0x01;
export const PUSH_ENVELOPE_INFO = 'frameleaf-push-v1';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + KEY_BYTES;

const decodeKey = (value: string): Buffer => {
  const trimmed = value.trim();
  if (!/^[\w+/-]+={0,2}$/.test(trimmed)) {
    throw new Error('A push public key is base64url');
  }
  const raw = Buffer.from(trimmed.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''), 'base64url');
  if (raw.length !== KEY_BYTES) {
    throw new Error(`A push public key is a raw ${KEY_BYTES}-byte X25519 key`);
  }
  return raw;
};

const toKeyObject = (raw: Buffer): KeyObject =>
  createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });

const rawOf = (key: KeyObject): Buffer => Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');

const deriveKey = (shared: Buffer, ephemeral: Buffer, device: Buffer): Buffer => {
  if (shared.every((byte) => byte === 0)) {
    // a low-order device key; no payload is ever sealed to it
    throw new Error('The push public key is not usable');
  }
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, device]), PUSH_ENVELOPE_INFO, KEY_BYTES));
};

/**
 * A device's public key in its canonical form (unpadded base64url of the raw 32 bytes); throws for
 * anything else. Standard base64 is accepted and normalised.
 */
export const parsePushPublicKey = (value: string): string => {
  const raw = decodeKey(value);
  toKeyObject(raw);
  return raw.toString('base64url');
};

/** A short, stable fingerprint of a device key, for display; never the key itself. */
export const pushKeyFingerprint = (publicKey: string): string =>
  createHash('sha256').update(decodeKey(publicKey)).digest('hex').slice(0, 16);

/** Encrypt `plaintext` to the device key `publicKey` (base64url raw X25519); returns the opaque blob. */
export const sealPushEnvelope = (publicKey: string, plaintext: Buffer): string => {
  const deviceRaw = decodeKey(publicKey);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawOf(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: toKeyObject(deviceRaw) });
  const key = deriveKey(shared, ephemeralRaw, deviceRaw);
  const header = Buffer.concat([Buffer.from([PUSH_ENVELOPE_VERSION]), ephemeralRaw]);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, ciphertext, cipher.getAuthTag()]).toString('base64url');
};

/**
 * The device side of `sealPushEnvelope`, for tests and the reference implementation the native apps
 * follow. Throws when the blob was not sealed to this key or was changed.
 */
export const openPushEnvelope = (privateKey: KeyObject, publicKey: string, blob: string): Buffer => {
  const bytes = Buffer.from(blob, 'base64url');
  if (bytes.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES || bytes[0] !== PUSH_ENVELOPE_VERSION) {
    throw new Error('Not a frameleaf-push-v1 envelope');
  }
  const header = bytes.subarray(0, HEADER_BYTES);
  const ephemeralRaw = bytes.subarray(1, HEADER_BYTES);
  const nonce = bytes.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const ciphertext = bytes.subarray(HEADER_BYTES + NONCE_BYTES, bytes.length - TAG_BYTES);
  const shared = diffieHellman({ privateKey, publicKey: toKeyObject(Buffer.from(ephemeralRaw)) });
  const key = deriveKey(shared, Buffer.from(ephemeralRaw), decodeKey(publicKey));
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};
