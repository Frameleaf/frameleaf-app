import z from 'zod';
import type { SystemConfig } from 'src/config.js';
import type { FrameleafCloudBackup, FrameleafLicenseStore } from 'src/types.js';
import { CONSENT_VERSION_PATTERN } from 'src/utils/frameleaf-cloud.js';
import { type LicenseState, licenseStatus } from 'src/utils/frameleaf-license.js';

/**
 * FL-159 (FC-61, frameleaf-cloud PR #73): the settings snapshot a check-in carries after `capabilities`,
 * so Frameleaf Cloud staff see what an administrator chose "as last reported". Settings only: booleans,
 * fixed enums and bounded numbers, never a path, a hostname, an address, a name, an email or free text.
 *
 * Each block is built from this server's real settings and checked against the cloud's own strict schema
 * (`packages/contracts` `RemoteAccessSettings`, `CloudMlSettings`, `CloudBackupSettings`, `LicenseState`)
 * before it is sent. A block that would not pass is left out rather than sent: the cloud then clears what
 * it stored for that block, which is better than a wrong value.
 */

/** The cloud's canonical workload ids (`packages/contracts` `Workload`). */
const CLOUD_WORKLOADS = ['descriptions', 'upscale', 'restoration', 'transcription', 'tts', 'interpolation'] as const;
type CloudWorkload = (typeof CLOUD_WORKLOADS)[number];
type CloudMlRoute = 'local-only' | 'both' | 'cloud-only';

/** The most a daily budget may be reported as, in US dollars (`CLOUD_ML_MAX_DAILY_BUDGET_USD`). */
export const CLOUD_ML_MAX_DAILY_BUDGET_USD = 10_000;

export const remoteAccessSettingsSchema = z.strictObject({
  mode: z.enum(['relay', 'relay-and-direct']),
  directPort: z.number().int().min(1).max(65_535).nullable(),
  portMapping: z.boolean(),
  allowOriginalsOverRelay: z.boolean(),
  allowPasswordOverRelay: z.boolean(),
  publicUrl: z.enum(['frameleaf', 'custom']),
  requireFrameleafSignIn: z.boolean(),
});
export type RemoteAccessSettings = z.infer<typeof remoteAccessSettingsSchema>;

export const cloudMlSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  routing: z.partialRecord(z.enum(CLOUD_WORKLOADS), z.enum(['local-only', 'both', 'cloud-only'])),
  autoBatch: z.boolean(),
  dailyBudgetUsd: z.number().min(0).max(CLOUD_ML_MAX_DAILY_BUDGET_USD),
  consentVersion: z.string().regex(CONSENT_VERSION_PATTERN).nullable(),
  faces: z.boolean(),
});
export type CloudMlSettings = z.infer<typeof cloudMlSettingsSchema>;

/** Five cron fields: digits, `*`, `/`, `,` and `-`, separated by single spaces, at most 64 characters. */
const BACKUP_SCHEDULE = /^[\d*/,-]+(?: [\d*/,-]+){4}$/;

/**
 * FC-61: whether a server backing up to its own bucket reports `target: own-bucket` (live since
 * frameleaf-cloud PR #78). Off, such a server leaves the cloudBackup block out, since `off` would be
 * misleading.
 */
export const CLOUD_BACKUP_REPORTS_OWN_BUCKET: boolean = true;

const backupSettingsSchema = (ownBucket: boolean) =>
  z.strictObject({
    target: ownBucket ? z.enum(['off', 'managed', 'own-bucket']) : z.enum(['off', 'managed']),
    keyMode: z.enum(['server', 'own-stored', 'own-memory']),
    schedule: z.string().max(64).regex(BACKUP_SCHEDULE).nullable(),
    retention: z.strictObject({
      daily: z.number().int().min(0).max(366),
      weekly: z.number().int().min(0).max(520),
      monthly: z.number().int().min(0).max(1200),
    }),
    verifyWeekly: z.boolean(),
    escrow: z.boolean(),
    lastRun: z
      .strictObject({
        at: z.iso.datetime({ offset: true }),
        result: z.enum(['running', 'completed', 'failed', 'paused', 'refused', 'cancelled']),
      })
      .nullable(),
  });

export const cloudBackupSettingsSchema = backupSettingsSchema(CLOUD_BACKUP_REPORTS_OWN_BUCKET);
export type CloudBackupSettings = Omit<z.infer<ReturnType<typeof backupSettingsSchema>>, 'target'> & {
  target: 'off' | 'managed' | 'own-bucket';
};

export const licenseStateSchema = z.enum(['none', 'active', 'grace', 'expired', 'invalid']);

export type HeartbeatSettings = {
  remoteAccessSettings?: RemoteAccessSettings;
  cloudMl?: CloudMlSettings;
  cloudBackup?: CloudBackupSettings;
  licenseState?: LicenseState;
};

type FrameleafCloudConfig = SystemConfig['frameleafCloud'];

const checked = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> | undefined => {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
};

