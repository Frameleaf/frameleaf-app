import { CloudHeartbeatField, CloudLinkState, LicenseState, type CloudStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
import YourCloudSection from './YourCloudSection.svelte';

const status = (overrides: Partial<CloudStatusResponseDto> = {}): CloudStatusResponseDto => ({
  state: CloudLinkState.Linked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
  keyFingerprint: 'q7Lk',
  account: { id: 'a', label: 'taylor@example.test' },
  dataRegion: 'na',
  linkedAt: '2026-03-03T00:00:00.000Z',
  lastContactAt: '2026-10-24T08:00:00.000Z',
  pending: null,
  linkResult: null,
  linkRefusal: null,
  regionMismatch: null,
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: null,
  heartbeatFields: Object.values(CloudHeartbeatField),
  heartbeatFailures: 0,
  cloneSuspected: false,
  relinkRequested: false,
  linkTokenConfigured: false,
  remoteAccessEnabled: true,
  manageUrl: 'https://frameleaf.cloud.test/servers/018f',
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
  signInInvitedStorageQuota: null,
  allowOriginalsOverRelay: false,
  allowPasswordOverRelay: false,
  ...overrides,
});
const slot = (kind: 'server' | 'individual' | 'plan', state = LicenseState.Active) => ({
  state,
  kind,
  source: 'account',
  keyHint: '9XTR',
  activatedAt: '2026-08-14T00:00:00.000Z',
  expiresAt: kind === 'plan' ? '2027-10-24T00:00:00.000Z' : null,
  graceUntil: state === LicenseState.Grace ? '2026-11-07T00:00:00.000Z' : null,
  refreshedAt: '2026-10-24T06:12:00.000Z',
});
const license = (overrides: Record<string, unknown> = {}) =>
  ({
    state: LicenseState.None,
    kind: null,
    keyHint: null,
    expiresAt: null,
    graceUntil: null,
    fingerprint: { instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', jkt: 'k' },
    entitlements: { frameleafCloud: false, remoteAccess: false, cloudMl: false, cloudBackup: false, supporter: false },
    licensed: false,
    refresh: { refreshedAt: null, nextRefreshAt: null, lastError: null },
    offline: false,
    linked: true,
    configured: true,
    key: null,
    plan: null,
    ...overrides,
  }) as never;
const products = () =>
  ({
    currency: 'USD',
    licensedDiscount: 0.07,
    individualDiscount: 0.05,
    pricesVersion: '2026-10-10.1',
    storeUrl: 'https://frameleaf.cloud.test/store',
    credit: { minimumUsd: 20, maximumUsd: 500 },
    backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
    products: [
      {
        id: 'cloud-monthly',
        kind: 'plan',
        period: 'month',
        priceUsd: 9.99,
        storeUrl: 'https://frameleaf.cloud.test/store?product=cloud-monthly',
      },
      {
        id: 'cloud-annual',
        kind: 'plan',
        period: 'year',
        priceUsd: 99.9,
        storeUrl: 'https://frameleaf.cloud.test/store?product=cloud-annual',
      },
      {
        id: 'supporter-server',
        kind: 'supporter',
        period: 'one-time',
        priceUsd: 100,
        storeUrl: 'https://frameleaf.cloud.test/store?product=supporter-server',
      },
      {
        id: 'supporter-individual',
        kind: 'supporter',
        period: 'one-time',
        priceUsd: 25,
        storeUrl: 'https://frameleaf.cloud.test/store?product=supporter-individual',
      },
    ],
  }) as never;

describe('YourCloudSection (FL-544: Plan, Licence and Support Frameleaf as one page)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    getCloudManager.close();
    authManager.setUser({
      id: 'user-1',
      name: 'Taylor',
      email: 't@example.test',
      isAdmin: true,
      license: null,
    } as never);
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.getLicenseStatus.mockResolvedValue(license());
    sdkMock.getLicenseProducts.mockResolvedValue(products());
    sdkMock.getCloudBackupLicenceCoverage.mockResolvedValue({ scope: 'all', accounts: [] } as never);
    sdkMock.getCloudMlStatus.mockResolvedValue({
      enabled: false,
      wallet: { availableUsd: 0, topUpUrl: null },
    } as never);
    sdkMock.getRemoteAccess.mockResolvedValue({ frameleafNameAddress: null } as never);
  });

  it('says the price plainly to a server with nothing bought: licence once, then the plan', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.Unlinked, account: null }));
    render(YourCloudSection);

    expect(await screen.findByText('No plan on this server')).toBeInTheDocument();
    expect(screen.getByText('$9.99 a month')).toBeInTheDocument();
    expect(screen.getByText('$92.91 a year')).toBeInTheDocument();
    expect(screen.getByText(/First comes a Server licence: \$100, once/)).toBeInTheDocument();
    const store = screen.getAllByRole('button', { name: 'Continue to the Frameleaf store' });
    expect(store).toHaveLength(2);
    await fireEvent.click(store[1]);
    expect(getCloudManager.request).toEqual({ feature: null, onDone: undefined, topUpUrl: null });
  });

  it('shows a licence-only server what is left to pay, and keeps AI credit reachable', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(
      license({ state: LicenseState.Active, key: slot('server'), licensed: true }),
    );
    render(YourCloudSection);

    expect(await screen.findByText(/Your Server licence is already on this server/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Add AI credit' }));
    expect(getCloudManager.request?.feature).toBe('processing');
  });

  it('shows the active plan with what it covers, what it costs and Add credit', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(
      license({ state: LicenseState.Active, key: slot('server'), plan: slot('plan'), licensed: true }),
    );
    render(YourCloudSection);

    expect(await screen.findByText('Frameleaf Cloud plan is active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Manage subscription' })).toHaveAttribute(
      'href',
      'https://frameleaf.cloud.test/servers/018f',
    );
    expect(screen.getByText('Everyone')).toBeInTheDocument();
    expect(
      screen.getByText(/\$9\.99 a month for each TB of Cloud Backup storage, or \$92\.91 a year/),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Add credit' }));
    expect(getCloudManager.request?.feature).toBe('processing');
    expect(screen.queryByRole('button', { name: 'Continue to the Frameleaf store' })).toBeNull();
  });

  it('says the plan’s name on frameleaf.net and leads to Remote access to change it (FL-1197)', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(
      license({ state: LicenseState.Active, key: slot('server'), plan: slot('plan'), licensed: true }),
    );
    sdkMock.getRemoteAccess.mockResolvedValue({ frameleafNameAddress: 'taylor-home.frameleaf.net' } as never);
    render(YourCloudSection);

    expect(await screen.findByText(/Everyone reaches this server at taylor-home\.frameleaf\.net/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change name…' })).toHaveAttribute(
      'href',
      expect.stringContaining('cloud-remote'),
    );
  });

  it('asks for the payment to be updated while the plan is in grace', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(
      license({
        state: LicenseState.Grace,
        key: slot('server'),
        plan: slot('plan', LicenseState.Grace),
        licensed: true,
      }),
    );
    render(YourCloudSection);

    expect(await screen.findByText('Your plan needs renewing')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Update payment/ })).toBeInTheDocument();
  });

  it('leads to the Licence page and keeps the plan’s removal on the page', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(
      license({ state: LicenseState.Active, key: slot('server'), plan: slot('plan'), licensed: true }),
    );
    render(YourCloudSection);

    expect(await screen.findByRole('link', { name: 'Licence' })).toHaveAttribute(
      'href',
      expect.stringContaining('section=cloud-license'),
    );
    expect(screen.getByRole('button', { name: 'Stop using it here…' })).toBeInTheDocument();
  });
});
