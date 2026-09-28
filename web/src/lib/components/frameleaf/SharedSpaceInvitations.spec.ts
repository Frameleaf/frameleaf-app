import {
  acceptSharedSpaceInvitation,
  declineSharedSpaceInvitation,
  AlbumUserRole,
  type SharedSpacePreviewResponseDto,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import SharedSpaceInvitations from './SharedSpaceInvitations.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  acceptSharedSpaceInvitation: vi.fn(),
  declineSharedSpaceInvitation: vi.fn(),
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

const invitation = (overrides: Partial<SharedSpacePreviewResponseDto> = {}): SharedSpacePreviewResponseDto => ({
  id: 'space-1',
  albumName: 'Family Space',
  description: 'Everything from the reunion',
  icon: null,
  owner: user('ada', 'Ada'),
  invitedBy: user('ada', 'Ada'),
  role: AlbumUserRole.Viewer,
  invitedAt: '2026-09-20T00:00:00.000Z',
  accepted: false,
  memberCount: 3,
  assetCount: 42,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('SharedSpaceInvitations', () => {
  it('shows what the space exposes: who, the role offered, and the counts', () => {
    render(SharedSpaceInvitations, { invitations: [invitation()], onAnswered: vi.fn() });

    expect(screen.getByRole('article', { name: 'Family Space' })).toBeInTheDocument();
    expect(screen.getByText('Ada invited you')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_album_role_viewer)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows no photo of any kind before the recipient joins, and says why the counts are what they are', () => {
    const { container } = render(SharedSpaceInvitations, { invitations: [invitation()], onAnswered: vi.fn() });

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText(en.frameleaf_spaces_preview_safety)).toBeInTheDocument();
  });

  it('joins through the accept endpoint and re-reads the page', async () => {
    const onAnswered = vi.fn();
    render(SharedSpaceInvitations, { invitations: [invitation()], onAnswered });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_invitation_accept }));

    await waitFor(() => expect(acceptSharedSpaceInvitation).toHaveBeenCalledWith({ id: 'space-1' }));
    expect(declineSharedSpaceInvitation).not.toHaveBeenCalled();
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it('declines without touching anything else', async () => {
    render(SharedSpaceInvitations, { invitations: [invitation()], onAnswered: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_invitation_decline }));

    await waitFor(() => expect(declineSharedSpaceInvitation).toHaveBeenCalledWith({ id: 'space-1' }));
    expect(acceptSharedSpaceInvitation).not.toHaveBeenCalled();
  });

  it('renders nothing once every invitation has been answered', () => {
    const { container } = render(SharedSpaceInvitations, {
      invitations: [invitation({ accepted: true })],
      onAnswered: vi.fn(),
    });

    expect(container.querySelector('section')).toBeNull();
  });
});
