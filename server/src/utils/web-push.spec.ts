import { createECDH, randomBytes } from 'node:crypto';
import {
  WEB_PUSH_MAX_PLAINTEXT_BYTES,
  decryptWebPush,
  encryptWebPush,
  parseWebPushAuth,
  parseWebPushPublicKey,
} from 'src/utils/web-push.js';

/** RFC 8291 section 5 (and appendix A): the worked example, every value base64url. */
const RFC8291 = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b64 = (value: string) => Buffer.from(value, 'base64url');

const newDevice = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
};

describe('Web Push encryption (RFC 8291, aes128gcm)', () => {
  it('produces the RFC 8291 section 5 message byte for byte from its salt and keys', () => {
    const body = encryptWebPush(
      b64(RFC8291.plaintext),
      { p256dh: RFC8291.uaPublic, auth: RFC8291.auth },
      { salt: b64(RFC8291.salt), senderPrivateKey: b64(RFC8291.asPrivate) },
    );
    expect(body.toString('base64url')).toBe(RFC8291.message);
    // the header names the record size (4096) and the sender's public key
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body.subarray(21, 86).toString('base64url')).toBe(RFC8291.asPublic);
  });

  it('decrypts the RFC 8291 message with the user agent private key', () => {
    const plaintext = decryptWebPush(b64(RFC8291.message), { privateKey: b64(RFC8291.uaPrivate), auth: RFC8291.auth });
    expect(plaintext.toString('utf8')).toBe('When I grow up, I want to be a watermelon');
  });

  it('uses a fresh salt and sender key for every message', () => {
    const device = newDevice();
    const plaintext = Buffer.from('{"v":1}');
    const first = encryptWebPush(plaintext, device);
    const second = encryptWebPush(plaintext, device);
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false);
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false);
    expect(decryptWebPush(first, device).equals(plaintext)).toBe(true);
    expect(decryptWebPush(second, device).equals(plaintext)).toBe(true);
  });

  it('fits the largest message a distributor must accept, and refuses more', () => {
    const device = newDevice();
    const largest = encryptWebPush(Buffer.alloc(WEB_PUSH_MAX_PLAINTEXT_BYTES, 0x61), device);
    expect(largest.length).toBe(4096);
    expect(() => encryptWebPush(Buffer.alloc(WEB_PUSH_MAX_PLAINTEXT_BYTES + 1), device)).toThrow('at most');
  });

  it('refuses keys that are not a P-256 point or a 16-byte secret', () => {
    expect(parseWebPushPublicKey(RFC8291.uaPublic).length).toBe(65);
    expect(() => parseWebPushPublicKey(Buffer.alloc(32, 1).toString('base64url'))).toThrow('65-byte');
    expect(() =>
      parseWebPushPublicKey(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url')),
    ).toThrow('not a P-256 point');
    expect(parseWebPushAuth(RFC8291.auth).length).toBe(16);
    expect(() => parseWebPushAuth('AAAA')).toThrow('16 bytes');
  });

  it('fails to decrypt a message for another device', () => {
    const [device, other] = [newDevice(), newDevice()];
    const body = encryptWebPush(Buffer.from('secret'), device);
    expect(() => decryptWebPush(body, other)).toThrow();
  });
});
