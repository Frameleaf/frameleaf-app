import { SharedLinkType } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleCreateSharedLink } from '$lib/services/shared-link.service';
import {
  canCopyImageToClipboard,
  copyAssetImageToClipboard,
  downloadArchive,
  downloadAssetFile,
} from '$lib/utils/asset-utils';
import en from '../../../../../i18n/en.json';
import ShareSheet from './ShareSheet.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { id: 'me', name: 'Taylor' }, params: {} },
}));

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: (link: { slug?: string | null }) => `https://frameleaf.local/s/${link.slug}`,
  handleCreateSharedLink: vi.fn(),
  handleUpdateSharedLink: vi.fn(),
}));

vi.mock(import('$lib/utils/asset-utils'), async (original) => ({
  ...(await original()),
  canCopyImageToClipboard: vi.fn(() => true),
  copyAssetImageToClipboard: vi.fn(() => Promise.resolve()),
  downloadArchive: vi.fn(() => Promise.resolve()),
  downloadAssetFile: vi.fn(() => 'key'),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canCopyImageToClipboard).mockReturnValue(true);
  sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
  sdkMock.getAllSharedLinks.mockResolvedValue([]);
  sdkMock.searchUsers.mockResolvedValue([]);
  sdkMock.getRecipientGroups.mockResolvedValue([]);
  sdkMock.getItemShares.mockResolvedValue([]);
  addMessages('dev', en);
});

const person = (id: string, name: string) => ({ id, name, email: `${id}@example.com` }) as never;
const theirs = (id: string) => ({ id, isVideo: false, ownerId: 'someone-else' });
const switchToLink = () =>
  fireEvent.click(screen.getByRole('radio', { name: new RegExp(en.frameleaf_sharing.link_option_title) }));

