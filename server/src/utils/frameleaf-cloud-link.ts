import z from 'zod';
import type { FrameleafCloudLink, FrameleafCloudLinkRefusal, FrameleafCloudPermissions } from 'src/types.js';
import { CloudErrorCode, FrameleafCloudError, cloudErrorCode } from 'src/utils/frameleaf-cloud.js';

/**
 * The link side of the Frameleaf Cloud instance contract (FL-155, CLD-002; program plan section 4
 * "Link", "Heartbeat" and "Unlink propagation"; frameleaf-cloud `docs/instance-contract.md`).
 *
 * Pure helpers and schemas only: `FrameleafCloudService` does the I/O. Unknown response fields are
 * ignored; a missing required field fails the read and is treated as the cloud being unavailable.
 */

/** The public OAuth client every server uses to start the device flow. */
export const FRAMELEAF_LINK_CLIENT_ID = 'frameleaf-link';

/** RFC 8628 grant type of the device-code poll. */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Consonants only (RFC 8628 section 6.1): a code never spells a word or mixes up 0 and O. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_PATTERN = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/** Heartbeat interval when the cloud names none, and the bounds a named one is clamped to. */
export const HEARTBEAT_DEFAULT_SECONDS = 300;
export const HEARTBEAT_MIN_SECONDS = 60;
export const HEARTBEAT_MAX_SECONDS = 3600;
/** At most this much random delay is added to each check-in, so servers never arrive together. */
export const HEARTBEAT_JITTER_SECONDS = 30;
/** Consecutive failed check-ins before administrators are told. */
export const HEARTBEAT_FAILURE_NOTICE_THRESHOLD = 3;
/** A slow_down answer adds this much to the poll interval (RFC 8628 section 3.5). */
export const SLOW_DOWN_SECONDS = 5;
/** The contract allows at most 16 connection candidates per check-in. */
export const HEARTBEAT_MAX_ENDPOINTS = 16;
/** A key replaced by rotation keeps working this long on the cloud side (instance contract, "Tokens"). */
export const KEY_RETIRE_HOURS = 24;

/**
 * Exactly the fields every check-in sends, in order. The admin UI's "What this server sends" panel
 * renders this list, and a spec asserts the built payload has these keys and no others.
 */
export const HEARTBEAT_FIELDS = [
  'version',
  'bootId',
  'uptimeSec',
  'health',
  'endpoints',
  'remoteAccess',
  'permissions',
  'licenseKid',
] as const;
export type HeartbeatField = (typeof HEARTBEAT_FIELDS)[number];

export type HeartbeatPayload = {
  version: string;
  bootId: string;
  uptimeSec: number;
  health: { database: 'ok' | 'error'; storage: 'ok' | 'error'; jobs: 'ok' | 'error' };
  endpoints: Array<{ kind: string; url: string }>;
  remoteAccess: { enabled: boolean; relayConnected: boolean; direct: boolean };
  permissions: FrameleafCloudPermissions;
  licenseKid: string | null;
};

/** The check-in body: only the listed fields, never media, names, accounts or usage. */
export const buildHeartbeat = (input: HeartbeatPayload): HeartbeatPayload => ({
  version: input.version,
  bootId: input.bootId,
  uptimeSec: Math.max(0, Math.floor(input.uptimeSec)),
  health: { database: input.health.database, storage: input.health.storage, jobs: input.health.jobs },
  endpoints: input.endpoints.slice(0, HEARTBEAT_MAX_ENDPOINTS).map(({ kind, url }) => ({ kind, url })),
  remoteAccess: {
    enabled: input.remoteAccess.enabled,
    relayConnected: input.remoteAccess.relayConnected,
    direct: input.remoteAccess.direct,
  },
  permissions: { ...defaultPermissions(), ...pickPermissions(input.permissions) },
  licenseKid: input.licenseKid,
});

/** What Frameleaf Cloud may ask this server to do, before an administrator changes it (prototype defaults). */
export const defaultPermissions = (): FrameleafCloudPermissions => ({
  allowRemoteEnable: false,
  allowBackupTrigger: true,
  allowEntitlementRefresh: true,
});

