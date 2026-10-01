import z from 'zod';
import type { FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { PushEventType, PushPlatform } from 'src/enum.js';

/**
 * FL-228: the server side of the Frameleaf push gateway (`push.frameleaf.cloud`, Frameleaf Cloud C5).
 *
 * ASSUMED CONTRACT. The gateway is Frameleaf Cloud work and its contract was not published when this was
 * written, so this module is the server's statement of it; a change on the cloud side changes it here.
 *
 * - Address: discovery's `endpoints.push` when present, else `api` (FL-155: "absent ones follow `api`").
 *   The instance token is requested with that address as its `resource`, DPoP-bound to the instance key
 *   like every other instance call (FL-178).
 * - `POST <push>/v1/push/messages`, `Authorization: DPoP <instance token>`, `DPoP: <proof>`, body
 *   `{ messages: PushGatewayMessage[] }` (at most `PUSH_GATEWAY_BATCH` per request), nothing else.
 *   Each message is `{ id, target, blob }`:
 *   - `id`: a random UUID, the gateway's idempotency key for that message;
 *   - `target`: where and how to deliver, never what: the platform (`ios` → APNs, `android` → FCM HTTP v1),
 *     the token, which token it is (`device`, ActivityKit `activity-start` or `activity-update`), the
 *     delivery mode (`alert`: a visible notification the app's Notification Service Extension / messaging
 *     service decrypts; `background`: a silent wake-up; `liveactivity`: an ActivityKit push whose
 *     content-state is `{ "e": <blob> }`), and for Live Activities the ActivityKit event and attributes type;
 *   - `blob`: the payload encrypted to the device key (`src/utils/push-crypto.ts`), opaque to the gateway.
 * - Answer `200`/`202` `{ results: [{ id, status }] }`: `accepted`; `unregistered` (APNs 410 / FCM
 *   UNREGISTERED: the token is gone, and this server forgets it); `rejected` (anything else; logged as a
 *   count only). Errors use the Frameleaf Cloud error envelope like every other cloud call.
 *
 * The server never holds APNs or FCM credentials; the gateway does.
 */
export const PUSH_GATEWAY_PATH = '/v1/push/messages';
export const PUSH_GATEWAY_BATCH = 100;

/** The ActivityKit attributes type of the Cloud Backup activation Live Activity (FL-266). */
export const CLOUD_BACKUP_ACTIVITY_KIND = 'cloud-backup-activation';

/**
 * The largest plaintext a payload may have before encryption. APNs takes 4 KiB, FCM data messages
 * 4 KiB; the envelope adds 61 bytes and base64url a third, and the gateway needs room for its own
 * wrapping, so 2 KiB of plaintext always fits.
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 2048;

/** At most this many item ids travel in one payload. */
export const PUSH_MAX_ASSET_IDS = 5;

export const pushGatewayBase = (document: Pick<FrameleafDiscoveryDocument, 'api' | 'endpoints'>): string =>
  (document.endpoints?.push ?? document.api).replace(/\/+$/, '');

export const pushGatewayUrl = (document: Pick<FrameleafDiscoveryDocument, 'api' | 'endpoints'>): string =>
  `${pushGatewayBase(document)}${PUSH_GATEWAY_PATH}`;

export enum PushTargetKind {
  Device = 'device',
  ActivityStart = 'activity-start',
  ActivityUpdate = 'activity-update',
}

export enum PushDeliveryMode {
  Alert = 'alert',
  Background = 'background',
  LiveActivity = 'liveactivity',
}

const pushTargetSchema = z
  .object({
    platform: z.enum(PushPlatform),
    token: z.string().min(1).max(4096),
    kind: z.enum(PushTargetKind),
    mode: z.enum(PushDeliveryMode),
    activityEvent: z.enum(['start', 'update', 'end']).optional(),
    activityKind: z.literal(CLOUD_BACKUP_ACTIVITY_KIND).optional(),
  })
  .strict();
export type PushGatewayTarget = z.infer<typeof pushTargetSchema>;

const pushMessageSchema = z
  .object({
    id: z.uuid(),
    target: pushTargetSchema,
    blob: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[\w-]+$/),
  })
  .strict();
export type PushGatewayMessage = z.infer<typeof pushMessageSchema>;

/** What may go to the gateway; checked before every request, so nothing else can leave. */
export const pushGatewayRequestSchema = z
  .object({ messages: z.array(pushMessageSchema).min(1).max(PUSH_GATEWAY_BATCH) })
  .strict();
export type PushGatewayRequest = z.infer<typeof pushGatewayRequestSchema>;

export const pushGatewayResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['accepted', 'unregistered', 'rejected']),
    }),
  ),
});
export type PushGatewayResponse = z.infer<typeof pushGatewayResponseSchema>;

/** Plain values only; identifiers, counts and names, never file paths or credentials. */
export type PushNoticeData = Record<string, string | number | boolean | null>;

/** The Cloud Backup activation chain, as the activation screen and its Live Activity show it. */
export type CloudBackupActivationProgress = {
  step: number;
  total: number;
  stage: 'plan-active' | 'server-notified' | 'preparing-storage' | 'first-backup';
  state: 'active' | 'complete' | 'failed';
  firstRun: 'not-started' | 'queued' | 'running' | 'done' | 'failed';
  nextRunAt: string | null;
};

/**
 * One push notice, as a service raises it (`PushNotify`) and the delivery job carries it. It names
 * recipients and what happened; the payload each device gets is built from it at delivery time.
 */
