import { fireEvent, render, screen } from '@testing-library/svelte';
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
  addMessages('dev', en);
});

describe('ShareSheet', () => {
  it('offers the public link only: partner sharing exposes a whole library, not the selected items', () => {
    render(ShareSheet, { open: true, assetIds: ['a1'] });
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /share with/i })).toBeNull();
    expect(screen.getByRole('button', { name: en.frameleaf_sharing.create_public_link })).toBeInTheDocument();
  });

  it('opens the real shared-link form for the selection', async () => {
    render(ShareSheet, { open: true, assetIds: ['a1', 'a2'] });
    expect(screen.queryByRole('dialog', { name: en.frameleaf_sharing.create_shared_link_title })).toBeNull();
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