const pickPermissions = (value: Partial<FrameleafCloudPermissions> | undefined): Partial<FrameleafCloudPermissions> => {
  const picked: Partial<FrameleafCloudPermissions> = {};
  for (const key of ['allowRemoteEnable', 'allowBackupTrigger', 'allowEntitlementRefresh'] as const) {
    if (typeof value?.[key] === 'boolean') {
      picked[key] = value[key];
    }
  }
  return picked;
};

export const permissionsOf = (link: FrameleafCloudLink | null | undefined): FrameleafCloudPermissions => ({
  ...defaultPermissions(),
  ...pickPermissions(link?.permissions),
});

export const isUserCode = (value: string): boolean => USER_CODE_PATTERN.test(value);

/** Seconds until the next check-in, from the cloud's hint clamped to sane bounds, plus jitter. */
export const nextHeartbeatDelay = (hintSeconds: number | null | undefined, random = Math.random): number => {
  const base =
    typeof hintSeconds === 'number' && Number.isFinite(hintSeconds)
      ? Math.min(HEARTBEAT_MAX_SECONDS, Math.max(HEARTBEAT_MIN_SECONDS, Math.round(hintSeconds)))
      : HEARTBEAT_DEFAULT_SECONDS;
  return base + Math.floor(random() * HEARTBEAT_JITTER_SECONDS);
};

export enum CloudCommandType {
  RemoteEnable = 'remote.enable',
  RemoteDisable = 'remote.disable',
  BackupRun = 'backup.run',
  SecretRotate = 'secret.rotate',
  KeyRotate = 'key.rotate',
  Relink = 'relink',
}

/**
 * The instance-side toggle a cloud command needs. `relink` only asks an administrator to link again
 * and is never destructive, so it needs none. Unknown commands are refused.
 */
export const commandPermission = (type: string): keyof FrameleafCloudPermissions | 'always' | null => {
  switch (type) {
    case CloudCommandType.RemoteEnable:
    case CloudCommandType.RemoteDisable: {
      return 'allowRemoteEnable';
    }
    case CloudCommandType.BackupRun: {
      return 'allowBackupTrigger';
    }
    case CloudCommandType.SecretRotate:
    case CloudCommandType.KeyRotate: {
      return 'allowEntitlementRefresh';
    }
    case CloudCommandType.Relink: {
      return 'always';
    }
    default: {
      return null;
    }
  }
};

/** Absolute URLs of the link and check-in endpoints, from discovery; never a hard-coded host. */
export const linkEndpoints = (document: { issuer: string; api: string; endpoints?: Record<string, string> }) => {
  const issuer = document.issuer.replace(/\/+$/, '');
  const api = document.api.replace(/\/+$/, '');
  return {
    deviceAuthorization: `${issuer}/device/auth`,
    token: `${issuer}/token`,
    instances: `${api}/v1/instances`,
    instance: `${api}/v1/instance`,
    heartbeat: document.endpoints?.heartbeat ?? `${api}/v1/instance/heartbeat`,
    commandAck: (id: string) => `${api}/v1/instance/commands/${encodeURIComponent(id)}/ack`,
    keyNonce: `${api}/v1/instance/keys/nonce`,
    keyRotate: `${api}/v1/instance/keys/rotate`,
  };
};

// ------------------------------------------------------------------ response schemas

export const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1).max(4096),
  user_code: z.string().refine(isUserCode, 'user code is not XXXX-XXXX'),
  verification_uri: z.url({ protocol: /^https?$/ }),
  verification_uri_complete: z.url({ protocol: /^https?$/ }),
  expires_in: z
    .number()
    .int()
    .min(30)
    .max(60 * 60),
  interval: z.number().int().min(1).max(120).default(5),
});
export type DeviceAuthorization = z.infer<typeof deviceAuthorizationSchema>;

/** The device-code grant succeeded: the link token, valid about ten minutes. */
export const linkTokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z
    .number()
    .int()
    .min(1)
    .max(60 * 60)
    .optional(),
});

