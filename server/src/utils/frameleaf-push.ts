import { createHash } from 'node:crypto';
import z from 'zod';
import type { FrameleafDiscoveryDocument } from 'src/utils/frameleaf-cloud.js';
import { PushEventType } from 'src/enum.js';
import { type SystemNotificationTemplate, renderSystemNotification } from 'src/utils/notification-locale.js';

/**
 * FL-302 (NAPI-015): the Frameleaf push gateway contract (FC-92, `push.frameleaf.cloud`; frameleaf-cloud
 * `packages/contracts/src/instance/push.ts` and `docs/native-apps-cloud.md`). It replaces FL-228's
 * assumed batch contract.
 *
 * - Address (FL-293): the gateway answers on its own host only (`/v1/push/*` is a 404 on the API
 *   host), and discovery does not name it today. It is `FRAMELEAF_PUSH_URL`, else discovery's
 *   `endpoints.push` should Frameleaf Cloud publish one; without either, push is off.
 * - The token is the ordinary instance token (the `api` resource), DPoP-bound to the instance key
 *   (FL-178), with the proof made for the push address.
 * - `POST <push>/v1/push/send`, one push per request: the target (`platform`: `apns`, `apns-sandbox`
 *   for development builds, or `fcm`; and `token`), the push `type`, `priority`, `collapseId`,
 *   `ttlSec`, and either the end-to-end encrypted `payload` (alert and background: the frameleaf-push-v1
 *   envelope, `docs/developer/push-envelope-v1.md`) or, for a Live Activity, a fixed non-personal
 *   `liveActivity.state` (ActivityKit renders the content state itself; nothing can decrypt it).
 * - Answer `{ status, retryAfterSec? }`: `sent`; `invalid-token` (this server must not use the token
 *   again); `throttled` or `retry` (try again later, after `retryAfterSec` when given).
 *
 * The server never holds APNs or FCM credentials; the gateway does.
 */
export const PUSH_GATEWAY_PATH = '/v1/push/send';
/** Sends in flight at once for one notice; the gateway allows 600 a minute per instance. */
export const PUSH_GATEWAY_CONCURRENCY = 8;
/** Delivery attempts for a target the gateway asked to retry (the first included). */
export const PUSH_GATEWAY_MAX_ATTEMPTS = 5;
/** The gateway's limit on the encrypted payload (base64url characters). */
export const PUSH_PAYLOAD_MAX_CHARS = 3072;

/** The ActivityKit attributes kind of the Cloud Backup activation Live Activity (FL-266), as the app registers it. */
export const CLOUD_BACKUP_ACTIVITY_KIND = 'cloud-backup-activation';
/** Its ActivityKit attributes type, as the gateway names it. */
export const CLOUD_BACKUP_ATTRIBUTES_TYPE = 'ActivationAttributes';
/** The ActivityKit attributes kind of the Studio render progress Live Activity, as the app registers it. */
export const STUDIO_RENDER_ACTIVITY_KIND = 'studio-render';
/** Its ActivityKit attributes type, as the gateway names it. */
export const STUDIO_RENDER_ATTRIBUTES_TYPE = 'RenderAttributes';
/** The Live Activity kinds an app may register an update token for. */
export const LIVE_ACTIVITY_KINDS = [CLOUD_BACKUP_ACTIVITY_KIND, STUDIO_RENDER_ACTIVITY_KIND] as const;

/** A render progress push goes out when progress moved by at least this fraction since the last one... */
export const RENDER_PROGRESS_MIN_STEP = 0.05;
/** ...or when this long passed since the last one and progress moved at all. */
export const RENDER_PROGRESS_MIN_INTERVAL_MS = 10_000;

/**
 * The largest plaintext a payload may have before encryption: the envelope adds 61 bytes and
 * base64url a third, so 2 KiB of plaintext stays within the gateway's 3 KiB payload.
 */
export const PUSH_PLAINTEXT_MAX_BYTES = 2048;

