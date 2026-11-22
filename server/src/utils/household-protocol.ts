import { createHash, createPublicKey, verify } from 'node:crypto';
import z from 'zod';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { BuddyJwks, decode, verifyBuddyProof } from 'src/utils/buddy-backup-protocol.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { HouseholdGrantClaims, HouseholdGrantHeader } from 'src/utils/frameleaf-household.js';

/** Linked Households (FL-952): the signed-request protocol between two linked servers, beside Buddy Backup's. */
export const HOUSEHOLD_PROTOCOL_VERSION = 1;
export const HOUSEHOLD_RESPONSE_TYPE = 'household-response+jwt';
/** The largest original this server accepts from another household (design section 8; no setting in version 1). */
export const HOUSEHOLD_MAX_ORIGINAL_BYTES = 20 * 1024 ** 3;
export const HouseholdJwks = BuddyJwks;

const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const ed25519 = (x: string) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });

/** The grant's own claims only. The caller still binds it to a link, asks Cloud, and admits the proof once. */
export const verifyHouseholdGrant = (
  token: string,
  jwks: z.infer<typeof HouseholdJwks>,
  issuer: string,
  now = Date.now(),
) => {
  const jwt = decode(token);
  const header = HouseholdGrantHeader.parse(jwt.header);
  // strict: `aud`, the 300 s lifetime and `sub` are part of the schema
  const claims = HouseholdGrantClaims.parse(jwt.payload);
  const key = jwks.keys.find((key) => key.kid === header.kid);
  if (
    !key ||
    claims.iss !== issuer ||
    claims.iat * 1000 > now + 30_000 ||
    claims.exp * 1000 <= now ||
    claims.cnf.jkt !== ed25519Thumbprint(claims.cnf.jwk) ||
    !verify(null, jwt.input, ed25519(key.x), jwt.signature)
  )
    throw new Error('Household grant rejected');
  return claims;
};

/** The request proof: made with the key the grant is bound to, for this method, this address and this grant. */
export const verifyHouseholdProof = (
  proof: string,
  token: string,
  grant: HouseholdGrantClaims,
  method: string,
  uri: string,
  now = Date.now(),
) => verifyBuddyProof(proof, token, grant, method, uri, now);

type ReplyGrant = Pick<HouseholdGrantClaims, 'linkId' | 'jti' | 'exp'>;

export const signHouseholdResponse = (
  signer: FrameleafKeySigner,
  grant: ReplyGrant,
  requestId: string,
  data: unknown,
) => ({
  data,
  proof: signer.sign(
    { typ: HOUSEHOLD_RESPONSE_TYPE, alg: 'EdDSA' },
    {
      linkId: grant.linkId,
      grantId: grant.jti,
      requestId,
      digest: digest(data),
      iat: Math.floor(Date.now() / 1000),
      exp: grant.exp,
    },
  ),
});

/**
 * A reply is accepted only when signed by the key stored for the peer at pairing, which must also be the key
 * the grant names: Cloud supplies the addresses, so whoever answers at one proves it is the linked server.
 */
export const verifyHouseholdResponse = (
  proof: string,
  grant: ReplyGrant & Pick<HouseholdGrantClaims, 'destinationKey'>,
  peerPublicKey: string,
  data: unknown,
  requestId: string,
  now = Date.now(),
) => {
  const jwt = decode(proof);
  z.strictObject({ typ: z.literal(HOUSEHOLD_RESPONSE_TYPE), alg: z.literal('EdDSA') }).parse(jwt.header);
  const claims = z
    .strictObject({
      linkId: z.uuid(),
      grantId: z.uuid(),
      requestId: z.string().min(1).max(128),
      digest: z.string().regex(/^[a-f\d]{64}$/),
      iat: z.number().int(),
      exp: z.number().int(),
    })
    .parse(jwt.payload);
  if (
    grant.destinationKey.x !== peerPublicKey ||
    claims.linkId !== grant.linkId ||
    claims.grantId !== grant.jti ||
    claims.requestId !== requestId ||
    claims.exp !== grant.exp ||
    claims.exp * 1000 <= now ||
    Math.abs(claims.iat * 1000 - now) > 60_000 ||
    claims.digest !== digest(data) ||
    !verify(null, jwt.input, ed25519(peerPublicKey), jwt.signature)
  )
    throw new Error('Household reply proof rejected');
};
