import {
  createPartner,
  getPartners,
  removePartner,
  searchUsers,
  UserAvatarColor,
  type UserResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import en from '../../../../../i18n/en.json';
import ShareSheet from './ShareSheet.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me' } },
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  searchUsers: vi.fn(),
  getPartners: vi.fn(),
  createPartner: vi.fn(),
  removePartner: vi.fn(),
}));

const user = (id: string, name: string): UserResponseDto =>
  ({
    id,
    name,
    email: `${id}@example.com`,
    avatarColor: UserAvatarColor.Primary,
    profileImagePath: '',
    profileChangedAt: '2026-09-01T00:00:00.000Z',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(searchUsers).mockResolvedValue([user('me', 'Me'), user('riley', 'Riley'), user('sam', 'Sam')]);
  vi.mocked(getPartners).mockResolvedValue([user('riley', 'Riley')] as never);
  authManager.user.id = 'me';
});

describe('ShareSheet', () => {
  it('shows selectable avatar tiles rather than checkboxes and highlights existing recipients', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1'] });
    const riley = await screen.findByRole('button', { name: 'Riley' });
    expect(riley.getAttribute('aria-pressed')).toBe('true');
    const sam = screen.getByRole('button', { name: 'Sam' });
    expect(sam.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('reads "Share with <name>" for one new recipient and syncs through the partner endpoints', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1'] });
    await screen.findByRole('button', { name: 'Sam' });

    await fireEvent.click(screen.getByRole('button', { name: 'Riley' })); // deselect existing partner
    await fireEvent.click(screen.getByRole('button', { name: 'Sam' })); // select a new one

    expect(await screen.findByRole('button', { name: 'Share with Sam' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Share with Sam' }));

    await waitFor(() => {
      expect(createPartner).toHaveBeenCalledWith({ partnerCreateDto: { sharedWithId: 'sam' } });
      expect(removePartner).toHaveBeenCalledWith({ id: 'riley' });
    });
  });

  it('switches to link mode and opens the real shared-link form for the selection', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });
    await screen.findByRole('button', { name: 'Riley' });

    await fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_sharing.link_option_title) }));
    expect(screen.queryByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link }));

    expect(
      await screen.findByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title }),
    ).toBeInTheDocument();
  });
});
