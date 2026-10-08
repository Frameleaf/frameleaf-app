import { CloudHeartbeatField, CloudLinkRefusal, CloudLinkState, type CloudStatusResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import SetupFrameleafLink from './SetupFrameleafLink.svelte';

const REGION_MESSAGE =
  "This Frameleaf account keeps its data in the EU, not North America. Link this server to an account in that region, or change the server's region setting to the EU and link again.";

const refused = (canContinue: boolean): CloudStatusResponseDto => ({
  state: CloudLinkState.Unlinked,
  configured: true,
  cloudHost: 'frameleaf.cloud.test',
  instanceId: null,
  keyFingerprint: null,
  account: null,
  dataRegion: null,
  linkedAt: null,
  lastContactAt: null,
  pending: null,
  linkResult: null,
  linkRefusal: CloudLinkRefusal.RegionMismatch,
  regionMismatch: { accountRegion: 'eu', requestedRegion: 'na', canContinue },
  permissions: { allowRemoteEnable: false, allowBackupTrigger: true, allowEntitlementRefresh: true },
  revoked: null,
  lastError: REGION_MESSAGE,
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
});

describe('SetupFrameleafLink region-mismatch (FC-18)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getLicenseStatus.mockRejectedValue(new Error('not needed'));
    sdkMock.getLicenseProducts.mockRejectedValue(new Error('not needed'));
  });

  it('shows Frameleaf Cloud’s message and links in the account’s region without a new code', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(refused(true));
    sdkMock.continueCloudLink.mockResolvedValue(refused(true));
    render(SetupFrameleafLink, { mode: 'link', linked: false, onLinked: vi.fn() });

    expect(await screen.findByText(REGION_MESSAGE)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Link in the EU' }));
    await waitFor(() => expect(sdkMock.continueCloudLink).toHaveBeenCalled());
    expect(sdkMock.startCloudLink).not.toHaveBeenCalled();
  });

  it('says why the last code did not link, with a fresh start below', async () => {
    sdkMock.getCloudStatus.mockResolvedValue({
      ...refused(false),
      linkRefusal: null,
      regionMismatch: null,
      lastError: null,
      linkResult: 'expired',
    } as CloudStatusResponseDto);
    render(SetupFrameleafLink, { mode: 'link', linked: false, onLinked: vi.fn() });

    expect(await screen.findByText('The code expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in with Frameleaf/ })).toBeInTheDocument();
  });

  it('shows the message above a fresh start when the approval was not kept', async () => {
    sdkMock.getCloudStatus.mockResolvedValue(refused(false));
    render(SetupFrameleafLink, { mode: 'link', linked: false, onLinked: vi.fn() });

    // the shared cloud manager may still hold the previous status until its refresh lands
    await waitFor(() => expect(screen.getByRole('button', { name: /Sign in with Frameleaf/ })).toBeInTheDocument());
    expect(screen.getByText(REGION_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link in/ })).toBeNull();
  });
});
