import type { HouseholdInboundShareDto, UserAdminResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { invitationCode, receivedStatus } from '$lib/frameleaf/linked-households';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../../i18n/en.json';
import HouseholdInvitation from './HouseholdInvitation.svelte';
import HouseholdSpaceStatus from './HouseholdSpaceStatus.svelte';

const share = (overrides: Partial<HouseholdInboundShareDto> = {}): HouseholdInboundShareDto => ({
  id: 'inbound-1',
  albumId: 'album-1',
  householdName: 'Rivera',
  spaceName: 'Rivera summer 2026',
  ownerName: 'Rosa Rivera',
  state: 'accepted',
  lastError: null,
  lastPulledAt: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  authManager.setUser({ id: 'me', isAdmin: false } as UserAdminResponseDto);
  addMessages('dev', en);
});

describe('HouseholdInvitation', () => {
  it('names the person, the space and the household', () => {
    render(HouseholdInvitation, { share: share({ state: 'invited', albumId: null }) });
    expect(screen.getByText('Rosa Rivera invited you to “Rivera summer 2026”')).toBeInTheDocument();
    expect(screen.getByText('From the Rivera household')).toBeInTheDocument();
  });

  it('accepts', async () => {
    sdkMock.acceptHouseholdShare.mockResolvedValue(share());
    const onAnswered = vi.fn();
    render(HouseholdInvitation, { share: share({ state: 'invited' }), onAnswered });
    await fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(sdkMock.acceptHouseholdShare).toHaveBeenCalledWith({ id: 'inbound-1' }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it('declines', async () => {
    sdkMock.declineHouseholdShare.mockResolvedValue(undefined as never);
    const onAnswered = vi.fn();
    render(HouseholdInvitation, { share: share({ state: 'invited' }), onAnswered });
    await fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(sdkMock.declineHouseholdShare).toHaveBeenCalledWith({ id: 'inbound-1' }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });
});

describe('HouseholdSpaceStatus', () => {
  it.each([
    ['up to date', {}, 'Up to date', /Checked/],
    ['getting photos', { lastPulledAt: null }, 'Getting photos', null],
    ['unreachable', { lastError: 'unreachable' }, 'Paused', /The Rivera household can’t be reached/],
    ['storage full', { lastError: 'over-quota' }, 'Paused', /Your storage is full/],
    ['file too large', { lastError: 'file-too-large' }, 'Up to date, file skipped', /over the 20 GB limit/],
    ['after unlinking', { state: 'left' }, 'No longer updating', /every copy in it stay yours/],
  ] as const)('says %s', (_, overrides, title, detail) => {
    render(HouseholdSpaceStatus, { share: share(overrides) });
    expect(screen.getByText(title)).toBeInTheDocument();
    if (detail) {
      expect(screen.getByText(detail)).toBeInTheDocument();
    }
  });

  it('offers the storage page to an administrator only', () => {
    const first = render(HouseholdSpaceStatus, { share: share({ lastError: 'over-quota' }) });
    expect(screen.queryByRole('link', { name: en.frameleaf_households_see_storage })).not.toBeInTheDocument();
    first.unmount();
    authManager.setUser({ id: 'me', isAdmin: true } as UserAdminResponseDto);
    render(HouseholdSpaceStatus, { share: share({ lastError: 'over-quota' }) });
    expect(screen.getByRole('link', { name: en.frameleaf_households_see_storage })).toBeInTheDocument();
  });

  it('promises nothing was removed once it stops updating', () => {
    render(HouseholdSpaceStatus, { share: share({ state: 'left' }) });
    expect(screen.getByText(en.frameleaf_households_sync_stopped_note)).toBeInTheDocument();
  });
});

describe('linked-households helpers', () => {
  it('reads an invitation from a code or a pasted address', () => {
    expect(invitationCode('  FERN-7Q4K M2XD ')).toBe('FERN-7Q4KM2XD');
    expect(invitationCode('https://frameleaf.cloud/link/FERN-7Q4K-M2XD/')).toBe('FERN-7Q4K-M2XD');
  });

  it('treats a cap on comments as up to date, and an unknown word as a skipped file', () => {
    expect(receivedStatus(share({ lastError: 'too-many-comments' }))).toBe('current');
    expect(receivedStatus(share({ lastError: 'checksum-mismatch' }))).toBe('skipped_other');
  });
});
