import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
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
      // Sam already has both items; Jamie has only one, so Jamie does not start selected.
      sdkMock.getItemShares.mockResolvedValue([
        { id: 's1', assetId: 'a1', sharedWith: person('sam', 'Sam'), createdAt: '' },
        { id: 's2', assetId: 'a2', sharedWith: person('sam', 'Sam'), createdAt: '' },
        { id: 's3', assetId: 'a1', sharedWith: person('jamie', 'Jamie'), createdAt: '' },
      ]);
      sdkMock.shareItems.mockResolvedValue({ shares: [], added: 2, removed: 0, link: null });
      sdkMock.unshareItems.mockResolvedValue({ shares: [], added: 0, removed: 2, link: null });
      render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });

      const sam = await screen.findByRole('button', { name: 'Sam' });
      const jamie = screen.getByRole('button', { name: 'Jamie' });
      expect(sam).toHaveAttribute('aria-pressed', 'true');
      expect(jamie).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByRole('button', { name: 'Share with Sam' })).toBeInTheDocument();

      await fireEvent.click(jamie);
      await fireEvent.click(sam);
      await fireEvent.click(screen.getByRole('button', { name: 'Share with Jamie' }));

      await waitFor(() =>
        expect(sdkMock.shareItems).toHaveBeenCalledWith({
          itemShareChangeDto: { assetIds: ['a1', 'a2'], userIds: ['jamie'] },
        }),
      );
      expect(sdkMock.unshareItems).toHaveBeenCalledWith({
        itemShareChangeDto: { assetIds: ['a1', 'a2'], userIds: ['sam'] },
      });
    });

    it('says so when nobody else is in the library', async () => {
      render(ShareSheet, { open: true, assetIds: ['a1'] });
      expect(await screen.findByText(en.frameleaf_sharing.no_other_people)).toBeInTheDocument();
    });

    it('offers only the public link for items that are not all yours', () => {
      render(ShareSheet, { open: true, assetIds: ['a1'], assets: [theirs('a1')] });
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link })).toBeInTheDocument();
      expect(sdkMock.searchUsers).not.toHaveBeenCalled();
    });
  });

  it('opens the real shared-link form for the selection', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });
    expect(screen.queryByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title })).toBeNull();
    await switchToLink();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link }));

    expect(
      await screen.findByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title }),
    ).toBeInTheDocument();
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

    it('says only the item count for a single item', () => {
      render(ShareSheet, { open: true, assetIds: ['a1'], assets: [photo('a1')] });
      expect(document.querySelector('.ss-strip')).toHaveTextContent(/^1 item$/);
    });

    it('copies the image only when exactly one photo is shared', async () => {
      const first = render(ShareSheet, { open: true, assetIds: ['a1', 'a2'], assets: [photo('a1'), photo('a2')] });
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.copy_image })).toBeDisabled();
      first.unmount();

      const second = render(ShareSheet, { open: true, assetIds: ['v1'], assets: [video('v1')] });
      expect(screen.getByRole('button', { name: en.frameleaf_sharing.copy_image })).toBeDisabled();
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
