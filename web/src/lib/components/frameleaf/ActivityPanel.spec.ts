import { AlbumUserRole, ReactionType, type ActivityResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ActivityPanel from './ActivityPanel.svelte';

const me = userAdminFactory.build({ id: 'me', name: 'Me' });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

const state = vi.hoisted(() => ({ activities: [] as unknown[], deleteActivity: vi.fn() }));
vi.mock('$lib/managers/activity-manager.svelte', () => ({
  activityManager: {
    get activities() {
      return state.activities;
    },
    get likeCount() {
      return state.activities.filter((entry) => (entry as ActivityResponseDto).type === 'like').length;
    },
    isLiked: undefined,
    deleteActivity: state.deleteActivity,
    toggleLike: vi.fn(),
    addActivity: vi.fn(),
  },
}));
let signedIn = 'me';
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return { id: signedIn };
    },
  },
}));

const like = (id: string, user: typeof me, assetId: string | null): ActivityResponseDto =>
  ({ id, type: ReactionType.Like, user, assetId, createdAt: '2026-09-20T00:00:00.000Z' }) as ActivityResponseDto;
const comment = (id: string, user: typeof me, text: string): ActivityResponseDto =>
  ({
    id,
    type: ReactionType.Comment,
    user,
    assetId: 'asset-1',
    comment: text,
    createdAt: '2026-09-20T00:00:00.000Z',
  }) as ActivityResponseDto;

const album = albumFactory.build({
  id: 'album-1',
  isActivityEnabled: true,
  albumUsers: [
    { user: me, role: AlbumUserRole.Owner },
    { user: jamie, role: AlbumUserRole.Editor },
  ],
});

describe('ActivityPanel', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signedIn = 'me';
    state.activities = [like('l1', jamie, 'asset-1'), like('l2', me, null), comment('c1', jamie, 'Lovely')];
  });

  it('lists who liked the item on request, and lets the album owner remove someone else’s like', async () => {
    render(ActivityPanel, { album, assetId: 'asset-1', onClose: vi.fn() });

    expect(screen.queryByRole('list', { name: 'People who liked this' })).toBeNull();
    await fireEvent.click(screen.getByRole('button', { expanded: false, name: /like/ }));
    const likers = screen.getByRole('list', { name: 'People who liked this' });
    // Only the item's own likes; the album-level like is not this item's.
    expect(likers).toHaveTextContent('Jamie');
    expect(likers).not.toHaveTextContent('You');

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Jamie’s like' }));
    await waitFor(() => expect(state.deleteActivity).toHaveBeenCalledWith(state.activities[0]));
  });

  it('lets the album owner delete another member’s comment', async () => {
    render(ActivityPanel, { album, assetId: 'asset-1', onClose: vi.fn() });
    expect(screen.getByRole('button', { name: 'Delete Jamie’s comment' })).toBeInTheDocument();
  });

  it('keeps the history readable but offers no like or comment when comments are turned off (FL-53)', () => {
    render(ActivityPanel, { album: { ...album, isActivityEnabled: false }, assetId: 'asset-1', onClose: vi.fn() });

    expect(screen.getByText(/Likes and comments are turned off here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Like' })).toBeDisabled();
    expect(screen.queryByRole('textbox', { name: 'Write a comment' })).toBeNull();
    // Earlier comments stay on the record.
    expect(screen.getByText('Lovely')).toBeInTheDocument();
  });

  it('offers a member no delete on someone else’s like or comment', async () => {
    signedIn = 'jamie';
    state.activities = [like('l1', me, 'asset-1'), comment('c1', me, 'Hi')];
    render(ActivityPanel, { album, assetId: 'asset-1', onClose: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { expanded: false, name: /like/ }));
    expect(screen.queryByRole('button', { name: /Remove .* like/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete .*comment/ })).toBeNull();
  });
});
