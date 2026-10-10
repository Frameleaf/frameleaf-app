import { Currency, LicenseState, type LicenseProductsResponseDto } from '@frameleaf/sdk';
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

/** Type (or paste) a key into "Already have a key?": the only way a key reaches this screen. */
const typeKey = async (value: string) => {
  const input = await screen.findByLabelText('Product key');
  await fireEvent.input(input, { target: { value } });
  return input;
};

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
    // the page says it is waiting, and reads the licence again when the person comes back
    expect(await screen.findByText('Finish in the Frameleaf store tab, then come back here.')).toBeInTheDocument();
    sdkMock.getMyUser.mockResolvedValue(
      user({ license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    await fireEvent.focus(globalThis as never);
    expect(await screen.findByText('Your purchase is active on this server.')).toBeInTheDocument();
    expect(screen.queryByText('Finish in the Frameleaf store tab, then come back here.')).not.toBeInTheDocument();
  });

  it('offers to try again when plans and prices cannot be loaded', async () => {
    sdkMock.getLicenseProducts.mockRejectedValueOnce(new Error('offline'));
    render(BuyScreen);

    expect(await screen.findByText(/Plans and prices did not load/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('$99.90')).toBeInTheDocument();
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
    // extra backup keeps its price; a licensed server sees its thank-you card in place of the supporter
    // key cards, as in the prototype (AuthScreens.jsx, `state.activated`)
    expect(screen.getByText(/More storage is \$9\.99\/month/)).toBeInTheDocument();
  });

  it('gives the discount for a personal supporter key and says so without calling the server licensed', async () => {
    authManager.setUser(
      user({ license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    render(BuyScreen);
    expect(await screen.findByText('$7.99')).toBeInTheDocument();
    expect(screen.getByText(/Your supporter key takes 20% off plan prices/)).toBeInTheDocument();
    expect(screen.queryByText(/This server is licensed/)).not.toBeInTheDocument();
  });

  it('refuses an upstream or mistyped key and never contacts the upstream licence server', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(BuyScreen);
    await typeKey('IMCL-0KEY-AAAA-BBBB');

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
      user({ license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T00:00:00.000Z' } }),
    );
    render(BuyScreen);
    await typeKey('FL-IC8Q-BT2Q-8EL6');

    expect(await screen.findByLabelText('Product key')).toHaveValue('FL-IC8Q-BT2Q-8EL6');
    expect(screen.getByText('Individual key recognised')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() =>
      expect(sdkMock.setUserLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-IC8Q-BT2Q-8EL6' } }),
    );
    expect(await screen.findByText('Thank you, Taylor')).toBeInTheDocument();
    expect(screen.getByText(/ends in 8EL6/)).toBeInTheDocument();
  });

  it('sends a server key to the administrator endpoint, and refuses it for anyone else', async () => {
    render(BuyScreen);
    await typeKey('FL-S8NL-49G8-J583');
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
        keyHint: 'J583',
        activatedAt: '2026-09-25T00:00:00.000Z',
        expiresAt: null,
        graceUntil: null,
        refreshedAt: null,
      },
    });
    sdkMock.activateLicense.mockResolvedValue(active);
    sdkMock.removeLicenseKey.mockResolvedValue(licenseStatus());
    render(BuyScreen);
    await typeKey('FL-S8NL-49G8-J583');

    expect(await screen.findByRole('group', { name: 'Add AI credit' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() =>
      expect(sdkMock.activateLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-S8NL-49G8-J583' } }),
    );
    expect(await screen.findByText(/ends in J583/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(screen.getByText('Remove this key from this server?')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await waitFor(() => expect(sdkMock.removeLicenseKey).toHaveBeenCalled());
  });

  it('hides the badge when "Hide the supporter badge" is turned on', async () => {
    authManager.setUser(
      user({ license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T00:00:00.000Z' } }),
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

  describe('link codes from the Frameleaf account site (CLD-004)', () => {
    const code = 'flc_jf23qnbc4wvmpnuogenclb2hyo';

    it('has this server redeem the code once and shows the activated card, never holding a key', async () => {
      sdkMock.redeemLicenseLinkCode.mockResolvedValue({ kind: 'individual', keyHint: '8EL6' } as never);
      sdkMock.getMyUser.mockResolvedValue(
        user({ license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T00:00:00.000Z' } }),
      );
      render(BuyScreen, { linkCode: code });

      await waitFor(() => expect(sdkMock.redeemLicenseLinkCode).toHaveBeenCalledWith({ licenseLinkCodeDto: { code } }));
      expect(sdkMock.redeemLicenseLinkCode).toHaveBeenCalledTimes(1);
      expect(await screen.findByText('Thank you. Your key is active.')).toBeInTheDocument();
      expect(await screen.findByText(/ends in 8EL6/)).toBeInTheDocument();
      expect(sdkMock.setUserLicense).not.toHaveBeenCalled();
      expect(sdkMock.activateLicense).not.toHaveBeenCalled();
    });

    it('explains a refused code and leaves the key field to paste into', async () => {
      sdkMock.isHttpError.mockReturnValue(true);
      sdkMock.redeemLicenseLinkCode.mockRejectedValue({
        name: 'HttpError',
        status: 400,
        data: {
          message:
            'This link from your Frameleaf account has expired. Open it again from My licenses, or paste the key.',
        },
      });
      render(BuyScreen, { linkCode: code });

      expect(await screen.findByRole('alert')).toHaveTextContent(/expired/);
      expect(screen.getByLabelText('Product key')).toHaveValue('');
    });

    it('asks for the key after a link code that is not shaped like one, never sending it', async () => {
      render(BuyScreen, { linkNotice: 'invalid-code' });

      expect(
        await screen.findByText(/This link from your Frameleaf account isn’t valid\. Paste your key below/),
      ).toBeInTheDocument();
      expect(sdkMock.redeemLicenseLinkCode).not.toHaveBeenCalled();
    });

    it('asks for the key to be pasted after an old link that carried one, without using it', async () => {
      render(BuyScreen, { linkNotice: 'key-in-link' });

      expect(
        await screen.findByText(/keys are no longer accepted in links\. Paste your key below/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Product key')).toHaveValue('');
      expect(sdkMock.redeemLicenseLinkCode).not.toHaveBeenCalled();
      expect(sdkMock.setUserLicense).not.toHaveBeenCalled();
      expect(sdkMock.activateLicense).not.toHaveBeenCalled();
    });
  });
});
