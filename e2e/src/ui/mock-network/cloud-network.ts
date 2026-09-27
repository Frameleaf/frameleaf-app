import { BrowserContext } from '@playwright/test';

/**
 * Mocked Frameleaf Cloud link routes (FL-155), alongside `base-network.ts`: the admin API this
 * server exposes (`admin/cloud/*`), scripted through `state`. Specs change `state` to move the link
 * between not configured, unlinked, pending, linked and revoked; the real hosted cloud is never used.
 */
export type CloudMockState = {
  state: 'not-configured' | 'unlinked' | 'pending' | 'linked' | 'revoked';
  requests: Array<{ method: string; path: string; body?: unknown }>;
  /** FL-165: the remote access page (`admin/cloud/remote*`); a remote access plan by default once linked. */
  remote?: RemoteMockState;
  /**
   * FL-196: the linked-server tour (`admin/cloud/tour`). Seen by default, so specs about other pages are
   * never interrupted by it; tour specs start with `{ seen: false }`.
   */
  tour?: { seen: boolean; ending?: string | null };
};

/** FL-196: `GET/PUT admin/cloud/tour`; the first ending is kept, and it is offered only once linked. */
const tourResponse = (mock: CloudMockState) => {
  const tour = mock.tour ?? { seen: true, ending: 'finished' };
  return {
    seen: tour.seen,
    seenAt: tour.seen ? '2026-09-27T09:00:00.000Z' : null,
    ending: tour.seen ? (tour.ending ?? 'finished') : null,
    offer: mock.state === 'linked' && !tour.seen,
    customHostnameVerified: false,
    processingEnabled: false,
    walletAvailableUsd: 12.5,
    backupConfigured: false,
  };
};

export type RemoteMockState = {
  entitled: boolean;
  enabled: boolean;
  mode: 'relay' | 'relay-and-direct';
  customHostname: string | null;
  customHostnameStatus: 'pending' | 'verified' | null;
  publicUrlChoice: 'frameleaf' | 'custom';
  tested: boolean;
  /** FL-166: the relay tunnel is READY (the edge worker's report). */
  relayConnected?: boolean;
  /** FL-167: how the direct port is open, and what the router and Frameleaf Cloud reported. */
  mapping?: 'upnp' | 'nat-pmp' | 'manual' | null;
  bridge?: boolean;
  cgnat?: boolean;
  wanVerified?: boolean;
};

const RELAY = 'https://r.u225vlzhsdlhwh4l.frameleaf.net';

export const remoteStatus = (mock: CloudMockState) => {
  const remote = mock.remote ?? defaultRemote();
  const linked = mock.state === 'linked';
  const unavailableReason =
    mock.state === 'not-configured'
      ? 'Frameleaf Cloud is not set up on this server.'
      : linked
        ? remote.entitled
          ? null
          : 'Remote access is included with a Frameleaf Cloud plan.'
        : 'Link this server to a Frameleaf account first.';
  const on = remote.enabled && !unavailableReason;
  const host = remote.customHostname;
  return {
    unavailableReason,
    enabled: on,
    mode: remote.mode,
    directPort: 2443,
    portMapping: true,
    publicUrlChoice: remote.publicUrlChoice,
    status: on ? 'ready' : 'off',
    reason: null,
    publicUrl: on ? (remote.publicUrlChoice === 'custom' && host ? `https://${host}` : RELAY) : null,
    frameleafAddress: linked ? RELAY : null,
    certificateName: on ? '*.u225vlzhsdlhwh4l.frameleaf.net' : null,
    certificateExpiresAt: on ? '2026-11-09T16:00:00.000Z' : null,
    certificateError: null,
    relayConnected: on && !!remote.relayConnected,
    relayRegion: linked ? 'eu1' : null,
    relayLatencyMs: on && remote.relayConnected ? 24 : null,
    relayConnectedAt: on && remote.relayConnected ? '2026-09-26T12:00:00.000Z' : null,
    relayBytesIn: on && remote.relayConnected ? 5_242_880 : 0,
    relayBytesOut: on && remote.relayConnected ? 52_428_800 : 0,
    relayLastError: on && !remote.relayConnected ? 'The relay refused the tunnel: unavailable' : null,
    relayLastErrorAt: on && !remote.relayConnected ? '2026-09-26T12:01:00.000Z' : null,
    relayRevoked: false,
    directListening: on,
    cgnatSuspected: on && !!remote.cgnat,
    mappingMethod: on ? (remote.mapping ?? null) : null,
    mappingError: on && remote.bridge ? 'No router answered UPnP or NAT-PMP.' : null,
    directGuidance: on && remote.bridge ? 'bridge' : null,
    directExternalIp: on && remote.mapping ? '203.0.113.7' : null,
    wanAddress: on && remote.wanVerified ? 'https://203-0-113-7.u225vlzhsdlhwh4l.frameleaf.net:2443' : null,
    wanVerified: on && !!remote.wanVerified,
    wanProblem: null,
    customHostname: host,
    customHostnameStatus: host ? remote.customHostnameStatus : null,
    customHostnameCheckedAt: host ? '2026-09-26T12:00:00.000Z' : null,
    customHostnameProblem: null,
    customHostnameRecords: host
      ? [
          { type: 'CNAME', name: host, value: 'r.u225vlzhsdlhwh4l.frameleaf.net', purpose: '' },
          {
            type: 'CNAME',
            name: `_acme-challenge.${host}`,
            value: '_acme-challenge.u225vlzhsdlhwh4l.frameleaf.net',
            purpose: '',
          },
        ]
      : [],
    candidates: [],
    lastTestAt: remote.tested ? '2026-09-26T12:05:00.000Z' : null,
    lastTestOk: remote.tested ? true : null,
    lastTestChecks: remote.tested
      ? [
          { id: 'certificate', ok: true, detail: 'Issued to this server for *.u225vlzhsdlhwh4l.frameleaf.net' },
          { id: 'listener', ok: true, detail: 'Listening for HTTPS on port 2443' },
          { id: 'api', ok: true, detail: 'This server answered over HTTPS through the direct listener.' },
          { id: 'relay', ok: false, detail: 'Not connected to the Frameleaf relay yet.' },
        ]
      : [],
  };
};

