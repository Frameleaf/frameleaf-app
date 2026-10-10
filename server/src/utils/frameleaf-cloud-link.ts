import z from 'zod';
import type { FrameleafCloudLink, FrameleafCloudLinkRefusal, FrameleafCloudPermissions } from 'src/types.js';
import {
  type HeartbeatSettings,
  cloudBackupSettingsSchema,
  cloudMlSettingsSchema,
  licenseStateSchema,
  remoteAccessSettingsSchema,
} from 'src/utils/frameleaf-cloud-settings.js';
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

/**
 * The check-in interval when neither the heartbeat answer nor discovery names one (the contract's
 * default), and the bounds a named one is clamped to: staff set it on Platform controls within 60–900 s
 * (FC-62, frameleaf-cloud `docs/instance-contract.md`).
 */
export const HEARTBEAT_DEFAULT_SECONDS = 300;
export const HEARTBEAT_MIN_SECONDS = 60;
export const HEARTBEAT_MAX_SECONDS = 900;
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
  'capabilities',
  // FC-61: the settings snapshot, each block left out when it can't be reported
  'remoteAccessSettings',
  'cloudMl',
  'cloudBackup',
  'licenseState',
] as const;
export type HeartbeatField = (typeof HEARTBEAT_FIELDS)[number];

/** The cloud's bounds on the check-in's `capabilities` (FC-50): at most 16 entries of 1 to 32 characters. */
const HEARTBEAT_MAX_CAPABILITIES = 16;
const HEARTBEAT_CAPABILITY_MAX_LENGTH = 32;

export type HeartbeatPayload = {
  version: string;
  bootId: string;
  uptimeSec: number;
  health: { database: 'ok' | 'error'; storage: 'ok' | 'error'; jobs: 'ok' | 'error' };
  endpoints: Array<{ kind: string; url: string }>;
  remoteAccess: { enabled: boolean; relayConnected: boolean; direct: boolean };
  permissions: FrameleafCloudPermissions;
  licenseKid: string | null;
  /**
   * CLD-201 (FC-50): the capabilities this build supports, so a server linked before it declared `dpop`
   * turns per-instance DPoP enforcement on without relinking (FC-50, frameleaf-cloud PR #72: at most 16
   * entries of 1 to 32 characters; only `dpop` is acted on, only over DPoP, and never turned off again).
   * Present while `HEARTBEAT_REPORTS_CAPABILITIES` is on.
   */
  capabilities?: readonly string[];
} & HeartbeatSettings;

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
  // CLD-201 (FC-50): additive and one-way on the cloud side
  ...(input.capabilities && {
    capabilities: input.capabilities
      .filter((value) => value.length > 0 && value.length <= HEARTBEAT_CAPABILITY_MAX_LENGTH)
      .slice(0, HEARTBEAT_MAX_CAPABILITIES),
  }),
  // FC-61 (frameleaf-cloud PR #73): settings only. Each block is checked against the contract's strict
  // schema once more; one that doesn't pass, or carries any other key, is left out, never sent
  ...snapshotBlock('remoteAccessSettings', remoteAccessSettingsSchema, input.remoteAccessSettings),
  ...snapshotBlock('cloudMl', cloudMlSettingsSchema, input.cloudMl),
  ...snapshotBlock('cloudBackup', cloudBackupSettingsSchema, input.cloudBackup),
  ...snapshotBlock('licenseState', licenseStateSchema, input.licenseState),
});

const snapshotBlock = <K extends keyof HeartbeatSettings, T extends z.ZodType>(key: K, schema: T, value: unknown) => {
  const result = value === undefined ? null : schema.safeParse(value);
  return (result?.success ? { [key]: result.data as unknown } : {}) as Partial<Pick<HeartbeatSettings, K>>;
};

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

const usableSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Seconds until the next check-in (FC-62): the answer's `nextHeartbeatSec`, else discovery's
 * `intervals.heartbeatSec`, else the contract default, clamped to 60–900 s, plus jitter. Both are
 * staff-set and read each time, so a change applies from the next check-in.
 */
