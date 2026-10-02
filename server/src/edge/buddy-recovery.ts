import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import type { FrameleafRemoteEnrollment } from 'src/types.js';
import { type RelayTokenResponse, relayTokenResponseSchema } from 'src/utils/frameleaf-relay.js';

// Pairing and recovery token fields mirror Frameleaf/frameleaf-cloud's Apache-2.0
// packages/contracts/src/{buddy/index,remote/relay}.ts (FC-100, version 1).
const publicKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const vault = z.strictObject({
  vaultId: z.uuid(),
  sourceInstanceId: z.uuid(),
  destinationInstanceId: z.uuid(),
  sourceKey: publicKey,
  destinationKey: publicKey,
  quotaBytes: z
    .number()
    .int()
    .min(10 * 1024 ** 3)
    .max(Number.MAX_SAFE_INTEGER),
  retention: z.strictObject({ days: z.literal(30), monthly: z.literal(12) }),
});
const pairing = z
  .strictObject({
    version: z.literal(1),
    pairId: z.uuid(),
    state: z.enum(['pending', 'active', 'ended', 'blocked']),
    readUntil: z.iso.datetime().nullable(),
    vaults: z.array(vault).length(2),
  })
  .refine(
    ({ vaults: [a, b], state, readUntil }) =>
      a.vaultId !== b.vaultId &&
      a.sourceInstanceId !== a.destinationInstanceId &&
      a.sourceInstanceId === b.destinationInstanceId &&
      a.destinationInstanceId === b.sourceInstanceId &&
      a.sourceKey.x === b.destinationKey.x &&
      a.destinationKey.x === b.sourceKey.x &&
      (state === 'ended') === (readUntil !== null),
  );

export type BuddyRecoveryScope = {
  pairId: string;
  vaultId: string;
  sourceInstanceId: string;
  readUntil: string | null;
  backupEnabled?: true;
  writeAllowed?: true;
};
export type BuddyRecoveryAccess = BuddyRecoveryScope & { host: string };
export const buddyRecoveryHost = (enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>) =>
  `recovery.${enrollment.label}.${enrollment.domain}`;

/** Read only the durable pairing; recovery does not start the backup worker or depend on its feature flag. */
export const readBuddyRecovery = async (
  identityDir: string,
  instanceId: string,
  now: number,
): Promise<BuddyRecoveryScope | null> => {
  try {
    const file = await open(join(identityDir, 'buddy', 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 256 * 1024) {
        return null;
      }
      // eslint-disable-next-line unicorn/consistent-json-file-read -- FileHandle.readFile takes encoding as its first argument.
      const content = await file.readFile('utf8');
      const state = z
        .object({
          version: z.literal(1),
          pairing: pairing.nullable(),
          settings: z
            .object({
              directory: z.string().min(1),
              quotaBytes: z
                .number()
                .int()
                .min(10 * 1024 ** 3),
              pausedReceiving: z.boolean().optional(),
            })
            .nullable()
            .optional(),
        })
        .parse(JSON.parse(content));
      const pair = state.pairing;
      if (!pair || (pair.state !== 'active' && !(pair.state === 'ended' && Date.parse(pair.readUntil!) > now))) {
        return null;
      }
      const incoming = pair.vaults.find((item) => item.destinationInstanceId === instanceId);
      const backupEnabled =
        pair.state === 'active' && !!state.settings && process.env.FRAMELEAF_BUDDY_BACKUP === 'true';
      return incoming
        ? {
            pairId: pair.pairId,
            vaultId: incoming.vaultId,
            sourceInstanceId: incoming.sourceInstanceId,
            readUntil: pair.readUntil,
            ...(backupEnabled && { backupEnabled: true as const }),
            ...(backupEnabled && !state.settings?.pausedReceiving && { writeAllowed: true as const }),
          }
        : null;
    } finally {
      await file.close();
    }
  } catch {
    // Missing, partial, invalid or unreadable state grants no network access.
    return null;
  }
};

/** A direct candidate may have a mapped port. The Host must still name its exact TLS SNI. */
export const buddyAuthorityMatches = (authority: string | undefined, servername: string | null) => {
  const [host, port, extra] = (authority ?? '').split(':', 3);
  return (
    !!servername &&
    host === servername &&
    extra === undefined &&
    (port === undefined || (/^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65_535))
  );
};