export type PushNotice = {
  type: PushEventType;
  /** Recipients by user id. */
  userIds?: string[];
  /** Every administrator, in addition to `userIds` (the server owner's events). */
  admins?: boolean;
  /** English fallback text; the app may localise from `type` and `data` instead. */
  title: string;
  body: string;
  data?: PushNoticeData;
  /**
   * Items the notice is about. Only items that are neither Locked nor sensitive reach a payload
   * (and the first of them becomes its preview); the others are dropped without a trace.
   */
  assetIds?: string[];
  /** Only the push devices linked to this phone backup device (`backup_device.deviceKey`). */
  backupDeviceKey?: string;
  /** A silent wake-up instead of a visible notification. */
  background?: boolean;
  /** The activation chain's state, for the Live Activity. */
  activation?: CloudBackupActivationProgress;
  /** Coalesces notices about the same thing while one waits (`PushDeliver` job id). */
  dedupeKey?: string;
  /** How long to wait before delivering, so a burst becomes one notice. */
  delayMs?: number;
};

/** The plaintext a device decrypts. */
export type PushPayload = {
  v: 1;
  id: string;
  type: PushEventType;
  sentAt: string;
  title: string;
  body: string;
  data: PushNoticeData;
  assetIds: string[];
  preview: { assetId: string } | null;
  activation?: CloudBackupActivationProgress;
};

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;

/**
 * The payload for one notice. Privacy (FL-137, FL-212/FL-213): an item that is not in `safeAssetIds`
 * (Locked, sensitive, hidden or gone) is never named; data values naming it are dropped as well, so a
 * Locked item's event carries no preview and no trace of the item. A Live Activity carries no items at
 * all. The result always fits `PUSH_PLAINTEXT_MAX_BYTES`.
 */
export const buildPushPayload = (
  notice: Pick<PushNotice, 'type' | 'title' | 'body' | 'data' | 'assetIds' | 'activation'>,
  options: { id: string; sentAt: string; safeAssetIds: ReadonlySet<string>; liveActivity?: boolean },
): PushPayload => {
  const candidates = notice.assetIds ?? [];
  const withheld = new Set(candidates.filter((id) => !options.safeAssetIds.has(id)));
  const assetIds = options.liveActivity
    ? []
    : candidates.filter((id) => options.safeAssetIds.has(id)).slice(0, PUSH_MAX_ASSET_IDS);
  const data = Object.fromEntries(
    Object.entries(notice.data ?? {}).filter(([, value]) => typeof value !== 'string' || !withheld.has(value)),
  );
  const payload: PushPayload = {
    v: 1,
    id: options.id,
    type: notice.type,
    sentAt: options.sentAt,
    title: truncate(notice.title, 120),
    body: truncate(notice.body, 400),
    data,
    assetIds,
    preview: assetIds.length > 0 ? { assetId: assetIds[0] } : null,
    ...(notice.activation && { activation: notice.activation }),
  };
  // text is the only open-ended part; shorten it until the payload fits
  while (Buffer.byteLength(JSON.stringify(payload)) > PUSH_PLAINTEXT_MAX_BYTES && payload.body.length > 0) {
    payload.body = truncate(payload.body, Math.floor(payload.body.length / 2));
  }
  while (Buffer.byteLength(JSON.stringify(payload)) > PUSH_PLAINTEXT_MAX_BYTES && payload.title.length > 0) {
    payload.title = truncate(payload.title, Math.floor(payload.title.length / 2));
  }
  return payload;
};

/**
 * FL-228 / FL-234: the four steps of the Cloud Backup activation chain (plan active → server notified →
 * storage ready → first backup) from the owner's setup state. Only Frameleaf-managed storage has the
 * chain; null otherwise.
 */
export const cloudBackupActivationProgress = (setup: {
  target: 'off' | 'managed' | 'byo-s3';
  entitlement: 'not-applicable' | 'pending' | 'seen';
  bucketClaimed: boolean;
  firstRun: CloudBackupActivationProgress['firstRun'];
  nextRunAt: string | null;
}): CloudBackupActivationProgress | null => {
  if (setup.target !== 'managed') {
    return null;
  }
  const base = { total: 4, firstRun: setup.firstRun, nextRunAt: setup.nextRunAt };
  if (setup.entitlement !== 'seen') {
    return { ...base, step: 1, stage: 'plan-active', state: 'active' };
  }
  if (!setup.bucketClaimed) {
    // the plan is active and the server has seen it: storage is being prepared
    return { ...base, step: 3, stage: 'preparing-storage', state: 'active' };
  }
  const state = setup.firstRun === 'done' ? 'complete' : setup.firstRun === 'failed' ? 'failed' : 'active';
  return { ...base, step: 4, stage: 'first-backup', state };
};

/** The English line for an activation step, e.g. "3 of 4 · Preparing storage". */
export const activationLine = (progress: CloudBackupActivationProgress): string => {
  const label = {
    'plan-active': 'Activating your plan',
    'server-notified': 'Notifying your server',
    'preparing-storage': 'Preparing storage',
    'first-backup':
      progress.state === 'complete'
        ? 'First backup complete'
        : progress.state === 'failed'
          ? 'First backup needs attention'
          : progress.firstRun === 'running'
            ? 'First backup running'
            : 'First backup scheduled',
  }[progress.stage];
  return `${progress.step} of ${progress.total} · ${label}`;
};
