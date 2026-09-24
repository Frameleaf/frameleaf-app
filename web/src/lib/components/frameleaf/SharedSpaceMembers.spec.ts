import {
  addUsersToAlbum,
  getRecipientGroups,
  removeSharedSpaceInvitation,
  removeUserFromAlbum,
  searchUsers,
  updateAlbumUser,
  AlbumKind,
  AlbumUserRole,
  type SharedSpaceMemberResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { albumFactory } from '@test-data/factories/album-factory';
import en from '../../../../../i18n/en.json';
import SharedSpaceMembers from './SharedSpaceMembers.svelte';

vi.mock('$lib/utils');
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  addUsersToAlbum: vi.fn(),
  getRecipientGroups: vi.fn(),
  createRecipientGroup: vi.fn(),
  updateRecipientGroup: vi.fn(),
  deleteRecipientGroup: vi.fn(),
  removeSharedSpaceInvitation: vi.fn(),
  removeUserFromAlbum: vi.fn(),
  searchUsers: vi.fn(),
  updateAlbumUser: vi.fn(),
}));

let signedInId = 'ada';
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return { id: signedInId, name: 'Signed in', email: 'signed-in@example.com', isAdmin: false };
    },
    params: {},
  },
}));

const user = (id: string, name: string): UserResponseDto =>
  ({
    id,
    name,
    email: `${id}@example.com`,
    profileImagePath: '',
    avatarColor: 'primary',
    profileChangedAt: '',
  }) as unknown as UserResponseDto;

const ada = user('ada', 'Ada');
const bo = user('bo', 'Bo');
const cy = user('cy', 'Cy');

const space = albumFactory.build({
  id: 'space-1',
  albumName: 'Family Space',
  kind: AlbumKind.Space,
  albumUsers: [
    { user: ada, role: AlbumUserRole.Owner },
    { user: bo, role: AlbumUserRole.Editor },
  ],
});

const members: SharedSpaceMemberResponseDto[] = [
  { user: ada, role: AlbumUserRole.Owner, pending: false },
  { user: bo, role: AlbumUserRole.Editor, pending: false },
  { user: cy, role: AlbumUserRole.Viewer, pending: true, invitedAt: '2026-09-20T00:00:00.000Z' },
];

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  signedInId = 'ada';
  addMessages('dev', en);
  vi.mocked(searchUsers).mockResolvedValue([]);
  vi.mocked(getRecipientGroups).mockResolvedValue([]);
});

