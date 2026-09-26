import { BrowserContext } from '@playwright/test';

/**
 * Mocked cloud backup routes (FL-160), alongside `base-network.ts` and `cloud-network.ts`: the admin
 * API this server exposes (`admin/cloud/backup/*`) and a licence with the cloud backup entitlement.
 * Register it after `setupCloudMockApiRoutes`, whose `admin/cloud/**` route it takes precedence over.
 * Nothing reaches a real bucket.
 */
export type CloudBackupMockState = {
  configured: boolean;
  keyMode: 'server' | 'own-stored' | 'own-memory' | null;
  requests: Array<{ method: string; path: string; body?: unknown }>;
};

export const GENERATED_KEY = {
  key: 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=',
  fingerprint: '0B2A-E445',
  recoveryCode: 'FLRK-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E1R7-0W3G-E0',
  createdAt: '2026-09-26T03:00:00.000Z',
};

export const cloudBackupStatus = (mock: CloudBackupMockState) => ({
  configured: mock.configured,
  target: mock.configured ? 'byo-s3' : 'off',
  managedAvailable: false,
  endpoint: mock.configured ? 'https://s3.eu-central-2.wasabisys.test' : null,
  region: mock.configured ? 'eu-central-2' : null,
  bucket: mock.configured ? 'family-backup' : null,
  instanceId: mock.configured ? '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55' : null,
  claimedAt: mock.configured ? '2026-09-26T03:00:00.000Z' : null,
  keyMode: mock.keyMode,
  keyFingerprint: mock.configured ? GENERATED_KEY.fingerprint : null,
  keyLoaded: mock.configured,
  lastRun: null,
  lastSuccessAt: null,
  lastManifestKey: null,
  usage: mock.configured ? { objects: 0, bytes: 0 } : null,
  activeRun: null,
});

const license = {
  configured: true,
  entitlements: { cloudBackup: true, cloudMl: false, frameleafCloud: true, remoteAccess: false, supporter: false },
  expiresAt: null,
  fingerprint: { instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', jkt: null },
  graceUntil: null,
  key: null,
  keyHint: null,
  kind: null,
  licensed: true,
  linked: true,
  offline: false,
  plan: null,
  refresh: { lastError: null, nextRefreshAt: null, refreshedAt: null },
  state: 'active',
};

export const setupCloudBackupMockApiRoutes = async (context: BrowserContext, mock: CloudBackupMockState) => {
  await context.route('**/api/admin/license**', (route) => route.fulfill({ status: 200, json: license }));
  await context.route('**/api/admin/cloud/backup**', async (route, request) => {
    const path = new URL(request.url()).pathname.replace('/api/', '');
    const method = request.method();
    const body = request.postDataJSON?.() ?? undefined;
    mock.requests.push({ method, path, body });

    if (method === 'POST' && path === 'admin/cloud/backup/check') {
      return route.fulfill({
        status: 200,
        json: {
          ok: true,
          state: 'empty',
          message: 'Connected. The provider accepted and returned a test file encrypted with a customer key (SSE-C).',
        },
      });
    }
    if (method === 'POST' && path === 'admin/cloud/backup/key') {
      return route.fulfill({ status: 201, json: GENERATED_KEY });
    }
    if (method === 'POST' && path === 'admin/cloud/backup/setup') {
      mock.configured = true;
      mock.keyMode = (body as { keyMode: CloudBackupMockState['keyMode'] }).keyMode;
    }
    return route.fulfill({ status: 200, json: cloudBackupStatus(mock) });
  });
};
