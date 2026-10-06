import { SharedLinkType } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { sharedLinkFactory } from '$lib/../test-data/factories/shared-link-factory';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleCreateSharedLink, handleUpdateSharedLink } from '$lib/services/shared-link.service';
import en from '../../../../../i18n/en.json';
import SharedLinkForm from './SharedLinkForm.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn(),
  handleUpdateSharedLink: vi.fn().mockResolvedValue(true),
}));

/** Every save hands the service a way to report an address that is already used (AL-26). */
const saveOptions = expect.objectContaining({ onSlugTaken: expect.any(Function) });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  sdkMock.getAllSharedLinks.mockResolvedValue([]);
  sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
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
      saveOptions,
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
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(
      link,
      expect.objectContaining({ password: undefined }),
      saveOptions,
    );

    // A successful save closes the form, so the second edit opens it again.
    first.unmount();
    vi.clearAllMocks();
    render(SharedLinkForm, { open: true, link });
    await fireEvent.click(screen.getByLabelText(en.frameleaf_sharing.remove_password));
    await fireEvent.click(screen.getByRole('button', { name: en.save }));
    expect(handleUpdateSharedLink).toHaveBeenCalledWith(link, expect.objectContaining({ password: null }), saveOptions);
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
      saveOptions,
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
  describe('link preview (FL-83 AL-25)', () => {
    it('shows the items as a collage of real thumbnails with live badges, expiry and a viewer summary', async () => {
      render(SharedLinkForm, {
        props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1', 'a2'], name: '2 items' } },
      });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      const images = preview.querySelectorAll('img');
      expect(images).toHaveLength(2);
      expect(images[0].getAttribute('src')).toContain('/assets/a1/thumbnail');
      expect(images[1].getAttribute('src')).toContain('/assets/a2/thumbnail');
      expect(within(preview).getByText(en.frameleaf_sharing.preview_individual, { exact: false })).toBeInTheDocument();
      expect(within(preview).getByText(en.frameleaf_sharing.preview_address_pending)).toBeInTheDocument();
      expect(within(preview).queryByText(en.frameleaf_sharing.badge_uploads)).toBeNull();
      expect(within(preview).getByText(/Viewers see 2 items without camera or location details\./)).toBeInTheDocument();
      expect(within(preview).getByText(/No password is needed\./)).toBeInTheDocument();
      expect(within(preview).getByText(/The link never expires\./)).toBeInTheDocument();

      await fireEvent.click(screen.getByRole('switch', { name: new RegExp(`^${en.frameleaf_sharing.allow_upload}`) }));
      await fireEvent.input(screen.getByLabelText(en.password), { target: { value: 'hunter2' } });
      await fireEvent.change(screen.getByLabelText(en.frameleaf_sharing.expires), { target: { value: '7d' } });
      await fireEvent.input(screen.getByLabelText(en.description), { target: { value: 'For the family' } });

      expect(within(preview).getByText(en.frameleaf_sharing.badge_uploads)).toBeInTheDocument();
      expect(within(preview).getByText(en.password)).toBeInTheDocument();
      expect(within(preview).getByText(/^Expires in 7 days$/)).toBeInTheDocument();
      expect(within(preview).getByText('For the family')).toBeInTheDocument();
      expect(within(preview).getByText(/A password is required\./)).toBeInTheDocument();
    });

    it('shows an album by its cover and item count', () => {
      render(SharedLinkForm, {
        props: {
          open: true,
          target: {
            type: SharedLinkType.Album,
            albumId: 'album-1',
            name: 'Summer trip',
            previewAssetIds: ['cover-1'],
            count: 12,
          },
        },
      });

      const preview = screen.getByRole('complementary', { name: en.frameleaf_sharing.link_preview });
      expect(preview.querySelector('img')?.getAttribute('src')).toContain('/assets/cover-1/thumbnail');
      expect(within(preview).getByText('+11')).toBeInTheDocument();
      expect(within(preview).getByText(/Album · Summer trip · 12 items/)).toBeInTheDocument();
    });
  });

  describe('custom address status (FL-83 AL-26)', () => {
    const renderWithLinks = async () => {
      sdkMock.getAllSharedLinks.mockResolvedValue([
        sharedLinkFactory.build({ id: 'other', slug: 'family', assets: [] }),
      ]);
      render(SharedLinkForm, {
        props: { open: true, target: { type: SharedLinkType.Individual, assetIds: ['a1'], name: '1 item' } },
      });
      await vi.waitFor(() => expect(sdkMock.getAllSharedLinks).toHaveBeenCalled());
      await tick();
      return screen.getByLabelText(en.frameleaf_sharing.custom_address);
    };

    it('says live whether the address is available, taken by one of your links, or not valid', async () => {
      const input = await renderWithLinks();

      await fireEvent.input(input, { target: { value: 'family' } });
      expect(await screen.findByText(en.frameleaf_sharing.slug_taken)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await fireEvent.input(input, { target: { value: 'Summer Trip' } });
      expect(input).toHaveValue('summer-trip');
      expect(screen.getByText(en.frameleaf_sharing.slug_available)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'false');

      await fireEvent.input(input, { target: { value: 'ab' } });
      expect(screen.getByText(en.frameleaf_sharing.slug_invalid)).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-invalid', 'true');

      await fireEvent.input(input, { target: { value: '' } });
      expect(screen.getByText(en.frameleaf_sharing.slug_hint)).toBeInTheDocument();
    });

    it('does not save an address that is already used', async () => {
      const input = await renderWithLinks();
      await fireEvent.input(input, { target: { value: 'family' } });
      await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

      expect(handleCreateSharedLink).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(en.frameleaf_sharing.slug_taken);
    });

    it('says the address is already used when the server refuses it on save', async () => {
      vi.mocked(handleCreateSharedLink).mockImplementation((_dto, options) => {
        options?.onSlugTaken?.();
        return Promise.resolve(undefined);
      });
      const input = await renderWithLinks();
      await fireEvent.input(input, { target: { value: 'someone-elses' } });
      await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

      expect(handleCreateSharedLink).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'someone-elses' }),
        expect.objectContaining({ onSlugTaken: expect.any(Function) }),
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_sharing.slug_taken);
      expect(input).toHaveAttribute('aria-invalid', 'true');
    });
  });
});
