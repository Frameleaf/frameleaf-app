/* eslint-disable no-restricted-imports -- Pure validation before application imports. */
import { createHash, type KeyObject, verify } from 'node:crypto';
import z from 'zod';
import { BUDDY_UUID } from './buddy-backup-crypto.ts';

const uuid = z.string().regex(BUDDY_UUID);
const digest = z.string().regex(/^[\da-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const nonce = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const dependency = z.enum(['postgres', 'valkey']);
const postgresKeys = ['DB_HOSTNAME', 'DB_PORT', 'DB_DATABASE_NAME', 'DB_USERNAME', 'DB_PASSWORD'] as const;
const valkeyKeys = ['REDIS_HOSTNAME', 'REDIS_PORT', 'REDIS_DBINDEX', 'REDIS_USERNAME', 'REDIS_PASSWORD'] as const;
const key = z.enum([...postgresKeys, ...valkeyKeys]);
const selectedKeys = z.array(key).min(1).max(5).refine((keys) => new Set(keys).size === keys.length);
const registration = z.strictObject({
  version: z.literal(1),
  dependency,
  kind: z.literal('standalone'),
  registrationId: uuid,
  revision: uuid,
  replacementIdentity: identity,
  transport: z.literal('tcp'),
  hostname: z.string().min(1).max(253).regex(/^[\w.-]+$/),
  port: z.number().int().min(1).max(65_535),
  tls: z.literal('disabled'),
});
const request = z.strictObject({
  version: z.literal(1),
  grantId: uuid,
  dependency,
  profile: z.literal('verify-existing'),
  profileVersion: z.literal(1),
  connectionMode: z.literal('parts'),
  environmentKeys: selectedKeys,
  sourceBindings: z.array(z.strictObject({ key, source: z.literal('environment') })).min(1).max(5),
  requestNonce: nonce,
  priorConfigurationRevision: uuid,
  registration,
  recoveryId: uuid,
  snapshotId: uuid,
  vaultId: uuid,
  replacementIdentity: identity,
  artifactDigest: digest,
  preparedDigest: digest,
});
const receipt = z.strictObject({
  version: z.literal(1),
  state: z.literal('eligible'),
  grantId: uuid,
  requestDigest: digest,
  requestNonce: nonce,
  registrationId: uuid,
  serviceRevision: uuid,
  replacementIdentity: identity,
  recoveryId: uuid,
  snapshotId: uuid,
  vaultId: uuid,
  artifactDigest: digest,
  preparedDigest: digest,
  publicationDigest: digest,
  sourceRevision: uuid,
  publicationFence: z.strictObject({ recoveryId: uuid, epoch: uuid, replacementIdentity: identity }),
  challenge: z.strictObject({ replacementIdentity: identity, requestNonce: nonce, serviceRevision: uuid }),
  journal: z.tuple([
    z.literal('requested'),
    z.literal('validated'),
    z.literal('service-prepared'),
    z.literal('files-prepared'),
    z.literal('verified'),
    z.literal('eligible'),
  ]),
});
export const BuddyDependencyGrantSchema = z.strictObject({
  request,
  receipt,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const isBuddyDependencyProtocolKey = (name: string) =>
  [...postgresKeys, ...valkeyKeys].some((key) => key === name);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const refuse = () => new Error('Invalid replacement-local Buddy boot authority');

/** Admission only: a signed local record is not live service readiness or credential authority. */
export const validateBuddyDependencyProtocol = (
  raw: unknown,
  expected: {
    recoveryId: string;
    snapshotId: string;
    vaultId: string;
    replacementIdentity: string;
    artifactDigest: string;
    preparedDigest: string;
    publicationDigest: string;
    environmentKeys: string[];
    entries: { key: string; state: 'unset' | 'value'; value?: unknown }[];
  },
  publicKey: KeyObject,
) => {
  const checked = z.array(BuddyDependencyGrantSchema).min(1).max(2).safeParse(raw);
  if (!checked.success) throw refuse();
  // Strict shape validation precedes this cast; preserve signed JSON member order,
  // rather than serializing Zod's reordered object and changing the issuer's bytes.
  const originals = raw as { request: unknown; receipt: unknown }[];
  const seen = new Set<string>();
  const granted = new Set<string>();
  let fenceEpoch: string | undefined;
  for (const [index, grant] of checked.data.entries()) {
    const { request, receipt, signature } = grant;
    if (seen.has(request.dependency) || seen.has(request.grantId)) throw refuse();
    seen.add(request.dependency);
    seen.add(request.grantId);
    const allowed = request.dependency === 'postgres' ? postgresKeys : valkeyKeys;
    if (
      request.environmentKeys.length !== allowed.length ||
      !allowed.every((key) => request.environmentKeys.includes(key)) ||
      request.sourceBindings.length !== allowed.length ||
      new Set(request.sourceBindings.map(({ key }) => key)).size !== allowed.length ||
      !request.sourceBindings.every(({ key }) => request.environmentKeys.includes(key)) ||
      request.registration.dependency !== request.dependency ||
      request.registration.replacementIdentity !== expected.replacementIdentity ||
      receipt.requestDigest !== hash(originals[index].request) ||
      !verify(
        null,
        Buffer.from(JSON.stringify(originals[index].receipt)),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ) ||
      receipt.grantId !== request.grantId ||
      receipt.requestNonce !== request.requestNonce ||
      receipt.registrationId !== request.registration.registrationId ||
      receipt.serviceRevision !== request.registration.revision ||
      receipt.publicationDigest !== expected.publicationDigest ||
      receipt.publicationFence.recoveryId !== expected.recoveryId ||
      receipt.publicationFence.replacementIdentity !== expected.replacementIdentity ||
      (fenceEpoch !== undefined && receipt.publicationFence.epoch !== fenceEpoch) ||
      receipt.challenge.replacementIdentity !== expected.replacementIdentity ||
      receipt.challenge.requestNonce !== request.requestNonce ||
      receipt.challenge.serviceRevision !== receipt.serviceRevision
    )
      throw refuse();
    fenceEpoch = receipt.publicationFence.epoch;
    for (const name of [
      'recoveryId',
      'snapshotId',
      'vaultId',
      'replacementIdentity',
      'artifactDigest',
      'preparedDigest',
    ] as const) {
      if (request[name] !== expected[name] || receipt[name] !== expected[name]) throw refuse();
    }
    for (const name of request.environmentKeys) {
      if (!expected.environmentKeys.includes(name) || granted.has(name)) throw refuse();
      granted.add(name);
    }
    const hostKey = request.dependency === 'postgres' ? 'DB_HOSTNAME' : 'REDIS_HOSTNAME';
    const portKey = request.dependency === 'postgres' ? 'DB_PORT' : 'REDIS_PORT';
    if (
      expected.entries.find(({ key }) => key === hostKey)?.value !== request.registration.hostname ||
      expected.entries.find(({ key }) => key === portKey)?.value !== request.registration.port
    )
      throw refuse();
  }
  if (expected.environmentKeys.filter(isBuddyDependencyProtocolKey).some((key) => !granted.has(key))) throw refuse();
};
