import { Currency, LicenseState, type LicenseProductsResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import BuyScreen from './BuyScreen.svelte';

const flags = vi.hoisted(() => ({ value: { supporter: false, frameleafCloud: false } }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: {
    get value() {
      return flags.value;
    },
    init: vi.fn(),
  },
}));

const store = 'https://frameleaf.cloud.test/store';
const products = (storeUrl: string | null = store): LicenseProductsResponseDto => ({
  currency: Currency.Usd,
  licensedDiscount: 0.2,
  pricesVersion: '2026-09-25.1',
  storeUrl,
  credit: { minimumUsd: 20, maximumUsd: 500 },
  backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
  products: [
    ['cloud-monthly', 'plan', 'month', 9.99],
    ['cloud-annual', 'plan', 'year', 99.9],
    ['supporter-server', 'supporter', 'one-time', 100],
    ['supporter-individual', 'supporter', 'one-time', 25],
    ['credit-25', 'credit', 'one-time', 25],
    ['credit-50', 'credit', 'one-time', 50],
    ['credit-100', 'credit', 'one-time', 100],
  ].map(([id, kind, period, priceUsd]) => ({
    id: id as string,
    kind: kind as never,
    period: period as never,
    priceUsd: priceUsd as number,
    storeUrl: storeUrl ? `${storeUrl}?product=${id}` : null,
  })),
});

const user = (overrides: Record<string, unknown> = {}) =>
  ({ id: 'user-1', name: 'Taylor', email: 't@example.test', isAdmin: false, license: null, ...overrides }) as never;

const licenseStatus = (overrides: Record<string, unknown> = {}) =>
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