/** At most this many item ids travel in one payload. */
export const PUSH_MAX_ASSET_IDS = 5;

/** Where pushes are sent: the configured address, else the one discovery names; null when neither. */
export const pushGatewayUrl = (
  document: Pick<FrameleafDiscoveryDocument, 'api' | 'endpoints'>,
  configured: string | null,
): string | null => {
  const base = (configured || document.endpoints?.push)?.replace(/\/+$/, '');
  return base ? `${base}${PUSH_GATEWAY_PATH}` : null;
};

/** Which token of a device a push goes to; an `invalid-token` answer forgets exactly that one. */
export enum PushTargetKind {
  Device = 'device',
  ActivityStart = 'activity-start',
  ActivityUpdate = 'activity-update',
}

export const LIVE_ACTIVITY_STEPS = [
  'plan-active',
  'server-notified',
  'storage-ready',
  'first-backup',
  'backup-running',
  'backup-done',
  'render-running',
  'render-done',
  'needs-attention',
] as const;

const liveActivityStateSchema = z
  .object({
    step: z.enum(LIVE_ACTIVITY_STEPS),
    progress: z.number().min(0).max(1).optional(),
    done: z.int().min(0).max(1e9).optional(),
    total: z.int().min(0).max(1e9).optional(),
  })
  .strict();
export type LiveActivityState = z.infer<typeof liveActivityStateSchema>;

/** A token the gateway takes: an APNs (hex) or ActivityKit token, or an FCM registration token. */
export const isGatewayToken = (token: string) => token.length >= 32 && token.length <= 4096 && /^[\w:-]+$/.test(token);

const LIVE_TYPES = ['live-activity-start', 'live-activity-update', 'live-activity-end'] as const;

