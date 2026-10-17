import { BadRequestException } from '@nestjs/common';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  assertIdentityNonce,
  identityRequestOrigin,
  lanIdentityPayload,
  signLanIdentity,
  verifyLanIdentity,
} from 'src/utils/frameleaf-server-identity-proof.js';

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' }) as { x: string };
  const jwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x };
  const kid = ed25519Thumbprint(jwk);
  return { pinned: { kid, jwk }, signer: { kid, signBytes: (data: Buffer) => sign(null, data, privateKey) } };
};

const claims = {
  instanceId: '018f5e7a-6b1e-7f6e-9c2e-1a2b3c4d5e6f',
  nonce: 'bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U',
  iat: 1_760_000_000,
  origin: 'http://192.168.1.20:2283',
};

describe('LAN identity proof (FL-430)', () => {
  it('signs a compact EdDSA JWS with the agreed header and pipe payload', () => {
    const { pinned, signer } = keyPair();
    const jws = signLanIdentity(signer, claims);
    const [header, payload] = jws.split('.', 2);
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'frameleaf-lan-identity+jwt',
      kid: pinned.kid,
    });
    expect(Buffer.from(payload, 'base64url').toString()).toBe(
      'frameleaf-lan-identity-v1|018f5e7a-6b1e-7f6e-9c2e-1a2b3c4d5e6f|bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U|1760000000|http://192.168.1.20:2283',
    );
    expect(lanIdentityPayload(claims)).toBe(Buffer.from(payload, 'base64url').toString());
    expect(verifyLanIdentity(jws, [pinned])).toEqual(claims);
  });

  it('verifies with the published raw public key, independent of the helper', () => {
    const { pinned, signer } = keyPair();
    const [header, payload, signature] = signLanIdentity(signer, claims).split('.', 3);
    const key = createPublicKey({ key: pinned.jwk, format: 'jwk' });
    expect(Buffer.from(pinned.jwk.x, 'base64url')).toHaveLength(32);
    expect(verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('fails for a tampered nonce, origin, instance id or an unpinned key', () => {
    const { pinned, signer } = keyPair();
    const jws = signLanIdentity(signer, claims);
    const [header, , signature] = jws.split('.', 3);
    const forge = (changes: Partial<typeof claims>) =>
      `${header}.${Buffer.from(lanIdentityPayload({ ...claims, ...changes })).toString('base64url')}.${signature}`;
    expect(verifyLanIdentity(forge({ nonce: 'b3RoZXItbm9uY2Utb3RoZXItbm9uY2U' }), [pinned])).toBeNull();
    expect(verifyLanIdentity(forge({ origin: 'http://192.168.1.99:2283' }), [pinned])).toBeNull();
    expect(verifyLanIdentity(forge({ instanceId: 'someone-else' }), [pinned])).toBeNull();
    expect(verifyLanIdentity(jws, [keyPair().pinned])).toBeNull();
  });

  it('rejects oversized, undersized and non-base64url nonces', () => {
    expect(assertIdentityNonce('a'.repeat(22))).toBe('a'.repeat(22));
    expect(assertIdentityNonce('a'.repeat(128))).toBe('a'.repeat(128));
    for (const bad of [
      'a'.repeat(21),
      'a'.repeat(129),
      `${'a'.repeat(22)}|x`,
      `${'a'.repeat(22)}=`,
      'a b'.repeat(10),
      42,
    ]) {
      expect(() => assertIdentityNonce(bad)).toThrow(BadRequestException);
    }
  });

  it('takes the origin from the connection, or from the edge worker when it vouched for the request', () => {
    expect(identityRequestOrigin({ protocol: 'http', host: '192.168.1.20:2283' })).toBe('http://192.168.1.20:2283');
    expect(identityRequestOrigin({ protocol: 'http', host: 'Frameleaf.Local' })).toBe('http://frameleaf.local');
    expect(identityRequestOrigin({ protocol: 'http', host: '[fe80::1]:2283' })).toBe('http://[fe80::1]:2283');
    expect(
      identityRequestOrigin({
        protocol: 'http',
        host: '127.0.0.1:2283',
        forwarded: { proto: 'https', host: 'home.example.com' },
      }),
    ).toBe('https://home.example.com');
    for (const host of [undefined, '', 'evil|host', 'a b', 'x'.repeat(300)]) {
      expect(() => identityRequestOrigin({ protocol: 'http', host })).toThrow(BadRequestException);
    }
    expect(() => identityRequestOrigin({ protocol: 'ftp', host: 'a' })).toThrow(BadRequestException);
  });
});
