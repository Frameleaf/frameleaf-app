import { PushEventType } from 'src/enum.js';
import {
  PUSH_PLAINTEXT_MAX_BYTES,
  buildPushPayload,
  cloudBackupActivationProgress,
  collapseIdOf,
  liveActivityPlanOf,
  liveActivityStateOf,
  pushGatewayUrl,
  pushJobData,
  pushSendRequestSchema,
  pushTtlSec,
  shouldSendRenderProgress,
} from 'src/utils/frameleaf-push.js';

const document = {
  version: 1,
  validFor: 3600,
  issuer: 'https://id.frameleaf.test',
  api: 'https://api.frameleaf.test/',
  ml: {},
};

const safe = '11111111-1111-4111-8111-111111111111';
const locked = '22222222-2222-4222-8222-222222222222';
const nsfw = '33333333-3333-4333-8333-333333333333';

describe('Frameleaf push gateway contract (FL-302, FC-92)', () => {
  it('reaches the gateway at the configured address, else the one discovery names, never the api host (FL-293)', () => {
    // `/v1/push/*` answers on the push host only: with no address, push is off
    expect(pushGatewayUrl(document, null)).toBeNull();
    expect(pushGatewayUrl(document, 'https://push.frameleaf.test/')).toBe('https://push.frameleaf.test/v1/push/send');
    const named = { ...document, endpoints: { push: 'https://discovered.frameleaf.test/' } };
    expect(pushGatewayUrl(named, null)).toBe('https://discovered.frameleaf.test/v1/push/send');
    expect(pushGatewayUrl(named, 'https://push.frameleaf.test')).toBe('https://push.frameleaf.test/v1/push/send');
  });

  it('maps the activation chain onto fixed, non-personal Live Activity steps', () => {
    const progress = { total: 4, firstRun: 'not-started' as const, nextRunAt: null };
    expect(liveActivityStateOf({ ...progress, step: 1, stage: 'plan-active', state: 'active' })).toEqual({
      step: 'plan-active',
      progress: 0.25,
    });
    expect(liveActivityStateOf({ ...progress, step: 3, stage: 'preparing-storage', state: 'active' })).toEqual({
      step: 'storage-ready',
      progress: 0.75,
    });
    expect(liveActivityStateOf({ ...progress, step: 4, stage: 'first-backup', state: 'active' })).toEqual({
      step: 'first-backup',
      progress: 1,
    });
    expect(liveActivityStateOf({ ...progress, step: 4, stage: 'first-backup', state: 'complete' })).toEqual({
      step: 'backup-done',
      progress: 1,
    });
    expect(liveActivityStateOf({ ...progress, step: 4, stage: 'first-backup', state: 'failed' })).toEqual({
      step: 'needs-attention',
    });
  });

  it('turns a dedupe key into a collapse id the platforms accept', () => {
    expect(collapseIdOf(undefined)).toBeUndefined();
    expect(collapseIdOf('memories.2026-10-01')).toBe('memories.2026-10-01');
    const hashed = collapseIdOf('album-update/8f6a3c1e-2b4d-4e5f-9a0b-1c2d3e4f5a6b/user');
    expect(hashed).toMatch(/^[\da-f]{32}$/);
    expect(collapseIdOf('album-update/8f6a3c1e-2b4d-4e5f-9a0b-1c2d3e4f5a6b/user')).toBe(hashed);
  });

  it('keeps a wake-up for hours and a notice for a day', () => {
    expect(pushTtlSec({ background: true }, false)).toBe(4 * 3600);
    expect(pushTtlSec({}, false)).toBe(86_400);
    expect(pushTtlSec({}, true)).toBe(3600);
  });
});

describe('push payloads (FL-228)', () => {
  const base = { id: safe, sentAt: '2026-10-01T00:00:00.000Z' };

  it('carries a preview only of items that are neither Locked nor sensitive', () => {
    const payload = buildPushPayload(
      {
        type: PushEventType.SharedActivity,
        title: 'Trip',
        body: 'New photos in Trip',
        data: { albumId: 'album-1' },
        assetIds: [locked, nsfw, safe],
      },
      { ...base, safeAssetIds: new Set([safe]) },
    );

    expect(payload).toEqual({
      v: 1,
      id: safe,
      type: PushEventType.SharedActivity,
      sentAt: base.sentAt,
      title: 'Trip',
      body: 'New photos in Trip',
      data: { albumId: 'album-1' },
      assetIds: [safe],
      preview: { assetId: safe },
    });
  });

  it('a Locked item event carries no preview and never names the item', () => {
    const payload = buildPushPayload(
      {
        type: PushEventType.SharedActivity,
        title: 'Comment',
        body: 'Someone mentioned you',
        data: { activityId: 'activity-1', assetId: locked },
        assetIds: [locked],
      },
      { ...base, safeAssetIds: new Set() },
    );

    expect(payload.preview).toBeNull();
    expect(payload.assetIds).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain(locked);
  });

  it('stays within the size a push can carry', () => {
    const payload = buildPushPayload(
      { type: PushEventType.Memories, title: 't'.repeat(5000), body: 'b'.repeat(5000) },
      { ...base, safeAssetIds: new Set() },
    );
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(PUSH_PLAINTEXT_MAX_BYTES);
  });
});

