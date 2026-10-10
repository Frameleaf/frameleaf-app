import { generateKeyPairSync } from 'node:crypto';
import {
  PUSH_ENVELOPE_INFO,
  PUSH_ENVELOPE_VERSION,
  openPushEnvelope,
  parsePushPublicKey,
  pushKeyFingerprint,
  sealPushEnvelope,
} from 'src/utils/push-crypto.js';

/** A device's X25519 key pair, as the native app would create it (raw 32-byte public key, base64url). */
const newDeviceKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { publicKey: x, privateKey };
};

describe('push payload encryption (FL-228)', () => {
  it('seals a payload only the device key opens', () => {
    const device = newDeviceKey();
    const plaintext = JSON.stringify({ type: 'memories', title: 'New memories' });

    const blob = sealPushEnvelope(device.publicKey, Buffer.from(plaintext));

    expect(blob).toMatch(/^[\w-]+$/);
    expect(blob).not.toContain('memories');
    expect(Buffer.from(blob, 'base64url').toString('latin1')).not.toContain('memories');
    expect(Buffer.from(blob, 'base64url')[0]).toBe(PUSH_ENVELOPE_VERSION);
    expect(openPushEnvelope(device.privateKey, device.publicKey, blob).toString()).toBe(plaintext);
  });

  it('uses a fresh ephemeral key and nonce for every payload', () => {
    const device = newDeviceKey();
    const first = sealPushEnvelope(device.publicKey, Buffer.from('same'));
    const second = sealPushEnvelope(device.publicKey, Buffer.from('same'));

    expect(first).not.toBe(second);
    expect(Buffer.from(first, 'base64url').subarray(1, 33)).not.toEqual(
      Buffer.from(second, 'base64url').subarray(1, 33),
    );
  });

  it('refuses a blob opened with another device key or changed in transit', () => {
    const device = newDeviceKey();
    const other = newDeviceKey();
    const blob = sealPushEnvelope(device.publicKey, Buffer.from('secret'));

    expect(() => openPushEnvelope(other.privateKey, other.publicKey, blob)).toThrow();

    const tampered = Buffer.from(blob, 'base64url');
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => openPushEnvelope(device.privateKey, device.publicKey, tampered.toString('base64url'))).toThrow();
  });

  it('accepts only a raw 32-byte X25519 public key in base64url', () => {
    const device = newDeviceKey();

    expect(parsePushPublicKey(device.publicKey)).toBe(device.publicKey);
    expect(parsePushPublicKey(Buffer.from(device.publicKey, 'base64url').toString('base64'))).toBe(device.publicKey);
    expect(() => parsePushPublicKey('')).toThrow();
    expect(() => parsePushPublicKey(Buffer.alloc(31, 7).toString('base64url'))).toThrow();
    expect(() => parsePushPublicKey(Buffer.alloc(33, 7).toString('base64url'))).toThrow();
    expect(() => parsePushPublicKey('not a key!')).toThrow();
  });

  it('refuses a low-order public key that would make the shared secret all zeros', () => {
    expect(() => sealPushEnvelope(Buffer.alloc(32).toString('base64url'), Buffer.from('x'))).toThrow();
  });

  it('fingerprints a key without revealing it', () => {
    const device = newDeviceKey();
    const fingerprint = pushKeyFingerprint(device.publicKey);

    expect(fingerprint).toMatch(/^[\da-f]{16}$/);
    expect(fingerprint).toBe(pushKeyFingerprint(device.publicKey));
    expect(fingerprint).not.toBe(pushKeyFingerprint(newDeviceKey().publicKey));
  });

  it('names the scheme in the key derivation', () => {
    expect(PUSH_ENVELOPE_INFO).toBe('frameleaf-push-v1');
  });
});
