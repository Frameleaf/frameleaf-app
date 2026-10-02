import { createHash, createPublicKey, verify } from 'node:crypto';
import z from 'zod';
import { type BuddySignedSnapshot, buddySnapshotBytes } from 'src/utils/buddy-backup-vault.js';
import { BuddyGrantClaims, BuddyGrantHeader } from 'src/utils/frameleaf-buddy.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

export const buddyCommitReceipt = (envelope: BuddySignedSnapshot) => ({
  snapshotId: envelope.snapshot.id,
  digest: createHash('sha256').update(buddySnapshotBytes(envelope.snapshot)).digest('hex'),
});
export const assertBuddyCommitReceipt = (reply: unknown, envelope: BuddySignedSnapshot) => {
  const expected = buddyCommitReceipt(envelope);
  const actual = reply as typeof expected | null;
  if (actual?.snapshotId !== expected.snapshotId || actual.digest !== expected.digest)
    throw new Error('Buddy acknowledged a different snapshot; this backup is incomplete');
};

const publicKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[\w-]{43}$/),
});
export const BuddyJwks = z.object({
  keys: z.array(publicKey.extend({ kid: z.string(), use: z.string().optional(), alg: z.string().optional() })).max(8),
});
const proofHeader = z.strictObject({ typ: z.literal('dpop+jwt'), alg: z.literal('EdDSA'), jwk: publicKey });
const proofClaims = z.strictObject({
  jti: z.string().min(1).max(128),
  htm: z.string().max(10),
  htu: z.url().max(4096),
  iat: z.number().int(),
  ath: z.string().regex(/^[\w-]{43}$/),
  nonce: z.string().max(128).optional(),
});

const decode = (token: string) => {
  if (token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('Invalid Buddy authorization');
  const [header, payload, signature] = token.split('.', 3);
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString()),
    input: Buffer.from(`${header}.${payload}`),
    signature: Buffer.from(signature, 'base64url'),
  };
};

/** JWT validation stays separate from live Cloud revocation checks and persistent request replay admission. */
export const verifyBuddyGrant = (token: string, jwks: z.infer<typeof BuddyJwks>, issuer: string, now = Date.now()) => {
  const jwt = decode(token);
  const header = BuddyGrantHeader.parse(jwt.header);
  const claims = BuddyGrantClaims.parse(jwt.payload);
  const key = jwks.keys.find((key) => key.kid === header.kid);
  if (
    !key ||
    claims.iss !== issuer ||
    claims.iat * 1000 > now + 30_000 ||
    claims.exp * 1000 <= now ||
    claims.cnf.jkt !== ed25519Thumbprint(claims.cnf.jwk) ||
    !verify(null, jwt.input, createPublicKey({ key, format: 'jwk' }), jwt.signature)
  )
    throw new Error('Buddy grant rejected');
  return claims;
};

export const verifyBuddyProof = (
  proof: string,
  token: string,
  grant: BuddyGrantClaims,
  method: string,
  uri: string,
  now = Date.now(),
) => {
  const jwt = decode(proof);
  const header = proofHeader.parse(jwt.header);
  const claims = proofClaims.parse(jwt.payload);
  const target = new URL(uri);
  target.hash = '';
  target.search = '';
  if (
    ed25519Thumbprint(header.jwk) !== grant.cnf.jkt ||
    claims.htm !== method ||
    claims.htu !== target.href ||
    Math.abs(claims.iat * 1000 - now) > 60_000 ||
    claims.ath !== createHash('sha256').update(token).digest('base64url') ||
    !verify(null, jwt.input, createPublicKey({ key: header.jwk, format: 'jwk' }), jwt.signature)
  )
    throw new Error('Buddy request proof rejected');
  return claims;
};

/** Receipts prove the pinned destination, even when Cloud supplies an untrusted connection candidate. */
export const verifyBuddyResponse = (
  proof: string,
  grant: BuddyGrantClaims,
  data: unknown,
  requestId: string,
  now = Date.now(),
) => {
  const jwt = decode(proof);
  const header = z.strictObject({ typ: z.literal('buddy-response+jwt'), alg: z.literal('EdDSA') }).parse(jwt.header);
  const claims = z
    .strictObject({
      vaultId: z.uuid(),
      grantId: z.uuid(),
      requestId: z.uuid(),
      digest: z.string().regex(/^[a-f\d]{64}$/),
      iat: z.number().int(),
      exp: z.number().int(),
    })
    .parse(jwt.payload);
  if (
    header.alg !== 'EdDSA' ||
    claims.vaultId !== grant.vaultId ||
    claims.grantId !== grant.jti ||
    claims.requestId !== requestId ||
    claims.exp !== grant.exp ||
    claims.exp * 1000 <= now ||
    Math.abs(claims.iat * 1000 - now) > 60_000 ||
    claims.digest !== createHash('sha256').update(JSON.stringify(data)).digest('hex') ||
    !verify(null, jwt.input, createPublicKey({ key: grant.destinationKey, format: 'jwk' }), jwt.signature)
  )
    throw new Error('Buddy destination proof rejected');
};
