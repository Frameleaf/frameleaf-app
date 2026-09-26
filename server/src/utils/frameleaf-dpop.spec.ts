import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base64url, ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import {
  Ed25519PublicJwk,
  FrameleafKeySigner,
  boundTokenProblem,
  createDpopProof,
  dpopAth,
  dpopHtu,
  isNonceChallenge,
  isUsableNonce,
  jwsSigningInput,
  signClientAssertion,
} from 'src/utils/frameleaf-dpop.js';

/** A signer over a fresh Ed25519 key, built the way `InstanceIdentityRepository` builds one. */
const newSigner = (): FrameleafKeySigner => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const publicJwk: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: jwk.x! };
  return {
    kid: ed25519Thumbprint(publicJwk),
    publicJwk,
    sign: (header, payload) => {
      const input = jwsSigningInput(header, payload);
      return `${input}.${base64url(sign(null, Buffer.from(input), privateKey))}`;
    },
  };
};

const decode = (jws: string) => {
  const [header, payload, signature] = jws.split('.', 3);
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    input: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
};

const token = (claims: Record<string, unknown>) =>
  `${base64url(JSON.stringify({ alg: 'EdDSA', typ: 'at+jwt' }))}.${base64url(JSON.stringify(claims))}.c2ln`;

describe('DPoP for Frameleaf Cloud instance tokens (FL-178)', () => {
  describe('dpopHtu', () => {
    it.each([
      ['https://api.frameleaf.cloud/v1/instance/heartbeat', 'https://api.frameleaf.cloud/v1/instance/heartbeat'],
      [
        'https://ml.eu.frameleaf.cloud/v2/usage?since=2026-09-01T00:00:00.000Z',
        'https://ml.eu.frameleaf.cloud/v2/usage',
      ],
      ['https://api.frameleaf.cloud/v1/instances#fragment', 'https://api.frameleaf.cloud/v1/instances'],
      ['https://api.frameleaf.cloud/v1/x?a=1#b', 'https://api.frameleaf.cloud/v1/x'],
      ['HTTPS://API.Frameleaf.Cloud/v1/Instances', 'https://api.frameleaf.cloud/v1/Instances'],
      ['https://api.frameleaf.cloud:443/v1/instances', 'https://api.frameleaf.cloud/v1/instances'],
      ['http://127.0.0.1:80/id/token', 'http://127.0.0.1/id/token'],
      ['http://127.0.0.1:8443/id/token', 'http://127.0.0.1:8443/id/token'],
      ['https://id.frameleaf.cloud', 'https://id.frameleaf.cloud/'],
    ])('%s → %s (scheme, host, non-default port and path only)', (url, htu) => {
      expect(dpopHtu(url)).toBe(htu);
    });
  });

  describe('dpopAth', () => {
    it('is base64url(SHA-256(token)), matching the RFC 9449 section 7.1 example', () => {
      expect(dpopAth('Kz~8mXK1EalYznwH-LC-1fBAo.4Ljp~zsPE_NeO.gxU')).toBe(
        'fUHyO2r2Z3DZ53EsNrWBb0xWXoaNy59IiKCAqksmQEo',
      );
    });
  });

  describe('createDpopProof', () => {
    it('has the RFC 9449 header (typ, alg, the public jwk, no kid) and the proof claims, and verifies', () => {
      const signer = newSigner();
      const now = Date.parse('2026-09-25T12:00:00.000Z');
      const proof = createDpopProof(
        signer,
        { htm: 'post', htu: 'https://api.frameleaf.cloud/v1/instance/heartbeat?x=1', nonce: 'n-1', accessToken: 'tok' },
        now,
      );
      const { header, claims, input, signature } = decode(proof);

      expect(header).toEqual({ typ: 'dpop+jwt', alg: 'EdDSA', jwk: signer.publicJwk });
      expect(Object.keys(header)).toEqual(['typ', 'alg', 'jwk']);
      expect(header.jwk).not.toHaveProperty('d');
      expect(header).not.toHaveProperty('kid');
      expect(claims).toEqual({
        jti: expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/),
        htm: 'POST',
        htu: 'https://api.frameleaf.cloud/v1/instance/heartbeat',
        iat: now / 1000,
        nonce: 'n-1',
        ath: dpopAth('tok'),
      });
      expect(ed25519Thumbprint(header.jwk)).toBe(signer.kid);
      expect(verify(null, Buffer.from(input), createPublicKey({ key: header.jwk, format: 'jwk' }), signature)).toBe(
        true,
      );
    });

    it('leaves out nonce and ath when there are none (the token request, the registration)', () => {
      const { claims } = decode(
        createDpopProof(newSigner(), { htm: 'POST', htu: 'https://id.frameleaf.cloud/token' }, 1_790_000_000_500),
      );
      expect(Object.keys(claims)).toEqual(['jti', 'htm', 'htu', 'iat']);
      expect(claims.iat).toBe(1_790_000_000);
    });

    it('uses a new jti for every proof', () => {
      const signer = newSigner();
      const jtis = new Set(
        Array.from(
          { length: 5 },
          () => decode(createDpopProof(signer, { htm: 'GET', htu: 'https://a.test/' })).claims.jti,
        ),
      );
      expect(jtis.size).toBe(5);
    });

    it('names the key the way the cloud’s golden fixtures do (RFC 7638 thumbprint)', () => {
      // packages/contracts fixtures/instance/register-request.json and key-rotation-current-key.json (FC-19)
      expect(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' })).toBe(
        'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
      );
      expect(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: 'o7NuAXIPASVvlfU7leN7DU1IVgnXJ-7YEYk5tI4qK5A' })).toBe(
        'KOSPDuCOuFIhcpdpJ7gqHzUXwKYSaDJ2C6BuRLLB18Y',
      );
    });
  });

  describe('signClientAssertion', () => {
    it('is signed by the same key as the proofs, with the key’s kid in the header', () => {
      const signer = newSigner();
      const assertion = decode(signClientAssertion(signer, { iss: 'i', sub: 'i' }));
      const proof = decode(createDpopProof(signer, { htm: 'POST', htu: 'https://id.test/token' }));
      expect(assertion.header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: signer.kid });
      expect(ed25519Thumbprint(proof.header.jwk)).toBe(assertion.header.kid);
      expect(
        verify(
          null,
          Buffer.from(assertion.input),
          createPublicKey({ key: proof.header.jwk, format: 'jwk' }),
          assertion.signature,
        ),
      ).toBe(true);
    });
  });

  describe('isNonceChallenge', () => {
    it.each([
      [400, 'use_dpop_nonce', null, true],
      [401, 'use_dpop_nonce', null, true],
      [
        401,
        undefined,
        'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"',
        true,
      ],
      [401, undefined, 'DPoP algs="EdDSA", error="use_dpop_nonce"', true],
      [401, 'invalid_dpop_proof', 'DPoP error="invalid_dpop_proof"', false],
      [401, undefined, 'DPoP error=use_dpop_nonce', false],
      [401, undefined, 'DPoP error="use_dpop_nonce_later"', false],
      [401, 'invalid_token', null, false],
      [403, 'use_dpop_nonce', null, false],
      [500, 'use_dpop_nonce', null, false],
    ])('%s %s %s → %s', (status, code, header, expected) => {
      expect(isNonceChallenge(status, code, header)).toBe(expected);
    });
  });

  describe('isUsableNonce', () => {
    it.each([
      // RFC 9449 section 8 example
      'eyJ7S_zG.eyJH0-Z.HX4w-7v',
      // 32 random bytes, base64url, with - and _
      'hJ3k-Qx_9vLm2Rt8Yw-Pz_0aB1cD2eF3gH4iJ5kL6mN',
      '-_-_',
      'a',
      '!',
      '~',
      'nonce]with[brackets',
      '#$%&()*+,/:;<=>?@^`{|}',
      'x'.repeat(512),
    ])('keeps the NQCHAR nonce %s', (nonce) => {
      expect(isUsableNonce(nonce)).toBe(true);
    });

    it.each([
      ['a quote', 'quote"d'],
      ['a backslash', String.raw`back\slash`],
      ['a space', 'has space'],
      ['a tab', 'tab\there'],
      ['a non-ASCII character', 'caf\u00E9'],
      ['a DEL', 'del\u007F'],
      ['an empty value', ''],
      ['more than 512 characters', 'x'.repeat(513)],
    ])('ignores a nonce with %s', (_reason, nonce) => {
      expect(isUsableNonce(nonce)).toBe(false);
    });

    it('ignores a missing nonce', () => {
      expect(isUsableNonce(null)).toBe(false);
      expect(isUsableNonce(undefined)).toBe(false);
    });
  });

  describe('boundTokenProblem', () => {
    const signer = newSigner();

    it('accepts a DPoP token bound to the signing key', () => {
      const accessToken = token({ cnf: { jkt: signer.kid }, frameleaf_kid: signer.kid });
      expect(boundTokenProblem({ access_token: accessToken, token_type: 'DPoP' }, signer)).toBeNull();
      expect(boundTokenProblem({ access_token: accessToken, token_type: 'dpop' }, signer)).toBeNull();
      // frameleaf_kid is checked when the cloud sends it
      expect(
        boundTokenProblem({ access_token: token({ cnf: { jkt: signer.kid } }), token_type: 'DPoP' }, signer),
      ).toBeNull();
    });

    it('refuses a bearer token or a missing token type', () => {
      const accessToken = token({ cnf: { jkt: signer.kid } });
      expect(boundTokenProblem({ access_token: accessToken, token_type: 'Bearer' }, signer)).toMatch(/not DPoP/);
      expect(boundTokenProblem({ access_token: accessToken }, signer)).toMatch(/missing/);
    });

    it('refuses a token bound to another key, or minted for another key', () => {
      const other = newSigner();
      expect(
        boundTokenProblem({ access_token: token({ cnf: { jkt: other.kid } }), token_type: 'DPoP' }, signer),
      ).toMatch(/cnf\.jkt/);
      expect(
        boundTokenProblem(
          { access_token: token({ cnf: { jkt: signer.kid }, frameleaf_kid: other.kid }), token_type: 'DPoP' },
          signer,
        ),
      ).toMatch(/frameleaf_kid/);
      expect(boundTokenProblem({ access_token: token({}), token_type: 'DPoP' }, signer)).toMatch(/cnf\.jkt/);
    });

    it('refuses a token it cannot read', () => {
      expect(boundTokenProblem({ access_token: 'opaque', token_type: 'DPoP' }, signer)).toMatch(/not a JWT/);
      expect(boundTokenProblem({ access_token: 'a.!!!.c', token_type: 'DPoP' }, signer)).toMatch(/not a JWT/);
    });
  });
});