describe('BuyScreen (FL-157, FL-170, FL-171, FL-172)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    flags.value = { supporter: false, frameleafCloud: false };
    authManager.setUser(user());
    authManager.setPreferences({ purchase: { showSupportBadge: true } } as never);
    sdkMock.getLicenseProducts.mockResolvedValue(products());
    sdkMock.getLicenseStatus.mockResolvedValue(licenseStatus());
    sdkMock.getCloudMlStatus.mockResolvedValue({ wallet: null } as never);
  });

  it('shows plan and supporter cards in US dollars, with 1 TB of backup included and more priced by the TB', async () => {
    render(BuyScreen);

    expect(await screen.findByRole('heading', { name: 'Support Frameleaf', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('$9.99')).toBeInTheDocument();
    expect(screen.getByText('$99.90')).toBeInTheDocument();
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(screen.getByText('$25')).toBeInTheDocument();
    expect(screen.getAllByText('1 TB encrypted cloud backup')).toHaveLength(2);
    expect(
      screen.getByText(/includes 1 TB of cloud backup\. More storage is \$9\.99\/month for each extra 1 TB/),
    ).toBeInTheDocument();
    // AI credit is an administrator's
    expect(screen.queryByRole('group', { name: 'Add AI credit' })).not.toBeInTheDocument();
  });

  it('opens the configured store in a new tab after the checkout note', async () => {
    const open = vi.spyOn(globalThis, 'open').mockReturnValue(null);
    render(BuyScreen);

    await fireEvent.click((await screen.findAllByRole('button', { name: 'Purchase' }))[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/payment details are entered only on that site/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(open).toHaveBeenCalledWith(`${store}?product=supporter-server`, '_blank', 'noopener,noreferrer');
  });

  it('says purchasing is not available yet, with no link, when no store is configured', async () => {
    sdkMock.getLicenseProducts.mockResolvedValue(products(null));
    render(BuyScreen);

    expect(await screen.findAllByText('Purchasing isn’t available on this server yet.')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: 'Purchase' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Subscribe/ })).not.toBeInTheDocument();
  });

  it('shows the licensed-server price struck through', async () => {
    flags.value = { supporter: true, frameleafCloud: false };
    render(BuyScreen);

    expect(await screen.findByText('$7.99')).toBeInTheDocument();
    expect(screen.getByText('$79.92')).toBeInTheDocument();
    expect(screen.getByLabelText('Regular price $9.99')).toBeInTheDocument();
  });

  it('takes the discount Frameleaf Cloud published off plans only, and says how much', async () => {
    flags.value = { supporter: true, frameleafCloud: false };
    sdkMock.getLicenseProducts.mockResolvedValue({
      ...products(),
      licensedDiscount: 0.25,
      pricesVersion: '2026-10-01.2',
    });
    render(BuyScreen);

    expect(await screen.findByText('$7.49')).toBeInTheDocument();
    expect(screen.getByText('$74.93')).toBeInTheDocument();
    expect(screen.getByText(/plan prices are 25% lower/)).toBeInTheDocument();
    // supporter keys and extra backup keep their prices
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect(screen.getByText(/More storage is \$9\.99\/month/)).toBeInTheDocument();
  });

  it('gives the discount for a personal supporter key and says so without calling the server licensed', async () => {
    authManager.setUser(
      user({ license: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    render(BuyScreen);
    expect(await screen.findByText('$7.99')).toBeInTheDocument();
    expect(screen.getByText(/Your supporter key takes 20% off plan prices/)).toBeInTheDocument();
    expect(screen.queryByText(/This server is licensed/)).not.toBeInTheDocument();
  });

  it('refuses an upstream or mistyped key and never contacts the upstream licence server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(BuyScreen, { pendingKey: 'IMCL-0KEY-AAAA-BBBB' });

    const input = await screen.findByLabelText('Product key');
    expect(input).toHaveAttribute('placeholder', 'FL-XXXX-XXXX-XXXX');
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/not a Frameleaf licence key/)).toBeInTheDocument();

    await fireEvent.input(input, { target: { value: 'FL-S8NL-49G8-J58V' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/typo/)).toBeInTheDocument();

    expect(sdkMock.setUserLicense).not.toHaveBeenCalled();
    expect(sdkMock.activateLicense).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('futo'))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('activates an individual key through the personal endpoint and shows the activated card', async () => {
    sdkMock.setUserLicense.mockResolvedValue({} as never);
    sdkMock.getMyUser.mockResolvedValue(
      user({ license: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    render(BuyScreen, { pendingKey: 'FL-IC8Q-BT2Q-8ELH' });

    expect(await screen.findByLabelText('Product key')).toHaveValue('FL-IC8Q-BT2Q-8ELH');
    expect(screen.getByText('Individual key recognised')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() =>
      expect(sdkMock.setUserLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-IC8Q-BT2Q-8ELH' } }),
    );
    expect(await screen.findByText('Thank you, Taylor')).toBeInTheDocument();
    expect(screen.getByText(/ends in 8ELH/)).toBeInTheDocument();
  });

  it('sends a server key to the administrator endpoint, and refuses it for anyone else', async () => {
    render(BuyScreen, { pendingKey: 'FL-S8NL-49G8-J58U' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Activate' }));
    expect(await screen.findByText(/Ask an administrator/)).toBeInTheDocument();
    expect(sdkMock.activateLicense).not.toHaveBeenCalled();
  });

  it('lets an administrator activate a server key and remove it in place', async () => {
    authManager.setUser(user({ isAdmin: true }));
    sdkMock.getMyUser.mockResolvedValue(user({ isAdmin: true }));
    const active = licenseStatus({
      licensed: true,
      key: {
        state: LicenseState.Active,
        kind: 'server',
        source: 'key',
        keyHint: 'J58U',
        activatedAt: '2026-09-25T00:00:00.000Z',
        expiresAt: null,
        graceUntil: null,
        refreshedAt: null,
      },
    });
    sdkMock.activateLicense.mockResolvedValue(active);
    sdkMock.removeLicenseKey.mockResolvedValue(licenseStatus());
    render(BuyScreen, { pendingKey: 'FL-S8NL-49G8-J58U' });

    expect(await screen.findByRole('group', { name: 'Add AI credit' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(sdkMock.activateLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-S8NL-49G8-J58U' } }),
    );
    expect(await screen.findByText(/ends in J58U/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(screen.getByText('Remove this key from this server?')).toBeInTheDocument();
    await fireEvent.click(screen.getAllByRole('button', { name: 'Remove key' }).at(-1)!);
    await waitFor(() => expect(sdkMock.removeLicenseKey).toHaveBeenCalled());
  });

  it('hides the badge when "Hide the supporter badge" is turned on', async () => {
    authManager.setUser(
      user({ license: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    sdkMock.updateMyPreferences.mockResolvedValue({ purchase: { showSupportBadge: false } } as never);
    render(BuyScreen);

    const toggle = await screen.findByRole('switch', { name: 'Hide the supporter badge' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(toggle);
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { purchase: { showSupportBadge: false } },
      }),
    );
  });
});
