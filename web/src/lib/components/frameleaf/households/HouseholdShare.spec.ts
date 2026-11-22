import type { HouseholdShareLinkDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import HouseholdShareHarness from './HouseholdShareHarness.spec.svelte';

const links = (overrides: Partial<HouseholdShareLinkDto> = {}): HouseholdShareLinkDto[] => [
  {
    linkId: 'link-1',
    householdName: 'Rivera',
    reachable: true,
    directory: [
      { id: 'rosa', name: 'Rosa Rivera', hasAvatar: true },
      { id: 'mateo', name: 'Mateo Rivera', hasAvatar: false },
    ],
    members: [],
    ...overrides,
  },
];
const member = (state: string, role = 'viewer') => ({
  shareId: 'share-1',
  remoteUserId: 'rosa',
  displayName: 'Rosa Rivera',
  role,
  state,
});

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
  addMessages('dev', en);
});

describe('Other households in the Share sheet', () => {
  it('says how to link when no household is linked', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue([]);
    render(HouseholdShareHarness);
    expect(await screen.findByText(en.frameleaf_households_share_none)).toBeInTheDocument();
  });

  it('lists people by name and household, and never an email', async () => {
    const withEmail = links();
    (withEmail[0].directory[0] as unknown as { email: string }).email = 'rosa@rivera.example';
    (withEmail[0].members as unknown[]).push({
      ...member('accepted'),
      remoteUserId: 'ana',
      displayName: 'Ana Rivera',
      email: 'ana@rivera.example',
    });
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(withEmail);
    const { container } = render(HouseholdShareHarness);
    expect(await screen.findByRole('option', { name: /Rosa Rivera/ })).toHaveTextContent('Rivera household');
    expect(await screen.findByText('Ana Rivera')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('@');
    expect(container.innerHTML).not.toContain('rivera.example');
  });

  it('invites with the chosen role and says what happens next', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValueOnce(links());
    sdkMock.inviteSharedSpaceHouseholdMember.mockResolvedValue(member('invited', 'contributor'));
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(links({ members: [member('invited', 'contributor')] }));
    render(HouseholdShareHarness);
    await fireEvent.click(await screen.findByRole('option', { name: /Rosa Rivera/ }));
    await fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'contributor' } });
    expect(screen.getByText(en.frameleaf_households_role_contributor_help)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_album_share_invite }));
    await waitFor(() =>
      expect(sdkMock.inviteSharedSpaceHouseholdMember).toHaveBeenCalledWith({
        id: 'space-1',
        householdShareInviteDto: { linkId: 'link-1', remoteUserId: 'rosa', role: 'contributor' },
      }),
    );
    expect(
      await screen.findByText('Invited Rosa Rivera as Contributor. They’ll see the invitation on their own server.'),
    ).toBeInTheDocument();
    expect(await screen.findByText(en.frameleaf_households_share_pending)).toBeInTheDocument();
  });

  it('says when a household cannot be reached', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(
      links({ reachable: false, directory: [], members: [member('invited')] }),
    );
    render(HouseholdShareHarness);
    expect(
      await screen.findByText(
        'The Rivera household can’t be reached right now. They’ll see the invitation when it’s back.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a member who left with what they keep, and clears them at once', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(links({ members: [member('left')] }));
    sdkMock.removeSharedSpaceHouseholdMember.mockResolvedValue(undefined as never);
    render(HouseholdShareHarness);
    expect(await screen.findByText(en.frameleaf_households_share_left)).toBeInTheDocument();
    expect(screen.queryByLabelText('Role for Rosa Rivera')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Clear Rosa Rivera from the list' }));
    await waitFor(() => expect(sdkMock.removeSharedSpaceHouseholdMember).toHaveBeenCalled());
  });

  it('changes a role', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(links({ members: [member('accepted')] }));
    sdkMock.updateSharedSpaceHouseholdMember.mockResolvedValue(undefined as never);
    render(HouseholdShareHarness);
    await fireEvent.change(await screen.findByLabelText('Role for Rosa Rivera'), {
      target: { value: 'contributor' },
    });
    await waitFor(() =>
      expect(sdkMock.updateSharedSpaceHouseholdMember).toHaveBeenCalledWith({
        id: 'space-1',
        shareId: 'share-1',
        remoteUserId: 'rosa',
        householdShareRoleDto: { role: 'contributor' },
      }),
    );
  });

  it('asks before removing an accepted member and says they keep their copies', async () => {
    sdkMock.getSharedSpaceHouseholds.mockResolvedValue(links({ members: [member('accepted')] }));
    sdkMock.removeSharedSpaceHouseholdMember.mockResolvedValue(undefined as never);
    render(HouseholdShareHarness);
    await fireEvent.click(await screen.findByRole('button', { name: 'Remove Rosa Rivera' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Rosa Rivera from this space?' });
    expect(within(dialog).getByText(/keeps the copies they already received/)).toBeInTheDocument();
    expect(sdkMock.removeSharedSpaceHouseholdMember).not.toHaveBeenCalled();
    await fireEvent.click(within(dialog).getByRole('button', { name: en.frameleaf_households_remove_confirm }));
    await waitFor(() =>
      expect(sdkMock.removeSharedSpaceHouseholdMember).toHaveBeenCalledWith({
        id: 'space-1',
        shareId: 'share-1',
        remoteUserId: 'rosa',
      }),
    );
  });
});