const defaultRemote = (): RemoteMockState => ({
  entitled: true,
  enabled: false,
  mode: 'relay',
  customHostname: null,
  customHostnameStatus: null,
  publicUrlChoice: 'frameleaf',
  tested: false,
});

/** FL-166: `GET admin/cloud/remote/usage`, 160 of 200 GiB through the relay this month. */
export const RELAY_USAGE = {
  period: '2026-09',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  bytes: 171_798_691_840,
  limitBytes: 214_748_364_800,
  throttled: false,
  throttleBps: null,
  throttleUntil: null,
};

/** What a remote access route does to the mocked state (FL-165). */
const applyRemote = (mock: CloudMockState, method: string, path: string, body: unknown) => {
  const remote = (mock.remote ??= defaultRemote());
  const input = (body ?? {}) as {
    enabled?: boolean;
    mode?: RemoteMockState['mode'];
    publicUrl?: RemoteMockState['publicUrlChoice'];
    hostname?: string;
  };
  if (method === 'PUT' && path === 'admin/cloud/remote') {
    if (input.enabled !== undefined) {
      remote.enabled = input.enabled;
    }
    if (input.mode !== undefined) {
      remote.mode = input.mode;
    }
    if (input.publicUrl !== undefined) {
      remote.publicUrlChoice = input.publicUrl;
    }
  } else if (method === 'PUT' && path === 'admin/cloud/remote/hostname') {
    remote.customHostname = input.hostname ?? null;
    remote.customHostnameStatus = 'pending';
  } else if (method === 'POST' && path === 'admin/cloud/remote/hostname/check') {
    remote.customHostnameStatus = 'verified';
  } else if (method === 'DELETE' && path === 'admin/cloud/remote/hostname') {
    remote.customHostname = null;
    remote.customHostnameStatus = null;
    remote.publicUrlChoice = 'frameleaf';
  } else if (method === 'POST' && path === 'admin/cloud/remote/test') {
    remote.tested = true;
  }
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
    linkRefusal: null,
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
    manageUrl: null,
    signInClientId: linked ? '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55' : null,
    signInIssuer: linked ? 'https://id.frameleaf.cloud.test' : null,
    signInLinkedAccounts: linked ? 1 : 0,
    signInShowOnLocalLogin: false,
    signInButtonText: 'Sign in with Frameleaf',
    allowOriginalsOverRelay: false,
    allowPasswordOverRelay: false,
  };
};

/**
 * The licence and prices the cloud manager loads with the link status. Left unmocked they reach the
 * real server, whose answer (a 401 for the fake session, or a slow store lookup) decides when the
 * cloud pages finish loading, so a spec could time out before its first assertion.
 */
const unlicensed = {
  configured: true,
  entitlements: { cloudBackup: false, cloudMl: false, frameleafCloud: false, remoteAccess: false, supporter: false },
  expiresAt: null,
  fingerprint: { instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', jkt: null },
  graceUntil: null,
  key: null,
  keyHint: null,
  kind: null,
  licensed: false,
  linked: false,
  offline: false,
  plan: null,
  refresh: { lastError: null, nextRefreshAt: null, refreshedAt: null },
  state: 'none',
};

const noStoreProducts = {
  currency: 'USD',
  licensedDiscount: 0.2,
  pricesVersion: '2026-09-25.1',
  storeUrl: null,
  credit: { minimumUsd: 20, maximumUsd: 500 },
  backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
  products: [],
};

export const setupCloudMockApiRoutes = async (context: BrowserContext, mock: CloudMockState) => {
  await context.route('**/api/admin/license', (route) => route.fulfill({ status: 200, json: unlicensed }));
  await context.route('**/api/license/products', (route) => route.fulfill({ status: 200, json: noStoreProducts }));
  await context.route('**/api/admin/cloud/**', async (route, request) => {
    const path = new URL(request.url()).pathname.replace('/api/', '');
    const method = request.method();
    const body = request.postDataJSON?.() ?? undefined;
    mock.requests.push({ method, path, body });
    if (path === 'admin/cloud/tour') {
      if (method === 'PUT' && !(mock.tour ?? { seen: true }).seen) {
        mock.tour = { seen: true, ending: (body as { ending?: string } | undefined)?.ending ?? null };
      }
      return route.fulfill({ status: 200, json: tourResponse(mock) });
    }
    // FL-166: relay use this month, as Frameleaf Cloud meters it (the contract's remote-usage fixture)
    if (method === 'GET' && path === 'admin/cloud/remote/usage') {
      return route.fulfill({ status: 200, json: RELAY_USAGE });
    }
    if (path === 'admin/cloud/remote' || path.startsWith('admin/cloud/remote/')) {
      applyRemote(mock, method, path, body);
      return route.fulfill({ status: 200, json: remoteStatus(mock) });
    }
    if (method === 'POST' && path === 'admin/cloud/link') {
      mock.state = 'pending';
    } else if (method === 'DELETE' && (path === 'admin/cloud/link/pending' || path === 'admin/cloud/link')) {
      mock.state = 'unlinked';
    }
    return route.fulfill({
      status: method === 'POST' && path === 'admin/cloud/link' ? 201 : 200,
      json: cloudStatus(mock),
    });
  });
};