export const nextHeartbeatDelay = (
  hintSeconds: number | null | undefined,
  random = Math.random,
  discoverySeconds?: number | null,
): number => {
  const named = usableSeconds(hintSeconds) ? hintSeconds : usableSeconds(discoverySeconds) ? discoverySeconds : null;
  const base =
    named === null
      ? HEARTBEAT_DEFAULT_SECONDS
      : Math.min(HEARTBEAT_MAX_SECONDS, Math.max(HEARTBEAT_MIN_SECONDS, Math.round(named)));
  return base + Math.floor(random() * HEARTBEAT_JITTER_SECONDS);
};

/**
 * FC-62: how long a shown notice id is remembered. A notice lives at most 90 days after its start, so
 * one the cloud keeps sending is shown once for its whole life; the cloud's own rule assumes at least
 * 30 days.
 */
export const NOTICE_MEMORY_DAYS = 91;
/** At most this many remembered ids are kept, the newest first. */
export const NOTICE_MEMORY_MAX = 500;
/** A notice that cannot be dismissed comes back once a UTC day under its own daily id. */
const DAILY_NOTICE_ID = /^fc-notice-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}-\d{8}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * FC-62: which of a check-in's notice keys (the notice `id`, exactly as sent) are new, and the ids to
 * remember. Dedupe is by exact id: `fc-notice-<uuid>` is shown once; `fc-notice-<uuid>-<yyyymmdd>` is a
 * new id each UTC day, so a notice that cannot be dismissed comes back once a day and never more often.
 * Ids are forgotten after `NOTICE_MEMORY_DAYS`, a daily id after two days (it never recurs).
 */
export const rememberNotices = (
  shown: Record<string, string> | undefined,
  keys: readonly string[],
  now: number,
): { fresh: string[]; shown: Record<string, string> } => {
  const kept = Object.entries(shown ?? {}).filter(([id, at]) => {
    const age = now - Date.parse(at);
    return Number.isFinite(age) && age < (DAILY_NOTICE_ID.test(id) ? 2 : NOTICE_MEMORY_DAYS) * DAY_MS;
  });
  const next = new Map(kept);
  const fresh: string[] = [];
  const stamp = new Date(now).toISOString();
  for (const key of keys) {
    if (next.has(key)) {
      continue;
    }
    next.set(key, stamp);
    fresh.push(key);
  }
  const newest = [...next].sort(([, a], [, b]) => Date.parse(b) - Date.parse(a)).slice(0, NOTICE_MEMORY_MAX);
  return { fresh, shown: Object.fromEntries(newest) };
};

