import { CloudHeartbeatField, CloudLinkState, LicenseState, type LicenseStatusResponseDto } from '@immich/sdk';
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
  kind: 'server' as const,
  source: 'key' as const,
  keyHint: 'J58U',
  activatedAt: '2026-09-25T09:00:00.000Z',
  expiresAt: null,
  graceUntil: null,
  refreshedAt: null,
};

const planSlot = {
  state: LicenseState.Active,
  kind: 'plan' as const,
  source: 'account' as const,
  keyHint: null,
  activatedAt: '2026-09-25T09:00:00.000Z',
  expiresAt: '2026-10-25T09:00:00.000Z',
  graceUntil: null,
  refreshedAt: '2026-09-25T09:00:00.000Z',
};

const products = (storeUrl: string | null = 'https://frameleaf.cloud.test/store') => ({
  currency: 'USD' as const,
  licensedDiscount: 0.2,
  storeUrl,
  backup: { usdPerTbMonth: 7.99, minimumTb: 1 },
  products: [
    {
      id: 'cloud-monthly',
      kind: 'plan' as const,
      period: 'month' as const,
      priceUsd: 6,
      storeUrl: storeUrl && `${storeUrl}?product=cloud-monthly`,
    },
    {
      id: 'cloud-annual',
      kind: 'plan' as const,
      period: 'year' as const,
      priceUsd: 60,
      storeUrl: storeUrl && `${storeUrl}?product=cloud-annual`,
    },
    { id: 'supporter-server', kind: 'supporter' as const, period: 'one-time' as const, priceUsd: 100, storeUrl: null },
    {
      id: 'supporter-individual',
      kind: 'supporter' as const,
      period: 'one-time' as const,
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
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: null,
  heartbeatFields: Object.values(CloudHeartbeatField),
  heartbeatFailures: 0,
  cloneSuspected: false,
  relinkRequested: false,
  linkTokenConfigured: false,
  remoteAccessEnabled: false,
  signInClientId: null,
  signInIssuer: null,
  signInLinkedAccounts: 0,
  signInShowOnLocalLogin: false,
  signInButtonText: 'Sign in with Frameleaf',
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

  describe('LicenseSection', () => {
    it('refuses a mistyped or upstream key before sending it, then activates a valid server key', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.activateLicense.mockResolvedValue(license({ licensed: true, key: keySlot, keyHint: 'J58U' }));
      render(LicenseSection);

      const input = await screen.findByPlaceholderText('FL-XXXX-XXXX-XXXX');
      const activate = screen.getByRole('button', { name: 'Activate licence' });

      await fireEvent.input(input, { target: { value: 'imcl-0key-aaaa-bbbb' } });
      expect(await screen.findByText(/not a Frameleaf licence key/)).toBeInTheDocument();
      expect(activate).toBeDisabled();

      await fireEvent.input(input, { target: { value: 'fls8nl49g8j58v' } });
      expect(input).toHaveValue('FL-S8NL-49G8-J58V');
      expect(await screen.findByText(/typo/)).toBeInTheDocument();
      expect(activate).toBeDisabled();

      await fireEvent.input(input, { target: { value: 'FL-S8NL-49G8-J58U' } });
      await waitFor(() => expect(activate).toBeEnabled());
      await fireEvent.click(activate);
      await waitFor(() =>
        expect(sdkMock.activateLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-S8NL-49G8-J58U' } }),
      );
      expect(await screen.findByText('•••• J58U')).toBeInTheDocument();
      expect(screen.getByText('Licensed')).toBeInTheDocument();
    });

    it('activates a key for one person as the administrator’s own supporter key, as the prototype allows', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.setUserLicense.mockResolvedValue({} as never);
      sdkMock.getMyUser.mockResolvedValue({ id: 'admin-1', isAdmin: true, license: { kind: 'individual' } } as never);
      render(LicenseSection);

      await fireEvent.input(await screen.findByPlaceholderText('FL-XXXX-XXXX-XXXX'), {
        target: { value: 'FL-IC8Q-BT2Q-8ELH' },
      });
      const activate = screen.getByRole('button', { name: 'Activate licence' });
      await waitFor(() => expect(activate).toBeEnabled());
      await fireEvent.click(activate);
      await waitFor(() =>
        expect(sdkMock.setUserLicense).toHaveBeenCalledWith({ licenseActivateDto: { key: 'FL-IC8Q-BT2Q-8ELH' } }),
      );
      expect(sdkMock.activateLicense).not.toHaveBeenCalled();
      expect(await screen.findByText(/active for your account/)).toBeInTheDocument();
    });

    it.each([
      [LicenseState.Expired, 'Your plan has ended'],
      [LicenseState.Invalid, 'The licence could not be verified'],
    ])('shows the %s banner and still offers a replacement key', async (state, title) => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ state, key: { ...keySlot, state }, keyHint: 'J58U', licensed: false }),
      );
      render(LicenseSection);
      expect(await screen.findByText(title)).toBeInTheDocument();
      expect(screen.getByText('Enter a licence key')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('FL-XXXX-XXXX-XXXX')).toBeInTheDocument();
    });

    it('shows an individual licence as licensed, with its hint and removal in place', async () => {
      authManager.setUser({
        id: 'admin-1',
        name: 'Admin',
        email: 'a@example.test',
        isAdmin: true,
        license: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T09:00:00.000Z' },
      } as never);
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.deleteUserLicense.mockResolvedValue();
      sdkMock.getMyUser.mockResolvedValue({ id: 'admin-1', isAdmin: true, license: null } as never);
      render(LicenseSection);

      expect(await screen.findByRole('heading', { name: 'Individual licence' })).toBeInTheDocument();
      expect(screen.getByText('Licensed')).toBeInTheDocument();
      expect(screen.getByText('•••• 8ELH')).toBeInTheDocument();
      expect(screen.queryByText('Enter a licence key')).toBeNull();

      await fireEvent.click(screen.getByRole('button', { name: 'Remove your supporter key…' }));
      const dialog = await screen.findByRole('dialog');
      await fireEvent.click(within(dialog).getByRole('button', { name: /Remove key/ }));
      await waitFor(() => expect(sdkMock.deleteUserLicense).toHaveBeenCalled());
      expect(sdkMock.removeLicenseKey).not.toHaveBeenCalled();
      expect(await screen.findByText('Enter a licence key')).toBeInTheDocument();
    });

    it('shows an expired server key and a personal key side by side, each removed through its own endpoint', async () => {
      authManager.setUser({
        id: 'admin-1',
        name: 'Admin',
        email: 'a@example.test',
        isAdmin: true,
        license: { kind: 'individual', keyHint: '8ELH', activatedAt: '2026-09-25T09:00:00.000Z' },
      } as never);
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ state: LicenseState.Expired, key: { ...keySlot, state: LicenseState.Expired }, keyHint: 'J58U' }),
      );
      sdkMock.removeLicenseKey.mockResolvedValue(license());
      sdkMock.deleteUserLicense.mockResolvedValue();
      sdkMock.getMyUser.mockResolvedValue({ id: 'admin-1', isAdmin: true, license: null } as never);
      render(LicenseSection);

      expect(await screen.findByText('•••• J58U')).toBeInTheDocument();
      expect(screen.getByText('•••• 8ELH')).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('button', { name: 'Remove licence key…' }));
      await fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove key' }));
      await waitFor(() => expect(sdkMock.removeLicenseKey).toHaveBeenCalled());
      expect(sdkMock.deleteUserLicense).not.toHaveBeenCalled();

      await fireEvent.click(screen.getByRole('button', { name: 'Remove your supporter key…' }));
      const personalDialog = await screen.findByRole('dialog');
      expect(within(personalDialog).getByText('Remove your supporter key?')).toBeInTheDocument();
      expect(within(personalDialog).queryByText(/on this server/)).toBeNull();
      await fireEvent.click(within(personalDialog).getByRole('button', { name: 'Remove key' }));
      await waitFor(() => expect(sdkMock.deleteUserLicense).toHaveBeenCalledTimes(1));
      expect(sdkMock.removeLicenseKey).toHaveBeenCalledTimes(1);
    });

    it('installs a licence file and shows this server’s instance ID', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      sdkMock.installLicenseCertificate.mockResolvedValue(license({ plan: planSlot }));
      const { container } = render(LicenseSection);

      expect(await screen.findByText('018f3a7c-5e2b-7c91-9a4d-2f6b1e0c8d55')).toBeInTheDocument();
      const input = container.querySelector('input[type="file"]') as HTMLInputElement;
      const file = new File(['header.payload.signature'], 'server.lic');
      await fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() =>
        expect(sdkMock.installLicenseCertificate).toHaveBeenCalledWith({
          licenseCertificateDto: { certificate: 'header.payload.signature' },
        }),
      );
    });

    it('warns in grace and asks before removing the key, naming the badge and discount', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({
          state: LicenseState.Grace,
          graceUntil: '2026-10-09T09:00:00.000Z',
          licensed: true,
          key: keySlot,
          entitlements: { ...entitlements, supporter: true, remoteAccess: true },
        }),
      );
      sdkMock.removeLicenseKey.mockResolvedValue(license());
      render(LicenseSection);

      expect(await screen.findByText('Your renewal did not go through')).toBeInTheDocument();
      const chips = screen.getByRole('list', { name: 'Included features' });
      expect(within(chips).getByText('Remote access').closest('li')).toHaveClass('is-on');
      expect(within(chips).getByText('Cloud backup').closest('li')).not.toHaveClass('is-on');

      await fireEvent.click(screen.getByRole('button', { name: /Remove licence key/ }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/supporter badge and the licensed-server discount stop/)).toBeInTheDocument();
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove key' }));
      await waitFor(() => expect(sdkMock.removeLicenseKey).toHaveBeenCalled());
    });
  });

  describe('PlanSection', () => {
    it('shows plan cards with the store link and backup as its own usage price', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(license());
      render(PlanSection);

      expect(await screen.findByText('No plan on this server')).toBeInTheDocument();
      expect(screen.getByText('$6')).toBeInTheDocument();
      expect(screen.getByText('$60')).toBeInTheDocument();
      expect(screen.queryByText(/1 TB encrypted/)).not.toBeInTheDocument();
      expect(screen.getByText(/from \$7.99\/month per TB, 1 TB minimum/)).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Continue to checkout' })).toHaveLength(2);
    });

    it('strikes through the price on a licensed server (plans only)', async () => {
      sdkMock.getLicenseStatus.mockResolvedValue(
        license({ licensed: true, key: keySlot, entitlements: { ...entitlements, supporter: true } }),
      );
      render(PlanSection);

      expect(await screen.findByText(/\$4.80/)).toBeInTheDocument();
      expect(screen.getByText('$6').tagName).toBe('S');
      expect(screen.getByText(/\$4.80/)).toBeInTheDocument();
      expect(screen.getByText(/\$48/)).toBeInTheDocument();
      expect(screen.getByText(/AI credit is priced the same for everyone/)).toBeInTheDocument();
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
      await fireEvent.click(screen.getByRole('button', { name: /Remove from this server/ }));
      const dialog = await screen.findByRole('dialog');
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Remove plan' }));
      await waitFor(() => expect(sdkMock.removeLicensePlan).toHaveBeenCalled());
    });
  });
});
