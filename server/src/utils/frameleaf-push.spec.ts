import { PushEventType, PushPlatform } from 'src/enum.js';
import {
  PUSH_PLAINTEXT_MAX_BYTES,
  buildPushPayload,
  cloudBackupActivationProgress,
  pushGatewayBase,
  pushGatewayRequestSchema,
  pushGatewayUrl,
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

describe('Frameleaf push gateway contract (FL-228)', () => {
  it('reaches the push gateway through discovery, following api when it names none', () => {
    expect(pushGatewayBase(document)).toBe('https://api.frameleaf.test');
    expect(pushGatewayUrl(document)).toBe('https://api.frameleaf.test/v1/push/messages');
    const named = { ...document, endpoints: { push: 'https://push.frameleaf.test/' } };
    expect(pushGatewayBase(named)).toBe('https://push.frameleaf.test');
    expect(pushGatewayUrl(named)).toBe('https://push.frameleaf.test/v1/push/messages');
  });

  it('accepts only a target and an opaque blob per message', () => {
    const message = {
      id: safe,
      target: { platform: PushPlatform.Ios, token: 'apns-token', kind: 'device', mode: 'alert' },
      blob: 'AQ',
    };
    expect(pushGatewayRequestSchema.safeParse({ messages: [message] }).success).toBe(true);
    expect(pushGatewayRequestSchema.safeParse({ messages: [{ ...message, title: 'Hello' }] }).success).toBe(false);
    expect(
      pushGatewayRequestSchema.safeParse({ messages: [{ ...message, target: { ...message.target, body: 'Hello' } }] })
        .success,
    ).toBe(false);
    expect(pushGatewayRequestSchema.safeParse({ messages: [{ ...message, blob: 'not base64url!' }] }).success).toBe(
      false,
    );
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

  it('a Live Activity payload never carries items or previews', () => {
    const payload = buildPushPayload(
      { type: PushEventType.CloudBackupActivation, title: 'Cloud Backup setup', body: '3 of 4', assetIds: [safe] },
      { ...base, safeAssetIds: new Set([safe]), liveActivity: true },
    );

    expect(payload.assetIds).toEqual([]);
    expect(payload.preview).toBeNull();
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
