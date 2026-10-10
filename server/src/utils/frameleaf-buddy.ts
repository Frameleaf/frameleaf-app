// Wire contracts from Frameleaf/frameleaf-cloud packages/contracts/src/buddy (Apache-2.0), commit 7f094c00.
import { z } from 'zod';
import { RemoteConnectionSchema as Connection } from 'src/dtos/frameleaf-remote-access.dto.js';
import { relayTokenResponseSchema as RelayTokenResponse } from 'src/utils/frameleaf-relay.js';

const RelayConfirmationKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const BUDDY_VERSION = 1;
export const BUDDY_GRANT_TYPE = 'buddy-grant+jwt';
export const BUDDY_GRANT_LIFETIME_SEC = 300;
export const BuddyVersion = z.literal(BUDDY_VERSION).meta({ format: 'double' });
export const BuddyRetention = z.strictObject({
  days: z.literal(30).meta({ format: 'double' }),
  monthly: z.literal(12).meta({ format: 'double' }),
});
export const BuddyScope = z.enum(['read', 'write']);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quota = bytes.min(10 * 1024 ** 3);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const BuddyAction = z.strictObject({ version: BuddyVersion });
export const BuddyInviteRequest = z.strictObject({
  version: BuddyVersion,
  instanceId: z.uuid(),
  targetAccountId: z.uuid(),
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyInviteRequest = z.infer<typeof BuddyInviteRequest>;
export const BuddyInviteResponse = z.strictObject({
  version: BuddyVersion,
  invitationId: z.uuid(),
  token,
  expiresAt: z.iso.datetime(),
});
export const BuddyAcceptRequest = z.strictObject({
  version: BuddyVersion,
  token,
  instanceId: z.uuid(),
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyAcceptRequest = z.infer<typeof BuddyAcceptRequest>;
export const BuddyVault = z.strictObject({
  vaultId: z.uuid(),
  sourceInstanceId: z.uuid(),
  destinationInstanceId: z.uuid(),
  sourceKey: RelayConfirmationKey,
  destinationKey: RelayConfirmationKey,
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyVault = z.infer<typeof BuddyVault>;
export const BuddyPairing = z
  .strictObject({
    version: BuddyVersion,
    pairId: z.uuid(),
    state: z.enum(['pending', 'active', 'ended', 'blocked']),
    readUntil: z.iso.datetime().nullable(),
    vaults: z.array(BuddyVault).length(2),
  })
  .refine((p) => {
    const [a, b] = p.vaults;
    return Boolean(
      a &&
      b &&
      a.vaultId !== b.vaultId &&
      a.sourceInstanceId !== a.destinationInstanceId &&
      a.sourceInstanceId === b.destinationInstanceId &&
      a.destinationInstanceId === b.sourceInstanceId &&
      a.sourceKey.x === b.destinationKey.x &&
      a.destinationKey.x === b.sourceKey.x &&
      (p.state === 'ended') === (p.readUntil !== null),
    );
  }, 'a pairing must contain reciprocal independent vaults');
export type BuddyPairing = z.infer<typeof BuddyPairing>;
export const BuddyPairingList = z.strictObject({ version: BuddyVersion, pairings: z.array(BuddyPairing) });
export const BuddyGrantRequest = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  vaultId: z.uuid(),
  scope: BuddyScope,
});
export type BuddyGrantRequest = z.infer<typeof BuddyGrantRequest>;
export const BuddyGrantHeader = z.strictObject({
  alg: z.literal('EdDSA'),
  typ: z.literal(BUDDY_GRANT_TYPE),
  kid: z.string().min(1).max(128),
});
export const BuddyGrantClaims = z
  .strictObject({
    version: BuddyVersion,
    iss: z.url(),
    aud: z.literal('frameleaf-buddy'),
    sub: z.uuid(),
    jti: z.uuid(),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    pairId: z.uuid(),
    sourceInstanceId: z.uuid(),
    destinationInstanceId: z.uuid(),
    vaultId: z.uuid(),
    scope: BuddyScope,
    cnf: z.strictObject({ jkt: token, jwk: RelayConfirmationKey }),
    destinationKey: RelayConfirmationKey,
  })
  .refine(
    (c) =>
      c.exp > c.iat &&
      c.exp - c.iat <= BUDDY_GRANT_LIFETIME_SEC &&
      c.sub === c.sourceInstanceId &&
      c.sourceInstanceId !== c.destinationInstanceId,
    'invalid grant lifetime or subject',
  );
export type BuddyGrantClaims = z.infer<typeof BuddyGrantClaims>;
export const BuddyGrantResponse = z.strictObject({
  version: BuddyVersion,
  token: z.string().min(1).max(8192),
  expiresAt: z.iso.datetime(),
  claims: BuddyGrantClaims,
  connections: z.array(Connection),
});
export const BuddyVerifyRequest = z.strictObject({ version: BuddyVersion, token: z.string().min(1).max(8192) });
export const BuddyStatusReport = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  vaultId: z.uuid(),
  committedBytes: bytes,
  reservedBytes: bytes,
  lastCompleteAt: z.iso.datetime().nullable(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  state: z.enum(['idle', 'sending', 'paused', 'quota', 'integrity']),
});
export type BuddyStatusReport = z.infer<typeof BuddyStatusReport>;
export const BuddyStatusResponse = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  reports: z.array(BuddyStatusReport).max(2),
});
export const BuddyRebindRequest = z.strictObject({
  version: BuddyVersion,
  oldInstanceId: z.uuid(),
  newInstanceId: z.uuid(),
});
export const BuddyEscrowRequest = z.strictObject({
  version: BuddyVersion,
  vaultId: z.uuid(),
  blob: z
    .string()
    .min(64)
    .max(32_768)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const BuddyRecoveryRelayRequest = z.strictObject({ version: BuddyVersion, pairId: z.uuid(), vaultId: z.uuid() });
export type BuddyRecoveryRelayRequest = z.infer<typeof BuddyRecoveryRelayRequest>;
export const BuddyRecoveryRelayResponse = RelayTokenResponse.extend({ recoveryHost: z.string().max(253) });
