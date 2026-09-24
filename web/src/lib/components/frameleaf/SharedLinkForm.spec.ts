import { SharedLinkType } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
import en from '../../../../../i18n/en.json';
import SharedLinkForm from './SharedLinkForm.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn(),
  handleUpdateSharedLink: vi.fn().mockResolvedValue(true),
}));

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(handleCreateSharedLink).mockResolvedValue(
    sharedLinkFactory.build({ type: SharedLinkType.Album, assets: [], password: null }),
  );
});

describe('SharedLinkForm', () => {
  it('creates a link over the real endpoint and never leaves the password in the component afterwards', async () => {
    // `target` is also a mount option name, so the props are passed explicitly.
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Album, albumId: 'album-1', name: 'Summer trip' } },
    });

    await fireEvent.input(screen.getByLabelText(en.password), { target: { value: 'hunter2' } });
    await fireEvent.input(screen.getByLabelText(en.description), { target: { value: 'For the family' } });
    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    expect(handleCreateSharedLink).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SharedLinkType.Album,
        albumId: 'album-1',
        description: 'For the family',
        password: 'hunter2',
      }),
    );

    // The password never appears anywhere after submission, on the Link ready step either.
    await screen.findByRole('heading', { name: en.frameleaf_sharing.link_ready_title });
    expect(screen.queryByDisplayValue('hunter2')).toBeNull();
  });

  it('removes an existing password only when the checkbox is used, and preserves it otherwise', async () => {
    const link = sharedLinkFactory.build({
      type: SharedLinkType.Individual,
      assets: [],
      password: 'set',
      slug: 'family',
    });

    const first = render(SharedLinkForm, { open: true, link });

    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(link, expect.objectContaining({ password: undefined }));

    // A successful save closes the form, so the second edit opens it again.
    first.unmount();
    vi.clearAllMocks();
    render(SharedLinkForm, { open: true, link });
    await fireEvent.click(screen.getByLabelText(en.frameleaf_sharing.remove_password));
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(link, expect.objectContaining({ password: null }));
  });

  it('computes a future expiry from a preset', async () => {
    const before = Date.now();
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
    });

    await fireEvent.change(screen.getByLabelText(en.frameleaf_sharing.expires), { target: { value: '1d' } });
    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    const dto = vi.mocked(handleCreateSharedLink).mock.calls[0][0];
    expect(dto.expiresAt).toBeTruthy();
    expect(Date.parse(dto.expiresAt as string)).toBeGreaterThan(before);
  });

  it('ties download to metadata: originals carry EXIF and GPS, so hiding metadata turns download off', async () => {
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
    });

    const download = screen.getByRole('switch', { name: new RegExp(`^${en.frameleaf_sharing.allow_download}`) });
    const metadata = screen.getByRole('switch', { name: new RegExp(`^${en.show_metadata}`) });
    // The design's default hides metadata, so a new link starts without downloads.
    expect(metadata).not.toBeChecked();
    expect(download).not.toBeChecked();
    expect(download).toBeDisabled();
    expect(screen.getByText(en.frameleaf_sharing.download_needs_metadata)).toBeInTheDocument();

    await fireEvent.click(metadata);
    expect(download).toBeEnabled();
    await fireEvent.click(download);
    expect(download).toBeChecked();

    // Turning metadata off again turns download off with it.
    await fireEvent.click(metadata);
    expect(download).not.toBeChecked();
    expect(download).toBeDisabled();

    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));
    expect(handleCreateSharedLink).toHaveBeenCalledWith(
      expect.objectContaining({ showMetadata: false, allowDownload: false }),
    );
  });

  it('ends on the Link ready step with the address, instead of a separate QR modal', async () => {
    render(SharedLinkForm, {
      props: { open: true, target: { type: SharedLinkType.Album, albumId: 'album-1', name: 'Summer trip' } },
    });

    await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

    expect(await screen.findByRole('heading', { name: en.frameleaf_sharing.link_ready_title })).toBeInTheDocument();
    expect(screen.getByLabelText(en.frameleaf_sharing.link_address)).toHaveValue('https://frameleaf.local/s/test');
    expect(screen.getByRole('button', { name: en.frameleaf_sharing.qr_code })).toHaveAttribute('aria-pressed', 'false');
  });
});