describe('SharedSpaceMembers', () => {
  it('lists members and marks the invitation nobody has answered', () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Bo')).toBeInTheDocument();
    expect(screen.getByText('Cy')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_spaces_member_pending)).toBeInTheDocument();
  });

  it('gives the owner the invite control and a role menu for everyone but themselves', () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    expect(screen.getByRole('button', { name: en.frameleaf_spaces_invite })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for Bo' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Role for Ada' })).toBeNull();
  });

  it('offers an editor neither the invite control nor a role menu, only their own leave', () => {
    signedInId = 'bo';
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    expect(screen.queryByRole('button', { name: en.frameleaf_spaces_invite })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: en.frameleaf_spaces_leave })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Cy from this shared space' })).toBeNull();
  });

  it('changes a role through the album endpoint', async () => {
    vi.mocked(updateAlbumUser).mockResolvedValue(undefined as never);
    const onChanged = vi.fn();
    render(SharedSpaceMembers, { space, members, onChanged });

    await fireEvent.change(screen.getByRole('combobox', { name: 'Role for Bo' }), {
      target: { value: AlbumUserRole.Viewer },
    });

    await waitFor(() =>
      expect(updateAlbumUser).toHaveBeenCalledWith({
        id: 'space-1',
        userId: 'bo',
        updateAlbumUserDto: { role: AlbumUserRole.Viewer },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('withdraws an invitation through its own endpoint, never the remove-member one', async () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Withdraw the invitation to Cy' }));

    await waitFor(() => expect(removeSharedSpaceInvitation).toHaveBeenCalledWith({ id: 'space-1', userId: 'cy' }));
    expect(removeUserFromAlbum).not.toHaveBeenCalled();
  });

  it('asks in the Frameleaf dialog before removing a member, then removes through the album endpoint', async () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Bo from this shared space' }));
    expect(removeUserFromAlbum).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Remove Bo?' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_album_remove_member_confirm }));

    await waitFor(() => expect(removeUserFromAlbum).toHaveBeenCalledWith({ id: 'space-1', userId: 'bo' }));
    expect(removeSharedSpaceInvitation).not.toHaveBeenCalled();
  });

  it('asks with the leave copy before an editor leaves', async () => {
    signedInId = 'bo';
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_leave }));
    expect(removeUserFromAlbum).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Leave “Family Space”?' })).toBeInTheDocument();

    // The roster's own Leave and the dialog's confirm share the design's label; the confirm is the last.
    await fireEvent.click(screen.getAllByRole('button', { name: 'Leave shared space' }).at(-1)!);
    // Leaving is the shared leave action (the server's own "remove myself"), and it alone navigates.
    await waitFor(() => expect(removeUserFromAlbum).toHaveBeenCalledWith({ id: 'space-1', userId: 'me' }));
    await waitFor(() => expect(goto).toHaveBeenCalledTimes(1));
    expect(goto).toHaveBeenCalledWith('/sharing');
  });

  it('never offers the owner role, and names roles as the design does', async () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    const options = [...screen.getByRole('combobox', { name: 'Role for Bo' }).querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(['Editor', 'Viewer']);
  });

  it('invites one person from the prototype’s searchable list with the chosen role', async () => {
    const dee = user('dee', 'Dee');
    vi.mocked(searchUsers).mockResolvedValue([ada, bo, cy, dee]);
    vi.mocked(addUsersToAlbum).mockResolvedValue(space);
    const onChanged = vi.fn();
    render(SharedSpaceMembers, { space, members, onChanged });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_invite }));
    const people = await screen.findByRole('listbox', { name: 'People to invite' });
    // Everyone already in the space or invited is not offered again.
    expect(
      within(people)
        .getAllByRole('option')
        .map((option) => option.textContent?.trim()),
    ).toEqual([expect.stringContaining('Dee')]);
    const invite = screen.getByRole('button', { name: /^Invite$/ });
    expect(invite).toBeDisabled();

    await fireEvent.click(within(people).getByRole('option', { name: /Dee/ }));
    await fireEvent.change(screen.getAllByRole('combobox', { name: 'Role' })[0], {
      target: { value: AlbumUserRole.Viewer },
    });
    await fireEvent.click(invite);

    await waitFor(() =>
      expect(addUsersToAlbum).toHaveBeenCalledWith({
        id: 'space-1',
        addUsersDto: { albumUsers: [{ userId: 'dee', role: AlbumUserRole.Viewer }] },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  describe('named recipient shortcuts (FL-55)', () => {
    const dee = user('dee', 'Dee');
    const eve = user('eve', 'Eve');
    const family = {
      id: 'group-1',
      name: 'Family',
      users: [bo, cy, dee, eve],
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    };

    it('reviews a group before inviting, leaving out anyone already involved, and shares no group name', async () => {
      vi.mocked(searchUsers).mockResolvedValue([ada, bo, cy, dee, eve]);
      vi.mocked(getRecipientGroups).mockResolvedValue([family]);
      vi.mocked(addUsersToAlbum).mockResolvedValue(space);
      render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_invite }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Invite Family, 4 people' }));

      // Nothing is sent by applying the group: a review sheet lists who it would invite.
      expect(addUsersToAlbum).not.toHaveBeenCalled();
      const sheet = within(await screen.findByRole('dialog', { name: 'Invite “Family”' }));
      expect(sheet.getByRole('checkbox', { name: /Bo/ })).toBeDisabled();
      expect(sheet.getByRole('checkbox', { name: /Cy/ })).toBeDisabled();
      expect(sheet.getByRole('checkbox', { name: /Dee/ })).toBeChecked();
      expect(sheet.getByRole('checkbox', { name: /Eve/ })).toBeChecked();

      await fireEvent.click(sheet.getByRole('checkbox', { name: /Eve/ }));
      await fireEvent.click(sheet.getByRole('button', { name: 'Send 1 invitation' }));

      await waitFor(() =>
        expect(addUsersToAlbum).toHaveBeenCalledWith({
          id: 'space-1',
          addUsersDto: { albumUsers: [{ userId: 'dee', role: AlbumUserRole.Editor }] },
        }),
      );
      // The invitation is the ordinary one: no group or group name travels with it.
      expect(JSON.stringify(vi.mocked(addUsersToAlbum).mock.calls)).not.toContain('Family');
    });

    it('keeps the review sheet open with the same people picked when sending fails', async () => {
      vi.mocked(searchUsers).mockResolvedValue([ada, bo, cy, dee, eve]);
      vi.mocked(getRecipientGroups).mockResolvedValue([family]);
      vi.mocked(addUsersToAlbum).mockRejectedValue(new Error('offline'));
      render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_invite }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Invite Family, 4 people' }));
      const sheet = within(await screen.findByRole('dialog', { name: 'Invite “Family”' }));
      await fireEvent.click(sheet.getByRole('checkbox', { name: /Eve/ }));
      await fireEvent.click(sheet.getByRole('button', { name: 'Send 1 invitation' }));

      await waitFor(() => expect(addUsersToAlbum).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('dialog', { name: 'Invite “Family”' })).toBeInTheDocument();
      expect(sheet.getByRole('checkbox', { name: /Dee/ })).toBeChecked();
      expect(sheet.getByRole('checkbox', { name: /Eve/ })).not.toBeChecked();
      expect(sheet.getByRole('button', { name: 'Send 1 invitation' })).toBeEnabled();
    });

    it('offers the shortcuts to the owner only', () => {
      signedInId = 'bo';
      render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });
      expect(screen.queryByRole('button', { name: en.frameleaf_spaces_invite })).toBeNull();
      expect(getRecipientGroups).not.toHaveBeenCalled();
    });
  });
});
