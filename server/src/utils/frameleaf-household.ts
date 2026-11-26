// Wire contracts from Frameleaf/frameleaf-cloud packages/contracts/src/households (Apache-2.0), as written for
// FL-928 on branch aj/FL-928-household-links (working tree on 75031c90, not yet committed when mirrored).
import { z } from 'zod';
import { RemoteConnectionSchema as Connection } from 'src/dtos/frameleaf-remote-access.dto.js';

const RelayConfirmationKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const HOUSEHOLD_VERSION = 1;
export const HOUSEHOLD_GRANT_TYPE = 'household-grant+jwt';
export const HOUSEHOLD_GRANT_AUDIENCE = 'frameleaf-household';
export const HOUSEHOLD_GRANT_LIFETIME_SEC = 300;

export const HouseholdVersion = z.literal(HOUSEHOLD_VERSION);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** A server's own name as it registered it; never a person's or an account's name. */
const serverName = z.string().max(100);

/** The body of a route that needs none: `POST invitations` and `POST links/:id/end`. */
export const HouseholdAction = z.strictObject({ version: HouseholdVersion });
// `code` is not in the mirrored contract yet (owner decision 2026-11-22): the short form of the invitation, 12
// characters shown in groups of four (FERN-7Q4K-M2XD). Preview and accept take the token or the code.
export const HouseholdInviteResponse = z.strictObject({
  version: HouseholdVersion,
  invitationId: z.uuid(),
  token,
  code: z.string().min(12).max(14),
  expiresAt: z.iso.datetime(),
});
/** `GET /v1/households/invitations/:token`: the inviting server's name, id and public key, nothing about its owner. */
export const HouseholdInvitationPreview = z.strictObject({
  version: HouseholdVersion,
  instanceId: z.uuid(),
  name: serverName,
  publicKey: RelayConfirmationKey,
});

export const HouseholdLinkState = z.enum(['active', 'ended']);
/** One link as the calling server sees it. `peerPublicKey` is null when the peer was unlinked from Frameleaf Cloud. */
export const HouseholdLink = z
  .strictObject({
    version: HouseholdVersion,
    linkId: z.uuid(),
    state: HouseholdLinkState,
    peerInstanceId: z.uuid(),
    peerName: serverName,
    peerPublicKey: RelayConfirmationKey.nullable(),
    createdAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    endedByInstanceId: z.uuid().nullable(),
  })
  .refine(
    (l) => (l.state === 'ended') === (l.endedAt !== null) && (l.state === 'ended') === (l.endedByInstanceId !== null),
    'an ended link names when and by which server',
  );
export type HouseholdLink = z.infer<typeof HouseholdLink>;
/** `GET /v1/households/links`: live links and ended ones, newest first. */
export const HouseholdLinkList = z.strictObject({ version: HouseholdVersion, links: z.array(HouseholdLink) });

export const HouseholdGrantHeader = z.strictObject({
  alg: z.literal('EdDSA'),
  typ: z.literal(HOUSEHOLD_GRANT_TYPE),
  kid: z.string().min(1).max(128),
});
export const HouseholdGrantClaims = z
  .strictObject({
    version: HouseholdVersion,
    iss: z.url(),
    aud: z.literal(HOUSEHOLD_GRANT_AUDIENCE),
    sub: z.uuid(),
    jti: z.uuid(),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    linkId: z.uuid(),
    sourceInstanceId: z.uuid(),
    destinationInstanceId: z.uuid(),
    cnf: z.strictObject({ jkt: token, jwk: RelayConfirmationKey }),
    destinationKey: RelayConfirmationKey,
  })
  .refine(
    (c) =>
      c.exp > c.iat &&
      c.exp - c.iat <= HOUSEHOLD_GRANT_LIFETIME_SEC &&
      c.sub === c.sourceInstanceId &&
      c.sourceInstanceId !== c.destinationInstanceId,
    'invalid grant lifetime or subject',
  );
export type HouseholdGrantClaims = z.infer<typeof HouseholdGrantClaims>;
/**
 * `connections`: the destination server's addresses. Its home entries always; its direct, IPv6, custom and relay
 * entries only while the destination's owner has remote access (active or in grace).
 */
export const HouseholdGrantResponse = z.strictObject({
  version: HouseholdVersion,
  token: z.string().min(1).max(8192),
  expiresAt: z.iso.datetime(),
  claims: HouseholdGrantClaims,
  connections: z.array(Connection),
});
export type HouseholdGrantResponse = z.infer<typeof HouseholdGrantResponse>;
export const HouseholdVerifyResponse = z.strictObject({ version: HouseholdVersion, claims: HouseholdGrantClaims });

/**
 * Why a grant or a verify was refused, in the error envelope's `detail`: the link was ended, or the peer is not
 * linked to Frameleaf Cloud any more. A missing licence answers code `entitlement-missing`.
 */
export const HouseholdRefusalDetail = z.enum(['link-ended', 'peer-unavailable']);
