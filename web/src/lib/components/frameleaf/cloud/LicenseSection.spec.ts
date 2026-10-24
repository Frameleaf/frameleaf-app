import {
  CloudHeartbeatField,
  CloudLinkState,
  Currency,
  LicenseKind,
  type LicenseProductDto,
  LicenseState,
  Period,
  Source,
  type LicenseProductsResponseDto,
  type LicenseStatusResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import LicenseSection from './LicenseSection.svelte';
import PlanSection from './PlanSection.svelte';

const entitlements = {
  frameleafCloud: false,
  remoteAccess: false,
  cloudMl: false,
  cloudBackup: false,
  supporter: false,
};

const license = (overrides: Partial<LicenseStatusResponseDto> = {}): LicenseStatusResponseDto => ({
  state: LicenseState.None,
  kind: null,
  keyHint: null,
  expiresAt: null,
  graceUntil: null,
  fingerprint: { instanceId: '018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55', jkt: 'kid' },
  entitlements,
  licensed: false,
  refresh: { refreshedAt: null, nextRefreshAt: null, lastError: null },
  offline: false,
  linked: true,
  configured: true,
  key: null,
  plan: null,
  ...overrides,
});

const keySlot = {
  state: LicenseState.Active,
  kind: LicenseKind.Server,
  source: Source.Key,
  keyHint: 'J583',
  activatedAt: '2026-09-25T09:00:00.000Z',
  expiresAt: null,
  graceUntil: null,
  refreshedAt: null,
};

const planSlot = {
  state: LicenseState.Active,
  kind: LicenseKind.Plan,
  source: Source.Account,
  keyHint: null,
  activatedAt: '2026-09-25T09:00:00.000Z',
  expiresAt: '2026-10-25T09:00:00.000Z',
  graceUntil: null,
  refreshedAt: '2026-09-25T09:00:00.000Z',
};

const products = (storeUrl: string | null = 'https://frameleaf.cloud.test/store'): LicenseProductsResponseDto => ({
  currency: Currency.Usd,
  credit: { minimumUsd: 20, maximumUsd: 500 },
  licensedDiscount: 0.07,
  individualDiscount: 0.05,
  pricesVersion: '2026-10-10.1',
  storeUrl,
  backup: { includedTb: 1, blockTb: 1, usdPerTbMonth: 9.99 },
  products: [
    {
      id: 'cloud-monthly',
      kind: 'plan' as LicenseProductDto['kind'],
      period: Period.Month,
      priceUsd: 9.99,
      storeUrl: storeUrl && `${storeUrl}?product=cloud-monthly`,
    },
    {
      id: 'cloud-annual',
      kind: 'plan' as LicenseProductDto['kind'],
      period: Period.Year,
      priceUsd: 99.9,
      storeUrl: storeUrl && `${storeUrl}?product=cloud-annual`,
    },
    {
      id: 'supporter-server',
      kind: 'supporter' as LicenseProductDto['kind'],
      period: Period.OneTime,
      priceUsd: 100,
      storeUrl: null,
    },
    {
      id: 'supporter-individual',
      kind: 'supporter' as LicenseProductDto['kind'],
      period: Period.OneTime,
      priceUsd: 25,
      storeUrl: null,
    },
  ],
});

const cloudStatus = {
  state: CloudLinkState.Linked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: 'i',
  keyFingerprint: 'k',
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
};

describe('Frameleaf Cloud licence and plan pages (FL-156, FL-157, FL-171, FL-172)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    authManager.setUser({
      id: 'admin-1',
      name: 'Admin',
      email: 'a@example.test',
      isAdmin: true,
      license: null,
    } as never);
    sdkMock.getCloudStatus.mockResolvedValue(cloudStatus);
    sdkMock.getLicenseProducts.mockResolvedValue(products());
  });

  describe('LicenseSection (FL-541)', () => {
    const personalUser = {
      id: 'admin-1',
      name: 'Admin',
      email: 'a@example.test',
      isAdmin: true,
      license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T09:00:00.000Z' },
    };

    it('opens on what the licence decides: not included yet, for one person, or for everyone', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      const { unmount } = render(LicenseSection);
      expect(await screen.findByRole('heading', { name: 'Backups away from home aren’t included yet' })).toBeInTheDocument();
      expect(screen.getAllByText('Not included').length).toBeGreaterThan(1);
      unmount();

      authManager.setUser(personalUser as never);
      const second = render(LicenseSection);
      expect(await screen.findByRole('heading', { name: 'Backups away from home are included for Admin only' })).toBeInTheDocument();
      expect(screen.getByText('Needs a Server licence')).toBeInTheDocument();
      second.unmount();

      authManager.setUser({ ...personalUser, license: null } as never);
      sdkMock.getLicenseStatus.mockResolvedValue(license({ licensed: true, key: keySlot, keyHint: 'J583' }));
      render(LicenseSection);
      expect(await screen.findByRole('heading', { name: 'Backups away from home are included for everyone' })).toBeInTheDocument();
      expect(screen.getByText('•••• J583')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('FL-XXXX-XXXX-XXXX')).toBeNull();
    });

    it('refuses a mistyped key, says a Server key covers everyone before anything changes, then activates it', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.activateLicense.mockResolvedValue(license({ licensed: true, key: keySlot, keyHint: 'J583' }));
      render(LicenseSection);

      const input = await screen.findByPlaceholderText('FL-XXXX-XXXX-XXXX');
      await fireEvent.input(input, { target: { value: 'imcl-0key-aaaa-bbbb' } });
      expect(await screen.findByText(/not a Frameleaf licence key/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();

      await fireEvent.input(input, { target: { value: 'FL-S8NL-49G8-J583' } });
      expect(await screen.findByText('This is a Server licence')).toBeInTheDocument();
      expect(screen.getByText(/It will cover everyone on this server/)).toBeInTheDocument();
      expect(sdkMock.activateLicense).not.toHaveBeenCalled();
      await fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
      await waitFor(() =>
        expect(sdkMock.activateLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-S8NL-49G8-J583' } }),
      );
      expect(await screen.findByText('•••• J583')).toBeInTheDocument();
    });

    it('activates an Individual key as the administrator’s own, saying so first', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.setUserLicense.mockResolvedValue({} as never);
      sdkMock.getMyUser.mockResolvedValue({ id: 'admin-1', isAdmin: true, license: { kind: 'individual' } } as never);
      render(LicenseSection);

      await fireEvent.input(await screen.findByPlaceholderText('FL-XXXX-XXXX-XXXX'), {
        target: { value: 'FL-IC8Q-BT2Q-8EL6' },
      });
      expect(await screen.findByText('This is an Individual licence')).toBeInTheDocument();
      await fireEvent.click(screen.getByRole('button', { name: 'Activate for Admin' }));
      await waitFor(() =>
        expect(sdkMock.setUserLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-IC8Q-BT2Q-8EL6' } }),
      );
      expect(sdkMock.activateLicense).not.toHaveBeenCalled();
      expect(await screen.findByText(/active for your account/)).toBeInTheDocument();
    });

    it('names the plan discount of each licence among what a licence gives (FL-369)', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      render(LicenseSection);
      expect(await screen.findByText('A lower price for Frameleaf Cloud plans')).toBeInTheDocument();
      expect(screen.getByText(/7% off with a Server licence, 5% off with an Individual licence/)).toBeInTheDocument();
      expect(screen.getByText(/Only Frameleaf Cloud and backups away from home need one/)).toBeInTheDocument();
    });

    it.each([
      [LicenseState.Expired, 'Your plan has ended'],
      [LicenseState.Invalid, 'The licence could not be verified'],
    ])('shows the %s notice and still offers a replacement key', async (state, title) => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ state, key: { ...keySlot, state }, keyHint: 'J583', licensed: false }),
      );
      render(LicenseSection);
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByPlaceholderText('FL-XXXX-XXXX-XXXX')).toBeInTheDocument();
    });

    it('removes an expired server key and a personal key, each through its own endpoint', async () => {
      authManager.setUser(personalUser as never);
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ state: LicenseState.Expired, key: { ...keySlot, state: LicenseState.Expired }, keyHint: 'J583' }),
      );
      sdkMock.removeLicenseKey.mockResolvedValue(license());
      sdkMock.deleteUserLicense.mockResolvedValue(undefined as never);
      sdkMock.getMyUser.mockResolvedValue({ id: 'admin-1', isAdmin: true, license: null } as never);
      render(LicenseSection);

      expect(await screen.findByText('•••• J583')).toBeInTheDocument();
      expect(screen.getByText('•••• 8EL6')).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'Remove from this server…' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/What is kept: backups already made/)).toBeInTheDocument();
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove licence' }));
      await waitFor(() => expect(sdkMock.removeLicenseKey).toHaveBeenCalled());
      expect(sdkMock.deleteUserLicense).not.toHaveBeenCalled();

      await fireEvent.click(screen.getByRole('button', { name: 'Remove your Individual licence…' }));
      const personalDialog = await screen.findByRole('dialog');
      expect(within(personalDialog).getByText('Remove your Individual licence?')).toBeInTheDocument();
      await fireEvent.click(within(personalDialog).getByRole('button', { name: 'Remove licence' }));
      await waitFor(() => expect(sdkMock.deleteUserLicense).toHaveBeenCalledTimes(1));
      expect(sdkMock.removeLicenseKey).toHaveBeenCalledTimes(1);
    });

    it('keeps a server with no internet connection under a closed Advanced: server ID, file and Check now', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license({ licensed: true, key: keySlot, keyHint: 'J583' }));
      sdkMock.installLicenseCertificate.mockResolvedValue(license({ plan: planSlot }));
      sdkMock.refreshLicense.mockResolvedValue(license({ licensed: true, key: keySlot }));
      const { container } = render(LicenseSection);

      const advanced = (await screen.findByText('A server with no internet connection')).closest('details')!;
      expect(advanced.open).toBe(false);
      expect(within(advanced).getByText('018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55')).toBeInTheDocument();
      await fireEvent.click(within(advanced).getByRole('button', { name: 'Check now' }));
      await waitFor(() => expect(sdkMock.refreshLicense).toHaveBeenCalled());

      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      await fireEvent.change(input, { target: { files: [new File(['header.payload.signature'], 'server.lic')] } });
      await waitFor(() =>
        expect(sdkMock.installLicenseCertificate).toHaveBeenCalledWith({
          licenseCertificateDto: { certificate: 'header.payload.signature' },
        }),
      );
    });

    it('warns in grace, with the date it keeps working until', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({
          state: LicenseState.Grace,
          graceUntil: '2026-10-09T09:00:00.000Z',
          licensed: true,
          key: { ...keySlot, state: LicenseState.Grace, graceUntil: '2026-10-09T09:00:00.000Z' },
        }),
      );
      render(LicenseSection);
      expect(await screen.findByText('Your renewal did not go through')).toBeInTheDocument();
      expect(screen.getByText(/Keeps working until/)).toBeInTheDocument();
    });
  });

  describe('PlanSection', () => {
    it('shows plan cards with the store link, 1 TB of backup included and the price of more', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      render(PlanSection);

      expect(await screen.findByText('No plan on this server')).toBeInTheDocument();
      expect(screen.getByText('$9.99')).toBeInTheDocument();
      expect(screen.getByText('$99.90')).toBeInTheDocument();
      expect(screen.getAllByText('1 TB encrypted cloud backup')).toHaveLength(2);
      expect(screen.getByText(/More storage is \$9\.99\/month for each extra 1 TB/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Continue to checkout' })).toHaveLength(2);
    });

    it('strikes through the price on a licensed server (plans only)', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ licensed: true, key: keySlot, entitlements: { ...entitlements, supporter: true } }),
      );
      render(PlanSection);

      expect(await screen.findByText(/\$9\.29/)).toBeInTheDocument();
      expect(screen.getByText('$9.99').tagName).toBe('S');
      expect(screen.getByText(/\$92\.91/)).toBeInTheDocument();
      expect(screen.getByText(/plans cost 7% less/)).toBeInTheDocument();
      expect(screen.getByText(/AI credit is priced the same for everyone/)).toBeInTheDocument();
    });

    it('takes the Individual rate off for an Individual licence: the server’s, or the administrator’s own (FL-369)', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ licensed: true, key: { ...keySlot, kind: LicenseKind.Individual } }),
      );
      const { unmount } = render(PlanSection);
      expect(await screen.findByText(/\$9\.49/)).toBeInTheDocument();
      expect(screen.getByText(/\$94\.90/)).toBeInTheDocument();
      expect(screen.getByText(/This server is licensed: Frameleaf Cloud plans cost 5% less/)).toBeInTheDocument();
      unmount();

      authManager.setUser({
        id: 'admin-1',
        isAdmin: true,
        license: { kind: 'individual', keyHint: '8EL6', activatedAt: '2026-09-25T09:00:00.000Z' },
      } as never);
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      render(PlanSection);
      expect(await screen.findByText(/Your Individual licence takes 5% off Frameleaf Cloud plans/)).toBeInTheDocument();
      expect(screen.getByText(/\$9\.49/)).toBeInTheDocument();
    });

    it('offers both rates to a server without a licence, at the regular price (FL-369)', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      render(PlanSection);

      expect(
        await screen.findByText(/A server licence takes 7% off Frameleaf Cloud plans, an individual licence 5%\./),
      ).toBeInTheDocument();
      expect(screen.getByText('$9.99').tagName).not.toBe('S');
    });

    it('follows the discount Frameleaf Cloud published', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ licensed: true, key: keySlot, entitlements: { ...entitlements, supporter: true } }),
      );
      sdkMock.getLicenseProducts.mockResolvedValue({ ...products(), licensedDiscount: 0.25 });
      render(PlanSection);

      expect(await screen.findByText(/\$7\.49/)).toBeInTheDocument();
      expect(screen.getByText(/\$74\.92/)).toBeInTheDocument();
      expect(screen.getByText(/plans cost 25% less/)).toBeInTheDocument();
    });

    it('says purchasing is not available yet when no store is configured', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.getLicenseProducts.mockResolvedValue(products(null));
      render(PlanSection);

      expect(await screen.findAllByText('Purchasing isn’t available on this server yet.')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Continue to checkout' })).not.toBeInTheDocument();
    });

    it('shows an active plan and removes it from this server after confirmation', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ state: LicenseState.Active, plan: planSlot, entitlements: { ...entitlements, remoteAccess: true } }),
      );
      sdkMock.removeLicensePlan.mockResolvedValue(license());
      render(PlanSection);

      expect(await screen.findByText('Active')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Frameleaf Cloud' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Manage subscription/ })).toHaveAttribute('target', '_blank');
      await fireEvent.click(screen.getByRole('button', { name: /Stop using this plan on this server/ }));
      const dialog = await screen.findByRole('dialog');
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Stop using the plan' }));
      await waitFor(() => expect(sdkMock.removeLicensePlan).toHaveBeenCalled());
    });
  });
});
