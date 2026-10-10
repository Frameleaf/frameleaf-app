import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import en from '../../../../../i18n/en.json';
import AvatarEditorDialog from './AvatarEditorDialog.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    user: { id: 'u1', name: 'Taylor', email: 't@example.test', profileImagePath: '', avatarColor: 'primary' },
    params: {},
    setUser: vi.fn(),
    refresh: vi.fn(),
  },
}));

describe('AvatarEditorDialog (S-2)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sessionAccess.isElevated = false;
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
    sdkMock.searchAssets.mockResolvedValue({
      assets: {
        items: [
          { id: 'a1', ownerId: 'u1', originalFileName: 'lake.jpg', thumbhash: null },
          { id: 'p1', ownerId: 'partner', originalFileName: 'partner.jpg', thumbhash: null },
        ],
        total: 2,
        count: 2,
        facets: [],
        nextPage: null,
      },
      albums: { items: [], total: 0, count: 0, facets: [] },
    } as never);
    sdkMock.updateMyUser.mockResolvedValue({} as never);
  });

  it('offers only your own recent timeline photos, never Locked or partner ones, and saves a colour', async () => {
    const onClose = vi.fn();
    render(AvatarEditorDialog, { onClose });

    expect(await screen.findByRole('button', { name: 'lake.jpg' })).toBeInTheDocument();
    // A partner's timeline photo is never offered: profile pictures are visible to every account.
    expect(screen.queryByRole('button', { name: 'partner.jpg' })).not.toBeInTheDocument();
    expect(sdkMock.searchAssets).toHaveBeenCalledWith({
      metadataSearchDto: expect.objectContaining({ visibility: 'timeline', type: 'IMAGE' }),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'pink' }));
    expect(screen.getByRole('button', { name: 'pink' })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(screen.getByRole('button', { name: 'Save avatar' }));

    await waitFor(() =>
      expect(sdkMock.updateMyUser).toHaveBeenCalledWith({ userUpdateMeDto: { avatarColor: 'pink' } }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('does not search photos while Locked content is revealed', () => {
    sessionAccess.isElevated = true;
    render(AvatarEditorDialog, { onClose: vi.fn() });

    expect(sdkMock.searchAssets).not.toHaveBeenCalled();
    expect(screen.getByText('Lock Locked content to choose from your photos.')).toBeInTheDocument();
  });
});
