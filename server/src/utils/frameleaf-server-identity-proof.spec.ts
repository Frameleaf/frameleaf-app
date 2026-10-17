import { BadRequestException } from '@nestjs/common';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  type IdentityOriginRequest,
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

  describe('the origin the request arrived on', () => {
    const secret = 'edge-secret-0123456789abcdef';
    /** A request after the real `frameleafViaMiddleware`, as the controller sees it. */
    const arrive = (headers: Record<string, string>, encrypted = false) => {
      const request = { headers: { ...headers }, socket: { encrypted } } as unknown as Request;
      const next = vi.fn();
      frameleafViaMiddleware(secret)(request, {} as Response, next);
      expect(next).toHaveBeenCalled();
      return identityRequestOrigin(request as unknown as IdentityOriginRequest);
    };

    it('signs the LAN Host as received, with the connection scheme', () => {
      expect(arrive({ host: '192.168.1.20:2283' })).toBe('http://192.168.1.20:2283');
      expect(arrive({ host: 'Frameleaf.Local' })).toBe('http://frameleaf.local');
      expect(arrive({ host: '[fe80::1]:2283' })).toBe('http://[fe80::1]:2283');
      expect(arrive({ host: 'photos.home.test' }, true)).toBe('https://photos.home.test');
    });

    it('signs the relay host and scheme the edge worker vouched for', () => {
      expect(
        arrive({
          host: '127.0.0.1:2283',
          'x-frameleaf-via': 'relay',
          'x-frameleaf-via-auth': secret,
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'abc123.relay.frameleaf.app',
        }),
      ).toBe('https://abc123.relay.frameleaf.app');
      expect(
        arrive({
          host: '127.0.0.1:2283',
          'x-frameleaf-via': 'wan',
          'x-frameleaf-via-auth': secret,
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'photos.example.com',
        }),
      ).toBe('https://photos.example.com');
    });

    it('ignores X-Forwarded-* from a peer the edge worker did not vouch for', () => {
      expect(
        arrive({
          host: '192.168.1.20:2283',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'attacker.example',
        }),
      ).toBe('http://192.168.1.20:2283');
    });

    it('refuses a Host that is missing or not a plain host', () => {
      for (const host of [undefined, '', 'evil|host', 'a b', 'x'.repeat(300)]) {
        expect(() => identityRequestOrigin({ headers: { host } })).toThrow(BadRequestException);
      }
      expect(() =>
        identityRequestOrigin({ headers: { host: 'a' }, frameleafForwarded: { proto: 'ftp', host: null } }),
      ).toThrow(BadRequestException);
    });
  });
});