describe('Cloud Backup activation progress (FL-228)', () => {
  const setup = {
    target: 'managed' as const,
    entitlement: 'seen' as const,
    bucketClaimed: false,
    firstRun: 'not-started' as const,
    nextRunAt: null,
  };

  it('counts the four steps of the activation chain', () => {
    expect(cloudBackupActivationProgress({ ...setup, entitlement: 'pending' })).toMatchObject({
      step: 1,
      total: 4,
      stage: 'plan-active',
      state: 'active',
    });
    expect(cloudBackupActivationProgress(setup)).toMatchObject({
      step: 3,
      stage: 'preparing-storage',
      state: 'active',
    });
    expect(
      cloudBackupActivationProgress({ ...setup, bucketClaimed: true, nextRunAt: '2026-10-02T02:00:00.000Z' }),
    ).toEqual({
      step: 4,
      total: 4,
      stage: 'first-backup',
      state: 'active',
      firstRun: 'not-started',
      nextRunAt: '2026-10-02T02:00:00.000Z',
    });
    expect(cloudBackupActivationProgress({ ...setup, bucketClaimed: true, firstRun: 'done' })).toMatchObject({
      step: 4,
      state: 'complete',
    });
    expect(cloudBackupActivationProgress({ ...setup, bucketClaimed: true, firstRun: 'failed' })).toMatchObject({
      step: 4,
      state: 'failed',
    });
  });

  it('has no chain when cloud backup is off', () => {
    expect(cloudBackupActivationProgress({ ...setup, target: 'off' })).toBeNull();
  });
});

describe('push job reference (native apps: Retry and Pause)', () => {
  it('names the job, its API and the actions on offer as plain data fields', () => {
    expect(pushJobData({ id: 'op-1', type: 'media-operation', actions: ['retry'] })).toEqual({
      job: 'op-1',
      jobType: 'media-operation',
      jobActions: 'retry',
    });
    expect(pushJobData({ id: 'run-1', type: 'cloud-backup-run', actions: ['pause', 'cancel'] })).toEqual({
      job: 'run-1',
      jobType: 'cloud-backup-run',
      jobActions: 'pause,cancel',
    });
    expect(pushJobData(undefined)).toEqual({});
  });

  it('reaches the device payload unchanged', () => {
    const payload = buildPushPayload(
      {
        type: PushEventType.RenderFinished,
        title: 'Render failed',
        body: 'x',
        data: { versionId: 'v', ...pushJobData({ id: 'op-9', type: 'media-operation', actions: ['retry'] }) },
      },
      { id: 'p', sentAt: '2026-10-08T00:00:00.000Z', safeAssetIds: new Set() },
    );
    expect(payload.data).toMatchObject({ job: 'op-9', jobType: 'media-operation', jobActions: 'retry' });
  });
});

describe('Studio render progress pushes', () => {
  it('throttles to a 5% step, or any movement after 10 seconds, and always sends the first report', () => {
    expect(shouldSendRenderProgress(undefined, 0, 0)).toBe(true);
    expect(shouldSendRenderProgress({ progress: 0.1, at: 0 }, 0.14, 1000)).toBe(false);
    expect(shouldSendRenderProgress({ progress: 0.1, at: 0 }, 0.15, 1000)).toBe(true);
    expect(shouldSendRenderProgress({ progress: 0.1, at: 0 }, 0.11, 9999)).toBe(false);
    expect(shouldSendRenderProgress({ progress: 0.1, at: 0 }, 0.11, 10_000)).toBe(true);
    expect(shouldSendRenderProgress({ progress: 0.1, at: 0 }, 0.1, 60_000)).toBe(false);
  });

  it('maps a render to the RenderAttributes Live Activity: start only at the start, end when it finishes', () => {
    const plan = (state: 'started' | 'running' | 'done' | 'failed', progress = 0.5) =>
      liveActivityPlanOf({ render: { job: 'job-1', state, progress } });
    expect(plan('started', 0)).toEqual({
      kind: 'studio-render',
      attributesType: 'RenderAttributes',
      state: { step: 'render-running', progress: 0 },
      start: true,
      end: false,
      liveOnly: false,
    });
    expect(plan('running')).toMatchObject({ start: false, end: false, liveOnly: true });
    expect(plan('done')).toMatchObject({ state: { step: 'render-done', progress: 1 }, end: true, liveOnly: false });
    expect(plan('failed')).toMatchObject({ state: { step: 'needs-attention' }, end: true });
    expect(liveActivityPlanOf({})).toBeNull();
  });

  it('lets the gateway start a render Live Activity and nothing but the two known attribute types', () => {
    const request = {
      platform: 'apns',
      token: 'start-1-0123456789abcdef0123456789abcdef',
      type: 'live-activity-start',
      priority: 'high',
      ttlSec: 3600,
      liveActivity: { state: { step: 'render-running', progress: 0 }, attributesType: 'RenderAttributes' },
    };
    expect(pushSendRequestSchema.safeParse(request).success).toBe(true);
    expect(
      pushSendRequestSchema.safeParse({
        ...request,
        liveActivity: { ...request.liveActivity, attributesType: 'OtherAttributes' },
      }).success,
    ).toBe(false);
  });
});
