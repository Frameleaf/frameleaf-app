import { BrowserContext } from '@playwright/test';

/**
 * Mocked Frameleaf Cloud link routes (FL-155), alongside `base-network.ts`: the admin API this
 * server exposes (`admin/cloud/*`), scripted through `state`. Specs change `state` to move the link
 * between not configured, unlinked, pending, linked and revoked; the real hosted cloud is never used.
 */
export type CloudMockState = {
  state: 'not-configured' | 'unlinked' | 'pending' | 'linked' | 'revoked';
  requests: Array<{ method: string; path: string; body?: unknown }>;
};

const heartbeatFields = [
  'version',
  'bootId',
  'uptimeSec',
  'health',
  'endpoints',
  'remoteAccess',
  'permissions',
  'licenseKid',
];

export const cloudStatus = (mock: CloudMockState) => {
  const pending = mock.state === 'pending';
  const linked = mock.state === 'linked';
  return {
    state: mock.state,
    configured: mock.state !== 'not-configured',
    cloudHost: mock.state === 'not-configured' ? null : 'frameleaf.cloud.test',
    instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
    keyFingerprint: 'q7LkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA9vXe',
    account: linked ? { id: 'account-1', label: 'owner@example.test' } : null,
    dataRegion: linked ? 'eu' : null,
    linkedAt: linked ? '2026-09-25T09:00:00.000Z' : null,
    lastContactAt: linked ? '2026-09-25T09:05:00.000Z' : null,
    pending: pending
      ? {
          userCode: 'BCDF-GHJK',
          verificationUri: 'https://frameleaf.cloud.test/link',
          verificationUriComplete: 'https://frameleaf.cloud.test/link?code=BCDF-GHJK',
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          intervalSeconds: 1,
        }
      : null,
    linkResult: pending ? 'pending' : linked ? 'approved' : null,
    permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
    revoked:
      mock.state === 'revoked'
        ? { at: '2026-09-25T09:10:00.000Z', reason: 'Frameleaf Cloud no longer recognises this server.' }
        : null,
    lastError: null,
    heartbeatFields,
    heartbeatFailures: 0,
    cloneSuspected: false,
    relinkRequested: false,
    linkTokenConfigured: false,
    remoteAccessEnabled: false,
    signInClientId: linked ? '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55' : null,
    signInIssuer: linked ? 'https://id.frameleaf.cloud.test' : null,
    signInLinkedAccounts: linked ? 1 : 0,
    signInShowOnLocalLogin: false,
    signInButtonText: 'Sign in with Frameleaf',
  };
};

export const setupCloudMockApiRoutes = async (context: BrowserContext, mock: CloudMockState) => {
  await context.route('**/api/admin/cloud/**', async (route, request) => {
    const path = new URL(request.url()).pathname.replace('/api/', '');
    const method = request.method();
    mock.requests.push({ method, path, body: request.postDataJSON?.() ?? undefined });
    if (method === 'POST' && path === 'admin/cloud/link') {
      mock.state = 'pending';
    } else if (method === 'DELETE' && path === 'admin/cloud/link/pending') {
      mock.state = 'unlinked';
    } else if (method === 'DELETE' && path === 'admin/cloud/link') {
      mock.state = 'unlinked';
    }
    return route.fulfill({
      status: method === 'POST' && path === 'admin/cloud/link' ? 201 : 200,
      json: cloudStatus(mock),
    });
  });
};
