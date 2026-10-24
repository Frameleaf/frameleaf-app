import { CloudHeartbeatField, CloudLinkState, LicenseState, type CloudStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import GetCloudSheet from './GetCloudSheet.svelte';

const status = (overrides: Partial<CloudStatusResponseDto> = {}): CloudStatusResponseDto => ({
  state: CloudLinkState.Unlinked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55',
  keyFingerprint: 'q7Lk',
  account: null,
  dataRegion: null,
  linkedAt: null,
  lastContactAt: null,
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
  remoteAccessEnabled: false,
  manageUrl: null,
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
const linked = () => status({ state: CloudLinkState.Linked, account: { id: 'a', label: 'taylor@example.test' } });
const pending = () =>
  status({
    state: CloudLinkState.Pending,
    pending: {
      userCode: 'BCDF-GHJK',
      verificationUri: 'https://frameleaf.cloud.test/link',
      verificationUriComplete: 'https://frameleaf.cloud.test/link?code=BCDF-GHJK',
      expiresAt: new Date(Date.now() + 9 * 60 * 1000).toISOString(),
      intervalSeconds: 5,
    },
  });

const slot = (kind: 'server' | 'individual' | 'plan', state = LicenseState.Active) => ({
  state,
  kind,
  source: 'account',
  keyHint: 'XXXX',
  activatedAt: '2026-10-24T00:00:00.000Z',
  expiresAt: null,
  graceUntil: null,
  refreshedAt: null,
});
const license = (overrides: Record<string, unknown> = {}) =>
  ({
    state: LicenseState.None,
    kind: null,
    keyHint: null,
    expiresAt: null,
    graceUntil: null,
    fingerprint: { instanceId: 'i', jkt: 'k' },
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
const cloudLicense = (who: 'server' | 'individual' = 'server') =>
  license({ state: LicenseState.Active, key: slot(who), plan: slot('plan'), licensed: true });

const products = (storeUrl: string | null = 'https://frameleaf.cloud.test/store') =>
  ({
    currency: 'USD',
    licensedDiscount: 0.07,
    individualDiscount: 0.05,
    pricesVersion: '2026-10-10.1',
    storeUrl,
    credit: { minimumUsd: 20, maximumUsd: 500 },
    backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
    products: [
      ['cloud-monthly', 'plan', 'month', 9.99],
      ['cloud-annual', 'plan', 'year', 99.9],
      ['supporter-server', 'supporter', 'one-time', 100],
      ['supporter-individual', 'supporter', 'one-time', 25],
      ['credit-25', 'credit', 'one-time', 25],
    ].map(([id, kind, period, priceUsd]) => ({
      id,
      kind,
      period,
      priceUsd,
      storeUrl: storeUrl && `${storeUrl}?product=${id}`,
    })),
  }) as never;

const CHECKOUT = {
  checkoutId: 'chk_1',
  url: 'https://frameleaf.cloud.test/store?checkout=chk_1',
  expiresAt: '2026-10-24T16:00:00.000Z',
};

describe('GetCloudSheet (FL-544: one sheet on every gate)', () => {
  let open: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    authManager.setUser({ id: 'user-1', name: 'Taylor', email: 't@example.test', isAdmin: true } as never);
    sdkMock.getCloudStatus.mockResolvedValue(linked());
    sdkMock.getLicenseStatus.mockResolvedValue(license());
    sdkMock.getLicenseProducts.mockResolvedValue(products());
    sdkMock.getCloudMlStatus.mockResolvedValue({
      wallet: { availableUsd: 0, topUpUrl: 'https://frameleaf.cloud.test/wallet/top-up' },
    } as never);
    sdkMock.startLicenseCheckout.mockResolvedValue(CHECKOUT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens at the link step when the server is not linked, and moves on once it is', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.startCloudLink.mockResolvedValue(pending());
    render(GetCloudSheet, { feature: 'remote', close: vi.fn() });

    expect(await screen.findByText('Link this server to a free Frameleaf account')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Link this server' }));
    expect(await screen.findByText('BCDF-GHJK')).toBeInTheDocument();

    // the code is approved: the manager's next poll reports linked, and the sheet moves to the purchase
    sdkMock.getCloudLink.mockResolvedValue(linked());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByText('Linked to taylor@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to the Frameleaf store' })).toBeInTheDocument();
  });

  it('opens at the purchase when linked, starts the combined checkout and waits for the plan to arrive', async () => {
    const close = vi.fn();
    const onDone = vi.fn();
    render(GetCloudSheet, { feature: 'remote', close, onDone });

    expect(await screen.findByText('Remote access is part of Frameleaf Cloud')).toBeInTheDocument();
    expect(screen.getByText('$100 once, then $92.91 a year')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to the Frameleaf store' }));
    await waitFor(() =>
      expect(sdkMock.startLicenseCheckout).toHaveBeenCalledWith({
        licenseCheckoutDto: { licence: 'supporter-server', plan: 'cloud-annual' },
      }),
    );
    expect(open).toHaveBeenCalledWith(CHECKOUT.url, '_blank', 'noopener,noreferrer');
    expect(await screen.findByText(/This page updates by itself when you finish paying/)).toBeInTheDocument();

    // the next poll finds the plan: done, with the feature's own button
    sdkMock.refreshLicense.mockResolvedValue(cloudLicense());
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByText('Frameleaf Cloud is on this server')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Turn on remote access' }));
    expect(onDone).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('stops polling when the sheet is closed while waiting', async () => {
    const { unmount } = render(GetCloudSheet, { feature: 'backup', close: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Continue to the Frameleaf store' }));
    await screen.findByText(/This page updates by itself/);
    unmount();
    sdkMock.refreshLicense.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sdkMock.refreshLicense).not.toHaveBeenCalled();
  });

  it('offers monthly and "just me", and sends the Individual purchase', async () => {
    render(GetCloudSheet, { feature: 'backup', close: vi.fn() });
    await fireEvent.click(await screen.findByLabelText('Monthly'));
    await fireEvent.click(screen.getByRole('radio', { name: 'Just me' }));
    expect(screen.getByText('$25 once, then $9.49 a month')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to the Frameleaf store' }));
    await waitFor(() =>
      expect(sdkMock.startLicenseCheckout).toHaveBeenCalledWith({
        licenseCheckoutDto: { licence: 'supporter-individual', plan: 'cloud-monthly' },
      }),
    );
    sdkMock.refreshLicense.mockResolvedValue(cloudLicense('individual'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByText('Added to this server just now. Covers you only.')).toBeInTheDocument();
  });

  it('asks only for AI credit when the licence is already here, and watches the wallet', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(cloudLicense());
    render(GetCloudSheet, { feature: 'processing', close: vi.fn() });

    expect(await screen.findByText('AI credit to start')).toBeInTheDocument();
    expect(screen.queryByText('Frameleaf Cloud', { selector: 'strong' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to the Frameleaf store' }));
    expect(sdkMock.startLicenseCheckout).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://frameleaf.cloud.test/wallet/top-up?amount=25',
      '_blank',
      'noopener,noreferrer',
    );
    sdkMock.getCloudMlStatus.mockResolvedValue({
      wallet: { availableUsd: 25, topUpUrl: 'https://frameleaf.cloud.test/wallet/top-up' },
    } as never);
    await vi.advanceTimersByTimeAsync(5000);
    // no gate asked to turn it on here, so the sheet ends on Done
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('buys a licence alone from the store, never the combined checkout, when only the licence is missing', async () => {
    render(GetCloudSheet, { feature: 'processing', close: vi.fn() });
    expect(await screen.findByText('A lifetime Server licence')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to the Frameleaf store' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://frameleaf.cloud.test/store?product=supporter-server',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    expect(sdkMock.startLicenseCheckout).not.toHaveBeenCalled();
  });

  it('goes back to the link step when the server is unlinked while the sheet is open', async () => {
    render(GetCloudSheet, { feature: 'remote', close: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Continue to the Frameleaf store' }));
    await screen.findByText(/This page updates by itself/);
    sdkMock.refreshLicense.mockRejectedValue(new Error('Link this server to a Frameleaf account first.'));
    sdkMock.getCloudStatus.mockResolvedValue(status());
    sdkMock.getLicenseStatus.mockResolvedValue(license({ linked: false }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByRole('button', { name: 'Link this server' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to the Frameleaf store' })).toBeNull();
  });

  it('ends on Done when no gate asked to turn anything on', async () => {
    sdkMock.getLicenseStatus.mockResolvedValue(cloudLicense());
    render(GetCloudSheet, { feature: 'backup', close: vi.fn() });
    expect(await screen.findByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on Cloud Backup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Later' })).toBeNull();
  });

  it('does not promise everyone Cloud Backup after a just-me purchase', async () => {
    render(GetCloudSheet, { feature: 'backup', close: vi.fn() });
    await fireEvent.click(await screen.findByRole('radio', { name: 'Just me' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to the Frameleaf store' }));
    sdkMock.refreshLicense.mockResolvedValue(cloudLicense('individual'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByText('Added to this server just now. Covers you only.')).toBeInTheDocument();
    expect(screen.queryByText(/are all ready now/)).toBeNull();
  });

  it('says Frameleaf Cloud is not set up when the server has no cloud address', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(status({ state: CloudLinkState.NotConfigured, configured: false }));
    render(GetCloudSheet, { feature: 'remote', close: vi.fn() });
    expect(await screen.findByText('Frameleaf Cloud is not set up on this server')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link this server' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Continue to the Frameleaf store' })).toBeNull();
  });

  it('gives a member the top-up link a refusal carried instead of a dead end', async () => {
    authManager.setUser({ id: 'user-2', name: 'Morgan', email: 'm@example.test', isAdmin: false } as never);
    render(GetCloudSheet, {
      feature: 'processing',
      close: vi.fn(),
      topUpUrl: 'https://frameleaf.cloud.test/wallet/top-up',
    });
    expect(await screen.findByRole('link', { name: /Add AI credit in your Frameleaf account/ })).toHaveAttribute(
      'href',
      'https://frameleaf.cloud.test/wallet/top-up',
    );
  });

  it('says purchasing is unavailable when the server has no store', async () => {
    sdkMock.getLicenseProducts.mockResolvedValue(products(null));
    render(GetCloudSheet, { feature: 'remote', close: vi.fn() });
    expect(await screen.findByText('Purchasing isn’t available on this server yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue to the Frameleaf store' })).toBeNull();
  });

  it('tells a member to ask an administrator', async () => {
    authManager.setUser({ id: 'user-2', name: 'Morgan', email: 'm@example.test', isAdmin: false } as never);
    render(GetCloudSheet, { feature: 'processing', close: vi.fn() });
    expect(await screen.findByText(/Only an administrator can set up Frameleaf Cloud/)).toBeInTheDocument();
    expect(sdkMock.getCloudStatus).not.toHaveBeenCalled();
  });
});