/** What may go to the gateway; checked before every request, so nothing else can leave. */
export const pushSendRequestSchema = z
  .object({
    platform: z.enum(['apns', 'apns-sandbox', 'fcm']),
    token: z.string().refine((token) => isGatewayToken(token)),
    type: z.enum(['alert', 'background', ...LIVE_TYPES]),
    priority: z.enum(['high', 'normal']),
    collapseId: z
      .string()
      .regex(/^[\w.-]{1,64}$/)
      .optional(),
    ttlSec: z.int().min(0).max(604_800),
    payload: z
      .string()
      .max(PUSH_PAYLOAD_MAX_CHARS)
      .regex(/^[\w-]*$/)
      .optional(),
    liveActivity: z
      .object({
        state: liveActivityStateSchema,
        attributesType: z.enum([CLOUD_BACKUP_ATTRIBUTES_TYPE, STUDIO_RENDER_ATTRIBUTES_TYPE]).optional(),
        staleAfterSec: z.int().positive().max(86_400).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const live = (LIVE_TYPES as readonly string[]).includes(request.type);
    const problems = [
      live && request.platform === 'fcm' && 'Live Activities are iOS only',
      live === !request.liveActivity && 'Only Live Activity pushes carry a state, and every one does',
      live === !!request.payload && 'Alert and background pushes carry the encrypted payload, Live Activities never do',
      request.type === 'live-activity-start' &&
        !request.liveActivity?.attributesType &&
        'Starting a Live Activity needs its attributes type',
    ];
    const problem = problems.find((value) => typeof value === 'string');
    if (problem) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });
export type PushSendRequest = z.infer<typeof pushSendRequestSchema>;

export const pushSendResultSchema = z.object({
  status: z.enum(['sent', 'invalid-token', 'throttled', 'retry']),
  retryAfterSec: z.int().positive().optional(),
});
export type PushSendResult = z.infer<typeof pushSendResultSchema>;

/** The Live Activity state of an activation step: no free text, nothing personal. */
export const liveActivityStateOf = (progress: CloudBackupActivationProgress): LiveActivityState => {
  if (progress.state === 'failed') {
    return { step: 'needs-attention' };
  }
  const step = {
    'plan-active': 'plan-active',
    'server-notified': 'server-notified',
    'preparing-storage': 'storage-ready',
    'first-backup': progress.state === 'complete' ? 'backup-done' : 'first-backup',
  } as const;
  return { step: step[progress.stage], progress: Math.min(1, progress.step / progress.total) };
};

/**
 * The progress of one Studio render (export), as a push carries it:
 * - `started`: a render worker took the job (progress 0, or where a resumed job stands);
 * - `running`: progress moved (throttled with `shouldSendRenderProgress`);
 * - `done` / `failed`: the render finished; this rides on the `render-finished` notice.
 */
export type StudioRenderProgress = {
  /** The render's media operation id (`POST /media-operations/{job}/...`). */
  job: string;
  state: 'started' | 'running' | 'done' | 'failed';
  /** 0..1. */
  progress: number;
};

/** The Live Activity state of a render: no free text, nothing personal. */
export const renderLiveActivityStateOf = (render: StudioRenderProgress): LiveActivityState => {
  if (render.state === 'failed') {
    return { step: 'needs-attention' };
  }
  if (render.state === 'done') {
    return { step: 'render-done', progress: 1 };
  }
  return { step: 'render-running', progress: Math.min(1, Math.max(0, render.progress)) };
};

/**
 * Whether a render's progress is worth a push: the first report of a job always is; later ones when the
 * fraction moved by `RENDER_PROGRESS_MIN_STEP`, or moved at all after `RENDER_PROGRESS_MIN_INTERVAL_MS`.
 */
export const shouldSendRenderProgress = (
  last: { progress: number; at: number } | undefined,
  progress: number,
  now: number,
): boolean => {
  if (!last) {
    return true;
  }
  const moved = progress - last.progress;
  return moved >= RENDER_PROGRESS_MIN_STEP - 1e-9 || (moved > 0 && now - last.at >= RENDER_PROGRESS_MIN_INTERVAL_MS);
};

/**
 * How a notice drives a Live Activity on iOS, if it does:
 * - `kind` / `attributesType`: which activity (as the app registered its token, and as push-to-start names it);
 * - `start`: whether a device without one may be pushed to start one (push-to-start token);
 * - `end`: whether the activity ends with this state;
 * - `liveOnly`: whether iOS gets only the Live Activity, without the alert or background payload.
 */
export type LiveActivityPlan = {
  kind: (typeof LIVE_ACTIVITY_KINDS)[number];
  attributesType: typeof CLOUD_BACKUP_ATTRIBUTES_TYPE | typeof STUDIO_RENDER_ATTRIBUTES_TYPE;
  state: LiveActivityState;
  start: boolean;
  end: boolean;
  liveOnly: boolean;
};

export const liveActivityPlanOf = (notice: Pick<PushNotice, 'activation' | 'render'>): LiveActivityPlan | null => {
  if (notice.activation) {
    const active = notice.activation.state === 'active';
    return {
      kind: CLOUD_BACKUP_ACTIVITY_KIND,
      attributesType: CLOUD_BACKUP_ATTRIBUTES_TYPE,
      state: liveActivityStateOf(notice.activation),
      start: active,
      end: !active,
      liveOnly: active,
    };
  }
  if (notice.render) {
    const { state } = notice.render;
    return {
      kind: STUDIO_RENDER_ACTIVITY_KIND,
      attributesType: STUDIO_RENDER_ATTRIBUTES_TYPE,
      state: renderLiveActivityStateOf(notice.render),
      // only the start of a render may start an activity, so a declined one is not started again
      start: state === 'started',
      end: state === 'done' || state === 'failed',
      // the start also reaches iOS as a background push naming the job; later steps are the activity alone
      liveOnly: state === 'running',
    };
  }
  return null;
};

/** A notice's dedupe key as an APNs collapse id / FCM collapse key (64 safe characters at most). */
export const collapseIdOf = (dedupeKey: string | undefined): string | undefined => {
  if (!dedupeKey) {
    return;
  }
  return /^[\w.-]{1,64}$/.test(dedupeKey)
    ? dedupeKey
    : createHash('sha256').update(dedupeKey).digest('hex').slice(0, 32);
};

/** How long a platform may hold a push for an offline device: a wake-up is stale after hours, a notice after a day. */
export const pushTtlSec = (notice: Pick<PushNotice, 'background'>, live: boolean): number =>
  live ? 3600 : notice.background ? 4 * 3600 : 86_400;

/** Plain values only; identifiers, counts and names, never file paths or credentials. */
export type PushNoticeData = Record<string, string | number | boolean | null>;

/**
 * Which API a server job named in a push answers to:
 * - `media-operation`: `POST /media-operations/{job}/retry`, `/pause`, `/resume`, `/cancel` (Activity jobs:
 *   Studio exports, photo and video edits, restorations, bulk operations);
 * - `cloud-backup-run` (administrators): `POST /admin/cloud/backup/runs/{job}/pause`, `/resume`, `/cancel`,
 *   and `POST /admin/cloud/backup/runs` to retry (a new run uploads only what is still missing).
 */
export type PushJobType = 'media-operation' | 'cloud-backup-run';
/** What a device may offer for the job at the time the push was built. */
export type PushJobAction = 'retry' | 'pause' | 'resume' | 'cancel';
export type PushJobRef = { id: string; type: PushJobType; actions: PushJobAction[] };

/**
 * The `data` fields that name the server job a notice is about, so an app can offer Retry or Pause for
 * it: `job` (the job's id), `jobType` (which API answers for it) and `jobActions` (comma-separated
 * actions on offer, possibly empty). Absent when the notice is not about a job.
 */
export const pushJobData = (job: PushJobRef | null | undefined): PushNoticeData =>
  job ? { job: job.id, jobType: job.type, jobActions: job.actions.join(',') } : {};

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
  /** Supplied fallback text, preserved for legacy notices. */
  title: string;
  body: string;
  /** FL-329: origin-only system template, rendered per recipient device before encryption. */
  systemTemplate?: SystemNotificationTemplate;
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
  /** A Studio render's progress, for the Live Activity (iOS) and the progress notification (Android). */
  render?: StudioRenderProgress;
  /** Coalesces notices about the same thing while one waits (`PushDeliver` job id). */
  dedupeKey?: string;
  /** How long to wait before delivering, so a burst becomes one notice. */
  delayMs?: number;
  /**
   * FL-302: a later attempt for only these targets (`deliveryKeyOf`), which the gateway asked to retry.
   * It keeps the first attempt's collapse id, since the retry job no longer carries the dedupe key.
   */
  retry?: { targets: string[]; attempt: number; collapseId?: string };
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
 * Locked item's event carries no preview and no trace of the item. (A Live Activity carries no payload
 * at all, only its fixed state.) The result always fits `PUSH_PLAINTEXT_MAX_BYTES`.
 */
export const buildPushPayload = (
  notice: Pick<PushNotice, 'type' | 'title' | 'body' | 'data' | 'assetIds' | 'activation' | 'systemTemplate'>,
  options: { id: string; sentAt: string; safeAssetIds: ReadonlySet<string>; locale?: string },
): PushPayload => {
  const candidates = notice.assetIds ?? [];
  const withheld = new Set(candidates.filter((id) => !options.safeAssetIds.has(id)));
  const assetIds = candidates.filter((id) => options.safeAssetIds.has(id)).slice(0, PUSH_MAX_ASSET_IDS);
  const data = Object.fromEntries(
    Object.entries(notice.data ?? {}).filter(([, value]) => typeof value !== 'string' || !withheld.has(value)),
  );
  const text = renderSystemNotification(notice.systemTemplate, options.locale ?? 'en', notice);
  const payload: PushPayload = {
    v: 1,
    id: options.id,
    type: notice.type,
    sentAt: options.sentAt,
    title: truncate(text.title, 120),
    body: truncate(text.body, 400),
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
