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
  /** FL-164: a restore queued through `POST admin/cloud/backup/restore`, shown as the active restore. */
  restoring?: { scope: string } | null;
};

/** FL-164: the kept backups the Restore section lists, newest first. */
export const MANIFESTS = [
  {
    key: 'm/20260926T030000Z.json.gz',
    status: 'complete',
    createdAt: '2026-09-26T03:00:00.000Z',
    finishedAt: '2026-09-26T03:41:00.000Z',
    assets: 3,
    files: 4,
    bytes: 32_000_000,
    databaseKey: 'db/cloud-backup-immich-db-backup-20260926T030000-v3.2.0-pg16.4.sql.gz',
  },
  {
    key: 'm/20260925T030000Z.json.gz',
    status: 'complete',
    createdAt: '2026-09-25T03:00:00.000Z',
    finishedAt: '2026-09-25T03:40:00.000Z',
    assets: 3,
    files: 4,
    bytes: 31_000_000,
    databaseKey: 'db/cloud-backup-immich-db-backup-20260925T030000-v3.2.0-pg16.4.sql.gz',
  },
];

/** FL-164: what the newest backup holds, and whether each item is still in the library. */
export const MANIFEST_ITEMS = [
  {
    assetId: '8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1',
    name: 'Elk.jpg',
    locked: false,
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    files: 2,
    bytes: 5_100_000,
    modifiedAt: '2026-08-14T09:12:00.000Z',
    state: 'active',
  },
  {
    assetId: '1d7c9e02-5b1a-4c3e-9f7d-2a6b8c0d1e2f',
    name: 'IMG_2041.HEIC',
    locked: false,
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    files: 1,
    bytes: 3_200_000,
    modifiedAt: '2026-08-14T09:12:00.000Z',
    state: 'deleted',
  },
];

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
  activeRestore: mock.restoring
    ? {
        operationId: '0195e2a0-0000-7000-8000-00000000abcd',
        state: 'queued',
        scope: mock.restoring.scope,
        progress: 0,
        files: 0,
        filesTotal: 0,
        bytes: 0,
        bytesTotal: 0,
      }
    : null,
  lastRestore: null,
  lastVerify: null,
  lastPrune: null,
  managed: null,
  escrow: { available: false, stored: false, storedAt: null },
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
    if (method === 'GET' && path === 'admin/cloud/backup/manifests') {
      return route.fulfill({ status: 200, json: { manifests: mock.configured ? MANIFESTS : [] } });
    }
    if (method === 'POST' && path === 'admin/cloud/backup/manifests/items') {
      const { query = '', filter = 'all' } = body as { query?: string; filter?: string };
      const items = MANIFEST_ITEMS.filter(
        (item) =>
          item.name.toLowerCase().includes(query.toLowerCase()) &&
          (filter === 'all' || (filter === 'deleted' ? item.state === 'deleted' : item.state !== 'deleted')),
      );
      return route.fulfill({ status: 200, json: { manifestKey: MANIFESTS[0].key, total: items.length, items } });
    }
    if (method === 'POST' && path === 'admin/cloud/backup/restore') {
      mock.restoring = { scope: (body as { scope: string }).scope };
    }
    if (method === 'POST' && path === 'admin/cloud/backup/setup') {
      mock.configured = true;
      mock.keyMode = (body as { keyMode: CloudBackupMockState['keyMode'] }).keyMode;
    }
    return route.fulfill({ status: 200, json: cloudBackupStatus(mock) });
  });
};