describe('ShareSheet', () => {
  describe('share with people in this library (FL-83 AL-30b)', () => {
    it('offers both ways to share the owner’s items, people first, as in the prototype', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('me', 'Taylor'), person('jamie', 'Jamie'), person('sam', 'Sam')]);
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      const people = screen.getByRole('radio', { name: new RegExp(en.frameleaf_sharing.people_option_title) });
      expect(people).toHaveAttribute('aria-checked', 'true');
      expect(
        screen.getByRole('radio', { name: new RegExp(en.frameleaf_sharing.link_option_title) }),
      ).toBeInTheDocument();

      const group = await screen.findByRole('group', { name: en.frameleaf_sharing.people_to_share_with });
      // everyone else in the library, never yourself
      expect(
        within(group)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Jamie', 'Sam']);
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.save_sharing })).toBeInTheDocument();
      expect(sdkMock.getItemShares).toHaveBeenCalledWith({ itemShareQueryDto: { assetIds: ['a1'] } });
    });

    it('shares with the people chosen and stops sharing with the ones turned off', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie'), person('sam', 'Sam')]);
      // Sam has both items. Jamie starts partial, then is cleared and selected again to share both.
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' },
        { id: 's2', assetId: 'a2', sharedWith: person('sam', 'Sam'), createdAt: '' },
        { id: 's3', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' },
      ]);
      sdkMock.shareItems.mockResolvedValue({ shares: [], added: 2, removed: 0, link: null });
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 2, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });

      const sam = await screen.findByRole('button', { name: 'Sam' });
      const jamie = screen.getByRole('button', { name: /Jamie, shared with some selected items/ });
      expect(sam).toHaveAttribute('aria-pressed', 'true');
      expect(jamie).toHaveAttribute('aria-pressed', 'mixed');
      expect(screen.getByText(en.frameleaf_sharing.some_items)).toBeInTheDocument();

      await fireEvent.click(jamie);
      expect(jamie).toHaveAttribute('aria-pressed', 'false');
      await fireEvent.click(jamie);
      // one person gains the items: the button names that change
      expect(screen.getByRole('button', { name: 'Share with Jamie' })).toBeEnabled();
      await fireEvent.click(sam);
      // someone gains and someone loses them
      await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() =>
        expect(sdkMock.shareItems).toHaveBeenCalledWith({
          itemShareChangeDto: { assetIds: ['a1', 'a2'], userIds: ['jamie'] },
        }),
      );
      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1', 'a2'], userIds: ['sam'] },
      });
    });

    it('retries only the outstanding revoke after a new share was saved', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie'), person('sam', 'Sam')]);
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' },
      ]);
      sdkMock.shareItems.mockResolvedValue({ shares: [], added: 1, removed: 0, link: null });
      sdkMock.unshareItems
        .mockRejectedValueOnce(new Error('Revoke unavailable'))
        .mockResolvedValue({ shares: [], added: 0, removed: 1, link: null });
      const danger = vi.spyOn(toastManager, 'danger').mockImplementation(() => undefined as never);
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      const sam = screen.getByRole('button', { name: 'Sam' });
      await fireEvent.click(jamie);
      await fireEvent.click(sam);
      const save = screen.getByRole('button', { name: 'Save changes' });
      await fireEvent.click(save);

      await waitFor(() => expect(sdkMock.unshareItems).toHaveBeenCalledTimes(1));
      expect(danger).toHaveBeenCalledWith(en.frameleaf_sharing.sharing_save_failed);
      expect(screen.getByRole('dialog', { name: 'Share 1 item' })).toBeInTheDocument();
      expect(jamie).toHaveAttribute('aria-pressed', 'true');
      expect(sam).toHaveAttribute('aria-pressed', 'false');
      await waitFor(() => expect(save).toBeEnabled());
      // the share was saved; only the revoke is left, and the button says so
      expect(save).toHaveTextContent('Stop sharing with Sam');

      await fireEvent.click(save);
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Share 1 item' })).toBeNull());
      expect(sdkMock.shareItems).toHaveBeenCalledTimes(1);
      expect(sdkMock.unshareItems).toHaveBeenCalledTimes(2);
      expect(sdkMock.unshareItems).toHaveBeenLastCalledWith({
        itemShareChangeDto: { assetIds: ['a1'], userIds: ['sam'] },
      });
      danger.mockRestore();
    });

    it('finishes a pending save against its original items without changing a new selection', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie'), person('sam', 'Sam'), person('alex', 'Alex')]);
      sdkMock.getItemShares
        .mockResolvedValueOnce([{ id: 's1', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' }])
        .mockResolvedValueOnce([{ id: 's2', assetId: 'b1', sharedWith: person('alex', 'Alex'), createdAt: '' }]);
      let finishAdd!: (response: Awaited<ReturnType<typeof sdkMock.shareItems>>) => void;
      sdkMock.shareItems.mockImplementationOnce(() => new Promise((resolve) => (finishAdd = resolve)));
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 1, link: null });
      const view = render(ShareSheet, { open: true, assetIds: ['a1'] });

      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      const sam = screen.getByRole('button', { name: 'Sam' });
      await fireEvent.click(jamie);
      await fireEvent.click(sam);
      await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(sdkMock.shareItems).toHaveBeenCalledTimes(1));
      expect(jamie).toBeDisabled();

      await view.rerender({ open: true, assetIds: ['b1'] });
      const alex = await screen.findByRole('button', { name: 'Alex' });
      await waitFor(() => expect(alex).toHaveAttribute('aria-pressed', 'true'));
      finishAdd({ shares: [], added: 1, removed: 0, link: null });

      await waitFor(() => expect(sdkMock.unshareItems).toHaveBeenCalledTimes(1));
      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1'], userIds: ['sam'] },
      });
      expect(screen.getByRole('dialog', { name: 'Share 1 item' })).toBeInTheDocument();
      expect(alex).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(alex).toBeEnabled());

      await fireEvent.click(alex);
      await fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Alex' }));
      await waitFor(() => expect(sdkMock.unshareItems).toHaveBeenCalledTimes(2));
      expect(sdkMock.unshareItems).toHaveBeenLastCalledWith({
        itemShareChangeDto: { assetIds: ['b1'], userIds: ['alex'] },
      });
      expect(sdkMock.shareItems).toHaveBeenCalledTimes(1);
    });

    it('clears a partial recipient across the selection', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie')]);
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' },
      ]);
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 1, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });

      const jamie = await screen.findByRole('button', { name: /Jamie, shared with some selected items/ });
      expect(jamie).toHaveAttribute('aria-pressed', 'mixed');
      await fireEvent.click(jamie);
      await fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Jamie' }));

      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1', 'a2'], userIds: ['jamie'] },
      });
      expect(sdkMock.shareItems).not.toHaveBeenCalled();
    });

    it('can revoke an existing share when the user directory is private', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('me', 'Taylor')]);
      sdkMock.getRecipientGroups.mockRejectedValueOnce(new Error('Unavailable'));
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' },
      ]);
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 1, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      expect(jamie).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(jamie);
      await fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Jamie' }));

      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1'], userIds: ['jamie'] },
      });
      expect(sdkMock.shareItems).not.toHaveBeenCalled();
    });

    it('can revoke an existing share when the user directory request fails', async () => {
      sdkMock.searchUsers.mockRejectedValueOnce(new Error('Directory unavailable'));
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' },
      ]);
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 1, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      expect(jamie).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(jamie);
      await fireEvent.click(screen.getByRole('button', { name: 'Stop sharing with Jamie' }));

      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1'], userIds: ['jamie'] },
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('creates a new share with a saved recipient when the user directory is private', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('me', 'Taylor')]);
      sdkMock.getRecipientGroups.mockResolvedValue([
        {
          id: 'g1',
          name: 'Family',
          users: [person('me', 'Taylor'), person('jamie', 'Jamie')],
          createdAt: '',
          updatedAt: '',
        },
        { id: 'g2', name: 'Friends', users: [person('jamie', 'Jamie')], createdAt: '', updatedAt: '' },
      ]);
      sdkMock.shareItems.mockResolvedValue({ shares: [], added: 1, removed: 0, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      const group = await screen.findByRole('group', { name: en.frameleaf_sharing.people_to_share_with });
      expect(within(group).getAllByRole('button')).toHaveLength(1);
      const jamie = within(group).getByRole('button', { name: 'Jamie' });
      expect(jamie).toHaveAttribute('aria-pressed', 'false');
      await fireEvent.click(jamie);
      await fireEvent.click(screen.getByRole('button', { name: 'Share with Jamie' }));

      expect(sdkMock.shareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1'], userIds: ['jamie'] },
      });
      expect(sdkMock.unshareItems).not.toHaveBeenCalled();
    });

    it('reloads sharing after a cancelled draft is reopened', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie'), person('sam', 'Sam')]);
      const view = render(ShareSheet, { open: true, assetIds: ['a1'] });
      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      await fireEvent.click(jamie);
      expect(jamie).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(screen.getByRole('button', { name: en.cancel }));

      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' },
      ]);
      await view.rerender({ open: true, assetIds: ['a1'] });

      await waitFor(() => expect(sdkMock.getItemShares).toHaveBeenCalledTimes(2));
      expect(screen.getByRole('button', { name: 'Jamie' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Sam' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('ignores an old load after reopening and does not duplicate a pending load', async () => {
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie'), person('sam', 'Sam')]);
      let finishFirst!: (shares: Awaited<ReturnType<typeof sdkMock.getItemShares>>) => void;
      sdkMock.getItemShares
        .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
        .mockResolvedValue([{ id: 's2', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' }]);
      const view = render(ShareSheet, { open: true, assetIds: ['a1'] });

      await view.rerender({ open: true, assetIds: ['a1'] });
      expect(sdkMock.getItemShares).toHaveBeenCalledTimes(1);
      await view.rerender({ open: false, assetIds: ['a1'] });
      await view.rerender({ open: true, assetIds: ['a1'] });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Sam' })).toHaveAttribute('aria-pressed', 'true'));

      finishFirst([{ id: 's1', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' }]);
      await Promise.resolve();
      await tick();
      expect(sdkMock.getItemShares).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Jamie' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('says so when nobody else is in the library', async () => {
      render(ShareSheet, { open: true, assetIds: ['a1'] });
      expect(await screen.findByText(en.frameleaf_sharing.no_other_people)).toBeInTheDocument();
    });

    it('keeps sharing unavailable after a load failure and retries the recipients', async () => {
      sdkMock.getItemShares.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue([]);
      sdkMock.searchUsers.mockResolvedValue([person('jamie', 'Jamie')]);
      render(ShareSheet, { open: true, assetIds: ['a1'] });

      expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_sharing.people_load_failed);
      expect(screen.queryByText(en.frameleaf_sharing.no_other_people)).toBeNull();
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.save_sharing })).toBeDisabled();

      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_error_retry }));
      const jamie = await screen.findByRole('button', { name: 'Jamie' });
      // nothing to save until the chosen people differ from who already has the item
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.save_sharing })).toBeDisabled();
      await fireEvent.click(jamie);
      expect(screen.getByRole('button', { name: 'Share with Jamie' })).toBeEnabled();
      expect(sdkMock.getItemShares).toHaveBeenCalledTimes(2);
    });

    it('offers only the public link for items that are not all yours', () => {
      render(ShareSheet, { open: true, assetIds: ['a1'], assets: [theirs('a1')] });
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link })).toBeInTheDocument();
      expect(sdkMock.searchUsers).not.toHaveBeenCalled();
    });
  });

  it('makes a public link in the sheet itself, ending on Link ready, without a second dialog', async () => {
    vi.mocked(handleCreateSharedLink).mockResolvedValue(
      sharedLinkFactory.build({ type: SharedLinkType.Individual, slug: 'beach-day', password: null }),
    );
    render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });
    expect(screen.queryByLabelText(en.frameleaf_sharing.custom_address)).toBeNull();
    await switchToLink();

    // the link's own settings take the place of the people list
    expect(screen.getByLabelText(en.frameleaf_sharing.custom_address)).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link }));

    expect(await screen.findByRole('dialog', { name: en.frameleaf_sharing.link_ready_title })).toBeInTheDocument();
    expect(handleCreateSharedLink).toHaveBeenCalledWith(
      expect.objectContaining({ type: SharedLinkType.Individual, assetIds: ['a1', 'a2'] }),
      expect.anything(),
    );
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByLabelText(en.frameleaf_sharing.link_address)).toHaveValue('https://frameleaf.local/s/beach-day');
    // nothing left to choose once the link exists: the sheet offers Done only
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: en.done })).toBeInTheDocument();
  });

  it('reports once when the sheet closes, so the viewer can open it through the modal manager (AL-33)', async () => {
    const onClosed = vi.fn();
    render(ShareSheet, { open: true, assetIds: ['a1'], onClosed });
    expect(onClosed).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
  describe('collage, count and shortcuts (FL-83 AL-31)', () => {
    const photo = (id: string) => ({ id, isVideo: false, originalFileName: `${id}.jpg` });
    const video = (id: string) => ({ id, isVideo: true, originalFileName: `${id}.mp4` });

    it('shows the items as a collage with how many photos and videos they are', () => {
      render(ShareSheet, { open: true, assetIds: ['a1', 'a2', 'a3'], assets: [photo('a1'), video('a2'), photo('a3')] });

      const images = document.querySelectorAll('.ss-strip img');
      expect(images).toHaveLength(3);
      expect(images[0].getAttribute('src')).toContain('/assets/a1/thumbnail');
      expect(screen.getByText('3 items · 2 photos, 1 video')).toBeInTheDocument();
    });

    it('titles the sheet by what is shared, not a file name, and keeps the count beside the collage', () => {
      const view = render(ShareSheet, { open: true, assetIds: ['a1'], assets: [photo('a1')] });
      expect(screen.getByRole('dialog', { name: 'Share 1 photo' })).toBeInTheDocument();
      expect(document.querySelector('.ss-strip')).toHaveTextContent(/^1 item$/);
      view.unmount();

      const unknown = render(ShareSheet, { open: true, assetIds: ['a1'] });
      expect(screen.getByRole('dialog', { name: 'Share 1 item' })).toBeInTheDocument();
      unknown.unmount();

      render(ShareSheet, { open: true, assetIds: ['a1', 'v1'], assets: [photo('a1'), video('v1')] });
      expect(screen.getByRole('dialog', { name: 'Share 2 items' })).toBeInTheDocument();
    });

    it('copies the image only when exactly one photo is shared', async () => {
      const first = render(ShareSheet, { open: true, assetIds: ['a1', 'a2'], assets: [photo('a1'), photo('a2')] });
      // left out, not shown disabled, when it cannot apply
      expect(screen.queryByRole('button', { name: en.frameleaf_sharing.copy_image })).toBeNull();
      first.unmount();

      const second = render(ShareSheet, { open: true, assetIds: ['v1'], assets: [video('v1')] });
      expect(screen.queryByRole('button', { name: en.frameleaf_sharing.copy_image })).toBeNull();
      second.unmount();

      render(ShareSheet, { open: true, assetIds: ['a1'], assets: [photo('a1')] });
      const copy = screen.getByRole('button', { name: en.frameleaf_sharing.copy_image });
      expect(copy).toBeEnabled();
      await fireEvent.click(copy);
      expect(copyAssetImageToClipboard).toHaveBeenCalledWith('a1');
    });

    it('downloads a single item as its file and several as an archive', async () => {
      const first = render(ShareSheet, { open: true, assetIds: ['a1'], assets: [photo('a1')] });
      await fireEvent.click(screen.getByRole('button', { name: en.download }));
      expect(downloadAssetFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', filename: 'a1.jpg' }));
      first.unmount();

      render(ShareSheet, { open: true, assetIds: ['a1', 'a2'], assets: [photo('a1'), video('a2')] });
      await fireEvent.click(screen.getByRole('button', { name: en.download }));
      expect(downloadArchive).toHaveBeenCalledWith(expect.any(String), { assetIds: ['a1', 'a2'] });
    });
  });
});
