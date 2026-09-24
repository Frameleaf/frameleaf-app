import { AlbumKind, AlbumUserRole } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import AlbumShareDialog from './AlbumShareDialog.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false, name: 'Me', email: 'me@example.com' }, params: {} },
}));

const me = userAdminFactory.build({ id: 'me', name: 'Me' });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

describe('AlbumShareDialog', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.searchUsers.mockResolvedValue([]);
  });

  it('asks before removing a member, as the space Members panel does, then removes them', async () => {
    sdkMock.removeUserFromAlbum.mockResolvedValue(undefined as never);
    const onChanged = vi.fn();
    const space = albumFactory.build({
      id: 'space-1',
      albumName: 'Family Space',
      kind: AlbumKind.Space,
      albumUsers: [
        { user: me, role: AlbumUserRole.Owner },
        { user: jamie, role: AlbumUserRole.Editor },
      ],
    });
    render(AlbumShareDialog, { album: space, open: true, onChanged, onLeave: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Jamie' }));
    expect(sdkMock.removeUserFromAlbum).not.toHaveBeenCalled();

    const confirm = within(await screen.findByRole('dialog', { name: 'Remove Jamie?' }));
    await fireEvent.click(confirm.getByRole('button', { name: 'Remove member' }));

    await waitFor(() => expect(sdkMock.removeUserFromAlbum).toHaveBeenCalledWith({ id: 'space-1', userId: 'jamie' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
