import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import {
  removeSharedSpaceInvitation,
  removeUserFromAlbum,
  searchUsers,
  updateAlbumUser,
  AlbumKind,
  AlbumUserRole,
  type SharedSpaceMemberResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import en from '../../../../../i18n/en.json';
import SharedSpaceMembers from './SharedSpaceMembers.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  addUsersToAlbum: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  signedInId = 'ada';
  addMessages('dev', en);
  vi.mocked(searchUsers).mockResolvedValue([]);
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

  it('removes a member who has joined through the album endpoint', async () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Bo from this shared space' }));

    await waitFor(() => expect(removeUserFromAlbum).toHaveBeenCalledWith({ id: 'space-1', userId: 'bo' }));
    expect(removeSharedSpaceInvitation).not.toHaveBeenCalled();
  });

  it('never offers the owner role', async () => {
    render(SharedSpaceMembers, { space, members, onChanged: vi.fn() });

    const options = [...screen.getByRole('combobox', { name: 'Role for Bo' }).querySelectorAll('option')].map(
      (option) => option.textContent,
    );
    expect(options).toEqual([en.frameleaf_spaces_role_editor, en.frameleaf_spaces_role_viewer]);
  });
});