/**
 * The `POST /v1/instances` answer (frameleaf-cloud `packages/contracts` `RegisterInstanceResponse`).
 * Frameleaf Cloud registers the Sign in with Frameleaf client itself (`client_id` = the instance id,
 * `private_key_jwt` with this server's key, redirect URIs it builds from the relay origin and verified
 * custom hostnames), so the answer carries no initial access token and this server never runs
 * dynamic client registration (as-built decisions #7–#9). Anything else in `oidc` is ignored.
 */
export const instanceRegistrationSchema = z.object({
  instanceId: z.string().min(1).max(200),
  oidc: z.object({
    issuer: z.url({ protocol: /^https?$/ }),
    clientId: z.string().min(1).max(200),
    scope: z.string().max(200).default('openid email profile'),
    roleClaim: z.string().max(100).default('frameleaf_role'),
    storageLabelClaim: z.string().max(100).default(''),
  }),
  services: z.record(z.string(), z.unknown()).default({}),
  owner: z
    .object({
      accountId: z.string().max(200).optional(),
      id: z.string().max(200).optional(),
      email: z.string().max(320).optional(),
      name: z.string().max(200).optional(),
      label: z.string().max(200).optional(),
      dataRegion: z.string().max(16).optional(),
      region: z.string().max(16).optional(),
    })
    .loose()
    .default({}),
});
export type InstanceRegistration = z.infer<typeof instanceRegistrationSchema>;

const commandSchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(64),
  })
  .loose();
export type CloudCommand = z.infer<typeof commandSchema>;

const noticeSchema = z.object({
  id: z.string().max(200).optional(),
  level: z.enum(['info', 'warning', 'error']).default('info'),
  message: z.string().min(1).max(2000),
});

export const heartbeatResponseSchema = z.object({
  commands: z.array(commandSchema).max(50).default([]),
  entitlementsChanged: z.boolean().default(false),
  servicesChanged: z.boolean().default(false),
  nextHeartbeatSec: z.number().int().positive().max(86_400).optional(),
  cloneSuspected: z.boolean().default(false),
  notices: z.array(noticeSchema).max(20).default([]),
  // validated on its own by acceptPublishedPricing, so a bad value never fails the check-in
  pricing: z.unknown().optional(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const keyNonceSchema = z.object({ nonce: z.string().min(8).max(512) });

/** The label shown for the linked account: its label, else its name, else its email. */
export const accountLabelOf = (owner: InstanceRegistration['owner']): string | undefined =>
  owner.label || owner.name || owner.email || undefined;

/**
 * The refusal an administrator can act on, when Frameleaf Cloud refused this server's registration
 * (`POST /v1/instances`) for one of the reasons the contract names; otherwise null (FL-177).
 */
export const linkRefusalOf = (error: unknown): FrameleafCloudLinkRefusal | null => {
  if (!(error instanceof FrameleafCloudError)) {
    return null;
  }
  const code = cloudErrorCode(error);
  if (error.status === 402 && code === CloudErrorCode.InstanceLimit) {
    return 'instance-limit';
  }
  if (error.status === 403) {
    // a server removed from the account (instance_revoked) or an account that is suspended
    return 'server-refused';
  }
  if (error.status === 409 && code === CloudErrorCode.InstanceIdTaken) {
    return 'instance-id-taken';
  }
  if (error.status === 409 && code === CloudErrorCode.JwkAlreadyBound) {
    return 'key-already-linked';
  }
  return null;
};

/** What an administrator reads for a refused registration: what happened and what to do next. */
export const LINK_REFUSAL_MESSAGES: Record<FrameleafCloudLinkRefusal, string> = {
  'instance-limit':
    'Your Frameleaf plan has no room for another server. Remove a server under Servers in your Frameleaf account, or change your plan, then link again.',
  'server-refused':
    'Frameleaf Cloud refused this server: it was removed from your Frameleaf account, or the account is suspended. Check Servers in your Frameleaf account.',
  'instance-id-taken':
    'Another server is already registered with this server’s ID. Remove the old entry under Servers in your Frameleaf account, then link again.',
  'key-already-linked':
    'This server’s key is already linked, usually because its identity directory was copied from another server. Give this server its own identity directory, or unlink the other one under Servers in your Frameleaf account.',
};