/**
 * Remote access as the administrator set it up. The public name itself is never sent, only which kind it
 * is. Remote visitors must sign in with Frameleaf unless password sign-in over the relay is allowed.
 */
export const remoteAccessSettingsOf = (
  settings: FrameleafCloudConfig['remoteAccess'] | undefined,
): RemoteAccessSettings | undefined =>
  settings &&
  checked(remoteAccessSettingsSchema, {
    mode: settings.mode,
    directPort: Number.isSafeInteger(settings.directPort) ? settings.directPort : null,
    portMapping: settings.portMapping,
    allowOriginalsOverRelay: settings.allowOriginalsOverRelay,
    allowPasswordOverRelay: settings.allowPasswordOverRelay,
    publicUrl: settings.publicUrl,
    requireFrameleafSignIn: !settings.allowPasswordOverRelay,
  });

const ROUTES: Record<string, CloudMlRoute> = { local: 'local-only', both: 'both', cloud: 'cloud-only' };

/**
 * The cloud workload each of this server's routes is reported as: Studio AI as `transcription` (speech to
 * text and captions). `tts` has no route of its own here, so it is left out, as the cloud intends for a
 * workload a server doesn't offer.
 */
const ROUTE_WORKLOADS: Record<string, readonly CloudWorkload[]> = {
  descriptions: ['descriptions'],
  upscale: ['upscale'],
  restoration: ['restoration'],
  studio: ['transcription'],
  interpolation: ['interpolation'],
};

/**
 * Cloud processing as the administrator set it up: whether it is on, where each workload runs, the
 * automatic descriptions (`autoBatch`) and their daily budget, the processing terms version accepted, and
 * whether faces may be sent (never, in this version).
 */
export const cloudMlSettingsOf = (
  settings: FrameleafCloudConfig['cloudMl'] | undefined,
  consentVersion: string | null | undefined,
): CloudMlSettings | undefined => {
  if (!settings) {
    return undefined;
  }
  const routing: Partial<Record<CloudWorkload, CloudMlRoute>> = {};
  for (const [route, value] of Object.entries(settings.routing ?? {})) {
    const mapped = ROUTES[value as string];
    for (const workload of ROUTE_WORKLOADS[route] ?? []) {
      if (mapped) {
        routing[workload] = mapped;
      }
    }
  }
  return checked(cloudMlSettingsSchema, {
    enabled: settings.enabled,
    routing,
    autoBatch: settings.autoDescribe.enabled,
    dailyBudgetUsd: settings.autoDescribe.dailyBudgetUsd,
    consentVersion: consentVersion ?? null,
    faces: !!settings.faces?.enabled,
  });
};

type BackupRunResult = NonNullable<CloudBackupSettings['lastRun']>['result'];

/** How a run ended, as the cloud's fixed codes: a run waiting for its key is reported as paused. */
const RUN_RESULTS: Record<string, BackupRunResult> = {
  running: 'running',
  'waiting-for-key': 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * Cloud backup as the administrator set it up, and how the last run ended (a fixed code, never the error
 * text). `keyMode` is this server's encryption key, and `escrow` is true only while a copy of it is held by
 * Frameleaf Cloud. A server backing up to its own bucket reports `own-bucket` (never the bucket's name,
 * endpoint or keys) while `CLOUD_BACKUP_REPORTS_OWN_BUCKET` is on, and leaves the block out otherwise.
 */
export const cloudBackupSettingsOf = (
  settings: FrameleafCloudConfig['cloudBackup'] | undefined,
  metadata: FrameleafCloudBackup | null | undefined,
  ownBucket: boolean = CLOUD_BACKUP_REPORTS_OWN_BUCKET,
): CloudBackupSettings | undefined => {
  if (!settings) {
    return undefined;
  }
  const target = settings.enabled ? (settings.target === 'byo-s3' ? 'own-bucket' : settings.target) : 'off';
  if (target === 'own-bucket' && !ownBucket) {
    return undefined;
  }
  const lastRun = metadata?.lastRun;
  const result = lastRun ? RUN_RESULTS[lastRun.status] : undefined;
  return checked(backupSettingsSchema(ownBucket), {
    target,
    keyMode: metadata?.keyMode ?? settings.keyMode,
    schedule: settings.enabled ? settings.schedule.cronExpression : null,
    retention: {
      daily: settings.retention.keepDaily,
      weekly: settings.retention.keepWeekly,
      monthly: settings.retention.keepMonthly,
    },
    verifyWeekly: settings.verifyWeekly,
    escrow: !!metadata?.escrow,
    lastRun: lastRun && result ? { at: lastRun.startedAt, result } : null,
  });
};

/** The state of the licence certificate this server leads with (its plan, else its key), as it evaluates it. */
export const licenseStateOf = (store: FrameleafLicenseStore | null | undefined, now = Date.now()): LicenseState =>
  licenseStatus(store?.plan ?? store?.key ?? null, now).state;
