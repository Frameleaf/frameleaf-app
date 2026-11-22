import type { HouseholdLinkDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import LinkedHouseholds from './LinkedHouseholds.svelte';

vi.mock('$lib/managers/cloud-manager.svelte', () => ({
  cloudManager: { status: null, license: null, listen: () => () => {} },
}));

const link = (overrides: Partial<HouseholdLinkDto> = {}): HouseholdLinkDto => ({
  id: 'link-1',
  active: true,
  paused: false,
  ended: false,
  state: 'active',
  reason: null,
  connectionPath: 'local',
  createdAt: '2026-10-12T12:00:00.000Z',
  endedAt: null,
  householdName: 'Rivera',
  peerName: 'Rivera Home',
  lastSeenAt: new Date().toISOString(),
  ...overrides,
});

const refused = (status = 404) => Object.assign(new Error('refused'), { status });

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  Element.prototype.animate ??= () => ({ cancel: () => {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.isHttpError.mockImplementation(((error: { status?: number }) => error?.status !== undefined) as never);
  addMessages('dev', en);
});

describe('LinkedHouseholds', () => {
  it('opens on the empty state with both ways to link', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([]);
    render(LinkedHouseholds);
    expect(await screen.findByText(en.frameleaf_households_empty_title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite another household/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Accept an invitation/ })).toBeEnabled();
  });

  it('shows an invitation with its link and short code', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([]);
    sdkMock.createHouseholdInvitation.mockResolvedValue({
      invitationId: 'i',
      token: 'long-token',
      code: 'FERN-7Q4K-M2XD',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    render(LinkedHouseholds);
    await fireEvent.click(await screen.findByRole('button', { name: /Invite another household/ }));
    expect(await screen.findByText('long-token')).toBeInTheDocument();
    expect(screen.getAllByText('FERN-7Q4K-M2XD').length).toBeGreaterThan(0);
    expect(screen.getByText(/7 days from now/)).toBeInTheDocument();
  });

  it('previews an invitation, then links it with the chosen name', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([]);
    sdkMock.previewHouseholdInvitation.mockResolvedValue({ name: 'Rivera Home' });
    sdkMock.acceptHouseholdInvitation.mockResolvedValue(link());
    render(LinkedHouseholds);
    await fireEvent.click(await screen.findByRole('button', { name: /Accept an invitation/ }));
    await fireEvent.input(await screen.findByLabelText(en.frameleaf_households_accept_field), {
      target: { value: ' FERN-7Q4K-M2XD ' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_households_accept_continue }));
    expect(await screen.findByText('Rivera Home')).toBeInTheDocument();
    await fireEvent.input(screen.getByLabelText(en.frameleaf_households_accept_name, { exact: false }), {
      target: { value: 'Rivera' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_households_accept_link }));
    await waitFor(() =>
      expect(sdkMock.acceptHouseholdInvitation).toHaveBeenCalledWith({
        householdInvitationAcceptDto: { code: 'FERN-7Q4K-M2XD', householdName: 'Rivera' },
      }),
    );
  });

  it.each([404, 403, 410])('says the same one thing for a code refused with %i', async (status) => {
    sdkMock.getHouseholdLinks.mockResolvedValue([]);
    sdkMock.previewHouseholdInvitation.mockRejectedValue(refused(status));
    render(LinkedHouseholds);
    await fireEvent.click(await screen.findByRole('button', { name: /Accept an invitation/ }));
    await fireEvent.input(await screen.findByLabelText(en.frameleaf_households_accept_field), {
      target: { value: 'NOPE' },
    });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_households_accept_continue }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_households_accept_wrong);
  });

  it('lists a linked household with its server, status and last seen', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([link()]);
    render(LinkedHouseholds);
    expect(await screen.findByText('Rivera household')).toBeInTheDocument();
    expect(screen.getByText(/Rivera Home · Linked/)).toBeInTheDocument();
    expect(screen.getByText('On your home network')).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
  });

  it('leaves ended links out', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([link({ ended: true, active: false, state: 'ended' })]);
    render(LinkedHouseholds);
    expect(await screen.findByText(en.frameleaf_households_empty_title)).toBeInTheDocument();
  });

  it('explains a household that can only be reached on its home network', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([link({ reason: 'home-network', connectionPath: null })]);
    render(LinkedHouseholds);
    expect(await screen.findByText('Home network only')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_households_row_home_only)).toBeInTheDocument();
  });

  it('pauses the whole page when this server is not linked to Cloud', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([
      link({ paused: true, active: false, state: 'paused', reason: 'unlinked', connectionPath: null }),
    ]);
    render(LinkedHouseholds);
    expect(await screen.findByText(en.frameleaf_households_paused_title)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_households_paused_cloud_body)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_households_link_cloud })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invite another household/ })).toBeDisabled();
  });

  it('renames a household on this server only', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([link()]);
    sdkMock.updateHouseholdLink.mockResolvedValue(link({ householdName: 'Cousins' }));
    render(LinkedHouseholds);
    await fireEvent.click(await screen.findByRole('button', { name: 'Rename the Rivera household' }));
    const field = await screen.findByLabelText(en.frameleaf_households_rename_field, { exact: false });
    await fireEvent.input(field, { target: { value: 'Cousins' } });
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    await waitFor(() =>
      expect(sdkMock.updateHouseholdLink).toHaveBeenCalledWith({
        id: 'link-1',
        householdLinkUpdateDto: { householdName: 'Cousins' },
      }),
    );
    expect(await screen.findByText('Now called the Cousins household.')).toBeInTheDocument();
  });

  it('asks before unlinking and says both households keep everything', async () => {
    sdkMock.getHouseholdLinks.mockResolvedValue([link()]);
    sdkMock.endHouseholdLink.mockResolvedValue(undefined as never);
    render(LinkedHouseholds);
    await fireEvent.click(await screen.findByRole('button', { name: 'Unlink from the Rivera household' }));

    const dialog = await screen.findByRole('dialog', { name: 'Unlink from the Rivera household?' });
    expect(
      within(dialog).getByText(
        'Both households keep everything they already received. Nothing is deleted on either server.',
      ),
    ).toBeInTheDocument();
    expect(sdkMock.endHouseholdLink).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(sdkMock.endHouseholdLink).toHaveBeenCalledWith({ id: 'link-1' }));
    expect(
      await screen.findByText(
        'Unlinked from the Rivera household. Both households keep everything they already received.',
      ),
    ).toBeInTheDocument();
  });

  it('offers a retry when the list cannot load', async () => {
    sdkMock.getHouseholdLinks.mockRejectedValue(refused());
    render(LinkedHouseholds);
    expect(await screen.findByText(en.frameleaf_households_load_failed)).toBeInTheDocument();
  });
});
