import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type FrameleafKeySigner,
  type SnapshotDescriptor,
  boundTokenProblem,
  createDpopProof,
  dpopAth,
  ed25519Thumbprint,
  isNonceChallenge,
  isUsableNonce,
  jwsSigningInput,
  parseRecoveryCode,
  recoveryCode,
  scryptDerive,
  signSnapshotDescriptor,
  snapshotSignatureHolds,
  snapshotSigningInput,
  unwrapBucketKey,
  wrapBucketKey,
} from '../src/index.js';

const signer = (): FrameleafKeySigner => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const { x } = publicKey.export({ format: 'jwk' });
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: x! } as const;
  return {
    kid: ed25519Thumbprint(publicJwk),
    publicJwk,
    sign: (header, payload) => {
      const input = jwsSigningInput(header, payload);
      return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
    },
    signBytes: (data) => sign(null, data, privateKey),
  };
};

describe('the recovery code', () => {
  it('prints a key as FLRK groups and reads it back, however it was typed', () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => (index * 37 + 11) & 0xff));
    const code = recoveryCode(key);
    expect(code).toMatch(/^FLRK(-[\dA-HJKMNP-TV-Z]{4}){13}$/);
    expect(parseRecoveryCode(code)).toEqual(key);
    expect(parseRecoveryCode(code.toLowerCase().replaceAll('-', ' '))).toEqual(key);
    // letters people misread stand for the digits they look like
    expect(parseRecoveryCode(code.replaceAll('0', 'O').replaceAll('1', 'l'))).toEqual(key);
  });

  it('refuses a code that is short or holds a symbol outside the alphabet', () => {
    const code = recoveryCode(Buffer.alloc(32, 9));
    expect(parseRecoveryCode(code.slice(0, -5))).toBeNull();
    expect(parseRecoveryCode(code.replace(/.$/, 'U'))).toBeNull();
  });
});

describe('DPoP proofs', () => {
  it('binds a proof to the method, the address without its query, the token and the key', () => {
    const key = signer();
    const proof = createDpopProof(
      key,
      { htm: 'post', htu: 'https://api.example/v4/backup/grant?x=1#y', nonce: 'n-1', accessToken: 'token' },
      1_700_000_000_500,
    );
    const [header, payload, signature] = proof.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      typ: 'dpop+jwt',
      alg: 'EdDSA',
      jwk: key.publicJwk,
    });
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      htm: 'POST',
      htu: 'https://api.example/v4/backup/grant',
      iat: 1_700_000_000,
      nonce: 'n-1',
      ath: dpopAth('token'),
    });
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: key.publicJwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('knows a nonce challenge from a refusal, and a usable nonce from an unusable one', () => {
    expect(isNonceChallenge(401, null, 'DPoP error="use_dpop_nonce"')).toBe(true);
    expect(isNonceChallenge(400, 'use_dpop_nonce', null)).toBe(true);
    expect(isNonceChallenge(401, null, 'DPoP error="use_dpop_nonce_other"')).toBe(false);
    expect(isNonceChallenge(403, 'use_dpop_nonce', null)).toBe(false);
    expect(isUsableNonce('abc-123')).toBe(true);
    expect(isUsableNonce('has "quotes"')).toBe(false);
    expect(isUsableNonce('')).toBe(false);
  });

  it('refuses a token that is not bound to the key that asked for it', () => {
    const key = signer();
    const token = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    expect(boundTokenProblem({ access_token: token({ cnf: { jkt: key.kid } }), token_type: 'DPoP' }, key)).toBeNull();
    expect(boundTokenProblem({ access_token: token({ cnf: { jkt: key.kid } }), token_type: 'Bearer' }, key)).toMatch(
      /not DPoP/,
    );
    expect(boundTokenProblem({ access_token: token({ cnf: { jkt: 'other' } }), token_type: 'dpop' }, key)).toMatch(
      /cnf\.jkt/,
    );
  });
});

describe('key escrow', () => {
  it('derives keys as RFC 7914 scrypt does', async () => {
    // RFC 7914 section 12, the third vector
    const derived = await scryptDerive('pleaseletmein', Buffer.from('SodiumChloride'), {
      N: 16_384,
      r: 8,
      p: 1,
      keyLength: 64,
    });
    expect(derived.toString('hex')).toBe(
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
    );
  });

  it('opens with the passphrase and with nothing else', { timeout: 30_000 }, async () => {
    const key = Buffer.alloc(32, 7);
    const blob = await wrapBucketKey(key, 'correct horse battery staple');
    expect(JSON.stringify(blob)).not.toContain(key.toString('base64'));
    expect(await unwrapBucketKey(blob, 'correct horse battery staple')).toEqual(key);
    await expect(unwrapBucketKey(blob, 'correct horse battery stapler')).rejects.toThrow(/does not open/);
    await expect(wrapBucketKey(key, 'too short')).rejects.toThrow(/at least 12/);
  });
});

describe('the signed record of a backup', () => {
  const descriptor = (signerKid: string): SnapshotDescriptor => ({
    version: 2,
    instanceId: '0195a1b2-0000-7000-8000-000000000001',
    vaultId: '0195a1b2-0000-7000-8000-000000000002',
    snapshotId: '0195a1b2-0000-7000-8000-000000000003',
    sequence: 1,
    previousDigest: null,
    createdAt: '2026-11-17T00:00:00.000Z',
    manifest: {
      format: 'frameleaf-repository',
      formatVersion: 1,
      keyVersion: 1,
      objectKey: 'r/v1/0195a1b2-0000-7000-8000-000000000002/s/000000000001-0123456789abcdef',
      versionId: 'v1',
      ciphertextSha256: 'a'.repeat(64),
    },
    signerKid,
  });

  it('signs fixed bytes: a label, a newline, then the fields in the published order', () => {
    const bytes = snapshotSigningInput(descriptor('kid')).toString();
    expect(bytes.startsWith('frameleaf-backup-snapshot-v2\n{"version":2,"instanceId":')).toBe(true);
    expect(Object.keys(JSON.parse(bytes.slice(bytes.indexOf('\n') + 1)))).toEqual([
      'version',
      'instanceId',
      'vaultId',
      'snapshotId',
      'sequence',
      'previousDigest',
      'createdAt',
      'manifest',
      'signerKid',
    ]);
  });

  it('holds for the key that signed it, and for no other key or changed field', () => {
    const key = signer();
    const signed = { descriptor: descriptor(key.kid), ...signSnapshotDescriptor(descriptor(key.kid), key) };
    const pinned = { ...key.publicJwk, kid: key.kid };
    expect(signed.digest).toBe(createHash('sha256').update(snapshotSigningInput(signed.descriptor)).digest('hex'));
    expect(snapshotSignatureHolds(signed, pinned)).toBe(true);
    expect(snapshotSignatureHolds(signed, undefined)).toBe(false);
    const other = signer();
    expect(snapshotSignatureHolds(signed, { ...other.publicJwk, kid: other.kid })).toBe(false);
    expect(snapshotSignatureHolds({ ...signed, descriptor: { ...signed.descriptor, sequence: 2 } }, pinned)).toBe(
      false,
    );
    expect(() => signSnapshotDescriptor(descriptor('someone-else'), key)).toThrow(/signing identity/);
  });
});
