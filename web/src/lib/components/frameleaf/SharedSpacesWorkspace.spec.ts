import { fireEvent, render, screen } from '@testing-library/svelte';
import { AlbumKind, AlbumUserRole, type AlbumResponseDto, type PartnerResponseDto, UserAvatarColor } from '@immich/sdk';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SharedSpacesWorkspace from './SharedSpacesWorkspace.svelte';

const me = userAdminFactory.build({ id: 'me', isAdmin: false });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));
vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

const ownedSpace = (overrides: Parameters<typeof albumFactory.build>[0] = {}): AlbumResponseDto =>
  albumFactory.build({
    kind: AlbumKind.Space,
    albumUsers: [
      { user: me, role: AlbumUserRole.Owner },
      { user: jamie, role: AlbumUserRole.Editor },
    ],
    ...overrides,
  });

const familySpace = ownedSpace({ id: 'family-space', albumName: 'Family Space', assetCount: 42 });

const partner: PartnerResponseDto = {
  id: 'jamie',
  name: 'Jamie',
  email: 'jamie@example.com',
  avatarColor: UserAvatarColor.Primary,
  profileChangedAt: '2026-09-01T00:00:00.000Z',
  profileImagePath: '',
};

describe('SharedSpacesWorkspace', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('lists every shared space and every partner', () => {
    render(SharedSpacesWorkspace, { spaces: [familySpace], partners: [partner], onRefresh: vi.fn() });

    expect(screen.getByRole('heading', { level: 1, name: 'Shared spaces' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Family Space' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Open Jamie’s library" })).toHaveAttribute('href', '/partners/jamie');
  });

  it('shows the empty state with a create action when there are no shared spaces', () => {
    render(SharedSpacesWorkspace, { spaces: [], partners: [], onRefresh: vi.fn() });

    expect(screen.getByRole('heading', { level: 2, name: 'No shared spaces yet' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open .* library/ })).toBeNull();
  });

  it('opens the create dialog for a shared space, not an album or a collection', async () => {
    render(SharedSpacesWorkspace, { spaces: [familySpace], partners: [], onRefresh: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'New shared space' }));

    expect(screen.getByRole('heading', { name: 'Create shared space' })).toBeInTheDocument();
    expect(
      screen.getByText('A shared space is a top-level library that everyone you invite adds to. Invite people from its page once it exists.'),
    ).toBeInTheDocument();
  });
});