export enum CloudCommandType {
  RemoteEnable = 'remote.enable',
  RemoteDisable = 'remote.disable',
  BackupRun = 'backup.run',
  SecretRotate = 'secret.rotate',
  KeyRotate = 'key.rotate',
  Relink = 'relink',
  /** FC-61: fetch the entitlements again, as for `entitlementsChanged`; sent only to a server listing the capability. */
  EntitlementsRefresh = 'entitlements.refresh',
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
    case CloudCommandType.KeyRotate:
    case CloudCommandType.EntitlementsRefresh: {
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
    /** FL-185: `GET /v1/discovery` with an instance token, for the per-instance service statuses. */
    instanceDiscovery: `${api}/v1/discovery`,
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

// '1tb', '2tb', '3tb', '5tb' today; a tier added later is shown as the cloud names it
const storeTierSchema = z.string().min(1).max(16);

/**
 * FL-301 (FC-91): the owner's backup plan signal, sent only because this server lists `backup.plan`.
 * `tierOverflow.id` is stable for one case, so its push goes out once per id and status.
 */
export const backupPlanSignalSchema = z.object({
  tierOverflow: z
    .object({
      id: z.uuid(),
      status: z.enum(['asked', 'accepted', 'declined']),
      currentTier: storeTierSchema,
      suggestedTier: storeTierSchema.nullable(),
      backupPaused: z.boolean(),
    })
    .nullable(),
  planFull: z
    .object({
      reason: z.literal('plan-full'),
      action: z.enum(['upgrade', 'ask-organiser']),
      suggestedTier: storeTierSchema.nullable(),
      message: z.string().min(1).max(2000),
    })
    .nullable(),
});
export type BackupPlanSignal = z.infer<typeof backupPlanSignalSchema>;

/** The `shownNotices` key prefix of the backup plan's pushes. */
export const BACKUP_PLAN_NOTICE_PREFIX = 'backup-plan:';
const PLAN_FULL_NOTICE_PREFIX = `${BACKUP_PLAN_NOTICE_PREFIX}plan-full:`;

const tierLabel = (tier: string | null) => (tier ? tier.replace(/^(\d+)tb$/, '$1 TB') : 'a larger plan');

/** FL-301: the heartbeat's `backupPlan`: absent, read, or present but unreadable (`null`). */
export const readBackupPlan = (value: unknown): BackupPlanSignal | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const parsed = backupPlanSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export type BackupPlanNotice = {
  key: string;
  /**
   * `owner`: only the server owner's devices, since it carries plan and usage details (FC-91 review).
   * `admins`: every administrator, without tier details.
   */
  audience: 'owner' | 'admins';
  title: string;
  body: string;
  data: Record<string, string | boolean | null>;
};

/**
 * FL-301: the full plan's push text by action. `ask-organiser` is a Family Sharing member's plan: only the family
 * organiser can change it, so no upgrade is offered (the cloud contract's generic wording).
 */
const PLAN_FULL_BODY: Record<NonNullable<BackupPlanSignal['planFull']>['action'], string> = {
  upgrade:
    'Backups no longer fit the Frameleaf plan, so new items wait until it is upgraded. Your library is untouched and restores keep working.',
  'ask-organiser': "Your family's plan is full. Ask your family organiser to upgrade.",
};

/**
 * FL-301: what is heard about the backup plan, each keyed so it is pushed once: the owner's tier-overflow
 * case once per id and status, and a full plan (to the administrators, without tier details; a Family Sharing
 * member is asked to ask their organiser) once per action until it clears.
 */
export const backupPlanNotices = (signal: BackupPlanSignal | undefined): BackupPlanNotice[] => {
  const notices: BackupPlanNotice[] = [];
  const overflow = signal?.tierOverflow;
  if (overflow) {
    const current = tierLabel(overflow.currentTier);
    const suggested = tierLabel(overflow.suggestedTier);
    const text = {
      asked: {
        title: 'Your backups have outgrown your plan',
        body: `Your backups no longer fit the ${current} plan. Open the Frameleaf app to move to ${suggested}.`,
      },
      accepted: {
        title: 'Your Frameleaf plan was upgraded',
        body: `Your plan is now ${suggested}. Backups carry on with the room it gives them.`,
      },
      declined: overflow.backupPaused
        ? {
            title: 'Backups are paused: plan full',
            body: `Your backups no longer fit the ${current} plan, so new items wait. Upgrade in the Frameleaf app to back them up.`,
          }
        : {
            title: 'Your plan stays the same',
            body: `Your plan stays at ${current}. Backups that do not fit wait until the plan is upgraded.`,
          },
    }[overflow.status];
    notices.push({
      key: `${BACKUP_PLAN_NOTICE_PREFIX}${overflow.id}:${overflow.status}`,
      audience: 'owner',
      ...text,
      data: {
        reason: 'tier-overflow',
        screen: 'plan',
        caseId: overflow.id,
        status: overflow.status,
        currentTier: overflow.currentTier,
        suggestedTier: overflow.suggestedTier,
        backupPaused: overflow.backupPaused,
      },
    });
  }
  const full = signal?.planFull;
  if (full) {
    notices.push({
      key: `${PLAN_FULL_NOTICE_PREFIX}${full.action}`,
      audience: 'admins',
      title: 'Backups are paused: plan full',
      // the server's own words, never the cloud's `message`, so nothing about the tier can reach the administrators
      body: PLAN_FULL_BODY[full.action],
      data: { reason: 'plan-full', screen: 'plan', action: full.action },
    });
  }
  return notices;
};

/**
 * FL-301: a full plan the cloud says cleared is forgotten, so the next time it fills it is heard again.
 * An absent or unreadable signal says nothing, so it forgets nothing.
 */
export const forgetClearedPlanFull = (
  shown: Record<string, string>,
  signal: BackupPlanSignal | null | undefined,
): Record<string, string> =>
  !signal || signal.planFull
    ? shown
    : Object.fromEntries(Object.entries(shown).filter(([key]) => !key.startsWith(PLAN_FULL_NOTICE_PREFIX)));

export const heartbeatResponseSchema = z.object({
  commands: z.array(commandSchema).max(50).default([]),
  entitlementsChanged: z.boolean().default(false),
  servicesChanged: z.boolean().default(false),
  // clamped to 60–900 s when used (nextHeartbeatDelay); an unusable value falls back to discovery
  nextHeartbeatSec: z.number().positive().optional().catch(undefined),
  cloneSuspected: z.boolean().default(false),
  notices: z.array(noticeSchema).max(20).default([]),
  /** FL-167: the address this check-in came from (null when the cloud did not say, or it is not an address). */
  observedIp: z.union([z.ipv4(), z.ipv6()]).nullable().optional().catch(null),
  // validated on its own by acceptPublishedPricing, so a bad value never fails the check-in
  pricing: z.unknown().optional(),
  // FL-301: read on its own by readBackupPlan, so a signal this server cannot read never fails the check-in
  backupPlan: z.unknown().optional(),
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/**
 * `GET {api}/v1/discovery` (instance token): only the ML service's status and `cloneSuspected` are read
 * here (FL-185), to learn whether cloud processing is still `suspended` while check-ins report a
 * suspected copy.
 */
export const instanceServicesSchema = z.object({
  services: z
    .object({
      ml: z
        .object({ status: z.string().max(32) })
        .loose()
        .optional(),
    })
    .loose()
    .default({}),
  cloneSuspected: z.boolean().optional(),
});

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
  if (error.status === 409 && code === CloudErrorCode.RegionMismatch) {
    return 'region-mismatch';
  }
  return null;
};

/** The data regions the cloud contract defines (`DataRegion`): `na` is North America, Canada included. */
export const DATA_REGIONS = ['eu', 'na'] as const;
export type DataRegion = (typeof DATA_REGIONS)[number];
export const isDataRegion = (value: unknown): value is DataRegion =>
  typeof value === 'string' && (DATA_REGIONS as readonly string[]).includes(value);

/**
 * FC-18: `POST /v1/instances` answered 409 `region-mismatch`: the account keeps its data in
 * `data.accountRegion`, not the `dataRegion` this server sent. Nothing was written and the link token
 * stays usable. `message` is the cloud's own words (they name both regions), or ours when it sent none.
 */
export const regionMismatchOf = (
  error: unknown,
): { accountRegion: string; requestedRegion?: string; message: string } | null => {
  if (!(error instanceof FrameleafCloudError) || linkRefusalOf(error) !== 'region-mismatch') {
    return null;
  }
  const data = error.envelope?.data ?? {};
  const accountRegion = isDataRegion(data.accountRegion) ? data.accountRegion : null;
  if (!accountRegion) {
    return null;
  }
  const requestedRegion = isDataRegion(data.requestedRegion) ? data.requestedRegion : undefined;
  return {
    accountRegion,
    requestedRegion,
    message: error.envelope?.message.trim() || LINK_REFUSAL_MESSAGES['region-mismatch'],
  };
};

/** What an administrator reads for a refused registration: what happened and what to do next. */
export const LINK_REFUSAL_MESSAGES: Record<FrameleafCloudLinkRefusal, string> = {
  'instance-limit':
    'Your Frameleaf plan has no room for another server. Remove a server under Servers in your Frameleaf account, or change your plan, then link again.',
  'server-refused':
    'Frameleaf Cloud refused this server: it was removed from your Frameleaf account, or the account is suspended. Check Servers in your Frameleaf account.',
  'instance-id-taken':
    'This server, or another one with its ID, is still registered with Frameleaf Cloud, for example after an unlink made while it was offline. Remove it under Servers in your Frameleaf account, then link again.',
  'key-already-linked':
    'This server’s key is already linked, usually because its identity directory was copied from another server. Give this server its own identity directory, or unlink the other one under Servers in your Frameleaf account.',
  'region-mismatch':
    'Your Frameleaf account keeps its data in another region than the one this server asked for. Link in the account’s region, or link to an account in the region you want.',
};
