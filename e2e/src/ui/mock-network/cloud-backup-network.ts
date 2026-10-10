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
  restoring?: { scope: string; state?: string } | null;
  /** FL-164: a backup run in progress, which Pause, Resume and Cancel change. */
  running?: { state: string } | null;
};

export const RUN_ID = '0195e2a0-0000-7000-8000-00000000beef';
export const RESTORE_ID = '0195e2a0-0000-7000-8000-00000000abcd';

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
    hasDetails: true,
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
    // backed up before item details were recorded: it comes back into the restore folder
    hasDetails: false,
  },
  {
    assetId: '3e9a1c55-7d2b-4f6a-8c1e-5b4d3a2f1e0d',
    name: 'Campfire evening.jpg',
    locked: false,
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    files: 1,
    bytes: 5_100_000,
    modifiedAt: '2026-07-22T21:05:00.000Z',
    state: 'deleted',
    hasDetails: true,
  },
];

/** FL-164: the albums the newest backup can bring back. */
export const MANIFEST_ALBUMS = [
  {
    albumId: '5b0c4e8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d',
    name: 'Lake house weekend',
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    items: 84,
    missing: 84,
    state: 'deleted',
  },
  {
    albumId: '0f0d1e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
    name: 'Moraine Lake',
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    items: 212,
    missing: 3,
    state: 'missing-items',
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
  endpoint: mock.configured ? 'https://s3.eu-central-2.storage.example' : null,
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
  activeRun: mock.running
    ? {
        operationId: RUN_ID,
        state: mock.running.state,
        task: 'backup',
        phase: 'assets',
        progress: 40,
        checked: 0,
        uploaded: 12,
        skipped: 30,
        bytesUploaded: 48_000_000,
      }
    : null,
  activeRestore: mock.restoring
    ? {
        operationId: RESTORE_ID,
        state: mock.restoring.state ?? 'queued',
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
    if (method === 'POST' && path === 'admin/cloud/backup/manifests/albums') {
      return route.fulfill({
        status: 200,
        json: { manifestKey: MANIFESTS[0].key, hasDetails: true, albums: MANIFEST_ALBUMS },
      });
    }
    if (method === 'POST' && path === 'admin/cloud/backup/restore') {
      mock.restoring = { scope: (body as { scope: string }).scope };
    }
    // FL-164: pause, resume and cancel a backup run or a restore
    const control = path.match(/^admin\/cloud\/backup\/runs\/([^/]+)\/(pause|resume|cancel)$/);
    if (method === 'POST' && control) {
      const [, id, action] = control;
      const target = id === RUN_ID ? mock.running : id === RESTORE_ID ? mock.restoring : null;
      if (!target) {
        return route.fulfill({ status: 404, json: { message: 'Backup run not found' } });
      }
      if (action === 'cancel') {
        if (id === RUN_ID) {
          mock.running = null;
        } else {
          mock.restoring = null;
        }
      } else {
        target.state = action === 'pause' ? 'paused' : 'running';
      }
    }
    if (method === 'POST' && path === 'admin/cloud/backup/setup') {
      mock.configured = true;
      mock.keyMode = (body as { keyMode: CloudBackupMockState['keyMode'] }).keyMode;
    }
    return route.fulfill({ status: 200, json: cloudBackupStatus(mock) });
  });
};