/** Paid Buddy-only access uses ordinary transport but never admits ordinary APIs or assets. */
export const buddyBackupRequestAllowed = (
  access: BuddyRecoveryAccess | null,
  method: string | undefined,
  path: string | undefined,
  now = Date.now(),
) => {
  if (!access?.backupEnabled) {
    return false;
  }
  if (buddyRecoveryRequestAllowed(access, method, path, access.host, now)) {
    return true;
  }
  const prefix = `/api/buddy/v1/vaults/${access.vaultId}/`;
  if (!access.writeAllowed || access.readUntil !== null || !path?.startsWith(prefix)) {
    return false;
  }
  const suffix = path.slice(prefix.length);
  return (
    (method === 'POST' && /^(?:inventory|reservations|snapshots)$/.test(suffix)) ||
    (method === 'PUT' && /^objects\/[0-9a-f]{64}$/.test(suffix))
  );
};

/** Match the raw request target: no URL normalization, queries, escaping or extra path segments. */
export const buddyRecoveryRequestAllowed = (
  access: BuddyRecoveryAccess | null,
  method: string | undefined,
  path: string | undefined,
  host: string | undefined,
  now = Date.now(),
): boolean => {
  if (
    !access ||
    host !== access.host ||
    (method !== 'GET' && method !== 'HEAD') ||
    (access.readUntil !== null && !(Date.parse(access.readUntil) > now))
  ) {
    return false;
  }
  const prefix = `/api/buddy/v1/vaults/${access.vaultId}/`;
  if (!path?.startsWith(prefix)) {
    return false;
  }
  return /^(?:handshake|snapshots|snapshots\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|objects\/[0-9a-f]{64})$/.test(
    path.slice(prefix.length),
  );
};

export const buddyRecoveryRelayResponseSchema = relayTokenResponseSchema.extend({ recoveryHost: z.string().max(253) });

/** The relay checks the JWT signature. Locally reject purpose/scope changes and inconsistent caps before dialing. */
export const buddyRelayPurposeProblem = (
  answer: RelayTokenResponse & { recoveryHost?: string },
  scope: BuddyRecoveryScope | undefined,
  host: string,
  issuer: string,
  now: number,
): string | null => {
  try {
    const [header, payload] = answer.token.split('.', 2);
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!scope) {
      return ['purpose', 'pairId', 'vaultId', 'sourceInstanceId'].some((key) => key in claims)
        ? 'a recovery token cannot authorize ordinary remote access'
        : null;
    }
    z.strictObject({ alg: z.literal('EdDSA'), typ: z.literal('relay+jwt'), kid: z.string().min(1).max(128) }).parse(
      JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    );
    const restriction = z
      .object({
        iss: z.literal(issuer),
        purpose: z.literal('buddy-recovery'),
        pairId: z.literal(scope.pairId),
        vaultId: z.literal(scope.vaultId),
        sourceInstanceId: z.literal(scope.sourceInstanceId),
        hosts: z.array(z.string()).length(0),
        iat: z.number().int().positive(),
        exp: z.number().int().positive(),
        thr: z.strictObject({
          bps: z.number().int().min(64_000).max(10_000_000_000),
          burst: z
            .number()
            .int()
            .min(16 * 1024)
            .max(64 * 1024 * 1024),
        }),
        lim: z.strictObject({ conns: z.number().int().min(1).max(2) }),
      })
      .parse(claims);
    if (
      answer.recoveryHost !== host ||
      restriction.iat * 1000 > now + 30_000 ||
      restriction.exp <= restriction.iat ||
      restriction.exp - restriction.iat > 300 ||
      restriction.exp * 1000 <= now ||
      (scope.readUntil !== null && restriction.exp * 1000 > Date.parse(scope.readUntil)) ||
      Date.parse(answer.expiresAt) !== restriction.exp * 1000 ||
      answer.limits.conns !== restriction.lim.conns ||
      answer.throttling.bps !== restriction.thr.bps ||
      answer.throttling.burst !== restriction.thr.burst
    ) {
      return 'the recovery relay token has invalid host, lifetime or limits';
    }
    return null;
  } catch {
    return 'the relay token does not match its recovery purpose';
  }
};
